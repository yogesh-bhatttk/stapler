import type { PageRef } from './store';

export interface PageAlignEntry {
  /** Index of this page's counterpart in the baseline, or `null` if it's new. */
  beforeIndex: number | null;
  rotated: boolean;
  moved: boolean;
}

export interface PageAlignment {
  /** One entry per CURRENT page, in current order. */
  entries: PageAlignEntry[];
  /** Baseline indices with no match in current, ascending. */
  removedBeforeIndices: number[];
  baselineCount: number;
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
  const entries: PageAlignEntry[] = current.map((page, currentIndex) => {
    const beforeIndex = beforeIndexByKey.get(page.key);
    if (beforeIndex === undefined) {
      return { beforeIndex: null, rotated: false, moved: false };
    }
    matched.add(beforeIndex);
    return {
      beforeIndex,
      rotated: baseline[beforeIndex].rotation !== page.rotation,
      moved: beforeIndex !== currentIndex
    };
  });

  const removedBeforeIndices = baseline
    .map((_, index) => index)
    .filter(index => !matched.has(index));

  return { entries, removedBeforeIndices, baselineCount: baseline.length };
}
