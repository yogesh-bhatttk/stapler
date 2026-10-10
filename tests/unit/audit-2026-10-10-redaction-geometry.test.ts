/**
 * AUDIT-2026-10-10 P8, P9, P10 — redaction geometry and annotation fallout.
 *
 * - P8: a run drawn rotated (90° through `Tm`/`cm`) was laid out from its
 *   origin along +x, so find-and-mark drew its mark in a horizontal strip the
 *   text never occupied and the verifier checked that strip too.
 * - P9: `sh` paints a shading over the current clip with no path of its own; the
 *   filter's path test never saw it, so a shading under a mark was always kept
 *   while the redaction reported `verified`.
 * - P10: removing a markup annotation left its `/Popup` (and any `/IRT` reply)
 *   in `/Annots`, pointing at a deleted object.
 *
 * Everything runs the real pipeline on real bytes: pdf-lib writing, the pdf.js
 * reader and renderer, and the verifier that gates the save.
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
  PDFString,
  StandardFonts,
  decodePDFRawStream,
  degrees
} from 'pdf-lib';
import {
  GraphicsState,
  filterContentStream,
  parseContentStream,
  tokenizeContentStream
} from '../../src/core/pdf/interpreter';
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
const { applyRedactions, findTextRegions } = await import('../../src/core/operations');

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

const latin1 = (bytes: Uint8Array) => Buffer.from(bytes).toString('latin1');

/** Every stream in the file, decoded where pdf-lib can. */
async function decodedStreams(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes);
  const out: string[] = [];
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFStream)) continue;
    try {
      out.push(
        object instanceof PDFRawStream
          ? latin1(decodePDFRawStream(object).decode())
          : latin1(object.getContents())
      );
    } catch {
      out.push(latin1(object.getContents()));
    }
  }
  return out;
}

async function anyStreamContains(bytes: Uint8Array, needle: string): Promise<boolean> {
  return (await decodedStreams(bytes)).some(s => s.includes(needle));
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
async function pixelAt(bytes: Uint8Array, x: number, y: number): Promise<number[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: bytes.slice(), disableFontFace: true });
  const pdf = await task.promise;
  const p = await pdf.getPage(1);
  const viewport = p.getViewport({ scale: 1 });
  const canvas = canvasLib.createCanvas(viewport.width, viewport.height);
  const ctx = canvas.getContext('2d');
  await p.render({ canvasContext: ctx, viewport, canvas } as never).promise;
  const data = ctx.getImageData(Math.round(x), Math.round(viewport.height - y), 1, 1).data;
  await task.destroy();
  return [...data];
}

/* ------------------------------------------------------------------ *
 * P8 — rotated text
 * ------------------------------------------------------------------ */

describe('find-and-mark and verification on rotated text (P8)', () => {
  const W = 612;
  const H = 792;

  async function rotatedDoc(): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const page = doc.addPage([W, H]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText('SSN 123-45-6789', { x: 100, y: 300, size: 14, font, rotate: degrees(90) });
    page.drawText('Normal line of text', { x: 200, y: 600, size: 14, font });
    return doc.save();
  }

  /** A normalised (top-left) region as page-space bounds. */
  const pageBounds = (r: { x: number; y: number; width: number; height: number }) => ({
    x0: r.x * W,
    x1: (r.x + r.width) * W,
    y0: (1 - r.y - r.height) * H,
    y1: (1 - r.y) * H
  });

  it('marks the vertical strip the rotated run actually occupies', async () => {
    const bytes = await rotatedDoc();
    const { handle } = await renderWorkerImpl.loadDocument(bytes.slice());
    try {
      const regions = await renderWorkerImpl.findText(handle, '123-45-6789', false);
      expect(regions).toHaveLength(1);
      const b = pageBounds(regions[0]);
      // Glyphs rotated 90° about (100, 300) stand to the left of x 100 (one
      // font size, 14pt, deep) and run up the page from y 300.
      expect(b.x0).toBeCloseTo(86, 0);
      expect(b.x1).toBeCloseTo(100, 0);
      expect(b.y0).toBeGreaterThanOrEqual(300);
      expect(b.y1).toBeLessThanOrEqual(420);
      expect(b.y1 - b.y0).toBeGreaterThan(60);
      // The verifier looks in the same place: before redaction it finds the digits.
      const [check] = await renderWorkerImpl.checkRegionText(handle, regions);
      expect(check.foundText.replace(/\s/g, '')).toContain('123-45-6789');
    } finally {
      await renderWorkerImpl.closeDocument(handle);
    }
  }, 60_000);

  it('applyRedactions removes the rotated match and verifies', async () => {
    realWorkers();
    const bytes = await rotatedDoc();
    const regions = await findTextRegions(bytes, '123-45-6789', false);
    const outcome = await applyRedactions(bytes, regions);
    expect(outcome.verified).toBe(true);
    const text = await pageText(outcome.bytes);
    expect(text).not.toContain('123-45-6789');
    expect(text).toContain('Normal line of text');
    const residual = await processWorkerImpl.scanResidualText(
      outcome.bytes.slice(),
      ['123-45-6789'],
      [0]
    );
    expect(residual.found).toEqual([]);
  }, 60_000);

  it('an unrotated run is boxed exactly as before', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([W, H]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText('Account 99887766', { x: 72, y: 500, size: 12, font });
    const bytes = await doc.save();
    const { handle } = await renderWorkerImpl.loadDocument(bytes.slice());
    try {
      const [region] = await renderWorkerImpl.findText(handle, 'Account 99887766', false);
      const b = pageBounds(region);
      expect(b.x0).toBeCloseTo(72, 1);
      expect(b.y0).toBeCloseTo(500, 1);
      expect(b.y1).toBeCloseTo(512, 0);
    } finally {
      await renderWorkerImpl.closeDocument(handle);
    }
  }, 60_000);
});

/* ------------------------------------------------------------------ *
 * P9 — the `sh` operator
 * ------------------------------------------------------------------ */

const PAGE = { width: 200, height: 200 };
/** Normalised display space (origin top-left): page x 60..120, y 90..140. */
const MARK = { pageIndex: 0, x: 0.3, y: 0.3, width: 0.3, height: 0.25, text: '' };

/** Red → blue axial shading across the page (ShadingType 2). */
function axialShading(doc: PDFDocument) {
  return doc.context.register(
    doc.context.obj({
      ShadingType: 2,
      ColorSpace: 'DeviceRGB',
      Coords: [0, 0, 200, 0],
      Function: { FunctionType: 2, Domain: [0, 1], C0: [1, 0, 0], C1: [0, 0, 1], N: 1 },
      Extend: [true, true]
    })
  );
}

async function shadingPage(ops: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([PAGE.width, PAGE.height]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('kept caption', { x: 20, y: 20, size: 10, font });
  const resources = page.node.Resources()!;
  resources.set(
    PDFName.of('Shading'),
    doc.context.obj({ Sh0: axialShading(doc), Sh1: axialShading(doc) })
  );
  const contents = page.node.Contents();
  const own = doc.context.register(doc.context.flateStream(ops));
  const existing = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
  page.node.set(PDFName.of('Contents'), doc.context.obj([own, ...existing]));
  return doc.save();
}

const isColoured = ([r, g, b]: number[]) => Math.max(r, b) > 120 && g < 100;

describe('shadings painted with sh under a mark (P9)', () => {
  it('the fixture really paints the shading inside the mark', async () => {
    const bytes = await shadingPage('q 70 100 40 30 re W n /Sh0 sh Q\n');
    expect(isColoured(await pixelAt(bytes, 90, 115))).toBe(true);
  }, 60_000);

  it('drops a clipped sh inside the mark and keeps one clipped elsewhere', async () => {
    realWorkers();
    const bytes = await shadingPage(
      'q 70 100 40 30 re W n /Sh0 sh Q\nq 150 160 30 30 re W n /Sh1 sh Q\n'
    );
    const outcome = await applyRedactions(bytes, [MARK]);
    expect(await anyStreamContains(outcome.bytes, '/Sh0 sh')).toBe(false);
    expect(await anyStreamContains(outcome.bytes, '/Sh1 sh')).toBe(true);
    // Kept where it was clipped to, gone (under the black cover) where it was not.
    expect(isColoured(await pixelAt(outcome.bytes, 165, 175))).toBe(true);
    expect(isColoured(await pixelAt(outcome.bytes, 90, 115))).toBe(false);
    expect(await pageText(outcome.bytes)).toContain('kept caption');
    expect(outcome.verified).toBe(true);
  }, 60_000);

  it('drops an unclipped sh, which paints the whole page', async () => {
    realWorkers();
    const bytes = await shadingPage('q /Sh0 sh Q\n');
    const outcome = await applyRedactions(bytes, [MARK]);
    expect(await anyStreamContains(outcome.bytes, '/Sh0 sh')).toBe(false);
    expect(outcome.verified).toBe(true);
  }, 60_000);

  it('a clip ends at Q: an sh after it is judged against the page again', () => {
    const run = (source: string) =>
      filterContentStream(
        parseContentStream(tokenizeContentStream(Buffer.from(source, 'latin1'))),
        [{ x: 60, y: 60, width: 60, height: 50 }],
        new GraphicsState()
      ).filtered.map(s => Buffer.from(s.operator.bytes).toString('latin1'));
    // Clipped far from the mark: kept.
    expect(run('q 150 160 30 30 re W n /Sh0 sh Q')).toContain('sh');
    // Same clip, but the sh comes after the Q that ended it: page-wide, dropped.
    expect(run('q 150 160 30 30 re W n Q /Sh0 sh')).not.toContain('sh');
    // Nested clips intersect: the second clip alone would reach the mark.
    expect(run('q 150 160 30 30 re W n 0 0 200 200 re W n /Sh0 sh Q')).toContain('sh');
    // A clip under a cm is measured in device space.
    expect(run('q 1 0 0 1 100 100 cm 50 60 30 30 re W n /Sh0 sh Q')).toContain('sh');
    expect(run('q 1 0 0 1 -100 -100 cm 170 160 30 30 re W n /Sh0 sh Q')).not.toContain('sh');
    // The W and n survive whenever the sh goes, so later content stays clipped.
    expect(run('q 70 70 10 10 re W n /Sh0 sh Q')).toEqual(['q', 're', 'W', 'n', 'Q']);
  });
});

/* ------------------------------------------------------------------ *
 * P10 — popups and replies of a removed annotation
 * ------------------------------------------------------------------ */

describe('annotations hanging off a removed one (P10)', () => {
  async function annotatedPage(): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const page = doc.addPage([PAGE.width, PAGE.height]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText('kept caption', { x: 20, y: 20, size: 10, font });
    const ctx = doc.context;
    const pageRef = page.ref;
    // A sticky note inside the mark, its popup well outside it, and a reply
    // (also outside) that quotes it, with its own popup.
    const noteRef = ctx.nextRef();
    const popupRef = ctx.nextRef();
    const replyRef = ctx.nextRef();
    const replyPopupRef = ctx.nextRef();
    const farRef = ctx.nextRef();
    ctx.assign(
      noteRef,
      ctx.obj({
        Type: 'Annot',
        Subtype: 'Text',
        Rect: [80, 100, 100, 120],
        Contents: PDFString.of('NOTESECRET'),
        P: pageRef,
        Popup: popupRef
      })
    );
    ctx.assign(
      popupRef,
      ctx.obj({ Type: 'Annot', Subtype: 'Popup', Rect: [150, 150, 195, 195], Parent: noteRef })
    );
    ctx.assign(
      replyRef,
      ctx.obj({
        Type: 'Annot',
        Subtype: 'Text',
        Rect: [10, 170, 30, 190],
        Contents: PDFString.of('REPLYSECRET is the number'),
        IRT: noteRef,
        RT: 'R',
        P: pageRef,
        Popup: replyPopupRef
      })
    );
    ctx.assign(
      replyPopupRef,
      ctx.obj({ Type: 'Annot', Subtype: 'Popup', Rect: [10, 120, 50, 160], Parent: replyRef })
    );
    ctx.assign(
      farRef,
      ctx.obj({
        Type: 'Annot',
        Subtype: 'Text',
        Rect: [170, 10, 190, 30],
        Contents: PDFString.of('unrelated note'),
        P: pageRef
      })
    );
    page.node.set(
      PDFName.of('Annots'),
      ctx.obj([noteRef, popupRef, replyRef, replyPopupRef, farRef])
    );
    return doc.save();
  }

  it('removes the popup and the reply chain with the note, leaving no dangling reference', async () => {
    realWorkers();
    const bytes = await annotatedPage();
    const outcome = await applyRedactions(bytes, [MARK]);
    expect(outcome.verified).toBe(true);

    const doc = await PDFDocument.load(outcome.bytes);
    const annots = doc.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
    const dicts = annots.asArray().map(entry => {
      const dict = entry instanceof PDFRef ? doc.context.lookup(entry) : entry;
      expect(dict).toBeInstanceOf(PDFDict);
      return dict as PDFDict;
    });
    // Only the unrelated note survives.
    expect(dicts).toHaveLength(1);
    expect(dicts[0].lookup(PDFName.of('Contents'), PDFString).decodeText()).toBe('unrelated note');

    // Nothing anywhere in the file points at an object that no longer exists.
    for (const [, object] of doc.context.enumerateIndirectObjects()) {
      const dict = object instanceof PDFStream ? object.dict : object;
      if (!(dict instanceof PDFDict)) continue;
      for (const key of ['Parent', 'IRT', 'Popup']) {
        const value = dict.get(PDFName.of(key));
        if (value instanceof PDFRef) expect(doc.context.lookup(value)).toBeDefined();
      }
    }

    // The reply's text is gone from the bytes, not just unhooked.
    const strings: string[] = [];
    for (const [, object] of doc.context.enumerateIndirectObjects()) {
      const dict = object instanceof PDFStream ? object.dict : object;
      if (!(dict instanceof PDFDict)) continue;
      const contents = dict.lookup(PDFName.of('Contents'));
      if (contents instanceof PDFString) strings.push(contents.decodeText());
    }
    expect(strings.join('\n')).not.toContain('REPLYSECRET');
    expect(strings.join('\n')).not.toContain('NOTESECRET');
    expect(latin1(outcome.bytes)).not.toContain('REPLYSECRET');
  }, 60_000);
});
