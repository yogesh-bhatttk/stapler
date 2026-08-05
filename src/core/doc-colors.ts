/**
 * Colours of the *document*, not of the UI.
 *
 * A PDF page is white in both themes and a redaction fill is opaque black
 * (DESIGN-ADAPTATION §3.1, the `--doc-*` tokens). These values are handed to canvas
 * and pdf-lib as numbers, so they cannot be CSS custom properties. This module is the
 * single audited exception to the no-raw-colour invariant and is allow-listed in
 * scripts/check-tokens.mjs and the PostToolUse hook.
 *
 * It deliberately imports nothing. An earlier version imported pdf-lib's `rgb()`
 * helper, and because the UI reads `DOC_PAGE_WHITE` for canvas backgrounds that pulled
 * all of pdf-lib into the main chunk — 108KB → 574KB, straight through the bundle
 * budget in NFR-02. Components that need a pdf-lib `Color` build it themselves from
 * these tuples, inside the worker where pdf-lib already lives.
 *
 * Keep these in step with the `--doc-*` tokens by hand: there is no way to read CSS
 * from a worker, and scripts/check-contrast.mjs asserts the token side.
 */

/** Background painted before rasterising a page — PDFs assume white paper. */
export const DOC_PAGE_WHITE = '#ffffff';

/** Signature strokes, drawn near-black so they read on white paper. */
export const DOC_SIGNATURE_STROKE = '#08090a';

/** Ink for stamped text and check marks, as 0..1 components. Matches `--ink`. */
export const DOC_INK_RGB: readonly [number, number, number] = [8 / 255, 9 / 255, 10 / 255];

/** N-up cell border lines. Matches `--hairline-strong` light theme. */
export const DOC_HAIRLINE_RGB: readonly [number, number, number] = [
  211 / 255,
  213 / 255,
  218 / 255
];

/** Redaction fill. Matches `--doc-redact`; opaque and identical in both themes. */
export const DOC_REDACT_RGB: readonly [number, number, number] = [10 / 255, 10 / 255, 11 / 255];
