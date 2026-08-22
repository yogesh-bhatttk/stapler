/**
 * RED-08 — the pixel half of blurring a detected region.
 *
 * Kept apart from the worker that calls it for the same reason
 * `pdf/image-redaction.ts` is: a y-flip error here does not fail loudly, it
 * mosaics the wrong band of the image and leaves the face perfectly readable.
 * Both files share `UnitRect`/`RedactableImage` deliberately — the coordinate
 * convention a detected box arrives in has to be the *same* convention a
 * redaction mark arrives in, or one of the two call sites is silently wrong.
 *
 * Mosaic rather than Gaussian blur, on purpose. A Gaussian blur is a linear,
 * invertible-in-principle operation: given the kernel, deconvolution recovers a
 * surprising amount, and off-the-shelf tools do it. Averaging a block down to
 * one colour throws the samples away — there is nothing left to deconvolve.
 * Strength is expressed as "how many blocks across the region", so a small face
 * and a large one are obscured to the same degree rather than the same pixel
 * count.
 */
import type { RedactableImage, UnitRect } from '../pdf/image-redaction';

export type BlurStrength = 'light' | 'medium' | 'strong';

/**
 * Blocks across the *shorter* side of the region. Fewer blocks = coarser =
 * more destructive. `strong` at four blocks leaves a face as a 4×4 colour
 * patch, which is well past what published face-reconstruction attacks recover
 * from; `light` is for a case where the user wants the subject still
 * recognisable as a person but not as an individual.
 */
const BLOCKS_ACROSS: Record<BlurStrength, number> = {
  light: 12,
  medium: 8,
  strong: 4
};

export interface PixelateOptions {
  strength?: BlurStrength;
  /**
   * Grow each rect by this fraction of its own size before mosaicking, on every
   * side. A face detector returns a box around the facial features, not around
   * the head: at zero padding the chin, hairline and ears stay sharp, which is
   * most of what makes a person recognisable. Clamped to the image.
   */
  padFraction?: number;
}

const DEFAULT_PAD_FRACTION = 0.15;

/** Never fewer than this many pixels per block, or "blurring" a tiny box is a no-op. */
const MIN_BLOCK_PX = 2;

interface PixelBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * A unit-space rect (x right, y **up** from the bottom-left — the space every
 * PDF image is drawn into) converted to half-open pixel bounds with rows running
 * *down* from the top, padded, and clipped to the image.
 *
 * Bounds are rounded outwards so a region covering part of a pixel covers all of
 * it. Over-covering is the only safe rounding direction here, exactly as it is
 * for a redaction.
 */
export function rectToPixelBox(
  rect: UnitRect,
  width: number,
  height: number,
  padFraction = DEFAULT_PAD_FRACTION
): PixelBox | null {
  const padX = rect.width * padFraction;
  const padY = rect.height * padFraction;
  const left = rect.x - padX;
  const right = rect.x + rect.width + padX;
  const bottom = rect.y - padY;
  const top = rect.y + rect.height + padY;

  const x0 = Math.max(0, floorOut(left * width));
  const x1 = Math.min(width, ceilOut(right * width));
  // y is measured up from the bottom in unit space and down from the top in
  // pixel rows, so the *top* of the rect gives the *first* row.
  const y0 = Math.max(0, floorOut((1 - top) * height));
  const y1 = Math.min(height, ceilOut((1 - bottom) * height));

  if (x1 <= x0 || y1 <= y0) return null;
  return { x0, y0, x1, y1 };
}

/**
 * Round outwards, but not because of floating-point noise.
 *
 * A rect covering exactly half a pixel must cover the whole pixel — that is the
 * "over-cover" rule, and it is deliberate. A rect landing exactly on a pixel
 * boundary must *not* spill into the next one, and after unit-space arithmetic
 * such a boundary routinely arrives as 39.99999999999999 rather than 40. The
 * epsilon separates the two cases: a genuine half-pixel is thousands of times
 * larger than it, and float noise is thousands of times smaller.
 */
const BOUNDARY_EPSILON = 1e-6;

function floorOut(value: number): number {
  return Math.floor(value + BOUNDARY_EPSILON);
}

function ceilOut(value: number): number {
  return Math.ceil(value - BOUNDARY_EPSILON);
}

/**
 * Mosaics unit-space rectangles into an image's pixels, in place.
 *
 * Only pixels inside a rect are written. That is not a detail — RED-08's
 * acceptance criterion is that a region overlapping the face is obscured **and
 * no others are**, so every write is bounded by the clipped box above and the
 * per-block loops below never step outside it.
 *
 * The soft mask is mosaicked over the same boxes when present. Leaving it sharp
 * would keep a pixel-accurate alpha silhouette of the head in the file — the
 * outline of a face is not as identifying as the face, but it is not nothing,
 * and it costs one extra loop to destroy it. (This differs from `paintRectsBlack`,
 * which forces the mask *opaque*: a redaction must not let a mask reveal what is
 * behind the black box, whereas a blur has to keep the image composited the way
 * the page expects, or a cut-out photo would gain an opaque rectangle.)
 */
export function pixelateRects(
  image: RedactableImage,
  rects: UnitRect[],
  options: PixelateOptions = {}
): void {
  const { rgba, width, height, mask } = image;
  const blocksAcross = BLOCKS_ACROSS[options.strength ?? 'medium'];
  const padFraction = options.padFraction ?? DEFAULT_PAD_FRACTION;

  for (const rect of rects) {
    const box = rectToPixelBox(rect, width, height, padFraction);
    if (!box) continue;

    const boxWidth = box.x1 - box.x0;
    const boxHeight = box.y1 - box.y0;
    const block = Math.max(MIN_BLOCK_PX, Math.round(Math.min(boxWidth, boxHeight) / blocksAcross));

    for (let by = box.y0; by < box.y1; by += block) {
      const yEnd = Math.min(by + block, box.y1);
      for (let bx = box.x0; bx < box.x1; bx += block) {
        const xEnd = Math.min(bx + block, box.x1);

        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        let m = 0;
        let count = 0;
        for (let y = by; y < yEnd; y++) {
          for (let x = bx; x < xEnd; x++) {
            const p = y * width + x;
            r += rgba[p * 4];
            g += rgba[p * 4 + 1];
            b += rgba[p * 4 + 2];
            a += rgba[p * 4 + 3];
            if (mask) m += mask[p];
            count += 1;
          }
        }
        if (count === 0) continue;

        // `Math.round` and not a truncation: a block of identical pixels must
        // come back as exactly that value, or a flat area shifts by a level
        // every time the tool runs.
        const ar = Math.round(r / count);
        const ag = Math.round(g / count);
        const ab = Math.round(b / count);
        const aa = Math.round(a / count);
        const am = mask ? Math.round(m / count) : 0;

        for (let y = by; y < yEnd; y++) {
          for (let x = bx; x < xEnd; x++) {
            const p = y * width + x;
            rgba[p * 4] = ar;
            rgba[p * 4 + 1] = ag;
            rgba[p * 4 + 2] = ab;
            rgba[p * 4 + 3] = aa;
            if (mask) mask[p] = am;
          }
        }
      }
    }
  }
}
