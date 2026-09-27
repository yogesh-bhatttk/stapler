/**
 * AUDIT-2026-09-25 UI-13 — Alt+arrow reorder moves the selection as a block,
 * whichever of its tiles has focus. Asserted through the real `movePages`.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { dropGapIndex, keyboardMoveTarget, logicalArrowKey } from '../../src/core/reorder';

describe('RTL page grid (AUDIT UI-21)', () => {
  it('swaps only the horizontal arrows under RTL', () => {
    expect(logicalArrowKey('ArrowLeft', true)).toBe('ArrowRight');
    expect(logicalArrowKey('ArrowRight', true)).toBe('ArrowLeft');
    expect(logicalArrowKey('ArrowUp', true)).toBe('ArrowUp');
    expect(logicalArrowKey('ArrowDown', true)).toBe('ArrowDown');
    expect(logicalArrowKey('Home', true)).toBe('Home');
    expect(logicalArrowKey('ArrowLeft', false)).toBe('ArrowLeft');
    expect(logicalArrowKey('ArrowRight', false)).toBe('ArrowRight');
  });

  it('mirrors the drop halves under RTL', () => {
    const rect = { left: 100, width: 100 };
    // LTR: left half = before (index), right half = after (index + 1).
    expect(dropGapIndex(120, rect, 4, false)).toBe(4);
    expect(dropGapIndex(180, rect, 4, false)).toBe(5);
    // RTL: the page before sits to the right, so the halves swap.
    expect(dropGapIndex(120, rect, 4, true)).toBe(5);
    expect(dropGapIndex(180, rect, 4, true)).toBe(4);
  });
});
import {
  activeDocId,
  addDocument,
  documents,
  makePageRefs,
  movePages,
  registerSource,
  sources
} from '../../src/core/store';

function order(): number[] {
  return documents.value[0].pages.map(p => p.sourceIndex + 1);
}

function moveSelection(selected: number[], direction: 'left' | 'right' | 'up' | 'down', cols = 4) {
  const pages = documents.value[0].pages;
  const indices = selected.map(n => pages.findIndex(p => p.sourceIndex + 1 === n));
  const target = keyboardMoveTarget(indices, pages.length, direction, cols);
  if (target === null) return false;
  movePages(
    'd',
    indices.map(i => pages[i].key),
    target
  );
  return true;
}

beforeEach(() => {
  documents.value = [];
  sources.value = {};
  activeDocId.value = null;
  registerSource({
    id: 's',
    name: 's.pdf',
    pageCount: 10,
    pageSizes: Array.from({ length: 10 }, () => ({ width: 595, height: 842 }))
  });
  addDocument({
    id: 'd',
    name: 'd.pdf',
    pages: makePageRefs('s', 10),
    annotations: [],
    dirty: false
  });
});

describe('keyboard reorder (UI-13)', () => {
  it('moves a contiguous selection one step left and right as a block', () => {
    moveSelection([6, 7], 'left');
    expect(order()).toEqual([1, 2, 3, 4, 6, 7, 5, 8, 9, 10]);
    moveSelection([6, 7], 'right');
    expect(order()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    moveSelection([6, 7], 'right');
    expect(order()).toEqual([1, 2, 3, 4, 5, 8, 6, 7, 9, 10]);
  });

  it('moves one row down by the column count', () => {
    moveSelection([2], 'down', 4);
    expect(order()).toEqual([1, 3, 4, 5, 6, 2, 7, 8, 9, 10]);
  });

  it('does nothing at an edge', () => {
    expect(moveSelection([1, 2], 'left')).toBe(false);
    expect(moveSelection([10], 'right')).toBe(false);
    expect(order()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('gathers a scattered selection next to its first page instead of flinging it to the end', () => {
    moveSelection([3, 8], 'right');
    const result = order();
    expect(result.indexOf(8)).toBe(result.indexOf(3) + 1);
    expect(result.indexOf(3)).toBeLessThan(5);
  });
});
