import { describe, expect, it } from 'vitest';
import { splitBoundaries } from '../../src/core/operations';

/** Turns boundaries back into the slices the worker will produce. */
function slices(pageCount: number, boundaries: number[]): number[][] {
  const out: number[][] = [];
  const pages = Array.from({ length: pageCount }, (_, i) => i);
  let from = 0;
  for (const cut of boundaries) {
    out.push(pages.slice(from, cut));
    from = cut;
  }
  out.push(pages.slice(from));
  return out;
}

describe('splitBoundaries', () => {
  it('splits into individual pages', () => {
    expect(splitBoundaries('individual', 4)).toEqual([1, 2, 3]);
  });

  it('splits every N pages', () => {
    expect(splitBoundaries('every_n', 10, { every: 3 })).toEqual([3, 6, 9]);
    expect(splitBoundaries('every_n', 9, { every: 3 })).toEqual([3, 6]);
  });

  it('treats a step of 0 or a negative step as 1', () => {
    expect(splitBoundaries('every_n', 3, { every: 0 })).toEqual([1, 2]);
    expect(splitBoundaries('every_n', 3, { every: -5 })).toEqual([1, 2]);
  });

  it('parses custom page numbers, ignoring junk and duplicates', () => {
    expect(splitBoundaries('custom', 20, { custom: '5, 10, 15' })).toEqual([5, 10, 15]);
    expect(splitBoundaries('custom', 20, { custom: '10,5,10' })).toEqual([5, 10]);
    expect(splitBoundaries('custom', 20, { custom: '5 abc 10' })).toEqual([5, 10]);
    expect(splitBoundaries('custom', 20, { custom: '' })).toEqual([]);
  });

  it('drops custom boundaries outside the document', () => {
    // 0 would produce an empty first file; 20 and beyond an empty last one.
    expect(splitBoundaries('custom', 20, { custom: '0, 20, 99, -3' })).toEqual([]);
    expect(splitBoundaries('custom', 20, { custom: '19' })).toEqual([19]);
  });

  it('never splits a single-page document', () => {
    for (const mode of ['individual', 'every_n', 'custom'] as const) {
      expect(splitBoundaries(mode, 1, { every: 1, custom: '1' })).toEqual([]);
      expect(splitBoundaries(mode, 0, { every: 1, custom: '1' })).toEqual([]);
    }
  });

  // OPS-03's acceptance criterion: the union of the outputs equals the input page set.
  it.each([
    ['individual', 300, {}],
    ['every_n', 300, { every: 7 }],
    ['every_n', 300, { every: 1 }],
    ['every_n', 300, { every: 299 }],
    ['custom', 300, { custom: '1, 2, 150, 299' }]
  ] as const)('preserves every page exactly once for %s', (mode, pageCount, options) => {
    const parts = slices(pageCount, splitBoundaries(mode, pageCount, options));
    expect(parts.flat()).toEqual(Array.from({ length: pageCount }, (_, i) => i));
    // No empty output file, and order is preserved within each.
    for (const part of parts) {
      expect(part.length).toBeGreaterThan(0);
      expect([...part].sort((a, b) => a - b)).toEqual(part);
    }
  });

  it('returns sorted boundaries whatever order the user typed', () => {
    const boundaries = splitBoundaries('custom', 50, { custom: '40, 10, 25' });
    expect(boundaries).toEqual([...boundaries].sort((a, b) => a - b));
  });
});
