/**
 * Rotation & coordinate geometry (AUDIT-FINDINGS §3).
 *
 * Crop, watermark, header/footer and Bates numbering used to be laid out against
 * the raw MediaBox while every UI overlay is drawn against pdf.js's rotation-aware
 * `PageViewport`. On a `/Rotate 90` page that is a quarter turn of disagreement:
 * crop took the wrong half, the watermark landed sideways in the wrong corner, and
 * the Bates number fell outside the crop the same export had just applied.
 *
 * These tests do not trust the implementation's own transform. `viewportPoint`
 * below is an independent transcription of pdf.js's `PageViewport` constructor, so
 * an assertion says "this is where the viewport puts it", not "this is what the
 * worker computed".
 */
import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFArray, PDFDict, PDFName, degrees } from 'pdf-lib';
import { processWorkerImpl } from '../../src/core/workers/process.worker';
import type {
  ComposeExtras,
  HeaderFooterData,
  PageSource,
  StampSource,
  WatermarkData
} from '../../src/core/workers/process.worker';
import {
  displayFrame,
  displayPointToNormalizedPage,
  displayPointToPage,
  placeDisplayBox
} from '../../src/core/rotation';
import { silentJob } from '../../src/core/workers/protocol';

/* ------------------------------------------------------------------ *
 * Independent reference: pdf.js PageViewport, transcribed.
 * ------------------------------------------------------------------ */

/**
 * Maps a raw page-space point (bottom-left origin) to canvas/display space
 * (top-left origin), exactly as pdf.js's `PageViewport` does at scale 1 for a
 * viewBox anchored at the origin. This is the frame every overlay is drawn in.
 */
function viewportPoint(
  x: number,
  y: number,
  w: number,
  h: number,
  rotation: number
): { x: number; y: number } {
  const r = ((rotation % 360) + 360) % 360;
  let a: number, b: number, c: number, d: number;
  switch (r) {
    case 90:
      [a, b, c, d] = [0, 1, 1, 0];
      break;
    case 180:
      [a, b, c, d] = [-1, 0, 0, 1];
      break;
    case 270:
      [a, b, c, d] = [0, -1, -1, 0];
      break;
    default:
      [a, b, c, d] = [1, 0, 0, -1];
  }
  const centerX = w / 2;
  const centerY = h / 2;
  let offsetCanvasX: number, offsetCanvasY: number;
  if (a === 0) {
    offsetCanvasX = centerY;
    offsetCanvasY = centerX;
  } else {
    offsetCanvasX = centerX;
    offsetCanvasY = centerY;
  }
  const e = offsetCanvasX - a * centerX - c * centerY;
  const f = offsetCanvasY - b * centerX - d * centerY;
  return { x: a * x + c * y + e, y: b * x + d * y + f };
}

/**
 * The linear part of the same viewport transform, applied to a direction vector.
 * Note it is not a pure rotation — a quarter turn composes with the y-flip that
 * takes PDF's upward y to the canvas's downward y — which is exactly why hand-
 * rolling "add the page rotation" gets this wrong.
 */
function viewportDirection(vx: number, vy: number, rotation: number): { x: number; y: number } {
  const origin = viewportPoint(0, 0, 0, 0, rotation);
  const moved = viewportPoint(vx, vy, 0, 0, rotation);
  return { x: moved.x - origin.x, y: moved.y - origin.y };
}

const ROTATIONS = [0, 90, 180, 270] as const;

/* ------------------------------------------------------------------ *
 * Content-stream probes.
 * ------------------------------------------------------------------ */

async function pageStream(doc: PDFDocument, index: number): Promise<string> {
  const { decodeStream } = await import('../../src/core/pdf/interpreter');
  const page = doc.getPage(index);
  const contents = page.node.Contents();
  if (!contents) return '';
  const streams: unknown[] =
    contents instanceof PDFArray
      ? contents.asArray().map(ref => doc.context.lookup(ref))
      : [contents];
  let text = '';
  for (const stream of streams) {
    const s = stream as any;
    const raw: Uint8Array = s.getContents();
    const isFlate = String(s.dict?.get(PDFName.of('Filter'))) === '/FlateDecode';
    text += new TextDecoder('latin1').decode(isFlate ? await decodeStream(raw) : raw);
  }
  // pdf-lib writes show-text operands as hex literals, so append their decoding —
  // otherwise an assertion on the visible string fails on a page that draws it.
  let decoded = '';
  for (const match of text.matchAll(/<([0-9A-Fa-f\s]+)>/g)) {
    const hex = match[1].replace(/\s+/g, '');
    for (let i = 0; i + 1 < hex.length; i += 2) {
      decoded += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    }
    decoded += ' ';
  }
  return `${text}\n${decoded}`;
}

interface Anchor {
  /** Translation — where the draw is anchored, in raw page space. */
  x: number;
  y: number;
  /** First column of the draw's own matrix, i.e. where its local +x axis points. */
  a: number;
  b: number;
}

/** Every `a b c d e f <op>` matrix in the stream, for `Tm` (text) or `cm` (images). */
function matrices(stream: string, op: 'Tm' | 'cm'): Anchor[] {
  const num = '(-?[\\d.]+)';
  const re = new RegExp(`${num} ${num} ${num} ${num} ${num} ${num} ${op}`, 'g');
  return [...stream.matchAll(re)].map(m => ({
    a: Number(m[1]),
    b: Number(m[2]),
    x: Number(m[5]),
    y: Number(m[6])
  }));
}

/** Text draws: pdf-lib emits one `Tm` per `drawText`. */
const drawAnchors = (stream: string): Anchor[] => matrices(stream, 'Tm');

/** A blank source page of the given raw size with the given `/Rotate`. */
async function rotatedSource(width: number, height: number, rotation: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([width, height]);
  if (rotation) page.setRotation(degrees(rotation));
  return doc.save();
}

const RAW_W = 400;
const RAW_H = 800;

function onlyPage(
  pages: {
    key: string;
    sourceDocId: string;
    sourceIndex: number;
    rotation: number;
    cropBox?: unknown;
  }[]
) {
  return pages;
}

/* ------------------------------------------------------------------ *
 * The shared transform itself.
 * ------------------------------------------------------------------ */

describe('displayPointToPage is the exact inverse of pdf.js PageViewport', () => {
  for (const rotation of ROTATIONS) {
    it(`round-trips every corner at /Rotate ${rotation}`, () => {
      const frame = displayFrame(RAW_W, RAW_H, rotation);
      for (const [px, py] of [
        [0, 0],
        [RAW_W, 0],
        [0, RAW_H],
        [RAW_W, RAW_H],
        [137, 512]
      ] as const) {
        const display = viewportPoint(px, py, RAW_W, RAW_H, rotation);
        const back = displayPointToPage(frame, display.x, display.y);
        expect(back.x).toBeCloseTo(px, 6);
        expect(back.y).toBeCloseTo(py, 6);
      }
    });

    it(`reports the displayed page size at /Rotate ${rotation}`, () => {
      const frame = displayFrame(RAW_W, RAW_H, rotation);
      const swapped = rotation === 90 || rotation === 270;
      expect(frame.displayWidth).toBe(swapped ? RAW_H : RAW_W);
      expect(frame.displayHeight).toBe(swapped ? RAW_W : RAW_H);
    });
  }

  it('maps a displayed click back into the raw page frame', () => {
    const frame = displayFrame(RAW_W, RAW_H, 90);
    const point = displayPointToNormalizedPage(frame, frame.displayWidth * 0.25, frame.displayHeight * 0.75);
    expect(point.x).toBeCloseTo(0.75, 6);
    expect(point.y).toBeCloseTo(0.75, 6);
  });

  it('is a no-op on an unrotated page, so existing output is unchanged', () => {
    const frame = displayFrame(RAW_W, RAW_H, 0);
    const placed = placeDisplayBox(frame, 30, 40, 100, 20, 0);
    expect(placed).toEqual({ x: 30, y: 40, rotate: 0 });
  });

  it('offsets into a crop box so edge-anchored content stays inside it', () => {
    // A crop box inset 50pt on every side: display-space (0,0) is the crop box's
    // bottom-left corner, not the MediaBox's.
    const frame = displayFrame(RAW_W - 100, RAW_H - 100, 0, 50, 50);
    const placed = placeDisplayBox(frame, 0, 0, 0, 0);
    expect(placed.x).toBe(50);
    expect(placed.y).toBe(50);
  });
});

/* ------------------------------------------------------------------ *
 * Crop
 * ------------------------------------------------------------------ */

describe('crop takes the half the viewport shows (§3)', () => {
  for (const rotation of ROTATIONS) {
    it(`crops the displayed top-left quadrant at /Rotate ${rotation}`, async () => {
      const source = await rotatedSource(RAW_W, RAW_H, rotation);
      const bytes = await processWorkerImpl.compose(
        [
          {
            key: 'p0',
            sourceDocId: 's',
            sourceIndex: 0,
            rotation: 0,
            cropBox: { x: 0, y: 0, width: 0.5, height: 0.5 }
          }
        ] satisfies PageSource[],
        { s: source },
        [],
        undefined,
        undefined,
        null,
        null,
        undefined,
        silentJob
      );

      const out = await PDFDocument.load(bytes);
      const crop = out.getPage(0).getCropBox();

      // Independently: the displayed top-left quadrant's two opposite corners,
      // mapped back through the viewport.
      const frame = displayFrame(RAW_W, RAW_H, rotation);
      const c0 = displayPointToPage(frame, 0, 0);
      const c1 = displayPointToPage(frame, frame.displayWidth / 2, frame.displayHeight / 2);
      expect(crop.x).toBeCloseTo(Math.min(c0.x, c1.x), 4);
      expect(crop.y).toBeCloseTo(Math.min(c0.y, c1.y), 4);
      expect(crop.width).toBeCloseTo(Math.abs(c1.x - c0.x), 4);
      expect(crop.height).toBeCloseTo(Math.abs(c1.y - c0.y), 4);

      // And the crop must be exactly one quarter of the page, whichever way round.
      expect(crop.width * crop.height).toBeCloseTo((RAW_W * RAW_H) / 4, 3);

      // The decisive check: re-project the crop box through the viewport. It has
      // to be the *displayed* top-left quadrant, not some other quadrant that
      // happens to be a quarter of the MediaBox.
      const projected = [
        viewportPoint(crop.x, crop.y, RAW_W, RAW_H, rotation),
        viewportPoint(crop.x + crop.width, crop.y + crop.height, RAW_W, RAW_H, rotation)
      ];
      const left = Math.min(projected[0].x, projected[1].x);
      const top = Math.min(projected[0].y, projected[1].y);
      const right = Math.max(projected[0].x, projected[1].x);
      const bottom = Math.max(projected[0].y, projected[1].y);
      expect(left).toBeCloseTo(0, 4);
      expect(top).toBeCloseTo(0, 4);
      expect(right).toBeCloseTo(frame.displayWidth / 2, 4);
      expect(bottom).toBeCloseTo(frame.displayHeight / 2, 4);
    });
  }
});

/* ------------------------------------------------------------------ *
 * Watermark, header/footer, Bates
 * ------------------------------------------------------------------ */

const WATERMARK: WatermarkData = {
  kind: 'text',
  text: 'WM',
  imageScale: 0.35,
  position: 'bottom-right',
  opacity: 1,
  rotation: 0,
  fontSize: 18,
  color: '#111111',
  startAt: 1,
  pageRange: ''
};

const HEADER_FOOTER: HeaderFooterData = {
  headerText: 'HEAD',
  footerText: 'FOOT',
  headerAlign: 'left',
  footerAlign: 'left',
  fontSize: 10,
  pageRange: ''
};

const BATES = { prefix: 'B', digits: 4, start: 1, position: 'bottom-left', fontSize: 10 };

/**
 * Composes one page carrying a watermark, a header/footer and a Bates number, and
 * returns every anchor the page draws at, in *display* space.
 */
async function displayAnchors(
  rotation: number,
  cropBox?: { x: number; y: number; width: number; height: number }
) {
  const source = await rotatedSource(RAW_W, RAW_H, rotation);
  const bytes = await processWorkerImpl.compose(
    [
      { key: 'p0', sourceDocId: 's', sourceIndex: 0, rotation: 0, ...(cropBox ? { cropBox } : {}) }
    ] satisfies PageSource[],
    { s: source },
    [],
    WATERMARK,
    HEADER_FOOTER,
    null,
    null,
    undefined,
    silentJob,
    { bates: BATES } satisfies ComposeExtras
  );
  const out = await PDFDocument.load(bytes);
  const stream = await pageStream(out, 0);
  const anchors = drawAnchors(stream);
  return {
    out,
    stream,
    anchors: anchors.map(anchor => ({
      ...viewportPoint(anchor.x, anchor.y, RAW_W, RAW_H, rotation),
      // The upright-ness check: `a`/`b` are the first column of the draw's CTM.
      // Content that reads the right way up in the viewport has its local +x axis
      // pointing along the viewport's +x axis.
      a: anchor.a,
      b: anchor.b
    }))
  };
}

describe('watermark, header/footer and Bates use the displayed frame (§3)', () => {
  for (const rotation of ROTATIONS) {
    it(`places all three in the displayed frame at /Rotate ${rotation}`, async () => {
      const { stream, anchors } = await displayAnchors(rotation);
      const frame = displayFrame(RAW_W, RAW_H, rotation);

      // All three strings made it into the page.
      for (const marker of ['WM', 'HEAD', 'FOOT', 'B0001']) {
        expect(stream).toContain(marker);
      }
      expect(anchors).toHaveLength(4);

      // Every anchor lands inside the displayed page box.
      for (const a of anchors) {
        expect(a.x).toBeGreaterThanOrEqual(-1);
        expect(a.y).toBeGreaterThanOrEqual(-1);
        expect(a.x).toBeLessThanOrEqual(frame.displayWidth + 1);
        expect(a.y).toBeLessThanOrEqual(frame.displayHeight + 1);
      }

      // Every one of them reads upright in the viewport: pushed through the
      // viewport's own linear map, each draw's local +x axis points along display
      // +x, i.e. the text runs left-to-right on screen rather than sideways.
      for (const a of anchors) {
        const dir = viewportDirection(a.a, a.b, rotation);
        expect(dir.x).toBeCloseTo(1, 5);
        expect(dir.y).toBeCloseTo(0, 5);
      }

      // Quadrants, in display space. The header sits in the top band, the footer,
      // Bates (bottom-left) and watermark (bottom-right) in the bottom band; the
      // watermark is right of the Bates number.
      const header = anchors.find(a => a.y < frame.displayHeight / 2);
      expect(header, 'header must be in the displayed top half').toBeDefined();
      const bottom = anchors.filter(a => a.y > frame.displayHeight / 2);
      expect(bottom, 'footer, Bates and watermark are all bottom-anchored').toHaveLength(3);
      expect(bottom.some(a => a.x > frame.displayWidth / 2)).toBe(true);
      expect(bottom.some(a => a.x < frame.displayWidth / 2)).toBe(true);
    });
  }

  it('keeps the Bates number inside a crop box applied by the same export', async () => {
    // Bottom-left quadrant in display space — the half a MediaBox-relative Bates
    // stamp on a rotated page would miss entirely.
    const cropBox = { x: 0, y: 0.5, width: 0.5, height: 0.5 };
    for (const rotation of ROTATIONS) {
      const source = await rotatedSource(RAW_W, RAW_H, rotation);
      const bytes = await processWorkerImpl.compose(
        onlyPage([
          { key: 'p0', sourceDocId: 's', sourceIndex: 0, rotation: 0, cropBox }
        ] satisfies PageSource[]),
        { s: source },
        [],
        undefined,
        undefined,
        null,
        null,
        undefined,
        silentJob,
        { bates: BATES } satisfies ComposeExtras
      );
      const out = await PDFDocument.load(bytes);
      const crop = out.getPage(0).getCropBox();
      const anchors = drawAnchors(await pageStream(out, 0));
      expect(anchors, `one Bates draw at /Rotate ${rotation}`).toHaveLength(1);
      const { x, y } = anchors[0];
      expect(x, `Bates x inside crop at /Rotate ${rotation}`).toBeGreaterThanOrEqual(crop.x - 1);
      expect(x).toBeLessThanOrEqual(crop.x + crop.width + 1);
      expect(y, `Bates y inside crop at /Rotate ${rotation}`).toBeGreaterThanOrEqual(crop.y - 1);
      expect(y).toBeLessThanOrEqual(crop.y + crop.height + 1);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Stamps vs the workspace rotate tool
 * ------------------------------------------------------------------ */

describe('rotating a page after signing it does not move or spin the signature (§3)', () => {
  const STAMP = {
    pageKey: 'p0',
    type: 'text' as const,
    text: 'SIGNED',
    x: 0.1,
    y: 0.1,
    width: 0.3,
    height: 0.05,
    rotation: 0
  };

  async function stampAnchor(sourceRotation: number, toolRotation: number) {
    const source = await rotatedSource(RAW_W, RAW_H, sourceRotation);
    const bytes = await processWorkerImpl.compose(
      onlyPage([
        { key: 'p0', sourceDocId: 's', sourceIndex: 0, rotation: toolRotation }
      ] satisfies PageSource[]),
      { s: source },
      [STAMP] satisfies StampSource[],
      undefined,
      undefined,
      null,
      null,
      undefined,
      silentJob
    );
    const out = await PDFDocument.load(bytes);
    const anchors = drawAnchors(await pageStream(out, 0));
    expect(anchors).toHaveLength(1);
    return { anchor: anchors[0], total: out.getPage(0).getRotation().angle };
  }

  it('writes the same page-space position however the rotate tool was used', async () => {
    const base = await stampAnchor(0, 0);
    for (const toolRotation of [90, 180, 270]) {
      const turned = await stampAnchor(0, toolRotation);
      // /Rotate on the output does change — the page really is turned.
      expect(turned.total).toBe(toolRotation);
      // The stamp does not: it stays glued to the same spot on the content, which
      // is the frame `SinglePageView` draws its overlay in. Before the fix the
      // anchor moved and the text spun with every extra quarter turn.
      expect(turned.anchor.x).toBeCloseTo(base.anchor.x, 4);
      expect(turned.anchor.y).toBeCloseTo(base.anchor.y, 4);
      expect(turned.anchor.a).toBeCloseTo(base.anchor.a, 6);
      expect(turned.anchor.b).toBeCloseTo(base.anchor.b, 6);
    }
  });

  it('still honours the source /Rotate, which the overlay does carry', async () => {
    // Source rotation is baked into the rendered canvas the overlay sits on, so
    // unlike the tool rotation it must change where the stamp is written.
    const flat = await stampAnchor(0, 0);
    const turned = await stampAnchor(90, 0);
    expect(turned.anchor.x).not.toBeCloseTo(flat.anchor.x, 1);

    // And it lands where the viewport says: the stamp's display-space box is
    // (0.1, 0.1) of the displayed page, top-left origin.
    const frame = displayFrame(RAW_W, RAW_H, 90);
    const h = STAMP.height * frame.displayHeight;
    const expected = placeDisplayBox(
      frame,
      STAMP.x * frame.displayWidth,
      frame.displayHeight - (STAMP.y * frame.displayHeight + h),
      STAMP.width * frame.displayWidth,
      h,
      0
    );
    // The text baseline sits inside that box, so compare the box, not the glyph
    // origin: the anchor must be within the placed box's own extent.
    expect(Math.hypot(turned.anchor.x - expected.x, turned.anchor.y - expected.y)).toBeLessThan(
      Math.max(STAMP.width * frame.displayWidth, h) + 1
    );
  });
});

/* ------------------------------------------------------------------ *
 * Page-range semantics (§3, third bullet)
 * ------------------------------------------------------------------ */

describe('header/footer and Bates ranges are document page numbers, not slice offsets', () => {
  function refs(count: number) {
    return Array.from({ length: count }, (_, sourceIndex) => ({
      key: `p${sourceIndex}`,
      sourceDocId: 'source',
      sourceIndex,
      rotation: 0
    }));
  }

  it('does not restamp every split slice as if it started at page 1', async () => {
    const { textPdf } = await import('../e2e/fixtures');
    const source = await textPdf(4);

    const result = await processWorkerImpl.composeSplit(
      refs(4) satisfies PageSource[],
      { source },
      [2],
      [],
      undefined,
      {
        ...HEADER_FOOTER,
        headerText: 'HEAD {n}/{total}',
        footerText: '',
        pageRange: '1-2'
      } as never,
      null,
      null,
      'part',
      undefined,
      silentJob,
      { bates: BATES } satisfies ComposeExtras
    );
    expect(result.isZip).toBe(true);

    const { unzipSync } = await import('fflate');
    const files = unzipSync(result.bytes);
    const names = Object.keys(files).sort();
    expect(names).toHaveLength(2);

    const first = await PDFDocument.load(files[names[0]]);
    const second = await PDFDocument.load(files[names[1]]);

    // "1-2" means document pages 1 and 2, which is the whole first slice…
    expect(await pageStream(first, 0)).toContain('HEAD 1/4');
    expect(await pageStream(first, 1)).toContain('HEAD 2/4');
    // …and none of the second, which used to be re-stamped as pages 1 and 2.
    expect(await pageStream(second, 0)).not.toContain('HEAD');
    expect(await pageStream(second, 1)).not.toContain('HEAD');

    // Bates numbering is sequential across the whole production set, not per file.
    expect(await pageStream(first, 0)).toContain('B0001');
    expect(await pageStream(second, 0)).toContain('B0003');
    expect(await pageStream(second, 1)).toContain('B0004');
  });
});

/* ------------------------------------------------------------------ *
 * Contact sheet pagination (§5)
 * ------------------------------------------------------------------ */

describe('contact sheet paginates instead of shrinking cells (§5)', () => {
  const JPEG_1X1 = new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x60,
    0x00, 0x60, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08,
    0x07, 0x07, 0x07, 0x09, 0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12,
    0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20, 0x24, 0x2e, 0x27, 0x20,
    0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29, 0x2c, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1f, 0x27,
    0x39, 0x3d, 0x38, 0x32, 0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01,
    0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x1f, 0x00, 0x00, 0x01, 0x05, 0x01, 0x01,
    0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04,
    0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f,
    0x00, 0xbf, 0x00, 0xff, 0xd9
  ]);

  it('spreads 300 pages over many sheets, keeping every cell legible', async () => {
    const jpegs = Array.from({ length: 300 }, () => JPEG_1X1);
    const bytes = await processWorkerImpl.contactSheetExport(jpegs, 4);
    const out = await PDFDocument.load(bytes);

    // The whole point: not one page.
    expect(out.getPageCount()).toBeGreaterThan(1);
    expect(out.getPageCount()).toBe(Math.ceil(300 / 20));

    // Every thumbnail is on some sheet, none silently dropped.
    let embedded = 0;
    for (let i = 0; i < out.getPageCount(); i++) {
      const xobjects = out.getPage(i).node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict);
      embedded += xobjects?.entries().length ?? 0;
    }
    expect(embedded).toBe(300);

    // And the drawn cell is legible rather than the ~10pt the audit measured.
    // pdf-lib's `drawImage` emits translate/rotate/scale/skew as separate `cm`
    // operators; the scale one carries the drawn width in points.
    const scales = matrices(await pageStream(out, 0), 'cm').filter(
      c => c.x === 0 && c.y === 0 && c.b === 0 && c.a !== 1
    );
    expect(scales).toHaveLength(20);
    for (const scale of scales) {
      expect(Math.abs(scale.a)).toBeGreaterThan(60);
    }
  });
});
