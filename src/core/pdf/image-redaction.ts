/**
 * RED-02 — the pixel half of redacting an image.
 *
 * Kept apart from the pdf.js worker that calls it so the geometry can be tested
 * without a canvas: a y-flip error here does not fail loudly, it blacks out the
 * wrong band of the image and leaves the secret one visible.
 */
import { fillPolygonMask, growMask, shrinkMask, type Point } from '../geometry';

/** A rectangle in an image's own unit square, y upwards from the bottom-left. */
export interface UnitRect {
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * RED-07 — a shaped mark's polygon, in the same unit space. When present the
   * rectangle is only its bounding box and the polygon decides which pixels go,
   * so a shape covers what the user drew rather than the box around it.
   */
  polygon?: Point[];
}

export interface RedactableImage {
  /** Straight (un-premultiplied) RGBA, mutated in place. */
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  /** The image's soft mask, if it had one. Mutated in place when present. */
  mask?: Uint8Array;
}

/**
 * Paints unit-space rectangles opaque black into an image's pixels.
 *
 * The unit square is the space every PDF image is drawn into: x rightwards, y
 * *upwards* from the bottom-left, while pixel rows run downwards from the top —
 * hence the flip. Bounds are rounded outwards, so a rectangle covering part of a
 * pixel covers all of it: over-removal is the only safe rounding direction for a
 * redaction.
 *
 * The mask is blacked out too. Leaving it alone would let a soft mask make the
 * new black rectangle transparent again, showing whatever is painted behind the
 * image through the hole where the redaction is supposed to be.
 */
export function paintRectsBlack(image: RedactableImage, rects: UnitRect[]): void {
  const { rgba, width, height, mask } = image;
  for (const rect of rects) {
    const x0 = Math.max(0, Math.floor(rect.x * width));
    const x1 = Math.min(width, Math.ceil((rect.x + rect.width) * width));
    const y0 = Math.max(0, Math.floor((1 - rect.y - rect.height) * height));
    const y1 = Math.min(height, Math.ceil((1 - rect.y) * height));
    // RED-07 — a shaped mark rasterises its polygon into this image's own pixel
    // grid instead of filling the box. Dilated by one pixel so a partly-covered
    // pixel is still destroyed, keeping the same over-removal bias the box
    // rounding above has.
    const shape = rect.polygon
      ? growMask(
          fillPolygonMask(
            // Unit space is y-up, pixel rows run down.
            rect.polygon.map(p => ({ x: p.x * width, y: (1 - p.y) * height })),
            width,
            height
          ),
          width,
          height,
          1
        )
      : undefined;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const p = y * width + x;
        if (shape && shape[p] === 0) continue;
        rgba[p * 4] = 0;
        rgba[p * 4 + 1] = 0;
        rgba[p * 4 + 2] = 0;
        rgba[p * 4 + 3] = 255;
        if (mask) mask[p] = 255;
      }
    }
  }
}

/**
 * RED-03 — what an image still holds where {@link paintRectsBlack} was supposed
 * to have destroyed it.
 *
 * This is the pixel check that cannot be fooled by the cover rectangle. Grading
 * the *rendered page* answers "does the mark look opaque", which an overlay
 * satisfies just as well as a redaction does — a page whose secret survived
 * intact under an opaque black rectangle renders as solid black and measures as
 * perfectly clean. This reads the embedded image XObject instead, so it sees what
 * a viewer's "extract images" or `pdfimages` would see rather than what the
 * compositor drew, and it needs no text layer — which is the whole point, because
 * a redaction over a photograph or a scan has no text for the other half of the
 * gate to re-extract.
 */
export interface BlackoutResidue {
  /** Pixels examined inside the covered rects, after the edge inset below. */
  sampled: number;
  /** Sampled pixels brighter than `tolerance` on any channel, i.e. not black. */
  offBlack: number;
  /** `offBlack / sampled`, 0 when nothing could be sampled. */
  fraction: number;
  /**
   * Sampled pixels at or above {@link BLACKOUT_BRIGHT_LEVEL} — content bright
   * enough to read, as opposed to the dark halo a JPEG re-encode leaves around a
   * blacked-out area. A small leak is invisible in `fraction` but not here.
   */
  bright: number;
  /** `bright / sampled`, 0 when nothing could be sampled. */
  brightFraction: number;
  /** Brightest channel value seen on any sampled pixel, 0..255. */
  maxLevel: number;
}

/**
 * Per-channel slack allowed against opaque black, out of 255.
 *
 * `paintRectsBlack` writes exact zeroes, but the image is re-encoded as JPEG on
 * the way back into the document (PNG only when it carries a soft mask), and
 * JPEG's 8×8 blocks smear the sharp black/content boundary in both directions.
 * Anything at or below this level is visually black and holds nothing a reader
 * could recover; a photograph or a glyph that was never painted over sits far
 * above it.
 */
export const BLACKOUT_LEVEL_TOLERANCE = 32;

/**
 * Level at which a surviving pixel is bright enough to read rather than dark
 * halo, out of 255.
 *
 * Measured, not guessed: re-encoding a high-frequency photograph with a blacked
 * out square in it leaves a ring around that square reaching ~8 pixels inward and
 * peaking near 75/255 immediately outside the inset below. Real content sits at
 * natural image levels, well above this.
 */
export const BLACKOUT_BRIGHT_LEVEL = 128;

/** Floor for the proportional inset below — always at least this many pixels. */
const MIN_MEASURE_INSET = 2;

/** Fraction of the shorter side trimmed at each edge of a covered rect. */
const MEASURE_INSET_FRACTION = 0.08;

/**
 * `paintRectsBlack` rounds the covered box *outwards*, so its last painted pixel
 * row is only partly inside the mark and its neighbour — legitimately kept
 * content — is one pixel away. Worse, the image is re-encoded as JPEG on the way
 * back into the document, and JPEG's blocks smear that hard black/content
 * boundary several pixels *into* the painted area. Measurement therefore rounds
 * inwards and trims a proportional margin, the same 8% of the shorter side the
 * region renderer's own anti-aliasing inset uses: over-sampling here would refuse
 * correct redactions, which is as harmful as passing a bad one.
 *
 * Never more than a third of the rect, so a thin sliver is still graded on
 * something rather than skipped.
 */
function insetFor(pxWidth: number, pxHeight: number): number {
  const shortest = Math.min(pxWidth, pxHeight);
  const wanted = Math.max(MIN_MEASURE_INSET, Math.round(shortest * MEASURE_INSET_FRACTION));
  return Math.max(
    0,
    Math.min(wanted, Math.floor((pxWidth - 1) / 3), Math.floor((pxHeight - 1) / 3))
  );
}

/**
 * Measures how much of `rects` is still not black in `image`'s own pixels.
 *
 * The geometry deliberately mirrors {@link paintRectsBlack} — same unit square,
 * same y-flip, same polygon rasterisation — with both roundings reversed, so the
 * two can never disagree about which pixels a mark owns. Pure, so the arithmetic
 * is tested without a canvas.
 *
 * Only colour is graded, not the soft mask: `paintRectsBlack` forces the mask
 * opaque, but a mask left translucent would reveal the *page* behind the image,
 * never the original pixels it destroyed, so it is not a leak of redacted
 * content and must not fail a save.
 */
export function measureRectsBlacked(
  image: RedactableImage,
  rects: UnitRect[],
  tolerance: number = BLACKOUT_LEVEL_TOLERANCE
): BlackoutResidue {
  const { rgba, width, height } = image;
  let sampled = 0;
  let offBlack = 0;
  let bright = 0;
  let maxLevel = 0;

  // A pixel covered by two overlapping marks must be counted once, or a
  // double-covered area would dominate the fraction.
  const seen = new Uint8Array(width * height);

  for (const rect of rects) {
    const bx0 = Math.max(0, Math.ceil(rect.x * width));
    const bx1 = Math.min(width, Math.floor((rect.x + rect.width) * width));
    const by0 = Math.max(0, Math.ceil((1 - rect.y - rect.height) * height));
    const by1 = Math.min(height, Math.floor((1 - rect.y) * height));
    if (!(bx1 > bx0) || !(by1 > by0)) continue;

    const inset = insetFor(bx1 - bx0, by1 - by0);
    const x0 = bx0 + inset;
    const x1 = bx1 - inset;
    const y0 = by0 + inset;
    const y1 = by1 - inset;
    if (!(x1 > x0) || !(y1 > y0)) continue;

    // RED-07 — a shaped mark only owns what its polygon covered, eroded by the
    // same inset the box path trims, which is `growMask(…, 1)` reversed.
    const shape = rect.polygon
      ? shrinkMask(
          fillPolygonMask(
            rect.polygon.map(p => ({ x: p.x * width, y: (1 - p.y) * height })),
            width,
            height
          ),
          width,
          height,
          inset + 1
        )
      : undefined;

    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const p = y * width + x;
        if (shape && shape[p] === 0) continue;
        if (seen[p]) continue;
        seen[p] = 1;
        const level = Math.max(rgba[p * 4], rgba[p * 4 + 1], rgba[p * 4 + 2]);
        sampled++;
        if (level > tolerance) offBlack++;
        if (level >= BLACKOUT_BRIGHT_LEVEL) bright++;
        if (level > maxLevel) maxLevel = level;
      }
    }
  }

  return {
    sampled,
    offBlack,
    fraction: sampled > 0 ? offBlack / sampled : 0,
    bright,
    brightFraction: sampled > 0 ? bright / sampled : 0,
    maxLevel
  };
}
