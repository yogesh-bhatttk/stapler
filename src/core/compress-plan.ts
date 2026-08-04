/**
 * CMP-01 — per-page compression routing.
 *
 * Pure: takes the pdf-lib image inventory and the pdf.js text census and returns
 * a plan. Kept free of both libraries so the classification rules are unit-tested
 * directly rather than inferred from output file sizes.
 *
 * PLAN §4.1 defines three routes. The fourth outcome, `skip`, exists because a
 * page we cannot process safely must be left byte-identical rather than guessed
 * at (PLAN §5.2).
 */
import type { ImageFacts, PageImageInventory } from './workers/process.worker';
import type { PageTextPresence } from './workers/render.worker';

export type PageRoute = 'raster' | 'surgical' | 'already-optimized' | 'skip';

export interface PagePlan {
  pageIndex: number;
  route: PageRoute;
  /** Shown in the report, so it has to read as an explanation, not a code. */
  reason: string;
  /** Images on this page worth re-encoding, for the `surgical` route. */
  reencode: { name: string; objectNumber: number }[];
  /** Bytes currently occupied by images we can act on. */
  actionableBytes: number;
}

export interface CompressionPlan {
  pages: PagePlan[];
  /** Bytes of image data we can realistically shrink. */
  actionableBytes: number;
  /** Names of constructs we deliberately did not touch, for the report. */
  skipped: string[];
}

/** Filters pdf.js cannot re-encode losslessly through a canvas round-trip. */
const UNDECODABLE_FILTERS = new Set(['JPXDecode', 'JBIG2Decode']);

/**
 * Colour spaces we refuse to re-encode.
 *
 * Not because pdf.js cannot decode them — it resolves the tint transform and
 * hands back RGB like any other space — but because the result would no longer
 * be a separation. A `/Separation` or `/DeviceN` image is a named ink plate in a
 * print job, and flattening it to DeviceRGB silently destroys the plate. That is
 * a decision for the person sending the file to press, so it is reported rather
 * than taken.
 *
 * DeviceCMYK and Indexed are *not* here: those genuinely are "convert to RGB
 * before the canvas re-encode" (PLAN §4.1), and pdf.js does the conversion
 * itself while decoding.
 */
const UNSAFE_COLOR_SPACES = new Set(['DeviceN', 'Separation']);

/**
 * A page needs this much extractable text before we refuse to rasterise it. One
 * stray "Scanned by …" stamp is not a text layer, and treating it as one is what
 * sends scans down the useless already-optimized path.
 */
const MEANINGFUL_TEXT_CHARS = 24;

/** Below this ratio of stored to displayed pixels there is nothing to gain. */
const MIN_DOWNSCALE_RATIO = 1.15;

export interface ClassifyOptions {
  /** Target render resolution for the raster path, in DPI. */
  rasterDpi: number;
}

function imageIsSafe(image: ImageFacts): { safe: boolean; reason?: string } {
  if (UNDECODABLE_FILTERS.has(image.filter)) {
    return {
      safe: false,
      reason: `${image.filter} image (decoder output cannot be re-encoded safely)`
    };
  }
  if (UNSAFE_COLOR_SPACES.has(image.colorSpace)) {
    return {
      safe: false,
      reason: `${image.colorSpace} image (re-encoding would flatten a named ink to RGB)`
    };
  }
  if (image.isImageMask) {
    return {
      safe: false,
      reason: 'Stencil mask (a 1-bit shape, not a picture — JPEG cannot carry it)'
    };
  }
  if (image.maskKind === 'colorKey') {
    return {
      safe: false,
      reason: 'Colour-key masked image (transparency defined by exact pixel values)'
    };
  }
  if (image.maskKind === 'preblended') {
    return {
      safe: false,
      reason: 'Pre-blended soft mask (/Matte), where colour and mask cannot be separated'
    };
  }

  if (image.bitsPerComponent < 8) {
    return { safe: false, reason: `${image.bitsPerComponent}-bit image` };
  }
  return { safe: true };
}

/** Stored pixels per point, i.e. the effective DPI of an image on the page. */
export function effectiveDpi(image: ImageFacts, pageWidth: number, pageHeight: number): number {
  // Without the content-stream CTM we cannot know the true placement, so assume
  // the image spans the page — the conservative reading, since it under-reports
  // how over-sampled the image is and so under-promises the saving.
  const byWidth = pageWidth > 0 ? (image.width / pageWidth) * 72 : 0;
  const byHeight = pageHeight > 0 ? (image.height / pageHeight) * 72 : 0;
  return Math.max(byWidth, byHeight);
}

export function classifyPages(
  inventory: PageImageInventory[],
  text: PageTextPresence[],
  options: ClassifyOptions
): CompressionPlan {
  const textByPage = new Map(text.map(t => [t.pageIndex, t]));
  const pages: PagePlan[] = [];
  const skipped = new Set<string>();
  let actionableBytes = 0;

  for (const page of inventory) {
    const census = textByPage.get(page.pageIndex);
    const hasText = (census?.charCount ?? 0) >= MEANINGFUL_TEXT_CHARS;
    const safety = page.images.map(image => ({ image, ...imageIsSafe(image) }));
    for (const entry of safety) {
      if (!entry.safe && entry.reason) skipped.add(entry.reason);
    }

    if (!hasText) {
      // No text to preserve, so the whole page can become one image. This is the
      // path that delivers 70–90% on a scan.
      if (page.images.length === 0 && (census?.runCount ?? 0) === 0) {
        pages.push({
          pageIndex: page.pageIndex,
          route: 'already-optimized',
          reason: 'Page has neither text nor images',
          reencode: [],
          actionableBytes: 0
        });
        continue;
      }
      const bytes = page.images.reduce((n, i) => n + i.byteLength, 0);
      actionableBytes += bytes;
      pages.push({
        pageIndex: page.pageIndex,
        route: 'raster',
        reason: 'Scanned page — no extractable text, so the page is re-rendered as one image',
        reencode: [],
        actionableBytes: bytes
      });
      continue;
    }

    const candidates = safety.filter(entry => {
      if (!entry.safe) return false;
      // Only worth re-encoding if it is meaningfully over-sampled for the target.
      return (
        effectiveDpi(entry.image, page.width, page.height) > options.rasterDpi * MIN_DOWNSCALE_RATIO
      );
    });

    if (candidates.length === 0) {
      const unsafeCount = safety.filter(entry => !entry.safe).length;
      pages.push({
        pageIndex: page.pageIndex,
        route: unsafeCount > 0 ? 'skip' : 'already-optimized',
        reason:
          unsafeCount > 0
            ? `Left untouched — ${unsafeCount} image(s) use constructs Stapler will not re-encode`
            : 'Text and vectors only, or images already at the target resolution',
        reencode: [],
        actionableBytes: 0
      });
      continue;
    }

    const bytes = candidates.reduce((n, entry) => n + entry.image.byteLength, 0);
    actionableBytes += bytes;
    pages.push({
      pageIndex: page.pageIndex,
      route: 'surgical',
      reason: `Has text — ${candidates.length} over-sampled image(s) re-encoded, text left untouched`,
      reencode: candidates.map(entry => ({
        name: entry.image.name,
        objectNumber: entry.image.objectNumber
      })),
      actionableBytes: bytes
    });
  }

  return { pages, actionableBytes, skipped: [...skipped] };
}

/**
 * CMP-04 — the pre-flight estimate, so we can say "already optimized, only N%
 * possible" *before* spending a minute on the work, not after.
 *
 * Deliberately pessimistic: it assumes a JPEG re-encode reaches the quality-scaled
 * fraction of the original image bytes and that nothing else shrinks. Over-promising
 * here is worse than under-promising, since the number is shown to the user.
 */
export function estimateSavings(
  plan: CompressionPlan,
  totalBytes: number,
  quality: number
): { estimatedBytes: number; estimatedFraction: number } {
  const keptFraction = Math.min(0.95, Math.max(0.1, quality * 0.55));
  const saved = plan.actionableBytes * (1 - keptFraction);
  const estimated = Math.max(1, totalBytes - saved);
  return {
    estimatedBytes: Math.round(estimated),
    estimatedFraction: totalBytes > 0 ? 1 - estimated / totalBytes : 0
  };
}

/** Below this, telling the truth beats saving a pointless file (CMP-04). */
export const MEANINGFUL_SAVING = 0.05;
