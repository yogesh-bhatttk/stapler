/** X-8 — custom split points accept plain integers only. */
import { describe, expect, it } from 'vitest';
import { parseSplitPoints, splitBoundaries, splitPointsError } from '../../src/core/operations';

describe('custom split points (X-8)', () => {
  it('does not cut at the leading digits of "1-3" or "2.5"', () => {
    // parseInt would have read these as 1 and 2.
    expect(splitBoundaries('custom', 20, { custom: '1-3' })).toEqual([]);
    expect(splitBoundaries('custom', 20, { custom: '2.5' })).toEqual([]);
    expect(splitBoundaries('custom', 20, { custom: '5, 2.5, 10' })).toEqual([5, 10]);
    expect(splitBoundaries('custom', 20, { custom: '3abc' })).toEqual([]);
  });

  it('lists every token that is not a plain integer', () => {
    expect(parseSplitPoints('5, 1-3, 2.5 x 10')).toEqual({
      points: [5, 10],
      invalid: ['1-3', '2.5', 'x']
    });
    expect(parseSplitPoints(' 4 , 8 ')).toEqual({ points: [4, 8], invalid: [] });
  });

  it('gives a clear error naming the bad tokens, and none for valid input', () => {
    expect(splitPointsError('5, 10')).toBeNull();
    expect(splitPointsError('')).toBeNull();
    const message = splitPointsError('1-3, 2.5');
    expect(message).toContain('1-3');
    expect(message).toContain('2.5');
    expect(message).toMatch(/page numbers/);
  });
});
