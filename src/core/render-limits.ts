/**
 * RT-10 — pixel ceilings for page renders.
 *
 * `renderPage` used to allocate whatever `pageSize × scale` came to. An A4
 * page at the single-page view's 400 % on a 2× display is ~130 MB of RGBA, and
 * a large-format page at high zoom is past what a canvas can hold at all — it
 * rendered blank with no message. Two limits:
 *
 *  • {@link MAX_RENDER_PIXELS} is the render worker's hard stop for *every*
 *    render, so nothing can ask for a canvas the browser cannot allocate.
 *    It sits well above anything export-quality work needs (OCR at 300 dpi
 *    on A2 is under it), so the renders whose callers derive geometry from
 *    `scale` are untouched in practice.
 *  • {@link MAX_VIEW_PIXELS} is what an on-screen view (single-page,
 *    side-by-side) asks for at most: past this, extra pixels are not visible
 *    detail, only memory. A view that hits it says so.
 */
import { unsupported } from './errors';
import { translate } from './i18n';

/** Hard ceiling for any one render: 8192² pixels, 256 MB of RGBA. */
export const MAX_RENDER_PIXELS = 8192 * 8192;
/** Longest canvas side any browser this ships to can allocate reliably. */
export const MAX_RENDER_SIDE = 16384;
/** Ceiling for an on-screen page view: 4096² pixels, 64 MB of RGBA. */
export const MAX_VIEW_PIXELS = 4096 * 4096;

export interface ClampedScale {
  scale: number;
  /** True when `scale` is lower than what was asked for. */
  clamped: boolean;
}

/**
 * The largest scale ≤ `scale` at which a `widthPt × heightPt` page renders to
 * at most `maxPixels` pixels with no side longer than {@link MAX_RENDER_SIDE}.
 * Sized against the canvas the worker actually allocates (each side rounded
 * up), so the result never overshoots by a rounding pixel.
 */
export function clampRenderScale(
  widthPt: number,
  heightPt: number,
  scale: number,
  maxPixels: number = MAX_RENDER_PIXELS
): ClampedScale {
  if (!(widthPt > 0) || !(heightPt > 0) || !(scale > 0)) return { scale, clamped: false };
  const fits = (s: number) => {
    const w = Math.ceil(widthPt * s);
    const h = Math.ceil(heightPt * s);
    return w * h <= maxPixels && Math.max(w, h) <= MAX_RENDER_SIDE;
  };
  if (fits(scale)) return { scale, clamped: false };
  let safe = Math.min(
    Math.sqrt(maxPixels / (widthPt * heightPt)),
    MAX_RENDER_SIDE / Math.max(widthPt, heightPt)
  );
  while (!fits(safe) && safe > 0) safe *= 0.995;
  return { scale: safe, clamped: true };
}

/* ------------------------------------------------------------------ *
 * CNV-14 — the one limit on an exact width × height, for both "Image to
 * size" and PDF → Images: the canvas it is drawn on has to be one a browser
 * can allocate, so at most {@link MAX_RENDER_PIXELS} pixels and no side past
 * {@link MAX_RENDER_SIDE}. The per-side cap matters with the aspect locked:
 * a width of 100 on a 1:400 panorama makes a 40,000 px height.
 * ------------------------------------------------------------------ */

/** Whether an exact output of `size` is past what a canvas can be allocated at. */
export function exactSizeOverLimit(size: { width: number; height: number }): boolean {
  return (
    size.width * size.height > MAX_RENDER_PIXELS ||
    Math.max(size.width, size.height) > MAX_RENDER_SIDE
  );
}

/** What to tell the person when {@link exactSizeOverLimit} is true for `size`. */
export function exactSizeLimitMessage(size: { width: number; height: number }): string {
  if (Math.max(size.width, size.height) > MAX_RENDER_SIDE) {
    return translate(
      '{width}×{height} px has a side longer than the {limit} px a browser can draw. Choose a smaller size.',
      { width: size.width, height: size.height, limit: MAX_RENDER_SIDE.toLocaleString('en-US') }
    );
  }
  return translate(
    '{width}×{height} px is larger than the {limit}-pixel limit a browser can draw. Choose a smaller size.',
    { width: size.width, height: size.height, limit: MAX_RENDER_PIXELS.toLocaleString('en-US') }
  );
}

/**
 * Throws an `UnsupportedFeature` error carrying {@link exactSizeLimitMessage}
 * when `size` is over the limit — before any canvas is allocated.
 */
export function assertExactSizeWithinLimit(size: { width: number; height: number }): void {
  if (exactSizeOverLimit(size)) {
    throw unsupported(exactSizeLimitMessage(size), { width: size.width, height: size.height });
  }
}
