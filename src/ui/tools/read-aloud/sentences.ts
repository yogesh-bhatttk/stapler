/**
 * AUDIT-2026-09-25 GAP-10 — sentence and word ranges for read-aloud
 * highlighting. Pure (no DOM, no speech API) so it is unit-testable.
 *
 * Read-aloud speaks one sentence per utterance. That keeps the current
 * sentence highlighted even when the voice never fires `boundary` events
 * (many on-device voices do not), makes "next/previous sentence" a matter of
 * picking an index, and sidesteps Chrome cutting off very long utterances.
 * When `boundary` events *do* arrive, their `charIndex` is relative to the
 * sentence being spoken and is mapped back into the page text with
 * {@link wordRangeAt}.
 */

export interface TextRange {
  /** Inclusive start offset into the page text. */
  start: number;
  /** Exclusive end offset into the page text. */
  end: number;
}

/**
 * Splits `text` into sentence ranges, trimmed of surrounding whitespace, with
 * no empty ranges. Uses `Intl.Segmenter` (locale-aware, handles CJK full
 * stops and abbreviations better) when the runtime has it, else a
 * punctuation-based fallback.
 */
export function splitSentences(text: string, locale?: string): TextRange[] {
  const raw: TextRange[] = [];
  const Segmenter = typeof Intl !== 'undefined' ? Intl.Segmenter : undefined;
  if (Segmenter) {
    const segmenter = new Segmenter(locale, { granularity: 'sentence' });
    for (const segment of segmenter.segment(text)) {
      raw.push({ start: segment.index, end: segment.index + segment.segment.length });
    }
  } else {
    const pattern = /[^.!?。！？]+(?:[.!?。！？]+|$)/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      if (match[0].length === 0) {
        pattern.lastIndex += 1;
        continue;
      }
      raw.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  const trimmed: TextRange[] = [];
  for (const range of raw) {
    const r = trimRange(text, range.start, range.end);
    if (r) trimmed.push(r);
  }
  // UI-4 — the segmenter breaks after "Dr.", "Mr.", "p.m.", initials, …
  const merged: TextRange[] = [];
  for (const range of trimmed) {
    const previous = merged[merged.length - 1];
    if (previous && endsInAbbreviation(text, previous, range)) {
      previous.end = range.end;
    } else {
      merged.push({ ...range });
    }
  }
  // UI-4 — and nothing capped an utterance: a table page with no full stops
  // became one page-long utterance, which Chrome cuts off part-way.
  const out: TextRange[] = [];
  for (const range of merged) capRange(text, range, out);
  return out;
}

/**
 * UI-4 — the longest single utterance, in UTF-16 code units. Chrome stops
 * some voices after roughly 15 seconds of speech; 250 characters stays well
 * inside that at any offered rate.
 */
export const MAX_UTTERANCE_CHARS = 250;

function trimRange(text: string, start: number, end: number): TextRange | null {
  while (start < end && /\s/.test(text[start])) start += 1;
  while (end > start && /\s/.test(text[end - 1])) end -= 1;
  return end > start ? { start, end } : null;
}

/** Abbreviations that are (almost) never the end of a sentence: a title or "e.g." before a name or phrase. */
const ALWAYS_ABBREVIATIONS = new Set([
  'dr.',
  'mr.',
  'mrs.',
  'ms.',
  'st.',
  'prof.',
  'sr.',
  'jr.',
  'mt.',
  'vs.',
  'cf.',
  'fig.',
  'no.',
  'e.g.',
  'i.e.'
]);

/** Abbreviations that also often end a sentence: merged only when the text runs on in lower case or digits. */
const SOMETIMES_ABBREVIATIONS = new Set([
  'a.m.',
  'p.m.',
  'etc.',
  'approx.',
  'jan.',
  'feb.',
  'mar.',
  'apr.',
  'jun.',
  'jul.',
  'aug.',
  'sep.',
  'sept.',
  'oct.',
  'nov.',
  'dec.'
]);

/**
 * Whether `previous` ends in an abbreviation, so the boundary the segmenter
 * put between it and `next` is not really a sentence end.
 */
function endsInAbbreviation(text: string, previous: TextRange, next: TextRange): boolean {
  const segment = text.slice(previous.start, previous.end);
  const lastWord = segment.slice(segment.search(/\S+$/)).replace(/^[("'“‘[]+/, '');
  if (!lastWord.endsWith('.')) return false;
  const lower = lastWord.toLowerCase();
  // A single initial: "J. Smith", "Harry S. Truman".
  if (/^\p{Lu}\.$/u.test(lastWord)) return true;
  if (ALWAYS_ABBREVIATIONS.has(lower)) return true;
  const runsOn = /^[\p{Ll}\d]/u.test(text.slice(next.start, next.start + 1));
  if (!runsOn) return false;
  if (SOMETIMES_ABBREVIATIONS.has(lower)) return true;
  // Dotted letters ("U.S.", "a.k.a.") and ordinal numbers ("3. Juni", "the 3. edition").
  return /^(?:\p{L}\.){2,}$/u.test(lastWord) || /^\d+\.$/.test(lastWord);
}

/** Separators a long run of text may be broken after, best first. */
const SOFT_BREAKS = /[,;:，、；：،؛]/u;

/** Pushes `range` onto `out`, split into pieces of at most {@link MAX_UTTERANCE_CHARS}. */
function capRange(text: string, range: TextRange, out: TextRange[]): void {
  let start = range.start;
  while (range.end - start > MAX_UTTERANCE_CHARS) {
    const limit = start + MAX_UTTERANCE_CHARS;
    // Prefer a break in the back half of the window, so pieces stay sizeable.
    const floor = start + Math.floor(MAX_UTTERANCE_CHARS / 2);
    let cut = -1;
    for (let i = limit; i > floor; i--) {
      // Not inside a number such as "1,000".
      if (SOFT_BREAKS.test(text[i - 1]) && !/\d/.test(text[i] ?? '')) {
        cut = i;
        break;
      }
    }
    if (cut < 0) {
      for (let i = limit; i > floor; i--) {
        if (/\s/.test(text[i])) {
          cut = i;
          break;
        }
      }
    }
    if (cut < 0) {
      // No break at all (CJK, a URL): a hard cut, never inside a surrogate pair.
      cut = limit;
      const code = text.charCodeAt(cut);
      if (code >= 0xdc00 && code <= 0xdfff) cut -= 1;
    }
    const piece = trimRange(text, start, cut);
    if (piece) out.push(piece);
    start = cut;
  }
  const rest = trimRange(text, start, range.end);
  if (rest) out.push(rest);
}

/**
 * The word being spoken, as a range into the page text: `charIndex` (and
 * `charLength`, when the browser supplies it) come from a `boundary` event on
 * the utterance for `sentence`, so they are offsets into the sentence.
 * Returns null for an index outside the sentence.
 */
export function wordRangeAt(
  text: string,
  sentence: TextRange,
  charIndex: number,
  charLength?: number
): TextRange | null {
  if (!Number.isFinite(charIndex) || charIndex < 0) return null;
  const start = sentence.start + charIndex;
  if (start >= sentence.end) return null;
  if (charLength !== undefined && charLength > 0) {
    return { start, end: Math.min(sentence.end, start + charLength) };
  }
  // No `charLength` (Firefox, Safari): the word runs to the next whitespace.
  let end = start;
  while (end < sentence.end && !/\s/.test(text[end])) end += 1;
  return end > start ? { start, end } : null;
}

/** Clamps a sentence index into `[0, count - 1]`; 0 for an empty page. */
export function clampSentence(index: number, count: number): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(count - 1, index));
}
