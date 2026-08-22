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
export const DOC_PAGE_RGB: readonly [number, number, number] = [1, 1, 1];

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

/**
 * Annotation ink swatches (ANN-01) — colours a user paints onto the page, not
 * theme colours, so they stay fixed across light/dark. Matches the
 * `--annotation-*` tokens in tokens.css by hand for the same reason as the
 * rest of this module: canvas 2D and pdf-lib need real colour values, not
 * CSS custom properties.
 */
export const ANNOTATION_COLORS: readonly string[] = [
  '#ffeb3b', // --annotation-yellow
  '#f44336', // --annotation-red
  '#4caf50', // --annotation-green
  '#2196f3', // --annotation-blue
  '#000000', // --annotation-black
  '#ffffff' // --annotation-white
];

/** Document annotation summary colors (ANN-04). */
export const SUMMARY_TITLE_RGB: readonly [number, number, number] = [25 / 255, 25 / 255, 51 / 255];
export const SUMMARY_MUTED_RGB: readonly [number, number, number] = [
  100 / 255,
  100 / 255,
  100 / 255
];
export const SUMMARY_LINE_RGB: readonly [number, number, number] = [
  200 / 255,
  200 / 255,
  200 / 255
];
export const SUMMARY_CARD_BG_RGB: readonly [number, number, number] = [
  247 / 255,
  250 / 255,
  255 / 255
];
export const SUMMARY_CARD_BORDER_RGB: readonly [number, number, number] = [
  217 / 255,
  224 / 255,
  237 / 255
];
export const SUMMARY_ACCENT_RGB: readonly [number, number, number] = [
  51 / 255,
  102 / 255,
  204 / 255
];
export const SUMMARY_HEADER_RGB: readonly [number, number, number] = [
  38 / 255,
  51 / 255,
  102 / 255
];
export const SUMMARY_TEXT_RGB: readonly [number, number, number] = [25 / 255, 25 / 255, 25 / 255];

/** ANN-06 redline export: the "UNCHANGED" banner background and its text. */
export const REDLINE_BANNER_BG_RGB: readonly [number, number, number] = [
  217 / 255,
  217 / 255,
  217 / 255
];
export const REDLINE_BANNER_TEXT_RGB: readonly [number, number, number] = [
  77 / 255,
  77 / 255,
  77 / 255
];

/** ANN-06 redline export: border drawn where a page has no counterpart to show. */
export const REDLINE_PLACEHOLDER_BORDER_RGB: readonly [number, number, number] = [
  153 / 255,
  153 / 255,
  153 / 255
];
