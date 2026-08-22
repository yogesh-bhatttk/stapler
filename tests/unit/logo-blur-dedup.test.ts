/**
 * RED-08 — `blurPageImages`'s "mark this logo" flow must report the marked
 * instance once, not twice.
 *
 * The user marks one instance of a logo; `runFaceBlur.ts` crops that exact
 * rect as `logoTemplate` and also passes it through as a `forcedRects` entry,
 * so the marked spot is blurred even if the automatic matcher scores it just
 * under the threshold. But the marked instance *is* the template, so the
 * matcher almost always finds it again by itself — and the two were being
 * added to the results as if they were different logos.
 */
import { describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';

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

// `any` throughout: @napi-rs/canvas is resolved dynamically off pdfjs-dist's
// own optional dependency, so there are no types to import for it.
const canvasLib: any = await import('@napi-rs/canvas').catch(async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  return require(
    require.resolve('@napi-rs/canvas', { paths: [require.resolve('pdfjs-dist/package.json')] })
  );
});

class NodeOffscreenCanvas {
  private canvas: any;
  constructor(width: number, height: number) {
    this.canvas = canvasLib.createCanvas(Math.max(1, width), Math.max(1, height));
  }
  get width() {
    return this.canvas.width;
  }
  set width(value: number) {
    this.canvas.width = Math.max(1, value);
  }
  get height() {
    return this.canvas.height;
  }
  set height(value: number) {
    this.canvas.height = Math.max(1, value);
  }
  getContext(kind: string) {
    return this.canvas.getContext(kind);
  }
  async convertToBlob({ type = 'image/png', quality }: { type?: string; quality?: number } = {}) {
    const format = type === 'image/jpeg' ? 'jpeg' : 'png';
    const buffer: Buffer =
      format === 'jpeg'
        ? this.canvas.toBuffer('image/jpeg', quality ?? 0.92)
        : this.canvas.toBuffer('image/png');
    return {
      arrayBuffer: async () =>
        buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
    };
  }
}

if (typeof (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas === 'undefined') {
  (globalThis as any).OffscreenCanvas = NodeOffscreenCanvas;
}

// `drawableFrom` asks `candidate instanceof ImageBitmap`, and the name has to
// exist for that to even evaluate. Nothing in Node ever produces one — pdf.js
// hands back raw `{data, kind}` pixels here — so an empty class is enough.
if (typeof (globalThis as { ImageBitmap?: unknown }).ImageBitmap === 'undefined') {
  (globalThis as any).ImageBitmap = class ImageBitmap {};
}

if (typeof (globalThis as { createImageBitmap?: unknown }).createImageBitmap === 'undefined') {
  (globalThis as any).createImageBitmap = async (source: ImageData) => {
    const canvas = canvasLib.createCanvas(source.width, source.height);
    const ctx = canvas.getContext('2d');
    const image = new canvasLib.ImageData(
      new Uint8ClampedArray(source.data),
      source.width,
      source.height
    );
    ctx.putImageData(image, 0, 0);
    canvas.close = () => undefined;
    return canvas;
  };
}

const { processWorkerImpl } = await import('../../src/core/workers/process.worker');
const { renderWorkerImpl } = await import('../../src/core/workers/render.worker');
const { encodePng } = await import('../../src/core/png');
const { silentJob } = await import('../../src/core/workers/protocol');

/**
 * A page-like raster with one "logo" stamped at a known spot — a disc, a
 * rule, and three block "letters", the same wordmark shape
 * `faceblur.test.ts`'s `matchTemplate` tests use. A flat solid square has
 * near-zero variance, which `matchTemplate` treats as "nothing to match" and
 * always scores 0 — this needs real internal texture so the auto-matcher
 * actually re-finds it, which is what the bug this test guards against
 * depends on.
 */
function pageWithOneLogo(at: { x: number; y: number }) {
  const width = 200;
  const height = 200;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    rgba[p * 4] = 235 + (p % 7);
    rgba[p * 4 + 1] = 233 + (p % 5);
    rgba[p * 4 + 2] = 230 + (p % 3);
    rgba[p * 4 + 3] = 255;
  }
  for (let y = 0; y < 40; y++) {
    for (let x = 0; x < 60; x++) {
      const disc = (x - 14) ** 2 + (y - 14) ** 2 < 100;
      const rule = y >= 30 && y < 34 && x >= 4 && x < 56;
      const letters = y >= 8 && y < 22 && [30, 40, 50].some(lx => x >= lx && x < lx + 7);
      const on = disc || rule || letters;
      const p = ((at.y + y) * width + at.x + x) * 4;
      rgba[p] = on ? 20 : 245;
      rgba[p + 1] = on ? 60 : 244;
      rgba[p + 2] = on ? 140 : 242;
    }
  }
  return { rgba, width, height };
}

describe('blurPageImages does not double-count the marked instance of a logo', () => {
  it('reports the user-marked logo once, not twice, when the auto-matcher also finds it', async () => {
    const raster = pageWithOneLogo({ x: 20, y: 20 });
    const rgb = new Uint8Array(raster.width * raster.height * 3);
    for (let p = 0; p < raster.width * raster.height; p++) {
      rgb[p * 3] = raster.rgba[p * 4];
      rgb[p * 3 + 1] = raster.rgba[p * 4 + 1];
      rgb[p * 3 + 2] = raster.rgba[p * 4 + 2];
    }
    const png = encodePng({
      width: raster.width,
      height: raster.height,
      bitDepth: 8,
      colorType: 2,
      samples: rgb
    });
    const doc = await PDFDocument.create();
    const page = doc.addPage([raster.width, raster.height]);
    const embedded = await doc.embedPng(png);
    page.drawImage(embedded, { x: 0, y: 0, width: raster.width, height: raster.height });
    const bytes = await doc.save();

    const plan = await processWorkerImpl.planPageImages(bytes, [0]);
    expect(plan.images.length).toBe(1);
    const target = plan.images[0];

    // Same rect the "mark this logo" flow (runFaceBlur.ts) uses both to crop
    // the template and as the forced instance — unit space, y-up.
    const rect = {
      x: 20 / raster.width,
      y: 1 - 60 / raster.height,
      width: 60 / raster.width,
      height: 40 / raster.height
    };

    const { handle } = await renderWorkerImpl.loadDocument(bytes);
    try {
      const template = await renderWorkerImpl.extractImageRegion(
        handle,
        0,
        target.objectNumber,
        rect
      );
      expect(template).not.toBeNull();

      const results = await renderWorkerImpl.blurPageImages(
        handle,
        0,
        [{ objectNumber: target.objectNumber, forcedRects: [rect] }],
        {
          detectFaces: false,
          minScore: 0.5,
          strength: 'strong',
          logoTemplate: template!,
          logoMinScore: 0.5
        },
        silentJob
      );

      expect(results.length).toBe(1);
      const logos = results[0].regions.filter(region => region.kind === 'logo');
      // Before the fix: `matchTemplate` re-found the marked instance at its
      // own location (a self-match scores ~1.0) *and* `forcedRects` added the
      // same rect again, unconditionally — reporting one real logo as two.
      expect(logos.length).toBe(1);
    } finally {
      await renderWorkerImpl.closeDocument(handle);
    }
  });
});
