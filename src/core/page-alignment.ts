import type { PageRef } from './store';

export interface PageAlignEntry {
  /** Index of this page's counterpart in the baseline, or `null` if it's new. */
  beforeIndex: number | null;
  rotated: boolean;
  moved: boolean;
  /**
   * This page's own current rotation (0/90/180/270) — the diff renders the
   * baseline counterpart at this same rotation, rather than its own, so a
   * page that was only rotated compares as identical instead of "changed
   * size" (a 90/270° rotation swaps rendered width and height) and so a real
   * edit made on top of a rotation still shows up instead of being masked by
   * the rotation alone making the two renders non-comparable.
   */
  afterRotation: number;
}

export interface PageAlignment {
  /** One entry per CURRENT page, in current order. */
  entries: PageAlignEntry[];
  /** Baseline indices with no match in current, ascending. */
  removedBeforeIndices: number[];
  baselineCount: number;
}

/**
 * Marks which positions of a `beforeIndex` sequence (baseline indices in
 * current order; `-1` for "no counterpart") belong to a longest strictly
 * increasing subsequence — the largest set of matched pages that could stay
 * in place without anyone having been reordered relative to anyone else.
 * Everyone outside that set is the (minimal) set of pages actually moved.
 *
 * This is what makes `moved` mean "reordered" rather than "shifted" —
 * deleting page 3 of 9 turns `[0,1,3,4,5,6,7,8]` into `[0,1,3,4,5,6,7,8]`
 * (already increasing: the deletion just removes an element, it doesn't
 * reorder the rest), where a naive `beforeIndex !== currentIndex` check would
 * wrongly flag pages 4-9 as moved just because the deletion shifted their
 * position.
 */
function longestIncreasingRun(values: number[]): boolean[] {
  const positions: number[] = [];
  const seq: number[] = [];
  values.forEach((value, index) => {
    if (value !== -1) {
      positions.push(index);
      seq.push(value);
    }
  });

  // Patience sorting: `tailIndices[len]` is the index (into `seq`) of the
  // smallest possible tail value for an increasing run of length `len + 1`.
  const tailIndices: number[] = [];
  const previous: number[] = new Array(seq.length).fill(-1);
  for (let i = 0; i < seq.length; i++) {
    let lo = 0;
    let hi = tailIndices.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[tailIndices[mid]] < seq[i]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) previous[i] = tailIndices[lo - 1];
    if (lo === tailIndices.length) tailIndices.push(i);
    else tailIndices[lo] = i;
  }

  const inRun = new Array(values.length).fill(false);
  let cursor = tailIndices.length > 0 ? tailIndices[tailIndices.length - 1] : -1;
  while (cursor !== -1) {
    inRun[positions[cursor]] = true;
    cursor = previous[cursor];
  }
  return inRun;
}

/**
 * Matches `current` against `baseline` by `PageRef.key` — reliable because key
 * survives rotation, reordering, and the deletion of *other* pages (only
 * `duplicatePages` mints a fresh key, for the new copy; the original keeps its
 * own). Pure metadata comparison, no bytes and no worker involved.
 */
export function alignPages(baseline: PageRef[], current: PageRef[]): PageAlignment {
  const beforeIndexByKey = new Map<string, number>();
  baseline.forEach((page, index) => beforeIndexByKey.set(page.key, index));

  const matched = new Set<number>();
  const beforeIndices = current.map(page => {
    const beforeIndex = beforeIndexByKey.get(page.key);
    if (beforeIndex === undefined) return -1;
    matched.add(beforeIndex);
    return beforeIndex;
  });
  const inOrder = longestIncreasingRun(beforeIndices);

  const entries: PageAlignEntry[] = current.map((page, currentIndex) => {
    const beforeIndex = beforeIndexByKey.get(page.key);
    if (beforeIndex === undefined) {
      return { beforeIndex: null, rotated: false, moved: false, afterRotation: page.rotation };
    }
    return {
      beforeIndex,
      rotated: baseline[beforeIndex].rotation !== page.rotation,
      moved: !inOrder[currentIndex],
      afterRotation: page.rotation
    };
  });

  const removedBeforeIndices = baseline
    .map((_, index) => index)
    .filter(index => !matched.has(index));

  return { entries, removedBeforeIndices, baselineCount: baseline.length };
}
