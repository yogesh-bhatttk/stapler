/**
 * CNV-11 — an `.xlsx` → the generalized PDF block model.
 *
 * The mirror of `xlsx-writer.ts` (CNV-10), and the direct counterpart of
 * `docx-reader.ts` (CNV-09): read-only, lazily loaded, and refusing bad input
 * before it can produce something that *looks* like a conversion.
 *
 * `xlsx` (SheetJS CE) is loaded through a dynamic `import()` for the same reason
 * `mammoth` is — nothing in it is parsed or evaluated until someone actually
 * converts a workbook, so it stays out of the 900KB initial bundle
 * `scripts/check-bundle-size.js` measures. It is a real bundled dependency (pure
 * JS, no WASM, no network), so this is a lazy *chunk*, not a remote fetch
 * (PLAN §5.4). This module never calls anything that writes.
 *
 * **Why the magic-byte checks are not optional here.** `XLSX.read` is far more
 * permissive than `mammoth.convertToHtml`: handed eight bytes of binary garbage
 * it does *not* throw — it sniffs the buffer as delimiter-separated text and
 * hands back a one-sheet workbook whose cells hold the control characters it
 * found. Converting that would produce a PDF of nonsense presented to the user
 * as their spreadsheet, which is precisely the silent-corruption outcome
 * PLAN §5.2 forbids. So this module decides what a `.xlsx` is (a ZIP) before
 * SheetJS is given the chance to guess, and every shape SheetJS *does* throw is
 * translated into a message that says what to do about it.
 *
 * **What is deliberately not carried across** is listed in `EXCEL_LIMITATIONS`,
 * which the panel renders verbatim — a limitation stated only in a ticket is not
 * disclosed to the person deciding whether to trust the output.
 */

import { unzipSync } from 'fflate';

import { corrupt, fromUnknown, unsupported } from '../errors';
import { checkpoint, type JobHandle } from '../workers/protocol';
import type { LayoutBlock, StyledRun } from './html-to-pdf-blocks';
import { columnRef } from './column-ref';

/** `PK\x03\x04` — the local file header every ZIP, and so every `.xlsx`, opens with. */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

/**
 * The OLE2 compound-file signature. Two very different files start with it and
 * both are common mistakes here: a legacy binary `.xls`, and a password-protected
 * `.xlsx` (OOXML encryption wraps the real ZIP inside an OLE container).
 */
const OLE2_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

export const XLSX_EMPTY_MESSAGE = 'This file is empty, so there is nothing to convert.';

export const XLSX_LEGACY_MESSAGE =
  'This is a legacy Excel .xls file, or a password-protected .xlsx. Neither can be read here — ' +
  'open it in Excel or LibreOffice and save it as an unprotected .xlsx first.';

export const XLSX_NOT_A_ZIP_MESSAGE =
  'This file is not a readable .xlsx: its ZIP container could not be opened. The original file ' +
  'is untouched — nothing was converted.';

export const XLSX_NOT_A_WORKBOOK_MESSAGE =
  'This file is a ZIP, but not an Excel workbook — it holds no spreadsheet part. A .docx or ' +
  '.pptx renamed to .xlsx lands here. The original file is untouched.';

export const XLSX_NO_SHEETS_MESSAGE =
  'This workbook contains no sheets, so there is nothing to convert. The original file is ' +
  'untouched.';

export const XLSX_ALL_SHEETS_HIDDEN_MESSAGE =
  'Every sheet in this workbook is hidden. Hidden sheets are left out of the PDF on purpose — ' +
  'unhide at least one sheet in Excel and convert again. Nothing was written.';

/**
 * The two things one sheet's section can say when there is no grid to draw, and
 * the reason they are different strings.
 *
 * SheetJS does not fail a read when a *single* worksheet part is unparseable: its
 * `safe_parse_sheet` swallows the error and its `parse_ws_xml` finds no
 * `sheetData` in garbage, so the sheet comes back as a truthy `{}` — byte for
 * byte the same object a genuinely blank sheet produces. Reporting both as "this
 * sheet is empty" is a false statement *about the user's document*: the sheet has
 * content, it could not be read. So emptiness now has to be proved from the
 * bytes (`worksheetPartState` below) and is never assumed from an absence.
 */
export const XLSX_SHEET_EMPTY_TEXT = 'This sheet is empty.';
// Written with no en/em dash on purpose: these two strings are *drawn into the
// page*, and `markdown-to-pdf.ts`'s WinAnsi sanitiser rewrites a dash on the way
// in, so source text that did not match the text in the PDF would be a trap for
// anyone grepping for it — the same reason the band labels below use a hyphen.
export const XLSX_SHEET_UNREADABLE_TEXT =
  'This sheet could not be read: its worksheet data is damaged or in a form this converter ' +
  'cannot parse. It is not empty; nothing from it is in the PDF.';

/**
 * The third reason a sheet draws no grid, and the one that used to be reported
 * as the first: every cell in it is a formula whose cached result is missing.
 *
 * A formula cell with no cached value has nothing to draw, so it does not widen
 * the grid — which meant a sheet made only of such cells produced no extent at
 * all and fell into "This sheet is empty." It is not empty; it is full of
 * formulas nobody has calculated. Same rule as `XLSX_SHEET_UNREADABLE_TEXT`:
 * this module never tells someone their sheet is empty unless it is.
 */
export const XLSX_SHEET_FORMULAS_ONLY_TEXT =
  'This sheet holds only formulas with no cached results, so there is nothing to draw. It is ' +
  'not empty. Excel stores the last computed value alongside each formula; open it in Excel ' +
  'or LibreOffice, let it recalculate, save, and convert again.';

/* ------------------------------------------------------------------ *
 * Caps
 * ------------------------------------------------------------------ */

/**
 * How many sheets, rows and columns this converter will draw.
 *
 * Excel's own limits are 1,048,576 rows × 16,384 columns *per sheet*, and a grid
 * that size is not a document — laying it out would produce tens of thousands of
 * PDF pages and exhaust memory long before finishing. So there are caps, and the
 * reason they are constants with their own notes rather than a silent `slice()`
 * is CNV-09's own audit: its list recursion used to stop at the indent limit and
 * `return`, deleting every item below it with nothing anywhere to say so. Every
 * cap below reports exactly what it left out, and by how much.
 */
export const MAX_SHEETS = 50;
export const MAX_SHEET_ROWS = 1000;
export const MAX_SHEET_COLUMNS = 32;

/**
 * How many columns share one printed grid before the sheet is continued as a
 * second band of columns further down the PDF.
 *
 * Columns are *never dropped* to make a sheet fit the page width — Excel's own
 * print behaviour is to continue the remaining columns on later pages, and that
 * is what this reproduces. Twelve is the point past which a column on A4 is
 * narrower than the two or three characters needed to read it.
 */
export const MAX_COLUMNS_PER_BAND = 12;

/** Nominal printable width, in points, a band of columns is packed against. */
const BAND_TARGET_PT = 460;

/**
 * How much of one cell's text is drawn.
 *
 * A cell can legally hold 32,767 characters. Wrapped into a grid column that is
 * a row several pages tall, and `pdf-block-layout.ts` deliberately lets an
 * over-tall row overflow rather than cutting it — so the text past the bottom of
 * the page would be *gone*, with nothing to say so. A visible ellipsis plus a
 * counted note is the honest version of the same limit.
 */
export const MAX_CELL_CHARS = 500;

/* ------------------------------------------------------------------ *
 * Notes
 * ------------------------------------------------------------------ */

export function sheetCapNote(total: number): string {
  return (
    `This workbook has ${total} sheets and the first ${MAX_SHEETS} were converted. Sheets ` +
    `${MAX_SHEETS + 1}–${total} are not in the PDF.`
  );
}

export function rowCapNote(sheet: string, total: number): string {
  return (
    `Sheet "${sheet}" has ${total} rows with content and the first ${MAX_SHEET_ROWS} were ` +
    `converted. Rows ${MAX_SHEET_ROWS + 1}–${total} are not in the PDF.`
  );
}

export function columnCapNote(sheet: string, total: number): string {
  return (
    `Sheet "${sheet}" has ${total} columns with content and the first ${MAX_SHEET_COLUMNS} were ` +
    `converted. The remaining ${total - MAX_SHEET_COLUMNS} are not in the PDF.`
  );
}

export function hiddenSheetsNote(names: readonly string[]): string {
  return (
    `${names.length} hidden sheet${names.length === 1 ? '' : 's'} ` +
    `(${names.join(', ')}) ${names.length === 1 ? 'was' : 'were'} left out, the same way Excel ` +
    'itself does not print them.'
  );
}

export function hiddenRowsNote(sheet: string, count: number): string {
  return (
    `${count} hidden row${count === 1 ? '' : 's'} in sheet "${sheet}" ${count === 1 ? 'was' : 'were'} ` +
    'left out, the same way Excel itself does not print them.'
  );
}

export function hiddenColumnsNote(sheet: string, count: number): string {
  return (
    `${count} hidden column${count === 1 ? '' : 's'} in sheet "${sheet}" ` +
    `${count === 1 ? 'was' : 'were'} left out, the same way Excel itself does not print them.`
  );
}

export function truncatedCellsNote(count: number): string {
  return (
    `${count} cell${count === 1 ? '' : 's'} held more than ${MAX_CELL_CHARS} characters and ` +
    `${count === 1 ? 'was' : 'were'} shortened with an ellipsis.`
  );
}

/**
 * A sheet SheetJS handed back with no cells whose worksheet part is *not* an
 * intact worksheet document.
 *
 * In the "left out" list as well as in the PDF, because the two are read by
 * different people: the section in the document tells whoever opens the PDF, the
 * note tells whoever is deciding whether to save it.
 */
export function unreadableSheetNote(name: string): string {
  return (
    `Sheet "${name}" could not be read — its worksheet data is damaged or in a form this ` +
    'converter cannot parse, so the sheet is in the PDF as a note saying so and nothing else. ' +
    'It is not an empty sheet. Open the file in Excel or LibreOffice to check what it holds.'
  );
}

/**
 * A workbook whose `SheetNames` holds the same name twice.
 *
 * Excel will not write one and refuses to open one, so this only ever comes from
 * a malformed producer — but SheetJS parses it, and its `Sheets` map is keyed by
 * *name*, so the second sheet has already overwritten the first by the time this
 * module sees either. There is nothing left to recover, which makes saying so
 * the whole of the fix: the alternative is a PDF that quietly shows one sheet's
 * grid twice under the same heading with the other sheet's rows nowhere in it.
 */
export function duplicateSheetNamesNote(names: readonly string[]): string {
  return (
    `This workbook declares more than one sheet called ${names.map(n => `"${n}"`).join(', ')}. ` +
    'A workbook cannot legally do that, and only one sheet of each name can be read — the ' +
    'sections under a repeated name show the same grid, and the other sheet of that name is ' +
    'not in the PDF. Rename the sheets in Excel or LibreOffice and convert again.'
  );
}

export function uncachedFormulaNote(count: number): string {
  return (
    `${count} formula cell${count === 1 ? '' : 's'} carried no cached result, so there is ` +
    `nothing to draw for ${count === 1 ? 'it' : 'them'}. Excel stores the last computed value ` +
    'alongside each formula; a file written by a tool that does not, or one saved before it ' +
    'recalculated, leaves the cell blank. Nothing is calculated here.'
  );
}

/**
 * Every limitation of this converter, in the order the panel lists them.
 *
 * Exported so the panel and `docs/TICKETS.md` cannot state different ones — the
 * same reason CNV-09's `LIMITATIONS` array exists, moved into `core/` here
 * because two of the items are decisions this module makes (hidden content,
 * caps) rather than facts about the layout engine.
 */
export const EXCEL_LIMITATIONS: readonly string[] = [
  'A cell shows its computed value, exactly as Excel last displayed it — number and date ' +
    'formats are preserved. Formulas themselves are not converted, and nothing is recalculated.',
  'Hidden sheets, hidden rows and hidden columns are left out, the same way Excel itself does ' +
    'not print them. The conversion says how many, by name for sheets.',
  'Cell fonts, colours, fills, borders and alignment are not reproduced: every grid is drawn ' +
    'in one size with a hairline border. Cell text is preserved, its styling is not.',
  'Merged cells are drawn as the grid beneath them — the value appears in the first cell of the ' +
    'merge and the rest are blank. No value is lost, the merge is.',
  'Charts, images, pivot tables, shapes, comments and conditional formatting are not carried ' +
    'across at all.',
  'Column widths are approximated from the workbook, then scaled to the page — they will not ' +
    'match Excel’s own layout. A sheet too wide for the page continues as a second band of ' +
    'columns lower down rather than losing them.',
  'Text is drawn in Helvetica. Characters outside the Latin-1 set (CJK, Cyrillic, most Arabic ' +
    'and Hebrew) are replaced with "?", and the conversion says so when it happens.',
  `At most ${MAX_SHEETS} sheets, ${MAX_SHEET_ROWS} rows and ${MAX_SHEET_COLUMNS} columns per ` +
    'sheet are drawn. Anything past that is reported as left out, never dropped quietly.',
  `A cell longer than ${MAX_CELL_CHARS} characters is shortened with an ellipsis, because a row ` +
    'several pages tall would run off the bottom of the page instead. The conversion says how ' +
    'many cells that happened to.',
  'A grid split across pages does not repeat its header row.'
];

/* ------------------------------------------------------------------ *
 * Result shape
 * ------------------------------------------------------------------ */

/** What one sheet became, for the panel's summary line. */
export interface SheetSummary {
  name: string;
  /** Rows actually drawn. */
  rows: number;
  /** Columns actually drawn. */
  columns: number;
  /** How many column bands the sheet was continued across. */
  bands: number;
  /**
   * True when the sheet held no cells at all *and* that was proved from the
   * bytes. Never true for a sheet whose worksheet part did not parse — see
   * `unreadable`.
   */
  empty: boolean;
  /**
   * True when the sheet's worksheet part exists but is not an intact worksheet
   * document, so nothing could be read out of it.
   *
   * Separate from `empty` on purpose: they were one field, and reporting a
   * damaged sheet as an empty one is a false claim about the user's document.
   */
  unreadable: boolean;
}

export interface XlsxBlocksResult {
  blocks: LayoutBlock[];
  /**
   * Everything recognised and deliberately not carried across, each with the
   * reason. Surfaced in the UI — a silently dropped row is exactly the failure
   * mode this product's error philosophy exists to prevent.
   */
  notes: string[];
  sheets: SheetSummary[];
  /** The workbook's own `/Title` from its core properties, if it set one. */
  title?: string;
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  if (bytes.length < magic.length) return false;
  return magic.every((byte, index) => bytes[index] === byte);
}

/** A1-style address for a 0-based row/column, without loading SheetJS. */
export function cellAddress(row: number, column: number): string {
  return `${columnRef(column)}${row + 1}`;
}

/** `0` → `A`, `26` → `AA` — used to name a band's column range. */
export function columnName(column: number): string {
  return columnRef(column);
}

/** The shape of a SheetJS cell this module reads. Never written to. */
interface SheetCell {
  t?: string;
  v?: string | number | boolean | Date;
  w?: string;
  f?: string;
  l?: { Target?: string };
}

interface ColumnInfo {
  hidden?: boolean;
  wpx?: number;
  wch?: number;
}

interface RowInfoLike {
  hidden?: boolean;
}

/**
 * The workbook-level sheet entry this module reads.
 *
 * `id` (the `r:id` naming the worksheet part) is parsed by SheetJS and present at
 * runtime but absent from its `.d.ts`, so the cast at the call site is narrowed to
 * this shape rather than to `any`.
 */
interface SheetPropsLike {
  Hidden?: number;
  id?: string;
}

/**
 * The Excel error codes an error cell (`t === 'e'`) stores in `v`, and the token
 * Excel shows for each — §18.18.11 ST_CellType / the BIFF `BErr` table.
 *
 * Needed because `v` for an error cell is a *number*: `#DIV/0!` is stored as 7.
 * `w` normally carries the token, but a cell whose number format SSF cannot parse
 * has no `w` at all, and falling through to the numeric fallback below would draw
 * a bare `7` in a cell the spreadsheet shows as `#DIV/0!` — a wrong value
 * presented as a right one, which is worse than any blank.
 */
const ERROR_CODES: Readonly<Record<number, string>> = {
  0x00: '#NULL!',
  0x07: '#DIV/0!',
  0x0f: '#VALUE!',
  0x17: '#REF!',
  0x1d: '#NAME?',
  0x24: '#NUM!',
  0x2a: '#N/A',
  0x2b: '#GETTING_DATA'
};

/**
 * What an error cell reads as when its code is not one of the eight above.
 *
 * Deliberately not a real Excel token — inventing `#N/A` for an unknown code
 * would be as wrong as drawing the number. This says "an error", which is the
 * one thing that is certainly true.
 */
export const UNKNOWN_ERROR_TEXT = '#ERROR!';

/** True for an error cell — the one cell type whose `v` must never be drawn. */
function errorCellText(cell: SheetCell): string {
  if (typeof cell.w === 'string' && cell.w.length > 0) return cell.w;
  const code = cell.v;
  if (typeof code === 'number') return ERROR_CODES[code] ?? UNKNOWN_ERROR_TEXT;
  // Some producers store the token itself rather than the code.
  if (typeof code === 'string' && code.startsWith('#')) return code;
  return UNKNOWN_ERROR_TEXT;
}

/**
 * One cell's text, as Excel last displayed it.
 *
 * `w` is SheetJS's own formatted rendering of the cell against its number format
 * (`cellNF` + `cellText` on the read), which is what makes "1,204.50", "8.1%" and
 * "2026-01-15" survive rather than becoming "1204.5", "0.081" and an ISO
 * timestamp. `v` is only the fallback for a cell that has no format at all —
 * except for an error cell, where `v` is a code and never a value, so it gets its
 * own symbolic path above.
 */
export function cellText(cell: SheetCell | undefined): string {
  if (!cell || cell.t === 'z') return '';
  if (cell.t === 'e') return errorCellText(cell);
  if (typeof cell.w === 'string' && cell.w.length > 0) return cell.w;
  const value = cell.v;
  if (value === undefined || value === null) return '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

/**
 * A cell hyperlink's target, when it is one a PDF link annotation can point at.
 *
 * An in-workbook reference (`#'Sheet2'!A1`) is skipped rather than written as a
 * link to nowhere: there is no second sheet in a PDF for it to reach.
 */
function externalTarget(cell: SheetCell | undefined): string | undefined {
  const target = cell?.l?.Target;
  if (typeof target !== 'string') return undefined;
  return /^(https?:|mailto:)/i.test(target) ? target : undefined;
}

/**
 * Approximated width, in points, for one column.
 *
 * Excel stores a column width in "characters" (`wch`) or screen pixels (`wpx`),
 * neither of which is a point measurement, and a workbook that never customised a
 * column stores nothing at all. So: the workbook's own number when it has one,
 * the column's widest cell when it does not, clamped at both ends. These are
 * *relative weights* — `pdf-block-layout.ts` scales a band to the real content
 * width, so the page size stays the layout engine's business.
 */
const PX_TO_PT = 0.75;
const CHAR_PX = 7;
const CELL_PAD_PX = 5;
const MIN_COLUMN_PT = 32;
const MAX_COLUMN_PT = 200;
const DEFAULT_WCH = 8.43;

export function columnWidthPt(info: ColumnInfo | undefined, widestCellChars: number): number {
  let px: number;
  if (info?.wpx !== undefined && info.wpx > 0) px = info.wpx;
  else if (info?.wch !== undefined && info.wch > 0) px = info.wch * CHAR_PX + CELL_PAD_PX;
  else if (widestCellChars > 0) px = Math.min(widestCellChars + 1, 40) * CHAR_PX + CELL_PAD_PX;
  else px = DEFAULT_WCH * CHAR_PX + CELL_PAD_PX;
  return Math.min(MAX_COLUMN_PT, Math.max(MIN_COLUMN_PT, px * PX_TO_PT));
}

/**
 * Groups columns into bands that each fit a printable width.
 *
 * Never drops a column: a band always takes at least one, however wide, and the
 * remainder become the next band.
 */
export function bandColumns(widths: readonly number[]): number[][] {
  const bands: number[][] = [];
  let current: number[] = [];
  let width = 0;
  for (let index = 0; index < widths.length; index++) {
    const next = widths[index];
    if (
      current.length > 0 &&
      (current.length >= MAX_COLUMNS_PER_BAND || width + next > BAND_TARGET_PT)
    ) {
      bands.push(current);
      current = [];
      width = 0;
    }
    current.push(index);
    width += next;
  }
  if (current.length > 0) bands.push(current);
  return bands;
}

/* ------------------------------------------------------------------ *
 * The ZIP underneath, read directly
 * ------------------------------------------------------------------ */

/**
 * What this module's own ZIP probe learned about the bytes.
 *
 * `unknown` exists so `translateSheetJsError` stays callable as a pure function
 * of a message — which is how its known-shapes table is unit-tested — while the
 * real read hands it the evidence it collected.
 */
export type ZipEvidence = 'opened' | 'unreadable' | 'unknown';

/**
 * Whether these bytes are a ZIP archive this build can open, judged by reading
 * the central directory and inflating **nothing** (`filter: () => false`).
 *
 * Cheap enough to run on a failure path, and it settles a question SheetJS's
 * error text cannot: `Unsupported ZIP file` is the single string it throws both
 * for a container it could not open *and* for a container it opened perfectly
 * that simply holds no `[Content_Types].xml`. Blaming the ZIP for the second is a
 * refusal message that misdescribes its own input.
 */
export function zipOpens(bytes: Uint8Array): boolean {
  try {
    unzipSync(bytes, { filter: () => false });
    return true;
  } catch {
    return false;
  }
}

/** One named entry, inflated on its own. `undefined` when it is not in the ZIP. */
function zipPart(bytes: Uint8Array, path: string): Uint8Array | undefined {
  try {
    return unzipSync(bytes, { filter: file => file.name === path })[path];
  } catch {
    return undefined;
  }
}

/** Where the workbook's relationships live in every `.xlsx` SheetJS will read. */
const WORKBOOK_RELS_PATH = 'xl/_rels/workbook.xml.rels';

/**
 * A workbook rel target is relative to `xl/`, and some producers write it
 * absolute, or reach back out of `xl/` with `../`.
 *
 * The `..` case is the one worth spelling out: `Target="../xl/worksheets/s1.xml"`
 * is legal OPC and, left unresolved, produces a path no ZIP entry matches — which
 * this module reads as "the worksheet part could not be located" and reports as
 * an *unreadable* sheet. A blank sheet misdescribed as damaged is a smaller lie
 * than the other way round, but it is still a wrong statement about the file.
 */
export function resolveWorkbookTarget(target: string): string {
  const clean = target.replace(/^\/+/, '');
  // A target that already starts at the package's `xl/` folder is taken as
  // written; anything else is relative to it.
  const joined = clean.startsWith('xl/') ? clean : `xl/${clean}`;
  const out: string[] = [];
  for (const segment of joined.split('/')) {
    if (segment === '' || segment === '.') continue;
    // A `..` that would climb above the package root is dropped, not honoured:
    // there is no entry up there to name.
    if (segment === '..') {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join('/');
}

/**
 * Decodes one XML part, honouring what it says about its own encoding.
 *
 * Almost every `.xlsx` in existence is UTF-8, and a plain `TextDecoder` is right
 * for all of them. The exception is cheap to handle and expensive to get wrong:
 * a UTF-16 part decoded as UTF-8 is a string full of NULs in which none of this
 * module's patterns match, so an intact worksheet would be reported as damaged
 * and a workbook's relationships would come back empty. The BOM is checked
 * first, then the XML declaration's own `encoding=`, and an encoding the
 * platform does not know falls back to UTF-8 rather than throwing.
 */
export function decodeXmlPart(bytes: Uint8Array): string {
  const [b0, b1] = [bytes[0], bytes[1]];
  if (b0 === 0xff && b1 === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (b0 === 0xfe && b1 === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  // No BOM, but a UTF-16 part still starts with `<` in one byte and NUL in the
  // other — the shape of `<?xml` in each order.
  if (b0 === 0x3c && b1 === 0x00) return new TextDecoder('utf-16le').decode(bytes);
  if (b0 === 0x00 && b1 === 0x3c) return new TextDecoder('utf-16be').decode(bytes);

  const utf8 = new TextDecoder().decode(bytes);
  // Only the declaration itself, which is by definition at the very start; a
  // stray `encoding="…"` in the body is an attribute, not a claim about bytes.
  const declared = /^<\?xml\b[^>]*\bencoding\s*=\s*["']([A-Za-z0-9._-]+)["']/.exec(utf8)?.[1];
  if (declared === undefined) return utf8;
  const label = declared.toLowerCase();
  if (label === 'utf-8' || label === 'utf8' || label === 'us-ascii' || label === 'ascii') {
    return utf8;
  }
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    // An encoding this platform has no decoder for. UTF-8 is the better guess of
    // the two available, and every caller here fails closed on nonsense anyway.
    return utf8;
  }
}

/**
 * `r:id` → the part it names, from the workbook's own relationships.
 *
 * A ten-line regex read of one small XML part rather than a second XML parser:
 * the only thing wanted from it is the `Id`/`Target` pair for a sheet whose grid
 * came back empty, and being wrong about it costs a *more* cautious message, not
 * a wrong document.
 */
function workbookRelTargets(bytes: Uint8Array): Map<string, string> {
  const targets = new Map<string, string>();
  const rels = zipPart(bytes, WORKBOOK_RELS_PATH);
  if (!rels) return targets;
  const text = decodeXmlPart(rels);
  const tag = /<(?:[A-Za-z0-9_.-]+:)?Relationship\b[^>]*>/g;
  let match: RegExpExecArray | null;
  while ((match = tag.exec(text)) !== null) {
    const id = /\bId="([^"]+)"/.exec(match[0])?.[1];
    const target = /\bTarget="([^"]+)"/.exec(match[0])?.[1];
    if (id !== undefined && target !== undefined) {
      targets.set(id, resolveWorkbookTarget(target));
    }
  }
  return targets;
}

/**
 * Whether a worksheet part is a *complete* worksheet document.
 *
 * Not a validator — a proxy for the one question that matters: did SheetJS's
 * regex-driven parser have a worksheet to find `sheetData` in? A part whose root
 * element is `worksheet` and which closes that element is one; garbage, HTML, a
 * `.xml` truncated mid-row and anything not UTF-8 text is not. That is exactly
 * the line between "the sheet is blank" and "the sheet did not parse", and it is
 * decided on the bytes rather than inferred from an empty result.
 */
export function isCompleteWorksheetPart(part: Uint8Array): boolean {
  const text = decodeXmlPart(part);
  const open = /<(?:[A-Za-z0-9_.-]+:)?worksheet(?=[\s/>])/.exec(text);
  if (!open) return false;
  const tagEnd = text.indexOf('>', open.index);
  if (tagEnd < 0) return false;
  // `<worksheet/>` — schema-invalid (`sheetData` is required) but unambiguously
  // complete, so it is a blank sheet and not a damaged one.
  if (text[tagEnd - 1] === '/') return true;
  return /<\/(?:[A-Za-z0-9_.-]+:)?worksheet\s*>/.test(text.slice(tagEnd));
}

/**
 * Why one sheet produced no grid: it really is blank, or its part did not parse.
 *
 * `blank` is only ever returned on positive evidence — the worksheet part was
 * found and is a complete worksheet document. Everything else, including "the
 * part could not be located in the package", is `unreadable`, because this
 * module must not tell someone their sheet is empty unless it knows that it is.
 */
export function worksheetPartState(
  bytes: Uint8Array,
  relTargets: Map<string, string>,
  sheetIndex: number,
  relId: string | undefined
): 'blank' | 'unreadable' {
  // The same two-step SheetJS uses: the rel target if there is one, else the
  // conventional `sheetN.xml` name.
  const path = (relId === undefined ? undefined : relTargets.get(relId)) ?? '';
  const candidates = [path, `xl/worksheets/sheet${sheetIndex + 1}.xml`].filter(
    candidate => candidate.length > 0
  );
  for (const candidate of candidates) {
    const part = zipPart(bytes, candidate);
    if (part) return isCompleteWorksheetPart(part) ? 'blank' : 'unreadable';
  }
  return 'unreadable';
}

/**
 * Turns whatever SheetJS threw into a message a user can act on.
 *
 * The matched shapes are the ones reproduced against `xlsx` 0.18.5 in
 * `tests/unit/excel-to-pdf.test.ts`; anything unmatched is still wrapped as a
 * refusal with the underlying text attached, rather than being allowed through as
 * an unhandled rejection.
 *
 * `zip` is the second review pass's finding 2. `Unsupported ZIP file` is thrown
 * both for a truncated container and for an intact ZIP holding no OOXML parts at
 * all (a `.zip` of one text file lands there), so the message alone cannot tell
 * them apart and this used to blame the container for both. A ZIP this module has
 * *proved* it can open is reported as "not a workbook" instead.
 */
export function translateSheetJsError(err: unknown, zip: ZipEvidence = 'unknown'): Error {
  const message = fromUnknown(err).message;

  if (/encryption|encrypted|password/i.test(message)) return unsupported(XLSX_LEGACY_MESSAGE);

  // The one container complaint a successful probe does not contradict: the probe
  // inflates nothing, so it never meets the compression method SheetJS refused.
  if (/Unsupported ZIP Compression/i.test(message)) return corrupt(XLSX_NOT_A_ZIP_MESSAGE);

  const containerBlamed =
    /Unsupported ZIP|End of data reached|end of central directory|Corrupted zip|invalid zip/i.test(
      message
    );
  const notAWorkbook =
    /Unknown Namespace|Unsupported file|Unrecognized|Unsupported (?:workbook|format)|Could not find workbook|Unsupported NUMBERS/i.test(
      message
    );

  if (notAWorkbook || (containerBlamed && zip === 'opened')) {
    return corrupt(XLSX_NOT_A_WORKBOOK_MESSAGE);
  }
  if (containerBlamed) return corrupt(XLSX_NOT_A_ZIP_MESSAGE);
  return corrupt(`This .xlsx could not be read, so nothing was converted (${message}).`);
}

/* ------------------------------------------------------------------ *
 * The read
 * ------------------------------------------------------------------ */

/**
 * Reads the `.xlsx` and returns the block model, one section per visible sheet.
 *
 * Throws rather than returning a partial result: a half-read workbook laid out
 * as a PDF that looks complete is the silent-corruption outcome PLAN §5.2
 * forbids outright.
 */
export async function readXlsxAsBlocks(
  bytes: Uint8Array,
  job?: JobHandle
): Promise<XlsxBlocksResult> {
  await checkpoint(job, 0, 'Reading the workbook');

  if (bytes.length === 0) throw corrupt(XLSX_EMPTY_MESSAGE);
  if (startsWith(bytes, OLE2_MAGIC)) throw unsupported(XLSX_LEGACY_MESSAGE);
  // Not a courtesy check — see the module comment: `XLSX.read` answers binary
  // garbage with a plausible-looking one-sheet workbook rather than an error.
  if (!startsWith(bytes, ZIP_MAGIC)) throw corrupt(XLSX_NOT_A_ZIP_MESSAGE);

  const XLSX = await import('xlsx');
  await checkpoint(job, 0.15, 'Reading the workbook');

  let workbook;
  try {
    workbook = XLSX.read(bytes, {
      type: 'array',
      // `cellDates` + `cellNF` + `cellText` are what make `w` — the string Excel
      // itself last displayed — available per cell, which is the whole of this
      // ticket's "basic number/date formatting preserved".
      cellDates: true,
      cellNF: true,
      cellText: true,
      // The only source of `!cols`/`!rows`, and so the only way to know which
      // rows and columns are hidden and how wide a column is.
      cellStyles: true,
      // Read-only means read-only: no VBA, and no stub cells invented for
      // addresses the file never wrote.
      bookVBA: false,
      sheetStubs: false
    });
  } catch (err) {
    // The evidence is collected only now, on the failure path, so an ordinary
    // conversion still opens the archive exactly once.
    throw translateSheetJsError(err, zipOpens(bytes) ? 'opened' : 'unreadable');
  }

  const names = workbook.SheetNames ?? [];
  // Reachable, not defensive: a `xl/workbook.xml` whose `<sheets/>` element is
  // empty parses cleanly and yields exactly this. SheetJS's *writer* refuses to
  // produce one ("Workbook is empty"), which is why the test for this message has
  // to hand-build the package.
  if (names.length === 0) throw corrupt(XLSX_NO_SHEETS_MESSAGE);

  const notes: string[] = [];

  // A repeated name is malformed input that parses cleanly and loses a sheet
  // silently — SheetJS keys `Sheets` by name, so the collision happened before
  // this module was handed the workbook. Detected here, once, over the names.
  const seenNames = new Set<string>();
  const repeatedNames: string[] = [];
  for (const name of names) {
    if (seenNames.has(name)) {
      if (!repeatedNames.includes(name)) repeatedNames.push(name);
    } else {
      seenNames.add(name);
    }
  }
  if (repeatedNames.length > 0) notes.push(duplicateSheetNamesNote(repeatedNames));

  // Visibility lives in the workbook-level sheet list, positionally aligned with
  // `SheetNames`. 0 = visible, 1 = hidden, 2 = very hidden. `id` is the `r:id`
  // SheetJS parses off `<sheet>` and does not declare in its types; it is what
  // maps a sheet to its worksheet part, needed only when a sheet draws nothing.
  const props = (workbook.Workbook?.Sheets ?? []) as readonly SheetPropsLike[];
  const hiddenNames: string[] = [];
  const visible: { name: string; sheetIndex: number }[] = [];
  names.forEach((name, index) => {
    if ((props[index]?.Hidden ?? 0) === 0) visible.push({ name, sheetIndex: index });
    else hiddenNames.push(name);
  });
  if (hiddenNames.length > 0) notes.push(hiddenSheetsNote(hiddenNames));
  if (visible.length === 0) throw unsupported(XLSX_ALL_SHEETS_HIDDEN_MESSAGE);

  const selected = visible.slice(0, MAX_SHEETS);
  if (visible.length > MAX_SHEETS) notes.push(sheetCapNote(visible.length));

  const blocks: LayoutBlock[] = [];
  const sheets: SheetSummary[] = [];
  let truncatedCells = 0;
  let uncachedFormulas = 0;

  /**
   * The workbook's rel targets, read from the ZIP the first time a sheet turns
   * out to have no grid — which for most workbooks is never.
   */
  let relTargets: Map<string, string> | undefined;

  /**
   * The section and summary for a sheet with no grid to draw, honestly labelled.
   *
   * Three reasons, three different sentences, and only one of them is "empty":
   * the part did not parse (`unreadable`), every cell is an uncalculated formula
   * (`formulas`), or the sheet really does hold nothing.
   */
  const noGrid = (name: string, reason: 'empty' | 'unreadable' | 'formulas') => {
    if (reason === 'unreadable') notes.push(unreadableSheetNote(name));
    blocks.push({
      kind: 'paragraph',
      runs: [
        {
          text:
            reason === 'unreadable'
              ? XLSX_SHEET_UNREADABLE_TEXT
              : reason === 'formulas'
                ? XLSX_SHEET_FORMULAS_ONLY_TEXT
                : XLSX_SHEET_EMPTY_TEXT,
          bold: false,
          italic: false
        }
      ]
    });
    sheets.push({
      name,
      rows: 0,
      columns: 0,
      bands: 0,
      empty: reason === 'empty',
      unreadable: reason === 'unreadable'
    });
  };

  for (let position = 0; position < selected.length; position++) {
    const { name, sheetIndex } = selected[position];
    await checkpoint(
      job,
      0.15 + (position / selected.length) * 0.8,
      `Reading sheet ${position + 1} of ${selected.length}`
    );

    const sheet = workbook.Sheets[name];
    blocks.push({ kind: 'heading', level: 2, runs: [{ text: name, bold: true, italic: false }] });

    if (!sheet) {
      // A name in `SheetNames` with no sheet object behind it: `safe_parse_sheet`
      // threw before it could assign one. Reported as a section rather than
      // skipped, so the PDF still has one per sheet.
      noGrid(name, 'unreadable');
      continue;
    }

    // The *actual* extent, from the cells that exist — never the declared
    // `!ref`, which a generator is free to write as `A1:B1048576` for a sheet
    // holding one cell. Iterating that would be a million-row loop.
    let firstRow = Number.POSITIVE_INFINITY;
    let lastRow = -1;
    let firstColumn = Number.POSITIVE_INFINITY;
    let lastColumn = -1;
    /**
     * Where this sheet's formula cells with no cached result sit. Collected
     * rather than counted on the spot, because whether one is worth reporting
     * depends on the range the sheet actually draws — which is not known until
     * hidden rows and the row/column caps below have been applied. Counting them
     * here made the diagnostic claim uncalculated formulas were why a capped
     * sheet's 5,000th row is missing, when the cap was.
     */
    const uncachedAt: { row: number; column: number }[] = [];
    for (const key of Object.keys(sheet)) {
      if (key.startsWith('!')) continue;
      const at = XLSX.utils.decode_cell(key);
      if (!Number.isFinite(at.r) || !Number.isFinite(at.c) || at.r < 0 || at.c < 0) continue;
      const cell = sheet[key] as SheetCell;
      if (cellText(cell).length === 0) {
        // A cell that draws nothing does not widen the grid — otherwise a stray
        // formatted-but-empty cell in column ZZ would add 700 blank columns. It
        // is still noted here if it is a formula with no cached result, which is
        // the one case where "nothing to draw" is worth telling the user about;
        // looking for it inside the grid loop below would miss it, since it is
        // exactly the cell the extent excludes.
        if (cell?.f !== undefined) uncachedAt.push({ row: at.r, column: at.c });
        continue;
      }
      if (at.r < firstRow) firstRow = at.r;
      if (at.r > lastRow) lastRow = at.r;
      if (at.c < firstColumn) firstColumn = at.c;
      if (at.c > lastColumn) lastColumn = at.c;
    }

    if (lastRow < 0 || lastColumn < 0) {
      if (uncachedAt.length > 0) {
        // Not empty, and the sheet object itself proves it: it holds cells, all
        // of them formulas whose cached result is missing. Every one of them is
        // counted, because here they are not "some cells outside the drawn
        // range" — they are the whole sheet, and the reason it draws nothing.
        uncachedFormulas += uncachedAt.length;
        noGrid(name, 'formulas');
        continue;
      }
      // Nothing to draw — and the reason is *not* knowable from `sheet`, which is
      // the identical `{}` whether the sheet is blank or its worksheet part never
      // parsed (see `XLSX_SHEET_UNREADABLE_TEXT`). So it is settled against the
      // bytes: "empty" requires finding an intact worksheet part.
      relTargets ??= workbookRelTargets(bytes);
      const state = worksheetPartState(bytes, relTargets, sheetIndex, props[sheetIndex]?.id);
      noGrid(name, state === 'unreadable' ? 'unreadable' : 'empty');
      continue;
    }

    const rowInfo = (sheet['!rows'] as RowInfoLike[] | undefined) ?? [];
    const columnInfo = (sheet['!cols'] as ColumnInfo[] | undefined) ?? [];

    const allRows: number[] = [];
    let hiddenRows = 0;
    for (let row = firstRow; row <= lastRow; row++) {
      if (rowInfo[row]?.hidden === true) hiddenRows += 1;
      else allRows.push(row);
    }
    const allColumns: number[] = [];
    let hiddenColumns = 0;
    for (let column = firstColumn; column <= lastColumn; column++) {
      if (columnInfo[column]?.hidden === true) hiddenColumns += 1;
      else allColumns.push(column);
    }
    if (hiddenRows > 0) notes.push(hiddenRowsNote(name, hiddenRows));
    if (hiddenColumns > 0) notes.push(hiddenColumnsNote(name, hiddenColumns));

    const rows = allRows.slice(0, MAX_SHEET_ROWS);
    if (allRows.length > MAX_SHEET_ROWS) notes.push(rowCapNote(name, allRows.length));
    const columns = allColumns.slice(0, MAX_SHEET_COLUMNS);
    if (allColumns.length > MAX_SHEET_COLUMNS) notes.push(columnCapNote(name, allColumns.length));

    if (rows.length === 0 || columns.length === 0) {
      // Everything with content in it was hidden. The section still says so.
      blocks.push({
        kind: 'paragraph',
        runs: [
          {
            text: 'Every row or column with content in this sheet is hidden, so the grid is empty.',
            bold: false,
            italic: false
          }
        ]
      });
      sheets.push({ name, rows: 0, columns: 0, bands: 0, empty: true, unreadable: false });
      continue;
    }

    // An uncalculated formula is counted only where *it* is the reason nothing
    // was drawn for that cell. One in a hidden row, or past the row/column cap,
    // is absent from the PDF for a reason that already has its own note, and
    // counting it here would tell the user their missing rows were formulas when
    // the cap was. A cell beyond the extent of everything that has text *is*
    // counted: nothing but its own missing value put it there.
    const lastDrawnRow = rows[rows.length - 1];
    const lastDrawnColumn = columns[columns.length - 1];
    const rowCapped = allRows.length > MAX_SHEET_ROWS;
    const columnCapped = allColumns.length > MAX_SHEET_COLUMNS;
    for (const at of uncachedAt) {
      if (rowInfo[at.row]?.hidden === true) continue;
      if (columnInfo[at.column]?.hidden === true) continue;
      if (rowCapped && at.row > lastDrawnRow) continue;
      if (columnCapped && at.column > lastDrawnColumn) continue;
      uncachedFormulas += 1;
    }

    // The grid, read once: the layout below needs both the text (to draw) and its
    // length (to approximate a column width), so reading each cell twice would be
    // two passes over the same worksheet.
    const grid: StyledRun[][][] = [];
    const widestChars = columns.map(() => 0);
    for (const row of rows) {
      const cells: StyledRun[][] = [];
      columns.forEach((column, columnIndex) => {
        const cell = sheet[cellAddress(row, column)] as SheetCell | undefined;
        let text = cellText(cell);
        if (text.length > MAX_CELL_CHARS) {
          text = `${text.slice(0, MAX_CELL_CHARS - 1).trimEnd()}…`;
          truncatedCells += 1;
        }
        if (text.length > widestChars[columnIndex]) widestChars[columnIndex] = text.length;
        const href = externalTarget(cell);
        cells.push(
          text.length === 0 ? [] : [{ text, bold: false, italic: false, ...(href ? { href } : {}) }]
        );
      });
      grid.push(cells);
    }

    const widths = columns.map((column, columnIndex) =>
      columnWidthPt(columnInfo[column], widestChars[columnIndex])
    );
    const bands = bandColumns(widths);

    bands.forEach((band, bandIndex) => {
      if (bands.length > 1) {
        // Said in the document itself, not only in a note: a reader looking at
        // the third grid under one sheet name needs to know which columns it is.
        const from = columnName(columns[band[0]]);
        const to = columnName(columns[band[band.length - 1]]);
        // A plain hyphen, not an en dash: `markdown-to-pdf.ts`'s WinAnsi
        // sanitiser rewrites `–` to `-` on the way into the page, and a label
        // whose source text does not match the text in the PDF is a small trap
        // for anyone grepping for it.
        blocks.push({
          kind: 'paragraph',
          runs: [
            {
              text: `Columns ${from}-${to} (${bandIndex + 1} of ${bands.length})`,
              bold: false,
              italic: true
            }
          ]
        });
      }
      blocks.push({
        kind: 'table',
        rows: grid.map(row => band.map(columnIndex => row[columnIndex])),
        columnWidths: band.map(columnIndex => widths[columnIndex])
      });
    });

    sheets.push({
      name,
      rows: rows.length,
      columns: columns.length,
      bands: bands.length,
      empty: false,
      unreadable: false
    });
  }

  if (truncatedCells > 0) notes.push(truncatedCellsNote(truncatedCells));
  if (uncachedFormulas > 0) notes.push(uncachedFormulaNote(uncachedFormulas));

  await checkpoint(job, 0.98, 'Reading the workbook');

  const title = workbook.Props?.Title;
  return {
    blocks,
    notes,
    sheets,
    ...(typeof title === 'string' && title.length > 0 ? { title } : {})
  };
}
