/**
 * RED-03 — the verification gate's pixel half.
 *
 * The gate used to be text-only: it re-extracted `getTextContent()` and checked
 * for residual glyphs. That is blind to a vector shape, an inline image, and to an
 * image whose covered pixels were only partly overwritten — and since a
 * partly-covered image now has its pixels painted rather than the whole XObject
 * dropped, "no extractable text in the region" stopped being sufficient evidence.
 *
 * Three levels are covered here:
 *
 *  1. `regionPixelResidue` against hand-built pixel buffers — the measurement.
 *  2. A real pdf.js render of a real PDF, proving the pair of checks disagree in
 *     exactly the way that matters: content that survives text extraction is
 *     caught by the pixels. pdf.js's legacy build renders into a napi-rs canvas
 *     standing in for `OffscreenCanvas`.
 *  3. `applyRedactions`'s wiring, with stub workers, proving a failing residue
 *     (and an unrenderable region) actually blocks the save.
 */
import { describe, expect, it, vi } from 'vitest';
import { PDFDocument, rgb } from 'pdf-lib';
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

// pdf.js renders into an `OffscreenCanvas`. Node has none, so napi-rs's canvas
// (already present as pdfjs-dist's own optional dependency) stands in for it.
const { createCanvas } = await import('@napi-rs/canvas').catch(async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const path = require.resolve('@napi-rs/canvas', {
    paths: [require.resolve('pdfjs-dist/package.json')]
  });
  return require(path);
});

if (typeof (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas === 'undefined') {
  class NodeOffscreenCanvas {
    // The napi-rs canvas is API-compatible for the 2D drawing surface pdf.js
    // needs; only the class identity differs, which nothing here checks.
    // `any`: @napi-rs/canvas is resolved dynamically off pdfjs-dist's own
    // optional dependency, so there are no types to import for it here.
    private canvas: any;
    constructor(width: number, height: number) {
      this.canvas = createCanvas(width, height);
    }
    get width() {
      return this.canvas.width;
    }
    set width(value: number) {
      this.canvas.width = value;
    }
    get height() {
      return this.canvas.height;
    }
    set height(value: number) {
      this.canvas.height = value;
    }
    getContext(kind: string) {
      return this.canvas.getContext(kind);
    }
  }
  (globalThis as unknown as { OffscreenCanvas: unknown }).OffscreenCanvas = NodeOffscreenCanvas;
}

/**
 * `operations.ts` reaches the workers through this module. Stubbing it (rather
 * than the worker implementations) is what lets the wiring in `verifyRedaction`
 * be graded: the stub decides exactly what each check answers.
 *
 * `any`: these stand in for two Comlink `Remote<T>` proxies, and each test
 * supplies only the handful of methods the path under test calls — a structural
 * type would have to list all of `RenderJob` and `ProcessJob`.
 */
const stubs: { render: any; process: any } = { render: {}, process: {} };

vi.mock('../../src/core/workers', () => ({
  renderWorker: { lease: (fn: (api: any) => unknown) => fn(stubs.render) },
  processWorker: { lease: (fn: (api: any) => unknown) => fn(stubs.process) },
  cvWorker: { lease: () => undefined }
}));

const { regionPixelResidue, renderWorkerImpl } =
  await import('../../src/core/workers/render.worker');
const { applyRedactions, residueFailure, MAX_RESIDUE_FRACTION } =
  await import('../../src/core/operations');

const FILL = [
  Math.round(DOC_REDACT_RGB[0] * 255),
  Math.round(DOC_REDACT_RGB[1] * 255),
  Math.round(DOC_REDACT_RGB[2] * 255)
];

/** A buffer filled with the redaction colour, i.e. a correctly redacted region. */
function filledRegion(width: number, height: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    data[p * 4] = FILL[0];
    data[p * 4 + 1] = FILL[1];
    data[p * 4 + 2] = FILL[2];
    data[p * 4 + 3] = 255;
  }
  return data;
}

function paint(
  data: Uint8ClampedArray,
  width: number,
  box: { x: number; y: number; w: number; h: number },
  colour: [number, number, number, number]
) {
  for (let y = box.y; y < box.y + box.h; y++) {
    for (let x = box.x; x < box.x + box.w; x++) {
      const at = (y * width + x) * 4;
      data[at] = colour[0];
      data[at + 1] = colour[1];
      data[at + 2] = colour[2];
      data[at + 3] = colour[3];
    }
  }
}

describe('regionPixelResidue (RED-03, the measurement)', () => {
  it('reports no residue for a region that is entirely the redaction fill', () => {
    const residue = regionPixelResidue(filledRegion(60, 40), 60, 40);
    expect(residue.sampled).toBeGreaterThan(0);
    expect(residue.offFill).toBe(0);
    expect(residue.fraction).toBe(0);
    expect(residueFailure(residue)).toBeNull();
  });

  it('catches a surviving block of content in the middle of the mark', () => {
    const width = 60;
    const height = 40;
    const data = filledRegion(width, height);
    // A 10x10 fragment of a logo or a glyph — 4% of the interior.
    paint(data, width, { x: 20, y: 15, w: 10, h: 10 }, [220, 30, 30, 255]);
    const residue = regionPixelResidue(data, width, height);
    expect(residue.offFill).toBe(100);
    expect(residue.fraction).toBeGreaterThan(MAX_RESIDUE_FRACTION);
    expect(residue.maxDeviation).toBeGreaterThan(200);
    expect(residueFailure(residue)).toMatch(/not the redaction fill/);
  });

  it('forgives an anti-aliased edge, because the mark boundary is not content', () => {
    const width = 60;
    const height = 40;
    const data = filledRegion(width, height);
    // A two-pixel white ring: the page showing through where the mark's own edge
    // is anti-aliased at a DPI unrelated to the one it was drawn at.
    paint(data, width, { x: 0, y: 0, w: width, h: 2 }, [255, 255, 255, 255]);
    paint(data, width, { x: 0, y: height - 2, w: width, h: 2 }, [255, 255, 255, 255]);
    paint(data, width, { x: 0, y: 0, w: 2, h: height }, [255, 255, 255, 255]);
    paint(data, width, { x: width - 2, y: 0, w: 2, h: height }, [255, 255, 255, 255]);
    const residue = regionPixelResidue(data, width, height);
    expect(residue.offFill).toBe(0);
    expect(residueFailure(residue)).toBeNull();
  });

  it('forgives JPEG ringing around the fill colour', () => {
    const width = 40;
    const height = 40;
    const data = filledRegion(width, height);
    for (let p = 0; p < width * height; p++) {
      const jitter = p % 3 === 0 ? 20 : -8;
      data[p * 4] = FILL[0] + jitter;
      data[p * 4 + 1] = FILL[1] + jitter;
      data[p * 4 + 2] = FILL[2] + jitter;
    }
    expect(residueFailure(regionPixelResidue(data, width, height))).toBeNull();
  });

  it('treats a transparent pixel as content, not as fill', () => {
    const width = 40;
    const height = 40;
    const data = filledRegion(width, height);
    // Nothing painted here at all: in a viewer whatever is underneath shows.
    paint(data, width, { x: 10, y: 10, w: 12, h: 12 }, [0, 0, 0, 0]);
    const residue = regionPixelResidue(data, width, height);
    expect(residue.fraction).toBeGreaterThan(MAX_RESIDUE_FRACTION);
    expect(residueFailure(residue)).not.toBeNull();
  });

  it('reports nothing sampled for a sub-pixel region rather than failing it', () => {
    const residue = regionPixelResidue(new Uint8ClampedArray(0), 0, 0);
    expect(residue.sampled).toBe(0);
    expect(residueFailure(residue)).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * The real render: where the two halves of the gate disagree.
 * ------------------------------------------------------------------ */

const PAGE = { width: 300, height: 300 };
/** Region in display space (origin top-left, normalised), as a mark is stored. */
const REGION = { pageIndex: 0, x: 0.2, y: 0.2, width: 0.4, height: 0.3, text: '' };

/**
 * `REGION` in pdf-lib's page space (origin bottom-left, points).
 */
const REGION_PT = {
  x: REGION.x * PAGE.width,
  y: (1 - REGION.y - REGION.height) * PAGE.height,
  width: REGION.width * PAGE.width,
  height: REGION.height * PAGE.height
};

/** A page whose region holds a vector shape and no text at all. */
async function pageWithVectorInRegion(covered: boolean) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([PAGE.width, PAGE.height]);
  page.drawRectangle({
    x: REGION_PT.x + 4,
    y: REGION_PT.y + 4,
    width: REGION_PT.width - 8,
    height: REGION_PT.height - 8,
    color: rgb(0.85, 0.1, 0.1)
  });
  if (covered) {
    // An honest redaction fill over the whole mark.
    page.drawRectangle({
      ...REGION_PT,
      color: rgb(...(DOC_REDACT_RGB as unknown as [number, number, number]))
    });
  }
  return doc.save();
}

async function residueFor(bytes: Uint8Array) {
  const { handle } = await renderWorkerImpl.loadDocument(bytes);
  try {
    const text = await renderWorkerImpl.checkRegionText(handle, [REGION]);
    const pixels = await renderWorkerImpl.checkRegionPixels(handle, [REGION]);
    return { foundText: text[0].foundText, residue: pixels[0].residue };
  } finally {
    await renderWorkerImpl.closeDocument(handle);
  }
}

describe('checkRegionPixels against a real render (RED-03)', () => {
  it('catches vector content that the text-only check passes', async () => {
    const { foundText, residue } = await residueFor(await pageWithVectorInRegion(false));
    // The text-based half of the gate is satisfied: there are no glyphs here.
    expect(foundText.trim()).toBe('');
    // The pixel half is not.
    expect(residue.sampled).toBeGreaterThan(100);
    expect(residue.fraction).toBeGreaterThan(MAX_RESIDUE_FRACTION);
    expect(residueFailure(residue)).not.toBeNull();
  }, 30_000);

  it('passes a region that really is covered by the redaction fill', async () => {
    const { foundText, residue } = await residueFor(await pageWithVectorInRegion(true));
    expect(foundText.trim()).toBe('');
    expect(residue.sampled).toBeGreaterThan(100);
    expect(residueFailure(residue)).toBeNull();
  }, 30_000);
});

/* ------------------------------------------------------------------ *
 * The gate itself: does a failing residue actually block the save?
 * ------------------------------------------------------------------ */

/**
 * Wires the stub workers so every check *except* the pixel one is satisfied —
 * the exact shape of the bug this closes: no extractable text anywhere, so the
 * old text-only gate reported `verified: true`.
 *
 * `any`: the caller passes either a resolving or a throwing stub, so the shape is
 * deliberately looser than `RenderJob['checkRegionPixels']`.
 */
function wireStubs(pixels: { checkRegionPixels: any }) {
  const output = new Uint8Array([1, 2, 3, 4]);
  stubs.process = {
    planImageRedactions: vi.fn(async () => []),
    applyRedactions: vi.fn(async () => output),
    scrubMetadata: vi.fn(async () => output),
    collectOffPageText: vi.fn(async () => [])
  };
  stubs.render = {
    loadDocument: vi.fn(async () => ({ handle: 'h' })),
    closeDocument: vi.fn(async () => undefined),
    documentText: vi.fn(async () => ['']),
    checkRegionText: vi.fn(async (_h: string, regions: (typeof REGION)[]) =>
      regions.map(region => ({ region, foundText: '' }))
    ),
    checkRegionPixels: pixels.checkRegionPixels
  };
  return output;
}

describe('applyRedactions blocks on the pixel half (RED-03)', () => {
  const dirty = { sampled: 1000, offFill: 90, fraction: 0.09, maxDeviation: 240 };
  const clean = { sampled: 1000, offFill: 3, fraction: 0.003, maxDeviation: 21 };

  it('fails verification when the region does not render blank, though no text remains', async () => {
    wireStubs({
      checkRegionPixels: vi.fn(async (_h: string, regions: (typeof REGION)[]) =>
        regions.map(region => ({ region, residue: dirty }))
      )
    });
    const outcome = await applyRedactions(new Uint8Array([9, 9]), [REGION]);
    expect(outcome.verified).toBe(false);
    expect(outcome.verdicts[0].pass).toBe(false);
    expect(outcome.verdicts[0].detail).toMatch(/does not render blank/);
  });

  it('passes when both halves agree the region is clear', async () => {
    wireStubs({
      checkRegionPixels: vi.fn(async (_h: string, regions: (typeof REGION)[]) =>
        regions.map(region => ({ region, residue: clean }))
      )
    });
    const outcome = await applyRedactions(new Uint8Array([9, 9]), [REGION]);
    expect(outcome.verified).toBe(true);
    expect(outcome.verdicts[0].detail).toMatch(/renders as solid fill/);
  });

  it('fails closed when the region cannot be rendered at all', async () => {
    wireStubs({
      checkRegionPixels: vi.fn(async () => {
        throw new Error('This page could not be rasterised.');
      })
    });
    const outcome = await applyRedactions(new Uint8Array([9, 9]), [REGION]);
    expect(outcome.verified).toBe(false);
    expect(outcome.verdicts[0].detail).toMatch(/could not be rendered/);
    expect(outcome.verdicts[0].detail).toContain('This page could not be rasterised.');
  });

  it('actually calls the pixel check — the gate is not text-only', async () => {
    const spy = vi.fn(async (_h: string, regions: (typeof REGION)[]) =>
      regions.map(region => ({ region, residue: clean }))
    );
    wireStubs({ checkRegionPixels: spy });
    await applyRedactions(new Uint8Array([9, 9]), [REGION]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toEqual([REGION]);
  });
});
