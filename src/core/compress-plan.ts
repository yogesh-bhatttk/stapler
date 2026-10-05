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
import { translate } from './i18n';

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
  /**
   * Total pixels the re-encoded JPEG(s) for this page will actually contain —
   * the whole page at `rasterDpi` for `raster`, or the sum of each candidate
   * image's own downscale target for `surgical`. Zero for routes that touch
   * nothing. This is what CMP-05's estimate is projected from instead of the
   * page's *current* byte count, since a re-encode's size is driven by the
   * output resolution, not by how the input happened to be compressed.
   */
  targetPixels: number;
  /**
   * Stored pixels of every image drawn on this page, counted per page rather
   * than per document (a shared image counts on each page that shows it).
   *
   * This is only used to pick CMP-05's representative page — "the one with the
   * most image area" — so it deliberately measures what is *on the page*, not
   * what is unique in the file. Stored pixels stand in for displayed area for
   * the same reason `effectiveDpi` uses the full-page-span assumption: the
   * placement CTM is not available at this stage.
   */
  imagePixels: number;
}

export interface CompressionPlan {
  pages: PagePlan[];
  /** Bytes of image data we can realistically shrink. */
  actionableBytes: number;
  /** Names of constructs we deliberately did not touch, for the report. */
  skipped: string[];
}

/**
 * Filters pdf.js cannot re-encode losslessly through a canvas round-trip.
 *
 * Exported because `rebuildCompressed` re-checks the same names as its own
 * second lock — see the mask check there — and two copies of this list is one
 * copy too many.
 */
export const UNDECODABLE_FILTERS = new Set(['JPXDecode', 'JBIG2Decode']);

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
 * How much extractable text a page needs before we refuse to rasterise it.
 *
 * One non-whitespace character. This was 24, on the reasoning that a stray
 * "Scanned by …" stamp is not a text layer and treating it as one sends a scan
 * down the useless `already-optimized` path — but the price of that reasoning
 * is paid in the other direction, and it is much higher: the `raster` route is
 * *destructive*, so a scan carrying a Bates number, a "Page 1 of 12" stamp or a
 * short caption — every one of them under 24 characters — had that real,
 * selectable text irreversibly flattened into a JPEG, while the report said the
 * page had "no extractable text". Losing text the user can select and search is
 * silent corruption; losing a compression opportunity is not.
 *
 * The original concern is not reopened, only re-priced. A stamped scan now
 * routes to `surgical`, which still re-encodes its over-sampled page image —
 * the same image the raster route would have re-rendered — and leaves the text
 * alone. The case that genuinely loses ground is a stamped scan whose image is
 * *not* over-sampled for the target, which now reports `already-optimized`
 * instead of being re-JPEGed at a lower quality: a smaller saving, truthfully
 * reported, instead of a bigger one that eats the stamp.
 *
 * `charCount` is a sum of `run.str.trim().length` (`render.worker.ts`), so
 * whitespace-only runs already count as nothing and a blank page still reaches
 * the raster route.
 */
const MEANINGFUL_TEXT_CHARS = 1;

/** Below this ratio of stored to displayed pixels there is nothing to gain. */
const MIN_DOWNSCALE_RATIO = 1.15;

export interface ClassifyOptions {
  /** Target render resolution for the raster path, in DPI. */
  rasterDpi: number;
}

/**
 * What an image disqualifies, which is not the same question for both routes.
 *
 * The two actionable routes do very different things to an image, so one
 * "is this image safe" boolean cannot answer for both:
 *
 *  • `surgical` re-encodes **the image's own stream** in place. It has to be
 *    able to decode that stream and to express the result as a JPEG.
 *  • `raster` never touches the image stream at all. pdf.js renders the whole
 *    page to an 8-bit RGBA bitmap and that bitmap becomes the page, so what the
 *    original samples were stored as is irrelevant — only whether pdf.js can
 *    render them, and whether flattening the page destroys something the file
 *    was carrying on purpose.
 *
 * Every verdict that blocks the raster route also blocks the surgical one; the
 * reverse is not true, which is the whole point.
 */
interface ImageSafety {
  /** Safe to re-encode this image's own stream in place. */
  surgical: boolean;
  /** Safe to re-render the page that carries it as a single bitmap. */
  raster: boolean;
  /** Shown in the report's skip list, so it reads as an explanation. */
  reason?: string;
}

/** Blocked on both routes — the image cannot be touched at all. */
function blocked(reason: string): ImageSafety {
  return { surgical: false, raster: false, reason };
}

function imageIsSafe(image: ImageFacts): ImageSafety {
  // The whole `/Filter` chain, not just the name at its head: filters apply in
  // order, so `[/ASCII85Decode /JPXDecode]` is a JPEG2000 image wrapped in
  // ASCII85. Testing only the first entry reported that as `ASCII85Decode`,
  // which matches nothing here, and the image went down the surgical path this
  // list exists to keep it out of.
  //
  // Surgical-only (HRD-39). The surgical route would have to decode this
  // stream and write it back as a JPEG, which it will not do for JPEG 2000 or
  // JBIG2. The raster route never reads the stream: pdf.js renders the page,
  // and the bundled pdf.js decodes both (its `openjpeg` and `jbig2` WASM
  // decoders, `pdfjs-setup.ts`'s `wasmUrl`) — the same reasoning as the
  // sub-byte case below. A textless page carrying one is therefore a raster
  // candidate like any other scan; CMP-04's never-larger check in
  // `rebuildCompressed` still discards the result if the JPEG page comes out
  // bigger, which for a well-compressed JBIG2 scan it often will.
  //
  // Surgical-only means *only* the surgical route: this is recorded, not
  // returned, so the raster-blocking checks further down (named inks, stencil
  // masks, colour-key masks, /Matte) still run. Returning early here used to
  // hand a JBIG2 image in /Separation, or a JBIG2 /ImageMask stencil, a
  // `raster: true` verdict — and the textless page carrying it was flattened
  // to an RGB JPEG, destroying the spot ink the checks below exist to keep.
  let surgicalOnly: ImageSafety | undefined;
  const undecodable = (image.filters ?? [image.filter]).find(name => UNDECODABLE_FILTERS.has(name));
  if (undecodable) {
    surgicalOnly = {
      surgical: false,
      raster: true,
      reason: translate('{filter} image (decoder output cannot be re-encoded safely)', {
        filter: undecodable
      })
    };
  }
  // The same test, applied to the image's *mask*. An `/SMask` (or a stencil
  // `/Mask`) is a separate stream with its own `/Filter` chain, and nothing
  // above looks at it — so a FlateDecode photo carrying a JPXDecode soft mask
  // passed every check here and was routed to `surgical`, where pdf.js has no
  // decoder for the mask it is asked to resample and `rebuildCompressed` would
  // re-attach a mask built from data nothing ever read. A mask that cannot be
  // decoded disqualifies the image it masks from the surgical route exactly as
  // an undecodable base image does — and, like one, leaves the raster route
  // open, because pdf.js renders the masked image, mask and all.
  const undecodableMask = (image.maskFilters ?? []).find(name => UNDECODABLE_FILTERS.has(name));
  if (undecodableMask && !surgicalOnly) {
    surgicalOnly = {
      surgical: false,
      raster: true,
      reason: translate(
        "{filter} soft mask (the mask's own stream cannot be decoded, so the image it masks cannot be re-encoded)",
        { filter: undecodableMask }
      )
    };
  }
  // Everything from here to the bit-depth test blocks *both* routes, and wins
  // over a surgical-only verdict above: its reason is the one a refused page
  // has to print.
  if (UNSAFE_COLOR_SPACES.has(image.colorSpace)) {
    return blocked(
      translate('{colorSpace} image (re-encoding would flatten a named ink to RGB)', {
        colorSpace: image.colorSpace
      })
    );
  }
  if (image.isImageMask) {
    return blocked(translate('Stencil mask (a 1-bit shape, not a picture — JPEG cannot carry it)'));
  }
  if (image.maskKind === 'colorKey') {
    return blocked(
      translate('Colour-key masked image (transparency defined by exact pixel values)')
    );
  }
  if (image.maskKind === 'preblended') {
    return blocked(
      translate('Pre-blended soft mask (/Matte), where colour and mask cannot be separated')
    );
  }

  if (surgicalOnly) return surgicalOnly;

  if (image.bitsPerComponent < 8) {
    // Surgical-only. Re-encoding a sub-byte image in place means decoding its
    // packed samples and writing a JPEG that has no way to say "1 bit per
    // component", so it stays off that route — but this used to mark the whole
    // *page* unsafe, which took the archetypal input this feature exists for
    // out of the game entirely: a 1-bit CCITT/JBIG2-style bilevel fax scan was
    // reported "cannot be safely rasterized" and compressed by exactly nothing,
    // without the raster route ever being tried. pdf.js renders bilevel images
    // to 8-bit RGBA like anything else, and the raster route re-renders the
    // page rather than reading this stream, so bit depth has no bearing on it.
    return {
      surgical: false,
      raster: true,
      reason: translate('{bits}-bit image', { bits: image.bitsPerComponent })
    };
  }
  return { surgical: true, raster: true };
}

/**
 * The stricter of two verdicts on the same image object, for the document-wide
 * pass below: unsafe anywhere is unsafe everywhere, per route.
 *
 * The reason quoted prefers one that blocks the raster route, because that is
 * the reason a blocked page prints — a surgical-only reason on a page that was
 * refused rasterisation would not explain the refusal.
 */
function mergeSafety(a: ImageSafety, b: ImageSafety): ImageSafety {
  return {
    surgical: a.surgical && b.surgical,
    raster: a.raster && b.raster,
    reason:
      (a.raster ? undefined : a.reason) ?? (b.raster ? undefined : b.reason) ?? a.reason ?? b.reason
  };
}

/**
 * The subset of `images` not already accounted for, marking each as counted.
 *
 * The same image object reached from ten pages is one stream in the file and one
 * re-encode in the output, so its bytes belong in the document's actionable
 * total exactly once; counting it per page inflated both that total and the
 * pre-flight saving estimate built from it. An image with no object number (a
 * direct stream, which cannot be replaced at all) is counted where it appears.
 */
function countOnce(images: ImageFacts[], counted: Set<number>): ImageFacts[] {
  const fresh: ImageFacts[] = [];
  for (const image of images) {
    if (image.objectNumber < 0) {
      fresh.push(image);
      continue;
    }
    if (counted.has(image.objectNumber)) continue;
    counted.add(image.objectNumber);
    fresh.push(image);
  }
  return fresh;
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

/**
 * Pixels an image will actually be re-encoded at, under the same full-page-span
 * assumption `effectiveDpi` uses. Clamped to the source's own pixel count: an
 * image already below the target never gets *upscaled* by this estimate.
 */
function targetPixelCount(
  image: ImageFacts,
  pageWidth: number,
  pageHeight: number,
  rasterDpi: number
): number {
  const maxW = Math.max(1, Math.round((pageWidth / 72) * rasterDpi));
  const maxH = Math.max(1, Math.round((pageHeight / 72) * rasterDpi));
  return Math.min(image.width, maxW) * Math.min(image.height, maxH);
}

/** Pixels a whole re-rendered page will contain at `rasterDpi` — the raster route. */
function pagePixelCount(pageWidth: number, pageHeight: number, rasterDpi: number): number {
  const w = Math.max(1, Math.round((pageWidth / 72) * rasterDpi));
  const h = Math.max(1, Math.round((pageHeight / 72) * rasterDpi));
  return w * h;
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

  const hasTextOn = (pageIndex: number) =>
    (textByPage.get(pageIndex)?.charCount ?? 0) >= MEANINGFUL_TEXT_CHARS;

  /*
   * Safety is a property of the image *object*, not of the page it appears on,
   * and has to be settled document-wide before any page is routed.
   *
   * `rebuildCompressed` replaces an XObject by object number, so the replacement
   * reaches every page referencing it. Judging safety per page therefore lets
   * one page's verdict override another's: an image's `/ColorSpace` can be a
   * resource-scoped *name* (`/CS0`) resolved against the resources of whichever
   * page draws it, so a `/Separation` plate named on page 1 and drawn again on
   * page 2 through resources that do not name it resolved to `Separation` on
   * page 1 (correctly refused) and to `CS0` on page 2 (silently a candidate) —
   * and page 2 winning flattened the ink plate to RGB for the whole document,
   * the exact outcome this list exists to prevent. Unsafe anywhere is now unsafe
   * everywhere.
   */
  const unsafeByObject = new Map<number, ImageSafety>();
  for (const page of inventory) {
    for (const image of page.images) {
      const verdict = imageIsSafe(image);
      if (verdict.surgical && verdict.raster) continue;
      if (image.objectNumber < 0) continue;
      const existing = unsafeByObject.get(image.objectNumber);
      unsafeByObject.set(image.objectNumber, existing ? mergeSafety(existing, verdict) : verdict);
    }
  }
  const safetyOf = (image: ImageFacts): ImageSafety => {
    const shared = image.objectNumber >= 0 ? unsafeByObject.get(image.objectNumber) : undefined;
    return shared ?? imageIsSafe(image);
  };

  const oversampled = (image: ImageFacts, pageWidth: number, pageHeight: number) =>
    effectiveDpi(image, pageWidth, pageHeight) > options.rasterDpi * MIN_DOWNSCALE_RATIO;

  /*
   * Candidacy is document-wide for the same reason. A shared image is re-encoded
   * once, at the largest size any page displays it at — but that size is only
   * ever measured (in `render.worker.ts`) on the pages that list the image in
   * `reencode`. If page A over-samples it and page B, a larger page, does not,
   * listing it on page A alone sized the single replacement for page A and left
   * page B's larger placement silently inheriting that downscale. Listing it on
   * every page that carries it lets "largest use wins" see every use.
   */
  const candidateObjects = new Set<number>();
  for (const page of inventory) {
    if (!hasTextOn(page.pageIndex)) continue;
    for (const image of page.images) {
      if (image.objectNumber < 0) continue;
      if (!safetyOf(image).surgical) continue;
      if (oversampled(image, page.width, page.height)) candidateObjects.add(image.objectNumber);
    }
  }

  /** Object numbers whose bytes have already been added to the totals. */
  const counted = new Set<number>();

  for (const page of inventory) {
    const census = textByPage.get(page.pageIndex);
    const hasText = hasTextOn(page.pageIndex);
    const imagePixels = page.images.reduce((n, image) => n + image.width * image.height, 0);
    const safety = page.images.map(image => ({ image, ...safetyOf(image) }));
    const blocksRaster = safety.some(entry => !entry.raster);

    /*
     * `skipped` is the report's "constructs we deliberately did not touch"
     * list, so what belongs in it depends on which route this page is about to
     * take. A 1-bit image on a page with text really is left alone — it is not
     * a re-encode candidate — and belongs there. The same image on a textless
     * page that rasterises is not left alone at all: it is re-rendered into the
     * page's new JPEG along with everything else, and listing it would be a
     * false claim in the one report the user reads to find out what happened.
     */
    const reportable = hasText || blocksRaster ? safety.filter(entry => !entry.surgical) : [];
    for (const entry of reportable) {
      if (entry.reason) skipped.add(entry.reason);
    }

    if (!hasText) {
      // No text to preserve, so the whole page can become one image — provided it has no unsafe images.
      if (page.images.length === 0 && (census?.runCount ?? 0) > 0) {
        pages.push({
          pageIndex: page.pageIndex,
          route: 'already-optimized',
          reason: 'Text-only page',
          reencode: [],
          actionableBytes: 0,
          targetPixels: 0,
          imagePixels
        });
        continue;
      }
      if (page.images.length === 0 && (census?.runCount ?? 0) === 0) {
        pages.push({
          pageIndex: page.pageIndex,
          route: 'already-optimized',
          reason: 'Page has neither text nor images',
          reencode: [],
          actionableBytes: 0,
          targetPixels: 0,
          imagePixels
        });
        continue;
      }
      if (blocksRaster) {
        pages.push({
          pageIndex: page.pageIndex,
          route: 'already-optimized',
          reason:
            'Page contains specialized images (e.g. spot colors or masks) that cannot be safely rasterized',
          reencode: [],
          actionableBytes: 0,
          targetPixels: 0,
          imagePixels
        });
        continue;
      }
      const bytes = countOnce(page.images, counted).reduce((n, i) => n + i.byteLength, 0);
      actionableBytes += bytes;
      pages.push({
        pageIndex: page.pageIndex,
        route: 'raster',
        reason: 'Scanned page — no extractable text, so the page is re-rendered as one image',
        reencode: [],
        actionableBytes: bytes,
        targetPixels: pagePixelCount(page.width, page.height, options.rasterDpi),
        imagePixels
      });
      continue;
    }

    const candidates = safety.filter(entry => {
      if (!entry.surgical) return false;
      // Only worth re-encoding if it is meaningfully over-sampled for the target
      // *on some page* — a shared image is judged once, document-wide, so every
      // page carrying it reports it and its largest placement decides the size.
      return entry.image.objectNumber >= 0
        ? candidateObjects.has(entry.image.objectNumber)
        : oversampled(entry.image, page.width, page.height);
    });

    if (candidates.length === 0) {
      const unsafeCount = safety.filter(entry => !entry.surgical).length;
      pages.push({
        pageIndex: page.pageIndex,
        route: unsafeCount > 0 ? 'skip' : 'already-optimized',
        reason:
          unsafeCount > 0
            ? `Left untouched — ${unsafeCount} image(s) use constructs Stapler will not re-encode`
            : 'Text and vectors only, or images already at the target resolution',
        reencode: [],
        actionableBytes: 0,
        targetPixels: 0,
        imagePixels
      });
      continue;
    }

    const fresh = countOnce(
      candidates.map(entry => entry.image),
      counted
    );
    const bytes = fresh.reduce((n, image) => n + image.byteLength, 0);
    actionableBytes += bytes;
    const targetPixels = fresh.reduce(
      (n, image) => n + targetPixelCount(image, page.width, page.height, options.rasterDpi),
      0
    );
    pages.push({
      pageIndex: page.pageIndex,
      route: 'surgical',
      reason: `Has text — ${candidates.length} over-sampled image(s) re-encoded, text left untouched`,
      reencode: candidates.map(entry => ({
        name: entry.image.name,
        objectNumber: entry.image.objectNumber
      })),
      actionableBytes: bytes,
      targetPixels,
      imagePixels
    });
  }

  return { pages, actionableBytes, skipped: [...skipped] };
}

/**
 * Projected JPEG bytes for a re-encode of `pixels` pixels at `quality`.
 *
 * A re-encoded image's size is driven by its *output* resolution and quality,
 * essentially independent of how many bytes the original happened to occupy —
 * a poorly-compressed 50MB scan and a well-compressed 2MB scan of the same page
 * become nearly the same JPEG at the same target DPI. The previous model
 * (`actionableBytes * qualityFraction`) had no notion of resolution at all, so a
 * 300 DPI target and a 72 DPI target of the same source produced an identical
 * estimate — the dominant reason it was measured 20–84% off.
 *
 * `pixels` here is computed the same conservative, full-page-span way
 * `effectiveDpi`/`targetPixelCount` already do — this stage has no measured CTM
 * placement (that only exists inside `render.worker.ts`'s real operator-list
 * walk, which is too expensive to run during the "instant" pre-flight estimate).
 * For an image that does not actually span the page, this overstates the target
 * pixel count and so the projected bytes — the same direction of error the rest
 * of this module already accepts deliberately (see CMP-04's doc comment above
 * `estimateSavings`).
 *
 * The `pixels^0.6` shape and the `k(quality)` coefficients are fit against this
 * project's own re-encoder (`OffscreenCanvas.convertToBlob('image/jpeg', q)`),
 * measured end to end — real exported byte counts, not synthetic numbers — across
 * a 72/150 DPI × 50/70/90% quality sweep on a representative photographic
 * fixture, using this same full-page-span pixel count as input so the fit
 * matches what this function is actually called with. Sub-linear scaling in
 * pixel count matches the general JPEG behaviour of fixed per-block (8×8 DCT)
 * overhead costing proportionally more at low resolution — not a coincidence
 * specific to this fixture — but the constants are only as good as that one
 * calibration source and content type, so this remains a heuristic, not a
 * guarantee.
 */
function projectedReencodeBytes(pixels: number, quality: number): number {
  if (pixels <= 0) return 0;
  const q = Math.min(0.95, Math.max(0.1, quality));
  const bytesPerPixel06 = 16.167 - 42.6025 * q + 43.6 * q * q;
  return Math.max(1, bytesPerPixel06) * Math.pow(pixels, 0.6);
}

/**
 * CMP-04 — the pre-flight estimate, so we can say "already optimized, only N%
 * possible" *before* spending a minute on the work, not after.
 *
 * Deliberately pessimistic where it still can be: non-actionable bytes (text,
 * structure, images left untouched) are assumed to not shrink at all, and the
 * projection is never allowed to exceed the actionable bytes' current size —
 * a badly wrong pixel projection should never promise more than "no worse than
 * today", since the number is shown to the user before any work is done.
 *
 * The pixel-based projection is calibrated against moderate-entropy photographic
 * content (see `projectedReencodeBytes`) and can overshoot for unusually
 * compressible source images — a PNG of a few flat colour bands can already be
 * smaller than this estimate's JPEG projection, which previously surfaced as a
 * false "already optimized" (and the confirmation dialog gating export on it)
 * for a document that in fact still compresses well. The old quality-only
 * fraction-of-original model has no notion of resolution and so is usually the
 * looser (larger) of the two, but it *is* anchored to this specific file's own
 * achieved compression ratio — so it is kept as a ceiling: whichever model
 * projects fewer bytes wins, never the pixel model alone.
 */
export function estimateSavings(
  plan: CompressionPlan,
  totalBytes: number,
  quality: number
): { estimatedBytes: number; estimatedFraction: number } {
  const pixelProjected = plan.pages.reduce(
    (sum, page) => sum + projectedReencodeBytes(page.targetPixels, quality),
    0
  );
  const qualityKeptFraction = Math.min(0.95, Math.max(0.1, quality * 0.55));
  const qualityProjected = plan.actionableBytes * qualityKeptFraction;
  const cappedProjection = Math.min(pixelProjected, qualityProjected, plan.actionableBytes);
  const nonActionableBytes = Math.max(0, totalBytes - plan.actionableBytes);
  const estimated = Math.max(1, nonActionableBytes + cappedProjection);
  return {
    estimatedBytes: Math.round(estimated),
    estimatedFraction: totalBytes > 0 ? 1 - estimated / totalBytes : 0
  };
}

/** Below this, telling the truth beats saving a pointless file (CMP-04). */
export const MEANINGFUL_SAVING = 0.05;

/**
 * One page of this document, put through the real re-encoder by CMP-05's
 * preview: the composed one-page PDF's size, and the size the pipeline actually
 * returned for it at the settings being previewed.
 */
export interface PreviewMeasurement {
  pageIndex: number;
  /** Size of the composed one-page PDF the measurement was taken from. */
  beforeBytes: number;
  /** Size the real pipeline returned for it. */
  afterBytes: number;
  /**
   * `actionableBytes` and `targetPixels` of that *composed* page's own plan.
   *
   * Not the document plan's figures for the same page: composing a page
   * re-embeds its streams, so the one-page PDF is not a byte-for-byte slice of
   * the original file (on the scanned fixture it is roughly twice the size).
   * Subtracting the original file's actionable bytes from the composed page's
   * total therefore produced a nonsense "overhead" larger than the whole
   * measured output, and the refinement silently declined every time.
   */
  pageActionableBytes: number;
  pageTargetPixels: number;
}

/**
 * CMP-05 — the projection, re-anchored on a page that was actually re-encoded.
 *
 * `estimateSavings` has to guess how well content it has never encoded will
 * compress, and `projectedReencodeBytes`'s coefficients are fitted to
 * photographic content; on smooth or flat artwork it overshoots by multiples —
 * measured at 296% over on the mixed fixture — which is exactly the gap CMP-05's
 * "within 15% of actual" criterion is about. Once the preview has run one page
 * through the real encoder there is nothing left to guess about how *this*
 * document's content compresses: that page gives a measured bytes-per-target-
 * pixel, and the rest of the plan is scaled by it.
 *
 * Two corrections make that scaling hold, and both were found by measuring
 * against real exports rather than reasoning about them:
 *
 * 1. **The measured page's own non-image bytes.** On a `surgical` page the text,
 *    fonts and structure survive into the output, so they must come out of the
 *    measured bytes before a per-pixel image cost can be taken — otherwise every
 *    other page inherits this page's text as if it were image data. On a
 *    `raster` page they do *not* survive: the page becomes one JPEG, so the
 *    measured output essentially is the image.
 * 2. **Non-actionable bytes that disappear.** `estimateSavings` assumes every
 *    byte outside `actionableBytes` survives, which is right for the surgical
 *    route and wrong for the raster one — a rasterised page throws its old
 *    content away. On the scanned fixture that single assumption was the whole
 *    108% overshoot. The measured page tells us what a raster page's
 *    non-actionable bytes weigh, and every raster page is scaled by area from it.
 *
 * Pages on the *other* actionable route from the one measured keep the
 * pre-flight model, since nothing was measured for them.
 *
 * Returns `null` — "keep the pre-flight estimate" — whenever the measurement
 * cannot support a ratio: a page with no re-encode target, or a measured output
 * whose surviving overhead already accounts for all of it.
 */
export function refineEstimate(
  plan: CompressionPlan,
  totalBytes: number,
  quality: number,
  measurement: PreviewMeasurement
): { estimatedBytes: number; estimatedFraction: number } | null {
  const measuredPage = plan.pages.find(p => p.pageIndex === measurement.pageIndex);
  if (!measuredPage || measurement.pageTargetPixels <= 0) return null;
  const route = measuredPage.route;
  if (route !== 'raster' && route !== 'surgical') return null;

  const pageOverhead = Math.max(0, measurement.beforeBytes - measurement.pageActionableBytes);
  const survivingOverhead = route === 'surgical' ? pageOverhead : 0;
  const imageBytesAfter = measurement.afterBytes - survivingOverhead;
  if (imageBytesAfter <= 0) return null;

  const perPixel = imageBytesAfter / measurement.pageTargetPixels;

  let projectedImages = 0;
  let vanishing = 0;
  for (const page of plan.pages) {
    if (page.targetPixels <= 0) continue;
    if (page.route === route) {
      projectedImages += perPixel * page.targetPixels;
      // A rasterised page's old content is replaced wholesale, so its share of
      // the "untouched" bytes is not untouched at all.
      if (route === 'raster') {
        vanishing += pageOverhead * (page.targetPixels / measurement.pageTargetPixels);
      }
    } else {
      projectedImages += projectedReencodeBytes(page.targetPixels, quality);
    }
  }
  if (projectedImages <= 0) return null;

  const untouched = Math.max(0, totalBytes - plan.actionableBytes - vanishing);
  const estimated = Math.min(totalBytes, Math.max(1, untouched + projectedImages));
  return {
    estimatedBytes: Math.round(estimated),
    estimatedFraction: totalBytes > 0 ? 1 - estimated / totalBytes : 0
  };
}

/**
 * CMP-05 — the page a quality preview should show: the one with the most image
 * area, since that is where a quality judgement can actually be made.
 *
 * Ties (a text-only document, where every page has no image at all) fall back to
 * the page with the most actionable bytes, and then to the first page, so the
 * preview always has something to render rather than nothing.
 */
export function representativePageIndex(plan: CompressionPlan | null | undefined): number {
  if (!plan || plan.pages.length === 0) return 0;
  let best = plan.pages[0];
  for (const page of plan.pages) {
    if (
      page.imagePixels > best.imagePixels ||
      (page.imagePixels === best.imagePixels && page.actionableBytes > best.actionableBytes)
    ) {
      best = page;
    }
  }
  return best.pageIndex;
}
