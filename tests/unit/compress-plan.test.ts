import { describe, expect, it } from 'vitest';
import {
  MEANINGFUL_SAVING,
  classifyPages,
  effectiveDpi,
  estimateSavings
} from '../../src/core/compress-plan';
import type { ImageFacts, PageImageInventory } from '../../src/core/workers/process.worker';
import type { PageTextPresence } from '../../src/core/workers/render.worker';

function image(overrides: Partial<ImageFacts> = {}): ImageFacts {
  return {
    name: 'Im1',
    objectNumber: 10,
    // 2480×3508 is A4 at 300 DPI, i.e. twice the 150 DPI target.
    width: 2480,
    height: 3508,
    bitsPerComponent: 8,
    colorSpace: 'DeviceRGB',
    filter: 'DCTDecode',
    hasSMask: false,
    hasMask: false,
    byteLength: 900_000,
    ...overrides
  };
}

function page(images: ImageFacts[], pageIndex = 0): PageImageInventory {
  return { pageIndex, images, width: 595, height: 842 };
}

function text(charCount: number, pageIndex = 0): PageTextPresence {
  return { pageIndex, charCount, runCount: charCount > 0 ? Math.ceil(charCount / 8) : 0 };
}

const OPTIONS = { rasterDpi: 150 };

describe('classifyPages', () => {
  it('routes a scanned page to raster', () => {
    const plan = classifyPages([page([image()])], [text(0)], OPTIONS);
    expect(plan.pages[0].route).toBe('raster');
    expect(plan.actionableBytes).toBe(900_000);
  });

  // The acceptance criterion in CMP-01: no fixture with extractable text may be
  // rasterised, because that destroys selectable text.
  it('never rasterises a page that has extractable text', () => {
    const plan = classifyPages([page([image()])], [text(4000)], OPTIONS);
    expect(plan.pages[0].route).toBe('surgical');
    expect(plan.pages[0].reencode).toEqual([{ name: 'Im1', objectNumber: 10 }]);
  });

  it('treats a stray label on a scan as no text layer', () => {
    // "Scanned by CamScanner" is 21 characters — not a text layer.
    const plan = classifyPages([page([image()])], [text(21)], OPTIONS);
    expect(plan.pages[0].route).toBe('raster');
  });

  it('reports a text-only page as already optimized', () => {
    const plan = classifyPages([page([])], [text(3000)], OPTIONS);
    expect(plan.pages[0].route).toBe('already-optimized');
    expect(plan.actionableBytes).toBe(0);
  });

  it('reports a genuinely empty page as already optimized', () => {
    const plan = classifyPages([page([])], [text(0)], OPTIONS);
    expect(plan.pages[0].route).toBe('already-optimized');
  });

  it('leaves an image already at the target resolution alone', () => {
    // 1240px across 595pt ≈ 150 DPI, exactly the target.
    const plan = classifyPages(
      [page([image({ width: 1240, height: 1754 })])],
      [text(3000)],
      OPTIONS
    );
    expect(plan.pages[0].route).toBe('already-optimized');
  });

  // Each of these is a documented way to corrupt a document, so each must skip.
  it.each([
    ['JPXDecode', { filter: 'JPXDecode' }],
    ['JBIG2Decode', { filter: 'JBIG2Decode' }],
    ['DeviceN', { colorSpace: 'DeviceN' }],
    ['sub-byte depth', { bitsPerComponent: 1 }],
    ['CMYK', { colorSpace: 'DeviceCMYK' }],
    ['Indexed', { colorSpace: 'Indexed' }],
    ['Separation', { colorSpace: 'Separation' }],
    ['an SMask', { hasSMask: true }],
    ['a stencil mask', { hasMask: true }]
  ])('skips a page whose image uses %s', (_label, overrides) => {
    const plan = classifyPages([page([image(overrides)])], [text(3000)], OPTIONS);
    expect(plan.pages[0].route).toBe('skip');
    expect(plan.pages[0].reencode).toEqual([]);
    expect(plan.actionableBytes).toBe(0);
    // The reason has to reach the user, not just the branch.
    expect(plan.skipped.length).toBeGreaterThan(0);
  });

  it('re-encodes the safe images on a page and skips the rest', () => {
    const plan = classifyPages(
      [page([image({ name: 'Safe' }), image({ name: 'Unsafe', filter: 'JPXDecode' })])],
      [text(3000)],
      OPTIONS
    );
    expect(plan.pages[0].route).toBe('surgical');
    expect(plan.pages[0].reencode).toEqual([{ name: 'Safe', objectNumber: 10 }]);
    expect(plan.skipped.join(' ')).toContain('JPXDecode');
  });

  it('classifies every page independently', () => {
    const plan = classifyPages(
      [page([image()], 0), page([], 1), page([image({ filter: 'JPXDecode' })], 2)],
      [text(0, 0), text(2000, 1), text(2000, 2)],
      OPTIONS
    );
    expect(plan.pages.map(p => p.route)).toEqual(['raster', 'already-optimized', 'skip']);
  });

  it('gives every page a reason a person can read', () => {
    const plan = classifyPages(
      [page([image()], 0), page([], 1)],
      [text(0, 0), text(2000, 1)],
      OPTIONS
    );
    for (const entry of plan.pages) {
      expect(entry.reason.length).toBeGreaterThan(10);
      expect(entry.reason).not.toMatch(/^[A-Z_]+$/);
    }
  });
});

describe('effectiveDpi', () => {
  it('reports 300 DPI for an A4-at-300 image', () => {
    expect(Math.round(effectiveDpi(image(), 595, 842))).toBe(300);
  });

  it('handles a degenerate page box without dividing by zero', () => {
    expect(effectiveDpi(image(), 0, 0)).toBe(0);
  });
});

describe('estimateSavings', () => {
  it('projects a saving proportional to the actionable bytes', () => {
    const plan = classifyPages([page([image()])], [text(0)], OPTIONS);
    const estimate = estimateSavings(plan, 1_000_000, 0.75);
    expect(estimate.estimatedBytes).toBeLessThan(1_000_000);
    expect(estimate.estimatedFraction).toBeGreaterThan(MEANINGFUL_SAVING);
  });

  it('projects nothing when no page is actionable', () => {
    const plan = classifyPages([page([])], [text(3000)], OPTIONS);
    const estimate = estimateSavings(plan, 1_000_000, 0.75);
    expect(estimate.estimatedBytes).toBe(1_000_000);
    expect(estimate.estimatedFraction).toBe(0);
    expect(estimate.estimatedFraction).toBeLessThan(MEANINGFUL_SAVING);
  });

  it('never projects a negative or zero size', () => {
    const plan = classifyPages([page([image({ byteLength: 10_000_000 })])], [text(0)], OPTIONS);
    const estimate = estimateSavings(plan, 1000, 0.3);
    expect(estimate.estimatedBytes).toBeGreaterThan(0);
  });

  it('projects a smaller file at lower quality', () => {
    const plan = classifyPages([page([image()])], [text(0)], OPTIONS);
    const low = estimateSavings(plan, 1_000_000, 0.3);
    const high = estimateSavings(plan, 1_000_000, 0.95);
    expect(low.estimatedBytes).toBeLessThan(high.estimatedBytes);
  });
});
