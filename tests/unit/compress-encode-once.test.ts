/**
 * CMP-03 — one image object, one encode.
 *
 * A logo repeated across ten pages used to be decoded, downscaled and
 * JPEG-encoded once *per page that displays it*, with nine of the ten results
 * thrown away: only the largest was ever embedded. The cost scaled with page
 * count for no benefit at all.
 *
 * These tests drive the real render worker against a real PDF — pdf.js's legacy
 * build renders through a napi-rs canvas standing in for `OffscreenCanvas` — and
 * count the encodes as they happen, so "encoded once" is measured rather than
 * asserted. The size-selection rule is graded separately as a pure function.
 */
import { describe, expect, it, vi } from 'vitest';
import { PDFDocument, PDFDict, PDFName, PDFRef } from 'pdf-lib';

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

// `any` throughout the shims below: @napi-rs/canvas is resolved dynamically off
// pdfjs-dist's own optional dependency, so there are no types to import for it.
const canvasLib: any = await import('@napi-rs/canvas').catch(async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  return require(
    require.resolve('@napi-rs/canvas', { paths: [require.resolve('pdfjs-dist/package.json')] })
  );
});

/** Every image encode the worker performs, in order — the spy this test needs. */
const encodes: { type: string; width: number; height: number }[] = [];

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
    encodes.push({ type, width: this.canvas.width, height: this.canvas.height });
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
// hands back raw `{data, kind}` pixels here — so an empty class is enough, and it
// keeps the check answering "no" honestly.
if (typeof (globalThis as { ImageBitmap?: unknown }).ImageBitmap === 'undefined') {
  (globalThis as any).ImageBitmap = class ImageBitmap {};
}

// `createImageBitmap` exists only in browsers. The worker uses it purely as a
// drawable source for `ctx.drawImage`, and a canvas is one.
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
    // `close()` is part of the ImageBitmap contract the worker calls.
    canvas.close = () => undefined;
    return canvas;
  };
}

const { renderWorkerImpl, largerPlacement } = await import('../../src/core/workers/render.worker');

/** A real JPEG, big enough that 72 DPI placement actually downscales it. */
function sourceJpeg(size = 400): Uint8Array {
  const canvas = canvasLib.createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  for (let y = 0; y < size; y += 8) {
    for (let x = 0; x < size; x += 8) {
      ctx.fillStyle = `rgb(${x % 255}, ${y % 255}, ${(x + y) % 255})`;
      ctx.fillRect(x, y, 8, 8);
    }
  }
  return new Uint8Array(canvas.toBuffer('image/jpeg', 0.9));
}

/**
 * `pageCount` pages, all drawing one shared image XObject. The last page draws it
 * largest, so a first-page-wins implementation would be visibly wrong.
 */
async function docSharingOneImage(pageCount: number, sizesPt: number[]) {
  const doc = await PDFDocument.create();
  const image = await doc.embedJpg(sourceJpeg());
  for (let i = 0; i < pageCount; i++) {
    const page = doc.addPage([612, 792]);
    const side = sizesPt[i] ?? 100;
    page.drawImage(image, { x: 20, y: 20, width: side, height: side });
  }
  const bytes = await doc.save({ useObjectStreams: false });

  // The object number the compression plan would carry for this image.
  const reloaded = await PDFDocument.load(bytes);
  const xobjs = reloaded.getPage(0).node.Resources()?.lookup(PDFName.of('XObject'), PDFDict);
  const [, ref] = [...xobjs!.entries()][0];
  if (!(ref instanceof PDFRef)) throw new Error('expected an indirect image');
  return { bytes, objectNumber: ref.objectNumber, pageCount };
}

describe('largerPlacement (CMP-03 size selection)', () => {
  const measured = (widthPt: number, heightPt: number) => ({
    objId: 'img_p0_1',
    widthPt,
    heightPt,
    measured: true
  });

  it('prefers the placement with the larger displayed area', () => {
    expect(largerPlacement(measured(400, 400), measured(100, 100))).toBe(true);
    expect(largerPlacement(measured(100, 100), measured(400, 400))).toBe(false);
  });

  it('lets an unmeasured placement win, because it needs the source resolution', () => {
    const unmeasured = { ...measured(1, 1), measured: false };
    expect(largerPlacement(unmeasured, measured(400, 400))).toBe(true);
    expect(largerPlacement(measured(400, 400), unmeasured)).toBe(false);
  });
});

describe('extractSharedImages encodes a shared image once (CMP-03)', () => {
  async function extract(doc: { bytes: Uint8Array; objectNumber: number; pageCount: number }) {
    encodes.length = 0;
    const { handle } = await renderWorkerImpl.loadDocument(doc.bytes);
    try {
      const requests = Array.from({ length: doc.pageCount }, (_, pageIndex) => ({
        pageIndex,
        objectNumbers: [doc.objectNumber]
      }));
      const out = await renderWorkerImpl.extractSharedImages(handle, requests, 0.7, 72);
      return { out, jpegEncodes: encodes.filter(e => e.type === 'image/jpeg') };
    } finally {
      await renderWorkerImpl.closeDocument(handle);
    }
  }

  it('encodes once for one page — the baseline', async () => {
    const { out, jpegEncodes } = await extract(await docSharingOneImage(1, [100]));
    expect(out).toHaveLength(1);
    expect(jpegEncodes).toHaveLength(1);
  }, 60_000);

  it('still encodes once when six pages reference the same image', async () => {
    const doc = await docSharingOneImage(6, [80, 100, 120, 140, 160, 500]);
    const { out, jpegEncodes } = await extract(doc);

    // One result, one encode — not one per page, which is the whole point.
    expect(out).toHaveLength(1);
    expect(out[0].objectNumber).toBe(doc.objectNumber);
    expect(jpegEncodes).toHaveLength(1);

    // And it is encoded at the *largest* page's size, not the first page's: the
    // 500pt placement at 72 DPI wants ~500px, the 80pt one only ~80px.
    expect(out[0].width).toBeGreaterThan(300);
    expect(jpegEncodes[0].width).toBe(out[0].width);
  }, 60_000);

  it('encodes each distinct image once when two images are shared across pages', async () => {
    const doc = await PDFDocument.create();
    const first = await doc.embedJpg(sourceJpeg(400));
    const second = await doc.embedJpg(sourceJpeg(300));
    for (let i = 0; i < 4; i++) {
      const page = doc.addPage([612, 792]);
      page.drawImage(first, { x: 20, y: 400, width: 100 + i * 50, height: 100 + i * 50 });
      page.drawImage(second, { x: 20, y: 40, width: 90, height: 90 });
    }
    const bytes = await doc.save({ useObjectStreams: false });

    const reloaded = await PDFDocument.load(bytes);
    const xobjs = reloaded.getPage(0).node.Resources()?.lookup(PDFName.of('XObject'), PDFDict);
    const objectNumbers = [...xobjs!.entries()]
      .map(([, ref]) => ref)
      .filter((ref): ref is PDFRef => ref instanceof PDFRef)
      .map(ref => ref.objectNumber);
    expect(objectNumbers).toHaveLength(2);

    encodes.length = 0;
    const { handle } = await renderWorkerImpl.loadDocument(bytes);
    try {
      const out = await renderWorkerImpl.extractSharedImages(
        handle,
        Array.from({ length: 4 }, (_, pageIndex) => ({ pageIndex, objectNumbers })),
        0.7,
        72
      );
      expect(new Set(out.map(o => o.objectNumber)).size).toBe(2);
      expect(out).toHaveLength(2);
      // Eight placements, two encodes.
      expect(encodes.filter(e => e.type === 'image/jpeg')).toHaveLength(2);
    } finally {
      await renderWorkerImpl.closeDocument(handle);
    }
  }, 60_000);
});
