/**
 * QA-02 — golden-file coverage for the P0 document operations.
 *
 * Each test drives the real operation (through `core/store.ts` where the
 * operation is a store mutation, then through the same `process.worker.ts`
 * compose path the app actually exports through) and re-parses the output
 * bytes, asserting page count, order, and text content — never a byte-exact
 * snapshot, which would be recreating the "vacuous assertion" problem Chunk 3
 * already fixed elsewhere, just with a snapshot file instead of a weak
 * assertion.
 *
 * PDF → images, PDF → text/Markdown, and both compress routes are not here:
 * they decode or rasterise through pdf.js, which needs a real browser
 * (OffscreenCanvas, a Worker-hosted decoder) that this Node/vitest
 * environment does not provide. Those are covered end to end in
 * `tests/e2e/tool-flows.spec.ts` instead, which is the layer that can
 * actually exercise them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { unzipSync } from 'fflate';

vi.mock('comlink', () => ({
  expose: vi.fn(),
  transfer: vi.fn(val => val)
}));

import { processWorkerImpl } from '../../src/core/workers/process.worker';
import { silentJob } from '../../src/core/workers/protocol';
import {
  activeDocId,
  addDocument,
  appendPages,
  bytesForPages,
  deletePages,
  documents,
  duplicatePages,
  insertPages,
  makePageRefs,
  movePages,
  registerSource,
  rotatePages,
  selectedPageKeys,
  sources,
  type StaplerDoc
} from '../../src/core/store';
import { resetHistory } from '../../src/core/history';

/** Every page's visible text, in document order — enough to prove order and content. */
async function pageTexts(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes);
  const { decodeStream } = await import('../../src/core/pdf/interpreter');
  const { PDFName, PDFArray } = await import('pdf-lib');

  const texts: string[] = [];
  for (let i = 0; i < doc.getPageCount(); i++) {
    const page = doc.getPage(i);
    const contents = page.node.Contents();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pdf-lib's stream classes share no exported base type.
    const streams: any[] = !contents
      ? []
      : contents instanceof PDFArray
        ? contents.asArray().map(ref => doc.context.lookup(ref))
        : [contents];

    let text = '';
    for (const stream of streams) {
      const raw: Uint8Array = stream.getContents();
      const isFlate = String(stream.dict?.get(PDFName.of('Filter'))) === '/FlateDecode';
      text += new TextDecoder('latin1').decode(isFlate ? await decodeStream(raw) : raw);
    }
    // pdf-lib writes show-text operands as hex literals when the font is
    // embedded (`<...> Tj`); decode those too so a subsetted-font page still
    // matches a plain-text assertion.
    for (const match of text.matchAll(/<([0-9A-Fa-f\s]+)>/g)) {
      const hex = match[1].replace(/\s+/g, '');
      for (const width of [2, 4]) {
        if (hex.length % width !== 0) continue;
        let decoded = '';
        for (let i = 0; i < hex.length; i += width) {
          decoded += String.fromCharCode(parseInt(hex.slice(i, i + width), 16));
        }
        text += `\n${decoded}`;
      }
    }
    texts.push(text);
  }
  return texts;
}

function seedDoc(sourceId: string, pageCount: number, bytes: Uint8Array): StaplerDoc {
  registerSource({
    id: sourceId,
    name: `${sourceId}.pdf`,
    bytes,
    pageCount,
    pageSizes: Array.from({ length: pageCount }, () => ({ width: 595.28, height: 841.89 }))
  });
  const doc: StaplerDoc = {
    id: `${sourceId}-doc`,
    name: 'doc.pdf',
    pages: makePageRefs(sourceId, pageCount),
    annotations: [],
    dirty: false
  };
  addDocument(doc);
  return doc;
}

function currentDoc(docId: string): StaplerDoc {
  const doc = documents.value.find(d => d.id === docId);
  if (!doc) throw new Error(`Document ${docId} was not found`);
  return doc;
}

async function composeCurrent(doc: StaplerDoc): Promise<Uint8Array> {
  return processWorkerImpl.compose(
    doc.pages,
    bytesForPages(doc.pages),
    [],
    undefined,
    undefined,
    null,
    null,
    silentJob
  );
}

beforeEach(() => {
  documents.value = [];
  sources.value = {};
  activeDocId.value = null;
  selectedPageKeys.value = new Set();
  resetHistory();
});

describe('golden: OPS-01 merge', () => {
  it('concatenates two documents in order, keeping every page', async () => {
    const { textPdf } = await import('../e2e/fixtures');
    const a = seedDoc('merge-a', 2, await textPdf(2));
    appendPages(a.id, makePageRefs('merge-b', 3));
    registerSource({
      id: 'merge-b',
      name: 'merge-b.pdf',
      bytes: await textPdf(3),
      pageCount: 3,
      pageSizes: Array.from({ length: 3 }, () => ({ width: 595.28, height: 841.89 }))
    });

    const doc = currentDoc(a.id);
    expect(doc.pages).toHaveLength(5);

    const output = await composeCurrent(doc);
    const out = await PDFDocument.load(output);
    expect(out.getPageCount()).toBe(5);

    const texts = await pageTexts(output);
    // A's own numbering (1..2) followed by B's own numbering (1..3) is only
    // possible if the two documents landed in the order they were merged.
    expect(texts[0]).toContain('fixture page 1');
    expect(texts[1]).toContain('fixture page 2');
    expect(texts[2]).toContain('fixture page 1');
    expect(texts[3]).toContain('fixture page 2');
    expect(texts[4]).toContain('fixture page 3');
  });
});

describe('golden: OPS-02 organize (rotate, delete, duplicate, reorder)', () => {
  it('applies all four together and the export reflects the final arrangement', async () => {
    const { textPdf } = await import('../e2e/fixtures');
    const doc = seedDoc('organize', 4, await textPdf(4));
    const [p1, p2, p3, p4] = doc.pages;

    rotatePages(doc.id, [p1.key], 90);
    deletePages(doc.id, [p3.key]); // drop "page 3"
    duplicatePages(doc.id, [p2.key]); // "page 2" now appears twice
    movePages(doc.id, [p4.key], 0); // "page 4" moves to the front

    const after = currentDoc(doc.id);
    expect(after.pages).toHaveLength(4); // -1 delete, +1 duplicate

    const output = await composeCurrent(after);
    const out = await PDFDocument.load(output);
    expect(out.getPageCount()).toBe(4);

    const texts = await pageTexts(output);
    expect(texts[0]).toContain('fixture page 4');
    expect(texts[1]).toContain('fixture page 1');
    expect(texts[2]).toContain('fixture page 2');
    expect(texts[3]).toContain('fixture page 2');

    // The rotate survived being carried through delete/duplicate/reorder.
    expect(out.getPage(1).getRotation().angle).toBe(90);
    expect(out.getPage(0).getRotation().angle).toBe(0);
  });
});

describe('golden: OPS-04 insert pages from another document', () => {
  it('splices pages from a second source into the middle, keeping both intact', async () => {
    const { textPdf } = await import('../e2e/fixtures');
    const doc = seedDoc('insert-a', 3, await textPdf(3));
    registerSource({
      id: 'insert-b',
      name: 'insert-b.pdf',
      bytes: await textPdf(2),
      pageCount: 2,
      pageSizes: Array.from({ length: 2 }, () => ({ width: 595.28, height: 841.89 }))
    });

    insertPages(doc.id, makePageRefs('insert-b', 2), 1);

    const after = currentDoc(doc.id);
    expect(after.pages).toHaveLength(5);
    expect(after.pages.map(p => p.sourceDocId)).toEqual([
      'insert-a',
      'insert-b',
      'insert-b',
      'insert-a',
      'insert-a'
    ]);

    const output = await composeCurrent(after);
    const texts = await pageTexts(output);
    expect(texts[0]).toContain('fixture page 1');
    expect(texts[1]).toContain('fixture page 1');
    expect(texts[2]).toContain('fixture page 2');
    expect(texts[3]).toContain('fixture page 2');
    expect(texts[4]).toContain('fixture page 3');
  });
});

describe('golden: OPS-03 split and extract', () => {
  it('split cuts a document into the requested number of files, each with its own pages', async () => {
    const { textPdf } = await import('../e2e/fixtures');
    const bytes = await textPdf(6);
    const pages = Array.from({ length: 6 }, (_, i) => ({
      key: `p${i}`,
      sourceDocId: 'doc',
      sourceIndex: i,
      rotation: 0
    }));

    const result = await processWorkerImpl.composeSplit(
      pages,
      { doc: bytes },
      [2, 4],
      [],
      undefined,
      undefined,
      null,
      null,
      'split',
      silentJob
    );

    expect(result.isZip).toBe(true);
    expect(result.fileCount).toBe(3);
    const files = unzipSync(result.bytes);
    const names = Object.keys(files).sort();
    expect(names).toEqual(['split-01.pdf', 'split-02.pdf', 'split-03.pdf']);

    for (const [name, expectedPages] of [
      ['split-01.pdf', ['fixture page 1', 'fixture page 2']],
      ['split-02.pdf', ['fixture page 3', 'fixture page 4']],
      ['split-03.pdf', ['fixture page 5', 'fixture page 6']]
    ] as const) {
      const doc = await PDFDocument.load(files[name]);
      expect(doc.getPageCount()).toBe(2);
      const texts = await pageTexts(files[name]);
      expect(texts[0]).toContain(expectedPages[0]);
      expect(texts[1]).toContain(expectedPages[1]);
    }
  });

  it('extract keeps only the selected pages, in the order given', async () => {
    const { textPdf } = await import('../e2e/fixtures');
    const bytes = await textPdf(5);
    // Pages 4 and 2, deliberately out of numeric order.
    const pages = [
      { key: 'p3', sourceDocId: 'doc', sourceIndex: 3, rotation: 0 },
      { key: 'p1', sourceDocId: 'doc', sourceIndex: 1, rotation: 0 }
    ];

    const output = await processWorkerImpl.compose(
      pages,
      { doc: bytes },
      [],
      undefined,
      undefined,
      null,
      null,
      silentJob
    );

    const doc = await PDFDocument.load(output);
    expect(doc.getPageCount()).toBe(2);
    const texts = await pageTexts(output);
    expect(texts[0]).toContain('fixture page 4');
    expect(texts[1]).toContain('fixture page 2');
  });
});

describe('golden: CNV-01 images to PDF', () => {
  /**
   * `imagesToPdf` only needs pdf-lib's `embedJpg`, which reads the SOF0 marker
   * for width/height/component count and stores the rest of the buffer as the
   * DCTDecode stream verbatim (see `JpegEmbedder.for` — it never decodes the
   * scan data). So a structurally valid but not-really-decodable JPEG is
   * sufficient here: this test is about page count, order, and page size, not
   * pixel content, which is what a real canvas-encoded JPEG would be needed
   * to prove (already exercised by the e2e fixtures that draw through a real
   * canvas, e.g. `makePhotoJpeg` in `tests/e2e/tool-flows.spec.ts`).
   */
  function minimalJpeg(width: number, height: number): Uint8Array {
    return new Uint8Array([
      0xff,
      0xd8, // SOI
      0xff,
      0xc0, // SOF0
      0x00,
      0x11, // length (unchecked by the embedder)
      0x08, // bits per component
      (height >> 8) & 0xff,
      height & 0xff,
      (width >> 8) & 0xff,
      width & 0xff,
      0x03, // components (RGB)
      0x01,
      0x11,
      0x00,
      0x02,
      0x11,
      0x00,
      0x03,
      0x11,
      0x00,
      0xff,
      0xd9 // EOI
    ]);
  }

  it('makes one page per image, sized to match and in the given order', async () => {
    const sizes: [number, number][] = [
      [200, 100],
      [50, 300],
      [400, 400]
    ];
    const images = sizes.map(([w, h]) => minimalJpeg(w, h));

    const output = await processWorkerImpl.imagesToPdf(images, silentJob);
    const doc = await PDFDocument.load(output);
    expect(doc.getPageCount()).toBe(3);
    sizes.forEach(([w, h], i) => {
      const page = doc.getPage(i);
      expect(page.getWidth()).toBe(w);
      expect(page.getHeight()).toBe(h);
    });
  });
});

describe('golden: OPS-06 crop', () => {
  it('shrinks the exported page to the requested crop box', async () => {
    const { textPdf } = await import('../e2e/fixtures');
    const bytes = await textPdf(1);
    const pages = [
      {
        key: 'p0',
        sourceDocId: 'doc',
        sourceIndex: 0,
        rotation: 0,
        cropBox: { x: 0.1, y: 0.2, width: 0.5, height: 0.4 }
      }
    ];

    const output = await processWorkerImpl.compose(
      pages,
      { doc: bytes },
      [],
      undefined,
      undefined,
      null,
      null,
      silentJob
    );

    const doc = await PDFDocument.load(output);
    const page = doc.getPage(0);
    const crop = page.getCropBox();
    // Source page is 595.28x841.89pt; crop is normalised, top-left origin.
    expect(crop.width).toBeCloseTo(595.28 * 0.5, 0);
    expect(crop.height).toBeCloseTo(841.89 * 0.4, 0);
  });
});

describe('golden: OPS-09 normalize', () => {
  it('resizes every page to the requested target size', async () => {
    const { mixedSizePdf } = await import('../e2e/fixtures');
    const bytes = await mixedSizePdf();
    const source = await PDFDocument.load(bytes);
    const pageCount = source.getPageCount();
    const pages = Array.from({ length: pageCount }, (_, i) => ({
      key: `p${i}`,
      sourceDocId: 'doc',
      sourceIndex: i,
      rotation: 0
    }));

    const output = await processWorkerImpl.compose(
      pages,
      { doc: bytes },
      [],
      undefined,
      undefined,
      { targetSize: 'Letter' as const, scaleMode: 'fit' as const },
      null,
      silentJob
    );

    const doc = await PDFDocument.load(output);
    expect(doc.getPageCount()).toBe(pageCount);
    for (const page of doc.getPages()) {
      expect(page.getWidth()).toBeCloseTo(612, 0);
      expect(page.getHeight()).toBeCloseTo(792, 0);
    }
  });
});
