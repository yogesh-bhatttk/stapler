/**
 * RED-08 — `setFaceDetectorOverride` (`detect.ts`) exists so the substitution
 * pipeline — coordinate mapping, encode-once, the PDF surgery — can be tested
 * from a known, fixed answer instead of waiting on the real network's
 * decisions. `faceblur.test.ts` already covers the real detector against real
 * weights; this file is the seam's other half, and gives it the caller its
 * own doc comment says it is for.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
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
const { setFaceDetectorOverride, getFaceDetectorOverride } =
  await import('../../src/core/faceblur/detect');

afterEach(() => {
  setFaceDetectorOverride(null);
});

/** A plain, featureless page raster — no real face needed, the detector is overridden. */
function blankPage(width = 100, height = 100) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  rgba.fill(255);
  return { rgba, width, height };
}

async function pdfWithOneImage(): Promise<{ bytes: Uint8Array }> {
  const raster = blankPage();
  const rgb = new Uint8Array(raster.width * raster.height * 3);
  rgb.fill(255);
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
  return { bytes: await doc.save() };
}

describe('detect.ts / setFaceDetectorOverride drives the real substitution pipeline', () => {
  it('is unset by default', () => {
    expect(getFaceDetectorOverride()).toBeNull();
  });

  it('a fixed detector answer reaches blurPageImages and mosaics exactly that region', async () => {
    const fixedRegion = { x: 0.2, y: 0.3, width: 0.25, height: 0.15 };
    setFaceDetectorOverride(async () => [{ ...fixedRegion, kind: 'face', score: 0.99 }]);
    expect(getFaceDetectorOverride()).not.toBeNull();

    const { bytes } = await pdfWithOneImage();
    const plan = await processWorkerImpl.planPageImages(bytes, [0]);
    expect(plan.images.length).toBe(1);
    const target = plan.images[0];

    const { handle } = await renderWorkerImpl.loadDocument(bytes);
    try {
      const results = await renderWorkerImpl.blurPageImages(
        handle,
        0,
        [{ objectNumber: target.objectNumber }],
        { detectFaces: true, minScore: 0.35, strength: 'strong' },
        silentJob
      );

      expect(results.length).toBe(1);
      expect(results[0].regions).toEqual([{ ...fixedRegion, kind: 'face', score: 0.99 }]);
      // A region was found, so the image must have been re-encoded — the
      // pipeline this seam exists to prove, not just the detector call.
      expect(results[0].image).toBeDefined();
    } finally {
      await renderWorkerImpl.closeDocument(handle);
    }
  });

  it('an empty answer leaves the image alone, same as "no faces found"', async () => {
    setFaceDetectorOverride(async () => []);
    const { bytes } = await pdfWithOneImage();
    const plan = await processWorkerImpl.planPageImages(bytes, [0]);
    const target = plan.images[0];

    const { handle } = await renderWorkerImpl.loadDocument(bytes);
    try {
      const results = await renderWorkerImpl.blurPageImages(
        handle,
        0,
        [{ objectNumber: target.objectNumber }],
        { detectFaces: true, minScore: 0.35, strength: 'strong' },
        silentJob
      );
      expect(results).toEqual([{ objectNumber: target.objectNumber, regions: [] }]);
    } finally {
      await renderWorkerImpl.closeDocument(handle);
    }
  });
});
