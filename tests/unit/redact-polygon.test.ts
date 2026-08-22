/**
 * RED-07 — freehand/polygon redaction marks.
 *
 * The whole point of a shaped mark is that it is *not* its bounding box, so every
 * assertion here is built around one fixture where those two differ: a right
 * triangle whose bounding box has a large empty corner, with content planted in
 * that corner. A bbox-only implementation passes the "the enclosed text is gone"
 * half and fails this file on the other half — the corner content it destroys, or
 * hides under an oversized black rectangle while the verifier reports clean.
 *
 * Nothing is asserted against the implementation's own intermediate state: text
 * comes back out of pdf.js and out of the decompressed content stream, and the
 * cover is graded by rendering the output the way a viewer draws it.
 */
import { describe, expect, it, vi } from 'vitest';
import { PDFDocument, PDFArray, PDFDict, PDFName, StandardFonts, rgb } from 'pdf-lib';
import {
  fillPolygonMask,
  pointInPolygon,
  polygonBounds,
  polygonContainsBox,
  polygonOverlapsBox,
  shrinkMask
} from '../../src/core/geometry';
import { paintRectsBlack } from '../../src/core/pdf/image-redaction';

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

/**
 * `operations.ts` is imported only for the residue *policy* (`residueFailure`),
 * which is the same threshold the save gate applies; its worker clients are
 * stubbed because nothing here goes through them.
 */
vi.mock('../../src/core/workers', () => ({
  renderWorker: { lease: () => undefined },
  processWorker: { lease: () => undefined },
  cvWorker: { lease: () => undefined }
}));

// pdf.js renders into an `OffscreenCanvas`; Node has none. Same napi-rs stand-in
// `redaction-verify.test.ts` uses.
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
    // `any`: @napi-rs/canvas is resolved off pdfjs-dist's own optional
    // dependency, so there are no types to import for it here.
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

const { processWorkerImpl } = await import('../../src/core/workers/process.worker');
const { renderWorkerImpl } = await import('../../src/core/workers/render.worker');
const { residueFailure } = await import('../../src/core/operations');
const { decodeStream } = await import('../../src/core/pdf/interpreter');

/* ------------------------------------------------------------------ *
 * The geometry, on its own.
 * ------------------------------------------------------------------ */

/** A concave "L", so the bbox corner the shape does not cover is unambiguous. */
const L_SHAPE = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 4 },
  { x: 4, y: 4 },
  { x: 4, y: 10 },
  { x: 0, y: 10 }
];

describe('polygon geometry (RED-07)', () => {
  it('bounds an L at its extremes, which is the box every rect consumer sees', () => {
    expect(polygonBounds(L_SHAPE)).toEqual({ x: 0, y: 0, width: 10, height: 10 });
  });

  it('excludes the corner of the bounding box the shape does not cover', () => {
    expect(pointInPolygon(L_SHAPE, 2, 2)).toBe(true);
    expect(pointInPolygon(L_SHAPE, 8, 2)).toBe(true);
    expect(pointInPolygon(L_SHAPE, 2, 8)).toBe(true);
    // Inside the bbox, outside the L — the pixel a bbox test gets wrong.
    expect(pointInPolygon(L_SHAPE, 8, 8)).toBe(false);
  });

  it('overlaps a box that meets the shape and not one only in the empty corner', () => {
    expect(polygonOverlapsBox(L_SHAPE, { x: 1, y: 1, width: 2, height: 2 })).toBe(true);
    // Straddling an edge counts as overlapping: the same rule a rectangle mark
    // already applies to a text run, so a shape never keeps a run a box would take.
    expect(polygonOverlapsBox(L_SHAPE, { x: 3, y: 5, width: 3, height: 1 })).toBe(true);
    expect(polygonOverlapsBox(L_SHAPE, { x: 5, y: 5, width: 4, height: 4 })).toBe(false);
  });

  it('treats a box the shape encloses entirely as covered, and a straddling one as not', () => {
    expect(polygonContainsBox(L_SHAPE, { x: 1, y: 1, width: 2, height: 2 })).toBe(true);
    expect(polygonContainsBox(L_SHAPE, { x: 3, y: 3, width: 4, height: 4 })).toBe(false);
    // A shape drawn entirely inside the box covers none of it.
    expect(polygonContainsBox(L_SHAPE, { x: -1, y: -1, width: 20, height: 20 })).toBe(false);
  });

  it('rasterises the shape and not its box, and erodes to the interior', () => {
    const mask = fillPolygonMask(L_SHAPE, 10, 10);
    const at = (x: number, y: number) => mask[y * 10 + x];
    expect(at(1, 1)).toBe(1);
    expect(at(8, 1)).toBe(1);
    expect(at(1, 8)).toBe(1);
    expect(at(8, 8)).toBe(0);

    // A full mask eroded by 1 is exactly the inset rectangle the pixel verifier
    // used before shapes existed — the property that keeps the rectangle path
    // byte-for-byte unchanged.
    const full = new Uint8Array(100).fill(1);
    const inset = shrinkMask(full, 10, 10, 1);
    expect(inset[0]).toBe(0);
    expect(inset[11]).toBe(1);
    expect([...inset].reduce((a, b) => a + b, 0)).toBe(64);
  });
});

/* ------------------------------------------------------------------ *
 * The fixture: a triangle whose bounding box has content in the corner.
 * ------------------------------------------------------------------ */

const PAGE = { width: 600, height: 800 };

/**
 * A right triangle in the normalised, top-left-origin page frame a mark is stored
 * in. Its bounding box is x 0.10–0.90, y 0.10–0.50; the hypotenuse runs from the
 * top-right vertex to the bottom-left one, so the bottom-right of that box —
 * about a third of its area — is inside the box and outside the shape.
 */
const TRIANGLE = [
  { x: 0.1, y: 0.1 },
  { x: 0.9, y: 0.1 },
  { x: 0.1, y: 0.5 }
];

const BBOX = { x: 0.1, y: 0.1, width: 0.8, height: 0.4 };

const SHAPED_MARK = { pageIndex: 0, ...BBOX, points: TRIANGLE };
/** The same mark as RED-01 would have made it: the bounding box, no shape. */
const BOX_MARK = { pageIndex: 0, ...BBOX };

const INSIDE = 'INSIDETRIANGLE';
const CORNER = 'CORNERTEXT';
const FARAWAY = 'FARAWAYTEXT';

/**
 * Page contents, positioned against `TRIANGLE`:
 *
 *  - `INSIDE` sits under the top edge, well inside the shape.
 *  - `CORNER` sits in the bounding box's bottom-right, outside the shape.
 *  - `FARAWAY` sits below the bounding box entirely.
 *  - a filled block joins `CORNER` in that corner, so the cover can be graded by
 *    rendering: a vector shape renders whether or not pdf.js has font data.
 */
async function fixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([PAGE.width, PAGE.height]);
  page.drawText(INSIDE, { x: 90, y: 668, size: 14, font });
  page.drawText(CORNER, { x: 330, y: 444, size: 14, font });
  page.drawText(FARAWAY, { x: 60, y: 60, size: 14, font });
  page.drawRectangle({ x: 420, y: 416, width: 90, height: 80, color: rgb(0.85, 0.1, 0.1) });
  return doc.save({ useObjectStreams: false });
}

/**
 * Decodes every `<hex>` string literal in a content stream, the way
 * `process.test.ts` does: pdf-lib writes show-text operands as hex when the font
 * is embedded, so an assertion on the visible string needs the decoding appended.
 */
function decodeHexLiterals(content: string): string {
  let out = '';
  for (const match of content.matchAll(/<([0-9A-Fa-f\s]+)>/g)) {
    const hex = match[1].replace(/\s+/g, '');
    for (const width of [2, 4]) {
      if (hex.length % width !== 0) continue;
      let decoded = '';
      for (let i = 0; i < hex.length; i += width) {
        decoded += String.fromCharCode(parseInt(hex.slice(i, i + width), 16));
      }
      out += `\n${decoded}`;
    }
  }
  return out;
}

/** Every page content stream in the file, decompressed, as latin1 text. */
async function pageContent(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPage(0);
  const contents = page.node.Contents();
  if (!contents) return '';
  // `any`: pdf-lib exposes no common interface for "a stream I can read bytes
  // from" across PDFRawStream and PDFContentStream.
  const streams: any[] =
    contents instanceof PDFArray
      ? contents.asArray().map(ref => doc.context.lookup(ref))
      : [contents];
  let out = '';
  for (const stream of streams) {
    const raw: Uint8Array = stream.getContents();
    const flate = String(stream.dict?.get(PDFName.of('Filter'))) === '/FlateDecode';
    out += new TextDecoder('latin1').decode(flate ? await decodeStream(raw) : raw);
  }
  return out + decodeHexLiterals(out);
}

/** Text as pdf.js reads it back out of the produced bytes. */
async function extractedText(bytes: Uint8Array): Promise<string> {
  const { handle } = await renderWorkerImpl.loadDocument(bytes);
  try {
    return (await renderWorkerImpl.documentText(handle)).join('\n');
  } finally {
    await renderWorkerImpl.closeDocument(handle);
  }
}

describe('RED-07: a shaped mark removes what it encloses and nothing else', () => {
  it('removes the enclosed run and leaves the run inside its bounding box alone', async () => {
    const bytes = await fixture();
    expect(await pageContent(bytes)).toContain(INSIDE);

    const out = await processWorkerImpl.applyRedactions(bytes, [SHAPED_MARK]);

    // Structural: the show-text operator is gone from the content stream, not
    // merely hidden.
    const content = await pageContent(out);
    expect(content).not.toContain(INSIDE);
    expect(content).toContain(CORNER);
    expect(content).toContain(FARAWAY);

    // And as a reader gets it back out of the file.
    const text = await extractedText(out);
    expect(text).not.toContain(INSIDE);
    expect(text).toContain(CORNER);
    expect(text).toContain(FARAWAY);
  }, 30_000);

  it('would have taken the corner run if the mark were its bounding box', async () => {
    // The control for the test above: with the same box and no shape, RED-01's
    // rectangle behaviour removes the corner text too. This is what proves the
    // polygon test — not a coincidence of layout — is what saved it.
    const out = await processWorkerImpl.applyRedactions(await fixture(), [BOX_MARK]);
    const content = await pageContent(out);
    expect(content).not.toContain(INSIDE);
    expect(content).not.toContain(CORNER);
    expect(content).toContain(FARAWAY);
  }, 30_000);

  it('keeps the vector block in the bounding box corner', async () => {
    // A rectangle mark strips any path it intersects; the shape must not, or the
    // "only what you enclosed" promise is false for vectors as well as text.
    // The block's own path, not just its colour: the filter drops the path
    // construction and painting operators and leaves the `rg` behind, so an
    // assertion on the colour alone would pass on a stripped block.
    const shaped = await pageContent(
      await processWorkerImpl.applyRedactions(await fixture(), [SHAPED_MARK])
    );
    expect(shaped).toContain('90 0 l');
    // The control again: the bounding box takes it.
    const boxed = await pageContent(
      await processWorkerImpl.applyRedactions(await fixture(), [BOX_MARK])
    );
    expect(boxed).not.toContain('90 0 l');
  }, 30_000);
});

/* ------------------------------------------------------------------ *
 * The cover, and RED-03's verdict on it.
 * ------------------------------------------------------------------ */

/** A small box in the bounding box's bottom-right corner, over the kept block. */
const CORNER_PROBE = { pageIndex: 0, x: 0.72, y: 0.4, width: 0.1, height: 0.06 };

describe('RED-07: the cover is the shape, and the verifier grades the shape', () => {
  it('fills the shape, passes verification, and reports nothing left inside it', async () => {
    const out = await processWorkerImpl.applyRedactions(await fixture(), [SHAPED_MARK]);
    const { handle } = await renderWorkerImpl.loadDocument(out);
    try {
      const [text] = await renderWorkerImpl.checkRegionText(handle, [SHAPED_MARK]);
      expect(text.foundText.trim()).toBe('');

      const [pixels] = await renderWorkerImpl.checkRegionPixels(handle, [SHAPED_MARK]);
      expect(pixels.residue.sampled).toBeGreaterThan(1000);
      expect(residueFailure(pixels.residue)).toBeNull();
    } finally {
      await renderWorkerImpl.closeDocument(handle);
    }
  }, 30_000);

  it('leaves the corner of the bounding box unpainted — the cover is not a rectangle', async () => {
    const out = await processWorkerImpl.applyRedactions(await fixture(), [SHAPED_MARK]);
    const { handle } = await renderWorkerImpl.loadDocument(out);
    try {
      // Grading the *box* fails, precisely because the corner still holds the
      // content the user kept. A bbox-only verifier would refuse this correct
      // save; the shape-aware one above passes it.
      const [asBox] = await renderWorkerImpl.checkRegionPixels(handle, [BOX_MARK]);
      expect(residueFailure(asBox.residue)).not.toBeNull();

      // And specifically, the kept block is still there to be seen.
      const [probe] = await renderWorkerImpl.checkRegionPixels(handle, [CORNER_PROBE]);
      expect(probe.residue.fraction).toBeGreaterThan(0.5);
    } finally {
      await renderWorkerImpl.closeDocument(handle);
    }
  }, 30_000);

  it('still fails a shaped mark whose interior holds surviving content', async () => {
    // A deliberately sabotaged cover: the shape's own content is removed from the
    // stream, then a block is painted back inside it. The shape-aware pixel check
    // has to catch that, or "verified" means nothing for shaped marks.
    const out = await processWorkerImpl.applyRedactions(await fixture(), [SHAPED_MARK]);
    const doc = await PDFDocument.load(out);
    const page = doc.getPage(0);
    // Inside the triangle: normalised (0.15..0.30, 0.15..0.25).
    page.drawRectangle({ x: 90, y: 600, width: 90, height: 80, color: rgb(0.9, 0.9, 0.2) });
    const sabotaged = await doc.save({ useObjectStreams: false });

    const { handle } = await renderWorkerImpl.loadDocument(sabotaged);
    try {
      const [pixels] = await renderWorkerImpl.checkRegionPixels(handle, [SHAPED_MARK]);
      expect(residueFailure(pixels.residue)).not.toBeNull();
    } finally {
      await renderWorkerImpl.closeDocument(handle);
    }
  }, 30_000);
});

/* ------------------------------------------------------------------ *
 * Rotation: the shape and its box must be mapped by the same transform.
 * ------------------------------------------------------------------ */

describe('RED-07: a shape and its own bounding box agree under every /Rotate', () => {
  const LINES = ['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA'];

  async function rotatedFixture(rotation: number): Promise<Uint8Array> {
    const { degrees } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([PAGE.width, PAGE.height]);
    page.setRotation(degrees(rotation));
    LINES.forEach((line, i) => {
      page.drawText(line, { x: 80 + i * 90, y: 700 - i * 150, size: 14, font });
    });
    return doc.save({ useObjectStreams: false });
  }

  for (const rotation of [0, 90, 180, 270]) {
    it(`maps a rectangle's own four corners to that rectangle at ${rotation}°`, async () => {
      // A polygon built from a box's corners is that box. If the point mapping
      // and the box mapping disagreed on any rotation, these two runs would
      // remove different lines — which is how a shape ends up covering one part
      // of a rotated page and removing another.
      const box = { pageIndex: 0, x: 0.05, y: 0.05, width: 0.5, height: 0.45 };
      const corners = [
        { x: box.x, y: box.y },
        { x: box.x + box.width, y: box.y },
        { x: box.x + box.width, y: box.y + box.height },
        { x: box.x, y: box.y + box.height }
      ];
      const bytes = await rotatedFixture(rotation);
      const asBox = await pageContent(await processWorkerImpl.applyRedactions(bytes, [box]));
      const asShape = await pageContent(
        await processWorkerImpl.applyRedactions(bytes, [{ ...box, points: corners }])
      );

      const survivors = (content: string) => LINES.filter(line => content.includes(line));
      expect(survivors(asShape)).toEqual(survivors(asBox));
      // Non-trivial: the mark really did take something on this rotation.
      expect(survivors(asBox).length).toBeLessThan(LINES.length);
    }, 30_000);
  }
});

/* ------------------------------------------------------------------ *
 * Images: the shape reaches the pixels, not just the decision.
 * ------------------------------------------------------------------ */

describe('RED-07: a shaped mark over an image', () => {
  /** A page whose whole surface is one image XObject, as a scan is. */
  async function scannedPage(): Promise<Uint8Array> {
    const { PDFRawStream } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    const page = doc.addPage([PAGE.width, PAGE.height]);
    const stream = PDFRawStream.of(
      doc.context.obj({
        Type: 'XObject',
        Subtype: 'Image',
        Width: 5,
        Height: 1,
        ColorSpace: 'DeviceRGB',
        BitsPerComponent: 8
      }),
      new TextEncoder().encode('SCANNEDPIXELS!!'.slice(0, 15))
    );
    const imageRef = doc.context.register(stream);
    (page.node.Resources() as PDFDict).set(
      PDFName.of('XObject'),
      doc.context.obj({ Im0: imageRef })
    );
    page.node.set(
      PDFName.of('Contents'),
      doc.context.register(doc.context.flateStream('q 600 0 0 800 0 0 cm /Im0 Do Q'))
    );
    return doc.save({ useObjectStreams: false });
  }

  it('reports the covered area with the shape carried into the image unit square', async () => {
    const [request] = await processWorkerImpl.planImageRedactions(await scannedPage(), [
      SHAPED_MARK
    ]);
    expect(request.name).toBe('Im0');
    const area = request.rects[0];
    // The box is the shape's bounds, clipped to the unit square, y *up*.
    expect(area.x).toBeCloseTo(0.1, 3);
    expect(area.y).toBeCloseTo(0.5, 3);
    expect(area.width).toBeCloseTo(0.8, 3);
    expect(area.height).toBeCloseTo(0.4, 3);
    // The shape came with it, flipped into the same space: its widest edge is at
    // the top of the image (unit y 0.9) and its point at unit y 0.5.
    expect(area.polygon).toHaveLength(3);
    const ys = area.polygon!.map(p => p.y);
    expect(Math.max(...ys)).toBeCloseTo(0.9, 3);
    expect(Math.min(...ys)).toBeCloseTo(0.5, 3);
  });

  it('blacks out only the pixels the shape covers', () => {
    // 8x8 image, marked with the lower-left triangle in unit space.
    const image = {
      rgba: new Uint8ClampedArray(8 * 8 * 4).fill(200),
      width: 8,
      height: 8
    };
    paintRectsBlack(image, [
      {
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        polygon: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 0, y: 1 }
        ]
      }
    ]);
    const black = (col: number, row: number) => {
      const p = (row * 8 + col) * 4;
      return image.rgba[p] === 0 && image.rgba[p + 3] === 255;
    };
    // Unit y runs up, so the triangle's bulk is the bottom-left of the raster.
    expect(black(0, 7)).toBe(true);
    expect(black(6, 7)).toBe(true);
    expect(black(0, 1)).toBe(true);
    // The opposite corner is outside the shape and must survive.
    expect(black(7, 0)).toBe(false);
    expect(black(6, 1)).toBe(false);
  });
});
