/**
 * DOC-07 — the target-size search order, against synthetic measurements.
 *
 * The driver never models a size, so what is testable here is exactly what it
 * decides: which rungs it runs, in what order, how many times, which result it
 * returns, and whether it claims to have reached a target. The real byte-level
 * evidence (that the file written is at or under the target) is in
 * `tests/e2e/compress-preview.spec.ts`, where the export is measured on disk.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_TARGET_TRIALS,
  TARGET_LADDER,
  searchForTargetSize,
  type TargetRung
} from '../../src/core/compress-target';

/**
 * A monotone stand-in for the encoder: bytes fall with both DPI and quality.
 * The shape is irrelevant to the search — only the ordering is.
 */
function synthetic(scale: number) {
  return (rung: TargetRung) => Math.round(scale * rung.dpi * rung.dpi * rung.quality);
}

function runner(model: (rung: TargetRung) => number, keptOriginal = false) {
  const seen: TargetRung[] = [];
  const run = vi.fn(async (settings: TargetRung) => {
    seen.push(settings);
    return { output: settings, byteLength: model(settings), keptOriginal };
  });
  return { seen, run };
}

const FLOOR = TARGET_LADDER[TARGET_LADDER.length - 1];

describe('DOC-07: target-size search', () => {
  it('probes the floor first, so "impossible" costs one run, not five', async () => {
    const model = synthetic(1);
    const { seen, run } = runner(model);
    // Below what even the floor produces.
    const outcome = await searchForTargetSize({ targetBytes: 1, run });

    expect(seen).toEqual([FLOOR]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(outcome.reached).toBe(false);
    // It still hands back the smallest thing it made, and says what that is.
    expect(outcome.chosen.settings).toEqual(FLOOR);
    expect(outcome.chosen.bytes).toBe(model(FLOOR));
    expect(outcome.trials).toHaveLength(1);
  });

  it('lands on the highest-quality rung at or under the target', async () => {
    const model = synthetic(1);
    // Pick a target that only rungs from index 4 (150 DPI / 60%) down can meet.
    const target = model(TARGET_LADDER[4]);
    const { seen, run } = runner(model);
    const outcome = await searchForTargetSize({ targetBytes: target, run });

    expect(outcome.reached).toBe(true);
    expect(outcome.chosen.settings).toEqual(TARGET_LADDER[4]);
    expect(outcome.chosen.bytes).toBeLessThanOrEqual(target);
    // And the rung one better really would have missed — this is a boundary, not
    // an arbitrary stop.
    expect(model(TARGET_LADDER[3])).toBeGreaterThan(target);
    expect(seen.length).toBeLessThanOrEqual(MAX_TARGET_TRIALS);
  });

  it('never spends more than the trial cap, on any target across the ladder', async () => {
    const model = synthetic(1);
    for (const rung of TARGET_LADDER) {
      const { seen, run } = runner(model);
      const outcome = await searchForTargetSize({ targetBytes: model(rung), run });
      expect(seen.length).toBeLessThanOrEqual(MAX_TARGET_TRIALS);
      expect(outcome.reached).toBe(true);
      expect(outcome.chosen.bytes).toBeLessThanOrEqual(model(rung));
    }
  });

  it('reports the top rung when the target is generous, without walking down', async () => {
    const model = synthetic(1);
    const { run } = runner(model);
    const outcome = await searchForTargetSize({ targetBytes: model(TARGET_LADDER[0]), run });
    expect(outcome.chosen.settings).toEqual(TARGET_LADDER[0]);
    expect(outcome.reached).toBe(true);
  });

  it('claims success only from a measurement, never from the ladder order', async () => {
    // A deliberately non-monotone encoder: rung 3 measures *smaller* than the
    // rungs below it. The search must not promote a rung it measured over the
    // target just because a lower one fitted.
    const target = 1000;
    const sizes = new Map<TargetRung, number>(
      TARGET_LADDER.map((rung, i) => [rung, i === 3 ? 100 : 5000])
    );
    sizes.set(FLOOR, 900);
    const { run } = runner(rung => sizes.get(rung) ?? 5000);
    const outcome = await searchForTargetSize({ targetBytes: target, run });

    expect(outcome.reached).toBe(true);
    expect(outcome.chosen.bytes).toBeLessThanOrEqual(target);
    for (const trial of outcome.trials) {
      if (trial.bytes > target) expect(trial.settings).not.toEqual(outcome.chosen.settings);
    }
  });

  it('carries the per-run "kept the original" verdict through unchanged', async () => {
    const { run } = runner(synthetic(1), true);
    const outcome = await searchForTargetSize({ targetBytes: Number.MAX_SAFE_INTEGER, run });
    expect(outcome.chosen.keptOriginal).toBe(true);
    expect(outcome.trials.every(trial => trial.keptOriginal)).toBe(true);
  });

  it('cancels mid-search instead of finishing the remaining trials', async () => {
    const controller = new AbortController();
    const model = synthetic(1);
    let calls = 0;
    const run = vi.fn(async (settings: TargetRung) => {
      calls++;
      if (calls === 2) controller.abort();
      return { output: settings, byteLength: model(settings), keptOriginal: false };
    });

    await expect(
      searchForTargetSize({
        targetBytes: model(TARGET_LADDER[0]),
        run,
        signal: controller.signal
      })
    ).rejects.toMatchObject({ kind: 'UserCancelled' });
    expect(calls).toBe(2);
  });
});
