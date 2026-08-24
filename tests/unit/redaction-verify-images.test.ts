/**
 * RED-03 — the half of the verification gate that can see *underneath* the cover.
 *
 * The pixel half used to grade one thing: how far the rendered region is from the
 * redaction fill colour. On a page whose secret survived intact under an opaque
 * black rectangle that reading is `0.0000` — perfectly clean — because the
 * rectangle really is the fill colour and the render really is solid black. The
 * check could not detect that failure mode at all, and on a redaction over a
 * photograph or a scan there is no text layer for the other half of the gate to
 * re-extract, so nothing else was watching either.
 *
 * So the gate now also reads the *embedded image pixels* the marks cover, in the
 * output bytes, and asks whether they were actually destroyed — the question a
 * viewer's "extract images" asks, which no amount of compositing can answer.
 *
 * Everything here runs the real pipeline: the real `pdf-lib` writer, the real
 * pdf.js reader, real rasters. The only thing stubbed is `applyRedactions`'s own
 * content-stream surgery, in the sabotage test, which is how the ticket's
 * acceptance criterion is phrased — "a deliberately-sabotaged build
 * (overlay-only redaction) is rejected by the verifier".
 */
import { describe, expect, it, vi } from 'vitest';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { DOC_REDACT_RGB } from '../../src/core/doc-colors';

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
 

/**
 * `operations.ts` reaches the workers through this module, so this is the seam
 * where the *real* worker implementations are wired in — the whole redaction and
 * verification pipeline then runs in-process, against real bytes.
 *
 * `any`: these stand in for two Comlink `Remote<T>` proxies. A structural type
 * would have to restate all of `RenderJob` and `ProcessJob`.
 */
 
const stubs: { render: any; process: any } = { render: {}, process: {} };

vi.mock('../../src/core/workers', () => ({
   
  renderWorker: { lease: (fn: (api: any) => unknown) => fn(stubs.render) },
   
  processWorker: { lease: (fn: (api: any) => unknown) => fn(stubs.process) },
  cvWorker: { lease: () => undefined }
}));

const { renderWorkerImpl } = await import('../../src/core/workers/render.worker');
const { processWorkerImpl } = await import('../../src/core/workers/process.worker');
const { applyRedactions, residueFailure, imageResidueFailure } =
  await import('../../src/core/operations');
const { encodePng } = await import('../../src/core/png');
const { isCancellation } = await import('../../src/core/errors');

const PAGE = { width: 200, height: 200 };

/** The mark, in display space (origin top-left, normalised) as a mark is stored. */
const MARK = { pageIndex: 0, x: 0.3, y: 0.3, width: 0.3, height: 0.25, text: '' };

/** `MARK` in pdf-lib's page space (origin bottom-left, points). */
const MARK_PT = {
  x: MARK.x * PAGE.width,
  y: (1 - MARK.y - MARK.height) * PAGE.height,
  width: MARK.width * PAGE.width,
  height: MARK.height * PAGE.height
};

/** A photograph-like raster: every pixel bright and different from its neighbours. */
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

/**
 * One page holding a photograph the mark partly covers, plus a line of text well
 * outside it. The image is *larger* than the mark on purpose: a fully covered
 * image is dropped from the content stream outright, and it is the partly covered
 * one — kept, with its covered pixels supposed to be destroyed — that the old
 * check was blind to.
 */
async function pageWithPhoto(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([PAGE.width, PAGE.height]);
  const image = await doc.embedPng(photoPng());
  page.drawImage(image, { x: 20, y: 60, width: 160, height: 120 });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('kept caption', { x: 20, y: 20, size: 10, font });
  return doc.save();
}

/**
 * The sabotage: a cover rectangle drawn over the mark and nothing else touched.
 * This is what "redaction" means in every tool that ships an overlay — the page
 * looks perfect and the image is still in the file, byte for byte.
 */
async function overlayOnly(bytes: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes);
  doc.getPages()[0].drawRectangle({
    ...MARK_PT,
    color: rgb(...(DOC_REDACT_RGB as unknown as [number, number, number]))
  });
  return doc.save();
}

/** Every check the gate can run against one document, region by region. */
async function inspect(bytes: Uint8Array) {
  const plan = await processWorkerImpl.planImageRedactions(bytes, [MARK]);
  const { handle } = await renderWorkerImpl.loadDocument(bytes);
  try {
    const [text] = await renderWorkerImpl.checkRegionText(handle, [MARK]);
    const [pixels] = await renderWorkerImpl.checkRegionPixels(handle, [MARK]);
    const inspections = await renderWorkerImpl.inspectRedactedImages(
      handle,
      plan.map(r => ({ pageIndex: r.pageIndex, objectNumber: r.objectNumber, rects: r.rects }))
    );
    return { plan, foundText: text.foundText, residue: pixels.residue, inspections };
  } finally {
    await renderWorkerImpl.closeDocument(handle);
  }
}

/**
 * Every `Uint8Array` argument copied on the way in.
 *
 * In the real app each Comlink argument crosses a structured-clone boundary, so
 * the worker always owns its own buffer — which is exactly why
 * `RenderJob.loadDocument` is allowed to hand its bytes to pdf.js, which
 * *detaches* them. Running both workers in-process removes that boundary, so
 * without this the second stage of the pipeline is handed a detached buffer and
 * fails with "No PDF header found" — an artefact of the harness, not of the code
 * under test.
 */
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

describe('the buried-image check (RED-03)', () => {
  it('an overlay-only redaction passes every other check and is caught by this one', async () => {
    const sabotaged = await overlayOnly(await pageWithPhoto());
    const { plan, foundText, residue, inspections } = await inspect(sabotaged);

    // The text half has nothing to say: the mark covers a photograph.
    expect(foundText.trim()).toBe('');

    // The render half has nothing to say either — and this is the whole point.
    // The cover rectangle *is* the redaction fill, so the region measures as
    // flawless. This is the `residue.fraction = 0.0000` the old gate reported on
    // a page whose secret was fully intact underneath.
    expect(residue.fraction).toBeLessThanOrEqual(0.02);
    expect(residueFailure(residue)).toBeNull();

    // The new half reads the image itself, and the image is untouched.
    expect(plan.length).toBe(1);
    expect(inspections.length).toBe(1);
    expect(inspections[0].residue?.fraction).toBeGreaterThan(0.9);
    expect(imageResidueFailure(inspections[0])).toMatch(/still holds its original pixels/);
  }, 30_000);

  it('rejects that sabotaged output through applyRedactions, blocking the save', async () => {
    const original = await pageWithPhoto();
    const sabotaged = await overlayOnly(original);
    realWorkers();
    stubs.process = cloningBoundary({
      ...processWorkerImpl,
      // The sabotage, at the seam a broken build would break: the writer returns
      // a document with the cover drawn and nothing removed.
      applyRedactions: async () => sabotaged.slice(),
      scrubMetadata: async (bytes: Uint8Array) => bytes
    });

    const outcome = await applyRedactions(original, [MARK]);
    expect(outcome.verified).toBe(false);
    expect(outcome.verdicts).toHaveLength(1);
    expect(outcome.verdicts[0].pass).toBe(false);
    expect(outcome.verdicts[0].detail).toMatch(/still holds its original pixels/);
  }, 60_000);

  it('the honest pipeline still verifies clean — no new false positive', async () => {
    realWorkers();
    const original = await pageWithPhoto();
    const outcome = await applyRedactions(original, [MARK]);

    expect(outcome.verified).toBe(true);
    expect(outcome.verdicts[0].detail).toMatch(/covered pixels destroyed/);

    // And the output really is what the verdict says it is: the covered pixels of
    // the image are gone, the page still has its kept text, and the image is
    // still drawn (it was only partly covered).
    //
    // `outcome.bytes` is loaded twice below — once by `inspect`, once directly —
    // and each `loadDocument` call hands pdf.js ownership of the buffer it's given
    // (see the comment on `loadDocument` in render.worker.ts: pdf.js may detach
    // it, which is the right call for a buffer with exactly one reader). Calling
    // `renderWorkerImpl` directly, as both call sites here do, skips the
    // `cloningBoundary` that gives every *other* call in this file its own copy —
    // that boundary only wraps calls made through `stubs.render`/`stubs.process`.
    // A `.slice()` per use reproduces what a real Comlink round-trip would hand
    // each caller: its own buffer.
    const after = await inspect(outcome.bytes.slice());
    expect(after.inspections.length).toBe(1);
    expect(after.inspections[0].residue?.fraction ?? 1).toBeLessThanOrEqual(0.02);
    expect(imageResidueFailure(after.inspections[0])).toBeNull();

    const { handle } = await renderWorkerImpl.loadDocument(outcome.bytes.slice());
    try {
      const text = await renderWorkerImpl.documentText(handle);
      expect(text.join(' ')).toContain('kept caption');
    } finally {
      await renderWorkerImpl.closeDocument(handle);
    }
  }, 60_000);
});

describe('verification progress and cancellation (RED-03)', () => {
  it('reports per-region and per-page progress inside the verification band', async () => {
    realWorkers();
    const ticks: { fraction: number; label: string }[] = [];
    const outcome = await applyRedactions(await pageWithPhoto(), [MARK], {
      onProgress: (fraction, label) => ticks.push({ fraction: fraction ?? -1, label })
    });
    expect(outcome.verified).toBe(true);

    const verifying = ticks.filter(t => t.fraction >= 0.85);
    // One 0.85 tick and then silence was the old behaviour; the pass now reports
    // each stage as it runs.
    expect(new Set(verifying.map(t => t.fraction)).size).toBeGreaterThanOrEqual(4);
    expect(verifying.every(t => t.fraction <= 1)).toBe(true);
    expect(verifying.map(t => t.label).join('\n')).toMatch(/region/i);
    expect(verifying.map(t => t.label).join('\n')).toMatch(/image/i);
  }, 60_000);

  it('aborts the verification pass instead of finishing it', async () => {
    realWorkers();
    const controller = new AbortController();
    let aborted = false;

    const run = applyRedactions(await pageWithPhoto(), [MARK], {
      signal: controller.signal,
      onProgress: fraction => {
        if ((fraction ?? 0) >= 0.85 && !aborted) {
          aborted = true;
          controller.abort();
        }
      }
    });

    // A cancellation must *throw*, never come back as a region that "failed
    // verification": the document was not judged unsafe, it was not judged.
    let thrown: unknown = null;
    await run.then(
      () => undefined,
      error => {
        thrown = error;
      }
    );
    expect(thrown).not.toBeNull();
    expect(isCancellation(thrown)).toBe(true);
    expect(aborted).toBe(true);
  }, 60_000);
});
