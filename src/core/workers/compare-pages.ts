/**
 * X-6 (AUDIT-2026-10-01) — the Compare exports' per-page pixel work, run in
 * the cv worker: reading the rendered bitmaps back, the pixel diff, packing
 * the samples and compressing them. On the main thread this took well over
 * the 50 ms budget per page. Everything here is worker-side glue around the
 * pure functions in `compare-raster.ts`.
 */
import * as Comlink from 'comlink';
import { pixelDiff } from '../pixel-diff';
import {
  deflateRaster,
  redlinePageRaster,
  visualDiffRaster,
  type FlateRaster,
  type RedlinePageRaster
} from '../compare-raster';

/** The two rendered pages of one comparison step; either may be absent. Closed once read. */
export interface ComparePagePair {
  a: ImageBitmap | null;
  b: ImageBitmap | null;
}

export interface ComparePagesJob {
  /** ANN-05 — one visual-diff page: "after" with every differing pixel red. */
  visualDiffPage(pair: ComparePagePair, sensitivity: number): FlateRaster & { changed: boolean };
  /** ANN-06 — one redline page pair: whether it changed, and each side's pixels. */
  redlinePage(
    pair: ComparePagePair,
    sensitivity: number,
    unchangedPages: 'skip' | 'mark'
  ): RedlinePageRaster;
  /**
   * UX-02 — one page of the pre-export review (`diff-preview.ts`): each side's
   * pixels and, when both sides are the same size, the changed-pixel mask.
   * Reading the bitmaps back and diffing them took ~50 ms of main thread per
   * page view on the 10 × 5 MB merge's review (NFR-02).
   */
  reviewPage(pair: ComparePagePair, sensitivity: number): ReviewPageImages;
}

export interface ReviewPageImages {
  before: ImageData | null;
  after: ImageData | null;
  diff: ImageData | null;
  comparable: boolean;
}

function readBitmap(bitmap: ImageBitmap | null): ImageData | undefined {
  if (!bitmap) return undefined;
  // Read before close(): a closed bitmap reports 0×0.
  const { width, height } = bitmap;
  try {
    if (width === 0 || height === 0) return undefined;
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return undefined;
    ctx.drawImage(bitmap, 0, 0);
    return ctx.getImageData(0, 0, width, height);
  } finally {
    bitmap.close();
  }
}

export const comparePagesApi: ComparePagesJob = {
  reviewPage(pair, sensitivity) {
    const before = readBitmap(pair.a) ?? null;
    const after = readBitmap(pair.b) ?? null;
    const comparable =
      !!before && !!after && before.width === after.width && before.height === after.height;
    const diff = comparable && before && after ? pixelDiff(before, after, sensitivity) : null;
    const out: ReviewPageImages = { before, after, diff, comparable };
    const buffers = [before, after, diff].flatMap(image =>
      image ? [image.data.buffer as ArrayBuffer] : []
    );
    return Comlink.transfer(out, buffers);
  },
  visualDiffPage(pair, sensitivity) {
    const raster = visualDiffRaster(readBitmap(pair.a), readBitmap(pair.b), sensitivity);
    const out = { ...deflateRaster(raster), changed: raster.changed };
    return Comlink.transfer(out, [out.flate.buffer]);
  },
  redlinePage(pair, sensitivity, unchangedPages) {
    const out = redlinePageRaster(
      readBitmap(pair.a),
      readBitmap(pair.b),
      sensitivity,
      unchangedPages
    );
    const buffers = [out.a?.flate.buffer, out.b?.flate.buffer].filter(
      (buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer
    );
    return Comlink.transfer(out, buffers);
  }
};
