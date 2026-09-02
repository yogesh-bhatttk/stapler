/**
 * CNV-10 — PDF → Excel (XLSX), graded against real output bytes.
 *
 * The acceptance criterion asks for the produced workbook to be "re-opened via
 * the `xlsx` reader" and its cell grid compared to the fixture's. It is, twice
 * over, and the two readings are complementary rather than redundant:
 *
 *  1. **SheetJS itself** (`xlsx`, a devDependency — verification only, never
 *     bundled; CNV-11 will promote it to a runtime dependency for its read side).
 *     `XLSX.read()` on the produced bytes is the literal thing the criterion
 *     asks for and the only check here written by someone other than this repo:
 *     an outside reader accepting the file, and its grid equalling the fixture's.
 *  2. **The package, opened by hand** with `fflate`: each worksheet part is
 *     parsed back into a grid keyed by its `r="B3"` reference rather than by
 *     position, so a cell written to the wrong column or a row emitted out of
 *     order fails the comparison. This one sees what a tolerant reader forgives
 *     — SheetJS repairs a good deal of malformed XML on the way in, so it cannot
 *     be the evidence that the *bytes* are well formed.
 *
 * Two further checks stand in for the reader's own well-formedness pass:
 *
 *  • every part in the package is run through a strict XML scanner
 *    (`assertWellFormedXml`), which is what would catch an unescaped `&` or a
 *    stray control character out of a PDF's text layer, and
 *  • the package's relationship graph is followed — a `<sheet r:id>` must resolve
 *    through `workbook.xml.rels` to a part that exists and is declared in
 *    `[Content_Types].xml`. A workbook that fails any of those is the shape of a
 *    file Excel offers to repair.
 *
 * As in CNV-08's and CNV-09's round-trip tests, the function under test is the
 * production entry point: `vi.mock('../../src/core/workers')` leases the *real*
 * render and convert worker implementations, so `operations.convertPdfToXlsx`
 * runs its own sequencing, its own progress bands and its own refusals rather
 * than a re-implementation of them.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { strFromU8, unzipSync } from 'fflate';
// SheetJS, the reader the acceptance criterion names. A devDependency: it is
// imported by tests only and never by anything under `src/`, so it is not in the
// shipped bundle (`pnpm check:bundle` is unchanged by its addition).
import * as XLSX from 'xlsx';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  PDF_TO_EXCEL,
  PDF_TO_EXCEL_PROSE,
  pdfToExcelPdf,
  pdfToExcelProsePdf
} from '../e2e/fixtures';
import {
  pageSheet,
  planWorkbook,
  hasNoText,
  NO_TEXT_LAYER_MESSAGE
} from '../../src/core/convert/sheets';
import {
  buildXlsx,
  sanitizeSheetName,
  uniqueSheetNames,
  getColRef,
  xmlEscape
} from '../../src/core/convert/xlsx-writer';
import { findTableRegions } from '../../src/core/convert/table-regions';
import { layoutLines } from '../../src/core/text-layout';
import { hasXfaMarker, XFA_CONVERT_MESSAGE } from '../../src/core/pdf/xfa';
import { StaplerError } from '../../src/core/errors';

vi.mock('comlink', () => ({
  expose: vi.fn(),
  transfer: vi.fn(value => value),
  // `createJobHandle` wraps its port in `Comlink.proxy`, so the stub needs it as
  // soon as a real `operations.ts` entry point is called rather than a worker
  // method directly.
  proxy: vi.fn(value => value)
}));
vi.mock('../../src/core/workers/pdfjs-setup', async () => {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return {
    pdfjsLib,
    openDocument: ({ data, password }: { data: Uint8Array; password?: string }) =>
      pdfjsLib.getDocument({ data, password, disableFontFace: true })
  };
});

/** How many times the writer was reached. A refusal must leave this at 0. */
let buildXlsxCalls = 0;
/** How many pages were actually read. A cancelled run must stop short of them all. */
let extractPageSheetCalls = 0;

vi.mock('../../src/core/workers', async () => {
  const { renderWorkerImpl } = await import('../../src/core/workers/render.worker');
  const { convertWorkerImpl } = await import('../../src/core/workers/convert.worker');
  type Bytes = Uint8Array;

  // `.slice()` stands in for the structured clone the real Comlink boundary
  // performs: pdf.js takes ownership of (and detaches) what `loadDocument` is
  // given, which is an artefact of calling the implementations in-process.
  const renderApi = {
    loadDocument: (bytes: Bytes, password?: string) =>
      renderWorkerImpl.loadDocument(bytes.slice(), password),
    extractPageSheet: (handle: string, pageIndex: number) => {
      extractPageSheetCalls++;
      return renderWorkerImpl.extractPageSheet(handle, pageIndex);
    },
    closeDocument: (handle: string) => renderWorkerImpl.closeDocument(handle)
  };
  const convertApi = {
    buildXlsx: (...args: Parameters<typeof convertWorkerImpl.buildXlsx>) => {
      buildXlsxCalls++;
      return convertWorkerImpl.buildXlsx(...args);
    }
  };
  const leaseOn =
    <T>(target: T) =>
    (fn: (api: T) => Promise<unknown>) =>
      fn(target);
  return {
    renderWorker: {
      lease: leaseOn(renderApi),
      pin: () => ({ lease: leaseOn(renderApi), release: () => {} })
    },
    processWorker: { lease: leaseOn({}) },
    cvWorker: { lease: leaseOn({}) },
    ocrWorker: { lease: leaseOn({}) },
    convertWorker: { lease: leaseOn(convertApi) }
  };
});

const { convertPdfToXlsx } = await import('../../src/core/operations');

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(`tests/fixtures/${name}`));
}

/* ------------------------------------------------------------------ *
 * Reading a produced workbook back
 * ------------------------------------------------------------------ */

/**
 * A strict-enough XML well-formedness scan: balanced elements, quoted attribute
 * values, and no raw `<` or `&` in text. Deliberately hand-rolled — a real parser
 * would be a new dependency, and the failure mode this guards against (an
 * unescaped character from a PDF's text layer reaching a part verbatim) is
 * exactly what a scanner like this catches.
 */
function assertWellFormedXml(part: string, label: string): void {
  const stack: string[] = [];
  let i = 0;
  while (i < part.length) {
    const lt = part.indexOf('<', i);
    if (lt === -1) {
      assertTextIsEscaped(part.slice(i), label);
      break;
    }
    assertTextIsEscaped(part.slice(i, lt), label);

    if (part.startsWith('<?', lt)) {
      const end = part.indexOf('?>', lt);
      expect(end, `${label}: unterminated processing instruction`).toBeGreaterThan(-1);
      i = end + 2;
      continue;
    }

    const gt = findTagEnd(part, lt, label);
    const tag = part.slice(lt + 1, gt);
    expect(tag.length, `${label}: empty tag`).toBeGreaterThan(0);

    if (tag.startsWith('/')) {
      expect(stack.pop(), `${label}: mismatched closing tag </${tag.slice(1)}>`).toBe(tag.slice(1));
    } else if (!tag.endsWith('/')) {
      stack.push(tag.split(/[\s]/)[0]);
    }
    i = gt + 1;
  }
  expect(stack, `${label}: unclosed elements`).toEqual([]);
}

/** The `>` that ends a tag, skipping any inside a quoted attribute value. */
function findTagEnd(part: string, lt: number, label: string): number {
  let quote: string | null = null;
  for (let i = lt + 1; i < part.length; i++) {
    const ch = part[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '>') return i;
    else if (ch === '<') break;
  }
  throw new Error(`${label}: unterminated tag at offset ${lt}`);
}

/** No raw `<`, and every `&` starts a real entity reference. */
function assertTextIsEscaped(text: string, label: string): void {
  expect(text.includes('<'), `${label}: raw "<" in text`).toBe(false);
  for (const match of text.matchAll(/&[^;]*;?/g)) {
    expect(match[0], `${label}: unescaped ampersand`).toMatch(
      /^&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);$/
    );
  }
  // Control characters XML 1.0 has no representation for must never reach a part.
  for (const ch of text) {
    const code = ch.codePointAt(0) as number;
    const legal =
      code === 0x9 ||
      code === 0xa ||
      code === 0xd ||
      (code >= 0x20 && code <= 0xd7ff) ||
      (code >= 0xe000 && code <= 0xfffd) ||
      code >= 0x10000;
    expect(legal, `${label}: illegal XML character U+${code.toString(16)}`).toBe(true);
  }
}

/** The one namespace every part of a SpreadsheetML package hangs off. */
const SPREADSHEETML_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

interface ReadWorkbook {
  /** Sheet name → grid, indexed by the cells' own `r="B3"` references. */
  sheets: Map<string, string[][]>;
  /** Sheet names in workbook order. */
  order: string[];
  parts: Record<string, Uint8Array>;
}

/**
 * Re-opens a produced `.xlsx`: unzips the package, follows the relationship graph
 * from `workbook.xml` to each worksheet part, and rebuilds each sheet's grid from
 * the cell references the file itself carries.
 *
 * Rebuilding from `r="B3"` rather than from element order is the point: a cell
 * written into the wrong column, or a row emitted out of order, produces a
 * different grid here and fails the comparison.
 */
function readXlsx(bytes: Uint8Array): ReadWorkbook {
  const parts = unzipSync(bytes);

  for (const [name, data] of Object.entries(parts)) {
    if (name.endsWith('.xml') || name.endsWith('.rels')) {
      assertWellFormedXml(strFromU8(data), name);
    }
  }

  const contentTypes = strFromU8(parts['[Content_Types].xml']);
  const workbook = strFromU8(parts['xl/workbook.xml']);
  expect(workbook, 'xl/workbook.xml does not declare the spreadsheetml namespace').toContain(
    `<workbook xmlns="${SPREADSHEETML_NS}"`
  );
  const rels = strFromU8(parts['xl/_rels/workbook.xml.rels']);

  const targetById = new Map(
    [...rels.matchAll(/<Relationship Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map(m => [m[1], m[2]])
  );

  const sheets = new Map<string, string[][]>();
  const order: string[] = [];

  for (const match of workbook.matchAll(/<sheet name="([^"]*)"[^>]*r:id="([^"]+)"\/>/g)) {
    const name = unescapeXml(match[1]);
    const target = targetById.get(match[2]);
    expect(target, `no relationship for ${match[2]}`).toBeTruthy();
    const partName = `xl/${target}`;
    expect(Object.keys(parts), `${partName} is missing from the package`).toContain(partName);
    expect(contentTypes, `${partName} has no content type`).toContain(`/${partName}`);

    order.push(name);
    const sheetXml = strFromU8(parts[partName]);
    // Found by mutating the writer: SheetJS reads a worksheet with no namespace
    // declaration quite happily, and so did this parser, but Excel rejects the
    // package. Neither round trip covered it, so it is asserted directly.
    expect(sheetXml, `${partName} does not declare the spreadsheetml namespace`).toContain(
      `<worksheet xmlns="${SPREADSHEETML_NS}"`
    );
    sheets.set(name, sheetGrid(sheetXml));
  }

  return { sheets, order, parts };
}

/** One worksheet part → a dense grid, placed by each cell's own reference. */
function sheetGrid(xml: string): string[][] {
  const grid: string[][] = [];
  for (const rowMatch of xml.matchAll(/<row r="(\d+)">([\s\S]*?)<\/row>/g)) {
    const rowIndex = Number(rowMatch[1]) - 1;
    const cells: string[] = [];
    for (const cellMatch of rowMatch[2].matchAll(
      /<c r="([A-Z]+)(\d+)" t="inlineStr"><is><t>([\s\S]*?)<\/t><\/is><\/c>/g
    )) {
      expect(Number(cellMatch[2]) - 1, 'a cell reference disagrees with its row').toBe(rowIndex);
      const colIndex = colIndexOf(cellMatch[1]);
      while (cells.length <= colIndex) cells.push('');
      cells[colIndex] = unescapeXml(cellMatch[3]);
    }
    while (grid.length <= rowIndex) grid.push([]);
    grid[rowIndex] = cells;
  }
  return grid;
}

/** "A" → 0, "AA" → 26. The inverse of the writer's `getColRef`. */
function colIndexOf(ref: string): number {
  let n = 0;
  for (const ch of ref) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** The production entry point, nothing else. */
async function convert(
  bytes: Uint8Array,
  {
    includePageText = true,
    documentName
  }: { includePageText?: boolean; documentName?: string } = {}
) {
  const progress: number[] = [];
  const result = await convertPdfToXlsx(
    bytes,
    { includePageText, documentName },
    { onProgress: fraction => progress.push(fraction) }
  );
  return { ...result, progress };
}

/* ------------------------------------------------------------------ *
 * AC 1 — the table's grid survives the round trip exactly
 * ------------------------------------------------------------------ */

describe('CNV-10 — PDF to XLSX round trip', () => {
  it("reproduces the fixture table's cell grid exactly, row for row and column for column", async () => {
    const result = await convert(await pdfToExcelPdf());
    const book = readXlsx(result.bytes);

    // One sheet for the page-1 table, plus a text sheet for each page's
    // non-table lines.
    expect(book.order).toEqual(['Page 1 Table', 'Page 1 Text', 'Page 2 Text']);
    expect(result.tableCount).toBe(1);
    expect(result.sheetCount).toBe(3);
    expect(result.pageCount).toBe(2);

    // The criterion itself: the cell grid, re-read from the produced bytes,
    // equals the fixture's table. Not a subset, not "contains" — equal.
    expect(book.sheets.get('Page 1 Table')).toEqual(PDF_TO_EXCEL.table.map(row => [...row]));
  }, 120_000);

  it('puts the page-1 lines that are not in the table on their own sheet, one row per line', async () => {
    const { bytes } = await convert(await pdfToExcelPdf());
    const book = readXlsx(bytes);

    expect(book.sheets.get('Page 1 Text')).toEqual([
      [PDF_TO_EXCEL.heading],
      [PDF_TO_EXCEL.intro],
      [PDF_TO_EXCEL.closing]
    ]);
    // …and none of the table's own text is duplicated onto it.
    const textCells = (book.sheets.get('Page 1 Text') ?? []).flat();
    for (const cell of PDF_TO_EXCEL.table.flat()) expect(textCells).not.toContain(cell);
  }, 120_000);

  it('writes the workbook title from the documentName option, not from a live signal', async () => {
    const { bytes } = await convert(await pdfToExcelPdf(), { documentName: 'sales.pdf' });
    const core = strFromU8(readXlsx(bytes).parts['docProps/core.xml']);
    expect(core).toContain('<dc:title>sales.pdf</dc:title>');
  }, 120_000);

  it('reports determinate, monotonic progress across both passes', async () => {
    // The read band (0..0.8) and the writer's band (0.8..1) are
    // `convertPdfToXlsx`'s own, defined nowhere else — so this is the evidence
    // that the real function ran rather than a test helper standing in for it.
    const { progress } = await convert(await pdfToExcelPdf());
    expect(progress.length).toBeGreaterThan(2);
    for (const fraction of progress) {
      expect(fraction).toBeGreaterThanOrEqual(0);
      expect(fraction).toBeLessThanOrEqual(1);
    }
    expect([...progress].sort((a, b) => a - b)).toEqual(progress);
    expect(progress.some(fraction => fraction >= 0.8)).toBe(true);
  }, 120_000);

  it('describes exactly the sheets it wrote, for the mandatory preview', async () => {
    const { outline, bytes } = await convert(await pdfToExcelPdf());
    const book = readXlsx(bytes);

    // The preview cannot name a sheet the file does not carry: same names, same
    // order, same shape.
    expect(outline.map(item => item.sheetName)).toEqual(book.order);
    expect(outline.map(item => item.kind)).toEqual(['table', 'text', 'text']);
    expect(outline[0]).toMatchObject({ pageIndex: 0, rowCount: 5, columnCount: 4 });
    expect(outline[0].text).toBe('Region | Revenue | Units | Change');
    expect(outline[1]).toMatchObject({ pageIndex: 0, rowCount: 3, columnCount: 1 });
    expect(outline[2]).toMatchObject({ pageIndex: 1, rowCount: 3, columnCount: 1 });
  }, 120_000);
});

/* ------------------------------------------------------------------ *
 * AC 1, read back by SheetJS — the reader the criterion names
 * ------------------------------------------------------------------ */

/** One worksheet as a dense grid of strings, through SheetJS's own reader. */
function sheetJsGrid(sheet: XLSX.WorkSheet): string[][] {
  return XLSX.utils.sheet_to_json<string[]>(sheet, {
    header: 1,
    // `raw: false` returns each cell as SheetJS formatted it; every cell this
    // writer emits is an inline string, so this must come back byte-identical to
    // what went in rather than as a re-formatted number.
    raw: false,
    defval: '',
    blankrows: true
  });
}

describe('CNV-10 — the workbook re-opened with the `xlsx` (SheetJS) reader', () => {
  it("SheetJS opens the produced file and its grid matches the fixture's table exactly", async () => {
    const { bytes } = await convert(await pdfToExcelPdf());

    // The criterion, literally: an outside reader — not this repo's own parser —
    // opens the bytes Save would write.
    const book = XLSX.read(bytes, { type: 'array' });

    expect(book.SheetNames).toEqual(['Page 1 Table', 'Page 1 Text', 'Page 2 Text']);
    expect(sheetJsGrid(book.Sheets['Page 1 Table'])).toEqual(
      PDF_TO_EXCEL.table.map(row => [...row])
    );
  }, 120_000);

  it('agrees with the hand-parsed reading of the same bytes, sheet for sheet', async () => {
    // Two independent readings of one file. If they ever disagree, one of the
    // two round trips is lying and the disagreement is the signal.
    const { bytes } = await convert(await pdfToExcelPdf());
    const byHand = readXlsx(bytes);
    const bySheetJs = XLSX.read(bytes, { type: 'array' });

    expect(bySheetJs.SheetNames).toEqual(byHand.order);
    for (const name of byHand.order) {
      expect(sheetJsGrid(bySheetJs.Sheets[name]), `sheet "${name}"`).toEqual(
        byHand.sheets.get(name)
      );
    }
  }, 120_000);

  it('reports every cell as text to the reader — never a number, date or formula', async () => {
    const { bytes } = await convert(await pdfToExcelPdf());
    const sheet = XLSX.read(bytes, { type: 'array' }).Sheets['Page 1 Table'];

    // "1,204" and "318" are what the PDF drew. A reader that saw them as numbers
    // would hand back 1204 and 318 as numbers, and "007"-style values would lose
    // their leading zeros — which is the whole reason the writer emits
    // `t="inlineStr"`. This asserts the *reader's* view of the type, not ours.
    for (const ref of Object.keys(sheet)) {
      if (ref.startsWith('!')) continue;
      expect(sheet[ref].t, `${ref} is not a text cell`).toBe('s');
      expect(typeof sheet[ref].v, `${ref} did not come back as a string`).toBe('string');
    }
    expect(sheet['B2'].v).toBe('1,204');
    expect(sheet['C2'].v).toBe('318');
  }, 120_000);

  it('reads the text-only sheets and the workbook title back through SheetJS too', async () => {
    const { bytes } = await convert(await pdfToExcelPdf(), { documentName: 'sales.pdf' });
    const book = XLSX.read(bytes, { type: 'array' });

    expect(sheetJsGrid(book.Sheets['Page 1 Text'])).toEqual([
      [PDF_TO_EXCEL.heading],
      [PDF_TO_EXCEL.intro],
      [PDF_TO_EXCEL.closing]
    ]);
    expect(sheetJsGrid(book.Sheets['Page 2 Text'])).toEqual(
      PDF_TO_EXCEL.appendix.map(line => [line])
    );
    // `docProps/core.xml` reached the reader as metadata, not just as bytes.
    expect(book.Props?.Title).toBe('sales.pdf');
  }, 120_000);

  it('opens a no-table document as one usable sheet, one row per line (AC 2)', async () => {
    const { bytes } = await convert(await pdfToExcelProsePdf());
    const book = XLSX.read(bytes, { type: 'array' });

    expect(book.SheetNames).toEqual(['Page 1 Text']);
    expect(sheetJsGrid(book.Sheets['Page 1 Text'])).toEqual(PDF_TO_EXCEL_PROSE.map(line => [line]));
  }, 120_000);

  it('round-trips the characters an escaping bug would eat', () => {
    // Not from a PDF — straight through the writer, because the fixture text is
    // deliberately plain and a reader is the right judge of whether `&`, `<` and
    // a quote survived being written into XML.
    const awkward = [
      ['A & B', '<not a tag>', '"quoted"'],
      ["it's", 'a > b', '100% & rising']
    ];
    const book = XLSX.read(buildXlsx([{ name: 'Awkward', rows: awkward }]), { type: 'array' });
    expect(sheetJsGrid(book.Sheets['Awkward'])).toEqual(awkward);
  });
});

/* ------------------------------------------------------------------ *
 * AC 2 — no detectable table still produces a usable sheet
 * ------------------------------------------------------------------ */

describe('CNV-10 — a PDF with no detectable table', () => {
  it('still produces a usable sheet: one row per line of text', async () => {
    const result = await convert(await pdfToExcelProsePdf());
    const book = readXlsx(result.bytes);

    expect(result.tableCount).toBe(0);
    expect(book.order).toEqual(['Page 1 Text']);
    expect(book.sheets.get('Page 1 Text')).toEqual(PDF_TO_EXCEL_PROSE.map(line => [line]));
    // Not empty, and not a failure: a real file with real content.
    expect(result.bytes.byteLength).toBeGreaterThan(400);
    expect(result.skipped).toEqual([]);
  }, 120_000);

  it('refuses, with a message, when page text is switched off and there is no table', async () => {
    buildXlsxCalls = 0;
    const failure = await convertPdfToXlsx(await pdfToExcelProsePdf(), {
      includePageText: false
    }).then(
      () => null,
      (err: unknown) => err
    );
    expect(failure).toBeInstanceOf(StaplerError);
    expect((failure as StaplerError).message).toMatch(/Include page text/);
    // The writer *was* reached — this refusal is the workbook planner's, raised
    // in place of writing a sheetless file Excel would offer to repair.
    expect(buildXlsxCalls).toBe(1);
  }, 120_000);

  it('keeps the tables and counts what switching page text off left out', async () => {
    const result = await convert(await pdfToExcelPdf(), { includePageText: false });
    const book = readXlsx(result.bytes);

    expect(book.order).toEqual(['Page 1 Table']);
    expect(book.sheets.get('Page 1 Table')).toEqual(PDF_TO_EXCEL.table.map(row => [...row]));
    // Three lines on page 1, three on page 2 — reported, not silently dropped.
    expect(result.skipped).toEqual([
      'Page 1: 3 line(s) of text outside a table were left out because "Include page text" is off.',
      'Page 2: 3 line(s) of text outside a table were left out because "Include page text" is off.'
    ]);
  }, 120_000);
});

/* ------------------------------------------------------------------ *
 * Unsupported input is refused, not half-converted
 * ------------------------------------------------------------------ */

describe('CNV-10 — unsupported input is refused, not half-converted', () => {
  it('refuses an XFA form from `convertPdfToXlsx` itself, before any workbook work', async () => {
    buildXlsxCalls = 0;
    const bytes = fixture('xfa.pdf');
    expect(hasXfaMarker(bytes)).toBe(true);

    const failure = await convertPdfToXlsx(bytes, { includePageText: true }).then(
      () => null,
      (err: unknown) => err
    );
    expect(failure).toBeInstanceOf(StaplerError);
    expect((failure as StaplerError).kind).toBe('UnsupportedFeature');
    expect((failure as StaplerError).message).toBe(XFA_CONVERT_MESSAGE);
    expect(buildXlsxCalls).toBe(0);

    // …and the fixture the conversion is meant to accept is not a false positive.
    expect(hasXfaMarker(await pdfToExcelPdf())).toBe(false);
  }, 60_000);

  it('refuses an encrypted document from `convertPdfToXlsx` itself', async () => {
    buildXlsxCalls = 0;
    const failure = await convertPdfToXlsx(fixture('encrypted.pdf'), {
      includePageText: true
    }).then(
      () => null,
      (err: unknown) => err
    );
    expect(failure).toBeInstanceOf(StaplerError);
    expect((failure as StaplerError).kind).toBe('Encrypted');
    expect(buildXlsxCalls).toBe(0);
  }, 60_000);

  it('refuses a PDF with no text layer, naming OCR, rather than writing an empty workbook', async () => {
    buildXlsxCalls = 0;
    // An image-free, text-free page: exactly what a scan looks like to the text
    // layer, without needing a scan fixture.
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    const failure = await convertPdfToXlsx(await doc.save(), { includePageText: true }).then(
      () => null,
      (err: unknown) => err
    );
    expect(failure).toBeInstanceOf(StaplerError);
    expect((failure as StaplerError).message).toBe(NO_TEXT_LAYER_MESSAGE);
    expect((failure as StaplerError).message).toMatch(/OCR/);
    expect(buildXlsxCalls).toBe(0);
  }, 60_000);
});

/* ------------------------------------------------------------------ *
 * Cancellation, in both phases
 * ------------------------------------------------------------------ */

/** A prose document of `pageCount` pages, so a mid-run abort has room to land. */
async function multiPagePdf(pageCount: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 0; p < pageCount; p++) {
    const page = doc.addPage([612, 792]);
    for (let line = 0; line < 4; line++) {
      page.drawText(`Page ${p + 1}, line ${line + 1} of ordinary prose.`, {
        x: 56,
        y: 730 - line * 14,
        size: 11,
        font
      });
    }
  }
  return doc.save();
}

describe('CNV-10 — cancellation', () => {
  it('does no work when the signal is aborted before the conversion starts', async () => {
    buildXlsxCalls = 0;
    extractPageSheetCalls = 0;
    const controller = new AbortController();
    controller.abort();

    const failure = await convertPdfToXlsx(
      await pdfToExcelPdf(),
      { includePageText: true },
      { signal: controller.signal }
    ).then(
      () => null,
      (err: unknown) => err
    );

    expect(failure).toBeInstanceOf(StaplerError);
    expect((failure as StaplerError).kind).toBe('UserCancelled');
    // Not one page read, not one byte written. (The document is opened first —
    // that is where encryption surfaces — but the page loop checks the signal
    // before its first iteration, so nothing is extracted.)
    expect(extractPageSheetCalls).toBe(0);
    expect(buildXlsxCalls).toBe(0);
  }, 60_000);

  it('stops mid-extraction without reading every page or reaching the writer', async () => {
    buildXlsxCalls = 0;
    extractPageSheetCalls = 0;
    const pageCount = 8;
    const controller = new AbortController();
    const fractions: number[] = [];

    const failure = await convertPdfToXlsx(
      await multiPagePdf(pageCount),
      { includePageText: true },
      {
        signal: controller.signal,
        onProgress: fraction => {
          fractions.push(fraction ?? 0);
          // Abort on the second page's progress report — early enough that most
          // of the document is still unread when the next loop check fires.
          if (fractions.length === 2) controller.abort();
        }
      }
    ).then(
      () => null,
      (err: unknown) => err
    );

    expect(failure).toBeInstanceOf(StaplerError);
    expect((failure as StaplerError).kind).toBe('UserCancelled');
    // It stopped short: fewer pages read than the document has.
    expect(extractPageSheetCalls).toBeGreaterThan(0);
    expect(extractPageSheetCalls).toBeLessThan(pageCount);
    // And the second phase was never entered, so no partial workbook exists.
    expect(buildXlsxCalls).toBe(0);
    // Nothing in the extraction band ever reported the writer's band.
    expect(Math.max(...fractions)).toBeLessThan(0.8);
  }, 120_000);

  it('stops inside the XLSX-building phase, after every page has been read', async () => {
    buildXlsxCalls = 0;
    extractPageSheetCalls = 0;
    const controller = new AbortController();
    let abortedAt: number | null = null;

    const failure = await convertPdfToXlsx(
      await pdfToExcelPdf(),
      { includePageText: true },
      {
        signal: controller.signal,
        onProgress: fraction => {
          // 0.8 is where `convertPdfToXlsx` hands over to the convert worker, so
          // the first report at or above it is the writer's own first
          // checkpoint. Aborting there exercises the second phase's
          // cancellation, not the first's.
          if (abortedAt === null && (fraction ?? 0) >= 0.8) {
            abortedAt = fraction ?? 0;
            controller.abort();
          }
        }
      }
    ).then(
      () => null,
      (err: unknown) => err
    );

    expect(failure).toBeInstanceOf(StaplerError);
    expect((failure as StaplerError).kind).toBe('UserCancelled');
    expect(abortedAt).not.toBeNull();
    // The writer was entered — this is phase two's checkpoint doing the work —
    // and it threw rather than returning bytes.
    expect(buildXlsxCalls).toBe(1);
    expect(extractPageSheetCalls).toBe(2);
  }, 120_000);
});

/* ------------------------------------------------------------------ *
 * The writer, and the detection it shares with CNV-08
 * ------------------------------------------------------------------ */

describe('CNV-10 — the XLSX writer', () => {
  it('writes one part, one content type and one relationship per sheet', () => {
    const bytes = buildXlsx([
      { name: 'One', rows: [['a', 'b']] },
      { name: 'Two', rows: [['c']] },
      { name: 'Three', rows: [['d']] }
    ]);
    const book = readXlsx(bytes);
    expect(book.order).toEqual(['One', 'Two', 'Three']);
    expect(book.sheets.get('One')).toEqual([['a', 'b']]);
    expect(book.sheets.get('Three')).toEqual([['d']]);
    expect(Object.keys(book.parts).filter(n => n.startsWith('xl/worksheets/'))).toHaveLength(3);
  });

  it('refuses to write a workbook with no sheets rather than one that will not open', () => {
    expect(() => buildXlsx([])).toThrow(/at least one sheet/);
  });

  it('escapes XML metacharacters in cells and in sheet names', () => {
    const bytes = buildXlsx([{ name: 'A & B', rows: [['<one>', 'two & "three"', "it's"]] }]);
    const book = readXlsx(bytes);
    expect(book.order).toEqual(['A & B']);
    expect(book.sheets.get('A & B')).toEqual([['<one>', 'two & "three"', "it's"]]);
  });

  it('strips the control characters a PDF text layer can carry, which XML cannot hold', () => {
    // A raw NUL or BEL in a part makes the whole workbook unparseable — Excel
    // reports that as a corrupt file, not as a bad cell.
    const dirty = `before${String.fromCharCode(0)}${String.fromCharCode(7)}after`;
    const bytes = buildXlsx([{ name: 'Sheet1', rows: [[dirty]] }]);
    expect(readXlsx(bytes).sheets.get('Sheet1')).toEqual([['beforeafter']]);
    expect(xmlEscape(`a${String.fromCharCode(11)}b`)).toBe('ab');
    // Tab, newline and carriage return are legal XML and are kept.
    expect(xmlEscape('a\tb\nc')).toBe('a\tb\nc');
  });

  it('makes every sheet name one Excel will accept, and keeps them unique', () => {
    expect(sanitizeSheetName('Q1/Q2: [draft]')).toBe('Q1 Q2 draft');
    expect(sanitizeSheetName('')).toBe('Sheet');
    expect(sanitizeSheetName('History')).toBe('History sheet');
    expect(sanitizeSheetName('x'.repeat(40))).toHaveLength(31);

    const names = uniqueSheetNames(['Data', 'Data', 'Data']);
    expect(new Set(names).size).toBe(3);
    expect(names[0]).toBe('Data');
    for (const name of uniqueSheetNames(['y'.repeat(40), 'y'.repeat(40)])) {
      expect(name.length).toBeLessThanOrEqual(31);
    }
  });

  it('numbers columns the way a spreadsheet does', () => {
    expect(getColRef(0)).toBe('A');
    expect(getColRef(25)).toBe('Z');
    expect(getColRef(26)).toBe('AA');
    expect(colIndexOf(getColRef(701))).toBe(701);
  });

  it("omits an empty cell rather than writing a blank one, and keeps the row's shape", () => {
    const book = readXlsx(buildXlsx([{ name: 'S', rows: [['a', '', 'c']] }]));
    // Read back by cell reference: the gap is still column B, not a lost column.
    expect(book.sheets.get('S')).toEqual([['a', '', 'c']]);
  });
});

describe('CNV-10 — the page model', () => {
  /** A pdf.js-shaped run. PDF space, so a larger `y` is higher on the page. */
  function run(str: string, x: number, y: number, size = 11, width = str.length * size * 0.5) {
    return { str, transform: [size, 0, 0, size, x, y], width, height: size };
  }

  it('keeps wrapped lines as separate rows rather than merging them into a paragraph', () => {
    // The one place this model deliberately differs from CNV-08's `pageBlocks`,
    // which merges a wrapped paragraph into one block. A spreadsheet row is a
    // line, and the acceptance criterion is stated in lines.
    const page = pageSheet(
      [run('First line of the paragraph.', 56, 700), run('Second line of the same one.', 56, 686)],
      792,
      0
    );
    expect(page.tables).toEqual([]);
    expect(page.textLines).toEqual([
      'First line of the paragraph.',
      'Second line of the same one.'
    ]);
  });

  it('splits a page into its table and the lines around it', () => {
    const runs = [
      run('Summary of the quarter', 56, 730, 18, 190),
      ...['Region', 'Revenue'].map((cell, i) => run(cell, [56, 300][i], 690)),
      ...['North', '1204'].map((cell, i) => run(cell, [56, 300][i], 670)),
      run('Prepared by the operations team.', 56, 600)
    ];
    const page = pageSheet(runs, 792, 3);
    expect(page.pageIndex).toBe(3);
    expect(page.tables).toEqual([
      [
        ['Region', 'Revenue'],
        ['North', '1204']
      ]
    ]);
    expect(page.textLines).toEqual(['Summary of the quarter', 'Prepared by the operations team.']);
  });

  it("shares CNV-08's table detection rather than repeating it", () => {
    // Same input, same regions: `blocks.ts` and `sheets.ts` both read
    // `findTableRegions`, so a tuning change cannot land in one export and not
    // the other.
    const runs = [
      ...['Region', 'Revenue'].map((cell, i) => run(cell, [56, 300][i], 690)),
      ...['North', '1204'].map((cell, i) => run(cell, [56, 300][i], 670))
    ];
    const { lines, bodySize } = layoutLines(runs);
    const regions = findTableRegions(lines, bodySize, 792);
    expect(regions).toHaveLength(1);
    expect(regions[0]).toMatchObject({ startLine: 0, endLine: 1, columnCount: 2 });
    expect(pageSheet(runs, 792, 0).tables[0]).toEqual(regions[0].rows);
  });

  it('does not read a justified paragraph as a table, in this direction either', () => {
    const runs = [700, 686, 672].flatMap(y => [
      run('The claimant', 56, y, 11, 60),
      run('states that', 127, y, 11, 55),
      run('the vehicle', 193, y, 11, 55)
    ]);
    const page = pageSheet(runs, 792, 0);
    expect(page.tables).toEqual([]);
    expect(page.textLines).toHaveLength(3);
  });

  it('names sheets from the page they came from, numbering only when a page has several', () => {
    const plan = planWorkbook(
      [
        { pageIndex: 0, tables: [[['a']], [['b']]], textLines: [] },
        { pageIndex: 1, tables: [[['c']]], textLines: ['line'] }
      ],
      true
    );
    expect(plan.sheets.map(sheet => sheet.name)).toEqual([
      'Page 1 Table 1',
      'Page 1 Table 2',
      'Page 2 Table',
      'Page 2 Text'
    ]);
    expect(plan.tableCount).toBe(3);
  });

  it("truncates a cell past Excel's limit and says so instead of writing an unopenable file", () => {
    const long = 'x'.repeat(40_000);
    const plan = planWorkbook([{ pageIndex: 0, tables: [], textLines: [long] }], true);
    expect(plan.sheets[0].rows[0][0]).toHaveLength(32767);
    expect(plan.skipped[0]).toMatch(/1 cell\(s\) were longer than Excel's 32767-character limit/);
  });

  it('recognises a document with no text layer at all', () => {
    expect(hasNoText([{ pageIndex: 0, tables: [], textLines: [] }])).toBe(true);
    expect(hasNoText([{ pageIndex: 0, tables: [], textLines: ['a'] }])).toBe(false);
    expect(hasNoText([{ pageIndex: 0, tables: [[['a']]], textLines: [] }])).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * The gate (PLAN §5.5)
 * ------------------------------------------------------------------ */

describe('CNV-10 — the mandatory-preview gate', () => {
  const result = () => ({
    bytes: new Uint8Array([1, 2, 3]),
    pageCount: 2,
    sheetCount: 3,
    tableCount: 1,
    outline: [],
    skipped: []
  });

  it('starts closed, opens only on a preview, and closes again on reset', async () => {
    const { commitGate } = await import('../../src/ui/tools/commit-gate');
    const state = await import('../../src/ui/tools/convert/pdf-to-excel-state');

    // Importing the panel's state module is what arms the gate, so the save
    // action is blocked before the panel has ever been mounted.
    expect(commitGate('pdf-to-excel')).toBe(state.PDF_TO_EXCEL_GATE);
    expect(state.pdfToExcelPreview.value).toBeNull();

    state.setPdfToExcelPreview(result(), 'doc-1', 0);
    expect(commitGate('pdf-to-excel')).toBeNull();
    expect(state.pdfToExcelPreviewDocId.value).toBe('doc-1');

    state.resetPdfToExcelPreview();
    expect(commitGate('pdf-to-excel')).toBe(state.PDF_TO_EXCEL_GATE);
    expect(state.pdfToExcelPreview.value).toBeNull();
  });

  it('closes again when the document is edited, not only when it is switched', async () => {
    // CNV-08's audit finding 4, adopted here from the start: the document id
    // alone does not change when a page is deleted or rotated, so a preview of
    // the pre-edit bytes stayed marked valid and Save would have written it.
    const state = await import('../../src/ui/tools/convert/pdf-to-excel-state');
    const { commitGate } = await import('../../src/ui/tools/commit-gate');
    const { historyVersion } = await import('../../src/core/history');
    const store = await import('../../src/core/store');

    const pageKey = 'page-1';
    const doc = {
      id: 'doc-xlsx-edit',
      name: 'edited.pdf',
      pages: [{ key: pageKey, sourceDocId: 'src-1', sourceIndex: 0, rotation: 0 }],
      annotations: [],
      dirty: false
    };
    store.documents.value = [doc];
    store.activeDocId.value = doc.id;

    state.setPdfToExcelPreview(result(), doc.id, historyVersion.value);
    expect(commitGate('pdf-to-excel')).toBeNull();
    expect(state.pdfToExcelPreviewIsStale(doc.id)).toBe(false);

    // A real mutation through the real store mutator — not a hand-incremented
    // counter.
    const before = historyVersion.value;
    store.rotatePages(doc.id, [pageKey], 90);
    expect(historyVersion.value).not.toBe(before);

    expect(state.pdfToExcelPreviewIsStale(doc.id)).toBe(true);

    // …and it is not a permanent lock.
    state.setPdfToExcelPreview(result(), doc.id, historyVersion.value);
    expect(state.pdfToExcelPreviewIsStale(doc.id)).toBe(false);

    const history = await import('../../src/core/history');
    history.undo();
    expect(state.pdfToExcelPreviewIsStale(doc.id)).toBe(true);

    state.resetPdfToExcelPreview();
    store.documents.value = [];
    store.activeDocId.value = null;
  });

  it('treats a preview with no recorded revision as stale rather than valid', async () => {
    const state = await import('../../src/ui/tools/convert/pdf-to-excel-state');
    state.setPdfToExcelPreview(result(), 'doc-x');
    expect(state.pdfToExcelPreviewRevision.value).toBeNull();
    expect(state.pdfToExcelPreviewIsStale('doc-x')).toBe(true);
    state.resetPdfToExcelPreview();
  });

  it('gates this tool without gating any other', async () => {
    const { commitGate, setCommitGate } = await import('../../src/ui/tools/commit-gate');
    setCommitGate('pdf-to-excel', 'blocked');
    expect(commitGate('pdf-to-excel')).toBe('blocked');
    expect(commitGate('pdf-to-word')).toBeNull();
    expect(commitGate('merge')).toBeNull();
    setCommitGate('pdf-to-excel', null);
    expect(commitGate('pdf-to-excel')).toBeNull();
  });
});
