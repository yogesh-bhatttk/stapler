/**
 * GAP-6 — duplex interleave: pure page-order logic.
 *
 * A single-sided feeder scans a stack of double-sided sheets in two passes:
 * every front, then (after flipping the stack) every back. The backs pass
 * comes out in *reverse* sheet order — the last sheet's back is on top of the
 * flipped stack — which is why "backs are reversed" is the default.
 *
 * Operates on any list (the store passes `PageRef`s), so it is independent of
 * how the two halves arrived: two merged documents, or one file that already
 * holds all fronts followed by all backs.
 */

export interface DuplexPlan<T> {
  /** The interleaved order: front 1, back 1, front 2, back 2, … */
  pages: T[];
  fronts: number;
  backs: number;
  /**
   * `exact` — one back per front.
   * `last-front-alone` — one more front than backs: the final sheet was
   *   single-sided (or its blank back was not scanned). Normal, not an error.
   * `mismatch` — any other difference. The pairs that exist are interleaved
   *   and the surplus pages are kept, in their scanned order, at the end —
   *   nothing is dropped, but the caller must say so before applying it.
   */
  fit: 'exact' | 'last-front-alone' | 'mismatch';
  /** Pages with no partner, appended after the interleaved pairs. */
  unpaired: number;
}

/**
 * Interleaves `pages[0..frontCount)` (fronts, in sheet order) with
 * `pages[frontCount..)` (backs, reversed when `backsReversed`).
 */
export function interleaveDuplex<T>(
  pages: readonly T[],
  frontCount: number,
  backsReversed: boolean
): DuplexPlan<T> {
  const split = Math.max(0, Math.min(pages.length, Math.floor(frontCount)));
  const fronts = pages.slice(0, split);
  const backs = pages.slice(split);
  if (backsReversed) backs.reverse();

  const pairs = Math.min(fronts.length, backs.length);
  const out: T[] = [];
  for (let i = 0; i < pairs; i++) {
    out.push(fronts[i], backs[i]);
  }
  // Surplus pages stay in the order the user would read them in: remaining
  // fronts in sheet order, remaining backs in (corrected) sheet order.
  out.push(...fronts.slice(pairs), ...backs.slice(pairs));

  const difference = fronts.length - backs.length;
  const fit = difference === 0 ? 'exact' : difference === 1 ? 'last-front-alone' : 'mismatch';
  return {
    pages: out,
    fronts: fronts.length,
    backs: backs.length,
    fit,
    unpaired: Math.abs(difference)
  };
}

/**
 * Where the fronts end, by default.
 *
 * When the document is exactly two runs of pages from two different sources —
 * two scans merged one after the other — the boundary between them is the
 * answer. Otherwise the first half, rounded up (a stack with an odd number of
 * pages has one more front than back).
 */
export function defaultFrontCount(sourceIds: readonly string[]): number {
  if (sourceIds.length === 0) return 0;
  const runs: { id: string; length: number }[] = [];
  for (const id of sourceIds) {
    const last = runs[runs.length - 1];
    if (last && last.id === id) last.length += 1;
    else runs.push({ id, length: 1 });
  }
  if (runs.length === 2 && runs[0].id !== runs[1].id) return runs[0].length;
  return Math.ceil(sourceIds.length / 2);
}
