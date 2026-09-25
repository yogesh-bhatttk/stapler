/**
 * PDF-14 — face/logo blur reaches images drawn through Form XObjects.
 *
 * Word, PowerPoint and Quartz exports routinely wrap a page's pictures in a form
 * XObject. Before this, `planPageImages` reported those pages as "not checked"
 * and nothing inside the form was blurred. Now the images are listed by object
 * number, decoded by pdf.js from the page's flattened operator list, and
 * substituted by copy-on-write cloning of every form on the path to them.
 *
 * What is proved here, against the produced bytes:
 *  • the real render worker decodes and blurs an image that sits inside a form;
 *  • only in-scope pages change — a form shared with an unselected page keeps
 *    drawing the original there;
 *  • page and form content streams are byte-identical (only image XObjects move);
 *  • the unblurred original is gone from the file when nothing references it,
 *    and kept — never left dangling — when something outside the pages does.
 */
import { describe, expect, it, vi } from 'vitest';
import { inflateSync } from 'node:zlib';
import {
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFStream,
  type PDFContext
} from 'pdf-lib';

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
const { encodePng } = await import('../../src/core/png');
const { silentJob } = await import('../../src/core/workers/protocol');

const SIZE = 32;

/** A smooth 32×32 RGB ramp: a mosaic visibly changes it, JPEG barely does. */
function texturedSamples(): Uint8Array {
  const samples = new Uint8Array(SIZE * SIZE * 3);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const p = (y * SIZE + x) * 3;
      samples[p] = (x * 8) & 0xff;
      samples[p + 1] = (y * 8) & 0xff;
      samples[p + 2] = 128;
    }
  }
  return samples;
}

const ORIGINAL = texturedSamples();
const PAGE_CONTENT = 'q 200 0 0 200 50 50 cm /Fm0 Do Q\n';
const FORM_CONTENT = 'q 1 0 0 1 0 0 cm /Im0 Do Q\n';

interface Built {
  bytes: Uint8Array;
  imageNumber: number;
  formNumber: number;
}

/**
 * `pages` pages, each drawing the same form, which draws the image. `nested`
 * puts a second form between the page's form and the image. `annotationAp`
 * also names the page-level form from an annotation's appearance — a
 * reference no page `/XObject` dict shows.
 */
async function build(
  options: { pages?: number; nested?: boolean; annotationAp?: boolean; directImage?: boolean } = {}
): Promise<Built> {
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const imageStream = ctx.stream(ORIGINAL, {
    Type: 'XObject',
    Subtype: 'Image',
    Width: SIZE,
    Height: SIZE,
    ColorSpace: 'DeviceRGB',
    BitsPerComponent: 8
  });
  const imageRef = ctx.register(imageStream);
  const form = (xobject: Record<string, PDFRef | PDFStream>) =>
    ctx.stream(FORM_CONTENT.replace('/Im0', `/${Object.keys(xobject)[0]}`), {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 1, 1],
      Resources: { XObject: xobject }
    });
  let formRef = ctx.register(form({ Im0: options.directImage ? imageStream : imageRef }));
  if (options.nested) formRef = ctx.register(form({ Inner: formRef }));

  for (let i = 0; i < (options.pages ?? 3); i++) {
    const page = doc.addPage([300, 300]);
    page.node.set(PDFName.of('Resources'), ctx.obj({ XObject: { Fm0: formRef } }));
    page.node.set(PDFName.of('Contents'), ctx.register(ctx.stream(PAGE_CONTENT)));
    if (options.annotationAp && i === 0) {
      const annot = ctx.obj({
        Type: 'Annot',
        Subtype: 'Stamp',
        Rect: [0, 0, 20, 20],
        AP: { N: formRef }
      });
      page.node.set(PDFName.of('Annots'), ctx.obj([ctx.register(annot)]));
    }
  }
  return {
    bytes: await doc.save({ useObjectStreams: false }),
    imageNumber: imageRef.objectNumber,
    formNumber: formRef.objectNumber
  };
}

function streamBytes(stream: PDFStream): Uint8Array {
  const raw = (stream as PDFRawStream).getContents();
  const filter = stream.dict.get(PDFName.of('Filter'));
  return filter === PDFName.of('FlateDecode') ? new Uint8Array(inflateSync(raw)) : raw;
}

function lookupStream(ctx: PDFContext, value: unknown): PDFStream {
  const resolved = value instanceof PDFRef ? ctx.lookup(value) : value;
  expect(resolved).toBeInstanceOf(PDFStream);
  return resolved as PDFStream;
}

/** Page → form (→ inner form) → image, following the resource names. */
function imageDrawnBy(doc: PDFDocument, pageIndex: number, nested = false) {
  const ctx = doc.context;
  const page = doc.getPage(pageIndex);
  const pageXObjects = page.node.Resources()!.lookup(PDFName.of('XObject'), PDFDict);
  const formValue = pageXObjects.get(PDFName.of('Fm0'));
  let form = lookupStream(ctx, formValue);
  const forms = [form];
  if (nested) {
    const res = form.dict.lookup(PDFName.of('Resources'), PDFDict);
    form = lookupStream(ctx, res.lookup(PDFName.of('XObject'), PDFDict).get(PDFName.of('Inner')));
    forms.push(form);
  }
  const res = form.dict.lookup(PDFName.of('Resources'), PDFDict);
  const imageValue = res.lookup(PDFName.of('XObject'), PDFDict).get(PDFName.of('Im0'));
  return {
    formRef: formValue as PDFRef,
    forms,
    imageRef: imageValue as PDFRef,
    samples: streamBytes(lookupStream(ctx, imageValue))
  };
}

function sameBytes(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function imagesMatchingOriginal(doc: PDFDocument): number {
  let count = 0;
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFStream)) continue;
    if (object.dict.get(PDFName.of('Subtype')) !== PDFName.of('Image')) continue;
    if (sameBytes(streamBytes(object), ORIGINAL)) count += 1;
  }
  return count;
}

/** A PNG replacement with every pixel changed, for the pure-surgery cases. */
const REPLACEMENT = {
  bytes: encodePng({
    width: SIZE,
    height: SIZE,
    bitDepth: 8,
    colorType: 2,
    samples: new Uint8Array(SIZE * SIZE * 3).fill(128)
  }),
  format: 'png' as const,
  width: SIZE,
  height: SIZE
};

function pageContentBytes(doc: PDFDocument, pageIndex: number): Uint8Array {
  return streamBytes(
    lookupStream(doc.context, doc.getPage(pageIndex).node.get(PDFName.of('Contents')))
  );
}

describe('PDF-14: planPageImages lists images inside forms', () => {
  it('flags them inForm, once per page, by object number', async () => {
    const { bytes, imageNumber } = await build({ nested: true });
    const plan = await processWorkerImpl.planPageImages(bytes, [0, 2]);
    expect(plan.formImagePages).toEqual([]);
    expect(plan.unaddressablePages).toEqual([]);
    expect(plan.images).toEqual([
      { pageIndex: 0, name: 'Im0', objectNumber: imageNumber, inForm: true },
      { pageIndex: 2, name: 'Im0', objectNumber: imageNumber, inForm: true }
    ]);
  });

  it('reports an image stored as a direct object inside a form as unaddressable', async () => {
    const { bytes } = await build({ directImage: true, pages: 1 });
    const plan = await processWorkerImpl.planPageImages(bytes, [0]);
    expect(plan.images).toEqual([]);
    expect(plan.unaddressablePages).toEqual([0]);
  });
});

describe('PDF-14: blurring an image inside a form, end to end', () => {
  it('decodes it with pdf.js, blurs it on the selected pages only, and touches nothing else', async () => {
    const { bytes, imageNumber, formNumber } = await build({ pages: 3 });
    const plan = await processWorkerImpl.planPageImages(bytes, [0, 1]);
    expect(plan.images.every(image => image.inForm)).toBe(true);

    // The real render worker, on the real pdf.js operator list: the image is
    // only reachable through the form.
    const { handle } = await renderWorkerImpl.loadDocument(bytes.slice());
    let blurred;
    try {
      const results = await renderWorkerImpl.blurPageImages(
        handle,
        0,
        [{ objectNumber: imageNumber, forcedRects: [{ x: 0, y: 0.5, width: 0.5, height: 0.5 }] }],
        { detectFaces: false, minScore: 0.5, strength: 'strong' },
        silentJob
      );
      expect(results).toHaveLength(1);
      expect(results[0].objectNumber).toBe(imageNumber);
      expect(results[0].regions.length).toBeGreaterThan(0);
      blurred = results[0].image;
    } finally {
      await renderWorkerImpl.closeDocument(handle);
    }
    expect(blurred).toBeDefined();

    const written = await processWorkerImpl.replacePageImages(bytes, {}, silentJob, {
      0: { [imageNumber]: blurred! },
      1: { [imageNumber]: blurred! }
    });
    const original = await PDFDocument.load(bytes);
    const out = await PDFDocument.load(written);
    expect(out.getPageCount()).toBe(3);

    const p0 = imageDrawnBy(out, 0);
    const p1 = imageDrawnBy(out, 1);
    const p2 = imageDrawnBy(out, 2);

    // Selected pages: one shared clone of the form, one new image.
    expect(p0.formRef.objectNumber).not.toBe(formNumber);
    expect(p1.formRef).toBe(p0.formRef);
    expect(p0.imageRef.objectNumber).not.toBe(imageNumber);
    expect(p1.imageRef).toBe(p0.imageRef);

    // The form now draws exactly the blurred image the render worker produced
    // (a JPEG is embedded verbatim), and pdf.js can decode it from inside the clone.
    const check = await renderWorkerImpl.loadDocument(written.slice());
    let after;
    try {
      after = await renderWorkerImpl.extractImageRegion(check.handle, 0, p0.imageRef.objectNumber, {
        x: 0,
        y: 0,
        width: 1,
        height: 1
      });
    } finally {
      await renderWorkerImpl.closeDocument(check.handle);
    }
    expect(after).not.toBeNull();
    expect(after!.width).toBe(SIZE);
    expect(after!.height).toBe(SIZE);
    const embeddedStream = lookupStream(out.context, p0.imageRef) as PDFRawStream;
    expect(sameBytes(embeddedStream.getContents(), blurred!.bytes)).toBe(true);
    expect(sameBytes(blurred!.bytes, ORIGINAL)).toBe(false);

    // The unselected page still draws the original form and image.
    expect(p2.formRef.objectNumber).toBe(formNumber);
    expect(p2.imageRef.objectNumber).toBe(imageNumber);
    expect(sameBytes(p2.samples, ORIGINAL)).toBe(true);

    // Text and vectors byte-untouched: page and form content streams.
    for (const i of [0, 1, 2]) {
      expect(sameBytes(pageContentBytes(out, i), pageContentBytes(original, i))).toBe(true);
    }
    expect(sameBytes(streamBytes(p0.forms[0]), streamBytes(p2.forms[0]))).toBe(true);

    // pdf.js still opens it and counts every page.
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = pdfjs.getDocument({ data: written.slice(), disableFontFace: true });
    expect((await task.promise).numPages).toBe(3);
    await task.destroy();
  }, 60_000);
});

describe('PDF-14: substitution inside forms — the file-level guarantees', () => {
  it('purges the unblurred original once no page draws it', async () => {
    const { bytes, imageNumber, formNumber } = await build({ pages: 2 });
    const written = await processWorkerImpl.replacePageImages(bytes, {}, silentJob, {
      0: { [imageNumber]: REPLACEMENT },
      1: { [imageNumber]: REPLACEMENT }
    });
    const out = await PDFDocument.load(written);
    expect(imagesMatchingOriginal(out)).toBe(0);
    expect(out.context.lookup(PDFRef.of(formNumber))).toBeUndefined();
    expect(sameBytes(imageDrawnBy(out, 0).samples, ORIGINAL)).toBe(false);
  });

  it('reaches an image two forms deep and purges both original forms', async () => {
    const { bytes, imageNumber, formNumber } = await build({ pages: 2, nested: true });
    const written = await processWorkerImpl.replacePageImages(bytes, {}, silentJob, {
      0: { [imageNumber]: REPLACEMENT },
      1: { [imageNumber]: REPLACEMENT }
    });
    const out = await PDFDocument.load(written);
    for (const i of [0, 1]) {
      const drawn = imageDrawnBy(out, i, true);
      expect(drawn.samples.every(v => v === 128)).toBe(true);
    }
    expect(imagesMatchingOriginal(out)).toBe(0);
    expect(out.context.lookup(PDFRef.of(formNumber))).toBeUndefined();
  });

  it('keeps an original form another object still names, instead of leaving it dangling', async () => {
    const { bytes, imageNumber, formNumber } = await build({ pages: 1, annotationAp: true });
    const written = await processWorkerImpl.replacePageImages(bytes, {}, silentJob, {
      0: { [imageNumber]: REPLACEMENT }
    });
    const out = await PDFDocument.load(written);
    // The page draws the blurred clone…
    expect(imageDrawnBy(out, 0).samples.every(v => v === 128)).toBe(true);
    // …and the annotation appearance still resolves to a real stream.
    const annots = out.getPage(0).node.Annots()!;
    const annot = out.context.lookup(annots.get(0), PDFDict);
    const ap = annot.lookup(PDFName.of('AP'), PDFDict).get(PDFName.of('N')) as PDFRef;
    expect(ap.objectNumber).toBe(formNumber);
    expect(out.context.lookup(ap)).toBeInstanceOf(PDFStream);
  });

  it('refuses a form replacement that lands on no form, rather than reporting it done', async () => {
    const { bytes } = await build({ pages: 1 });
    await expect(
      processWorkerImpl.replacePageImages(bytes, {}, silentJob, { 0: { 99999: REPLACEMENT } })
    ).rejects.toThrow(/no form on the page draws that image/);
  });
});
