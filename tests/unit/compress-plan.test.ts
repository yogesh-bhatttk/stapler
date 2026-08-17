import { describe, expect, it } from 'vitest';
import {
  MEANINGFUL_SAVING,
  classifyPages,
  effectiveDpi,
  estimateSavings,
  refineEstimate,
  representativePageIndex
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
    maskKind: 'none',
    isImageMask: false,
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

  // §2 audit item: the safety skip-list used to be computed and then ignored on
  // the textless (raster) route — a page with no text and a `/Separation` image
  // was flattened to RGB JPEG, destroying the ink plate, while the report claimed
  // the page was untouched. `hasUnsafeImage` now gates that route too.
  it('never rasterises a textless page whose image is unsafe to re-encode', () => {
    const plan = classifyPages([page([image({ colorSpace: 'Separation' })])], [text(0)], OPTIONS);
    expect(plan.pages[0].route).toBe('already-optimized');
    expect(plan.pages[0].reencode).toEqual([]);
    expect(plan.actionableBytes).toBe(0);
    expect(plan.skipped.join(' ')).toContain('Separation');
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
    // A named ink, not a colour: flattening it to RGB destroys the plate.
    ['Separation', { colorSpace: 'Separation' }],
    // Transparency defined by exact sample values, which a lossy re-encode loses.
    ['a colour-key mask', { hasMask: true, maskKind: 'colorKey' as const }],
    // pdf.js un-blends /Matte while decoding, so the mask no longer describes it.
    ['a pre-blended soft mask', { hasSMask: true, maskKind: 'preblended' as const }],
    // A 1-bit shape that paints the fill colour; JPEG cannot represent it at all.
    ['a stencil (ImageMask)', { isImageMask: true, bitsPerComponent: 8 }]
  ])('skips a page whose image uses %s', (_label, overrides) => {
    const plan = classifyPages([page([image(overrides)])], [text(3000)], OPTIONS);
    expect(plan.pages[0].route).toBe('skip');
    expect(plan.pages[0].reencode).toEqual([]);
    expect(plan.actionableBytes).toBe(0);
    // The reason has to reach the user, not just the branch.
    expect(plan.skipped.length).toBeGreaterThan(0);
  });

  /*
   * CMP-03 widened the surgical path to these. pdf.js resolves the colour space
   * to RGB while decoding, and a soft mask lives in its own stream, so the base
   * colour can be re-encoded and the mask re-attached byte-for-byte — verified
   * end to end in `tests/e2e/tool-flows.spec.ts`.
   */
  it.each([
    ['DeviceCMYK', { colorSpace: 'DeviceCMYK' }],
    ['Indexed', { colorSpace: 'Indexed' }],
    ['ICCBased', { colorSpace: 'ICCBased' }],
    ['an /SMask', { hasSMask: true, maskKind: 'soft' as const }],
    ['a stencil /Mask stream', { hasMask: true, maskKind: 'soft' as const }]
  ])('re-encodes an over-sampled image that uses %s', (_label, overrides) => {
    const plan = classifyPages([page([image(overrides)])], [text(3000)], OPTIONS);
    expect(plan.pages[0].route).toBe('surgical');
    expect(plan.pages[0].reencode).toEqual([{ name: 'Im1', objectNumber: 10 }]);
    expect(plan.skipped).toEqual([]);
  });

  it('re-encodes the safe images on a page and skips the rest', () => {
    // Distinct object numbers, because safety is now decided per image *object*
    // document-wide (a shared image cannot be safe on one page and unsafe on
    // another — the replacement reaches every page). Two different streams
    // sharing object number 10 is not a thing a real PDF can contain.
    const plan = classifyPages(
      [
        page([
          image({ name: 'Safe', objectNumber: 10 }),
          image({ name: 'Unsafe', objectNumber: 11, filter: 'JPXDecode' })
        ])
      ],
      [text(3000)],
      OPTIONS
    );
    expect(plan.pages[0].route).toBe('surgical');
    expect(plan.pages[0].reencode).toEqual([{ name: 'Safe', objectNumber: 10 }]);
    expect(plan.skipped.join(' ')).toContain('JPXDecode');
  });

  /*
   * CMP-03 skip detection, the cross-page half. `rebuildCompressed` replaces an
   * XObject by object number, so a decision taken on one page reaches every page
   * that references the same image — which makes a per-page safety verdict
   * unsound the moment two pages disagree.
   */
  it('refuses a shared image everywhere once any page finds it unsafe', () => {
    // The realistic way two pages disagree: `/ColorSpace` is a resource-scoped
    // name, so the page whose resources do not define it reports the raw name.
    const plan = classifyPages(
      [
        page([image({ objectNumber: 10, colorSpace: 'Separation' })], 0),
        page([image({ objectNumber: 10, colorSpace: 'CS0' })], 1)
      ],
      [text(3000, 0), text(3000, 1)],
      OPTIONS
    );
    expect(plan.pages.map(p => p.route)).toEqual(['skip', 'skip']);
    expect(plan.pages.flatMap(p => p.reencode)).toEqual([]);
    expect(plan.skipped.join(' ')).toContain('Separation');
  });

  it('detects an undecodable filter that is not the first in the chain', () => {
    const plan = classifyPages(
      [page([image({ filter: 'JPXDecode', filters: ['ASCII85Decode', 'JPXDecode'] })])],
      [text(3000)],
      OPTIONS
    );
    expect(plan.pages[0].route).toBe('skip');
    expect(plan.skipped.join(' ')).toContain('JPXDecode');
  });

  /*
   * A shared image is encoded once, at the largest size any page displays it at,
   * but that size is only measured on the pages that list it in `reencode`.
   * Listing it only where it happens to be over-sampled sized the one
   * replacement for the smaller page and silently downscaled the larger one.
   */
  it('lists a shared image on every page that carries it, not just the over-sampled one', () => {
    const small: PageImageInventory = { pageIndex: 0, images: [image()], width: 595, height: 842 };
    // A3: the same 2480×3508 image is only ~212 DPI here, below the 150 × 1.15
    // threshold, so this page alone would never have nominated it.
    const large: PageImageInventory = { pageIndex: 1, images: [image()], width: 842, height: 1191 };
    const plan = classifyPages([small, large], [text(3000, 0), text(3000, 1)], OPTIONS);
    expect(plan.pages.map(p => p.route)).toEqual(['surgical', 'surgical']);
    expect(plan.pages[1].reencode).toEqual([{ name: 'Im1', objectNumber: 10 }]);
  });

  it('counts a shared image once in the actionable total', () => {
    const shared = [0, 1, 2].map(i => page([image()], i));
    const plan = classifyPages(shared, [text(3000, 0), text(3000, 1), text(3000, 2)], OPTIONS);
    // One 900_000-byte stream reachable from three pages is 900_000 actionable
    // bytes, not 2_700_000 — the inflated total made the pre-flight estimate
    // promise a saving larger than the file's whole image payload.
    expect(plan.actionableBytes).toBe(900_000);
  });

  it('classifies every page independently', () => {
    const plan = classifyPages(
      [
        page([image({ objectNumber: 10 })], 0),
        page([], 1),
        page([image({ filter: 'JPXDecode', objectNumber: 12 })], 2)
      ],
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

/**
 * CMP-05 — which page the quality preview shows. The preview re-encodes this
 * page for real on every slider tick, so picking the wrong one both wastes the
 * work and shows the user a page that cannot demonstrate the quality change.
 */
describe('representativePageIndex', () => {
  it('picks the page with the most image area, not the first or the heaviest', () => {
    const plan = classifyPages(
      [
        // Page 0 has the heaviest *bytes* but a small image; page 2 has the most
        // image area. Area wins, because that is what quality is judged on.
        page([image({ width: 400, height: 400, byteLength: 5_000_000 })], 0),
        page([], 1),
        page([image({ width: 2480, height: 3508, byteLength: 400_000 })], 2)
      ],
      [text(0, 0), text(3000, 1), text(0, 2)],
      OPTIONS
    );
    expect(representativePageIndex(plan)).toBe(2);
  });

  it('counts every image on a page, not just the first', () => {
    const plan = classifyPages(
      [
        // 810,000 pixels in one image, against 980,000 spread over two.
        page([image({ width: 900, height: 900 })], 0),
        page(
          [
            image({ width: 700, height: 700, objectNumber: 11 }),
            image({ width: 700, height: 700, objectNumber: 12 })
          ],
          1
        )
      ],
      [text(0, 0), text(0, 1)],
      OPTIONS
    );
    expect(plan.pages[1].imagePixels).toBe(980_000);
    expect(representativePageIndex(plan)).toBe(1);
  });

  it('falls back to a real page for a document with no images at all', () => {
    const plan = classifyPages([page([], 0), page([], 1)], [text(3000, 0), text(3000, 1)], OPTIONS);
    expect(representativePageIndex(plan)).toBe(0);
    expect(representativePageIndex(null)).toBe(0);
  });
});

/**
 * CMP-05 — the projection re-anchored on a page the preview really re-encoded.
 * The numbers below are the shapes measured against real exports in
 * `tests/e2e/compress-preview.spec.ts`; these tests pin the arithmetic that made
 * those two exports land within 0.2%.
 */
describe('refineEstimate', () => {
  const surgicalPlan = () =>
    classifyPages([page([image({ byteLength: 900_000 })])], [text(3000)], OPTIONS);
  const rasterPlan = () =>
    classifyPages([page([image({ byteLength: 900_000 })])], [text(0)], OPTIONS);

  it('beats the pre-flight model when the content compresses better than the model assumes', () => {
    const plan = surgicalPlan();
    const measurement = {
      pageIndex: 0,
      // A composed one-page PDF: 900KB of image plus 20KB of text and structure.
      beforeBytes: 920_000,
      // What the real encoder returned: 30KB, i.e. 10KB of image plus the same
      // 20KB of surviving text.
      afterBytes: 30_000,
      pageActionableBytes: 900_000,
      pageTargetPixels: plan.pages[0].targetPixels
    };
    const refined = refineEstimate(plan, 1_000_000, 0.75, measurement);
    expect(refined).not.toBeNull();
    // 100KB untouched + the 10KB of measured image bytes.
    expect(refined!.estimatedBytes).toBe(110_000);
    // And it is a long way below what the un-measured model projects.
    expect(refined!.estimatedBytes).toBeLessThan(
      estimateSavings(plan, 1_000_000, 0.75).estimatedBytes
    );
  });

  it('drops the non-actionable bytes a rasterised page throws away', () => {
    const plan = rasterPlan();
    const measurement = {
      pageIndex: 0,
      beforeBytes: 920_000,
      // The whole page became one 200KB JPEG — its old text and structure are gone.
      afterBytes: 200_000,
      pageActionableBytes: 900_000,
      pageTargetPixels: plan.pages[0].targetPixels
    };
    const refined = refineEstimate(plan, 1_000_000, 0.75, measurement);
    expect(refined).not.toBeNull();
    // 100KB untouched, minus the 20KB of page overhead that does not survive.
    expect(refined!.estimatedBytes).toBe(280_000);
  });

  it('scales a multi-page scan from the one page that was measured', () => {
    const plan = classifyPages(
      // Distinct object numbers: two scans, not one image drawn twice, so both
      // pages' bytes count towards the document's actionable total.
      [
        page([image({ byteLength: 900_000, objectNumber: 10 })], 0),
        page([image({ byteLength: 900_000, objectNumber: 11 })], 1)
      ],
      [text(0, 0), text(0, 1)],
      OPTIONS
    );
    const measurement = {
      pageIndex: 0,
      beforeBytes: 920_000,
      afterBytes: 200_000,
      pageActionableBytes: 900_000,
      pageTargetPixels: plan.pages[0].targetPixels
    };
    const refined = refineEstimate(plan, 2_000_000, 0.75, measurement);
    // Both pages are the same size and route, so both project at 200KB.
    expect(refined!.estimatedBytes).toBe(560_000);
  });

  it('never projects more than the file already weighs', () => {
    const plan = rasterPlan();
    const refined = refineEstimate(plan, 1_000_000, 0.75, {
      pageIndex: 0,
      beforeBytes: 920_000,
      afterBytes: 5_000_000,
      pageActionableBytes: 900_000,
      pageTargetPixels: plan.pages[0].targetPixels
    });
    expect(refined!.estimatedBytes).toBeLessThanOrEqual(1_000_000);
  });

  it('declines rather than guessing when the measurement cannot support a ratio', () => {
    const plan = surgicalPlan();
    const base = {
      pageIndex: 0,
      beforeBytes: 920_000,
      afterBytes: 30_000,
      pageActionableBytes: 900_000,
      pageTargetPixels: plan.pages[0].targetPixels
    };
    // A page the preview never re-encoded.
    expect(refineEstimate(plan, 1_000_000, 0.75, { ...base, pageIndex: 7 })).toBeNull();
    // No re-encode target to divide by.
    expect(refineEstimate(plan, 1_000_000, 0.75, { ...base, pageTargetPixels: 0 })).toBeNull();
    // Surviving text alone already accounts for the whole measured output.
    expect(refineEstimate(plan, 1_000_000, 0.75, { ...base, afterBytes: 15_000 })).toBeNull();
    // Nothing actionable at all: a text-only document keeps its pre-flight answer.
    const textOnly = classifyPages([page([])], [text(3000)], OPTIONS);
    expect(refineEstimate(textOnly, 1_000_000, 0.75, base)).toBeNull();
  });
});
