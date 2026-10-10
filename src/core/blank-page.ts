/**
 * OPS-05 — deciding whether a rendered page is blank.
 *
 * Ink coverage alone is not enough. One short line of body text ("See
 * overleaf.", a closing line, a lone caption) covers well under the default
 * 0.5% of an A4 page, so a coverage-only test proposes real content pages for
 * deletion. Three independent signals are combined instead:
 *
 *  1. total ink coverage — many specks of scanner dust still add up;
 *  2. the largest connected blob of ink — dust is a scatter of tiny isolated
 *     marks, while a word, a rule or a photo is one connected run of pixels;
 *  3. real text — visible (not render mode 3/7), non-whitespace glyphs whose
 *     text-content position lies on the page.
 *
 * Everything here is pure so it can be tested without a renderer.
 */
import { blankCoverageLimit } from './text-layout';

/** Detector render resolution: one pixel ≈ 4pt (18 dpi). */
export const BLANK_RENDER_SCALE = 0.25;
/** Canvas budget per page, so a poster-sized page cannot blow the memory budget. */
const MAX_BLANK_RENDER_PIXELS = 1_000_000;
/** Same cutoff as `inkCoverage`: anything visibly darker than paper white. */
const INK_CUTOFF = 250;

/**
 * Render scale for a page of `width`×`height` points: 18 dpi, reduced for huge
 * pages. A reduced scale only makes the blob test stricter (a single pixel then
 * covers more than the speck allowance), so it errs towards "not blank".
 */
export function blankRenderScale(width: number, height: number): number {
  const area = Math.max(1, width * height);
  return Math.min(BLANK_RENDER_SCALE, Math.sqrt(MAX_BLANK_RENDER_PIXELS / area));
}

/**
 * Sensitivity → the largest connected ink blob, in pt², still treated as a speck.
 *
 * Up to the default (50) this stays below a single short line of body text
 * (~800pt² at 18 dpi) and covers scanner dust (a 1–4 pixel mark, 16–64pt²); a
 * 10×10pt blot is the most the default forgives. Above the default it grows to
 * allow one short line, which is what the loosest setting has always meant
 * ("This page intentionally left blank").
 */
export function blankSpeckLimit(threshold: number): number {
  const t = Math.min(100, Math.max(0, threshold));
  if (t <= 50) return t * 2;
  return 100 + ((t - 50) / 50) * 3900;
}

/**
 * Sensitivity → how many visible, on-page glyphs a blank page may carry.
 * None at or below the default; up to a short sentence (a page number, a
 * running footer, "This page intentionally left blank") at the loosest.
 */
export function blankTextAllowance(threshold: number): number {
  const t = Math.min(100, Math.max(0, threshold));
  if (t <= 50) return 0;
  return Math.round(((t - 50) / 50) * 40);
}

export interface InkMeasure {
  /** Fraction of pixels darker than the ink cutoff. */
  coverage: number;
  /** Pixel count of the largest 8-connected run of inked pixels. */
  largestBlob: number;
}

/** Ink coverage plus the largest connected ink blob, over an RGBA buffer. */
export function measureInk(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  cutoff = INK_CUTOFF
): InkMeasure {
  const pixels = width * height;
  if (pixels <= 0 || rgba.length < pixels * 4) return { coverage: 0, largestBlob: 0 };

  const inked = new Uint8Array(pixels);
  let count = 0;
  for (let p = 0; p < pixels; p++) {
    const o = p * 4;
    if ((rgba[o] + rgba[o + 1] + rgba[o + 2]) / 3 < cutoff) {
      inked[p] = 1;
      count += 1;
    }
  }
  if (count === 0) return { coverage: 0, largestBlob: 0 };

  // Iterative flood fill; `inked` doubles as the visited map (1 → 2).
  const stack = new Int32Array(pixels);
  let largestBlob = 0;
  for (let start = 0; start < pixels; start++) {
    if (inked[start] !== 1) continue;
    inked[start] = 2;
    let top = 0;
    stack[top++] = start;
    let size = 0;
    while (top > 0) {
      const p = stack[--top];
      size += 1;
      const x = p % width;
      const y = (p - x) / width;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if ((dx === 0 && dy === 0) || nx < 0 || nx >= width) continue;
          const n = ny * width + nx;
          if (inked[n] === 1) {
            inked[n] = 2;
            stack[top++] = n;
          }
        }
      }
    }
    if (size > largestBlob) largestBlob = size;
  }
  return { coverage: count / pixels, largestBlob };
}

/** The op codes the glyph scan needs, structurally compatible with pdf.js's `OPS`. */
export interface TextOpCodes {
  save: number;
  restore: number;
  setTextRenderingMode: number;
  showText: number;
  showSpacedText: number;
  nextLineShowText: number;
  nextLineSetSpacingShowText: number;
  paintFormXObjectBegin: number;
  paintFormXObjectEnd: number;
}

/** Tr 3 (invisible — an OCR text layer) and Tr 7 (clip only) paint nothing. */
function paintsGlyphs(mode: number): boolean {
  return mode !== 3 && mode !== 7;
}

function isVisibleGlyph(glyph: unknown): boolean {
  if (!glyph || typeof glyph !== 'object') return false;
  const g = glyph as { unicode?: unknown; fontChar?: unknown; isSpace?: unknown };
  if (g.isSpace === true) return false;
  const text =
    (typeof g.unicode === 'string' && g.unicode) ||
    (typeof g.fontChar === 'string' && g.fontChar) ||
    '';
  return text.trim().length > 0;
}

function countGlyphs(args: unknown): number {
  if (!Array.isArray(args)) return 0;
  let n = 0;
  for (const item of args) {
    if (Array.isArray(item)) n += countGlyphs(item);
    else if (isVisibleGlyph(item)) n += 1;
  }
  return n;
}

/**
 * Non-whitespace glyphs a pdf.js operator list actually paints: text drawn in
 * render mode 3 (the invisible layer OCR adds over a scan) or 7 does not count.
 * The text rendering mode is graphics state, so it follows `q`/`Q` and form
 * XObject nesting.
 */
export function visibleGlyphCount(
  fnArray: ArrayLike<number>,
  argsArray: ArrayLike<unknown>,
  ops: TextOpCodes
): number {
  const shows = new Set([
    ops.showText,
    ops.showSpacedText,
    ops.nextLineShowText,
    ops.nextLineSetSpacingShowText
  ]);
  let mode = 0;
  const stack: number[] = [];
  let count = 0;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    if (fn === ops.save || fn === ops.paintFormXObjectBegin) {
      stack.push(mode);
    } else if (fn === ops.restore || fn === ops.paintFormXObjectEnd) {
      mode = stack.pop() ?? mode;
    } else if (fn === ops.setTextRenderingMode) {
      const args = argsArray[i];
      if (Array.isArray(args) && typeof args[0] === 'number') mode = args[0];
    } else if (shows.has(fn) && paintsGlyphs(mode)) {
      count += countGlyphs(argsArray[i]);
    }
  }
  return count;
}

/** The fields of a pdf.js text-content item this check reads. */
export interface TextItemLike {
  str?: string;
  transform?: number[];
  width?: number;
  height?: number;
}

/**
 * Non-whitespace characters in text-content items whose box touches the page's
 * view box (`[x0, y0, x1, y1]`, PDF user space). Text positioned entirely off
 * the page is never seen and does not make a page "not blank".
 */
export function onPageTextLength(items: readonly unknown[], view: readonly number[]): number {
  const [vx0, vy0, vx1, vy1] = [
    Math.min(view[0], view[2]),
    Math.min(view[1], view[3]),
    Math.max(view[0], view[2]),
    Math.max(view[1], view[3])
  ];
  let count = 0;
  for (const raw of items) {
    const item = raw as TextItemLike;
    if (typeof item.str !== 'string') continue;
    const chars = item.str.replace(/\s+/gu, '').length;
    if (chars === 0 || !item.transform || item.transform.length < 6) continue;
    const [a, b, c, d, x, y] = item.transform;
    const w = item.width ?? 0;
    const h = item.height ?? Math.hypot(c, d);
    // Axis-aligned bounds of the run, whatever its rotation.
    const ux = Math.hypot(a, b) > 0 ? a / Math.hypot(a, b) : 1;
    const uy = Math.hypot(a, b) > 0 ? b / Math.hypot(a, b) : 0;
    const xs = [x, x + ux * w, x - uy * h, x + ux * w - uy * h];
    const ys = [y, y + uy * w, y + ux * h, y + uy * w + ux * h];
    const inside =
      Math.max(...xs) >= vx0 &&
      Math.min(...xs) <= vx1 &&
      Math.max(...ys) >= vy0 &&
      Math.min(...ys) <= vy1;
    if (inside) count += chars;
  }
  return count;
}

export interface BlankPageEvidence {
  ink: InkMeasure;
  /** Points per detector pixel, squared — converts blob pixels to pt². */
  pt2PerPixel: number;
  /** Visible, on-page, non-whitespace glyphs; only read when the ink says "maybe". */
  textLength: () => Promise<number> | number;
}

/**
 * The verdict. Ink is checked first because it is cheap and settles almost
 * every content page; the text check runs only for pages that look blank.
 *
 * Text vetoes even a page that rendered no ink at all: a non-embedded font the
 * renderer could not draw (a CJK or Arabic line on a machine without the
 * font) is still content for whoever opens the file elsewhere. Erring this way
 * keeps a page; erring the other way invites the user to delete it.
 */
export async function isBlankPage(
  evidence: BlankPageEvidence,
  threshold: number
): Promise<boolean> {
  const { ink, pt2PerPixel } = evidence;
  if (ink.coverage > blankCoverageLimit(threshold)) return false;
  if (ink.largestBlob * pt2PerPixel > blankSpeckLimit(threshold)) return false;
  return (await evidence.textLength()) <= blankTextAllowance(threshold);
}
