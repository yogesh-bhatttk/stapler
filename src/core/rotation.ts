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
