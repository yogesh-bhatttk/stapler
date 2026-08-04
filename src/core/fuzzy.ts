/**
 * Subsequence matching for the command palette and the home tool search.
 *
 * Lived inside the palette component, which meant the home launcher imported a scoring
 * function from a UI component and neither could be tested without mounting Preact.
 */

/**
 * Scores `needle` against `haystack`, 0 for no match and higher for a better one.
 *
 * Subsequence rather than substring, so "cmp" finds "Compress" — the whole point of a
 * fuzzy palette. Adjacent characters and word beginnings score higher, so a prefix match
 * outranks letters scattered across a long description.
 */
export function fuzzyScore(haystack: string, needle: string): number {
  if (!needle) return 1;
  const text = haystack.toLowerCase();
  const query = needle.toLowerCase();

  let score = 0;
  let at = -1;
  for (const char of query) {
    const found = text.indexOf(char, at + 1);
    if (found === -1) return 0;
    if (found === at + 1) score += 3;
    else score += 1;
    if (found === 0 || text[found - 1] === ' ') score += 2;
    at = found;
  }

  // Normalise by length so a short exact-ish match beats the same letters buried in a
  // long sentence. Without this, a tool whose *description* happens to contain the
  // letters can outrank the tool actually named that.
  return score / Math.sqrt(text.length);
}

/** Ranks items by score, dropping non-matches. Stable for equal scores. */
export function fuzzyRank<T>(
  items: readonly T[],
  needle: string,
  textOf: (item: T) => string
): T[] {
  return items
    .map((item, index) => ({ item, index, score: fuzzyScore(textOf(item), needle) }))
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(entry => entry.item);
}
