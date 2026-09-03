/**
 * The XLSX writer — one hand-rolled OOXML builder, shared by OCR-03 and CNV-10.
 *
 * OCR-03 shipped this as `exportTableToXlsx` in `ocr/table-extract.ts`: one grid,
 * one sheet, the OPC package assembled by hand and zipped with `fflate`. CNV-10
 * needs the same package with N sheets, and the ticket is explicit that this must
 * not become a second writer or a new dependency. So the package assembly moved
 * here and grew a sheet list; `exportTableToXlsx` is now a one-line caller of it,
 * which means an escaping or content-type bug can only exist in one place.
 *
 * Why hand-rolled at all: `fflate` is already in the bundle (CNV-06's image
 * archive, the DOCX/`mammoth` readers), and a spreadsheet with inline strings and
 * no styles is about 60 lines of XML. Pulling in a writer library for that would
 * cost a dependency and a chunk for no capability.
 *
 * Everything is written as an **inline string** (`t="inlineStr"`), never a shared
 * string and never a number. A PDF's text layer gives us glyphs, not types:
 * "1,204" is a string that looks like a number, "007" loses its zeros the moment
 * something decides it is one, and a date is whatever the locale of the producer
 * said it was. Excel still reads an inline string cell as text you can convert
 * yourself; guessing here would silently change values.
 */

import { strToU8, zipSync } from 'fflate';
import { columnRef } from './column-ref';
import { internal } from '../errors';

/** One worksheet: a name and a rectangular-ish grid of already-stringified cells. */
export interface XlsxSheet {
  /** Sanitized and de-duplicated by {@link buildXlsx}; callers may pass anything. */
  name: string;
  rows: readonly (readonly string[])[];
}

export interface XlsxOptions {
  /** Written to `docProps/core.xml` as `<dc:title>`. Omitted when absent. */
  title?: string;
  /**
   * Called once, with the number of cells **this writer** had to shorten to
   * Excel's {@link MAX_CELL_CHARS} limit, when that number is not zero.
   *
   * Normally it never fires: a caller that cares about the loss (CNV-10's
   * `planWorkbook`) truncates first, so it can say *which* cells and count them
   * into its own disclosure. This is the backstop underneath that, for the
   * caller that forgets — the truncation happens either way, because an
   * over-long cell makes Excel offer to repair the file, but it is never allowed
   * to happen *silently*.
   */
  onTruncatedCells?: (cells: number) => void;
}

/**
 * Excel's own limit on a sheet name. Longer names make the workbook unopenable
 * rather than merely ugly, so this is a correctness constraint, not a style one.
 */
const MAX_SHEET_NAME = 31;

/** Characters Excel forbids in a sheet name. */
const ILLEGAL_SHEET_NAME = /[\\/?*[\]:]/g;

/**
 * Excel's hard cap on the characters one cell can hold. Past it the file opens
 * with a repair prompt, which is worse than a truncated cell.
 *
 * Enforced *here*, in the one writer, as well as by the callers that care about
 * the loss (CNV-10's `planWorkbook` truncates first so it can count and disclose
 * it). Leaving a hard format limit to caller discipline means the first caller
 * that forgets ships a workbook Excel offers to repair — the failure this
 * codebase treats as worse than a visibly shortened cell. See
 * {@link XlsxOptions.onTruncatedCells} for how the writer says it did.
 */
export const MAX_CELL_CHARS = 32767;

/**
 * Makes a sheet name Excel will accept: no illegal characters, not empty, not
 * longer than 31, not the reserved word "History", no leading or trailing
 * apostrophe. Never throws — a name is cosmetic and refusing to write a workbook
 * over one would be the wrong trade.
 */
export function sanitizeSheetName(name: string): string {
  let out = name.replace(ILLEGAL_SHEET_NAME, ' ').replace(/\s+/g, ' ').trim();
  out = out.replace(/^'+/, '').replace(/'+$/, '').trim();
  if (out.length > MAX_SHEET_NAME) out = out.slice(0, MAX_SHEET_NAME).trim();
  if (out.length === 0) return 'Sheet';
  // Excel reserves this one name for its change log and refuses a sheet called it.
  if (out.toLowerCase() === 'history') return 'History sheet';
  return out;
}

/**
 * Sanitizes and de-duplicates a list of sheet names, preserving order.
 *
 * Two sheets with one name is not a cosmetic problem: Excel refuses to open the
 * workbook. The disambiguating suffix is applied *inside* the 31-character limit,
 * so a long name cannot smuggle the file back over it.
 */
export function uniqueSheetNames(names: readonly string[]): string[] {
  const taken = new Set<string>();
  return names.map(raw => {
    const base = sanitizeSheetName(raw);
    let candidate = base;
    let n = 2;
    while (taken.has(candidate.toLowerCase())) {
      const suffix = ` (${n})`;
      candidate = `${base.slice(0, Math.max(1, MAX_SHEET_NAME - suffix.length)).trim()}${suffix}`;
      n += 1;
    }
    taken.add(candidate.toLowerCase());
    return candidate;
  });
}

/**
 * Builds a real `.xlsx` (OPC package) from one or more sheets.
 *
 * Refuses an empty workbook rather than writing a file Excel offers to repair —
 * the same rule `buildDocx` applies to an empty document. A caller that has
 * nothing to write has a message to give the user, not a file to save.
 */
export function buildXlsx(sheets: readonly XlsxSheet[], options: XlsxOptions = {}): Uint8Array {
  if (sheets.length === 0) {
    throw internal('A spreadsheet needs at least one sheet; nothing was written.');
  }

  const names = uniqueSheetNames(sheets.map(sheet => sheet.name));
  const hasTitle = typeof options.title === 'string' && options.title.length > 0;

  const sheetOverrides = sheets
    .map(
      (_, i) =>
        `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ` +
        `ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
    )
    .join('');

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  ${sheetOverrides}${
    hasTitle
      ? '<Override PartName="/docProps/core.xml" ' +
        'ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
      : ''
  }
</Types>`;

  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>${
    hasTitle
      ? '<Relationship Id="rId2" ' +
        'Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" ' +
        'Target="docProps/core.xml"/>'
      : ''
  }
</Relationships>`;

  const workbookRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${sheets
    .map(
      (_, i) =>
        `<Relationship Id="rId${i + 1}" ` +
        `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" ` +
        `Target="worksheets/sheet${i + 1}.xml"/>`
    )
    .join('')}
</Relationships>`;

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    ${names
      .map((name, i) => `<sheet name="${xmlEscape(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join('')}
  </sheets>
</workbook>`;

  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(contentTypesXml),
    '_rels/.rels': strToU8(relsXml),
    'xl/_rels/workbook.xml.rels': strToU8(workbookRelsXml),
    'xl/workbook.xml': strToU8(workbookXml)
  };

  // Counted across every sheet, reported once: a caller wants "17 cells were
  // shortened", not seventeen callbacks.
  const truncated = { cells: 0 };
  sheets.forEach((sheet, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(sheet.rows, truncated));
  });
  if (truncated.cells > 0) options.onTruncatedCells?.(truncated.cells);

  if (hasTitle) {
    files['docProps/core.xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:title>${xmlEscape(options.title as string)}</dc:title>
</cp:coreProperties>`);
  }

  return zipSync(files);
}

/** One worksheet part. Empty cells are omitted, which is what a sparse grid is. */
function sheetXml(rows: readonly (readonly string[])[], truncated: { cells: number }): string {
  const sheetRowsXml = rows
    .map((row, rIdx) => {
      const rowNum = rIdx + 1;
      const cellsXml = row
        .map((cell, cIdx) => {
          if (!cell) return '';
          const ref = `${columnRef(cIdx)}${rowNum}`;
          // Measured before escaping, because the limit is on the cell's own
          // characters — `&amp;` is one character to Excel and five here, and
          // cutting the escaped form could also split an entity in half.
          let text = cell;
          if (text.length > MAX_CELL_CHARS) {
            text = text.slice(0, MAX_CELL_CHARS);
            truncated.cells += 1;
          }
          return `<c r="${ref}" t="inlineStr"><is><t>${xmlEscape(text)}</t></is></c>`;
        })
        .join('');
      return `<row r="${rowNum}">${cellsXml}</row>`;
    })
    .join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>${sheetRowsXml}</sheetData>
</worksheet>`;
}

/**
 * Escapes for XML text and attribute content, and drops the code points XML 1.0
 * has no representation for at all.
 *
 * The strip matters more than the escape here. A PDF's text layer can carry NUL,
 * BEL or a stray form feed — a producer bug, or a font with an odd `/ToUnicode`
 * map — and a literal control character in the part makes the whole workbook
 * unparseable, which Excel reports as a corrupt file rather than as a bad cell.
 * Tab, newline and carriage return are legal and kept.
 */
function stripInvalidXmlChars(str: string): string {
  // Written as a code-point scan rather than a regex character class because the
  // class would have to be spelled with escapes for characters that must never
  // appear literally in this source file in the first place.
  let out = '';
  let clean = true;
  for (const ch of str) {
    const code = ch.codePointAt(0) as number;
    const valid =
      code === 0x9 ||
      code === 0xa ||
      code === 0xd ||
      (code >= 0x20 && code <= 0xd7ff) ||
      // 0xD800–0xDFFF are surrogates. A well-formed pair arrives from `for…of`
      // as one code point above 0xFFFF and passes on the last clause; a *lone*
      // surrogate lands in this gap and is dropped, which is the only correct
      // answer — it is not a character.
      (code >= 0xe000 && code <= 0xfffd) ||
      code >= 0x10000;
    if (valid) out += ch;
    else clean = false;
  }
  return clean ? str : out;
}

export function xmlEscape(str: string): string {
  return stripInvalidXmlChars(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 0 → "A", 25 → "Z", 26 → "AA".
 *
 * Re-exported rather than implemented here: `xlsx-reader.ts` needs the same
 * bijective base-26 to look a cell up and to label a column band, and two copies
 * of it were two places for the same off-by-one past column Z. See
 * `column-ref.ts`.
 */
export { columnRef as getColRef } from './column-ref';
