/**
 * CNV-11 — Excel (XLSX) → PDF, graded against real output bytes.
 *
 * The acceptance criterion names its own verification method: a multi-sheet
 * fixture must produce "a PDF with one section per sheet, all cell values
 * present and in the correct row/column order, verified by re-extracting text
 * via CNV-04's extraction and comparing to the source grid". So the round trip
 * below runs the production pipeline end to end and then reads the produced PDF
 * back with `extractDocumentText` — the same `layoutText` path the Extract tool
 * ships — rather than inspecting the model it was drawn from. Nothing here grades
 * intent; every assertion about the output is against bytes that came out of
 * pdf-lib and back in through pdf.js.
 *
 * Same worker arrangement as `word-to-pdf.test.ts`, and for the same reason:
 * `vi.mock('comlink')` makes the worker modules importable in Node (each calls
 * `Comlink.expose` at import time), and `vi.mock('../../src/core/workers')` leases
 * the **real** worker implementations in place of real `Worker`s. The function
 * under test is therefore `operations.convertXlsxToPdf` itself — its own
 * sequencing, its own progress bands, its own refusal behaviour — not a
 * re-implementation of it.
 *
 * What this file cannot prove is stated in the ticket's Status line: nothing here
 * opens Acrobat, Preview or Chrome's viewer.
 */
import { describe, expect, it, vi } from 'vitest';
import { zipSync, strFromU8, strToU8, unzipSync, unzlibSync } from 'fflate';
import { PDFDocument, PDFName, PDFArray, PDFRawStream } from 'pdf-lib';
import { EXCEL_TO_PDF, excelToPdfXlsx } from '../e2e/fixtures';
import {
  MAX_CELL_CHARS,
  MAX_SHEET_COLUMNS,
  MAX_SHEET_ROWS,
  EXCEL_LIMITATIONS,
  UNKNOWN_ERROR_TEXT,
  XLSX_ALL_SHEETS_HIDDEN_MESSAGE,
  XLSX_EMPTY_MESSAGE,
  XLSX_LEGACY_MESSAGE,
  XLSX_NOT_A_WORKBOOK_MESSAGE,
  XLSX_NOT_A_ZIP_MESSAGE,
  XLSX_NO_SHEETS_MESSAGE,
  XLSX_SHEET_EMPTY_TEXT,
  XLSX_SHEET_FORMULAS_ONLY_TEXT,
  XLSX_SHEET_UNREADABLE_TEXT,
  bandColumns,
  cellAddress,
  cellText,
  columnName,
  columnWidthPt,
  hiddenColumnsNote,
  hiddenRowsNote,
  hiddenSheetsNote,
  decodeXmlPart,
  duplicateSheetNamesNote,
  isCompleteWorksheetPart,
  readXlsxAsBlocks,
  resolveWorkbookTarget,
  rowCapNote,
  columnCapNote,
  translateSheetJsError,
  truncatedCellsNote,
  uncachedFormulaNote,
  unreadableSheetNote,
  zipOpens
} from '../../src/core/convert/xlsx-reader';
import { runsToText, type LayoutBlock } from '../../src/core/convert/html-to-pdf-blocks';
import { StaplerError } from '../../src/core/errors';

vi.mock('comlink', () => ({
  expose: vi.fn(),
  transfer: vi.fn(value => value),
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

/** How many times the layout engine was reached. A refusal must leave this at 0. */
let layoutCalls = 0;

vi.mock('../../src/core/workers', async () => {
  const { renderWorkerImpl } = await import('../../src/core/workers/render.worker');
  const { processWorkerImpl } = await import('../../src/core/workers/process.worker');
  const { convertWorkerImpl } = await import('../../src/core/workers/convert.worker');
  type Bytes = Uint8Array;

  // `.slice()` stands in for the structured clone the real Comlink boundary
  // performs — pdf.js takes ownership of (and detaches) what `loadDocument` is
  // given, which would otherwise poison a second read of the same array.
  const renderApi = {
    loadDocument: (bytes: Bytes, password?: string) =>
      renderWorkerImpl.loadDocument(bytes.slice(), password),
    extractText: (handle: string, pageIndex: number, mode: 'text' | 'markdown') =>
      renderWorkerImpl.extractText(handle, pageIndex, mode),
    closeDocument: (handle: string) => renderWorkerImpl.closeDocument(handle)
  };
  const processApi = {
    layoutBlocksToPdf: (...args: Parameters<typeof processWorkerImpl.layoutBlocksToPdf>) => {
      layoutCalls++;
      return processWorkerImpl.layoutBlocksToPdf(...args);
    }
  };
  const convertApi = {
    xlsxToBlocks: (bytes: Bytes, job?: Parameters<typeof convertWorkerImpl.xlsxToBlocks>[1]) =>
      convertWorkerImpl.xlsxToBlocks(bytes.slice(), job)
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
    processWorker: { lease: leaseOn(processApi) },
    cvWorker: { lease: leaseOn({}) },
    ocrWorker: { lease: leaseOn({}) },
    convertWorker: { lease: leaseOn(convertApi) }
  };
});

const { convertXlsxToPdf, extractDocumentText } = await import('../../src/core/operations');

type Converted = Awaited<ReturnType<typeof convertXlsxToPdf>> & { progress: number[] };

/** The production entry point, nothing else. */
async function convert(
  bytes: Uint8Array,
  options: Partial<Parameters<typeof convertXlsxToPdf>[1]> = {},
  jobOptions: { signal?: AbortSignal } = {}
): Promise<Converted> {
  const progress: number[] = [];
  const result = await convertXlsxToPdf(
    bytes,
    { pageSize: 'a4', ...options },
    { ...jobOptions, onProgress: fraction => progress.push(fraction ?? 0) }
  );
  return { ...result, progress };
}

/** Every page's text, read back out of the produced PDF through CNV-04's path. */
async function extractedText(pdf: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(pdf.slice());
  const indices = doc.getPages().map((_, index) => index);
  return extractDocumentText(pdf.slice(), indices, 'text');
}

/** Collapses whitespace so an assertion is about words, not about line breaks. */
function flat(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The extracted text as non-empty lines, each whitespace-collapsed. */
async function extractedLines(pdf: Uint8Array): Promise<string[]> {
  return (await extractedText(pdf))
    .split('\n')
    .map(line => flat(line))
    .filter(line => line.length > 0);
}

/**
 * The width of every cell border the PDF draws, in points, read out of the page
 * content streams themselves.
 *
 * This is how a claim about *column widths* gets graded against output bytes
 * rather than against the numbers the reader computed. pdf-lib does not emit a
 * `re` operator for `drawRectangle`: it translates the CTM to the corner and
 * strokes an explicit path, `0 0 m` → `<width> 0 l` → `<width> <height> l` → …,
 * so the second line of each path is the cell's width. Content streams come back
 * flate-encoded, hence the inflate.
 */
async function drawnCellWidths(pdf: Uint8Array): Promise<number[]> {
  const doc = await PDFDocument.load(pdf.slice());
  const widths: number[] = [];
  for (const page of doc.getPages()) {
    const contents = page.node.Contents();
    const streams =
      contents instanceof PDFArray
        ? contents.asArray().map(ref => doc.context.lookup(ref))
        : [contents];
    for (const stream of streams) {
      if (!(stream instanceof PDFRawStream)) continue;
      const filter = stream.dict.get(PDFName.of('Filter'))?.toString() ?? '';
      const raw = stream.getContents();
      const body = new TextDecoder('latin1').decode(
        filter.includes('FlateDecode') ? unzlibSync(raw) : raw
      );
      const token = /^(-?[\d.]+) 0 l$/gm;
      let match: RegExpExecArray | null;
      while ((match = token.exec(body)) !== null) widths.push(Number.parseFloat(match[1]));
    }
  }
  return widths;
}

let fixtureCache: Uint8Array | undefined;
async function fixture(): Promise<Uint8Array> {
  fixtureCache ??= await excelToPdfXlsx();
  return fixtureCache.slice();
}

/** Builds a one-sheet `.xlsx` from a grid of raw values, for the edge cases. */
async function sheetFrom(
  rows: unknown[][],
  name = 'Sheet1',
  decorate?: (sheet: Record<string, unknown>) => void
): Promise<Uint8Array> {
  const XLSX = await import('xlsx');
  const sheet = XLSX.utils.aoa_to_sheet(rows as never[][]);
  decorate?.(sheet as unknown as Record<string, unknown>);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, name);
  return new Uint8Array(XLSX.write(book, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
}

/**
 * A real, valid `.xlsx` with one worksheet part's XML replaced by `content`.
 *
 * The audit's exact repro for the second review pass's finding 1: everything
 * about the package stays correct — content types, workbook, rels, shared
 * strings, the *other* sheet — and only `xl/worksheets/sheet1.xml` is garbage.
 * `XLSX.read` does not fail on this; it returns a truthy, key-less `{}` for the
 * damaged sheet, indistinguishable from a blank one without going to the bytes.
 */
async function workbookWithBrokenSheet(content: string): Promise<Uint8Array> {
  const XLSX = await import('xlsx');
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet([
      ['a', 'b'],
      ['c', 'd']
    ]),
    'Broken'
  );
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['intact']]), 'Fine');
  const whole = new Uint8Array(
    XLSX.write(book, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
  );

  const parts = unzipSync(whole);
  expect(Object.keys(parts)).toContain('xl/worksheets/sheet1.xml');
  parts['xl/worksheets/sheet1.xml'] = strToU8(content);
  return zipSync(parts);
}

/**
 * A hand-built `.xlsx` whose `<sheets/>` element is empty.
 *
 * SheetJS's writer cannot produce this (`XLSX.write` throws "Workbook is
 * empty"), which is why `XLSX_NO_SHEETS_MESSAGE` needs a package assembled by
 * hand to be reached at all.
 */
function zeroSheetWorkbook(): Uint8Array {
  const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const relsNs = 'http://schemas.openxmlformats.org/package/2006/relationships';
  return zipSync({
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '</Types>'
    ),
    '_rels/.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${relsNs}">` +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>'
    ),
    'xl/workbook.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${ns}"><sheets/></workbook>`
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${relsNs}"/>`
    )
  });
}

describe('CNV-11 — XLSX to PDF round trip', () => {
  it('produces one section per visible sheet, named, in workbook order', async () => {
    const result = await convert(await fixture());

    // The claim is about the *produced bytes*, so the sheet names are looked for
    // in text re-extracted from the PDF, in order — not in the model.
    const text = flat(await extractedText(result.bytes));
    const expected = [
      EXCEL_TO_PDF.sheets.summary,
      EXCEL_TO_PDF.sheets.regions,
      EXCEL_TO_PDF.sheets.blank,
      EXCEL_TO_PDF.sheets.wide
    ];
    let cursor = -1;
    for (const name of expected) {
      const at = text.indexOf(name, cursor + 1);
      expect(at, `"${name}" heads its own section, after everything before it`).toBeGreaterThan(
        cursor
      );
      cursor = at;
    }

    // …and the summary the panel shows agrees with it: four visible sheets, the
    // hidden one absent.
    expect(result.sheets.map(sheet => sheet.name)).toEqual(expected);
    expect(result.sheets.map(sheet => sheet.name)).not.toContain(EXCEL_TO_PDF.sheets.notes);
  }, 120_000);

  it('matches every cell of the Summary sheet, cell by cell, on its own row', async () => {
    // The criterion says "in the correct row/column order", so this asserts the
    // grid rather than the presence of the strings anywhere in the document: each
    // source row has to come back as one extracted line whose cells are in
    // column order.
    const result = await convert(await fixture());
    const lines = await extractedLines(result.bytes);

    for (const row of EXCEL_TO_PDF.summary) {
      const cells = row.filter(cell => cell.length > 0);
      const pattern = new RegExp(
        `^${cells.map(cell => cell.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+')}$`
      );
      expect(
        lines.some(line => pattern.test(line)),
        `row ${JSON.stringify(row)} came back as one line in column order; saw:\n${lines.join('\n')}`
      ).toBe(true);
    }
  }, 120_000);

  it('draws each cell’s displayed value, so number and date formats survive', async () => {
    const result = await convert(await fixture());
    const text = flat(await extractedText(result.bytes));

    // The formatted strings, which only exist because the reader asks SheetJS for
    // `w` rather than `v`.
    for (const shown of ['1,204.50', '987.00', '2026-01-15', '2026-02-01', '8.1%', '3.0%']) {
      expect(text, `the displayed value ${shown} is in the PDF`).toContain(shown);
    }
    // And the raw values are *not* what got drawn — this is the assertion that
    // would fail if the reader fell back to `v`.
    expect(text).not.toContain('1204.5');
    expect(text).not.toContain('0.081');
    expect(text).not.toMatch(/2026-01-15T/);
  }, 120_000);

  it('draws a formula’s computed value and never the formula itself', async () => {
    const result = await convert(await fixture());
    const text = flat(await extractedText(result.bytes));

    expect(text).toContain('2,191.50');
    expect(text).toContain('11.1%');
    // The single most important negative in this file: a spreadsheet converter
    // that printed `=SUM(B2:B3)` where the user expects 2,191.50 would be
    // presenting a formula as if it were the intended content.
    expect(text).not.toContain('SUM(B2:B3)');
    expect(text).not.toContain('SUM(D2:D3)');
    expect(text).not.toContain('=SUM');
  }, 120_000);

  it('leaves out the hidden sheet, hidden row and hidden column, and says so', async () => {
    const result = await convert(await fixture());
    const text = flat(await extractedText(result.bytes));

    // Nothing that lives only behind a hidden sheet, row or column reaches the
    // output. A leak here would be this tool publishing what Excel was hiding.
    for (const secret of EXCEL_TO_PDF.hiddenOnly) {
      expect(text, `"${secret}" is hidden in Excel and must not be in the PDF`).not.toContain(
        secret
      );
    }

    // Excluded *and disclosed* — the three notes name what went and how much.
    expect(result.notes).toContain(hiddenSheetsNote([EXCEL_TO_PDF.sheets.notes]));
    expect(result.notes).toContain(hiddenRowsNote(EXCEL_TO_PDF.sheets.regions, 1));
    expect(result.notes).toContain(hiddenColumnsNote(EXCEL_TO_PDF.sheets.regions, 1));

    // What is left of `Regions` is still a correct grid.
    const lines = await extractedLines(result.bytes);
    for (const row of EXCEL_TO_PDF.regionsVisible) {
      const pattern = new RegExp(`^${row.join('\\s+')}$`);
      expect(
        lines.some(line => pattern.test(line)),
        `visible row ${JSON.stringify(row)} came back in column order; saw:\n${lines.join('\n')}`
      ).toBe(true);
    }
  }, 120_000);

  it('gives an empty sheet a section that says it is empty, rather than dropping it', async () => {
    const result = await convert(await fixture());
    const text = flat(await extractedText(result.bytes));

    // "One section per sheet" has to hold for the sheet with nothing in it too,
    // or the PDF quietly has fewer sections than the workbook has sheets.
    expect(text).toContain(EXCEL_TO_PDF.sheets.blank);
    expect(text).toContain(XLSX_SHEET_EMPTY_TEXT);
    const blank = result.sheets.find(sheet => sheet.name === EXCEL_TO_PDF.sheets.blank);
    expect(blank).toMatchObject({ empty: true, unreadable: false, rows: 0, columns: 0 });
    // "Empty" is now a claim that has to be *earned* from the bytes, so a real
    // blank sheet must still earn it: nothing here may be reported as damaged.
    expect(result.notes.join(' ')).not.toContain('could not be read');
  }, 120_000);

  it('continues a sheet too wide for the page as further column bands, losing none', async () => {
    const result = await convert(await fixture());
    const text = flat(await extractedText(result.bytes));

    const wide = result.sheets.find(sheet => sheet.name === EXCEL_TO_PDF.sheets.wide);
    expect(wide?.columns).toBe(EXCEL_TO_PDF.wideHeaders.length);
    expect(wide?.bands, '20 columns do not fit one A4 grid').toBeGreaterThan(1);

    // Every one of the 20 columns is in the PDF — the whole point of banding
    // rather than truncating.
    for (const header of EXCEL_TO_PDF.wideHeaders) expect(text).toContain(header);
    for (const value of EXCEL_TO_PDF.wideValues) expect(text).toContain(value);

    // And each band says which columns it is, in the document itself.
    // A plain hyphen, because the WinAnsi sanitiser rewrites an en dash to one
    // on the way into the page — and the reader writes it that way for exactly
    // this reason.
    expect(text).toMatch(/Columns A-[A-Z]+ \(1 of \d\)/);
    expect(text).toMatch(/Columns [A-Z]+-T \(\d of \d\)/);
  }, 120_000);

  it('re-parses as a structurally valid PDF with the requested page size', async () => {
    const a4 = await convert(await fixture(), { pageSize: 'a4' });
    const letter = await convert(await fixture(), { pageSize: 'letter' });

    for (const [label, result, expected] of [
      ['a4', a4, [595.28, 841.89]],
      ['letter', letter, [612, 792]]
    ] as const) {
      const doc = await PDFDocument.load(result.bytes.slice());
      expect(doc.getPageCount(), label).toBe(result.pageCount);
      expect(result.pageCount, label).toBeGreaterThan(0);
      const { width, height } = doc.getPage(0).getSize();
      expect(width, label).toBeCloseTo(expected[0], 1);
      expect(height, label).toBeCloseTo(expected[1], 1);
    }

    // Two different page sizes must actually produce different bytes, or the
    // option is decorative and the gate is re-closing for nothing.
    expect(Buffer.from(a4.bytes).equals(Buffer.from(letter.bytes))).toBe(false);
  }, 180_000);

  it('describes the output for the mandatory preview, page by page, in output order', async () => {
    const { outline, pageCount, sheets } = await convert(await fixture());

    // One heading per visible sheet, and its text is the sheet's name.
    const headings = outline.filter(item => item.kind === 'heading');
    expect(headings.map(item => item.text)).toEqual(sheets.map(sheet => sheet.name));

    // Every row names a page that exists in the file, and pages only move
    // forward — an outline that claimed page 9 of an 8-page PDF would be a
    // preview describing a document that is not there.
    let previous = 0;
    for (const item of outline) {
      expect(item.pageIndex).toBeGreaterThanOrEqual(previous);
      expect(item.pageIndex).toBeLessThan(pageCount);
      previous = item.pageIndex;
    }

    // The grid rows are summarised, so the preview says how much data it drew.
    expect(outline.find(item => item.kind === 'table')?.text).toContain('4 rows × 4 columns');
  }, 120_000);

  it('titles the PDF from the documentName option when the workbook states none', async () => {
    const result = await convert(await fixture(), { documentName: 'quarterly-workbook' });
    const doc = await PDFDocument.load(result.bytes.slice());
    expect(doc.getTitle()).toBe('quarterly-workbook');
  }, 120_000);

  it('prefers the workbook’s own title over the file name', async () => {
    const XLSX = await import('xlsx');
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['a']]), 'S');
    book.Props = { Title: 'Stated by the workbook' };
    const bytes = new Uint8Array(
      XLSX.write(book, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
    );

    const result = await convert(bytes, { documentName: 'from-the-file-name' });
    const doc = await PDFDocument.load(result.bytes.slice());
    expect(doc.getTitle()).toBe('Stated by the workbook');
  }, 120_000);

  it('reports determinate, monotonic progress across both passes', async () => {
    // Evidence that the real `convertXlsxToPdf` ran its own sequence: the read
    // band (0..0.45) and the layout band (0.45..1) are its bands, defined
    // nowhere else.
    const { progress } = await convert(await fixture());
    expect(progress.length).toBeGreaterThan(2);
    for (const fraction of progress) {
      expect(fraction).toBeGreaterThanOrEqual(0);
      expect(fraction).toBeLessThanOrEqual(1);
    }
    expect([...progress].sort((a, b) => a - b)).toEqual(progress);
    expect(progress.some(fraction => fraction >= 0.45)).toBe(true);
  }, 120_000);

  it('replaces no character the standard fonts cannot draw, on this fixture', async () => {
    const result = await convert(await fixture());
    expect(result.hadUnsupportedCharacters).toBe(false);
  }, 120_000);

  it('paginates a long sheet across pages without losing a row', async () => {
    // The fixture's sheets are short, so the page-break path needs its own input.
    // 120 rows is comfortably more than one A4 page of grid.
    const rows = Array.from({ length: 120 }, (_, index) => [
      `Row ${index + 1}`,
      `value-${index + 1}`
    ]);
    const result = await convert(await sheetFrom([['Label', 'Value'], ...rows], 'Long'));

    expect(result.pageCount).toBeGreaterThan(1);
    const doc = await PDFDocument.load(result.bytes.slice());
    expect(doc.getPageCount()).toBe(result.pageCount);

    const text = flat(await extractedText(result.bytes));
    for (const index of [1, 60, 120]) {
      expect(text, `row ${index} survived the page breaks`).toContain(`value-${index}`);
    }
    expect(result.notes).toEqual([]);
  }, 180_000);

  it('cancels through the AbortSignal instead of running to completion', async () => {
    const controller = new AbortController();
    controller.abort();
    const before = layoutCalls;
    await expect(convert(await fixture(), {}, { signal: controller.signal })).rejects.toThrow();
    // Cancellation is a refusal too: an aborted job must not have laid out a PDF
    // on its way to throwing.
    expect(layoutCalls).toBe(before);
  }, 120_000);

  it('cancels a job aborted after it was started but before it could yield', async () => {
    // Deliberately *not* described as "the per-sheet checkpoint notices": the
    // audit's finding 4 was that this comment used to claim exactly that and was
    // wrong. `convert` reaches its first `await` before returning, so a
    // synchronous `abort()` here still lands before checkpoint 0's continuation
    // runs and checkpoint 0 is what throws — the same guard as the test above,
    // reached down a different path (a signal that was live when the job
    // started, rather than one already aborted when it was handed over). The
    // layout phase gets its own test below, which is the case this one was
    // mistakenly believed to cover.
    const controller = new AbortController();
    const before = layoutCalls;
    const running = convert(await fixture(), {}, { signal: controller.signal });
    controller.abort();
    await expect(running).rejects.toThrow();
    expect(layoutCalls).toBe(before);
  }, 120_000);

  it('cancels during the PDF layout phase, after the workbook was read in full', async () => {
    // The phase nothing exercised. `pdf-block-layout.ts` checkpoints once per
    // block, and `convertXlsxToPdf` maps that band onto 0.45..1 — so aborting on
    // the first progress report strictly above 0.45 aborts inside the layout
    // engine, with the read already finished.
    const XLSX = await import('xlsx');
    const book = XLSX.utils.book_new();
    // 20 sheets → ~40 blocks → ~40 layout checkpoints to be interrupted between.
    for (let index = 0; index < 20; index++) {
      XLSX.utils.book_append_sheet(
        book,
        XLSX.utils.aoa_to_sheet([[`head ${index}`], [`body ${index}`]]),
        `S${index}`
      );
    }
    const bytes = new Uint8Array(
      XLSX.write(book, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
    );

    const controller = new AbortController();
    const before = layoutCalls;
    const progress: number[] = [];
    await expect(
      convertXlsxToPdf(
        bytes,
        { pageSize: 'a4' },
        {
          signal: controller.signal,
          onProgress: fraction => {
            progress.push(fraction ?? 0);
            if ((fraction ?? 0) > 0.45) controller.abort();
          }
        }
      )
    ).rejects.toThrow();

    // Unlike the two tests above, the layout engine *was* entered — this is a
    // cancellation of the second phase, not of the first.
    expect(layoutCalls, 'the layout phase really ran').toBe(before + 1);
    expect(
      progress.some(fraction => fraction > 0.45),
      'progress crossed the inter-phase gate into the layout band'
    ).toBe(true);
    // And it stopped there: the run never reported itself as nearly finished.
    expect(Math.max(...progress)).toBeLessThan(1);
  }, 180_000);
});

describe('CNV-11 — column widths reach the drawn bytes', () => {
  it('draws unequal columns when the workbook states unequal widths', async () => {
    // Two sheets with the same text and different declared column widths must
    // produce different cell rectangles in the content stream. Graded off the
    // `re` operators, not off the numbers the reader computed.
    const narrowFirst = await sheetFrom([['a', 'b']], 'W', sheet => {
      sheet['!cols'] = [{ wch: 6 }, { wch: 40 }];
    });
    const wideFirst = await sheetFrom([['a', 'b']], 'W', sheet => {
      sheet['!cols'] = [{ wch: 40 }, { wch: 6 }];
    });

    const [narrow, wide] = await Promise.all([convert(narrowFirst), convert(wideFirst)]);
    const widthsOf = async (pdf: Uint8Array) =>
      (await drawnCellWidths(pdf)).map(width => Math.round(width));

    const narrowWidths = await widthsOf(narrow.bytes);
    const wideWidths = await widthsOf(wide.bytes);
    expect(narrowWidths).toHaveLength(2);
    expect(wideWidths).toHaveLength(2);

    // The first column is the narrow one in the first document and the wide one
    // in the second — the columns really are laid out from the workbook.
    expect(narrowWidths[0]).toBeLessThan(narrowWidths[1]);
    expect(wideWidths[0]).toBeGreaterThan(wideWidths[1]);
    // And in both cases the row still spans the whole content column.
    for (const widths of [narrowWidths, wideWidths]) {
      expect(widths[0] + widths[1]).toBeGreaterThan(450);
      expect(widths[0] + widths[1]).toBeLessThan(453);
    }
  }, 180_000);

  it('falls back to an equal split for a malformed width list', async () => {
    // A producer that hands the engine the wrong number of widths, or a zero,
    // must not divide by zero and draw the grid at x = NaN.
    const { layoutBlocksToPdf } = await import('../../src/core/convert/pdf-block-layout');
    const rows = [
      [[{ text: 'a', bold: false, italic: false }], [{ text: 'b', bold: false, italic: false }]]
    ];
    const equal = await layoutBlocksToPdf([{ kind: 'table', rows }], { pageSize: 'a4' });
    for (const broken of [[1], [1, 2, 3], [0, 0], [Number.NaN, 1], [-1, 2]]) {
      const laid = await layoutBlocksToPdf([{ kind: 'table', rows, columnWidths: broken }], {
        pageSize: 'a4'
      });
      const widths = (await drawnCellWidths(laid.bytes)).map(width => Math.round(width));
      expect(widths, `columnWidths ${JSON.stringify(broken)} falls back`).toEqual(
        (await drawnCellWidths(equal.bytes)).map(width => Math.round(width))
      );
    }
  }, 120_000);

  it('groups columns into bands without ever dropping one', () => {
    // 12 is the hard cap per band; a band always takes at least one column,
    // however wide, so no width can make a column disappear.
    expect(bandColumns(Array.from({ length: 30 }, () => 32)).flat()).toEqual(
      Array.from({ length: 30 }, (_, index) => index)
    );
    expect(bandColumns(Array.from({ length: 30 }, () => 32)).map(band => band.length)).toEqual([
      12, 12, 6
    ]);
    // One absurdly wide column still gets its own band rather than being skipped.
    expect(bandColumns([1000, 1000])).toEqual([[0], [1]]);
    expect(bandColumns([])).toEqual([]);
  });

  it('approximates a column width from the workbook, then from content, then a default', () => {
    // Pixels win over characters, characters over content, content over nothing —
    // and both ends are clamped so no column is unreadably thin or absurdly wide.
    expect(columnWidthPt({ wpx: 100 }, 0)).toBeCloseTo(75, 5);
    expect(columnWidthPt({ wch: 20 }, 0)).toBeCloseTo(108.75, 5);
    expect(columnWidthPt(undefined, 30)).toBeCloseTo(166.5, 5);
    expect(columnWidthPt(undefined, 0)).toBeCloseTo(48.01, 2);
    expect(columnWidthPt({ wpx: 1 }, 0)).toBe(32);
    expect(columnWidthPt({ wpx: 10_000 }, 0)).toBe(200);
  });

  it('names cells and columns the way a spreadsheet does', () => {
    expect(cellAddress(0, 0)).toBe('A1');
    expect(cellAddress(9, 25)).toBe('Z10');
    expect(cellAddress(0, 26)).toBe('AA1');
    expect(cellAddress(0, 701)).toBe('ZZ1');
    expect(cellAddress(0, 702)).toBe('AAA1');
    expect(columnName(0)).toBe('A');
    expect(columnName(27)).toBe('AB');
  });
});

describe('CNV-11 — refusing input it cannot convert honestly', () => {
  /** Runs the conversion and returns the error, asserting the writer never ran. */
  async function refusal(bytes: Uint8Array): Promise<StaplerError> {
    const before = layoutCalls;
    let caught: unknown;
    try {
      await convert(bytes);
    } catch (err) {
      caught = err;
    }
    expect(caught, 'the conversion must reject rather than produce a PDF').toBeInstanceOf(
      StaplerError
    );
    expect(layoutCalls, 'the layout engine must never be reached').toBe(before);
    return caught as StaplerError;
  }

  it('refuses binary garbage that SheetJS would otherwise “read” as a spreadsheet', async () => {
    // The reason `xlsx-reader.ts` checks the ZIP magic itself. Handed these bytes
    // directly, `XLSX.read` does *not* throw: it sniffs them as
    // delimiter-separated text and returns a one-sheet workbook whose cells hold
    // the control characters. Converting that would hand the user a PDF of
    // nonsense presented as their spreadsheet.
    const garbage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

    // First, the fact this test rests on, asserted rather than assumed.
    const XLSX = await import('xlsx');
    const permissive = XLSX.read(garbage, { type: 'array' });
    expect(permissive.SheetNames.length).toBeGreaterThan(0);

    // And then the refusal.
    const error = await refusal(garbage);
    expect(error.message).toContain(XLSX_NOT_A_ZIP_MESSAGE);
  });

  it('refuses a CSV renamed .xlsx, for the same reason', async () => {
    const csv = new TextEncoder().encode('Region,Revenue\nNorth,1204\n');
    const error = await refusal(csv);
    expect(error.message).toContain(XLSX_NOT_A_ZIP_MESSAGE);
  });

  it('refuses an empty file', async () => {
    const error = await refusal(new Uint8Array(0));
    expect(error.message).toContain(XLSX_EMPTY_MESSAGE);
  });

  it('refuses a legacy .xls / password-protected .xlsx by its OLE2 signature', async () => {
    const ole = new Uint8Array(64);
    ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    const error = await refusal(ole);
    expect(error.message).toContain(XLSX_LEGACY_MESSAGE);
  });

  it('refuses a valid ZIP that holds no workbook, and says that, not that the ZIP broke', async () => {
    // Past the magic-byte check, so this one has to be caught by SheetJS's own
    // error — which is why the translation is tested end to end and not only as
    // a unit.
    //
    // This assertion used to read `XLSX_NOT_A_ZIP_MESSAGE`, and was codifying
    // the second review pass's finding 2: SheetJS throws the *same*
    // `Unsupported ZIP file` for a container it could not open and for one it
    // opened perfectly that holds no OOXML parts, so this input was being told
    // "its ZIP container could not be opened" about a ZIP that opened fine.
    const bytes = zipSync({ 'hello.txt': strToU8('not a workbook') });

    // The fact the fix rests on, asserted rather than assumed.
    expect(zipOpens(bytes)).toBe(true);

    const error = await refusal(bytes);
    expect(error.message).toContain(XLSX_NOT_A_WORKBOOK_MESSAGE);
    expect(error.message).not.toContain('ZIP container could not be opened');
  }, 60_000);

  it('still blames the container for a ZIP that really cannot be opened', async () => {
    // The other side of the same fix: a truncated archive gets `Unsupported ZIP
    // file` from SheetJS too, and it must keep the container message. Built by
    // cutting a real workbook in half so the local header (and so the magic-byte
    // check) survives and the central directory does not.
    const whole = await fixture();
    const half = whole.slice(0, Math.floor(whole.length / 2));
    expect(zipOpens(half)).toBe(false);

    const error = await refusal(half);
    expect(error.message).toContain(XLSX_NOT_A_ZIP_MESSAGE);
  }, 60_000);

  it('refuses a workbook that declares no sheets at all', async () => {
    // `XLSX_NO_SHEETS_MESSAGE` had no test, and the question was whether it was
    // reachable: SheetJS's *writer* refuses to emit a sheetless workbook
    // ("Workbook is empty"), so the package is hand-built here. Its reader
    // parses it happily and returns `SheetNames: []`, so the branch is live.
    const bytes = zeroSheetWorkbook();
    const XLSX = await import('xlsx');
    expect(XLSX.read(bytes, { type: 'array' }).SheetNames).toEqual([]);

    const error = await refusal(bytes);
    expect(error.message).toContain(XLSX_NO_SHEETS_MESSAGE);
  }, 60_000);

  it('refuses a .docx renamed .xlsx', async () => {
    const error = await refusal(
      zipSync({
        '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types/>'),
        'word/document.xml': strToU8('<w:document/>')
      })
    );
    expect(error.message).toContain(XLSX_NOT_A_WORKBOOK_MESSAGE);
  }, 60_000);

  it('refuses a workbook whose every sheet is hidden', async () => {
    const XLSX = await import('xlsx');
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['secret']]), 'Only');
    book.Workbook = { Sheets: [{ name: 'Only', Hidden: 1 }] };
    const bytes = new Uint8Array(
      XLSX.write(book, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
    );

    const error = await refusal(bytes);
    expect(error.message).toContain(XLSX_ALL_SHEETS_HIDDEN_MESSAGE);
    // An empty PDF would have been the alternative, and it would have leaked
    // nothing but explained nothing either.
    expect(error.kind).toBe('UnsupportedFeature');
  }, 60_000);

  it('translates every known SheetJS failure shape, and wraps unknown ones', () => {
    // Pinned against the strings `xlsx` 0.18.5 actually produces — reproduced by
    // running the cases above through the real library.
    expect(translateSheetJsError(new Error('Unsupported ZIP file')).message).toContain(
      XLSX_NOT_A_ZIP_MESSAGE
    );
    expect(translateSheetJsError(new Error('Unsupported ZIP encryption')).message).toContain(
      XLSX_LEGACY_MESSAGE
    );
    expect(translateSheetJsError(new Error('Unknown Namespace: ')).message).toContain(
      XLSX_NOT_A_WORKBOOK_MESSAGE
    );
    // Unknown shapes are still refusals, with the underlying text attached —
    // never an unhandled rejection surfacing as a generic failure.
    const unknown = translateSheetJsError(new Error('something nobody predicted'));
    expect(unknown.message).toContain('could not be read');
    expect(unknown.message).toContain('something nobody predicted');
  });
});

describe('CNV-11 — the caps, each of which reports what it left out', () => {
  const textOf = (block: LayoutBlock) =>
    block.kind === 'table' ? '' : 'runs' in block ? runsToText(block.runs) : '';

  it('caps rows and says which rows are not in the PDF', async () => {
    // Excel allows 1,048,576 rows; this engine draws 1,000. The cap is tested on
    // the reader rather than end to end because laying out 1,005 rows of grid is
    // 30-odd pages of PDF for a fact about the reader's arithmetic.
    const rows = Array.from({ length: MAX_SHEET_ROWS + 5 }, (_, index) => [`r${index + 1}`]);
    const { blocks, notes, sheets } = await readXlsxAsBlocks(await sheetFrom(rows, 'Tall'));

    expect(sheets[0].rows).toBe(MAX_SHEET_ROWS);
    expect(notes).toContain(rowCapNote('Tall', MAX_SHEET_ROWS + 5));

    const table = blocks.find(block => block.kind === 'table');
    if (table?.kind !== 'table') throw new Error('expected a grid');
    expect(table.rows).toHaveLength(MAX_SHEET_ROWS);
    expect(runsToText(table.rows[0][0])).toBe('r1');
    expect(runsToText(table.rows[MAX_SHEET_ROWS - 1][0])).toBe(`r${MAX_SHEET_ROWS}`);
  }, 120_000);

  it('caps columns and says how many are not in the PDF', async () => {
    const header = Array.from({ length: MAX_SHEET_COLUMNS + 3 }, (_, index) => `c${index + 1}`);
    const { notes, sheets } = await readXlsxAsBlocks(await sheetFrom([header], 'Wide'));

    expect(sheets[0].columns).toBe(MAX_SHEET_COLUMNS);
    expect(notes).toContain(columnCapNote('Wide', MAX_SHEET_COLUMNS + 3));
  }, 60_000);

  it('shortens a cell longer than the limit rather than letting it run off the page', async () => {
    // `pdf-block-layout.ts` deliberately lets an over-tall row overflow rather
    // than cutting it, which for a 32,000-character cell would mean text simply
    // gone off the bottom of the page with nothing to say so.
    const long = 'x'.repeat(MAX_CELL_CHARS + 200);
    const { blocks, notes } = await readXlsxAsBlocks(await sheetFrom([[long]], 'Long'));

    expect(notes).toContain(truncatedCellsNote(1));
    const table = blocks.find(block => block.kind === 'table');
    if (table?.kind !== 'table') throw new Error('expected a grid');
    const drawn = runsToText(table.rows[0][0]);
    expect(drawn).toHaveLength(MAX_CELL_CHARS);
    expect(drawn.endsWith('…')).toBe(true);
  }, 60_000);

  it('reports a formula cell that carries no cached result instead of drawing nothing', async () => {
    // A file written by a tool that stores formulas without their last computed
    // value has nothing to draw, and this converter calculates nothing. Blank
    // *and* counted is the honest version.
    const bytes = await sheetFrom([['a']], 'F', sheet => {
      sheet.B1 = { t: 'n', f: 'SUM(A1:A1)' };
      sheet['!ref'] = 'A1:B1';
    });
    const { notes } = await readXlsxAsBlocks(bytes);
    expect(notes).toContain(uncachedFormulaNote(1));
  }, 60_000);

  it('ignores a declared range far larger than the cells that exist', async () => {
    // A generator is free to write `!ref` as `A1:B1048576` for a sheet holding
    // one cell. Trusting it would be a million-row loop; the reader reads the
    // real extent from the cells instead.
    const XLSX = await import('xlsx');
    const book = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([['only']]);
    sheet['!ref'] = 'A1:B1048576';
    XLSX.utils.book_append_sheet(book, sheet, 'Sparse');
    const bytes = new Uint8Array(
      XLSX.write(book, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
    );

    const started = Date.now();
    const { blocks, sheets, notes } = await readXlsxAsBlocks(bytes);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(sheets[0]).toMatchObject({ rows: 1, columns: 1, empty: false });
    expect(notes).toEqual([]);
    const table = blocks.find(block => block.kind === 'table');
    if (table?.kind !== 'table') throw new Error('expected a grid');
    expect(table.rows).toHaveLength(1);
  }, 60_000);

  it('does not call a sheet of uncalculated formulas empty', async () => {
    // Every cell is a formula whose cached value is missing, so nothing widens
    // the grid and the extent stays empty — which used to land on "This sheet is
    // empty." The sheet is not empty; it is full of formulas nobody calculated,
    // and this module's own rule is that emptiness is never assumed.
    const bytes = await sheetFrom([[]], 'Formulas', sheet => {
      sheet.A1 = { t: 'n', f: 'SUM(B1:B2)' };
      sheet.A2 = { t: 'n', f: 'SUM(B1:B3)' };
      sheet['!ref'] = 'A1:A2';
    });
    const { blocks, sheets, notes } = await readXlsxAsBlocks(bytes);

    expect(sheets[0].empty, 'not empty — it holds cells').toBe(false);
    expect(sheets[0].unreadable, 'and not damaged either').toBe(false);
    expect(blocks.map(textOf)).toEqual(['Formulas', XLSX_SHEET_FORMULAS_ONLY_TEXT]);
    expect(blocks.map(textOf)).not.toContain(XLSX_SHEET_EMPTY_TEXT);
    // Reported through the diagnostic that names the real cause, with both cells.
    expect(notes).toContain(uncachedFormulaNote(2));
  }, 60_000);

  it('does not blame uncalculated formulas for rows the row cap removed', async () => {
    // The count is a diagnostic: it says "these cells are blank because nobody
    // calculated them". A formula past the row cap is missing because of the
    // cap, which has its own note, so counting it there sends the user looking
    // in the wrong place.
    const rows = Array.from({ length: MAX_SHEET_ROWS + 5 }, (_, index) => [`r${index + 1}`]);
    const bytes = await sheetFrom(rows, 'Capped', sheet => {
      // One inside the drawn range, one well past the cap.
      sheet.B1 = { t: 'n', f: 'SUM(A1:A1)' };
      sheet[`B${MAX_SHEET_ROWS + 4}`] = { t: 'n', f: 'SUM(A1:A2)' };
      sheet['!ref'] = `A1:B${MAX_SHEET_ROWS + 5}`;
    });
    const { notes } = await readXlsxAsBlocks(bytes);

    expect(notes).toContain(rowCapNote('Capped', MAX_SHEET_ROWS + 5));
    expect(notes, 'only the in-range formula is counted').toContain(uncachedFormulaNote(1));
    expect(notes).not.toContain(uncachedFormulaNote(2));
  }, 60_000);

  it('does not count an uncalculated formula in a hidden row', async () => {
    const bytes = await sheetFrom([['visible'], ['also visible']], 'Masked2', sheet => {
      sheet['!rows'] = [undefined, { hidden: true }];
      sheet.B2 = { t: 'n', f: 'SUM(A1:A1)' };
      sheet['!ref'] = 'A1:B2';
    });
    const { notes } = await readXlsxAsBlocks(bytes);

    expect(notes).toContain(hiddenRowsNote('Masked2', 1));
    expect(notes.some(note => note.includes('carried no cached result'))).toBe(false);
  }, 60_000);

  it('says a sheet is empty when every row with content in it is hidden', async () => {
    const bytes = await sheetFrom([['visible header'], ['hidden body']], 'Masked', sheet => {
      sheet['!rows'] = [{ hidden: true }, { hidden: true }];
    });
    const { blocks, sheets, notes } = await readXlsxAsBlocks(bytes);

    expect(sheets[0].empty).toBe(true);
    expect(notes).toContain(hiddenRowsNote('Masked', 2));
    expect(blocks.map(textOf)).toEqual([
      'Masked',
      'Every row or column with content in this sheet is hidden, so the grid is empty.'
    ]);
  }, 60_000);

  it('reads a cell’s displayed text, falling back through the value types', () => {
    expect(cellText(undefined)).toBe('');
    expect(cellText({ t: 'z' })).toBe('');
    expect(cellText({ t: 'n', v: 1204.5, w: '1,204.50' })).toBe('1,204.50');
    expect(cellText({ t: 'n', v: 1204.5 })).toBe('1204.5');
    expect(cellText({ t: 'b', v: true })).toBe('TRUE');
    expect(cellText({ t: 'b', v: false })).toBe('FALSE');
    expect(cellText({ t: 'd', v: new Date(Date.UTC(2026, 0, 15)) })).toBe('2026-01-15');
    expect(cellText({ t: 'e', v: 0x07, w: '#DIV/0!' })).toBe('#DIV/0!');
  });

  it('never draws an error cell’s raw code as if it were a value', () => {
    // The audit's finding 9, narrowed to the case that is both cheap to guard
    // and catastrophic to get wrong. An error cell stores a *number* in `v`
    // (`#DIV/0!` is 7), and `w` is absent whenever SSF cannot parse the cell's
    // number format — so the general `String(value)` fallback would have drawn a
    // bare `7` in a cell the spreadsheet shows as `#DIV/0!`.
    expect(cellText({ t: 'e', v: 0x07 })).toBe('#DIV/0!');
    expect(cellText({ t: 'e', v: 0x00 })).toBe('#NULL!');
    expect(cellText({ t: 'e', v: 0x0f })).toBe('#VALUE!');
    expect(cellText({ t: 'e', v: 0x17 })).toBe('#REF!');
    expect(cellText({ t: 'e', v: 0x1d })).toBe('#NAME?');
    expect(cellText({ t: 'e', v: 0x24 })).toBe('#NUM!');
    expect(cellText({ t: 'e', v: 0x2a })).toBe('#N/A');
    expect(cellText({ t: 'e', v: 0x2b })).toBe('#GETTING_DATA');
    // A producer that stores the token itself keeps it.
    expect(cellText({ t: 'e', v: '#SPILL!' })).toBe('#SPILL!');
    // And a code this table does not name is still symbolic, never the number,
    // and never a real Excel token this cell does not have.
    expect(cellText({ t: 'e', v: 0x99 })).toBe(UNKNOWN_ERROR_TEXT);
    expect(cellText({ t: 'e', v: 0x99 })).not.toMatch(/\d/);
    for (const code of [0, 7, 0x0f, 0x17, 0x1d, 0x24, 0x2a, 0x2b, 0x99]) {
      expect(cellText({ t: 'e', v: code })).not.toBe(String(code));
    }
  });

  it('names the per-cell character cap in the panel’s own limitation list', () => {
    // The audit's finding 6. The three grid caps were in the static list and
    // this one was reported only afterwards, via `truncatedCellsNote` — the same
    // half-disclosure CNV-09's audit ruled against.
    const copy = EXCEL_LIMITATIONS.join(' ');
    expect(copy).toContain(String(MAX_CELL_CHARS));
    expect(copy).toContain(String(MAX_SHEET_ROWS));
    expect(copy).toContain(String(MAX_SHEET_COLUMNS));
  });

  it('keeps an external cell hyperlink and drops an in-workbook one', async () => {
    const bytes = await sheetFrom([['external', 'internal']], 'L', sheet => {
      sheet.A1 = { t: 's', v: 'external', w: 'external', l: { Target: 'https://example.test/a' } };
      sheet.B1 = { t: 's', v: 'internal', w: 'internal', l: { Target: "#'Sheet2'!A1" } };
    });
    const { blocks } = await readXlsxAsBlocks(bytes);
    const table = blocks.find(block => block.kind === 'table');
    if (table?.kind !== 'table') throw new Error('expected a grid');
    expect(table.rows[0][0][0].href).toBe('https://example.test/a');
    // There is no second sheet in a PDF for an in-workbook reference to reach.
    expect(table.rows[0][1][0].href).toBeUndefined();
  }, 60_000);
});

describe('CNV-11 — a damaged worksheet is never reported as an empty one', () => {
  /**
   * The second review pass's finding 1, and the defect class the CNV-08/09/10
   * audits were all fishing for: not a crash, but a *false claim about the
   * document*. `xlsx-reader.ts` handled a missing worksheet part honestly and a
   * corrupted one by falling through to "This sheet is empty." — which is
   * factually wrong. The sheet has content; it could not be parsed.
   *
   * Every test here is a claim about the produced PDF's own text, so it grades
   * what the user actually reads.
   */
  it('says the sheet could not be read, not that it is empty', async () => {
    const bytes = await workbookWithBrokenSheet('this is not XML at all <<<>>> &&&');

    // First, the SheetJS behaviour the defect rested on, asserted rather than
    // assumed: the read *succeeds*, and the damaged sheet is a truthy, key-less
    // object — the identical value a genuinely blank sheet produces.
    const XLSX = await import('xlsx');
    const probed = XLSX.read(bytes.slice(), { type: 'array', cellStyles: true });
    expect(probed.SheetNames).toEqual(['Broken', 'Fine']);
    expect(probed.Sheets.Broken).toBeTruthy();
    expect(Object.keys(probed.Sheets.Broken)).toEqual([]);

    const result = await convert(bytes);
    const text = flat(await extractedText(result.bytes));

    // The whole point: the PDF says the sheet could not be read — verbatim, so
    // this also holds the constant to characters the standard fonts can draw.
    expect(text).toContain(XLSX_SHEET_UNREADABLE_TEXT);
    // And it never says the false thing. This assertion is what fails, with the
    // pre-fix code, on exactly the audit's repro.
    expect(text, 'a damaged sheet must not be called empty').not.toContain(XLSX_SHEET_EMPTY_TEXT);

    // The summary the panel reads agrees, in its own field rather than by
    // string-matching a sentence.
    const broken = result.sheets.find(sheet => sheet.name === 'Broken');
    expect(broken).toMatchObject({ unreadable: true, empty: false, rows: 0, columns: 0 });

    // …and it is in the "left out" list, so the person deciding whether to save
    // is told before they save, not only after they open the file.
    expect(result.notes).toContain(unreadableSheetNote('Broken'));
  }, 120_000);

  it('still converts the sheets that did parse, rather than failing the whole file', async () => {
    // "Detect and explain, never half-process" is about not producing something
    // that *looks* complete. A section that says it could not be read is not a
    // silent partial: the intact sheet is converted, the damaged one is named.
    const result = await convert(await workbookWithBrokenSheet('<<< not xml >>>'));
    const text = flat(await extractedText(result.bytes));

    expect(text).toContain('Fine');
    expect(text).toContain('intact');
    expect(result.sheets.map(sheet => sheet.name)).toEqual(['Broken', 'Fine']);
    expect(result.sheets.find(sheet => sheet.name === 'Fine')).toMatchObject({
      empty: false,
      unreadable: false,
      rows: 1,
      columns: 1
    });
    // Nothing from the damaged sheet leaked in as half-read content.
    expect(text).not.toContain('not xml');
  }, 120_000);

  it('catches the shapes a truncated or mistyped worksheet part takes', async () => {
    // Garbage is the easy case. These are the ones that still *look* like XML.
    for (const [label, content] of [
      ['truncated mid-row', '<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1"><v>1'],
      ['an HTML error page', '<html><body>403 Forbidden</body></html>'],
      ['an empty part', ''],
      ['a different OOXML part', '<?xml version="1.0"?><workbook><sheets/></workbook>']
    ] as const) {
      const result = await convert(await workbookWithBrokenSheet(content));
      const broken = result.sheets.find(sheet => sheet.name === 'Broken');
      expect(broken?.unreadable, `${label} is reported as unreadable`).toBe(true);
      expect(broken?.empty, `${label} is not reported as empty`).toBe(false);
    }
  }, 180_000);

  it('accepts every shape a genuinely blank worksheet takes, and calls it empty', async () => {
    // The other direction, and the reason the check is on the *bytes* and not on
    // "SheetJS returned nothing": over-reporting damage would be its own false
    // claim. All four of these are valid, complete worksheet documents that
    // SheetJS also parses to `{}`.
    const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
    for (const [label, content] of [
      ['self-closed sheetData, no dimension', `<worksheet xmlns="${ns}"><sheetData/></worksheet>`],
      ['open/close sheetData', `<worksheet xmlns="${ns}"><sheetData></sheetData></worksheet>`],
      [
        'what Excel writes for a blank sheet',
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          `<worksheet xmlns="${ns}"><dimension ref="A1"/><sheetViews><sheetView workbookViewId="0"/>` +
          '</sheetViews><sheetFormatPr defaultRowHeight="15"/><sheetData/>' +
          '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>'
      ],
      ['a namespace-prefixed root', `<x:worksheet xmlns:x="${ns}"><x:sheetData/></x:worksheet>`]
    ] as const) {
      const result = await convert(await workbookWithBrokenSheet(content));
      const blank = result.sheets.find(sheet => sheet.name === 'Broken');
      expect(blank?.empty, `${label} is reported as empty`).toBe(true);
      expect(blank?.unreadable, `${label} is not reported as damaged`).toBe(false);
      expect(result.notes.join(' ')).not.toContain('could not be read');
    }
  }, 180_000);

  it('reads a part that declares itself UTF-16 instead of calling it damaged', () => {
    // Rare, but not hypothetical: the OOXML spec allows it, and a UTF-16 part
    // decoded as UTF-8 is a string of NULs in which none of this module's
    // patterns match — so an intact worksheet would be reported as *damaged*,
    // which is a false statement about the user's file.
    const xml = '<?xml version="1.0" encoding="UTF-16"?><worksheet><sheetData/></worksheet>';
    const utf16 = (text: string, bom: boolean) => {
      const source = bom ? `\ufeff${text}` : text;
      const out = new Uint8Array(source.length * 2);
      for (let i = 0; i < source.length; i++) {
        const code = source.charCodeAt(i);
        out[i * 2] = code & 0xff;
        out[i * 2 + 1] = code >> 8;
      }
      return out;
    };

    expect(decodeXmlPart(utf16(xml, true))).toBe(xml);
    // No BOM either: `<` followed by NUL is the shape of a UTF-16LE declaration.
    expect(decodeXmlPart(utf16(xml, false))).toBe(xml);
    expect(isCompleteWorksheetPart(utf16(xml, true))).toBe(true);
    expect(isCompleteWorksheetPart(utf16(xml, false))).toBe(true);

    // UTF-8 is unchanged, and an encoding nothing can decode falls back to it
    // rather than throwing.
    expect(decodeXmlPart(strToU8('<?xml version="1.0" encoding="UTF-8"?><a/>'))).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><a/>'
    );
    expect(decodeXmlPart(strToU8('<?xml version="1.0" encoding="x-made-up"?><a/>'))).toContain(
      '<a/>'
    );
  });

  it('resolves a rel target that climbs out of xl/, and one written absolute', () => {
    // `Target="../xl/sheets/custom.xml"` is legal OPC. Left unresolved it names
    // no ZIP entry at all, the worksheet part cannot be located, and this module
    // reports a sheet it could have read as damaged.
    expect(resolveWorkbookTarget('../xl/sheets/custom.xml')).toBe('xl/sheets/custom.xml');
    expect(resolveWorkbookTarget('worksheets/../worksheets/sheet2.xml')).toBe(
      'xl/worksheets/sheet2.xml'
    );
    // The three shapes that already worked, unchanged.
    expect(resolveWorkbookTarget('worksheets/sheet1.xml')).toBe('xl/worksheets/sheet1.xml');
    expect(resolveWorkbookTarget('./worksheets/sheet1.xml')).toBe('xl/worksheets/sheet1.xml');
    expect(resolveWorkbookTarget('/xl/worksheets/sheet1.xml')).toBe('xl/worksheets/sheet1.xml');
    // A `..` that would climb above the package root is dropped: there is no
    // entry up there, and a path outside the ZIP is not one this reads.
    expect(resolveWorkbookTarget('../../../etc/passwd')).toBe('etc/passwd');
  });

  it('says so when a workbook declares the same sheet name twice', async () => {
    // Malformed input Excel will not write and refuses to open, but SheetJS
    // parses: its `Sheets` map is keyed by name, so the second sheet has already
    // overwritten the first before this module sees either. Nothing can recover
    // the lost sheet — but a PDF showing one grid twice under one heading, with
    // no mention that a sheet is missing, is the silent loss.
    const XLSX = await import('xlsx');
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['first']]), 'Alpha');
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['second']]), 'Beta');
    const parts = unzipSync(
      new Uint8Array(XLSX.write(book, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer)
    );
    parts['xl/workbook.xml'] = strToU8(
      strFromU8(parts['xl/workbook.xml']).replace('name="Beta"', 'name="Alpha"')
    );

    const { notes } = await readXlsxAsBlocks(zipSync(parts));
    expect(notes).toContain(duplicateSheetNamesNote(['Alpha']));
  }, 60_000);

  it('decides intactness from the part itself, so the rule is checkable in isolation', () => {
    const part = (xml: string) => isCompleteWorksheetPart(strToU8(xml));
    expect(part('<worksheet><sheetData/></worksheet>')).toBe(true);
    expect(part('<w:worksheet><w:sheetData/></w:worksheet>')).toBe(true);
    expect(part('<worksheet/>')).toBe(true);
    expect(part('<?xml version="1.0"?>\n<worksheet a="b">\n<sheetData/>\n</worksheet>\n')).toBe(
      true
    );
    expect(part('nonsense')).toBe(false);
    expect(part('')).toBe(false);
    expect(part('<worksheet><sheetData>')).toBe(false);
    expect(part('<workbook><sheets/></workbook>')).toBe(false);
    // A tag that merely starts with the right letters is not the root element.
    expect(part('<worksheetzz><sheetData/></worksheetzz>')).toBe(false);
  });

  it('reports a sheet whose part is missing from the package as unreadable too', async () => {
    // The pre-existing `!sheet` branch, re-graded: it already said "could not be
    // read", and now it also has to say `unreadable` in the summary and put a
    // note in the list, so the panel and the PDF cannot disagree.
    const XLSX = await import('xlsx');
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['gone']]), 'Gone');
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['kept']]), 'Kept');
    const parts = unzipSync(
      new Uint8Array(XLSX.write(book, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer)
    );
    delete parts['xl/worksheets/sheet1.xml'];

    const result = await convert(zipSync(parts));
    const gone = result.sheets.find(sheet => sheet.name === 'Gone');
    expect(gone).toMatchObject({ unreadable: true, empty: false });
    expect(result.notes).toContain(unreadableSheetNote('Gone'));
    const text = flat(await extractedText(result.bytes));
    expect(text).toContain('kept');
    expect(text).not.toContain(XLSX_SHEET_EMPTY_TEXT);
  }, 120_000);
});

describe('CNV-11 — the ZIP probe that keeps a refusal honest about its input', () => {
  it('opens a real ZIP and refuses the things that are not one', async () => {
    expect(zipOpens(await fixture())).toBe(true);
    expect(zipOpens(zipSync({ 'hello.txt': strToU8('x') }))).toBe(true);
    expect(zipOpens(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]))).toBe(false);
    expect(zipOpens(new Uint8Array(0))).toBe(false);
  }, 60_000);

  it('lets ZIP evidence override SheetJS’s ambiguous message', () => {
    // `Unsupported ZIP file` is one string for two unrelated inputs, which is
    // the whole of finding 2. With no evidence the old reading stands; with
    // proof the archive opened, the container is no longer blamed for it.
    const ambiguous = new Error('Unsupported ZIP file');
    expect(translateSheetJsError(ambiguous).message).toContain(XLSX_NOT_A_ZIP_MESSAGE);
    expect(translateSheetJsError(ambiguous, 'unreadable').message).toContain(
      XLSX_NOT_A_ZIP_MESSAGE
    );
    expect(translateSheetJsError(ambiguous, 'opened').message).toContain(
      XLSX_NOT_A_WORKBOOK_MESSAGE
    );

    // One step further into the package, and unambiguous either way.
    for (const zip of ['opened', 'unreadable', 'unknown'] as const) {
      expect(translateSheetJsError(new Error('Could not find workbook'), zip).message).toContain(
        XLSX_NOT_A_WORKBOOK_MESSAGE
      );
    }

    // The one container complaint an "opened" probe does not contradict: the
    // probe inflates nothing, so it never meets the method SheetJS refused.
    expect(
      translateSheetJsError(new Error('Unsupported ZIP Compression method 9'), 'opened').message
    ).toContain(XLSX_NOT_A_ZIP_MESSAGE);

    // Encryption still wins over everything, evidence or not.
    expect(
      translateSheetJsError(new Error('Unsupported ZIP encryption'), 'opened').message
    ).toContain(XLSX_LEGACY_MESSAGE);
  });
});
