/**
 * IMG-6 — "longest side at most N" from the render worker's
 * `pageToSizedImage` (behind `pagesToSizedImageArchive`) must never give
 * N + 1 px through floating point and `Math.ceil`. Driven against the real
 * worker implementation and checked on the decoded output pixels.
 */
import { describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { decodeToRgba, installCanvasShims } from './helpers/node-canvas-shims';

vi.mock('comlink', () => ({
  expose: vi.fn(),
  transfer: vi.fn(value => value),
  proxy: vi.fn(value => value),
  releaseProxy: Symbol('releaseProxy')
}));

vi.mock('../../src/core/workers/pdfjs-setup', async () => {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return {
    pdfjsLib,
    openDocument: ({ data, password }: { data: Uint8Array; password?: string }) =>
      pdfjsLib.getDocument({ data, password, disableFontFace: true, verbosity: 0 })
  };
});

installCanvasShims();
const { renderWorkerImpl } = await import('../../src/core/workers/render.worker');

const SIZES: [number, number][] = [
  [595, 595],
  [595, 842],
  [842, 595],
  [612, 792],
  [595.28, 841.89]
];
const BOXES = [400, 800, 1000, 1234, 1600];

describe('pageToSizedImage longest-side box (IMG-6)', () => {
  it('never exceeds N px on the longest side, and is not more than 1 px short', async () => {
    const doc = await PDFDocument.create();
    for (const size of SIZES) doc.addPage(size);
    const { handle } = await renderWorkerImpl.loadDocument(await doc.save());
    const misses: string[] = [];
    try {
      for (let pageIndex = 0; pageIndex < SIZES.length; pageIndex++) {
        for (const box of BOXES) {
          const result = await renderWorkerImpl.pageToSizedImage(handle, pageIndex, 'png', 300, {
            targetBytes: null,
            maxDimension: box
          });
          const decoded = await decodeToRgba(result.bytes);
          const longest = Math.max(decoded.width, decoded.height);
          expect(Math.max(result.width, result.height)).toBe(longest);
          if (longest > box || longest < box - 1) {
            misses.push(`${SIZES[pageIndex].join('×')} pt in ${box}: ${longest} px`);
          }
        }
      }
    } finally {
      await renderWorkerImpl.closeDocument(handle);
    }
    expect(misses).toEqual([]);
  });
});
