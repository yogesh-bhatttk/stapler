/**
 * Audit 2026-10-10 T4 — OPS-03 on a real 300-page document.
 *
 * `split.test.ts` proves `splitBoundaries` partitions 300 page *indices*; it
 * never splits a 300-page *file*. This runs the real `splitDocument` and the
 * real extract path (`composeDocument` over the selection, which is what
 * `commit.ts` calls in extract mode) through the in-process worker, unzips the
 * output, re-parses every part, and checks the page counts add up to 300 and
 * that each part's pages carry the right page text, in order.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFArray, PDFDocument, PDFName, type PDFRawStream } from 'pdf-lib';
import { unzipSync } from 'fflate';
import { inflateSync } from 'node:zlib';

vi.setConfig({ testTimeout: 180_000 });

vi.mock('comlink', () => ({
  expose: vi.fn(),
  transfer: vi.fn(value => value),
  proxy: vi.fn(value => value)
}));
vi.mock('../../src/core/workers', async () => {
  const { processWorkerImpl } = await import('../../src/core/workers/process.worker');
  // `any`: stands in for the pool's `Comlink.Remote<T>` wrapper.
  const run = (fn: (api: any) => unknown) => fn(processWorkerImpl);
  return { processWorker: { lease: run, pin: () => ({ lease: run, release: () => {} }) } };
});

const ops = await import('../../src/core/operations');
const store = await import('../../src/core/store');
const { resetHistory } = await import('../../src/core/history');
const { __memoryFallback } = await import('../../src/core/opfs');
const { textPdf } = await import('../e2e/fixtures');

const PAGES = 300;

/**
 * The 1-based number each page's heading carries ("Stapler fixture page N"),
 * read from the content streams the compose copied across. pdf-lib writes the
 * standard-font text as a hex literal, so both encodings are checked.
 */
async function pageNumbers(bytes: Uint8Array): Promise<number[]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map(page => {
    const contents = page.node.Contents();
    const streams = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
    let text = '';
    for (const ref of streams) {
      const stream = doc.context.lookup(ref) as PDFRawStream;
      const raw = Buffer.from(stream.getContents());
      const flate = String(stream.dict.get(PDFName.of('Filter'))) === '/FlateDecode';
      text += (flate ? inflateSync(raw) : raw).toString('latin1');
    }
    for (const match of text.matchAll(/<([0-9A-Fa-f]+)>/g)) {
      text += `\n${Buffer.from(match[1], 'hex').toString('latin1')}`;
    }
    const found = /Stapler fixture page (\d+)/.exec(text);
    return found ? Number(found[1]) : -1;
  });
}

let source: Uint8Array;

beforeAll(async () => {
  source = await textPdf(PAGES);
});

beforeEach(() => {
  store.documents.value = [];
  store.sources.value = {};
  store.activeDocId.value = null;
  store.selectedPageKeys.value = new Set();
  resetHistory();
  __memoryFallback.set('big', source.slice());
  store.registerSource({
    id: 'big',
    name: 'big.pdf',
    pageCount: PAGES,
    pageSizes: Array.from({ length: PAGES }, () => ({ width: 595.28, height: 841.89 }))
  } as Parameters<typeof store.registerSource>[0]);
  store.addDocument({
    id: 'big-doc',
    name: 'big.pdf',
    pages: store.makePageRefs('big', PAGES),
    annotations: [],
    dirty: false
  });
});

function pages() {
  return store.documents.value.find(d => d.id === 'big-doc')!.pages;
}

/** Splits for real and returns each part's page numbers, in file order. */
async function split(boundaries: number[]): Promise<number[][]> {
  const result = await ops.splitDocument({
    pages: pages(),
    annotations: [],
    boundaries,
    baseName: 'big'
  });
  expect(result.isZip).toBe(true);
  const files = unzipSync(result.bytes);
  const names = Object.keys(files).sort();
  const parts: number[][] = [];
  for (const name of names) parts.push(await pageNumbers(files[name]));
  return parts;
}

function expectWholeDocumentInOrder(parts: number[][]) {
  expect(parts.reduce((n, part) => n + part.length, 0)).toBe(PAGES);
  expect(parts.flat()).toEqual(Array.from({ length: PAGES }, (_, i) => i + 1));
}

describe('OPS-03 — splitting a 300-page document', () => {
  it('every 7 pages: 43 files, 42 × 7 + 6, all 300 pages in order', async () => {
    const boundaries = ops.splitBoundaries('every_n', PAGES, { every: 7 });
    const parts = await split(boundaries);
    expect(parts).toHaveLength(43);
    expect(parts.slice(0, 42).every(part => part.length === 7)).toBe(true);
    expect(parts[42]).toEqual([295, 296, 297, 298, 299, 300]);
    expectWholeDocumentInOrder(parts);
  });

  it('custom points 1, 2, 150, 299: uneven parts, nothing lost at either end', async () => {
    const boundaries = ops.splitBoundaries('custom', PAGES, { custom: '1, 2, 150, 299' });
    const parts = await split(boundaries);
    expect(parts.map(part => part.length)).toEqual([1, 1, 148, 149, 1]);
    expect(parts[0]).toEqual([1]);
    expect(parts[4]).toEqual([300]);
    expectWholeDocumentInOrder(parts);
  });

  it('individual pages: 300 one-page files', async () => {
    const parts = await split(ops.splitBoundaries('individual', PAGES));
    expect(parts).toHaveLength(PAGES);
    expect(parts.every(part => part.length === 1)).toBe(true);
    expectWholeDocumentInOrder(parts);
  });

  it('extract a selection: exactly the selected pages, in document order', async () => {
    // A scattered selection, made out of order — the output follows the document.
    const wanted = [250, 3, 299, 150, 1, 151];
    const keys = new Set(wanted.map(i => pages()[i].key));
    store.setPageSelection(keys);
    const selected = pages().filter(p => store.selectedPageKeys.value.has(p.key));
    const bytes = await ops.composeDocument({ pages: selected, annotations: [] });
    expect(await pageNumbers(bytes)).toEqual([2, 4, 151, 152, 251, 300]);
  });
});
