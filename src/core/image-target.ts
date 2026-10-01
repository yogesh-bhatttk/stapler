/**
 * GAP-5 — an image at or under a file size, and/or within a pixel box.
 *
 * The same rule as DOC-07's `compress-target.ts`: the search is *measured*,
 * never modelled. Every candidate it considers is a real JPEG encode, the size
 * it reports is the byte length of the bytes it hands back, and `reached` is
 * true only because one of those encodes measured at or under the target. A
 * byte model (pixels × bits-per-pixel) only ever chooses *where to look next*.
 *
 * Why not reuse `searchForTargetSize` directly: its ladder is one discrete axis
 * with a handful of very expensive trials (a whole-document render + rebuild).
 * An image encode costs milliseconds to a few hundred, and the useful answer is
 * on two continuous axes, so this bisects them in turn instead:
 *
 *  1. **Quality at full size** (within the max-dimension box). Portal limits
 *     are usually met by quality alone, and keeping every pixel is what the
 *     person would pick by hand. The high end is tried first — if the image
 *     already fits at 92% there is nothing to trade away.
 *  2. **Scale at a fixed, still-decent quality**, only when the lowest quality
 *     we are willing to use at full size still misses. Resolution is the lever
 *     that actually moves bytes by multiples; quality below ~50% mostly adds
 *     blocking artefacts for little saving.
 *  3. **The floor** — a small longest side at a low quality. If even that
 *     misses, the target is unreachable and the smallest file actually
 *     produced is returned with `reached: false`, for the UI to say so.
 *
 * Pure: the caller supplies `encode`, so the search is unit-tested against real
 * encodes of fixture images in Node and the same code runs in the image and
 * render workers.
 */
import { cancelled as cancelledError } from './errors';

/** Highest quality tried; above this JPEG size grows fast for no visible gain. */
export const IMAGE_QUALITY_MAX = 0.92;
/** Lowest quality used while the image keeps its full size. */
export const IMAGE_QUALITY_MIN = 0.5;
/** Quality used while searching over scale. */
export const IMAGE_RESIZE_QUALITY = 0.6;
/** The floor's quality: the last resort before "cannot reach". */
export const IMAGE_FLOOR_QUALITY = 0.3;
/** The floor's longest side, in pixels. Below this a photo stops being one. */
export const IMAGE_FLOOR_LONG_SIDE = 64;
/** Quality when there is no size target, only a pixel box. */
export const IMAGE_DEFAULT_QUALITY = 0.85;
/** Real encodes per image, at most. */
export const MAX_IMAGE_TRIALS = 14;

export interface ImageSize {
  width: number;
  height: number;
}

export interface ImageTrial extends ImageSize {
  quality: number;
  bytes: number;
}

export interface EncodedTrial<T> {
  output: T;
  byteLength: number;
}

export interface ImageTargetOptions<T> {
  /** Source size in pixels, after EXIF orientation. */
  width: number;
  height: number;
  /** Target in bytes, or null for "no size limit, just fit the box". */
  targetBytes: number | null;
  /** Longest side limit in pixels, or null for none. Never upscales. */
  maxDimension: number | null;
  /**
   * The source file's own size (IMG-1). When the 92% encode fits the target
   * but is larger than this, it is not taken as the answer: the quality search
   * continues for the highest quality that fits *both* the target and this
   * size. Only when no quality at full size gets under it does the search fall
   * back to the highest quality that fits the target alone — lowering
   * resolution just to beat the source would trade away what was asked to be
   * kept. Ignored when there is no target.
   */
  preferAtMostBytes?: number;
  /** Encodes the source scaled to exactly `width` × `height` at `quality`. */
  encode: (size: ImageSize, quality: number) => Promise<EncodedTrial<T>>;
  maxTrials?: number;
  signal?: AbortSignal;
  /** Called before each real encode, for progress across trials. */
  onTrial?: (trialIndex: number, maxTrials: number) => void;
}

export interface ImageTargetOutcome<T> {
  /**
   * True when `chosen` measured at or under the target (always true when there
   * was no target). False means `chosen` is the smallest file produced and it
   * is still over the target.
   */
  reached: boolean;
  chosen: ImageTrial & { output: T };
  /** Every encode run, in order. */
  trials: ImageTrial[];
  /** The size the max-dimension box allowed, before any size-driven shrinking. */
  boxed: ImageSize;
}

/**
 * The size of `width` × `height` scaled to fit a `maxDimension` box on its
 * longest side. Never enlarges; never returns a zero side.
 */
export function fitWithin(width: number, height: number, maxDimension: number | null): ImageSize {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  if (!maxDimension || maxDimension <= 0) return { width: w, height: h };
  const longest = Math.max(w, h);
  if (longest <= maxDimension) return { width: w, height: h };
  const scale = maxDimension / longest;
  return scaled({ width: w, height: h }, scale);
}

/** `size` × `scale`, rounded, each side at least 1 px. */
export function scaled(size: ImageSize, scale: number): ImageSize {
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale))
  };
}

export async function searchImageTargetSize<T>(
  options: ImageTargetOptions<T>
): Promise<ImageTargetOutcome<T>> {
  if (!(options.width > 0 && options.height > 0)) {
    throw new Error('An image to resize must have a positive width and height');
  }
  const boxed = fitWithin(options.width, options.height, options.maxDimension);
  const target = options.targetBytes;
  const budget = Math.max(3, options.maxTrials ?? MAX_IMAGE_TRIALS);
  const trials: ImageTrial[] = [];
  let smallest: (ImageTrial & { output: T }) | null = null;

  const attempt = async (size: ImageSize, quality: number) => {
    if (options.signal?.aborted) throw cancelledError();
    options.onTrial?.(trials.length, target === null ? 1 : budget);
    const result = await options.encode(size, quality);
    if (options.signal?.aborted) throw cancelledError();
    const trial: ImageTrial = { ...size, quality, bytes: result.byteLength };
    trials.push(trial);
    const withOutput = { ...trial, output: result.output };
    if (!smallest || trial.bytes < smallest.bytes) smallest = withOutput;
    return withOutput;
  };
  const fits = (trial: ImageTrial) => target !== null && trial.bytes <= target;
  const done = (chosen: ImageTrial & { output: T }, reached: boolean) => ({
    reached,
    chosen,
    trials,
    boxed
  });

  if (target === null) {
    return done(await attempt(boxed, IMAGE_DEFAULT_QUALITY), true);
  }

  // 1. Quality, at the full boxed size. With a source size to stay under, the
  // first pass aims for the tighter of the two limits.
  const source = options.preferAtMostBytes;
  const cap = source !== undefined && source > 0 && source < target ? source : target;
  const underCap = (trial: ImageTrial) => trial.bytes <= cap;
  const bisectQuality = async (
    low: ImageTrial & { output: T },
    accept: (trial: ImageTrial) => boolean
  ) => {
    let best = low;
    let lo = IMAGE_QUALITY_MIN;
    let hi = IMAGE_QUALITY_MAX;
    // Four halvings of a 0.42 interval land within ~3 quality points, which is
    // below what anyone can see, while leaving budget unspent.
    for (let i = 0; i < 4 && hi - lo > 0.03 && trials.length < budget; i++) {
      const mid = Math.round(((lo + hi) / 2) * 100) / 100;
      const trial = await attempt(boxed, mid);
      if (accept(trial)) {
        best = trial;
        lo = mid;
      } else {
        hi = mid;
      }
    }
    return best;
  };

  const high = await attempt(boxed, IMAGE_QUALITY_MAX);
  if (underCap(high)) return done(high, true);
  const low = await attempt(boxed, IMAGE_QUALITY_MIN);
  if (underCap(low)) return done(await bisectQuality(low, underCap), true);
  // Nothing at full size gets under the source: the highest quality that
  // fits the target alone is the answer.
  if (fits(high)) return done(high, true);
  if (fits(low)) return done(await bisectQuality(low, fits), true);

  // 2. Scale, at a fixed quality. JPEG size tracks pixel count closely enough
  // that the square root of the byte ratio is a good first guess; the guess
  // only picks where to measure.
  const longest = Math.max(boxed.width, boxed.height);
  const floorScale = Math.min(1, IMAGE_FLOOR_LONG_SIDE / longest);
  let lo: number | null = null; // largest scale measured to fit
  let hi = 1; // smallest scale known (or assumed, at scale 1) not to fit
  let best: (ImageTrial & { output: T }) | null = null;

  const guess = Math.sqrt(target / low.bytes) * 0.9;
  if (guess < 1 && guess > floorScale) {
    const trial = await attempt(scaled(boxed, guess), IMAGE_RESIZE_QUALITY);
    if (fits(trial)) {
      lo = guess;
      best = trial;
    } else {
      hi = guess;
    }
  }

  if (lo === null) {
    // Nothing fits yet: measure the floor before bisecting towards it.
    const floorSize = scaled(boxed, floorScale);
    const floor = await attempt(floorSize, IMAGE_RESIZE_QUALITY);
    if (fits(floor)) {
      lo = floorScale;
      best = floor;
    } else {
      // 3. Last resort: the floor at the lowest quality.
      const bottom = await attempt(floorSize, IMAGE_FLOOR_QUALITY);
      if (fits(bottom)) return done(bottom, true);
      return done(smallest ?? bottom, false);
    }
  }

  // Bisect in log space between a scale that fits and one that does not, until
  // the two are within ~3% (about one pixel in thirty) or the budget runs out.
  while (best && lo !== null && hi / lo > 1.03 && trials.length < budget) {
    const mid = Math.sqrt(lo * hi);
    const size = scaled(boxed, mid);
    if (size.width === best.width && size.height === best.height) break;
    const trial = await attempt(size, IMAGE_RESIZE_QUALITY);
    if (fits(trial)) {
      lo = mid;
      best = trial;
    } else {
      hi = mid;
    }
  }
  if (!best) throw new Error('unreachable: a fitting trial was recorded');
  return done(best, true);
}
