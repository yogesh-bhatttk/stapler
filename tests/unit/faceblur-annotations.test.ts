/**
 * HRD-41 (AUDIT-2026-09-25 PDF-14) — face/logo blur and images that only an
 * annotation appearance or a tiling pattern draws.
 *
 * An appearance stream is a form reached from `/Annots → /AP`, not from the
 * page's `/Resources`, so the planner never saw an image in one: a photo stamp
 * kept its face, and the report said nothing. Now:
 *  • an image in a *painted* appearance is listed, decoded by the real pdf.js
 *    operator list, blurred, and substituted by copy-on-write of the appearance;
 *  • an image in a tiling pattern's cell is planned, reached by the render
 *    worker through the pattern's operator list, and substituted by
 *    copy-on-write of the pattern;
 *  • an image only a hidden annotation or an alternate look draws cannot be
 *    decoded — the plan reports the page so the run says "not checked" instead
 *    of "no faces found".
 */
import { describe, expect, it, vi } from 'vitest';
import { inflateSync } from 'node:zlib';
import { PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, PDFStream } from 'pdf-lib';

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
// own optional dependency, so there are no types to import for it (same shim
// as `logo-blur-dedup.test.ts`).
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
    const buffer: Buffer =
      type === 'image/jpeg'
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
if (typeof (globalThis as { ImageData?: unknown }).ImageData === 'undefined') {
  (globalThis as any).ImageData = canvasLib.ImageData;
}
if (typeof (globalThis as { createImageBitmap?: unknown }).createImageBitmap === 'undefined') {
  (globalThis as any).createImageBitmap = async (source: ImageData) => {
    const canvas = canvasLib.createCanvas(source.width, source.height);
    const ctx = canvas.getContext('2d');
    ctx.putImageData(
      new canvasLib.ImageData(new Uint8ClampedArray(source.data), source.width, source.height),
      0,
      0
    );
    canvas.close = () => undefined;
    return canvas;
  };
}

const { processWorkerImpl } = await import('../../src/core/workers/process.worker');
const { renderWorkerImpl } = await import('../../src/core/workers/render.worker');
const { silentJob } = await import('../../src/core/workers/protocol');

const SIZE = 32;
const ORIGINAL = new Uint8Array(SIZE * SIZE * 3).map((_, i) => (i * 7) & 0xff);

function streamBytes(stream: PDFStream): Uint8Array {
  const raw = (stream as PDFRawStream).getContents();
  const filter = stream.dict.get(PDFName.of('Filter'));
  return filter === PDFName.of('FlateDecode') ? new Uint8Array(inflateSync(raw)) : raw;
}

function imagesMatchingOriginal(doc: PDFDocument): number {
  let count = 0;
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFStream)) continue;
    if (object.dict.get(PDFName.of('Subtype')) !== PDFName.of('Image')) continue;
    const b = streamBytes(object);
    if (b.length === ORIGINAL.length && b.every((v, i) => v === ORIGINAL[i])) count += 1;
  }
  return count;
}

/** One page; the image is drawn only by a stamp annotation's appearance (or a pattern). */
async function build(
  options: { hidden?: boolean; stateful?: 'active' | 'inactive'; pattern?: boolean } = {}
) {
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const imageRef = ctx.register(
    ctx.stream(ORIGINAL, {
      Type: 'XObject',
      Subtype: 'Image',
      Width: SIZE,
      Height: SIZE,
      ColorSpace: 'DeviceRGB',
      BitsPerComponent: 8
    })
  );
  const page = doc.addPage([300, 300]);
  if (options.pattern) {
    const cell = ctx.register(
      ctx.stream('q 20 0 0 20 0 0 cm /Im0 Do Q', {
        Type: 'Pattern',
        PatternType: 1,
        PaintType: 1,
        TilingType: 1,
        BBox: [0, 0, 20, 20],
        XStep: 20,
        YStep: 20,
        Resources: { XObject: { Im0: imageRef } }
      })
    );
    page.node.set(PDFName.of('Resources'), ctx.obj({ Pattern: { P0: cell } }));
    page.node.set(
      PDFName.of('Contents'),
      ctx.register(ctx.stream('/Pattern cs /P0 scn 0 0 300 300 re f'))
    );
    return { bytes: await doc.save({ useObjectStreams: false }), imageRef };
  }
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.stream('')));
  const appearance = ctx.register(
    ctx.stream('q 100 0 0 100 0 0 cm /Im0 Do Q', {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 100, 100],
      Resources: { XObject: { Im0: imageRef } }
    })
  );
  const blank = ctx.register(
    ctx.stream('', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 100] })
  );
  const ap = options.stateful ? { N: { On: appearance, Off: blank } } : { N: appearance };
  const annot = ctx.register(
    ctx.obj({
      Type: 'Annot',
      Subtype: 'Stamp',
      Rect: [50, 50, 150, 150],
      F: options.hidden ? 2 : 4,
      ...(options.stateful ? { AS: options.stateful === 'active' ? 'On' : 'Off' } : {}),
      AP: ap
    })
  );
  page.node.set(PDFName.of('Annots'), ctx.obj([annot]));
  return { bytes: await doc.save({ useObjectStreams: false }), imageRef, appearance };
}

describe('HRD-41: images drawn only by an annotation appearance', () => {
  it('are planned, decoded by pdf.js, blurred and substituted; the original is gone', async () => {
    const { bytes, imageRef, appearance } = await build();
    const plan = await processWorkerImpl.planPageImages(bytes, [0]);
    expect(plan.images).toEqual([
      { pageIndex: 0, name: 'Im0', objectNumber: imageRef.objectNumber, inForm: true }
    ]);
    expect(plan.hiddenAppearancePages).toEqual([]);

    const { handle } = await renderWorkerImpl.loadDocument(bytes.slice());
    let blurred;
    try {
      const [result] = await renderWorkerImpl.blurPageImages(
        handle,
        0,
        [
          {
            objectNumber: imageRef.objectNumber,
            forcedRects: [{ x: 0, y: 0, width: 1, height: 1 }]
          }
        ],
        { detectFaces: false, minScore: 0.5, strength: 'strong' },
        silentJob
      );
      expect(result.reason).toBeUndefined();
      blurred = result.image;
    } finally {
      await renderWorkerImpl.closeDocument(handle);
    }
    expect(blurred).toBeDefined();

    const written = await processWorkerImpl.replacePageImages(bytes, {}, silentJob, {
      0: { [imageRef.objectNumber]: blurred! }
    });
    const out = await PDFDocument.load(written);
    expect(out.getPageCount()).toBe(1);
    const annot = out.context.lookup(out.getPage(0).node.Annots()!.get(0), PDFDict);
    const n = annot.lookup(PDFName.of('AP'), PDFDict).get(PDFName.of('N')) as PDFRef;
    expect(n.objectNumber).not.toBe(appearance!.objectNumber);
    const clone = out.context.lookup(n) as PDFRawStream;
    // Appearance content bytes untouched: only the image reference moved.
    expect(Buffer.from(streamBytes(clone)).toString()).toBe('q 100 0 0 100 0 0 cm /Im0 Do Q');
    const im = clone.dict
      .lookup(PDFName.of('Resources'), PDFDict)
      .lookup(PDFName.of('XObject'), PDFDict)
      .get(PDFName.of('Im0')) as PDFRef;
    expect(im.objectNumber).not.toBe(imageRef.objectNumber);
    expect(imagesMatchingOriginal(out)).toBe(0);

    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = pdfjs.getDocument({ data: written.slice(), disableFontFace: true });
    expect((await task.promise).numPages).toBe(1);
    await task.destroy();
  }, 60_000);

  it('the active state of an appearance sub-dictionary is planned', async () => {
    const { bytes, imageRef } = await build({ stateful: 'active' });
    const plan = await processWorkerImpl.planPageImages(bytes, [0]);
    expect(plan.images.map(i => i.objectNumber)).toEqual([imageRef.objectNumber]);
    expect(plan.hiddenAppearancePages).toEqual([]);
  });

  it('an inactive state or a hidden annotation is reported, not silently skipped', async () => {
    for (const options of [{ stateful: 'inactive' as const }, { hidden: true }]) {
      const { bytes } = await build(options);
      const plan = await processWorkerImpl.planPageImages(bytes, [0]);
      expect(plan.images).toEqual([]);
      expect(plan.hiddenAppearancePages).toEqual([0]);
    }
  });
});

describe('HRD-41: images inside a tiling pattern', () => {
  it('are planned, decoded through the pattern, blurred and substituted; the original is gone', async () => {
    const { bytes, imageRef } = await build({ pattern: true });
    const plan = await processWorkerImpl.planPageImages(bytes, [0]);
    expect(plan.images).toEqual([
      { pageIndex: 0, name: 'Im0', objectNumber: imageRef.objectNumber, inForm: true }
    ]);
    expect(plan.formImagePages).toEqual([]);
    expect(plan.unaddressablePages).toEqual([]);

    // The render worker reaches the image through the pattern's own operator
    // list — before HRD-41's walker change it was never found at all.
    const { handle } = await renderWorkerImpl.loadDocument(bytes.slice());
    let blurred;
    try {
      const [result] = await renderWorkerImpl.blurPageImages(
        handle,
        0,
        [
          {
            objectNumber: imageRef.objectNumber,
            forcedRects: [{ x: 0, y: 0, width: 1, height: 1 }]
          }
        ],
        { detectFaces: false, minScore: 0.5, strength: 'strong' },
        silentJob
      );
      expect(result.reason).toBeUndefined();
      blurred = result.image;
    } finally {
      await renderWorkerImpl.closeDocument(handle);
    }
    expect(blurred).toBeDefined();

    const source = await PDFDocument.load(bytes);
    const sourcePattern = source
      .getPage(0)
      .node.Resources()!
      .lookup(PDFName.of('Pattern'), PDFDict)
      .get(PDFName.of('P0')) as PDFRef;
    const sourceContents = streamBytes(
      source.context.lookup(
        source.getPage(0).node.get(PDFName.of('Contents')) as PDFRef
      ) as PDFStream
    );

    const written = await processWorkerImpl.replacePageImages(bytes, {}, silentJob, {
      0: { [imageRef.objectNumber]: blurred! }
    });
    const out = await PDFDocument.load(written);
    expect(out.getPageCount()).toBe(1);
    const page = out.getPage(0);
    const p0 = page.node
      .Resources()!
      .lookup(PDFName.of('Pattern'), PDFDict)
      .get(PDFName.of('P0')) as PDFRef;
    expect(p0.objectNumber).not.toBe(sourcePattern.objectNumber);
    const clone = out.context.lookup(p0) as PDFRawStream;
    // Cell content bytes untouched, and the page's own content too: only the
    // image reference moved.
    expect(Buffer.from(streamBytes(clone)).toString()).toBe('q 20 0 0 20 0 0 cm /Im0 Do Q');
    expect(
      Buffer.from(
        streamBytes(
          out.context.lookup(page.node.get(PDFName.of('Contents')) as PDFRef) as PDFStream
        )
      ).toString()
    ).toBe(Buffer.from(sourceContents).toString());
    // The pattern keeps its own dictionary.
    expect(clone.dict.get(PDFName.of('XStep'))?.toString()).toBe('20');
    const im = clone.dict
      .lookup(PDFName.of('Resources'), PDFDict)
      .lookup(PDFName.of('XObject'), PDFDict)
      .get(PDFName.of('Im0')) as PDFRef;
    expect(im.objectNumber).not.toBe(imageRef.objectNumber);
    expect(imagesMatchingOriginal(out)).toBe(0);

    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = pdfjs.getDocument({ data: written.slice(), disableFontFace: true });
    const pdf = await task.promise;
    expect(pdf.numPages).toBe(1);
    // pdf.js still paints the (now blurred) image from the pattern.
    const ops = await (await pdf.getPage(1)).getOperatorList();
    expect(ops.fnArray).toContain(pdfjs.OPS.setFillColorN);
    await task.destroy();
  }, 60_000);
});
