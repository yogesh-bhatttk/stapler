/**
 * Find-and-mark across text runs (AUDIT-FINDINGS §1, medium).
 *
 * The bug this covers is a silent miss: a search that returns nothing for text
 * the user can see, because pdf.js happened to split it at a kern pair.
 */
import { describe, expect, it } from 'vitest';
import { findAcrossRuns } from '../../src/core/pdf/text-search';
import type { TextRun } from '../../src/core/text-layout';

const run = (str: string, extra: Partial<TextRun> = {}): TextRun => ({
  str,
  transform: [1, 0, 0, 1, 0, 0],
  width: str.length * 5,
  height: 10,
  ...extra
});

describe('findAcrossRuns', () => {
  it('finds a match contained in a single run', () => {
    const matches = findAcrossRuns([run('the secret code')], 'secret', false);
    expect(matches).toHaveLength(1);
    expect(matches[0].slices).toEqual([{ runIndex: 0, start: 4, end: 10 }]);
    expect(matches[0].text).toBe('secret');
  });

  it('finds a match split across two runs — the whole point', () => {
    const matches = findAcrossRuns([run('Ac'), run('count')], 'Account', false);
    expect(matches).toHaveLength(1);
    expect(matches[0].slices).toEqual([
      { runIndex: 0, start: 0, end: 2 },
      { runIndex: 1, start: 0, end: 5 }
    ]);
  });

  it('finds a match spanning three runs', () => {
    const matches = findAcrossRuns([run('A'), run('B'), run('C')], 'ABC', false);
    expect(matches[0].slices.map(s => s.runIndex)).toEqual([0, 1, 2]);
  });

  it('respects matchCase', () => {
    expect(findAcrossRuns([run('Secret')], 'secret', true)).toHaveLength(0);
    expect(findAcrossRuns([run('Secret')], 'secret', false)).toHaveLength(1);
  });

  it('does not match across a line break', () => {
    const runs = [run('foo', { hasEOL: true }), run('bar')];
    expect(findAcrossRuns(runs, 'foobar', false)).toHaveLength(0);
    expect(findAcrossRuns(runs, 'foo', false)).toHaveLength(1);
  });

  it('returns non-overlapping occurrences', () => {
    const matches = findAcrossRuns([run('aaaa')], 'aa', false);
    expect(matches.map(m => m.slices[0])).toEqual([
      { runIndex: 0, start: 0, end: 2 },
      { runIndex: 0, start: 2, end: 4 }
    ]);
  });

  it('finds every occurrence when they are split differently', () => {
    // "code" appears once whole and once split — the old per-run search found
    // only the first.
    const matches = findAcrossRuns([run('code '), run('co'), run('de')], 'code', false);
    expect(matches).toHaveLength(2);
    expect(matches[1].slices.map(s => s.runIndex)).toEqual([1, 2]);
  });

  it('returns nothing for an empty needle', () => {
    expect(findAcrossRuns([run('anything')], '', false)).toEqual([]);
  });
});
