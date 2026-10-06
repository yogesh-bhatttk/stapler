/**
 * GAP-5 — "Image to size": one image in, one JPEG out — or the original,
 * unchanged, when it already meets every limit and a JPEG would be no smaller.
 *
 * The panel configures, the action bar commits (siblings, so signals), and the
 * canvas shows the last result. Nothing here belongs to an open document —
 * the tool reads its image from disk — so none of it resets on document change.
 */
import { signal } from '@preact/signals';
import type { SizeParam } from '../../../core/deep-link';
import { sizeParamBytes } from '../../../core/deep-link';
import { formatBytesUp, formatTargetMiss } from '../../../core/bytes';
import {
  exactOutputSize,
  isExactSide,
  type ExactDimensions,
  type ImageSize
} from '../../../core/image-target';

/**
 * CNV-14 — an explicit width × height. While `lockAspect` is on, only the
 * side last typed in (`driver`) is sent, and the other follows the image's
 * own proportions; unlocked, both are sent and the output is exactly that
 * size. Each side is stored as typed (NaN when empty), so the run never uses
 * a number different from the one on screen.
 */
export interface ExactSizeSettings {
  on: boolean;
  width: number;
  height: number;
  lockAspect: boolean;
  driver: 'width' | 'height';
}

export const DEFAULT_EXACT_SIZE: ExactSizeSettings = {
  on: false,
  width: NaN,
  height: NaN,
  lockAspect: true,
  driver: 'width'
};

export interface ImageSizeSettings {
  /** The image chosen from disk, or null before one is picked. */
  file: File | null;
  /** Whether to aim for `target`. Off means "only fit the pixel box". */
  useTarget: boolean;
  target: SizeParam;
  /** Longest side limit in pixels, or null for none. */
  maxDimension: number | null;
  /** CNV-14 — exact width × height; when on, it replaces `maxDimension`. */
  exact?: ExactSizeSettings;
}

export const imageSizeSettings = signal<ImageSizeSettings>({
  file: null,
  useTarget: true,
  target: { amount: 50, unit: 'KB' },
  maxDimension: null,
  exact: DEFAULT_EXACT_SIZE
});

/** What the last run produced; every number is measured on `bytes`. */
export interface ImageSizeResult {
  /** The file it was made from, so a later pick of another file hides it. */
  source: File;
  bytes: Uint8Array;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  /** JPEG quality used, 0..1 — or null when the original was kept as-is. */
  quality: number | null;
  targetBytes: number | null;
  reached: boolean;
  attempts: number;
  sourcePages: number;
  /** Frames in the source (an animated GIF); only the first was used. */
  sourceFrames: number;
  /** True when the original already met every limit and was kept byte for byte. */
  keptOriginal: boolean;
}

export const imageSizeResult = signal<ImageSizeResult | null>(null);

/** The sides an exact-size setting sends — none when it is off. */
export function exactRequest(exact: ExactSizeSettings | undefined): ExactDimensions {
  if (!exact?.on) return { width: null, height: null };
  if (exact.lockAspect) {
    return exact.driver === 'width'
      ? { width: exact.width, height: null }
      : { width: null, height: exact.height };
  }
  return { width: exact.width, height: exact.height };
}

/**
 * An edit to one side of an exact size. That side becomes the `driver`
 * whether or not the aspect is locked, so re-locking later keeps the side
 * the person typed last rather than one from before they unlocked.
 */
export function editExactSide(
  exact: ExactSizeSettings,
  side: 'width' | 'height',
  amount: number
): ExactSizeSettings {
  return { ...exact, [side]: amount, driver: side };
}

/**
 * Flips the aspect lock. Unlocking fills the following side with `output`'s
 * (the proportional size shown), so nothing on screen jumps. Re-locking keeps
 * the driver — the side last edited — exact; if that side is empty while the
 * other holds a number, the other drives instead, so a value on screen is
 * never answered with "Enter a width or a height".
 */
export function toggleExactLock(
  exact: ExactSizeSettings,
  output: ImageSize | null
): ExactSizeSettings {
  const other = exact.driver === 'width' ? 'height' : 'width';
  if (exact.lockAspect) {
    return { ...exact, lockAspect: false, [other]: output ? output[other] : exact[other] };
  }
  const driver =
    Number.isNaN(exact[exact.driver]) && !Number.isNaN(exact[other]) ? other : exact.driver;
  return { ...exact, lockAspect: true, driver };
}

/**
 * What is wrong with an exact-size setting, or null when it is usable (or
 * off): `missing` when no side is given, `invalid` when a side that is sent
 * is not a whole number of pixels within bounds. Unlocked, one side may be
 * left empty and then follows the other in proportion.
 */
export function exactSizeProblem(
  exact: ExactSizeSettings | undefined
): 'missing' | 'invalid' | null {
  if (!exact?.on) return null;
  const sent = exactRequest(exact);
  const sides = [sent.width, sent.height].filter(
    (side): side is number => side !== null && side !== undefined && !Number.isNaN(side)
  );
  if (sides.length === 0) return 'missing';
  return sides.every(isExactSide) ? null : 'invalid';
}

/**
 * The exact output size of `dims`, when it can be known: unlocked (both
 * sides) it needs no source; locked, it needs the source's oriented size.
 * Null when no side is asked for, or the source size is unknown.
 */
export function exactOutputFor(dims: ExactDimensions, source: ImageSize | null): ImageSize | null {
  if (isExactSide(dims.width) && isExactSide(dims.height)) {
    return { width: dims.width, height: dims.height };
  }
  return source ? exactOutputSize(source, dims) : null;
}

export function imageSizeRequest(settings: ImageSizeSettings): {
  targetBytes: number | null;
  maxDimension: number | null;
  width: number | null;
  height: number | null;
} {
  const exact = exactRequest(settings.exact);
  const width = isExactSide(exact.width) ? exact.width : null;
  const height = isExactSide(exact.height) ? exact.height : null;
  const isExact = width !== null || height !== null;
  return {
    targetBytes: settings.useTarget ? sizeParamBytes(settings.target) : null,
    // An exact size replaces the longest-side box rather than combining with it.
    maxDimension: isExact ? null : settings.maxDimension,
    width,
    height
  };
}

/**
 * CNV-14 — a missed target, said with how much it was missed by: the achieved
 * size rounded up and the target to the nearest (`formatTargetMiss`, so the
 * two never print the same), plus the overshoot, also rounded up.
 */
export function describeTargetMiss(
  targetBytes: number,
  achievedBytes: number
): { target: string; achieved: string; over: string } {
  return {
    ...formatTargetMiss(targetBytes, achievedBytes),
    over: formatBytesUp(Math.max(0, achievedBytes - targetBytes))
  };
}
