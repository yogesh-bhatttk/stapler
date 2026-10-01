import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument, PDFName, PDFRawStream, PDFDict } from 'pdf-lib';
import { unzlibSync } from 'fflate';

/**
 * AUDIT-2026-10-01 X-1..X-6 — the Compare exports.
 *
 * The render worker and the cv worker are replaced by in-process fakes that
 * log every call, so the tests can see how many times each document was
 * loaded, in what order pages were rendered and diffed, and which page sizes
 * reached the output — against the real output bytes, parsed with pdf-lib.
 */

const calls: string[] = [];
const sizesByHandle = new Map<string, { width: number; height: number }[]>();
const colourByHandle = new Map<string, [number, number, number]>();

/** A stand-in bitmap: the fake cv worker turns it back into pixels. */
interface FakeBitmap {
  width: number;
  height: number;
  rgb: [number, number, number];
  closed: boolean;
  close(): void;
}

function solid(width: number, height: number, rgb: [number, number, number]): ImageData {
  const img = new ImageData(width, height);
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = rgb[0];
    img.data[i + 1] = rgb[1];
    img.data[i + 2] = rgb[2];
    img.data[i + 3] = 255;
  }
  return img;
}

const { fakeWorkers } = vi.hoisted(() => ({ fakeWorkers: {} as Record<string, unknown> }));

vi.mock('../../src/core/operations', () => ({
  composeDocument: vi.fn(async (request: { pages: { sourceDocId: string }[] }) => {
    // The "bytes" just name the document, so the fake loader knows which one it is.
    return new TextEncoder().encode(request.pages[0].sourceDocId);
  })
}));

vi.mock('../../src/core/workers', () => fakeWorkers);

const compareRaster = await import('../../src/core/compare-raster');

let handleCounter = 0;
const renderApi = {
  async loadDocument(bytes: Uint8Array) {
    const id = new TextDecoder().decode(bytes);
    const handle = `${id}#${++handleCounter}`;
    calls.push(`load:${id}`);
    return {
      handle,
      pageCount: 0,
      isXfa: false,
      fingerprint: id,
      pageSizes: sizesByHandle.get(id)!
    };
  },
  async closeDocument(handle: string) {
    calls.push(`close:${handle.split('#')[0]}`);
  },
  async renderPage(handle: string, pageIndex: number, scale: number): Promise<FakeBitmap> {
    const id = handle.split('#')[0];
    calls.push(`render:${id}:${pageIndex}`);
    const size = sizesByHandle.get(id)![pageIndex];
    const bitmap: FakeBitmap = {
      width: Math.round(size.width * scale),
      height: Math.round(size.height * scale),
      rgb: colourByHandle.get(id)!,
      closed: false,
      close() {
        bitmap.closed = true;
      }
    };
    return bitmap;
  }
};

const toImage = (bitmap: FakeBitmap | null) =>
  bitmap ? solid(bitmap.width, bitmap.height, bitmap.rgb) : undefined;

const cvApi = {
  visualDiffPage(pair: { a: FakeBitmap | null; b: FakeBitmap | null }, sensitivity: number) {
    calls.push('cv:visual');
    const raster = compareRaster.visualDiffRaster(toImage(pair.a), toImage(pair.b), sensitivity);
    return { ...compareRaster.deflateRaster(raster), changed: raster.changed };
  },
  redlinePage(
    pair: { a: FakeBitmap | null; b: FakeBitmap | null },
    sensitivity: number,
    mode: 'skip' | 'mark'
  ) {
    calls.push('cv:redline');
    return compareRaster.redlinePageRaster(toImage(pair.a), toImage(pair.b), sensitivity, mode);
  }
};

const pinned = () => ({
  lease: <R>(fn: (api: typeof renderApi) => Promise<R>) => fn(renderApi),
  release: () => calls.push('release')
});
Object.assign(fakeWorkers, {
  renderWorker: {
    pin: pinned,
    lease: <R>(fn: (api: typeof renderApi) => Promise<R>) => fn(renderApi)
  },
  cvWorker: { lease: <R>(fn: (api: typeof cvApi) => R | Promise<R>) => fn(cvApi) }
});

const { exportVisualDiff } = await import('../../src/core/visual-diff-export');
const { exportRedlinePdf } = await import('../../src/core/redline-export');
const { pageListKey } = await import('../../src/core/page-version');

function doc(
  id: string,
  sizes: { width: number; height: number }[],
  rgb: [number, number, number]
) {
  sizesByHandle.set(id, sizes);
  colourByHandle.set(id, rgb);
  const pages = sizes.map((_, i) => ({
    key: `${id}-${i}`,
    sourceDocId: id,
    sourceIndex: i,
    rotation: 0
  }));
  return { id, name: `${id}.pdf`, pages, baseline: pages, annotations: [], dirty: false };
}

const A4 = { width: 595.28, height: 841.89 };
const LETTER = { width: 612, height: 792 };
const A4_LANDSCAPE = { width: 841.89, height: 595.28 };

beforeEach(() => {
  calls.length = 0;
});

/** Every image XObject drawn on `page`, decoded back to its first RGB pixel. */
function firstImagePixel(pdf: PDFDocument, pageIndex: number): number[] {
  const page = pdf.getPage(pageIndex);
  const xobjects = page.node.Resources()!.lookup(PDFName.of('XObject'), PDFDict);
  const [name] = xobjects.keys();
  const stream = xobjects.lookup(name) as PDFRawStream;
  expect(stream.dict.get(PDFName.of('Filter'))).toEqual(PDFName.of('FlateDecode'));
  return Array.from(unzlibSync(stream.contents).subarray(0, 3));
}

describe('exportVisualDiff — rendered path', () => {
  it('X-2 + X-3 + X-4: real page sizes, mismatched sizes compared, each document loaded once', async () => {
    const before = doc('before', [A4, A4_LANDSCAPE, A4], [255, 255, 255]);
    const after = doc('after', [LETTER, A4_LANDSCAPE, A4], [255, 255, 255]);
    const bytes = await exportVisualDiff(before, after, [], { sensitivity: 10 });
    const pdf = await PDFDocument.load(bytes);

    expect(pdf.getPageCount()).toBe(3);
    // The "before" page's own size, landscape included — never 612×792.
    expect(pdf.getPage(0).getSize()).toEqual({ width: A4.width, height: A4.height });
    expect(pdf.getPage(1).getSize()).toEqual({
      width: A4_LANDSCAPE.width,
      height: A4_LANDSCAPE.height
    });
    // X-4: one load per document, not one per page.
    expect(calls.filter(c => c.startsWith('load:'))).toEqual(['load:before', 'load:after']);
    expect(calls.filter(c => c.startsWith('close:'))).toHaveLength(2);
    // Identical white pages, even at different sizes: nothing marked red.
    expect(firstImagePixel(pdf, 0)).toEqual([255, 255, 255]);
  });

  it('marks a changed page red', async () => {
    const before = doc('b2', [A4], [255, 255, 255]);
    const after = doc('a2', [A4], [0, 0, 0]);
    const pdf = await PDFDocument.load(await exportVisualDiff(before, after, [], {}));
    expect(firstImagePixel(pdf, 0)).toEqual([255, 0, 0]);
  });

  it('X-6: diffs every page in the cv worker, page by page, with determinate progress', async () => {
    const before = doc('pb', [A4, A4, A4], [255, 255, 255]);
    const after = doc('pa', [A4, A4, A4], [255, 255, 255]);
    const progress: number[] = [];
    await exportVisualDiff(before, after, [], {
      onProgress: fraction => progress.push(fraction ?? -1)
    });
    expect(calls.filter(c => c === 'cv:visual')).toHaveLength(3);
    // Page i is diffed before page i+1 is rendered.
    const order = calls.filter(c => c.startsWith('render:pb') || c === 'cv:visual');
    expect(order).toEqual([
      'render:pb:0',
      'cv:visual',
      'render:pb:1',
      'cv:visual',
      'render:pb:2',
      'cv:visual'
    ]);
    expect(progress).toEqual([0, 1 / 3, 2 / 3, 1]);
  });

  it('X-1: a cancelled export throws instead of saving the pages built so far', async () => {
    const before = doc('cb', [A4, A4, A4], [255, 255, 255]);
    const after = doc('ca', [A4, A4, A4], [255, 255, 255]);
    const controller = new AbortController();
    await expect(
      exportVisualDiff(before, after, [], {
        signal: controller.signal,
        onProgress: fraction => {
          if (fraction !== null && fraction > 0.5) controller.abort();
        }
      })
    ).rejects.toMatchObject({ kind: 'UserCancelled' });
    // Both documents are still closed and released.
    expect(calls.filter(c => c.startsWith('close:'))).toHaveLength(2);
    expect(calls.filter(c => c === 'release')).toHaveLength(2);
  });

  it('X-1: also with supplied overlays (the test seam)', async () => {
    const img = solid(3, 3, [255, 255, 255]);
    const controller = new AbortController();
    controller.abort();
    const a = doc('sa', [A4, A4], [255, 255, 255]);
    await expect(
      exportVisualDiff(
        a,
        a,
        [
          { pageIndex: 0, diffImage: img },
          { pageIndex: 1, diffImage: img }
        ],
        {
          signal: controller.signal
        }
      )
    ).rejects.toMatchObject({ kind: 'UserCancelled' });
  });
});

describe('exportRedlinePdf — rendered path', () => {
  it('X-5: renders, diffs and embeds one pair at a time; each document loaded once', async () => {
    const before = doc('rb', [A4, A4, LETTER], [255, 255, 255]);
    const after = doc('ra', [A4, A4, A4], [255, 255, 255]);
    const progress: number[] = [];
    const bytes = await exportRedlinePdf(before, after, {
      onProgress: fraction => progress.push(fraction ?? -1)
    });
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(3);
    expect(calls.filter(c => c.startsWith('load:'))).toEqual(['load:rb', 'load:ra']);
    const order = calls.filter(c => c.startsWith('render:rb') || c === 'cv:redline');
    expect(order).toEqual([
      'render:rb:0',
      'cv:redline',
      'render:rb:1',
      'cv:redline',
      'render:rb:2',
      'cv:redline'
    ]);
    // The Letter "before" pane is drawn at Letter size next to the A4 "after".
    const last = pdf.getPage(2).getSize();
    expect(last.width).toBeCloseTo(24 * 2 + LETTER.width + 24 + A4.width, 3);
    expect(progress).toEqual([0, 1 / 3, 2 / 3, 1]);
  });

  it('X-1: cancelling mid-export throws and still closes both documents', async () => {
    const before = doc('xb', [A4, A4, A4], [255, 255, 255]);
    const after = doc('xa', [A4, A4, A4], [255, 255, 255]);
    const controller = new AbortController();
    await expect(
      exportRedlinePdf(before, after, {
        signal: controller.signal,
        onProgress: fraction => {
          if (fraction !== null && fraction > 0) controller.abort();
        }
      })
    ).rejects.toMatchObject({ kind: 'UserCancelled' });
    expect(calls.filter(c => c.startsWith('close:'))).toHaveLength(2);
  });
});

describe('compare-raster', () => {
  it('resamples to a requested size and leaves a same-size image alone', () => {
    const img = solid(4, 2, [10, 20, 30]);
    expect(compareRaster.resampleImageData(img, 4, 2)).toBe(img);
    const out = compareRaster.resampleImageData(img, 2, 4);
    expect([out.width, out.height]).toEqual([2, 4]);
    expect(Array.from(out.data.subarray(0, 4))).toEqual([10, 20, 30, 255]);
  });

  it('skips compressing an unchanged pair that will not be drawn', () => {
    const img = solid(2, 2, [1, 2, 3]);
    expect(compareRaster.redlinePageRaster(img, img, 10, 'skip')).toEqual({
      changed: false,
      a: null,
      b: null
    });
    const marked = compareRaster.redlinePageRaster(img, img, 10, 'mark');
    expect(marked.a && Array.from(unzlibSync(marked.a.flate))).toEqual([
      1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 3
    ]);
  });
});

describe('pageListKey (pattern 1)', () => {
  const pages = [
    { key: 'k1', sourceDocId: 's', sourceIndex: 0, rotation: 0 },
    { key: 'k2', sourceDocId: 's', sourceIndex: 1, rotation: 0 }
  ];
  it('changes when a page is deleted or moved, not when nothing changed', () => {
    const base = pageListKey({ id: 'd', pages });
    expect(pageListKey({ id: 'd', pages: [...pages] })).toBe(base);
    expect(pageListKey({ id: 'd', pages: [pages[0]] })).not.toBe(base);
    expect(pageListKey({ id: 'd', pages: [pages[1], pages[0]] })).not.toBe(base);
    expect(pageListKey({ id: 'other', pages })).not.toBe(base);
  });
  it('ignores rotation for text caches unless asked', () => {
    const turned = [{ ...pages[0], rotation: 90 }, pages[1]];
    expect(pageListKey({ id: 'd', pages: turned })).toBe(pageListKey({ id: 'd', pages }));
    expect(pageListKey({ id: 'd', pages: turned }, { rotation: true })).not.toBe(
      pageListKey({ id: 'd', pages }, { rotation: true })
    );
  });
});
