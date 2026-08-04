import { describe, expect, it } from 'vitest';
import { displayedAspectRatio, isQuarterTurn, normalizeRotation } from '../../src/core/rotation';

describe('normalizeRotation', () => {
  it('keeps the four legal values', () => {
    expect(normalizeRotation(0)).toBe(0);
    expect(normalizeRotation(90)).toBe(90);
    expect(normalizeRotation(180)).toBe(180);
    expect(normalizeRotation(270)).toBe(270);
  });

  // The regression this function exists for: the store used a plain `%`, so one
  // anticlockwise rotation from 0 produced -90, which is not a legal /Rotate value.
  it('wraps anticlockwise rotation to a positive value', () => {
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(-180)).toBe(180);
    expect(normalizeRotation(-270)).toBe(90);
    expect(normalizeRotation(-360)).toBe(0);
    expect(normalizeRotation(-450)).toBe(270);
  });

  it('wraps past a full turn', () => {
    expect(normalizeRotation(360)).toBe(0);
    expect(normalizeRotation(450)).toBe(90);
    expect(normalizeRotation(1080)).toBe(0);
  });

  it('snaps a value that is not a multiple of 90', () => {
    expect(normalizeRotation(89)).toBe(90);
    expect(normalizeRotation(46)).toBe(90);
    expect(normalizeRotation(44)).toBe(0);
  });
});

describe('displayedAspectRatio', () => {
  it('swaps width and height on a quarter turn', () => {
    expect(displayedAspectRatio(600, 800, 0)).toBeCloseTo(0.75);
    expect(displayedAspectRatio(600, 800, 90)).toBeCloseTo(800 / 600);
    expect(displayedAspectRatio(600, 800, 180)).toBeCloseTo(0.75);
    expect(displayedAspectRatio(600, 800, 270)).toBeCloseTo(800 / 600);
  });

  it('falls back to A4 for a degenerate page box', () => {
    expect(displayedAspectRatio(0, 0, 0)).toBeCloseTo(1 / 1.414);
  });

  it('agrees with isQuarterTurn', () => {
    for (const angle of [-270, -90, 90, 270, 450]) expect(isQuarterTurn(angle)).toBe(true);
    for (const angle of [-360, -180, 0, 180, 360]) expect(isQuarterTurn(angle)).toBe(false);
  });
});
