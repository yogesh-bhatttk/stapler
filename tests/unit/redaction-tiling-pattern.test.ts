/**
 * HRD-41 follow-up — redaction through a tiling pattern's cell.
 *
 * A tiling pattern (`/PatternType 1`) is a content stream of its own, reached
 * from `/Resources /Pattern` and painted wherever a path (or text) is filled
 * with `/Pattern cs /P0 scn`. Nothing in the page's own content stream names
 * the image or the text inside the cell, so a mark over part of a
 * pattern-filled area used to leave the cell — image pixels and text alike —
 * intact in the file underneath the black box.
 *
 * Everything here runs the real pipeline on real bytes: the pdf-lib writer, the
 * pdf.js reader, real rasters, and the verifier that gates the save.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFStream,
  StandardFonts,
  decodePDFRawStream
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

// `any` throughout the shim: @napi-rs/canvas is resolved dynamically off
// pdfjs-dist's own optional dependency, so there are no types to import for it.

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
  transferToImageBitmap() {
    return this.canvas;
  }
  async convertToBlob({ type = 'image/png', quality }: { type?: string; quality?: number } = {}) {
    const buffer: Buffer =
      type === 'image/jpeg'
        ? this.canvas.toBuffer('image/jpeg', Math.round((quality ?? 0.92) * 100))
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
    ctx.putImageData(
      new canvasLib.ImageData(new Uint8ClampedArray(source.data), source.width, source.height),
      0,
      0
    );
    canvas.close = () => undefined;
    return canvas;
  };
}

// `any`: stand-ins for two Comlink `Remote<T>` proxies.
const stubs: { render: any; process: any } = { render: {}, process: {} };

vi.mock('../../src/core/workers', () => ({
  renderWorker: { lease: (fn: (api: any) => unknown) => fn(stubs.render) },
  processWorker: { lease: (fn: (api: any) => unknown) => fn(stubs.process) },
  cvWorker: { lease: () => undefined }
}));

const { renderWorkerImpl } = await import('../../src/core/workers/render.worker');
const { processWorkerImpl } = await import('../../src/core/workers/process.worker');
const { applyRedactions } = await import('../../src/core/operations');
const { encodePng } = await import('../../src/core/png');

/** Each Comlink argument crosses a structured-clone boundary in the real app. */
function cloningBoundary<T extends object>(api: T): T {
  return new Proxy(api, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) =>
        (value as (...a: unknown[]) => unknown).apply(
          target,
          args.map(arg => (arg instanceof Uint8Array ? arg.slice() : arg))
        );
    }
  }) as T;
}

function realWorkers() {
  stubs.render = cloningBoundary(renderWorkerImpl);
  stubs.process = cloningBoundary(processWorkerImpl);
}

const PAGE = { width: 200, height: 200 };
const SECRET = 'PATSECRET';

/** The mark, normalised display space (origin top-left). */
const MARK = { pageIndex: 0, x: 0.3, y: 0.3, width: 0.3, height: 0.25, text: '' };
/** The same mark in page space: x 60..120, y 90..140. */
const MARK_PT = { x0: 60, y0: 90, x1: 120, y1: 140 };

/** The image is drawn at x 20..180, y 60..180 inside the cell. */
const IMAGE_PT = { x: 20, y: 60, width: 160, height: 120 };

function photoPng(size = 120) {
  const rgbBytes = new Uint8Array(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const at = (y * size + x) * 3;
      rgbBytes[at] = 120 + ((x * 3) % 130);
      rgbBytes[at + 1] = 100 + ((y * 5) % 150);
      rgbBytes[at + 2] = 200 - ((x + y) % 120);
    }
  }
  return encodePng({ width: size, height: size, bitDepth: 8, colorType: 2, samples: rgbBytes });
}

interface FixtureOptions {
  /** XStep/YStep; the default is one tile covering the page. */
  step?: number;
  matrix?: [number, number, number, number, number, number];
  /** The cell's content stream; the default draws the photo and the secret. */
  cell?: string;
  /** Draw the pattern fill from inside a Form XObject instead of the page. */
  viaForm?: boolean;
  /** Also draw a second photo directly on the page, partly under the mark. */
  pageImage?: boolean;
  /** Replaces the page's pattern paint (default: the whole page filled with /P0). */
  fillOps?: string;
  /** Page content drawn after the pattern paint. */
  afterOps?: string;
  /** Extra page `/XObject` resources; `cellImage` is the image the cell draws. */
  pageXObjects?: (doc: PDFDocument, cellImage: PDFRef) => Record<string, PDFRef>;
  /** Leave `/BBox` out of the pattern dictionary. */
  noBBox?: boolean;
  /** Add a second, unmarked page that fills itself with the same pattern. */
  secondPage?: boolean;
}

/**
 * One page whose whole area is a rectangle filled with a tiling pattern. The
 * pattern's cell draws a photograph and a line of text (`SECRET`) under where
 * the mark goes; the page itself draws a caption outside the mark.
 */
async function patternPage(options: FixtureOptions = {}): Promise<{
  bytes: Uint8Array;
  imageRaw: Uint8Array;
  pageImageRaw?: Uint8Array;
}> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([PAGE.width, PAGE.height]);
  const image = await doc.embedPng(photoPng());
  await image.embed();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('kept caption', { x: 20, y: 20, size: 10, font });

  let pageImageRaw: Uint8Array | undefined;
  if (options.pageImage) {
    const second = await doc.embedPng(photoPng(90));
    await second.embed();
    // x 100..160, y 100..160: the mark (x 60..120, y 90..140) covers part of it.
    page.drawImage(second, { x: 100, y: 100, width: 60, height: 60 });
    pageImageRaw = (doc.context.lookup(second.ref) as PDFRawStream).getContents().slice();
  }
  const step = options.step ?? 200;
  const cell =
    options.cell ??
    `q ${IMAGE_PT.width} 0 0 ${IMAGE_PT.height} ${IMAGE_PT.x} ${IMAGE_PT.y} cm /Im0 Do Q\n` +
      `BT /F1 8 Tf 66 110 Td (${SECRET}) Tj ET\n`;
  const pattern = doc.context.flateStream(cell, {
    Type: 'Pattern',
    PatternType: 1,
    PaintType: 1,
    TilingType: 1,
    ...(options.noBBox ? {} : { BBox: [0, 0, step, step] }),
    XStep: step,
    YStep: step,
    ...(options.matrix ? { Matrix: options.matrix } : {}),
    Resources: { XObject: { Im0: image.ref }, Font: { F1: font.ref } }
  });
  const patternRef = doc.context.register(pattern);
  const resources = page.node.Resources()!;
  const fillOps =
    (options.fillOps ?? 'q /Pattern cs /P0 scn 0 0 200 200 re f Q\n') + (options.afterOps ?? '');
  let fill: PDFStream;
  if (options.viaForm) {
    const form = doc.context.flateStream(fillOps, {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 200, 200],
      Resources: { Pattern: { P0: patternRef } }
    });
    resources.set(PDFName.of('XObject'), doc.context.obj({ Fm0: doc.context.register(form) }));
    fill = doc.context.flateStream('q /Fm0 Do Q\n');
  } else {
    resources.set(PDFName.of('Pattern'), doc.context.obj({ P0: patternRef }));
    if (options.pageXObjects) {
      const existing = resources.lookupMaybe(PDFName.of('XObject'), PDFDict);
      const xObjects = existing ?? doc.context.obj({});
      for (const [key, ref] of Object.entries(options.pageXObjects(doc, image.ref))) {
        xObjects.set(PDFName.of(key), ref);
      }
      resources.set(PDFName.of('XObject'), xObjects);
    }
    fill = doc.context.flateStream(fillOps);
  }
  if (options.secondPage) {
    const second = doc.addPage([PAGE.width, PAGE.height]);
    second.node.set(
      PDFName.of('Resources'),
      doc.context.obj({ Pattern: doc.context.obj({ P0: patternRef }) })
    );
    second.node.set(
      PDFName.of('Contents'),
      doc.context.register(doc.context.flateStream('q /Pattern cs /P0 scn 0 0 200 200 re f Q\n'))
    );
  }
  const contents = page.node.Contents();
  const fillRef = doc.context.register(fill);
  const existing = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
  page.node.set(PDFName.of('Contents'), doc.context.obj([fillRef, ...existing]));

  const imageStream = doc.context.lookup(image.ref) as PDFRawStream;
  return {
    bytes: await doc.save(),
    imageRaw: imageStream.getContents().slice(),
    pageImageRaw
  };
}

const latin1 = (bytes: Uint8Array) => Buffer.from(bytes).toString('latin1');

/** Every stream in the file, decoded where pdf-lib can. */
async function decodedStreams(bytes: Uint8Array): Promise<{ raw: Uint8Array; decoded: string }[]> {
  const doc = await PDFDocument.load(bytes);
  const out: { raw: Uint8Array; decoded: string }[] = [];
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFStream)) continue;
    const raw = object.getContents();
    let decoded: string;
    try {
      decoded =
        object instanceof PDFRawStream ? latin1(decodePDFRawStream(object).decode()) : latin1(raw);
    } catch {
      // An image codec pdf-lib cannot decode: its raw bytes are searched instead.
      decoded = latin1(raw);
    }
    out.push({ raw, decoded });
  }
  return out;
}

function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  return Buffer.from(haystack).indexOf(Buffer.from(needle)) >= 0;
}

async function pageText(bytes: Uint8Array): Promise<string> {
  const { handle } = await renderWorkerImpl.loadDocument(bytes.slice());
  try {
    return (await renderWorkerImpl.documentText(handle)).join(' ');
  } finally {
    await renderWorkerImpl.closeDocument(handle);
  }
}

/** Renders page 1 and returns the RGBA of one page-space point. */
async function pixelAt(bytes: Uint8Array, x: number, y: number, pageNumber = 1): Promise<number[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: bytes.slice(), disableFontFace: true });
  const pdf = await task.promise;
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  const canvas = canvasLib.createCanvas(viewport.width, viewport.height);
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport, canvas } as never).promise;
  const data = ctx.getImageData(Math.round(x), Math.round(viewport.height - y), 1, 1).data;
  await task.destroy();
  return [...data];
}

describe('redaction through a tiling pattern (HRD-41)', () => {
  it('the fixture really hides its secret inside the pattern cell', async () => {
    const { bytes, imageRaw } = await patternPage();
    const streams = await decodedStreams(bytes);
    expect(streams.some(s => s.decoded.includes(SECRET))).toBe(true);
    expect(streams.some(s => containsBytes(s.raw, imageRaw))).toBe(true);
    // pdf.js's page text does not look inside patterns, which is why the
    // text half of the verifier cannot be the whole answer here.
    expect(await pageText(bytes)).not.toContain(SECRET);
    expect(await pageText(bytes)).toContain('kept caption');
    // The cell really paints: the photo shows at a point outside the mark.
    const [r, g, b] = await pixelAt(bytes, 150, 160);
    expect(r + g + b).toBeGreaterThan(200);
  }, 60_000);

  it('removes the cell content under the mark and keeps the rest', async () => {
    realWorkers();
    const { bytes, imageRaw } = await patternPage();
    const outcome = await applyRedactions(bytes, [MARK]);

    const streams = await decodedStreams(outcome.bytes);

    // The secret text is gone from every decoded stream, the pattern's included.
    expect(streams.filter(s => s.decoded.includes(SECRET))).toHaveLength(0);
    // The original image stream is gone too: no stream carries its bytes.
    expect(streams.filter(s => containsBytes(s.raw, imageRaw))).toHaveLength(0);
    expect(await pageText(outcome.bytes)).not.toContain(SECRET);
    expect(await pageText(outcome.bytes)).toContain('kept caption');

    // Uncovered parts of the pattern still paint the photograph.
    const [r, g, b] = await pixelAt(outcome.bytes, 150, 160);
    expect(r + g + b).toBeGreaterThan(200);
    // And the covered part is black.
    const [cr, cg, cb] = await pixelAt(outcome.bytes, 90, 115);
    expect(cr + cg + cb).toBeLessThan(60);

    expect(outcome.verified).toBe(true);
  }, 60_000);

  it('reaches every tile of a repeating pattern, and only the covered part of the cell', async () => {
    realWorkers();
    // A 50pt cell: the photo fills it, the secret sits at cell (12..40, 42..48).
    // The mark (page 60..120 × 90..140) covers cell x 10..50 ∪ 0..20 and
    // y 40..50 ∪ 0..40 — i.e. all of it — so instead use a mark that only
    // reaches the secret's band: page 60..90 × 90..100 → cell 10..40 × 40..50.
    const cell = 'q 50 0 0 50 0 0 cm /Im0 Do Q\n' + `BT /F1 6 Tf 12 42 Td (${SECRET}) Tj ET\n`;
    const { bytes, imageRaw } = await patternPage({ step: 50, cell });
    const mark = {
      pageIndex: 0,
      x: 60 / 200,
      y: 1 - 100 / 200,
      width: 30 / 200,
      height: 10 / 200,
      text: ''
    };
    const outcome = await applyRedactions(bytes, [mark]);
    const streams = await decodedStreams(outcome.bytes);
    expect(streams.filter(s => s.decoded.includes(SECRET))).toHaveLength(0);
    expect(streams.filter(s => containsBytes(s.raw, imageRaw))).toHaveLength(0);
    expect(outcome.verified).toBe(true);
    // A tile far from the mark still paints the photo below the secret's band.
    const [r, g, b] = await pixelAt(outcome.bytes, 25 + 100, 10 + 100);
    expect(r + g + b).toBeGreaterThan(200);
  }, 60_000);

  it('removes text from a text-only cell under a hand-drawn mark', async () => {
    realWorkers();
    const cell = `BT /F1 8 Tf 66 110 Td (${SECRET}) Tj ET\nBT /F1 8 Tf 20 170 Td (kept cell) Tj ET\n`;
    const { bytes } = await patternPage({ cell });
    const outcome = await applyRedactions(bytes, [MARK]);
    const streams = await decodedStreams(outcome.bytes);
    expect(streams.filter(s => s.decoded.includes(SECRET))).toHaveLength(0);
    expect(streams.some(s => s.decoded.includes('kept cell'))).toBe(true);
    expect(await pageText(outcome.bytes)).not.toContain(SECRET);
    expect(outcome.verified).toBe(true);
  }, 60_000);

  it('the verifier rejects an overlay that leaves the cell intact', async () => {
    const cell = `BT /F1 8 Tf 66 110 Td (${SECRET}) Tj ET\n`;
    const { bytes } = await patternPage({ cell });
    // The sabotage: the cover drawn, the pattern untouched.
    const doc = await PDFDocument.load(bytes);
    doc.getPages()[0].drawRectangle({
      x: MARK_PT.x0,
      y: MARK_PT.y0,
      width: MARK_PT.x1 - MARK_PT.x0,
      height: MARK_PT.y1 - MARK_PT.y0
    });
    const sabotaged = await doc.save();
    // Every other check is blind to it: the page text never had the secret,
    // and the region renders as solid fill.
    expect(await pageText(sabotaged)).not.toContain(SECRET);

    realWorkers();
    stubs.process = cloningBoundary({
      ...processWorkerImpl,
      applyRedactions: async () => sabotaged.slice(),
      scrubMetadata: async (input: Uint8Array) => input
    });
    const outcome = await applyRedactions(bytes, [MARK]);
    expect(outcome.verified).toBe(false);
    expect(outcome.verdicts[0].pass).toBe(false);
    expect(outcome.verdicts[0].detail).toMatch(/tiling pattern .* still draws content/);
  }, 60_000);

  it('handles a page image and a pattern image under the same mark together', async () => {
    realWorkers();
    const { bytes, imageRaw, pageImageRaw } = await patternPage({ pageImage: true });
    const outcome = await applyRedactions(bytes, [MARK]);
    const streams = await decodedStreams(outcome.bytes);
    expect(streams.filter(s => s.decoded.includes(SECRET))).toHaveLength(0);
    expect(streams.filter(s => containsBytes(s.raw, imageRaw))).toHaveLength(0);
    expect(streams.filter(s => containsBytes(s.raw, pageImageRaw!))).toHaveLength(0);
    expect(outcome.verified).toBe(true);
    // The page image's uncovered corner still shows.
    const [r, g, b] = await pixelAt(outcome.bytes, 150, 150);
    expect(r + g + b).toBeGreaterThan(200);
  }, 60_000);

  it('refuses a pattern drawn through a form, leaving nothing half-done', async () => {
    realWorkers();
    const { bytes } = await patternPage({ viaForm: true });
    await expect(applyRedactions(bytes, [MARK])).rejects.toThrow(
      /Form XObject fills with a tiling pattern/
    );
  }, 60_000);
});

/** Every tiling pattern's `/Resources /XObject` entry resolves to a real stream. */
async function patternRefsResolve(
  bytes: Uint8Array
): Promise<{ checked: number; dangling: number }> {
  const doc = await PDFDocument.load(bytes);
  let checked = 0;
  let dangling = 0;
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFStream)) continue;
    if (object.dict.get(PDFName.of('PatternType'))?.toString() !== '1') continue;
    const resources = object.dict.lookupMaybe(PDFName.of('Resources'), PDFDict);
    const xObjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
    for (const [, value] of xObjects?.entries() ?? []) {
      if (!(value instanceof PDFRef)) continue;
      checked++;
      if (!(doc.context.lookup(value) instanceof PDFStream)) dangling++;
    }
  }
  return { checked, dangling };
}

/** An 8×8 stencil mask whose every sample paints (`/Decode [0 1]`, sample 0). */
function stencilMask(doc: PDFDocument): PDFRef {
  return doc.context.register(
    doc.context.stream(new Uint8Array(8), {
      Type: 'XObject',
      Subtype: 'Image',
      Width: 8,
      Height: 8,
      ImageMask: true,
      BitsPerComponent: 1
    })
  );
}

/** A cell with the secret under the mark and a kept line outside it. */
const TEXT_CELL = `BT /F1 8 Tf 66 110 Td (${SECRET}) Tj ET\nBT /F1 8 Tf 20 170 Td (kept cell) Tj ET\n`;

describe('tiling-pattern redaction — review findings', () => {
  // ---- 1. A shared image must not be deleted while a pattern cell draws it. ----

  it('keeps an image a pattern cell draws when the page strips its own placement', async () => {
    realWorkers();
    // The cell draws the photo at 130..190 × 10..50, nowhere near the mark; the
    // page draws the *same image object* fully under the mark (70..110 × 100..130).
    const cell = 'q 60 0 0 40 130 10 cm /Im0 Do Q\n' + `BT /F1 8 Tf 66 110 Td (${SECRET}) Tj ET\n`;
    const { bytes, imageRaw } = await patternPage({
      cell,
      secondPage: true,
      pageXObjects: (_doc, cellImage) => ({ ImP: cellImage }),
      afterOps: 'q 40 0 0 30 70 100 cm /ImP Do Q\n'
    });
    const outcome = await applyRedactions(bytes, [MARK]);
    const refs = await patternRefsResolve(outcome.bytes);
    expect(refs.checked).toBeGreaterThan(0);
    expect(refs.dangling).toBe(0);
    // The image is still in the file, and both pages' patterns still paint it.
    const streams = await decodedStreams(outcome.bytes);
    expect(streams.some(s => containsBytes(s.raw, imageRaw))).toBe(true);
    for (const pageNumber of [1, 2]) {
      const [r, g, b] = await pixelAt(outcome.bytes, 160, 30, pageNumber);
      expect(r + g + b).toBeGreaterThan(200);
    }
    // Page 1's pattern lost the secret; page 2, unmarked, keeps the original.
    const out = await PDFDocument.load(outcome.bytes);
    const cellText = (pageIndex: number) => {
      const page = out.getPages()[pageIndex];
      const patterns = page.node.Resources()!.lookup(PDFName.of('Pattern'), PDFDict);
      const cell = out.context.lookup(patterns.get(PDFName.of('P0'))) as PDFRawStream;
      return latin1(decodePDFRawStream(cell).decode());
    };
    expect(cellText(0)).not.toContain(SECRET);
    expect(cellText(1)).toContain(SECRET);
    expect(outcome.verified).toBe(true);
  }, 60_000);

  it('keeps an image a pattern cell draws when the page replaces its own placement', async () => {
    realWorkers();
    const cell = 'q 60 0 0 40 130 10 cm /Im0 Do Q\n';
    const { bytes } = await patternPage({
      cell,
      pageXObjects: (_doc, cellImage) => ({ ImP: cellImage }),
      // 100..160 × 100..160: the mark (60..120 × 90..140) covers part of it.
      afterOps: 'q 60 0 0 60 100 100 cm /ImP Do Q\n'
    });
    const outcome = await applyRedactions(bytes, [MARK]);
    const refs = await patternRefsResolve(outcome.bytes);
    expect(refs.checked).toBeGreaterThan(0);
    expect(refs.dangling).toBe(0);
    const [r, g, b] = await pixelAt(outcome.bytes, 160, 30);
    expect(r + g + b).toBeGreaterThan(200);
    expect(outcome.verified).toBe(true);
  }, 60_000);

  it('face blur keeps an image a pattern cell still draws when it replaces a page placement', async () => {
    const cell = 'q 60 0 0 40 130 10 cm /Im0 Do Q\n';
    const { bytes } = await patternPage({
      cell,
      secondPage: true,
      pageXObjects: (_doc, cellImage) => ({ ImP: cellImage }),
      afterOps: 'q 40 0 0 30 70 100 cm /ImP Do Q\n'
    });
    const written = await processWorkerImpl.replacePageImages(bytes.slice(), {
      0: { ImP: { format: 'png', bytes: photoPng(10), width: 10, height: 10 } }
    });
    const refs = await patternRefsResolve(written);
    expect(refs.checked).toBeGreaterThan(0);
    expect(refs.dangling).toBe(0);
    const [r, g, b] = await pixelAt(written, 160, 30, 2);
    expect(r + g + b).toBeGreaterThan(200);
  }, 60_000);

  // ---- 2. Every paint that fills with the pattern records a footprint. ----

  it('redacts the cell under a stencil image mask filled with the pattern', async () => {
    realWorkers();
    const { bytes } = await patternPage({
      cell: TEXT_CELL,
      pageXObjects: doc => ({ Mk: stencilMask(doc) }),
      fillOps: 'q /Pattern cs /P0 scn 40 0 0 30 70 100 cm /Mk Do Q\n'
    });
    const outcome = await applyRedactions(bytes, [MARK]);
    const streams = await decodedStreams(outcome.bytes);
    expect(streams.filter(s => s.decoded.includes(SECRET))).toHaveLength(0);
    expect(streams.some(s => s.decoded.includes('kept cell'))).toBe(true);
    expect(outcome.verified).toBe(true);
  }, 60_000);

  it('redacts the cell under a fully covered form that paints with the inherited pattern', async () => {
    realWorkers();
    const { bytes } = await patternPage({
      cell: TEXT_CELL,
      pageXObjects: doc => ({
        Fm: doc.context.register(
          doc.context.flateStream('0 0 40 30 re f\n', {
            Type: 'XObject',
            Subtype: 'Form',
            BBox: [0, 0, 40, 30]
          })
        )
      }),
      fillOps: 'q /Pattern cs /P0 scn 1 0 0 1 70 100 cm /Fm Do Q\n'
    });
    const outcome = await applyRedactions(bytes, [MARK]);
    const streams = await decodedStreams(outcome.bytes);
    expect(streams.filter(s => s.decoded.includes(SECRET))).toHaveLength(0);
    expect(streams.some(s => s.decoded.includes('kept cell'))).toBe(true);
    expect(outcome.verified).toBe(true);
  }, 60_000);

  it('treats a fully covered form it cannot read (an inline image) as painting the pattern', async () => {
    realWorkers();
    const { bytes } = await patternPage({
      cell: TEXT_CELL,
      pageXObjects: doc => ({
        Fm: doc.context.register(
          doc.context.flateStream(
            'q 40 0 0 30 0 0 cm BI /W 8 /H 8 /IM true /BPC 1 ID \x00\x00\x00\x00\x00\x00\x00\x00 EI Q\n',
            { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 40, 30] }
          )
        )
      }),
      fillOps: 'q /Pattern cs /P0 scn 1 0 0 1 70 100 cm /Fm Do Q\n'
    });
    const outcome = await applyRedactions(bytes, [MARK]);
    const streams = await decodedStreams(outcome.bytes);
    expect(streams.filter(s => s.decoded.includes(SECRET))).toHaveLength(0);
    expect(outcome.verified).toBe(true);
  }, 60_000);

  it('leaves the cell alone for a covered form that sets its own colour', async () => {
    realWorkers();
    const { bytes } = await patternPage({
      cell: TEXT_CELL,
      pageXObjects: doc => ({
        Fm: doc.context.register(
          doc.context.flateStream('0 g 0 0 40 30 re f\n', {
            Type: 'XObject',
            Subtype: 'Form',
            BBox: [0, 0, 40, 30]
          })
        )
      }),
      fillOps: 'q /Pattern cs /P0 scn 1 0 0 1 70 100 cm /Fm Do Q\n'
    });
    const outcome = await applyRedactions(bytes, [MARK]);
    const streams = await decodedStreams(outcome.bytes);
    // Nothing paints the cell under the mark, so nothing in it is redacted.
    expect(streams.some(s => s.decoded.includes(SECRET))).toBe(true);
    expect(outcome.verified).toBe(true);
  }, 60_000);

  it('still refuses a page that draws an inline image', async () => {
    realWorkers();
    const { bytes } = await patternPage({
      cell: TEXT_CELL,
      fillOps:
        'q /Pattern cs /P0 scn 40 0 0 30 70 100 cm BI /W 8 /H 8 /IM true /BPC 1 ID ' +
        '\x00\x00\x00\x00\x00\x00\x00\x00 EI Q\n'
    });
    await expect(applyRedactions(bytes, [MARK])).rejects.toThrow(/inline images/);
  }, 60_000);

  it('the verifier rejects a stripped stencil mask that left the cell intact', async () => {
    const options = {
      cell: TEXT_CELL,
      pageXObjects: (doc: PDFDocument) => ({ Mk: stencilMask(doc) }),
      fillOps: 'q /Pattern cs /P0 scn 40 0 0 30 70 100 cm /Mk Do Q\n'
    };
    const { bytes } = await patternPage(options);
    // The sabotage: the mask's `Do` removed and the cover drawn, the cell untouched.
    const { bytes: stripped } = await patternPage({ ...options, fillOps: '' });
    const doc = await PDFDocument.load(stripped);
    doc.getPages()[0].drawRectangle({
      x: MARK_PT.x0,
      y: MARK_PT.y0,
      width: MARK_PT.x1 - MARK_PT.x0,
      height: MARK_PT.y1 - MARK_PT.y0
    });
    const sabotaged = await doc.save();

    realWorkers();
    stubs.process = cloningBoundary({
      ...processWorkerImpl,
      applyRedactions: async () => sabotaged.slice(),
      scrubMetadata: async (input: Uint8Array) => input
    });
    const outcome = await applyRedactions(bytes, [MARK]);
    expect(outcome.verified).toBe(false);
    expect(outcome.verdicts[0].detail).toMatch(/tiling pattern .* still draws content/);
  }, 60_000);

  // ---- 3. A stroke's footprint includes its line width. ----

  it('redacts cell content inside a thick pattern stroke but outside its centre line', async () => {
    realWorkers();
    // The centre lines span y 125..132; at 20pt the ink reaches y 115..142.
    // The secret's run (3pt type at y 136.5) is under the mark and under the
    // ink, but outside the stroke's point bounds.
    const cell =
      `BT /F1 3 Tf 66 136.5 Td (${SECRET}) Tj ET\n` + 'BT /F1 8 Tf 20 170 Td (kept cell) Tj ET\n';
    const { bytes } = await patternPage({
      cell,
      fillOps: 'q /Pattern CS /P0 SCN 20 w 0 125 m 200 125 l 0 132 m 200 132 l S Q\n'
    });
    const outcome = await applyRedactions(bytes, [MARK]);
    const streams = await decodedStreams(outcome.bytes);
    expect(streams.filter(s => s.decoded.includes(SECRET))).toHaveLength(0);
    expect(streams.some(s => s.decoded.includes('kept cell'))).toBe(true);
    expect(outcome.verified).toBe(true);
  }, 60_000);

  it('reaches a thick pattern stroke whose centre line is outside the mark', async () => {
    realWorkers();
    // Centre line at y 152, 30pt wide: the ink covers y 137..167, the mark ends at 140.
    const cell =
      `BT /F1 2 Tf 66 137.5 Td (${SECRET}) Tj ET\n` + 'BT /F1 8 Tf 20 170 Td (kept cell) Tj ET\n';
    const { bytes } = await patternPage({
      cell,
      fillOps: 'q /Pattern CS /P0 SCN 30 w 0 152 m 200 152 l S Q\n'
    });
    const outcome = await applyRedactions(bytes, [MARK]);
    const streams = await decodedStreams(outcome.bytes);
    expect(streams.filter(s => s.decoded.includes(SECRET))).toHaveLength(0);
    expect(streams.some(s => s.decoded.includes('kept cell'))).toBe(true);
    expect(outcome.verified).toBe(true);
  }, 60_000);

  // ---- 5. The cell filter reaches a fixed point through a rewritten form. ----

  it('verifies a cell whose partly covered run sits beside a partly covered form', async () => {
    realWorkers();
    // The run crosses the mark's left edge (so it comes back as a split TJ that
    // needs a second look), and the form crosses its top edge (so it is rewritten).
    const cell =
      'BT /F1 8 Tf 30 110 Td (ABCDEFGH) Tj ET\n' +
      'q 1 0 0 1 100 120 cm /FmC Do Q\n' +
      'BT /F1 8 Tf 20 170 Td (kept cell) Tj ET\n';
    const { bytes } = await patternPage({ cell });
    const doc = await PDFDocument.load(bytes);
    for (const [, object] of doc.context.enumerateIndirectObjects()) {
      if (!(object instanceof PDFStream)) continue;
      if (object.dict.get(PDFName.of('PatternType'))?.toString() !== '1') continue;
      const xObjects = object.dict
        .lookup(PDFName.of('Resources'), PDFDict)
        .lookup(PDFName.of('XObject'), PDFDict);
      xObjects.set(
        PDFName.of('FmC'),
        doc.context.register(
          doc.context.flateStream('q 0 0 1 rg 0 0 100 10 re f Q\n', {
            Type: 'XObject',
            Subtype: 'Form',
            BBox: [0, 0, 100, 10]
          })
        )
      );
    }
    const outcome = await applyRedactions(await doc.save(), [MARK]);
    const streams = await decodedStreams(outcome.bytes);
    expect(streams.some(s => s.decoded.includes('kept cell'))).toBe(true);
    expect(outcome.verdicts[0].detail).not.toMatch(/tiling pattern/);
    expect(outcome.verified).toBe(true);
  }, 60_000);

  it('through a rewritten form in a cell: removes the secret, and fails an overlay that did not', async () => {
    // The form spans x 60..160: its secret at x 70 is under the mark, its
    // second line at x 130 is not.
    const cell = 'q 1 0 0 1 60 100 cm /FmS Do Q\nBT /F1 8 Tf 30 110 Td (ABCDEFGH) Tj ET\n';
    const { bytes: plain } = await patternPage({ cell });
    const doc = await PDFDocument.load(plain);
    for (const [, object] of doc.context.enumerateIndirectObjects()) {
      if (!(object instanceof PDFStream)) continue;
      if (object.dict.get(PDFName.of('PatternType'))?.toString() !== '1') continue;
      const resources = object.dict.lookup(PDFName.of('Resources'), PDFDict);
      const font = resources.lookup(PDFName.of('Font'), PDFDict).get(PDFName.of('F1'));
      resources.lookup(PDFName.of('XObject'), PDFDict).set(
        PDFName.of('FmS'),
        doc.context.register(
          doc.context.flateStream(
            `BT /F1 6 Tf 10 5 Td (${SECRET}) Tj ET\nBT /F1 6 Tf 70 5 Td (formkept) Tj ET\n`,
            {
              Type: 'XObject',
              Subtype: 'Form',
              BBox: [0, 0, 100, 20],
              Resources: doc.context.obj({ Font: doc.context.obj({ F1: font }) })
            }
          )
        )
      );
    }
    const bytes = await doc.save();

    realWorkers();
    const outcome = await applyRedactions(bytes, [MARK]);
    const streams = await decodedStreams(outcome.bytes);
    expect(streams.filter(s => s.decoded.includes(SECRET))).toHaveLength(0);
    expect(streams.some(s => s.decoded.includes('formkept'))).toBe(true);
    expect(outcome.verified).toBe(true);

    const sabotage = await PDFDocument.load(bytes);
    sabotage.getPages()[0].drawRectangle({
      x: MARK_PT.x0,
      y: MARK_PT.y0,
      width: MARK_PT.x1 - MARK_PT.x0,
      height: MARK_PT.y1 - MARK_PT.y0
    });
    const sabotaged = await sabotage.save();
    stubs.process = cloningBoundary({
      ...processWorkerImpl,
      applyRedactions: async () => sabotaged.slice(),
      scrubMetadata: async (input: Uint8Array) => input
    });
    const refused = await applyRedactions(bytes, [MARK]);
    expect(refused.verified).toBe(false);
    expect(refused.verdicts[0].detail).toMatch(/tiling pattern .* still draws content/);
  }, 60_000);

  // ---- 4. Face/logo blur is not refused by pattern-redaction limits. ----

  it('logo marking on a page with an unreadable pattern background is not refused', async () => {
    realWorkers();
    for (const options of [
      { noBBox: true },
      { viaForm: true },
      // A cell this filter cannot parse: inline images are refused outright.
      {
        cell: 'q 40 0 0 30 70 100 cm BI /W 8 /H 8 /IM true /BPC 1 ID \x00\x00\x00\x00\x00\x00\x00\x00 EI Q\n'
      }
    ] as FixtureOptions[]) {
      const { bytes } = await patternPage({
        ...options,
        pageImage: !options.viaForm,
        cell: options.cell ?? TEXT_CELL
      });
      // The redaction planner still refuses — the cell under the mark cannot be proven clean.
      await expect(processWorkerImpl.planImageRedactions(bytes.slice(), [MARK])).rejects.toThrow();
      // The blur planner does not: it reports the pattern it could not look into.
      const plan = await processWorkerImpl.planLogoMark(bytes.slice(), MARK);
      if (!options.viaForm) expect(plan.requests.length).toBeGreaterThan(0);
      expect(plan.skipped.length).toBeGreaterThan(0);
      expect(plan.skipped[0].reason).not.toMatch(/redact/i);
    }
  }, 60_000);

  it('logo marking still finds a logo inside a readable pattern cell', async () => {
    realWorkers();
    const { bytes } = await patternPage();
    const plan = await processWorkerImpl.planLogoMark(bytes.slice(), MARK);
    expect(plan.requests.length).toBe(1);
    expect(plan.skipped).toHaveLength(0);
  }, 60_000);
});

describe('tiling-pattern redaction — cell parsing cost (review finding 6)', () => {
  /** `pages` pages sharing one tiling pattern, each painting it with `fillOps`. */
  async function sharedPatternDoc(pages: number, fillOps: string): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const pattern = doc.context.register(
      doc.context.flateStream(TEXT_CELL, {
        Type: 'Pattern',
        PatternType: 1,
        PaintType: 1,
        TilingType: 1,
        BBox: [0, 0, 200, 200],
        XStep: 200,
        YStep: 200,
        Resources: { Font: { F1: font.ref } }
      })
    );
    for (let i = 0; i < pages; i++) {
      const page = doc.addPage([PAGE.width, PAGE.height]);
      page.node.set(PDFName.of('Resources'), doc.context.obj({ Pattern: { P0: pattern } }));
      page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(fillOps)));
    }
    return doc.save();
  }

  /** How many times a tiling pattern's cell bytes are read during `run`. */
  async function cellReads(run: () => Promise<unknown>): Promise<number> {
    const original = PDFRawStream.prototype.getContents;
    let reads = 0;
    const spy = vi.spyOn(PDFRawStream.prototype, 'getContents').mockImplementation(function (
      this: PDFRawStream
    ) {
      if (this.dict.get(PDFName.of('PatternType'))?.toString() === '1') reads++;
      return original.call(this);
    });
    try {
      await run();
    } finally {
      spy.mockRestore();
    }
    return reads;
  }

  const marks = (pages: number) =>
    Array.from({ length: pages }, (_, i) => ({ ...MARK, pageIndex: i }));

  it('does not parse a pattern no mark reaches', async () => {
    // Painted at 0..20 × 0..20, far from the mark (60..120 × 90..140).
    const bytes = await sharedPatternDoc(12, 'q /Pattern cs /P0 scn 0 0 20 20 re f Q\n');
    const reads = await cellReads(() =>
      processWorkerImpl.planImageRedactions(bytes.slice(), marks(12))
    );
    expect(reads).toBe(0);
    const verifierReads = await cellReads(() =>
      processWorkerImpl.patternResidue(bytes.slice(), marks(12), bytes.slice())
    );
    expect(verifierReads).toBe(0);
  }, 60_000);

  it('parses a pattern shared by every marked page once', async () => {
    const bytes = await sharedPatternDoc(12, 'q /Pattern cs /P0 scn 0 0 200 200 re f Q\n');
    const reads = await cellReads(() =>
      processWorkerImpl.planImageRedactions(bytes.slice(), marks(12))
    );
    expect(reads).toBe(1);
  }, 60_000);
});
