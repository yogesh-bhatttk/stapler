/**
 * CNV-08 — PDF → Word (DOCX), graded against real output bytes.
 *
 * The acceptance criterion is a `.docx` that opens in Word/LibreOffice with all
 * text in reading order, the table intact as a real table and the image embedded,
 * "verified by re-parsing the output with `mammoth`". So the round-trip test
 * below runs the production pipeline end to end — the same `formattedRuns`,
 * `pageBlocks`, `attachImageBlocks` and `buildDocx` the render/process/convert
 * workers call — over a real PDF built by `pdfToWordPdf()`, then reads the
 * produced file back two independent ways:
 *
 *  • **`mammoth`**, which parses `word/document.xml` and yields semantic HTML.
 *    `<h1>`/`<h2>`, `<strong>`/`<em>`, a real `<table>` and an `<img>` in the
 *    output are evidence about the DOCX's structure, not about its appearance.
 *  • **`fflate`**, unzipping the OPC package directly, so the image is asserted
 *    to be a real part in `word/media/` with a relationship pointing at it —
 *    something a converter could fake in the HTML but not in the package.
 *
 * pdf.js runs here through its `legacy` build, the same way the other unit tests
 * that need a real parse do (`redact-patterns.test.ts`). What it is *not* doing is
 * spawning the workers: `vi.mock('comlink')` makes `render.worker.ts` and
 * `process.worker.ts` importable in Node (both call `Comlink.expose` at import
 * time), and `vi.mock('../../src/core/workers')` leases the three **real** worker
 * implementations in place of the three real Workers. So the function under test
 * is `operations.convertPdfToDocx` itself — its own sequencing, its own progress
 * bands, and both of its refusal branches — not a re-implementation of it. An
 * earlier version of this file hand-rolled the render → build sequence, which
 * meant the exported function had no direct coverage at all and neither refusal
 * was ever executed.
 *
 * What this file cannot prove is in the ticket's Status line: nothing here opens
 * Microsoft Word. Nor does it prove the image archive is *transferred* rather
 * than cloned — Comlink is stubbed here, so that claim is measured against real
 * `postMessage` behaviour in `pdf-to-word-transfer.test.ts` instead.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { strFromU8, unzipSync } from 'fflate';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { PDF_TO_WORD, pdfToWordPdf } from '../e2e/fixtures';
import { formattedRuns, fontStyle } from '../../src/core/convert/pdf-runs';
import {
  attachImageBlocks,
  fitImage,
  lineRuns,
  pageBlocks,
  type DocxPage
} from '../../src/core/convert/blocks';
import { buildDocx } from '../../src/core/convert/docx-writer';
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
let buildDocxCalls = 0;

vi.mock('../../src/core/workers', async () => {
  const { renderWorkerImpl } = await import('../../src/core/workers/render.worker');
  const { processWorkerImpl } = await import('../../src/core/workers/process.worker');
  const { convertWorkerImpl } = await import('../../src/core/workers/convert.worker');
  type Bytes = Uint8Array;

  // `.slice()` stands in for the structured clone the real Comlink boundary
  // performs. Without it the two passes fight over one buffer: pdf.js takes
  // ownership of (and detaches) what `loadDocument` is given, so the image pass
  // that follows would receive a zero-length array — an artefact of calling the
  // implementations in-process, not of the code under test.
  const renderApi = {
    loadDocument: (bytes: Bytes, password?: string) =>
      renderWorkerImpl.loadDocument(bytes.slice(), password),
    extractPageBlocks: (handle: string, pageIndex: number) =>
      renderWorkerImpl.extractPageBlocks(handle, pageIndex),
    closeDocument: (handle: string) => renderWorkerImpl.closeDocument(handle)
  };
  const processApi = {
    extractImages: (bytes: Bytes, pageIndices: number[]) =>
      processWorkerImpl.extractImages(bytes.slice(), pageIndices)
  };
  const convertApi = {
    buildDocx: (...args: Parameters<typeof convertWorkerImpl.buildDocx>) => {
      buildDocxCalls++;
      return convertWorkerImpl.buildDocx(...args);
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
    processWorker: { lease: leaseOn(processApi) },
    cvWorker: { lease: leaseOn({}) },
    ocrWorker: { lease: leaseOn({}) },
    convertWorker: { lease: leaseOn(convertApi) }
  };
});

const { convertPdfToDocx } = await import('../../src/core/operations');

type PdfjsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let pdfjsCache: PdfjsModule | undefined;
async function pdfjs(): Promise<PdfjsModule> {
  pdfjsCache ??= await import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsCache;
}

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(`tests/fixtures/${name}`));
}

/**
 * The production entry point, nothing else. `includeImages` is the tool's own
 * option, and the result is exactly what `PdfToWordPanel` holds and `commit.ts`
 * writes to disk.
 */
async function convert(
  bytes: Uint8Array,
  { includeImages = true, documentName }: { includeImages?: boolean; documentName?: string } = {}
): Promise<{
  docx: Uint8Array;
  pageCount: number;
  skipped: string[];
  imageCount: number;
  outline: Awaited<ReturnType<typeof convertPdfToDocx>>['outline'];
  progress: number[];
}> {
  const progress: number[] = [];
  const result = await convertPdfToDocx(
    bytes,
    { includeImages, documentName },
    { onProgress: fraction => progress.push(fraction) }
  );
  return {
    docx: result.bytes,
    pageCount: result.pageCount,
    skipped: result.skipped,
    imageCount: result.imageCount,
    outline: result.outline,
    progress
  };
}

async function toHtml(docx: Uint8Array): Promise<{ value: string; messages: unknown[] }> {
  const mammoth = await import('mammoth');
  const result = await mammoth.convertToHtml({ buffer: Buffer.from(docx) });
  return { value: result.value, messages: result.messages };
}

describe('CNV-08 — PDF to DOCX round trip', () => {
  it('produces a .docx whose text, table and image survive a mammoth re-parse', async () => {
    const { docx, skipped, imageCount } = await convert(await pdfToWordPdf());
    const { value: html, messages } = await toHtml(docx);

    // mammoth reports every construct it could not make sense of. An empty list
    // is the strongest single statement that the package is well-formed.
    expect(messages).toEqual([]);

    // --- all text present, in reading order -------------------------------
    const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
    const expectedOrder = [
      PDF_TO_WORD.h1,
      PDF_TO_WORD.paragraph.join(' '),
      PDF_TO_WORD.h2,
      'Revenue rose',
      PDF_TO_WORD.boldRun,
      PDF_TO_WORD.italicRun,
      ...PDF_TO_WORD.table.flat(),
      PDF_TO_WORD.appendixH2,
      PDF_TO_WORD.appendixParagraph.join(' ')
    ];
    let cursor = -1;
    for (const fragment of expectedOrder) {
      const at = text.indexOf(fragment, cursor + 1);
      expect(at, `"${fragment}" is present after everything before it`).toBeGreaterThan(cursor);
      cursor = at;
    }

    // --- headings, by the font-size heuristic -----------------------------
    // 22pt over an 11pt body clears the level-1 ratio; 14pt clears promotion only.
    expect(html).toContain(`<h1>`);
    expect(html.match(/<h1>.*?<\/h1>/)?.[0]).toContain(PDF_TO_WORD.h1);
    const h2s = [...html.matchAll(/<h2>(.*?)<\/h2>/g)].map(m => m[1].replace(/<[^>]*>/g, ''));
    expect(h2s).toEqual([PDF_TO_WORD.h2, PDF_TO_WORD.appendixH2]);

    // --- bold / italic runs, from the font descriptors --------------------
    // The trailing space belongs to the emphasised run because pdf.js attaches
    // the inter-run space to the font that drew it; `.trim()` is about that, not
    // about a missing word.
    const strong = [...html.matchAll(/<strong>(.*?)<\/strong>/g)].map(m => m[1].trim());
    const em = [...html.matchAll(/<em>(.*?)<\/em>/g)].map(m => m[1].trim());
    expect(strong).toContain(PDF_TO_WORD.boldRun);
    expect(em).toEqual([PDF_TO_WORD.italicRun]);

    // --- the table is a real table ----------------------------------------
    const tables = [...html.matchAll(/<table>([\s\S]*?)<\/table>/g)];
    expect(tables).toHaveLength(1);
    const grid = [...tables[0][1].matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(row =>
      [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(cell =>
        cell[1].replace(/<[^>]*>/g, '').trim()
      )
    );
    expect(grid).toEqual(PDF_TO_WORD.table.map(row => [...row]));

    // --- the image is embedded --------------------------------------------
    expect(imageCount).toBe(1);
    expect(skipped).toEqual([]);
    expect(html).toMatch(/<img[^>]+src="data:image\/png;base64,/);

    // …and it is a real part of the OPC package, not only a data URI mammoth
    // produced. A relationship without a part, or a part nothing references, is
    // the shape of a file Word offers to repair.
    const parts = unzipSync(docx);
    // `endsWith('/')` filters the ZIP's own directory entry for `word/media/`.
    const media = Object.keys(parts).filter(
      name => name.startsWith('word/media/') && !name.endsWith('/')
    );
    expect(media).toHaveLength(1);
    expect(parts[media[0]].length).toBeGreaterThan(1000);
    // PNG signature: CNV-06 hands over the image without re-encoding it.
    expect([...parts[media[0]].subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    const rels = strFromU8(parts['word/_rels/document.xml.rels']);
    expect(rels).toContain(media[0].replace('word/', ''));
  }, 120_000);

  it('keeps both source pages in one document, with a page break between them', async () => {
    const { docx, pageCount } = await convert(await pdfToWordPdf());
    expect(pageCount).toBe(2);

    const body = strFromU8(unzipSync(docx)['word/document.xml']);
    // Exactly one break, and it precedes page 2's heading rather than sitting at
    // the top of the document.
    expect([...body.matchAll(/<w:pageBreakBefore\s*\/>/g)]).toHaveLength(1);
    const breakAt = body.indexOf('<w:pageBreakBefore');
    expect(body.indexOf(PDF_TO_WORD.appendixH2)).toBeGreaterThan(breakAt);
    expect(body.indexOf(PDF_TO_WORD.h1)).toBeLessThan(breakAt);
  }, 120_000);

  it('titles the .docx from the documentName option, not from whatever document happens to be active', async () => {
    // A regression test for a real bug: the title used to come from a live
    // `activeDoc` signal read partway through this (multi-await) function, so
    // switching tabs mid-conversion could title the output after a *different*
    // document than the one whose bytes were actually converted. It must now
    // come from the caller-supplied option alone.
    const { docx } = await convert(await pdfToWordPdf(), { documentName: 'quarterly-report.pdf' });
    const core = strFromU8(unzipSync(docx)['docProps/core.xml']);
    expect(core).toContain('<dc:title>quarterly-report.pdf</dc:title>');
  }, 120_000);

  it('falls back to a generic title when no documentName is given', async () => {
    const { docx } = await convert(await pdfToWordPdf());
    const core = strFromU8(unzipSync(docx)['docProps/core.xml']);
    expect(core).toContain('<dc:title>Converted document</dc:title>');
  }, 120_000);

  it('leaves images out on request, and says nothing was skipped for that', async () => {
    const { docx, imageCount, skipped } = await convert(await pdfToWordPdf(), {
      includeImages: false
    });
    expect(imageCount).toBe(0);
    expect(skipped).toEqual([]);
    expect(
      Object.keys(unzipSync(docx)).some(
        name => name.startsWith('word/media/') && !name.endsWith('/')
      )
    ).toBe(false);

    // Turning images off must not cost any text.
    const { value: html } = await toHtml(docx);
    expect(html).toContain(PDF_TO_WORD.appendixH2);
    expect(html).toContain('<table>');
  }, 120_000);

  it('reports determinate, monotonic progress across all three passes', async () => {
    // Not decoration: this is the evidence that the *real* `convertPdfToDocx`
    // ran its own sequence rather than a test helper standing in for it — the
    // text band (0..0.6), the image band (0.6..0.75) and the writer's band
    // (0.75..1) are its bands, defined nowhere else.
    const { progress } = await convert(await pdfToWordPdf());
    expect(progress.length).toBeGreaterThan(2);
    for (const fraction of progress) {
      expect(fraction).toBeGreaterThanOrEqual(0);
      expect(fraction).toBeLessThanOrEqual(1);
    }
    expect([...progress].sort((a, b) => a - b)).toEqual(progress);
    // The image pass is reached, so the 0.6 boundary is actually crossed.
    expect(progress.some(fraction => fraction >= 0.6)).toBe(true);
  }, 120_000);

  it('describes the output for the mandatory preview, in output order', async () => {
    // The outline comes back *from the writer*, derived from the model the file
    // was written from — not recomputed here from something else.
    const { outline } = await convert(await pdfToWordPdf());

    expect(outline.map(item => `${item.pageIndex}:${item.kind}`)).toEqual([
      '0:heading',
      '0:paragraph',
      '0:heading',
      '0:paragraph',
      '0:table',
      '1:heading',
      '1:paragraph',
      '1:image'
    ]);
    expect(outline[0].level).toBe(1);
    expect(outline[2].level).toBe(2);
    // The preview shows the table's shape and its header row, because a
    // mis-clustered table is visibly wrong there.
    expect(outline[4].text).toContain('4 rows × 3 columns');
    expect(outline[4].text).toContain('Region | Revenue | Change');
    expect(outline[7].text).toMatch(/^Image, \d+ × \d+ px/);
  }, 120_000);
});

describe('CNV-08 — unsupported input is refused, not half-converted', () => {
  it('refuses an XFA form from `convertPdfToDocx` itself, before any docx work', async () => {
    buildDocxCalls = 0;
    const bytes = fixture('xfa.pdf');
    // The marker is what the refusal is decided on…
    expect(hasXfaMarker(bytes)).toBe(true);
    // …and the whole function refuses on it, with the XFA-specific message
    // rather than the compose one.
    const failure = await convertPdfToDocx(bytes, { includeImages: true }).then(
      () => null,
      (err: unknown) => err
    );
    expect(failure).toBeInstanceOf(StaplerError);
    expect((failure as StaplerError).kind).toBe('UnsupportedFeature');
    expect((failure as StaplerError).message).toBe(XFA_CONVERT_MESSAGE);
    // Nothing was written, and nothing was even attempted: no `.docx` exists to
    // be half-saved.
    expect(buildDocxCalls).toBe(0);

    // …and the fixture the conversion is meant to accept is not a false positive.
    expect(hasXfaMarker(await pdfToWordPdf())).toBe(false);
  }, 60_000);

  it('refuses an encrypted document from `convertPdfToDocx` itself', async () => {
    buildDocxCalls = 0;
    const failure = await convertPdfToDocx(fixture('encrypted.pdf'), {
      includeImages: true
    }).then(
      () => null,
      (err: unknown) => err
    );
    // `loadDocument` maps pdf.js's `PasswordException` to this, and the refusal
    // is the whole function's, reached before its first page.
    expect(failure).toBeInstanceOf(StaplerError);
    expect((failure as StaplerError).kind).toBe('Encrypted');
    expect(buildDocxCalls).toBe(0);
  }, 60_000);

  it('confirms the underlying pdf.js throw the encrypted refusal is built on', async () => {
    const lib = await pdfjs();
    await expect(
      lib.getDocument({ data: fixture('encrypted.pdf') }).promise
    ).rejects.toBeInstanceOf(lib.PasswordException);
  }, 60_000);

  it('refuses to write an empty document rather than one that will not open', async () => {
    await expect(buildDocx({ title: 'empty.pdf', pages: [], skipped: [] })).rejects.toThrow(
      /no text or images/
    );
  });

  it('reports a JPEG 2000 image as unconvertible instead of embedding garbage', () => {
    const pages: DocxPage[] = [{ pageIndex: 0, blocks: [] }];
    const skipped: string[] = [];
    const count = attachImageBlocks(
      pages,
      [
        {
          pageIndex: 0,
          position: 1,
          name: 'Im1',
          objectNumber: 7,
          width: 100,
          height: 50,
          fileName: 'page-001-image-01.jp2',
          byteLength: 10,
          status: 'extracted'
        }
      ],
      { 'page-001-image-01.jp2': new Uint8Array(10) },
      skipped
    );
    expect(count).toBe(0);
    expect(pages[0].blocks).toEqual([]);
    expect(skipped[0]).toContain('jp2');
    expect(skipped[0]).toContain('the PDF still has it');
  });

  it("passes CNV-06's own skip reason through instead of dropping the image quietly", () => {
    const pages: DocxPage[] = [{ pageIndex: 2, blocks: [] }];
    const skipped: string[] = [];
    attachImageBlocks(
      pages,
      [
        {
          pageIndex: 2,
          position: 1,
          name: 'Im1',
          objectNumber: 9,
          width: 8,
          height: 8,
          byteLength: 0,
          status: 'skipped',
          note: 'JBIG2 data is an embedded segment sequence.'
        }
      ],
      {},
      skipped
    );
    expect(skipped).toEqual(['Page 3: JBIG2 data is an embedded segment sequence.']);
  });
});

describe('CNV-08 — the block heuristics', () => {
  /** A pdf.js-shaped run. PDF space, so a larger `y` is higher on the page. */
  function run(
    str: string,
    x: number,
    y: number,
    size = 11,
    width = str.length * size * 0.5,
    style: { bold?: boolean; italic?: boolean } = {}
  ) {
    return { str, transform: [size, 0, 0, size, x, y], width, height: size, ...style };
  }

  it('does not read a justified paragraph as a two-column table', () => {
    // Word spaces stretched to a full type size — wider than any real space, and
    // still an order of magnitude short of a column gap.
    const lines = [700, 686, 672, 658].flatMap(y => [
      run('The claimant', 56, y, 11, 60),
      run('states that', 127, y, 11, 55),
      run('the vehicle', 193, y, 11, 55)
    ]);
    const blocks = pageBlocks(lines, 792);
    expect(blocks.map(block => block.kind)).toEqual(['paragraph']);
  });

  it('reads a two-row three-column grid as a table', () => {
    const blocks = pageBlocks(
      [
        ...['Region', 'Revenue', 'Change'].map((cell, i) => run(cell, [56, 250, 420][i], 540)),
        ...['North', '1204', '8'].map((cell, i) => run(cell, [56, 250, 420][i], 520))
      ],
      792
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('table');
    if (blocks[0].kind === 'table') {
      expect(blocks[0].rows).toEqual([
        ['Region', 'Revenue', 'Change'],
        ['North', '1204', '8']
      ]);
    }
  });

  it('needs two rows: one wide-gapped line on its own stays a paragraph', () => {
    const blocks = pageBlocks(
      [run('Invoice', 56, 540), run('2024-11-03', 420, 540), run('Body text follows.', 56, 500)],
      792
    );
    expect(blocks.every(block => block.kind === 'paragraph')).toBe(true);
  });

  it('never starts a table on a heading line', () => {
    // A centred title whose two words are far apart: tabular by gap alone, but a
    // heading, so excluded — otherwise it would swallow the body under it.
    const blocks = pageBlocks(
      [
        run('ANNUAL', 150, 700, 24, 90),
        run('REPORT', 330, 700, 24, 90),
        run('SECOND', 150, 660, 24, 90),
        run('LINE', 330, 660, 24, 90),
        run('Body text at the body size, repeated so 11pt wins the page.', 56, 600),
        run('More body text at the body size, to settle the dominant size.', 56, 586)
      ],
      792
    );
    expect(blocks.filter(block => block.kind === 'table')).toHaveLength(0);
    expect(blocks.filter(block => block.kind === 'heading')).toHaveLength(2);
  });

  it('merges adjacent runs of the same format and keeps the emphasis boundary', () => {
    // No whitespace items here, so the space each gap implies is reinstated on
    // the *following* run — the same rule `layoutText` applies. (Against a real
    // pdf.js parse the standalone whitespace item usually arrives first and gets
    // merged into the preceding run instead; either way the joined line reads the
    // same, which is what the round-trip test above asserts.)
    const runs = [
      run('Revenue rose', 56, 580, 11, 68),
      run('12 percent', 127, 580, 11, 55, { bold: true }),
      run('against', 185, 580, 11, 40)
    ];
    const built = lineRuns(runs);
    expect(built).toEqual([
      { text: 'Revenue rose', bold: false, italic: false },
      { text: ' 12 percent', bold: true, italic: false },
      { text: ' against', bold: false, italic: false }
    ]);
    expect(built.map(r => r.text).join('')).toBe('Revenue rose 12 percent against');
  });

  it('reports no emphasis rather than guessing when the font is unknown', () => {
    expect(fontStyle(null)).toEqual({ bold: false, italic: false });
    expect(fontStyle({})).toEqual({ bold: false, italic: false });
  });

  it('reads weight and slant out of a /BaseFont name, embedded or not', () => {
    // pdf.js only sets its own `bold`/`italic` for non-embedded fonts, so the name
    // has to carry the answer for the embedded, subset-prefixed case.
    expect(fontStyle({ name: 'AAAAAA+Arial-BoldMT' })).toEqual({ bold: true, italic: false });
    expect(fontStyle({ name: 'TimesNewRoman,BoldItalic' })).toEqual({ bold: true, italic: true });
    expect(fontStyle({ name: 'Helvetica-Oblique' })).toEqual({ bold: false, italic: true });
    expect(fontStyle({ name: 'Helvetica' })).toEqual({ bold: false, italic: false });
    // And pdf.js's own flag still wins when the name says nothing.
    expect(fontStyle({ name: 'CustomFace', bold: true })).toEqual({ bold: true, italic: false });
  });

  it('fits an oversized image to the text column and never scales one up', () => {
    expect(fitImage(2000, 1000)).toEqual({ width: 624, height: 312 });
    expect(fitImage(64, 64)).toEqual({ width: 64, height: 64 });
    expect(fitImage(0, 10)).toBeNull();
  });

  it("shares CNV-04's line grouping — the same lines drive both exports", async () => {
    // Not a re-test of `layoutText`: the point is that the DOCX path reads the
    // same `layoutLines` output, so a paragraph break cannot be in one export and
    // not the other.
    const runs = [
      run('Heading here', 56, 700, 22, 140),
      run('Body line one.', 56, 660),
      run('Body line two.', 56, 646)
    ];
    const { lines } = layoutLines(runs);
    expect(lines.map(line => line.isHeading)).toEqual([true, false, false]);
    expect(lines.map(line => line.startsParagraph)).toEqual([false, true, false]);

    const blocks = pageBlocks(runs, 792);
    expect(blocks.map(block => block.kind)).toEqual(['heading', 'paragraph']);
  });

  it('writes a padded row rather than a short one when a table row is ragged', async () => {
    const docx = await buildDocx({
      title: 'ragged.pdf',
      pages: [
        {
          pageIndex: 0,
          blocks: [
            {
              kind: 'table',
              rows: [
                ['a', 'b', 'c'],
                ['d', 'e']
              ]
            }
          ]
        }
      ],
      skipped: []
    });
    const body = strFromU8(unzipSync(docx)['word/document.xml']);
    const rows = [...body.matchAll(/<w:tr>([\s\S]*?)<\/w:tr>/g)];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect([...row[1].matchAll(/<w:tc>/g)]).toHaveLength(3);
    }
    const { messages } = await toHtml(docx);
    expect(messages).toEqual([]);
  }, 60_000);

  it('extracts nothing but reports nothing wrong for a page with no text', async () => {
    // An image-only page: the text pass yields no blocks, which must not throw.
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    const bytes = await doc.save();
    const lib = await pdfjs();
    const parsed = await lib.getDocument({ data: bytes }).promise;
    const page = await parsed.getPage(1);
    expect(pageBlocks(await formattedRuns(page), 200)).toEqual([]);
  }, 60_000);

  it('keeps the whole document when a page has only a heading', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([612, 792]);
    page.drawText('Only a line', { x: 56, y: 700, size: 11, font });
    const { docx } = await convert(await doc.save(), { includeImages: false });
    const { value: html, messages } = await toHtml(docx);
    expect(messages).toEqual([]);
    expect(html).toContain('Only a line');
  }, 60_000);
});

/**
 * The gate itself (PLAN §5.5). The action bar disables its primary CTA whenever
 * `commitGate(toolId)` is non-null, and `commit.ts`'s `pdf-to-word` handler
 * refuses again if it is reached anyway — so this state machine is the gating
 * logic, not a decoration around it.
 */
describe('CNV-08 — the mandatory-preview gate', () => {
  it('starts closed, opens only on a preview, and closes again on reset', async () => {
    const { commitGate } = await import('../../src/ui/tools/commit-gate');
    const state = await import('../../src/ui/tools/convert/pdf-to-word-state');

    // Importing the panel's state module is what arms the gate, so the save
    // action is blocked before the panel has ever been mounted.
    expect(commitGate('pdf-to-word')).toBe(state.PDF_TO_WORD_GATE);
    expect(state.pdfToWordPreview.value).toBeNull();

    const result = {
      bytes: new Uint8Array([1, 2, 3]),
      pageCount: 2,
      imageCount: 1,
      outline: [],
      skipped: []
    };
    state.setPdfToWordPreview(result, 'doc-1');
    expect(commitGate('pdf-to-word')).toBeNull();
    expect(state.pdfToWordPreviewDocId.value).toBe('doc-1');

    // Changing an option, or switching document, must re-close it: the previewed
    // bytes are no longer the file the panel is describing.
    state.resetPdfToWordPreview();
    expect(commitGate('pdf-to-word')).toBe(state.PDF_TO_WORD_GATE);
    expect(state.pdfToWordPreview.value).toBeNull();
    expect(state.pdfToWordPreviewDocId.value).toBeNull();
  });

  it('closes again when the document is edited, not only when it is switched', async () => {
    // The audit finding: the gate keyed on the document *id* alone, so deleting
    // or rotating a page in another tool left the previewed (pre-edit) bytes
    // marked valid and Save would have written them. `historyVersion` is the
    // signal every store mutator already bumps, via `commit()`.
    const state = await import('../../src/ui/tools/convert/pdf-to-word-state');
    const { commitGate } = await import('../../src/ui/tools/commit-gate');
    const { historyVersion } = await import('../../src/core/history');
    const store = await import('../../src/core/store');

    const pageKey = 'page-1';
    const doc = {
      id: 'doc-edit',
      name: 'edited.pdf',
      pages: [{ key: pageKey, sourceDocId: 'src-1', sourceIndex: 0, rotation: 0 }],
      annotations: [],
      dirty: false
    };
    store.documents.value = [doc];
    store.activeDocId.value = doc.id;

    const result = {
      bytes: new Uint8Array([1, 2, 3]),
      pageCount: 1,
      imageCount: 0,
      outline: [],
      skipped: []
    };
    state.setPdfToWordPreview(result, doc.id, historyVersion.value);
    expect(commitGate('pdf-to-word')).toBeNull();
    expect(state.pdfToWordPreviewIsStale(doc.id)).toBe(false);

    // A real mutation through the real store mutator — not a hand-incremented
    // counter.
    const before = historyVersion.value;
    store.rotatePages(doc.id, [pageKey], 90);
    expect(historyVersion.value).not.toBe(before);
    expect(store.documents.value[0].pages[0].rotation).toBe(90);

    // Same document, same id — and the preview is stale, so the panel's effect
    // drops it and `commit.ts` refuses even if the disabled button is bypassed.
    expect(state.pdfToWordPreviewIsStale(doc.id)).toBe(true);
    state.resetPdfToWordPreview();
    expect(commitGate('pdf-to-word')).toBe(state.PDF_TO_WORD_GATE);
    expect(state.pdfToWordPreview.value).toBeNull();

    // A preview taken *after* the edit is fresh again, so the invalidation is not
    // a permanent lock.
    state.setPdfToWordPreview(result, doc.id, historyVersion.value);
    expect(state.pdfToWordPreviewIsStale(doc.id)).toBe(false);

    // An undo is a change too: the document it describes is the pre-rotation one.
    const history = await import('../../src/core/history');
    history.undo();
    expect(state.pdfToWordPreviewIsStale(doc.id)).toBe(true);

    state.resetPdfToWordPreview();
    store.documents.value = [];
    store.activeDocId.value = null;
  });

  it('treats a preview with no recorded revision as stale rather than valid', async () => {
    // The safe side of a caller that forgets to record one.
    const state = await import('../../src/ui/tools/convert/pdf-to-word-state');
    state.setPdfToWordPreview(
      { bytes: new Uint8Array([1]), pageCount: 1, imageCount: 0, outline: [], skipped: [] },
      'doc-x'
    );
    expect(state.pdfToWordPreviewRevision.value).toBeNull();
    expect(state.pdfToWordPreviewIsStale('doc-x')).toBe(true);
    state.resetPdfToWordPreview();
  });

  it('gates one tool without gating any other', async () => {
    const { commitGate, setCommitGate } = await import('../../src/ui/tools/commit-gate');
    setCommitGate('pdf-to-word', 'blocked');
    expect(commitGate('pdf-to-word')).toBe('blocked');
    expect(commitGate('merge')).toBeNull();
    expect(commitGate('compress')).toBeNull();
    setCommitGate('pdf-to-word', null);
    expect(commitGate('pdf-to-word')).toBeNull();
  });
});
