/**
 * Strong-direction detection for the PDF→Office writers (CNV-08 / CNV-10 / CNV-12).
 *
 * A PDF's text layer hands us correct Unicode code points and nothing at all
 * about direction. The three writers were putting those code points into
 * `.docx` / `.xlsx` / `.pptx` with no directionality metadata, which means Word,
 * Excel and PowerPoint apply their default — left-to-right — and a paragraph of
 * Arabic or Hebrew renders left-aligned with its punctuation and any embedded
 * numbers in the wrong place. The characters were right; the label was missing.
 * This module supplies the label.
 *
 * ## What this is, and firmly is not
 *
 * This is **not** the Unicode bidirectional algorithm (UAX #9). It does not
 * reorder anything, it does not resolve embedding levels, and it does not shape
 * or join glyphs. Those are the consuming application's job — Word and
 * PowerPoint both run a real bidi implementation, and all they need from us is
 * the paragraph-direction flag that tells them to. The tools this feeds are
 * beta, best-effort conversions (PLAN §1.1); the goal here is to stop *silently
 * mislabelling* clearly-RTL text as LTR, not to lay it out ourselves.
 *
 * ## The decision rule
 *
 * Count the **strong** characters — letters, since a letter is the only thing
 * with an inherent direction — and classify each as RTL or LTR. Majority wins.
 * On an exact tie, the first strong character decides, which is UAX #9's own
 * P2/P3 paragraph-direction rule and the same answer every bidi implementation
 * would reach for the string.
 *
 * Deliberately excluded from the count:
 *
 *  • **Digits of every kind.** European digits are bidi class EN and
 *    Arabic-Indic digits (U+0660–U+0669) are AN — *neither is strong*. A price
 *    list or a table of figures inside an Arabic document must not be pulled
 *    back to LTR by its own numbers.
 *  • **Marks, punctuation and spaces.** Arabic harakat (U+064B–U+065F) are
 *    combining marks, not letters; a string of "..." has no direction of its
 *    own and takes the surrounding paragraph's, which is what the `fallback`
 *    parameter is for.
 *
 * ## Why explicit ranges rather than `\p{Script=Arabic}`
 *
 * Direction is not script. `\p{sc=Arabic}` would have to be spelled out for
 * Hebrew, Syriac, Thaana, NKo, Samaritan, Mandaic, Adlam and the presentation
 * forms anyway, and it would also sweep in the Arabic-Indic digits this rule
 * deliberately leaves out. A code-point range table is what the property
 * actually is, and it is auditable in one place.
 */

/** A resolved paragraph/cell/run direction. */
export type TextDirection = 'ltr' | 'rtl';

/**
 * Code-point ranges whose **letters** are bidi class R or AL, per the Unicode
 * character database. Inclusive on both ends, in ascending order.
 *
 * Non-letters inside these ranges (the Arabic-Indic digits, harakat, Arabic
 * punctuation) never reach the range test — {@link isRtlText} filters to letters
 * first — so listing a range wholesale is safe and keeps the table short.
 */
const RTL_RANGES: readonly (readonly [number, number])[] = [
  [0x0590, 0x05ff], // Hebrew
  [0x0600, 0x06ff], // Arabic
  [0x0700, 0x074f], // Syriac
  [0x0750, 0x077f], // Arabic Supplement
  [0x0780, 0x07bf], // Thaana
  [0x07c0, 0x07ff], // NKo
  [0x0800, 0x083f], // Samaritan
  [0x0840, 0x085f], // Mandaic
  [0x0860, 0x086f], // Syriac Supplement
  [0x0870, 0x089f], // Arabic Extended-B
  [0x08a0, 0x08ff], // Arabic Extended-A
  [0xfb1d, 0xfb4f], // Hebrew presentation forms
  [0xfb50, 0xfdff], // Arabic Presentation Forms-A
  [0xfe70, 0xfeff], // Arabic Presentation Forms-B
  [0x10800, 0x10fff], // Cypriot … Sogdian (historic RTL scripts)
  [0x1e800, 0x1efff] // Mende Kikakui, Adlam, Arabic Mathematical Alphabetic Symbols
];

/**
 * Letters only. A digit, a space, a comma or a combining mark has no direction
 * of its own, and counting one would let "1,204" or a run of dashes outvote the
 * words around it.
 *
 * No `g` flag, so `.test()` is stateless and this constant is safe to share.
 */
const LETTER = /\p{L}/u;

/** True when this code point sits in one of {@link RTL_RANGES}. */
function isRtlCodePoint(code: number): boolean {
  for (const [start, end] of RTL_RANGES) {
    if (code < start) return false;
    if (code <= end) return true;
  }
  return false;
}

/**
 * Whether a piece of extracted PDF text should be written as right-to-left.
 *
 * @param text     The text to classify. Iterated by code point, so a surrogate
 *                 pair (Adlam, Arabic mathematical symbols) counts once.
 * @param fallback What to answer when the text has **no strong character at
 *                 all** — a run of digits, punctuation or whitespace. Callers
 *                 pass the direction of the paragraph, cell or text box the run
 *                 sits in, so a neutral run inherits its context instead of
 *                 silently reverting to LTR in the middle of an Arabic
 *                 paragraph.
 */
export function isRtlText(text: string, fallback = false): boolean {
  let rtl = 0;
  let ltr = 0;
  let firstStrong: TextDirection | null = null;

  for (const ch of text) {
    if (!LETTER.test(ch)) continue;
    const direction: TextDirection = isRtlCodePoint(ch.codePointAt(0) as number) ? 'rtl' : 'ltr';
    firstStrong ??= direction;
    if (direction === 'rtl') rtl += 1;
    else ltr += 1;
  }

  if (firstStrong === null) return fallback;
  if (rtl !== ltr) return rtl > ltr;
  // UAX #9 P2/P3: with no majority, the first strong character sets the
  // paragraph direction.
  return firstStrong === 'rtl';
}

/**
 * {@link isRtlText} over a group of runs that share one paragraph, cell or text
 * box — the direction of the container, decided from everything in it at once.
 *
 * The container's direction is a single decision over the whole string rather
 * than a vote between its runs, so a long Arabic sentence split into three runs
 * by a bold word does not get outvoted by a two-run count.
 */
export function isRtlRunGroup(texts: Iterable<string>): boolean {
  return isRtlText([...texts].join(''));
}
