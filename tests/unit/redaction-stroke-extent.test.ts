/**
 * Stroke extent under redaction: line width set through `/ExtGState`, and
 * stroked text (`Tr` 1, 2, 5, 6).
 *
 * A stroke's ink reaches past its path by up to half the line width (further at
 * a mitred corner). The filter already measured that for `w`; these are the two
 * places the width came from somewhere it did not look:
 *
 * - `/GS0 gs` with `/LW 20` in the ExtGState dictionary — the width every
 *   viewer strokes with, which the filter took to be the default 1;
 * - text drawn with a stroking render mode, whose outline is stroked with the
 *   current line width and so reaches past the glyph box the filter tested.
 *
 * Both left ink inside a mark while the redaction reported `verified`: the
 * cover hides it on screen, so neither the text nor the pixel check can see it.
 *
 * Everything here runs the real pipeline on real bytes: the pdf-lib writer, the
 * pdf.js reader and renderer, and the verifier that gates the save.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  PDFArray,
  PDFDocument,
  PDFName,
  PDFRawStream,
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
/** The mark, normalised display space (origin top-left): page x 60..120, y 90..140. */
const MARK = { pageIndex: 0, x: 0.3, y: 0.3, width: 0.3, height: 0.25, text: '' };

interface PageOptions {
  /** The page's own content, drawn before a caption outside the mark. */
  ops: string;
  /** `/ExtGState` resources, as pdf-lib literal objects. */
  extGState?: Record<string, Record<string, unknown>>;
  /** A tiling pattern `/P0` whose cell draws this content. */
  patternCell?: string;
}

async function page(options: PageOptions): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const pdfPage = doc.addPage([PAGE.width, PAGE.height]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  pdfPage.drawText('kept caption', { x: 20, y: 20, size: 10, font });
  const resources = pdfPage.node.Resources()!;
  if (options.extGState) {
    const states = doc.context.obj({});
    for (const [name, entries] of Object.entries(options.extGState)) {
      states.set(PDFName.of(name), doc.context.register(doc.context.obj(entries as never)));
    }
    resources.set(PDFName.of('ExtGState'), states);
  }
  if (options.patternCell) {
    const pattern = doc.context.flateStream(options.patternCell, {
      Type: 'Pattern',
      PatternType: 1,
      PaintType: 1,
      TilingType: 1,
      BBox: [0, 0, 200, 200],
      XStep: 200,
      YStep: 200,
      Resources: { Font: { F1: font.ref } }
    });
    resources.set(PDFName.of('Pattern'), doc.context.obj({ P0: doc.context.register(pattern) }));
  }
  // `drawText` registered the font under its own name; alias it as /F1 for
  // the hand-written operators below.
  const fonts = resources.lookup(PDFName.of('Font')) as never as {
    set(key: PDFName, value: unknown): void;
  };
  fonts.set(PDFName.of('F1'), font.ref);
  const contents = pdfPage.node.Contents();
  const ownRef = doc.context.register(doc.context.flateStream(options.ops));
  const existing = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
  pdfPage.node.set(PDFName.of('Contents'), doc.context.obj([ownRef, ...existing]));
  return doc.save();
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

/** Blue-dominant: the strokes below are all `0 0 1 RG`. */
const isBlue = ([r, g, b]: number[]) => b > 150 && r < 100 && g < 100;

// Centre line at y 148, 20pt wide: the ink covers y 138..158 and the mark ends
// at 140. The point bounds (y 148) are 8pt clear of it.
const THICK_LINE = '0 148 m 200 148 l S';
// A 3pt line well away from the mark, which must survive every case below.
const FAR_LINE = '3 w 0 190 m 200 190 l S';

describe('line width set through /ExtGState', () => {
  it('the fixture really strokes 20pt wide through gs', async () => {
    const bytes = await page({
      ops: `q 0 0 1 RG /GS0 gs ${THICK_LINE} Q\n`,
      extGState: { GS0: { Type: 'ExtGState', LW: 20 } }
    });
    // Ink at y 139 — inside the mark, 9pt below the centre line.
    expect(isBlue(await pixelAt(bytes, 90, 139))).toBe(true);
  }, 60_000);

  it('removes a thick stroke whose /LW ink enters the mark', async () => {
    realWorkers();
    const bytes = await page({
      ops: `q 0 0 1 RG /GS0 gs ${THICK_LINE} Q\nq 0 0 1 RG ${FAR_LINE} Q\n`,
      extGState: { GS0: { Type: 'ExtGState', LW: 20 } }
    });
    const outcome = await applyRedactions(bytes, [MARK]);
    expect(await anyStreamContains(outcome.bytes, '0 148 m')).toBe(false);
    expect(await anyStreamContains(outcome.bytes, '0 190 m')).toBe(true);
    expect(await pageText(outcome.bytes)).toContain('kept caption');
    // Outside the mark, where the stroke used to paint, it no longer does.
    expect(isBlue(await pixelAt(outcome.bytes, 150, 148))).toBe(false);
    expect(isBlue(await pixelAt(outcome.bytes, 150, 190))).toBe(true);
    expect(outcome.verified).toBe(true);
  }, 60_000);

  it('a dash pattern in the same ExtGState does not shrink the reach', async () => {
    realWorkers();
    const bytes = await page({
      ops: `q 0 0 1 RG /GS0 gs ${THICK_LINE} Q\n`,
      extGState: { GS0: { Type: 'ExtGState', LW: 20, D: [[3, 3], 0] } }
    });
    const outcome = await applyRedactions(bytes, [MARK]);
    expect(await anyStreamContains(outcome.bytes, '0 148 m')).toBe(false);
    expect(outcome.verified).toBe(true);
  }, 60_000);

  it('a later w and a Q both end the ExtGState width', async () => {
    realWorkers();
    // `1 w` after the gs, and a stroke after the Q: both are hairlines again.
    const bytes = await page({
      ops:
        `q 0 0 1 RG /GS0 gs 1 w 0 146 m 200 146 l S Q\n` +
        `q 0 0 1 RG /GS0 gs Q 0 0 1 RG 0 145 m 200 145 l S\n`,
      extGState: { GS0: { Type: 'ExtGState', LW: 20 } }
    });
    const outcome = await applyRedactions(bytes, [MARK]);
    expect(await anyStreamContains(outcome.bytes, '0 146 m')).toBe(true);
    expect(await anyStreamContains(outcome.bytes, '0 145 m')).toBe(true);
    expect(outcome.verified).toBe(true);
  }, 60_000);

  it('fails closed on an ExtGState it cannot resolve: the stroke goes', async () => {
    realWorkers();
    // /GSX is not in the resources, and /GSN's /LW is not a number. Either way
    // the width is unknown, so a hairline 8pt clear of the mark is taken out —
    // but only inside that q/Q; the far line after it is untouched.
    const bytes = await page({
      ops:
        `q 0 0 1 RG /GSX gs ${THICK_LINE} Q\n` +
        `q 0 0 1 RG /GSN gs 0 160 m 200 160 l S Q\n` +
        `q 0 0 1 RG ${FAR_LINE} Q\n`,
      extGState: { GSN: { Type: 'ExtGState', LW: 'Twenty' } }
    });
    const outcome = await applyRedactions(bytes, [MARK]);
    expect(await anyStreamContains(outcome.bytes, '0 148 m')).toBe(false);
    expect(await anyStreamContains(outcome.bytes, '0 160 m')).toBe(false);
    expect(await anyStreamContains(outcome.bytes, '0 190 m')).toBe(true);
    expect(outcome.verified).toBe(true);
  }, 60_000);

  it('redacts a pattern cell under a stroke widened through /ExtGState', async () => {
    realWorkers();
    // Centre line at y 152, 30pt wide through gs: the ink covers y 137..167,
    // the mark ends at 140, and the cell's secret sits at y 137.5..139.5.
    const cell =
      'BT /F1 2 Tf 66 137.5 Td (GSPATSECRET) Tj ET\nBT /F1 8 Tf 20 170 Td (kept cell) Tj ET\n';
    const bytes = await page({
      ops: 'q /Pattern CS /P0 SCN /GS0 gs 0 152 m 200 152 l S Q\n',
      extGState: { GS0: { Type: 'ExtGState', LW: 30 } },
      patternCell: cell
    });
    expect(await anyStreamContains(bytes, 'GSPATSECRET')).toBe(true);
    const outcome = await applyRedactions(bytes, [MARK]);
    expect(await anyStreamContains(outcome.bytes, 'GSPATSECRET')).toBe(false);
    expect(await anyStreamContains(outcome.bytes, 'kept cell')).toBe(true);
    expect(outcome.verified).toBe(true);
  }, 60_000);
});

describe('stroked text (Tr 1, 2, 5, 6)', () => {
  // Baseline at y 143, 10pt type: the glyph box is y 143..153, 3pt clear of
  // the mark's top edge at 140. A 12pt stroke puts 6pt of outline ink past every
  // glyph edge — down to y 137 under the baseline-sitting glyphs.
  const show = (mode: number, text: string) =>
    `q 0 0 1 RG 0 0 1 rg 12 w 1 j BT ${mode} Tr /F1 10 Tf 62 143 Td (${text}) Tj ET Q\n`;

  it('the fixture really strokes the outline into the mark', async () => {
    const bytes = await page({ ops: show(1, 'OUTLINED') });
    // Inside the mark, 2pt below the baseline, under the first glyph.
    expect(isBlue(await pixelAt(bytes, 66, 139))).toBe(true);
    const fill = await page({ ops: show(0, 'OUTLINED') });
    expect(isBlue(await pixelAt(fill, 66, 139))).toBe(false);
  }, 60_000);

  for (const mode of [1, 2, 5, 6]) {
    it(`removes Tr ${mode} text whose outline enters the mark`, async () => {
      realWorkers();
      const bytes = await page({ ops: show(mode, 'OUTLINED') });
      expect(await pageText(bytes)).toContain('OUTLINED');
      const outcome = await applyRedactions(bytes, [MARK]);
      expect(await pageText(outcome.bytes)).not.toContain('OUTLINED');
      expect(await anyStreamContains(outcome.bytes, 'OUTLINED')).toBe(false);
      expect(await pageText(outcome.bytes)).toContain('kept caption');
      expect(outcome.verified).toBe(true);
    }, 60_000);
  }

  it('keeps fill-only text (Tr 0) at the same position, outside the mark', async () => {
    realWorkers();
    const bytes = await page({ ops: show(0, 'OUTLINED') });
    const outcome = await applyRedactions(bytes, [MARK]);
    expect(await pageText(outcome.bytes)).toContain('OUTLINED');
    expect(outcome.verified).toBe(true);
  }, 60_000);

  it('the stroke width can come from /ExtGState too', async () => {
    realWorkers();
    const bytes = await page({
      ops: 'q /GS0 gs BT 1 Tr /F1 10 Tf 62 143 Td (OUTLINED) Tj ET Q\n',
      extGState: { GS0: { Type: 'ExtGState', LW: 12, LJ: 1 } }
    });
    const outcome = await applyRedactions(bytes, [MARK]);
    expect(await pageText(outcome.bytes)).not.toContain('OUTLINED');
    expect(outcome.verified).toBe(true);
  }, 60_000);

  it('Tr 3 (invisible) and Tr 7 (clip) are judged on the glyph box, as before', async () => {
    realWorkers();
    const bytes = await page({
      ops:
        `q 12 w BT 3 Tr /F1 10 Tf 62 143 Td (HIDDENRUN) Tj ET Q\n` +
        `q 12 w BT 7 Tr /F1 10 Tf 62 160 Td (CLIPRUN) Tj ET Q\n`
    });
    const outcome = await applyRedactions(bytes, [MARK]);
    expect(await anyStreamContains(outcome.bytes, 'HIDDENRUN')).toBe(true);
    expect(await anyStreamContains(outcome.bytes, 'CLIPRUN')).toBe(true);
    expect(outcome.verified).toBe(true);
  }, 60_000);
});
