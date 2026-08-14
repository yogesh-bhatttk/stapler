/**
 * DOC-07 — compress to a target size.
 *
 * The search is deliberately *measured*, not modelled. CMP-04's
 * `estimateSavings` exists to answer "is this worth doing at all" instantly, and
 * CMP-05 had to re-anchor it on one real re-encode precisely because the static
 * model is wrong by multiples on content it was not fitted to. A target-size
 * feature that picked its settings from that model would inherit exactly that
 * error and then *assert* a size it never produced — the failure mode the
 * project's honesty rules exist to prevent. So every rung this search reports on
 * is a full render + encode + rebuild pass whose byte count came off the real
 * output, and the size reported to the user is the length of the bytes that are
 * about to be written.
 *
 * That makes each trial expensive, which is what the ladder and the trial cap
 * are for: a discrete ladder of (DPI, quality) rungs ordered from largest
 * expected output to smallest, binary-searched for the *highest-quality* rung
 * that lands at or under the target, in at most `MAX_TARGET_TRIALS` real runs.
 *
 * The floor rung is run first, before any bisection. It is the one trial that
 * can settle the question outright: if the floor still exceeds the target, no
 * rung above it can do better, and the honest answer ("this cannot reach your
 * target, here is the smallest I can make it") is available after one pass
 * instead of four. That case is not exotic — CMP-03 deliberately skips six
 * categories of image, so a document dominated by JPX/JBIG2/Separation/stencil/
 * colour-key/pre-blended images has very little Stapler is willing to touch, and
 * "cannot reach the target" is the normal outcome there rather than an edge case.
 *
 * Pure of pdf-lib, pdf.js and workers: the caller supplies `run`, so the search
 * order is unit-tested against synthetic byte counts and the same code drives the
 * real pipeline in `operations.compressToTargetSize`.
 */
import { cancelled as cancelledError } from './errors';

export interface TargetRung {
  /** Render resolution for the raster path (CMP-02). */
  dpi: number;
  /** JPEG quality for both the raster and the surgical path (CMP-02/03). */
  quality: number;
}

/**
 * The rungs, ordered largest expected output first.
 *
 * Both axes move together going down the ladder because they trade differently:
 * dropping DPI removes pixels (a large, reliable saving that costs sharpness),
 * dropping quality removes detail within the pixels that remain (a smaller,
 * content-dependent saving that costs fidelity). Alternating them keeps the
 * degradation legible instead of destroying resolution first and then quality.
 *
 * 150 DPI / 75% is CMP-02's default and sits deliberately in the middle, so the
 * common case of a modest target lands on or near the settings a user would have
 * picked by hand. The floor is 72 DPI / 30% — screen resolution at the lowest
 * quality the CMP-05 slider itself offers. Below that the output stops being a
 * usable document, which is the point at which the ticket says to stop and say
 * so rather than degrade further.
 */
export const TARGET_LADDER: readonly TargetRung[] = [
  { dpi: 300, quality: 0.9 },
  { dpi: 300, quality: 0.75 },
  { dpi: 200, quality: 0.75 },
  { dpi: 150, quality: 0.75 },
  { dpi: 150, quality: 0.6 },
  { dpi: 110, quality: 0.6 },
  { dpi: 110, quality: 0.45 },
  { dpi: 72, quality: 0.45 },
  { dpi: 72, quality: 0.3 }
];

/**
 * Hard cap on real render+encode passes. One floor probe plus a bisection of the
 * eight rungs above it is four; the fifth is headroom for a longer ladder, not a
 * budget to spend.
 */
export const MAX_TARGET_TRIALS = 5;

/** One completed real run, as measured on its output bytes. */
export interface TargetTrial {
  settings: TargetRung;
  /** Byte length of what that run actually produced. */
  bytes: number;
  /** True when the run's own safety net discarded a *larger* output (CMP-04). */
  keptOriginal: boolean;
}

export interface TrialOutput<T> {
  /** Whatever the caller wants to keep for the winning run (e.g. the bytes). */
  output: T;
  byteLength: number;
  keptOriginal: boolean;
}

export interface TargetSearchOutcome<T> {
  /** True when `chosen` is at or under the target. */
  reached: boolean;
  /**
   * The run to use: the highest-quality rung at or under the target, or — when
   * nothing reached it — the floor run, i.e. the smallest output available.
   * Never null; the floor rung is always run.
   */
  chosen: TargetTrial & { output: T };
  /** Every trial actually run, in the order they were run. */
  trials: TargetTrial[];
}

export interface TargetSearchOptions<T> {
  targetBytes: number;
  /** Runs the real pipeline at `settings` and measures what came out. */
  run: (settings: TargetRung, trialIndex: number) => Promise<TrialOutput<T>>;
  ladder?: readonly TargetRung[];
  maxTrials?: number;
  signal?: AbortSignal;
  /** Called before each real run, for progress reporting across trials. */
  onTrial?: (trialIndex: number, maxTrials: number, settings: TargetRung) => void;
}

/**
 * Bisects `ladder` for the highest-quality rung whose *measured* output is at or
 * under `targetBytes`.
 *
 * The ladder is assumed monotone (a lower rung produces no more bytes), which is
 * what makes a bisection sound. Real encoders are only approximately monotone,
 * so the result is never inferred from that assumption: `reached` is true only
 * because a run measured at or under the target, and the returned size is that
 * run's own byte count. A rung that measured over the target is never returned
 * as a success even if a lower rung's result suggests it "should" have fit.
 */
export async function searchForTargetSize<T>(
  options: TargetSearchOptions<T>
): Promise<TargetSearchOutcome<T>> {
  const ladder = options.ladder ?? TARGET_LADDER;
  if (ladder.length === 0) throw new Error('The target-size ladder cannot be empty');
  const budget = Math.max(1, Math.min(options.maxTrials ?? MAX_TARGET_TRIALS, ladder.length));
  const trials: TargetTrial[] = [];

  const abortCheck = () => {
    if (options.signal?.aborted) throw cancelledError();
  };

  const attempt = async (index: number): Promise<TargetTrial & { output: T }> => {
    abortCheck();
    const settings = ladder[index];
    options.onTrial?.(trials.length, budget, settings);
    const result = await options.run(settings, trials.length);
    abortCheck();
    const trial: TargetTrial = {
      settings,
      bytes: result.byteLength,
      keptOriginal: result.keptOriginal
    };
    trials.push(trial);
    return { ...trial, output: result.output };
  };

  // The floor first: the only single run that can answer "impossible" outright.
  const floor = await attempt(ladder.length - 1);
  if (floor.bytes > options.targetBytes) {
    return { reached: false, chosen: floor, trials };
  }

  let best = floor;
  let lo = 0;
  let hi = ladder.length - 2;
  while (lo <= hi && trials.length < budget) {
    const mid = (lo + hi) >> 1;
    const trial = await attempt(mid);
    if (trial.bytes <= options.targetBytes) {
      best = trial;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }

  return { reached: true, chosen: best, trials };
}
