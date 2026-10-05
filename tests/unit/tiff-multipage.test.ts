/**
 * HRD-05 (AUDIT-2026-08-17 §3 #26) — a multi-page TIFF imports every IFD as a
 * page, each at its own size and orientation.
 *
 * `sample.tiff` has one page, so the old test could only assert `count >= 1`.
 * `multipage.tiff` (see tests/fixtures/README.md) has three: 300×200, 160×240,
 * and 200×100 stored with Orientation 6, which must come out portrait 100×200.
 * Each page carries a red 20×20 marker in its *stored* top-left corner, so the
 * rotation is checked on pixels, not only on the size.
 *
 * The second test runs the real import chain in-process: `imagesToPdfBytes` →
 * `imageFileToPdfImages` → the image worker's `decodeToPdfImages` (UTIF, then
 * an encode through the Skia OffscreenCanvas shim) → the process worker's
 * `imagesToPdf`, and reads the page boxes back out of the PDF bytes.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { canvasLib, installOffscreenCanvas } from './helpers/node-canvas';
import { decodeTiffPages, type RgbaFrame } from '../../src/core/raster-decode';

const exposed = vi.hoisted(() => ({ api: null as unknown }));

vi.mock('comlink', async importOriginal => ({
  ...(await importOriginal<typeof import('comlink')>()),
  expose: (api: unknown) => {
    exposed.api = api;
  },
  transfer: <T>(value: T) => value,
  proxy: <T>(value: T) => value
}));

vi.mock('../../src/core/workers', async () => {
  await import('../../src/core/workers/image.worker');
  const { processWorkerImpl } = await import('../../src/core/workers/process.worker');
  const leaseOn =
    <T>(target: () => T) =>
    <R>(fn: (api: T) => Promise<R>) =>
      fn(target());
  const unavailable = {
    lease: () => Promise.reject(new Error('not used in this test')),
    terminate() {}
  };
  return {
    imageWorker: { lease: leaseOn(() => exposed.api), terminate() {} },
    processWorker: { lease: leaseOn(() => processWorkerImpl), terminate() {} },
    renderWorker: unavailable,
    cvWorker: unavailable,
    convertWorker: unavailable,
    ocrWorker: unavailable
  };
});

const FIXTURE = 'tests/fixtures/multipage.tiff';
const EXPECTED = [
  { width: 300, height: 200 },
  { width: 160, height: 240 },
  { width: 100, height: 200 } // stored 200×100, Orientation 6
];

const px = (f: RgbaFrame, x: number, y: number) => {
  const i = (y * f.width + x) * 4;
  return [f.data[i], f.data[i + 1], f.data[i + 2], f.data[i + 3]];
};
const RED = [255, 0, 0, 255];

// Skia's `putImageData` only takes its own `ImageData`, not setup.ts's stand-in.
const nodeImageData = globalThis.ImageData;
beforeAll(() => {
  installOffscreenCanvas();
  (globalThis as unknown as { ImageData: unknown }).ImageData = canvasLib.ImageData;
});
afterAll(() => {
  globalThis.ImageData = nodeImageData;
});

describe('multi-page TIFF (HRD-05)', () => {
  it('decodes every IFD as its own page, in order, upright', async () => {
    const before: [number, number][] = [];
    const frames: RgbaFrame[] = [];
    const count = await decodeTiffPages(new Uint8Array(readFileSync(FIXTURE)), {
      beforePage: (i, total) => {
        before.push([i, total]);
      },
      onPage: frame => {
        frames.push(frame);
      }
    });

    expect(count).toBe(3);
    expect(before).toEqual([
      [0, 3],
      [1, 3],
      [2, 3]
    ]);
    expect(frames.map(f => ({ width: f.width, height: f.height }))).toEqual(EXPECTED);
    for (const f of frames) expect(f.data.length).toBe(f.width * f.height * 4);

    // Upright pages: the marker stays top-left, and each page keeps its own fill.
    expect(px(frames[0]!, 5, 5)).toEqual(RED);
    expect(px(frames[0]!, 299, 199)).toEqual([0, 255, 0, 255]);
    expect(px(frames[1]!, 5, 5)).toEqual(RED);
    expect(px(frames[1]!, 159, 239)).toEqual([0, 0, 255, 255]);
    // Orientation 6 ("row 0 is the visual right side"): the stored top-left
    // marker is shown at the top-right of the portrait page.
    const turned = frames[2]!;
    expect(px(turned, 95, 5)).toEqual(RED);
    expect(px(turned, 5, 5)).toEqual([255, 255, 0, 255]);
    expect(px(turned, 95, 195)).toEqual([255, 255, 0, 255]);
  });

  it('imports as a 3-page PDF with each page at its own size and orientation', async () => {
    const { imagesToPdfBytes } = await import('../../src/core/import');
    const file = new File([readFileSync(FIXTURE)], 'multipage.tiff', { type: 'image/tiff' });
    const progress: (number | null)[] = [];
    const { bytes, warnings } = await imagesToPdfBytes([file], {
      onProgress: fraction => progress.push(fraction)
    });

    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(3);
    expect(
      pdf.getPages().map(page => {
        const { width, height } = page.getSize();
        return { width: Math.round(width), height: Math.round(height) };
      })
    ).toEqual(EXPECTED);
    // The page is portrait because the pixels were turned, not by /Rotate.
    expect(pdf.getPages().map(page => page.getRotation().angle)).toEqual([0, 0, 0]);
    expect(warnings).toEqual([]);
    expect(progress.length).toBeGreaterThan(0);
  });
});
