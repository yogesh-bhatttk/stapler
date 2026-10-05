/**
 * HRD-27 H3 (AUDIT-FINDINGS §14) — `trimTransparentToPng` and
 * `removeWhiteBackground` run their per-pixel loops in the cv worker, not on
 * the main thread, and their output is unchanged.
 *
 * `legacyTrim` / `legacyRemoveWhite` are the main-thread implementations as
 * they were before the move (git `58668e0` `src/core/image.ts`), verbatim
 * apart from types. Both versions run on the same input through the same Skia
 * canvas (`helpers/node-canvas.ts`), and the PNG bytes and RGBA pixels must
 * match exactly. The cv worker is replaced by an in-process fake that calls
 * the real worker-side code (`workers/signature-pixels.ts`), and `Comlink.transfer`
 * is observed, so the test also proves what crosses the boundary is transferred.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { installOffscreenCanvas, NodeOffscreenCanvas, canvasFromRgba } from './helpers/node-canvas';

const transfers: unknown[][] = [];
vi.mock('comlink', async importOriginal => {
  const actual = await importOriginal<typeof import('comlink')>();
  return {
    ...actual,
    transfer: <T>(value: T, list: unknown[]) => {
      transfers.push(list);
      return value;
    }
  };
});

const leases: string[] = [];
vi.mock('../../src/core/workers', async () => {
  const { signaturePixelsApi } = await import('../../src/core/workers/signature-pixels');
  return {
    cvWorker: {
      lease: <R>(fn: (api: typeof signaturePixelsApi) => Promise<R>) =>
        fn(
          new Proxy(signaturePixelsApi, {
            get(target, prop, receiver) {
              leases.push(String(prop));
              return Reflect.get(target, prop, receiver);
            }
          })
        )
    }
  };
});

/** A shim canvas that also answers `close()`, standing in for an ImageBitmap. */
type FakeBitmap = NodeOffscreenCanvas & { close(): void; closed: boolean };

function asBitmap(canvas: NodeOffscreenCanvas): FakeBitmap {
  const bitmap = canvas as FakeBitmap;
  bitmap.closed = false;
  bitmap.close = () => {
    bitmap.closed = true;
  };
  return bitmap;
}

/** `createImageBitmap` over the shim: a pixel-exact copy, like the browser's. */
async function fakeCreateImageBitmap(source: NodeOffscreenCanvas): Promise<FakeBitmap> {
  const copy = new NodeOffscreenCanvas(source.width, source.height);
  copy.getContext('2d').drawImage(source, 0, 0);
  return asBitmap(copy);
}

beforeAll(() => {
  installOffscreenCanvas();
  (globalThis as unknown as { createImageBitmap: unknown }).createImageBitmap =
    fakeCreateImageBitmap;
});

beforeEach(() => {
  transfers.length = 0;
  leases.length = 0;
});

const { trimTransparentToPng, removeWhiteBackground } = await import('../../src/core/image');
const { opaqueBounds, clearPaperWhite } = await import('../../src/core/workers/signature-pixels');

/* ---------------- the pre-H3 main-thread code, for comparison ---------------- */

async function legacyTrim(
  source: NodeOffscreenCanvas,
  padding = 8
): Promise<{ png: Uint8Array; width: number; height: number } | null> {
  const width = source.width;
  const height = source.height;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(source as unknown as CanvasImageSource, 0, 0);

  const { data } = ctx.getImageData(0, 0, width, height);
  let top = height;
  let left = width;
  let right = -1;
  let bottom = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] === 0) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }

  if (right < left || bottom < top) return null; // nothing drawn

  const cropWidth = right - left + 1;
  const cropHeight = bottom - top + 1;
  const out = new OffscreenCanvas(cropWidth + padding * 2, cropHeight + padding * 2);
  const outCtx = out.getContext('2d');
  if (!outCtx) return null;
  outCtx.drawImage(
    canvas,
    left,
    top,
    cropWidth,
    cropHeight,
    padding,
    padding,
    cropWidth,
    cropHeight
  );

  const blob = await out.convertToBlob({ type: 'image/png' });
  return {
    png: new Uint8Array(await blob.arrayBuffer()),
    width: out.width,
    height: out.height
  };
}

function legacyRemoveWhite(bitmap: NodeOffscreenCanvas, cutoff = 235): OffscreenCanvas | null {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(bitmap as unknown as CanvasImageSource, 0, 0);

  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (min >= cutoff && max - min < 24) data[i + 3] = 0;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/* ---------------- inputs ---------------- */

/** Deterministic PRNG, so a failure reproduces. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** A drawn signature: transparent margins around opaque and anti-aliased ink. */
function inkOnTransparent(width: number, height: number, seed: number): Uint8ClampedArray {
  const next = rng(seed);
  const data = new Uint8ClampedArray(width * height * 4);
  const x0 = Math.floor(width * 0.2);
  const x1 = Math.floor(width * 0.85);
  const y0 = Math.floor(height * 0.3);
  const y1 = Math.floor(height * 0.7);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (next() < 0.3) continue;
      const i = (y * width + x) * 4;
      data[i] = 20;
      data[i + 1] = 30;
      data[i + 2] = 120;
      // Fully opaque or partly transparent — never just a single value.
      data[i + 3] = next() < 0.5 ? 255 : 1 + Math.floor(next() * 254);
    }
  }
  // The faintest possible ink, alone, just outside two corners of the box:
  // alpha 1 still counts as content, so the bounds must reach it.
  for (const [x, y] of [
    [x0 - 3, y0 - 2],
    [x1 + 2, y1 + 1]
  ] as const) {
    data.set([20, 30, 120, 1], (y * width + x) * 4);
  }
  return data;
}

/** A photographed signature: noisy paper-white, grey shadow, ink and a yellow highlight. */
function inkOnPaper(width: number, height: number, seed: number): Uint8ClampedArray {
  const next = rng(seed);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const roll = next();
      let rgb: [number, number, number];
      if (roll < 0.6) {
        const base = 225 + Math.floor(next() * 31); // around the 235 cutoff on purpose
        rgb = [base, base - Math.floor(next() * 30), base];
      } else if (roll < 0.75) rgb = [200, 200, 200];
      else if (roll < 0.9) rgb = [15, 15, 60];
      else rgb = [255, 245, 120];
      data.set([...rgb, 255], i);
    }
  }
  return data;
}

function pixels(canvas: OffscreenCanvas | NodeOffscreenCanvas): Uint8ClampedArray {
  const ctx = (canvas as NodeOffscreenCanvas).canvas.getContext('2d');
  return new Uint8ClampedArray(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
}

/* ---------------- tests ---------------- */

describe('signature pixel work in the cv worker (HRD-27 H3)', () => {
  it('trimTransparentToPng: byte-identical PNG to the old main-thread code', async () => {
    for (const [width, height, padding, seed] of [
      [64, 48, 8, 1],
      [301, 97, 0, 2],
      [120, 120, 13, 3]
    ] as const) {
      const rgba = inkOnTransparent(width, height, seed);
      const expected = await legacyTrim(canvasFromRgba(rgba, width, height), padding);
      const source = asBitmap(canvasFromRgba(rgba, width, height));
      const actual = await trimTransparentToPng(source as unknown as ImageBitmap, padding);

      expect(expected).not.toBeNull();
      expect(actual).not.toBeNull();
      expect(actual!.width).toBe(expected!.width);
      expect(actual!.height).toBe(expected!.height);
      expect(Buffer.from(actual!.png).equals(Buffer.from(expected!.png))).toBe(true);
      // The caller's bitmap is untouched: a copy went to the worker.
      expect(source.closed).toBe(false);
      expect(pixels(source)).toEqual(pixels(canvasFromRgba(rgba, width, height)));
    }
  });

  it('trimTransparentToPng: an empty canvas is still null', async () => {
    const empty = asBitmap(new NodeOffscreenCanvas(40, 30));
    expect(await legacyTrim(empty)).toBeNull();
    expect(await trimTransparentToPng(empty as unknown as ImageBitmap)).toBeNull();
  });

  it('trimTransparentToPng: the default padding is still 8', async () => {
    const rgba = inkOnTransparent(50, 50, 9);
    const expected = await legacyTrim(canvasFromRgba(rgba, 50, 50));
    const actual = await trimTransparentToPng(
      asBitmap(canvasFromRgba(rgba, 50, 50)) as unknown as ImageBitmap
    );
    expect(actual!.width).toBe(expected!.width);
    expect(Buffer.from(actual!.png).equals(Buffer.from(expected!.png))).toBe(true);
  });

  it('removeWhiteBackground: identical RGBA to the old main-thread code, still a canvas', async () => {
    for (const [width, height, cutoff, seed] of [
      [80, 60, 235, 4],
      [33, 211, 200, 5],
      [128, 64, 250, 6]
    ] as const) {
      const rgba = inkOnPaper(width, height, seed);
      const expected = legacyRemoveWhite(canvasFromRgba(rgba, width, height), cutoff)!;
      const source = asBitmap(canvasFromRgba(rgba, width, height));
      const actual = await removeWhiteBackground(source as unknown as ImageBitmap, cutoff);

      expect(actual).toBeInstanceOf(OffscreenCanvas);
      expect(actual!.width).toBe(width);
      expect(actual!.height).toBe(height);
      const got = pixels(actual!);
      expect(got).toEqual(pixels(expected));
      // Some paper really was cleared and some ink really was kept.
      let cleared = 0;
      for (let i = 3; i < got.length; i += 4) if (got[i] === 0) cleared++;
      expect(cleared).toBeGreaterThan(0);
      expect(cleared).toBeLessThan(width * height);
      expect(source.closed).toBe(false);
    }
  });

  it('removeWhiteBackground then trim: the SignatureModal import pipeline is unchanged', async () => {
    const rgba = inkOnPaper(90, 70, 7);
    const legacyCanvas = legacyRemoveWhite(canvasFromRgba(rgba, 90, 70))!;
    const expected = await legacyTrim(legacyCanvas as unknown as NodeOffscreenCanvas);

    const canvas = await removeWhiteBackground(
      asBitmap(canvasFromRgba(rgba, 90, 70)) as unknown as ImageBitmap
    );
    const bitmap = await createImageBitmap(canvas as unknown as ImageBitmapSource);
    const actual = await trimTransparentToPng(bitmap);
    expect(Buffer.from(actual!.png).equals(Buffer.from(expected!.png))).toBe(true);
  });

  it('runs the pixel work in the cv worker and transfers bitmaps and PNG bytes both ways', async () => {
    const rgba = inkOnTransparent(40, 40, 8);
    await trimTransparentToPng(asBitmap(canvasFromRgba(rgba, 40, 40)) as unknown as ImageBitmap);
    expect(leases).toEqual(['trimSignature']);
    // Main → worker: the bitmap copy. Worker → main: the PNG's buffer.
    expect(transfers).toHaveLength(2);
    expect(transfers[0]![0]).toBeInstanceOf(NodeOffscreenCanvas);
    expect(transfers[1]![0]).toBeInstanceOf(ArrayBuffer);

    transfers.length = 0;
    leases.length = 0;
    await removeWhiteBackground(asBitmap(canvasFromRgba(inkOnPaper(20, 20, 1), 20, 20)) as never);
    expect(leases).toEqual(['removeSignatureBackground']);
    expect(transfers).toHaveLength(2);
    expect(transfers[0]![0]).toBeInstanceOf(NodeOffscreenCanvas);
    expect(transfers[1]![0]).toBeInstanceOf(NodeOffscreenCanvas);
  });

  it('the kernels match the old loops on raw buffers', () => {
    const width = 57;
    const height = 31;
    const data = inkOnTransparent(width, height, 11);
    expect(opaqueBounds(data, width, height)).toEqual({
      left: Math.floor(width * 0.2) - 3,
      top: Math.floor(height * 0.3) - 2,
      right: Math.floor(width * 0.85) + 2,
      bottom: Math.floor(height * 0.7) + 1
    });
    expect(opaqueBounds(new Uint8ClampedArray(width * height * 4), width, height)).toBeNull();

    const paper = inkOnPaper(width, height, 12);
    const viaKernel = new Uint8ClampedArray(paper);
    clearPaperWhite(viaKernel, 235);
    for (let i = 0; i < paper.length; i += 4) {
      const max = Math.max(paper[i]!, paper[i + 1]!, paper[i + 2]!);
      const min = Math.min(paper[i]!, paper[i + 1]!, paper[i + 2]!);
      expect(viaKernel[i + 3]).toBe(min >= 235 && max - min < 24 ? 0 : paper[i + 3]);
    }
  });
});
