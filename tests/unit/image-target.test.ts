/**
 * GAP-5 — the measured image size search, on real fixture images with a real
 * JPEG encoder (Skia, via @napi-rs/canvas).
 *
 * The rule under test is DOC-07's: `reached` is true only when the bytes being
 * returned measured at or under the target, the size reported is those bytes'
 * length, and when nothing fits the smallest file actually produced comes
 * back marked as a miss — never a file over the target presented as a success.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  IMAGE_FLOOR_LONG_SIDE,
  IMAGE_QUALITY_MAX,
  IMAGE_RESIZE_QUALITY,
  MAX_IMAGE_TRIALS,
  fitWithin,
  searchImageTargetSize,
  type ImageSize
} from '../../src/core/image-target';
import { resizeToTarget, type DrawableSource } from '../../src/core/image-resize';
import { createLibheif, decodeHeicToRgba, type LibHeif } from '../../src/core/raster-decode';
import { isCancellation } from '../../src/core/errors';
import {
  canvasFromFile,
  canvasFromRgba,
  installOffscreenCanvas,
  type NodeOffscreenCanvas
} from './helpers/node-canvas';

const require = createRequire(import.meta.url);
const WASM_DIR = 'node_modules/libheif-js/libheif-wasm/';

let photo: NodeOffscreenCanvas; // sample.heic, 1440×960, a real photograph
let chip: NodeOffscreenCanvas; // face-chip.png, 240×240
let tall: NodeOffscreenCanvas; // tiny.jpg, 10×210 greyscale

beforeAll(async () => {
  installOffscreenCanvas();
  const lib: LibHeif = createLibheif(
    require(`../../${WASM_DIR}libheif.js`),
    new Uint8Array(readFileSync(`${WASM_DIR}libheif.wasm`))
  );
  const frame = await decodeHeicToRgba(
    lib,
    new Uint8Array(readFileSync('tests/fixtures/sample.heic'))
  );
  photo = canvasFromRgba(frame.data, frame.width, frame.height);
  chip = await canvasFromFile(new Uint8Array(readFileSync('tests/fixtures/face-chip.png')));
  tall = await canvasFromFile(new Uint8Array(readFileSync('tests/fixtures/tiny.jpg')));
});

const asSource = (canvas: NodeOffscreenCanvas) => canvas as unknown as DrawableSource;

describe('fitWithin', () => {
  it('scales the longest side down to the box and keeps the aspect ratio', () => {
    expect(fitWithin(1440, 960, 600)).toEqual({ width: 600, height: 400 });
    expect(fitWithin(960, 1440, 600)).toEqual({ width: 400, height: 600 });
  });

  it('never enlarges, and treats null/zero as no box', () => {
    expect(fitWithin(240, 240, 1000)).toEqual({ width: 240, height: 240 });
    expect(fitWithin(240, 160, null)).toEqual({ width: 240, height: 160 });
    expect(fitWithin(240, 160, 0)).toEqual({ width: 240, height: 160 });
  });

  it('never returns a zero side', () => {
    expect(fitWithin(10, 2000, 100)).toEqual({ width: 1, height: 100 });
  });
});

describe('resizeToTarget on real images', () => {
  it('hits a portal-style 20 KB target on a 1440×960 photo, measured', async () => {
    const result = await resizeToTarget(asSource(photo), {
      targetBytes: 20_000,
      maxDimension: null
    });
    expect(result.reached).toBe(true);
    expect(result.bytes.byteLength).toBeLessThanOrEqual(20_000);
    expect(result.attempts).toBeLessThanOrEqual(MAX_IMAGE_TRIALS);
    // A real JPEG, of the size it claims.
    expect([...result.bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    expect(result.sourceWidth).toBe(1440);
    expect(result.sourceHeight).toBe(960);
    // Aspect ratio kept within rounding.
    expect(Math.abs(result.width / result.height - 1.5)).toBeLessThan(0.02);
  });

  it('lands close under the target rather than far below it', async () => {
    const target = 60_000;
    const result = await resizeToTarget(asSource(photo), {
      targetBytes: target,
      maxDimension: null
    });
    expect(result.reached).toBe(true);
    expect(result.bytes.byteLength).toBeLessThanOrEqual(target);
    // Within the bound the bisection promises: not a needlessly tiny file.
    expect(result.bytes.byteLength).toBeGreaterThan(target * 0.6);
  });

  it('is at or under the target whenever it reports reached, across targets and images', async () => {
    for (const [canvas, targets] of [
      [photo, [8_000, 15_000, 35_000, 120_000]],
      [chip, [5_000, 9_000, 20_000]]
    ] as const) {
      for (const targetBytes of targets) {
        const result = await resizeToTarget(asSource(canvas), { targetBytes, maxDimension: null });
        expect(result.reached, `${targetBytes}`).toBe(true);
        expect(result.bytes.byteLength, `${targetBytes}`).toBeLessThanOrEqual(targetBytes);
      }
    }
  });

  it('keeps every pixel when quality alone is enough', async () => {
    // Between this photo's 50% and 92% encodes: reachable without resizing.
    const full = await resizeToTarget(asSource(chip), { targetBytes: null, maxDimension: null });
    const result = await resizeToTarget(asSource(chip), {
      targetBytes: Math.round(full.bytes.byteLength * 0.9),
      maxDimension: null
    });
    expect(result.reached).toBe(true);
    expect([result.width, result.height]).toEqual([240, 240]);
    expect(result.quality).toBeLessThan(IMAGE_QUALITY_MAX);
  });

  it('uses the first, best-quality encode when the target is generous', async () => {
    const result = await resizeToTarget(asSource(chip), {
      targetBytes: 5_000_000,
      maxDimension: null
    });
    expect(result.reached).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.quality).toBe(IMAGE_QUALITY_MAX);
    expect([result.width, result.height]).toEqual([240, 240]);
  });

  it('respects the max-dimension box, with or without a size target', async () => {
    const boxed = await resizeToTarget(asSource(photo), { targetBytes: null, maxDimension: 600 });
    expect([boxed.width, boxed.height]).toEqual([600, 400]);
    expect(boxed.reached).toBe(true);
    expect(boxed.attempts).toBe(1);

    const both = await resizeToTarget(asSource(photo), { targetBytes: 15_000, maxDimension: 400 });
    expect(Math.max(both.width, both.height)).toBeLessThanOrEqual(400);
    expect(both.reached).toBe(true);
    expect(both.bytes.byteLength).toBeLessThanOrEqual(15_000);

    // A tall, narrow image boxes on its height.
    const narrow = await resizeToTarget(asSource(tall), { targetBytes: null, maxDimension: 100 });
    expect(narrow.height).toBe(100);
    expect(narrow.width).toBeGreaterThanOrEqual(1);
  });

  it('reports an unreachable target honestly, returning the smallest file it made', async () => {
    const result = await resizeToTarget(asSource(photo), { targetBytes: 300, maxDimension: null });
    expect(result.reached).toBe(false);
    expect(result.bytes.byteLength).toBeGreaterThan(300);
    // The floor: the smallest longest side the search will go to.
    expect(Math.max(result.width, result.height)).toBe(IMAGE_FLOOR_LONG_SIDE);
  });
});

describe('searchImageTargetSize — search order', () => {
  /** A deterministic encoder: bytes ∝ pixels × quality, like a real JPEG roughly is. */
  const model =
    (bytesPerPixelAtFull: number, log: Array<ImageSize & { quality: number }> = []) =>
    async (size: ImageSize, quality: number) => {
      log.push({ ...size, quality });
      const byteLength = Math.round(size.width * size.height * bytesPerPixelAtFull * quality);
      return { output: byteLength, byteLength };
    };

  it('picks the chosen trial from what was measured, never beyond the target', async () => {
    const log: Array<ImageSize & { quality: number }> = [];
    const outcome = await searchImageTargetSize({
      width: 4000,
      height: 3000,
      targetBytes: 50_000,
      maxDimension: null,
      encode: model(0.5, log)
    });
    expect(outcome.reached).toBe(true);
    expect(outcome.chosen.bytes).toBeLessThanOrEqual(50_000);
    expect(outcome.trials.length).toBe(log.length);
    expect(outcome.trials.length).toBeLessThanOrEqual(MAX_IMAGE_TRIALS);
    // Quality first, then resizing at the fixed resize quality.
    expect(log[0]).toMatchObject({ width: 4000, height: 3000, quality: IMAGE_QUALITY_MAX });
    expect(outcome.chosen.quality).toBe(IMAGE_RESIZE_QUALITY);
    // The bisection converges: the chosen size is within a few percent of the
    // largest that fits at that quality (sqrt(50000 / (0.5 × 0.6)) ≈ 408 px²).
    const ideal = Math.sqrt(50_000 / (0.5 * IMAGE_RESIZE_QUALITY * (4000 * 3000))) * 4000;
    expect(outcome.chosen.width).toBeGreaterThan(ideal * 0.95);
    expect(outcome.chosen.width).toBeLessThanOrEqual(ideal + 1);
  });

  it('respects a smaller trial budget', async () => {
    const outcome = await searchImageTargetSize({
      width: 4000,
      height: 3000,
      targetBytes: 50_000,
      maxDimension: null,
      maxTrials: 5,
      encode: model(0.5)
    });
    expect(outcome.trials.length).toBeLessThanOrEqual(5);
    expect(outcome.reached).toBe(true);
    expect(outcome.chosen.bytes).toBeLessThanOrEqual(50_000);
  });

  it('never trusts monotonicity: a lucky mid-ladder miss is not reported as a fit', async () => {
    // An encoder that is badly non-monotone in one spot.
    const encode = async (size: ImageSize, quality: number) => {
      const base = size.width * size.height * 0.5 * quality;
      const byteLength = Math.round(size.width === 2000 ? base * 10 : base);
      return { output: byteLength, byteLength };
    };
    const outcome = await searchImageTargetSize({
      width: 4000,
      height: 3000,
      targetBytes: 700_000,
      maxDimension: null,
      encode
    });
    expect(outcome.reached).toBe(true);
    expect(outcome.chosen.bytes).toBeLessThanOrEqual(700_000);
    // The inflated 2000-px rung, if it was tried, measured over and was not chosen.
    expect(outcome.chosen.width).not.toBe(2000);
  });

  it('stops with a cancellation when the signal aborts', async () => {
    const controller = new AbortController();
    let calls = 0;
    const promise = searchImageTargetSize({
      width: 1000,
      height: 1000,
      targetBytes: 10,
      maxDimension: null,
      signal: controller.signal,
      encode: async () => {
        calls++;
        controller.abort();
        return { output: 0, byteLength: 1_000_000 };
      }
    });
    await expect(promise).rejects.toSatisfy(isCancellation);
    expect(calls).toBe(1);
  });

  it('rejects a zero-sized source', async () => {
    await expect(
      searchImageTargetSize({
        width: 0,
        height: 10,
        targetBytes: 10,
        maxDimension: null,
        encode: model(1)
      })
    ).rejects.toThrow();
  });
});
