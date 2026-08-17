/**
 * Page rotation arithmetic.
 *
 * PDF's `/Rotate` must be a multiple of 90, and viewers disagree about negative
 * values. The store used a plain `%`, which yields -90 as soon as the user rotates
 * anticlockwise from 0 — so a rotation that looked right in the grid could export
 * wrong. Everything that touches rotation goes through here.
 */

/** Normalises any degree value to one of 0, 90, 180, 270. */
export function normalizeRotation(degrees: number): 0 | 90 | 180 | 270 {
  const snapped = Math.round(degrees / 90) * 90;
  const wrapped = ((snapped % 360) + 360) % 360;
  return wrapped as 0 | 90 | 180 | 270;
}

/** True when the rotation swaps the page's width and height. */
export function isQuarterTurn(degrees: number): boolean {
  const r = normalizeRotation(degrees);
  return r === 90 || r === 270;
}

/**
 * Aspect ratio of a page as displayed, given its unrotated size.
 * The thumbnail box needs this or a rotated page renders squashed inside a
 * portrait-shaped frame.
 */
export function displayedAspectRatio(width: number, height: number, rotation: number): number {
  if (width <= 0 || height <= 0) return 1 / 1.414;
  return isQuarterTurn(rotation) ? height / width : width / height;
}

/**
 * Given a box's center and its (unrotated) width/height, returns the bottom-left
 * origin such that rotating the box by `angleDegrees` about that origin — as
 * pdf-lib's `rotate` draw option does — leaves the box's center fixed at
 * `(cx, cy)`.
 */
export function centerPreservingOrigin(
  cx: number,
  cy: number,
  w: number,
  h: number,
  angleDegrees: number
): { x: number; y: number } {
  const rad = (angleDegrees * Math.PI) / 180;
  const dx = (w / 2) * Math.cos(rad) - (h / 2) * Math.sin(rad);
  const dy = (w / 2) * Math.sin(rad) + (h / 2) * Math.cos(rad);
  return { x: cx - dx, y: cy - dy };
}

/**
 * The single rotation-aware coordinate frame every placement tool must agree on.
 *
 * `/Rotate` is a display-only transform: page content always lives in the raw,
 * unrotated MediaBox, which is the only frame pdf-lib's `getSize()` and draw
 * options know about. Every overlay in the UI, meanwhile, is drawn against
 * pdf.js's `PageViewport` — the page *as displayed*, with `/Rotate` applied.
 *
 * Treating those two frames as one is why crop took the wrong half, and why
 * watermarks, headers/footers and Bates numbers landed in the wrong corner (or
 * outside the crop box, silently clipped) on a `/Rotate 90` page. The mapping
 * below is the exact inverse of the four cases pdf.js's `PageViewport`
 * constructor applies, so display space here is byte-for-byte the space the
 * overlay was drawn in.
 */
export interface DisplayFrame {
  /** Normalised page rotation, i.e. how the raw MediaBox is turned for display. */
  rotation: 0 | 90 | 180 | 270;
  /** Raw (unrotated) size of the box being mapped — MediaBox, or CropBox. */
  rawWidth: number;
  rawHeight: number;
  /**
   * Bottom-left corner of that box in raw page space. Non-zero when the frame is
   * a crop box: a Bates number laid out against the visible page has to land
   * inside the crop box, not at the MediaBox corner where it is clipped away.
   */
  originX: number;
  originY: number;
  /** Size of the box as displayed; swapped from raw on a quarter turn. */
  displayWidth: number;
  displayHeight: number;
}

export function displayFrame(
  rawWidth: number,
  rawHeight: number,
  rotation: number,
  originX = 0,
  originY = 0
): DisplayFrame {
  const r = normalizeRotation(rotation);
  const swapped = r === 90 || r === 270;
  return {
    rotation: r,
    rawWidth,
    rawHeight,
    originX,
    originY,
    displayWidth: swapped ? rawHeight : rawWidth,
    displayHeight: swapped ? rawWidth : rawHeight
  };
}

/**
 * A point in display space with a **top-left** origin and y running downwards
 * (canvas/overlay convention) → the same point in raw page space, bottom-left
 * origin, y running upwards (PDF convention).
 */
export function displayPointToPage(
  frame: DisplayFrame,
  displayX: number,
  displayY: number
): { x: number; y: number } {
  const { rawWidth: w, rawHeight: h, originX, originY } = frame;
  switch (frame.rotation) {
    case 90:
      return { x: originX + displayY, y: originY + displayX };
    case 180:
      return { x: originX + w - displayX, y: originY + displayY };
    case 270:
      return { x: originX + w - displayY, y: originY + h - displayX };
    default:
      return { x: originX + displayX, y: originY + h - displayY };
  }
}

/**
 * Places a box that was laid out in display space so that it lands, upright and
 * the right way round, once a viewer applies `/Rotate` on top of the result.
 *
 * `left`/`bottom` are the box's bottom-left corner in display space with a
 * **bottom-left** origin (the frame `positionOrigin` and PDF text baselines work
 * in). `extraRotationDeg` is any further rotation the user asked for, applied
 * about the box's own center in display space, in pdf-lib's anticlockwise
 * convention.
 *
 * Passing a 0x0 box makes this a plain anchor mapping, which is what a text
 * baseline needs: `drawText` rotates about its `x`/`y` anchor.
 *
 * At rotation 0 this reduces exactly to `{ x: left, y: bottom }`, so unrotated
 * pages are byte-identical to the pre-fix output.
 */
export function placeDisplayBox(
  frame: DisplayFrame,
  left: number,
  bottom: number,
  boxWidth: number,
  boxHeight: number,
  extraRotationDeg = 0
): { x: number; y: number; rotate: number } {
  // Box center in display space, converted to the top-left origin the mapping
  // above expects.
  const centerDisplayX = left + boxWidth / 2;
  const centerDisplayY = frame.displayHeight - (bottom + boxHeight / 2);
  const { x: cx, y: cy } = displayPointToPage(frame, centerDisplayX, centerDisplayY);
  const rotate = frame.rotation + extraRotationDeg;
  const { x, y } = centerPreservingOrigin(cx, cy, boxWidth, boxHeight, rotate);
  return { x, y, rotate };
}
