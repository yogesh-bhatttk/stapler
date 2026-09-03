/**
 * CNV-09 — Word (DOCX) → PDF, graded against real output bytes.
 *
 * The acceptance criterion names its own verification method: a `.docx` fixture
 * "round-trips through this tool to a PDF whose extracted text (via CNV-04's own
 * extraction) matches the source paragraphs and table cell values". So the round
 * trip below runs the production pipeline end to end and then reads the produced
 * PDF back with `extractDocumentText` — the same `layoutText` path the Extract
 * tool ships — rather than inspecting the model it was drawn from. Nothing here
 * grades intent; every assertion is against bytes that came out of pdf-lib and
 * back in through pdf.js.
 *
 * Same worker arrangement as `pdf-to-word.test.ts`, and for the same reason:
 * `vi.mock('comlink')` makes the worker modules importable in Node (each calls
 * `Comlink.expose` at import time), and `vi.mock('../../src/core/workers')` leases
 * the **real** worker implementations in place of real `Worker`s. The function
 * under test is therefore `operations.convertDocxToPdf` itself — its own
 * sequencing, its own progress bands, its own refusal behaviour — not a
 * re-implementation of it. CNV-08's audit had to fix exactly that defect in its
 * own test file, so this one starts from the corrected shape.
 *
 * What this file cannot prove is stated in the ticket's Status line: nothing here
 * opens Acrobat, Preview or Chrome's viewer.
 */
import { describe, expect, it, vi } from 'vitest';
import { zipSync, strToU8, unzlibSync } from 'fflate';
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRawStream } from 'pdf-lib';
import { WORD_TO_PDF, wordToPdfDocx } from '../e2e/fixtures';
import {
  DEEP_LIST_NOTE,
  MAX_LIST_DEPTH,
  parseHtmlBlocks,
  normalizeRuns,
  runsToText,
  type LayoutBlock,
  type StyledRun
} from '../../src/core/convert/html-to-pdf-blocks';
import {
  DOCX_LEGACY_MESSAGE,
  DOCX_NO_DOCUMENT_MESSAGE,
  DOCX_NOT_A_ZIP_MESSAGE,
  translateMammothError
} from '../../src/core/convert/docx-reader';
import { layoutBlocksToPdf } from '../../src/core/convert/pdf-block-layout';
import { markdownToPdfBytes } from '../../src/core/markdown-to-pdf';
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
    docxToBlocks: (bytes: Bytes, job?: Parameters<typeof convertWorkerImpl.docxToBlocks>[1]) =>
      convertWorkerImpl.docxToBlocks(bytes.slice(), job)
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

const { convertDocxToPdf, extractDocumentText } = await import('../../src/core/operations');

type Converted = Awaited<ReturnType<typeof convertDocxToPdf>> & { progress: number[] };

/** The production entry point, nothing else. */
async function convert(
  bytes: Uint8Array,
  options: Partial<Parameters<typeof convertDocxToPdf>[1]> = {},
  jobOptions: { signal?: AbortSignal } = {}
): Promise<Converted> {
  const progress: number[] = [];
  const result = await convertDocxToPdf(
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

let fixtureCache: Uint8Array | undefined;
async function fixture(): Promise<Uint8Array> {
  fixtureCache ??= await wordToPdfDocx();
  return fixtureCache.slice();
}

/**
 * Every string the produced PDF actually *draws*, paired with the base font it
 * was drawn with — read out of the page content streams themselves.
 *
 * `extractDocumentText` answers "is the text there?"; nothing about pdf.js's text
 * layer says which face drew it, so a claim that bold survives into a table cell
 * cannot be graded from extraction alone. This walks the content stream instead:
 * pdf-lib emits `/<resource> <size> Tf` followed by `<hex> Tj` per `drawText`
 * call, and the page's `/Font` dictionary maps that resource name to a
 * `/BaseFont`. Content streams come back flate-encoded, hence the inflate.
 */
async function drawnText(pdf: Uint8Array): Promise<{ font: string; text: string }[]> {
  const doc = await PDFDocument.load(pdf.slice());
  const drawn: { font: string; text: string }[] = [];

  for (const page of doc.getPages()) {
    const fonts = page.node.Resources()?.lookupMaybe(PDFName.of('Font'), PDFDict);
    const baseFontByResource = new Map<string, string>();
    if (fonts) {
      for (const key of fonts.keys()) {
        const base = fonts.lookupMaybe(key, PDFDict)?.get(PDFName.of('BaseFont'));
        if (base) baseFontByResource.set(key.asString(), base.toString());
      }
    }

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

      let font = '';
      const token = /\/(\S+)\s+[\d.]+\s+Tf|<([0-9A-Fa-f]*)>\s*Tj|\(((?:\\.|[^\\)])*)\)\s*Tj/g;
      let match: RegExpExecArray | null;
      while ((match = token.exec(body)) !== null) {
        if (match[1] !== undefined) {
          font = baseFontByResource.get(`/${match[1]}`) ?? `/${match[1]}`;
          continue;
        }
        const text =
          match[2] !== undefined
            ? (match[2].match(/../g) ?? [])
                .map(byte => String.fromCharCode(Number.parseInt(byte, 16)))
                .join('')
            : match[3].replace(/\\([()\\])/g, '$1');
        if (text.length > 0) drawn.push({ font, text });
      }
    }
  }
  return drawn;
}

describe('CNV-09 — DOCX to PDF round trip', () => {
  it('produces a PDF whose extracted text matches the source paragraphs, in reading order', async () => {
    const result = await convert(await fixture());
    const text = flat(await extractedText(result.bytes));

    const expectedOrder = [
      WORD_TO_PDF.h1,
      WORD_TO_PDF.paragraph,
      WORD_TO_PDF.h2,
      WORD_TO_PDF.inlineSentence,
      ...WORD_TO_PDF.bullets,
      ...WORD_TO_PDF.numbered,
      WORD_TO_PDF.appendixH2,
      WORD_TO_PDF.appendixParagraph
    ];

    let cursor = -1;
    for (const fragment of expectedOrder) {
      const at = text.indexOf(fragment, cursor + 1);
      expect(at, `"${fragment}" is present after everything before it`).toBeGreaterThan(cursor);
      cursor = at;
    }
  }, 120_000);

  it('matches every table cell value, cell by cell, on its own row', async () => {
    // The criterion says "table cell values", so this asserts the grid rather
    // than the presence of the strings anywhere in the document: each source row
    // has to come back as one extracted line whose cells are in column order.
    const result = await convert(await fixture());
    const lines = (await extractedText(result.bytes))
      .split('\n')
      .map(line => flat(line))
      .filter(line => line.length > 0);

    for (const row of WORD_TO_PDF.table) {
      const pattern = new RegExp(
        `^${row.map(cell => cell.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+')}$`
      );
      expect(
        lines.some(line => pattern.test(line)),
        `row ${JSON.stringify(row)} came back as one line in column order; saw:\n${lines.join('\n')}`
      ).toBe(true);
    }
  }, 120_000);

  it('carries bold and italic into the PDF, including inside table cells', async () => {
    // CNV-08 states the loss of cell formatting as limitation 3 because its block
    // model carries cells as plain strings. This direction does not inherit that,
    // and the evidence is twofold: the parsed model marks the header cells bold,
    // and the produced PDF actually embeds the bold and oblique faces.
    const result = await convert(await fixture());

    const doc = await PDFDocument.load(result.bytes.slice());
    const baseFonts = new Set<string>();
    for (const page of doc.getPages()) {
      const resources = page.node.Resources();
      const fonts = resources?.lookupMaybe(PDFName.of('Font'), PDFDict);
      if (!fonts) continue;
      for (const key of fonts.keys()) {
        const font = fonts.lookupMaybe(key, PDFDict);
        const base = font?.get(PDFName.of('BaseFont'));
        if (base) baseFonts.add(base.toString());
      }
    }
    expect([...baseFonts].join(' ')).toMatch(/Helvetica-Bold/);
    expect([...baseFonts].join(' ')).toMatch(/Helvetica-Oblique/);
  }, 120_000);

  it('draws the fixture’s own table header in bold and its body rows in regular', async () => {
    // The two assertions above are *necessary* but not sufficient for the claim
    // this tool makes over CNV-08: the fixture's heading text and its italic run
    // would embed `Helvetica-Bold` and `-Oblique` even if every table cell were
    // drawn flat, and the model-level bold assertion in the parser suite below is
    // against a hand-written snippet rather than the fixture. So this one reads
    // the content stream of the real conversion of the real fixture and asks
    // which face each *cell string* was actually drawn with.
    const result = await convert(await fixture());

    // Each wrapped word is its own `drawText`, so consecutive drawings sharing a
    // face are merged back into one run before being matched — the question is
    // which face a cell's text was drawn with, not how the wrapper split it.
    const runs: { font: string; text: string }[] = [];
    for (const piece of await drawnText(result.bytes)) {
      const last = runs[runs.length - 1];
      if (last && last.font === piece.font) last.text += piece.text;
      else runs.push({ ...piece });
    }

    const [header, ...body] = WORD_TO_PDF.table;

    // All three header cells inside one run drawn with the bold face. The h2
    // "Revenue by region" is bold too, but it is a *different* run and contains
    // neither "Region" nor "Change", so it cannot satisfy this by accident.
    const headerRun = runs.find(run => header.every(cell => run.text.includes(cell)));
    expect(headerRun, `no single run holds ${JSON.stringify(header)}`).toBeDefined();
    expect(headerRun!.font).toMatch(/Helvetica-Bold/);

    for (const row of body) {
      const rowRun = runs.find(run => row.every(cell => run.text.includes(cell)));
      expect(rowRun, `no single run holds ${JSON.stringify(row)}`).toBeDefined();
      expect(rowRun!.font, `body row ${JSON.stringify(row)} is not drawn bold`).not.toMatch(/Bold/);
    }
  }, 120_000);

  it('marks the fixture’s own header cells bold in the parsed model, body cells not', async () => {
    // The model half of the same claim, and also against the fixture rather than
    // a snippet: the production read path (`readDocxAsHtml` → `parseHtmlBlocks`)
    // over the bytes the round trip converts.
    const { readDocxAsHtml } = await import('../../src/core/convert/docx-reader');
    const { html } = await readDocxAsHtml(await fixture());
    const { blocks } = parseHtmlBlocks(html);

    const table = blocks.find(block => block.kind === 'table');
    if (table?.kind !== 'table') throw new Error('the fixture has a table');

    expect(table.rows.map(row => row.map(runsToText))).toEqual(
      WORD_TO_PDF.table.map(row => [...row])
    );
    const boldOf = (row: StyledRun[][]) => row.map(cell => cell.every(run => run.bold));
    expect(boldOf(table.rows[0])).toEqual([true, true, true]);
    for (const row of table.rows.slice(1)) {
      expect(boldOf(row)).toEqual([false, false, false]);
    }
  }, 120_000);

  it('embeds the image as a real PDF image XObject', async () => {
    const result = await convert(await fixture());
    expect(result.imageCount).toBe(1);

    const doc = await PDFDocument.load(result.bytes.slice());
    let images = 0;
    for (const page of doc.getPages()) {
      const xobjects = page.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict);
      if (!xobjects) continue;
      for (const key of xobjects.keys()) {
        // An image XObject is a stream, not a dict — read the stream's own dict.
        const entry = xobjects.lookup(key);
        const dict =
          entry instanceof PDFDict ? entry : ((entry as { dict?: PDFDict }).dict ?? null);
        if (dict?.get(PDFName.of('Subtype'))?.toString() === '/Image') images += 1;
      }
    }
    expect(images).toBe(1);
    expect(result.outline.some(item => item.kind === 'image')).toBe(true);
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

  it('titles the PDF from the documentName option rather than from a live signal', async () => {
    const result = await convert(await fixture(), { documentName: 'quarterly-report' });
    const doc = await PDFDocument.load(result.bytes.slice());
    expect(doc.getTitle()).toBe('quarterly-report');
  }, 120_000);

  it('describes the output for the mandatory preview, page by page, in output order', async () => {
    const { outline, pageCount } = await convert(await fixture());

    expect(outline.map(item => item.kind)).toEqual([
      'heading',
      'paragraph',
      'heading',
      'paragraph',
      'list-item',
      'list-item',
      'list-item',
      'list-item',
      'list-item',
      'table',
      'heading',
      'paragraph',
      'image'
    ]);

    // Every row names a page that exists in the file, and pages only move
    // forward — an outline that claimed page 3 of a 2-page PDF would be a
    // preview describing a document that is not there.
    let previous = 0;
    for (const item of outline) {
      expect(item.pageIndex).toBeGreaterThanOrEqual(previous);
      expect(item.pageIndex).toBeLessThan(pageCount);
      previous = item.pageIndex;
    }

    expect(outline[0].text).toBe(WORD_TO_PDF.h1);
    expect(outline[0].level).toBe(1);
    expect(outline[2].level).toBe(2);
    expect(outline.find(item => item.kind === 'table')?.text).toContain('4 rows × 3 columns');
  }, 120_000);

  it('reports determinate, monotonic progress across both passes', async () => {
    // Evidence that the real `convertDocxToPdf` ran its own sequence: the read
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
    // A nested list used to pick `◦`/`▪` as its markers, which are outside
    // WinAnsi — so a perfectly ordinary document raised the "some characters
    // could not be represented" warning about *the converter's own* bullets.
    const result = await convert(await fixture());
    expect(result.hadUnsupportedCharacters).toBe(false);
    expect(result.notes).toEqual([]);
  }, 120_000);

  it('does not report another conversion\u2019s substitutions as its own', async () => {
    // `layoutBlocksToPdf` (this tool) and `markdownToPdfBytes` (CNV-05) both run
    // inside the pooled `process` worker, which shares one instance once the
    // pool is at capacity. They used to read one module-level flag that each
    // reset on entry, so a Markdown export starting inside this layout's `await`
    // decided what this document reported. Both answers must be the call's own.
    const asciiBlocks: LayoutBlock[] = [
      { kind: 'paragraph', runs: [{ text: 'Plain ASCII, nothing exotic.' }] }
    ];
    const cjkBlocks: LayoutBlock[] = [
      { kind: 'paragraph', runs: [{ text: '\u65e5\u672c\u8a9e \u4e2d\u6587' }] }
    ];

    const [ascii, cjkMarkdown] = await Promise.all([
      layoutBlocksToPdf(asciiBlocks, { pageSize: 'a4' }),
      markdownToPdfBytes('# \u65e5\u672c\u8a9e\n\nMixed \u4e2d\u6587 text.')
    ]);
    expect(ascii.hadUnsupportedCharacters, 'the layout kept its own answer').toBe(false);
    expect(cjkMarkdown.hadUnsupportedCharacters, 'and so did the Markdown export').toBe(true);

    // …and the other way round: a substituting layout beside a clean export.
    const [cjk, asciiMarkdown] = await Promise.all([
      layoutBlocksToPdf(cjkBlocks, { pageSize: 'a4' }),
      markdownToPdfBytes('# Plain ASCII\n\nNothing exotic here.')
    ]);
    expect(cjk.hadUnsupportedCharacters).toBe(true);
    expect(asciiMarkdown.hadUnsupportedCharacters).toBe(false);
  }, 60_000);

  it('paginates: content longer than one page produces more pages, in order', async () => {
    // The fixture fits on a single A4 page, so the page-break path needs its own
    // input or it would never run. This one is deliberately long enough that the
    // exact threshold does not matter.
    const paragraphs = Array.from(
      { length: 120 },
      (_, index) =>
        `<p>Paragraph number ${index + 1}. It carries enough words to occupy a full line of ` +
        'the text column so that the total height clearly exceeds one page.</p>'
    ).join('');
    const { blocks } = parseHtmlBlocks(`<h1>Long document</h1>${paragraphs}`);
    const { layoutBlocksToPdf } = await import('../../src/core/convert/pdf-block-layout');
    const result = await layoutBlocksToPdf(blocks, { pageSize: 'a4' });

    expect(result.pageCount).toBeGreaterThan(1);
    const doc = await PDFDocument.load(result.bytes.slice());
    expect(doc.getPageCount()).toBe(result.pageCount);

    // Every block landed on a real page, and the outline never goes backwards.
    let previous = 0;
    for (const item of result.outline) {
      expect(item.pageIndex).toBeGreaterThanOrEqual(previous);
      expect(item.pageIndex).toBeLessThan(result.pageCount);
      previous = item.pageIndex;
    }
    expect(previous).toBeGreaterThan(0);

    // And no text was lost across the breaks.
    const text = flat(await extractedText(result.bytes));
    expect(text).toContain('Paragraph number 1.');
    expect(text).toContain('Paragraph number 120.');
  }, 180_000);

  it('refuses to produce a blank PDF from a model with nothing in it', async () => {
    const { layoutBlocksToPdf } = await import('../../src/core/convert/pdf-block-layout');
    // A `.docx` that parses fine but holds no drawable content must fail loudly
    // rather than hand back a one-page blank file that looks like a success.
    const caught = await layoutBlocksToPdf([], { pageSize: 'a4' }).then(
      () => null,
      (err: unknown) => err
    );
    expect(caught).toBeInstanceOf(StaplerError);
    expect((caught as StaplerError).message).toMatch(/no text or images to convert/i);
    // …and as a fact about the *input*, not as "Something went wrong inside
    // Stapler.", which is what `InternalError` puts in front of the user.
    expect((caught as StaplerError).kind).toBe('CorruptDocument');
    expect((caught as StaplerError).copy.title).not.toMatch(/inside Stapler/);
  });

  it('cancels through the AbortSignal instead of running to completion', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(convert(await fixture(), {}, { signal: controller.signal })).rejects.toThrow();
  }, 120_000);
});

describe('CNV-09 — refusing input it cannot convert honestly', () => {
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

  it('refuses a file that is not a ZIP at all', async () => {
    const error = await refusal(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(error.message).toContain(DOCX_NOT_A_ZIP_MESSAGE);
  });

  it('refuses an empty file', async () => {
    const error = await refusal(new Uint8Array(0));
    expect(error.message).toMatch(/empty/i);
  });

  it('refuses a legacy .doc / password-protected .docx by its OLE2 signature', async () => {
    const ole = new Uint8Array(64);
    ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    const error = await refusal(ole);
    expect(error.message).toContain(DOCX_LEGACY_MESSAGE);
  });

  it('refuses a valid ZIP with no word/document.xml', async () => {
    // This one gets past the magic-byte check and has to be caught by
    // `mammoth`'s own error, which is why the translation is tested end to end
    // rather than only as a unit.
    const error = await refusal(zipSync({ 'hello.txt': strToU8('not a word document') }));
    expect(error.message).toContain(DOCX_NO_DOCUMENT_MESSAGE);
  }, 60_000);

  it('translates every known mammoth failure shape, and wraps unknown ones', () => {
    // Pinned against the strings mammoth 1.12.2 / jszip 3.10 actually produce —
    // reproduced by running the three cases above through the real library.
    expect(
      translateMammothError(new Error("Can't find end of central directory : is this a zip file ?"))
        .message
    ).toContain(DOCX_NOT_A_ZIP_MESSAGE);
    expect(
      translateMammothError(new Error('End of data reached (data length = 0, asked index = 4).'))
        .message
    ).toContain(DOCX_NOT_A_ZIP_MESSAGE);
    expect(
      translateMammothError(
        new Error('Could not find main document part. Are you sure this is a valid .docx file?')
      ).message
    ).toContain(DOCX_NO_DOCUMENT_MESSAGE);
    // Unknown shapes are still refusals, with the underlying text attached — never
    // an unhandled rejection surfacing as a generic failure.
    const unknown = translateMammothError(new Error('something nobody predicted'));
    expect(unknown.message).toContain('could not be read');
    expect(unknown.message).toContain('something nobody predicted');
  });
});

describe('CNV-09 — the HTML parser, over the constructs mammoth emits', () => {
  const textOf = (block: LayoutBlock) =>
    block.kind === 'table' ? '' : 'runs' in block ? runsToText(block.runs) : '';

  it('reads headings, paragraphs and inline styling', () => {
    const { blocks } = parseHtmlBlocks(
      '<h1>Title</h1><h3>Sub</h3><p>Plain <strong>bold</strong> and <em>italic</em> end.</p>'
    );
    expect(blocks.map(b => b.kind)).toEqual(['heading', 'heading', 'paragraph']);
    expect(blocks[0]).toMatchObject({ kind: 'heading', level: 1 });
    expect(blocks[1]).toMatchObject({ kind: 'heading', level: 3 });

    const paragraph = blocks[2];
    if (paragraph.kind !== 'paragraph') throw new Error('expected a paragraph');
    expect(paragraph.runs.filter(run => run.bold).map(run => run.text)).toEqual(['bold']);
    expect(paragraph.runs.filter(run => run.italic).map(run => run.text)).toEqual(['italic']);
    expect(runsToText(paragraph.runs)).toBe('Plain bold and italic end.');
  });

  it('reads bulleted, numbered and nested lists with their markers', () => {
    const { blocks } = parseHtmlBlocks(
      '<ul><li>One<ul><li>Deep</li></ul></li><li>Two</li></ul><ol start="3"><li>Third</li></ol>'
    );
    expect(
      blocks.map(block =>
        block.kind === 'list-item'
          ? `${block.depth}:${block.marker}:${runsToText(block.runs)}:${block.ordered}`
          : block.kind
      )
    ).toEqual(['0:•:One:false', '1:o:Deep:false', '0:•:Two:false', '0:3.:Third:true']);
  });

  it('reads a table as runs per cell, keeping cell formatting and padding short rows', () => {
    const { blocks } = parseHtmlBlocks(
      '<table><tr><td><p><strong>H1</strong></p></td><td><p>H2</p></td></tr>' +
        '<tr><td><p>only</p></td></tr></table>'
    );
    expect(blocks).toHaveLength(1);
    const table = blocks[0];
    if (table.kind !== 'table') throw new Error('expected a table');
    expect(table.rows.map(row => row.map(runsToText))).toEqual([
      ['H1', 'H2'],
      ['only', '']
    ]);
    expect(table.rows[0][0][0].bold).toBe(true);
    expect(table.rows[1][0][0].bold).toBe(false);
  });

  it('flattens a list nested deeper than it can indent, and never loses its text', async () => {
    // Word offers nine list levels; this engine indents eight. The recursion used
    // to stop at the limit and return, which emitted **no block and no note** for
    // anything below it: a 9-level and a 10-level list both came back as 8 blocks
    // and 0 notes, with levels 9 and 10 simply gone. That is the one failure mode
    // this file's contract rules out — "an unusual wrapper's text arrives as
    // plain paragraphs, never text disappears".
    const nested = (levels: number) => {
      let html = '';
      for (let level = levels; level >= 1; level--)
        html = `<ul><li>Level ${level}${html}</li></ul>`;
      return html;
    };

    for (const levels of [9, 10]) {
      const { blocks, notes } = parseHtmlBlocks(nested(levels));
      const items = blocks.filter(
        (block): block is Extract<LayoutBlock, { kind: 'list-item' }> => block.kind === 'list-item'
      );

      expect(items, `${levels} levels produce ${levels} items`).toHaveLength(levels);
      expect(items.map(item => runsToText(item.runs))).toEqual(
        Array.from({ length: levels }, (_, index) => `Level ${index + 1}`)
      );
      // Flattened, not dropped: everything past the limit is drawn at the
      // deepest level the engine has.
      expect(items.map(item => item.depth)).toEqual(
        Array.from({ length: levels }, (_, index) => Math.min(index, MAX_LIST_DEPTH - 1))
      );
      // …and it says so, exactly once, the way an unembeddable image does.
      expect(notes).toEqual([DEEP_LIST_NOTE]);
    }

    // And the text really reaches the produced bytes, not only the model.
    const { blocks } = parseHtmlBlocks(nested(10));
    const { layoutBlocksToPdf } = await import('../../src/core/convert/pdf-block-layout');
    const laid = await layoutBlocksToPdf(blocks, { pageSize: 'a4' });
    const text = flat(await extractedText(laid.bytes));
    for (let level = 1; level <= 10; level++) expect(text).toContain(`Level ${level}`);
  }, 120_000);

  it('decodes entities and keeps hyperlink targets', () => {
    const { blocks } = parseHtmlBlocks(
      '<p>R&amp;D &lt;5&gt; &#8212; <a href="https://example.test/a">link</a></p>'
    );
    const paragraph = blocks[0];
    if (paragraph.kind !== 'paragraph') throw new Error('expected a paragraph');
    expect(runsToText(paragraph.runs)).toBe('R&D <5> — link');
    expect(paragraph.runs.find(run => run.text === 'link')?.href).toBe('https://example.test/a');
  });

  it('turns a data-URI image into an image block and refuses one it cannot embed', () => {
    // A 1×1 PNG, and an EMF — the format Word stores pasted vector art in, which
    // mammoth hands over as a data URI no PDF can embed.
    const png =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const { blocks, notes } = parseHtmlBlocks(
      `<p><img src="${png}" alt="Chart" /></p><p><img src="data:image/x-emf;base64,AAAA" /></p>`
    );
    expect(blocks.map(b => b.kind)).toEqual(['image']);
    const image = blocks[0];
    if (image.kind !== 'image') throw new Error('expected an image');
    expect(image.format).toBe('png');
    expect(image.altText).toBe('Chart');
    expect([...image.data.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/X-EMF/);
  });

  it('never loses text inside an element it does not recognise', () => {
    const { blocks } = parseHtmlBlocks(
      '<div><blockquote><p>Quoted</p></blockquote></div><marquee><p>Odd</p></marquee>'
    );
    expect(blocks.map(textOf)).toEqual(['Quoted', 'Odd']);
  });

  it('survives malformed markup rather than throwing', () => {
    const { blocks } = parseHtmlBlocks('<p>Open <strong>bold</p></em><p>Next</p>');
    expect(blocks.map(textOf)).toEqual(['Open bold', 'Next']);
  });

  it('drops Word’s empty spacer paragraphs but keeps a <br /> as a hard break', () => {
    const { blocks } = parseHtmlBlocks('<p></p><p>One<br />Two</p><p>   </p>');
    expect(blocks).toHaveLength(1);
    const paragraph = blocks[0];
    if (paragraph.kind !== 'paragraph') throw new Error('expected a paragraph');
    expect(paragraph.runs.map(run => run.text).join('')).toBe('One\nTwo');
  });

  it('merges adjacent runs that share a style and trims the outer edges', () => {
    expect(
      normalizeRuns([
        { text: '  Hello ', bold: false, italic: false },
        { text: 'world', bold: false, italic: false },
        { text: '!', bold: true, italic: false },
        { text: '   ', bold: true, italic: false }
      ])
    ).toEqual([
      { text: 'Hello world', bold: false, italic: false },
      { text: '!', bold: true, italic: false }
    ]);
  });
});

describe('CNV-09 — the mandatory-preview gate', () => {
  const result = () => ({
    bytes: new Uint8Array([1, 2, 3]),
    pageCount: 1,
    imageCount: 0,
    outline: [],
    notes: [],
    warnings: [],
    hadUnsupportedCharacters: false
  });

  /** A distinct `File` each time, so identity is a real signal in these tests. */
  const docxFile = (name = 'report.docx') =>
    new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], name);

  it('starts closed, opens only on a preview, and closes again on reset', async () => {
    const state = await import('../../src/ui/tools/convert/word-to-pdf-state');
    const { commitGate } = await import('../../src/ui/tools/commit-gate');

    // Before a file has even been chosen the reason is the more specific one.
    state.setWordToPdfSource(null);
    expect(commitGate('word-to-pdf')).toBe(state.WORD_TO_PDF_NO_FILE_GATE);

    const file = docxFile();
    state.setWordToPdfSource(file);
    expect(commitGate('word-to-pdf')).toBe(state.WORD_TO_PDF_GATE);

    state.setWordToPdfPreview(result(), file, state.wordToPdfInputRevision.value);
    expect(commitGate('word-to-pdf')).toBeNull();
    expect(state.wordToPdfPreviewIsStale()).toBe(false);

    state.resetWordToPdfPreview();
    expect(commitGate('word-to-pdf')).toBe(state.WORD_TO_PDF_GATE);
    state.setWordToPdfSource(null);
  });

  it('closes when a different file is chosen, even one with the same name', async () => {
    const state = await import('../../src/ui/tools/convert/word-to-pdf-state');
    const { commitGate } = await import('../../src/ui/tools/commit-gate');

    const first = docxFile('quarterly.docx');
    state.setWordToPdfSource(first);
    state.setWordToPdfPreview(result(), first, state.wordToPdfInputRevision.value);
    expect(commitGate('word-to-pdf')).toBeNull();

    // Same *name*, different file. A name-keyed gate would have stayed open over
    // the previous document's bytes — the shape of CNV-08's audit finding 4.
    state.setWordToPdfSource(docxFile('quarterly.docx'));
    expect(state.wordToPdfPreviewIsStale()).toBe(true);
    expect(commitGate('word-to-pdf')).toBe(state.WORD_TO_PDF_GATE);
    state.setWordToPdfSource(null);
  });

  it('closes when an option changes after a preview', async () => {
    const state = await import('../../src/ui/tools/convert/word-to-pdf-state');
    const { commitGate } = await import('../../src/ui/tools/commit-gate');

    const file = docxFile();
    state.setWordToPdfSource(file);
    state.setWordToPdfPreview(result(), file, state.wordToPdfInputRevision.value);
    expect(commitGate('word-to-pdf')).toBeNull();

    state.setWordToPdfOptions({ pageSize: 'letter' });
    expect(state.wordToPdfPreviewIsStale()).toBe(true);
    expect(commitGate('word-to-pdf')).toBe(state.WORD_TO_PDF_GATE);
    state.setWordToPdfOptions({ pageSize: 'a4' });
    state.setWordToPdfSource(null);
  });

  it('refuses a result that finished after its own input changed', async () => {
    // The race the revision counter exists for, and the only path where clearing
    // the preview on change is *not* enough on its own: the panel captures the
    // revision before reading the bytes, the user changes the page size while the
    // conversion is still running, and the late result then tries to install
    // itself. Without the revision comparison the gate would open over a PDF laid
    // out for the page size the user just moved away from.
    const state = await import('../../src/ui/tools/convert/word-to-pdf-state');
    const { commitGate } = await import('../../src/ui/tools/commit-gate');

    const file = docxFile();
    state.setWordToPdfSource(file);
    const captured = state.wordToPdfInputRevision.value;

    // …conversion running… and the user changes an option mid-flight.
    state.setWordToPdfOptions({ pageSize: 'letter' });

    // …then the in-flight conversion returns and installs its result.
    state.setWordToPdfPreview(result(), file, captured);

    expect(state.wordToPdfPreviewIsStale()).toBe(true);
    expect(commitGate('word-to-pdf')).toBe(state.WORD_TO_PDF_GATE);

    state.setWordToPdfOptions({ pageSize: 'a4' });
    state.setWordToPdfSource(null);
  });

  it('treats a preview with no recorded revision as stale rather than valid', async () => {
    const state = await import('../../src/ui/tools/convert/word-to-pdf-state');
    const file = docxFile();
    state.setWordToPdfSource(file);
    state.setWordToPdfPreview(result(), file);
    expect(state.wordToPdfPreviewRevision.value).toBeNull();
    expect(state.wordToPdfPreviewIsStale()).toBe(true);
    state.setWordToPdfSource(null);
  });

  it('gates only its own tool', async () => {
    const state = await import('../../src/ui/tools/convert/word-to-pdf-state');
    const { commitGate } = await import('../../src/ui/tools/commit-gate');
    state.setWordToPdfSource(null);
    expect(commitGate('word-to-pdf')).toBe(state.WORD_TO_PDF_NO_FILE_GATE);
    expect(commitGate('merge')).toBeNull();
    expect(commitGate('md-to-pdf')).toBeNull();
  });
});
