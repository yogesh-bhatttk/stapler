import { describe, expect, it } from 'vitest';
import { alignPages } from '../../src/core/page-alignment';
import { makePageRefs, type PageRef } from '../../src/core/store';

describe('alignPages', () => {
  it('does not flag surviving pages as moved when a page between them is deleted', () => {
    const baseline = makePageRefs('doc', 9);
    const current = [
      baseline[0],
      baseline[1],
      baseline[3],
      baseline[4],
      baseline[5],
      baseline[6],
      baseline[7],
      baseline[8]
    ];

    const { entries, removedBeforeIndices } = alignPages(baseline, current);

    expect(removedBeforeIndices).toEqual([2]);
    expect(entries.every(entry => !entry.moved)).toBe(true);
  });

  it('does not flag surviving pages as moved when a page is duplicated', () => {
    const baseline = makePageRefs('doc', 3);
    const duplicate: PageRef = { ...baseline[0], key: 'dup-of-0' };
    const current = [baseline[0], duplicate, baseline[1], baseline[2]];

    const { entries, removedBeforeIndices } = alignPages(baseline, current);

    expect(removedBeforeIndices).toEqual([]);
    expect(entries[1]).toMatchObject({ beforeIndex: null, moved: false });
    expect(entries.filter(e => e.beforeIndex !== null).every(entry => !entry.moved)).toBe(true);
  });

  it('flags an actually swapped pair as moved, not the whole tail', () => {
    const baseline = makePageRefs('doc', 4);
    const current = [baseline[1], baseline[0], baseline[2], baseline[3]];

    const { entries } = alignPages(baseline, current);

    const movedCount = entries.filter(e => e.moved).length;
    expect(movedCount).toBe(1);
    expect(entries[2].moved).toBe(false);
    expect(entries[3].moved).toBe(false);
  });

  it('flags nothing as moved when current matches baseline exactly', () => {
    const baseline = makePageRefs('doc', 5);
    const { entries, removedBeforeIndices } = alignPages(baseline, [...baseline]);

    expect(removedBeforeIndices).toEqual([]);
    expect(entries.every(entry => !entry.moved)).toBe(true);
  });

  it('handles combined delete + duplicate + reorder without over-flagging', () => {
    const baseline = makePageRefs('doc', 6); // indices 0..5
    const duplicateOf5: PageRef = { ...baseline[5], key: 'dup-of-5' };
    // Delete page 0, duplicate page 5 right after the original, reorder 1 and 2.
    const current = [baseline[2], baseline[1], baseline[3], baseline[4], baseline[5], duplicateOf5];

    const { entries, removedBeforeIndices } = alignPages(baseline, current);

    expect(removedBeforeIndices).toEqual([0]);
    // Only the swapped pair (1,2) should be moved; 3,4,5 stayed in relative order.
    const movedBeforeIndices = entries.filter(e => e.moved).map(e => e.beforeIndex);
    expect(movedBeforeIndices.length).toBe(1);
    expect(entries[5]).toMatchObject({ beforeIndex: null, moved: false });
  });

  it('detects rotation independently of order', () => {
    const baseline = makePageRefs('doc', 2);
    const rotated: PageRef = { ...baseline[0], rotation: 90 };
    const { entries } = alignPages(baseline, [rotated, baseline[1]]);

    expect(entries[0]).toMatchObject({ beforeIndex: 0, rotated: true, moved: false });
    expect(entries[1]).toMatchObject({ beforeIndex: 1, rotated: false, moved: false });
  });
});
