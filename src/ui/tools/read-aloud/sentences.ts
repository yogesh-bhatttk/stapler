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
  const out: TextRange[] = [];
  for (const range of raw) {
    let { start, end } = range;
    while (start < end && /\s/.test(text[start])) start += 1;
    while (end > start && /\s/.test(text[end - 1])) end -= 1;
    if (end > start) out.push({ start, end });
  }
  return out;
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
