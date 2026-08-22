/**
 * RED-02 — the pixel half of redacting an image.
 *
 * Kept apart from the pdf.js worker that calls it so the geometry can be tested
 * without a canvas: a y-flip error here does not fail loudly, it blacks out the
 * wrong band of the image and leaves the secret one visible.
 */
import { fillPolygonMask, growMask, type Point } from '../geometry';

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
