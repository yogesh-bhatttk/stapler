/**
 * Keyboard reorder targets for the page grid (Alt+arrows), as a gap index in
 * the *current* page list — the convention `movePages` takes.
 *
 * The grid used to compute the target from the focused tile's index, which is
 * only right when that tile is the first of a contiguous selection. Alt+Left
 * from the last tile of a selection was a no-op that still committed a history
 * entry; Alt+Right jumped two places; a non-contiguous selection collapsed to
 * the end (AUDIT-2026-09-25 UI-13). The target now comes from the selection's
 * own extent: the block moves one step (or one row) as a unit.
 *
 * Returns null when the block is already at that edge, so the caller does
 * nothing — no move, no undo entry.
 */
export function keyboardMoveTarget(
  selectedIndices: readonly number[],
  pageCount: number,
  direction: 'left' | 'right' | 'up' | 'down',
  columns: number
): number | null {
  if (selectedIndices.length === 0) return null;
  const selected = [...new Set(selectedIndices)].sort((a, b) => a - b);
  const min = selected[0];
  const max = selected[selected.length - 1];
  const contiguous = max - min + 1 === selected.length;
  const step = direction === 'left' || direction === 'right' ? 1 : Math.max(1, columns);
  const restLength = pageCount - selected.length;

  // Where the block should start once it has moved, counted among the pages
  // that are *not* moving. A scattered selection is gathered around its first
  // page rather than flung to wherever its last page sits.
  const delta = direction === 'left' || direction === 'up' ? -step : step;
  const start = Math.max(0, Math.min(restLength, min + delta));
  if (contiguous && start === min) return null;

  // `movePages` takes a gap index in the current list; find the gap whose
  // position among the non-moving pages is `start`.
  let before = 0;
  for (let gap = 0; gap <= pageCount; gap++) {
    if (gap - before === start) return gap;
    if (selected.includes(gap)) before++;
  }
  return pageCount;
}

/**
 * AUDIT UI-21 — the page grid is a CSS grid, so under `dir="rtl"` (Arabic) the
 * first page sits at the top *right* and page order runs leftwards. The
 * physical arrow keys must follow what the user sees: ArrowLeft goes to the
 * next page, not the previous one. This maps a physical key to the logical
 * one the grid's index arithmetic is written for (ArrowRight = next page).
 * Vertical keys and everything else pass through untouched.
 */
export function logicalArrowKey(key: string, rtl: boolean): string {
  if (!rtl) return key;
  if (key === 'ArrowLeft') return 'ArrowRight';
  if (key === 'ArrowRight') return 'ArrowLeft';
  return key;
}

/**
 * The gap a dragged page lands in when hovering tile `index` at `clientX`:
 * the half of the tile nearer the page before it means "insert before". In
 * RTL the page before is to the right, so the halves swap.
 */
export function dropGapIndex(
  clientX: number,
  rect: { left: number; width: number },
  index: number,
  rtl: boolean
): number {
  const inLeftHalf = clientX < rect.left + rect.width / 2;
  return inLeftHalf !== rtl ? index : index + 1;
}

/** Whether `element` lays out right-to-left, per the nearest `dir` attribute. */
export function isRightToLeft(element: Element | null): boolean {
  const owner = element?.closest('[dir]');
  return owner?.getAttribute('dir')?.toLowerCase() === 'rtl';
}
