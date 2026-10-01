/**
 * Audit 2026-10-01 — the shared byte formatter (IMG-3, X-10, pattern 6) and
 * the shared "never larger than the input" decision (IMG-1, pattern 2).
 */
import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatBytesUp,
  formatTargetMiss,
  formatTargetMisses,
  wholeKilobytes,
  wholeMegabytes
} from '../../src/core/bytes';
import { formatBytes as uiFormatBytes } from '../../src/ui/components/Feedback';
import { chooseSmaller } from '../../src/core/size-guard';
import { formatStorageBytes } from '../../src/core/storage-persistence';

describe('formatBytes (IMG-3)', () => {
  it('is decimal and is the one the UI uses', () => {
    expect(uiFormatBytes).toBe(formatBytes);
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(1000)).toBe('1 KB');
    expect(formatBytes(200_000)).toBe('200 KB');
    expect(formatBytes(1_500_000)).toBe('1.5 MB');
    expect(formatBytes(9_000_000)).toBe('9 MB');
    expect(formatBytes(1_234_567)).toBe('1.23 MB');
    expect(formatBytes(2_250_000_000)).toBe('2.25 GB');
  });

  it('switches KB → MB at 999,500 B, so nothing reads "1000 KB"', () => {
    expect(formatBytes(999_499)).toBe('999 KB');
    expect(formatBytes(999_500)).toBe('1 MB');
    expect(formatBytes(999_999)).toBe('1 MB');
    for (let bytes = 999_000; bytes < 1_001_000; bytes += 37) {
      expect(formatBytes(bytes)).not.toMatch(/^1000 KB$/);
    }
    expect(formatBytes(999_994_999)).toBe('999.99 MB');
    expect(formatBytes(999_995_000)).toBe('1 GB');
  });
});

describe('formatBytesUp / formatTargetMiss (IMG-3)', () => {
  it('rounds up, crossing into the next unit when it has to', () => {
    expect(formatBytesUp(200_001)).toBe('201 KB');
    expect(formatBytesUp(200_000)).toBe('200 KB');
    expect(formatBytesUp(999_001)).toBe('1 MB');
    expect(formatBytesUp(1_500_001)).toBe('1.51 MB');
    expect(formatBytesUp(1001)).toBe('2 KB');
  });

  it('never shows a miss as equal to its target — the audit case', () => {
    // "Could not reach 200 KB. The smallest Stapler could make is 200 KB."
    const miss = formatTargetMiss(200_000, 200_300);
    expect(miss.target).toBe('200 KB');
    expect(miss.achieved).toBe('201 KB');
  });

  it('adds precision when whole units would still collide', () => {
    // 199,600 rounds to "200 KB" and 199,700 rounds *up* to "200 KB" too.
    const miss = formatTargetMiss(199_600, 199_700);
    expect(miss.target).not.toBe(miss.achieved);
    expect(miss).toEqual({ target: '199.6 KB', achieved: '199.7 KB' });
    // A one-byte miss falls all the way back to exact bytes.
    const tight = formatTargetMiss(199_600, 199_601);
    expect(tight.target).not.toBe(tight.achieved);
    expect(parseFloat(tight.achieved)).toBeGreaterThan(parseFloat(tight.target));
  });

  it('holds over a sweep of targets and misses', () => {
    const number = (text: string) => {
      const [value, unit] = text.split(' ');
      const scale = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9 }[unit] ?? NaN;
      return parseFloat(value.replace(/,/g, '')) * scale;
    };
    for (const target of [5_000, 49_999, 200_000, 999_400, 1_000_000, 2_345_678, 50_000_000]) {
      for (const over of [1, 7, 499, 500, 501, 4_999, 123_456]) {
        const { target: t, achieved: a } = formatTargetMiss(target, target + over);
        expect(number(a)).toBeGreaterThan(number(t));
        // The achieved figure is never shown below the real size.
        expect(number(a)).toBeGreaterThanOrEqual(target + over - 1e-6);
      }
    }
  });

  it('formats several misses against one target consistently', () => {
    const shown = formatTargetMisses(100_000, [100_400, 180_000, 90_000]);
    expect(shown.target).toBe('100 KB');
    expect(shown.achieved).toEqual(['101 KB', '180 KB', '90 KB']);
  });
});

describe('X-10 — the other displays use the same decimal units', () => {
  it('Local data / storage figures', () => {
    expect(formatStorageBytes(1_500_000_000)).toBe('1.5 GB');
    expect(formatStorageBytes(5_000_000)).toBe('5 MB');
    expect(formatStorageBytes(512)).toBe('512 B');
  });

  it('whole-unit helpers for templates that already say "MB"/"KB"', () => {
    expect(wholeMegabytes(256_000_000)).toBe(256);
    expect(wholeMegabytes(32 * 1024 * 1024)).toBe(34);
    expect(wholeKilobytes(16_000_000)).toBe(16_000);
  });
});

describe('chooseSmaller (pattern 2)', () => {
  it('always takes a strictly smaller result', () => {
    expect(chooseSmaller({ originalBytes: 100, resultBytes: 99, originalSatisfies: true })).toBe(
      'result'
    );
    expect(chooseSmaller({ originalBytes: 100, resultBytes: 99, originalSatisfies: false })).toBe(
      'result'
    );
  });

  it('keeps an original that already satisfies the request when the result is no smaller', () => {
    expect(chooseSmaller({ originalBytes: 1379, resultBytes: 2077, originalSatisfies: true })).toBe(
      'original'
    );
    expect(chooseSmaller({ originalBytes: 100, resultBytes: 100, originalSatisfies: true })).toBe(
      'original'
    );
  });

  it('flags a larger result when the original does not do the job', () => {
    expect(chooseSmaller({ originalBytes: 100, resultBytes: 150, originalSatisfies: false })).toBe(
      'larger'
    );
    expect(chooseSmaller({ originalBytes: 100, resultBytes: 100, originalSatisfies: false })).toBe(
      'same'
    );
  });
});
