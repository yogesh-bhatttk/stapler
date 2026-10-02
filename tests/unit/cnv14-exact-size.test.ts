/**
 * CNV-14 — "requested pixel dimensions are exact", "the tool says the target
 * is unreachable and by how much", and "EXIF orientation is applied before
 * resizing", measured on real JPEG encodes (Skia via the OffscreenCanvas shim)
 * and checked on the *decoded* output, not on what was asked for.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { encodeScaledJpeg, resizeToTarget, type DrawableSource } from '../../src/core/image-resize';
import {
  EXACT_SIDE_BOUNDS,
  IMAGE_FLOOR_QUALITY,
  IMAGE_QUALITY_MIN,
  exactOutputSize,
  fitWithin,
  isExactSide,
  matchesExactSize
} from '../../src/core/image-target';
import { imageOriginalSatisfies } from '../../src/core/image';
import { decodeTiffPages, sniffWebImageFormat, type RgbaFrame } from '../../src/core/raster-decode';
import { chooseSmaller } from '../../src/core/size-guard';
import {
  DEFAULT_EXACT_SIZE,
  describeTargetMiss,
  exactRequest,
  exactSizeProblem,
  imageSizeRequest,
  type ImageSizeSettings
} from '../../src/ui/tools/image-size/state';
import {
  canvasFromFile,
  canvasFromRgba,
  canvasLib,
  installOffscreenCanvas
} from './helpers/node-canvas';

const fixture = (name: string) => new Uint8Array(readFileSync('tests/fixtures/' + name));

beforeAll(() => installOffscreenCanvas());

/** Decodes an encoded result and returns its real pixel size. */
async function decodedSize(bytes: Uint8Array) {
  const image = await canvasLib.loadImage(Buffer.from(bytes));
  return { width: image.width as number, height: image.height as number };
}

/** A canvas of deterministic noise: JPEG cannot squeeze it, so targets can miss. */
function noise(width: number, height: number) {
  const data = new Uint8ClampedArray(width * height * 4);
  let seed = 12345;
  for (let i = 0; i < data.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    data[i] = (i & 3) === 3 ? 255 : (seed >>> 16) & 0xff;
  }
  return canvasFromRgba(data, width, height);
}

const asSource = (canvas: unknown) => canvas as DrawableSource;

describe('CNV-14 — exactOutputSize', () => {
  const source = { width: 240, height: 160 };

  it('uses a requested side as is and the other in proportion', () => {
    expect(exactOutputSize(source, { width: 600 })).toEqual({ width: 600, height: 400 });
    expect(exactOutputSize(source, { height: 100 })).toEqual({ width: 150, height: 100 });
    // 240×160 at width 101 → 67.33 → 67.
    expect(exactOutputSize(source, { width: 101, height: null })).toEqual({
      width: 101,
      height: 67
    });
    // Never a zero side.
    expect(exactOutputSize({ width: 10_000, height: 10 }, { width: 2 })).toEqual({
      width: 2,
      height: 1
    });
  });

  it('both sides set is exactly that size (unlocked)', () => {
    expect(exactOutputSize(source, { width: 300, height: 300 })).toEqual({
      width: 300,
      height: 300
    });
  });

  it('no usable side means no exact size', () => {
    expect(exactOutputSize(source, {})).toBeNull();
    expect(exactOutputSize(source, { width: NaN, height: null })).toBeNull();
    expect(exactOutputSize(source, { width: 0 })).toBeNull();
    expect(exactOutputSize(source, { width: 12.5 })).toBeNull();
    expect(isExactSide(EXACT_SIDE_BOUNDS.max)).toBe(true);
    expect(isExactSide(EXACT_SIDE_BOUNDS.max + 1)).toBe(false);
  });

  it('matchesExactSize is true only for the size asked for, or when none was', () => {
    expect(matchesExactSize(source, {})).toBe(true);
    expect(matchesExactSize(source, { width: 240 })).toBe(true);
    expect(matchesExactSize(source, { width: 240, height: 160 })).toBe(true);
    expect(matchesExactSize(source, { width: 240, height: 161 })).toBe(false);
    expect(matchesExactSize(source, { height: 80 })).toBe(false);
  });
});

describe('CNV-14 — requested pixel dimensions are exact, on the decoded output', () => {
  it.each([
    // [request, expected] — on sample.png, 240×160.
    [
      { width: 120, height: 120 },
      { width: 120, height: 120 }
    ], // unlocked, squashed
    [
      { width: 100, height: 37 },
      { width: 100, height: 37 }
    ], // unlocked, odd sizes
    [{ width: 101 }, { width: 101, height: 67 }], // locked on width
    [{ height: 57 }, { width: 86, height: 57 }], // locked on height
    [
      { width: 1000, height: 333 },
      { width: 1000, height: 333 }
    ], // enlarged
    [{ width: 961 }, { width: 961, height: 641 }] // enlarged, locked
  ])('%o → %o', async (dims, expected) => {
    const canvas = await canvasFromFile(fixture('sample.png'));
    for (const targetBytes of [null, 200_000]) {
      const result = await resizeToTarget(asSource(canvas), {
        targetBytes,
        maxDimension: null,
        ...dims
      });
      expect({ width: result.width, height: result.height }).toEqual(expected);
      expect(sniffWebImageFormat(result.bytes)).toBe('jpeg');
      expect(await decodedSize(result.bytes)).toEqual(expected);
      expect(result.reached).toBe(true);
    }
  });

  it('an exact size replaces the longest-side box', async () => {
    const canvas = await canvasFromFile(fixture('sample.png'));
    const result = await resizeToTarget(asSource(canvas), {
      targetBytes: null,
      maxDimension: 64,
      width: 200,
      height: 50
    });
    expect(await decodedSize(result.bytes)).toEqual({ width: 200, height: 50 });
  });

  it('the longest-side box (the ?max= path) still scales down and never enlarges', async () => {
    const canvas = await canvasFromFile(fixture('sample.png'));
    const down = await resizeToTarget(asSource(canvas), { targetBytes: null, maxDimension: 120 });
    expect(await decodedSize(down.bytes)).toEqual({ width: 120, height: 80 });
    const same = await resizeToTarget(asSource(canvas), { targetBytes: null, maxDimension: 4000 });
    expect(await decodedSize(same.bytes)).toEqual({ width: 240, height: 160 });
  });

  it('a size target at an exact size lowers only quality, never pixels', async () => {
    const canvas = noise(400, 300);
    const free = await resizeToTarget(asSource(canvas), {
      targetBytes: 20_000,
      maxDimension: null
    });
    // Without an exact size the search is free to shrink the image.
    expect(free.reached).toBe(true);
    expect(free.width).toBeLessThan(400);

    const exact = await resizeToTarget(asSource(canvas), {
      targetBytes: 20_000,
      maxDimension: null,
      width: 400,
      height: 300
    });
    expect(await decodedSize(exact.bytes)).toEqual({ width: 400, height: 300 });
    // Noise at 400×300 does not get to 20 KB at any quality: an honest miss
    // at the size asked for, measured on the bytes returned.
    expect(exact.reached).toBe(false);
    expect(exact.bytes.byteLength).toBeGreaterThan(20_000);
    expect(exact.quality).toBeLessThan(0.5);
  });

  it('a reachable target at an exact size is met below the usual 50% floor when it has to be', async () => {
    const canvas = noise(200, 150);
    const size = { width: 200, height: 150 };
    const atMin = await encodeScaledJpeg(asSource(canvas), size, IMAGE_QUALITY_MIN);
    const atFloor = await encodeScaledJpeg(asSource(canvas), size, IMAGE_FLOOR_QUALITY);
    expect(atFloor.byteLength).toBeLessThan(atMin.byteLength);
    // A target between the two: the free search would shrink the image; an
    // exact size has to reach it by quality alone, below 50%.
    const targetBytes = Math.floor((atMin.byteLength + atFloor.byteLength) / 2);
    const result = await resizeToTarget(asSource(canvas), {
      targetBytes,
      maxDimension: null,
      width: 200
    });
    expect(result.reached).toBe(true);
    expect(result.bytes.byteLength).toBeLessThanOrEqual(targetBytes);
    expect(result.quality).toBeLessThan(IMAGE_QUALITY_MIN);
    expect(result.quality).toBeGreaterThanOrEqual(IMAGE_FLOOR_QUALITY);
    expect(await decodedSize(result.bytes)).toEqual(size);
  });

  it('refuses an exact size larger than a browser can draw, before allocating it', async () => {
    const wide = noise(1000, 10);
    await expect(
      resizeToTarget(asSource(wide), { targetBytes: null, maxDimension: null, height: 16_384 })
    ).rejects.toThrow(/1638400×16384 px has a side longer than the 16,384 px/);
  });
});

describe('CNV-14 — EXIF orientation is applied before resizing', () => {
  it('a TIFF tagged Orientation = 6 is turned upright, then sized on its upright sides', async () => {
    const UTIF = (await import('utif')).default ?? (await import('utif'));
    // Stored 40×20: left half red, right half blue.
    const w = 40;
    const h = 20;
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        rgba[i] = x < w / 2 ? 255 : 0;
        rgba[i + 2] = x < w / 2 ? 0 : 255;
        rgba[i + 3] = 255;
      }
    }
    const tiff = new Uint8Array(
      (UTIF as { encodeImage: (...a: unknown[]) => ArrayBuffer }).encodeImage(rgba, w, h, {
        t274: [6]
      })
    );
    const frames: RgbaFrame[] = [];
    await decodeTiffPages(tiff, { onPage: frame => void frames.push(frame) });
    const [frame] = frames;
    expect([frame.width, frame.height]).toEqual([20, 40]);
    const upright = canvasFromRgba(frame.data, frame.width, frame.height);

    // Locked on width 50: the upright 20×40 gives 50×100. Sized on the stored
    // 40×20 it would have been 50×25.
    const result = await resizeToTarget(asSource(upright), {
      targetBytes: null,
      maxDimension: null,
      width: 50
    });
    expect(await decodedSize(result.bytes)).toEqual({ width: 50, height: 100 });
    // And the content is the right way up: red (the stored left) on top.
    const image = await canvasLib.loadImage(Buffer.from(result.bytes));
    const check = canvasLib.createCanvas(50, 100);
    const ctx = check.getContext('2d');
    ctx.drawImage(image, 0, 0);
    const top = ctx.getImageData(25, 10, 1, 1).data;
    const bottom = ctx.getImageData(25, 90, 1, 1).data;
    expect(top[0]).toBeGreaterThan(200);
    expect(top[2]).toBeLessThan(60);
    expect(bottom[2]).toBeGreaterThan(200);
    expect(bottom[0]).toBeLessThan(60);
  });
});

describe('CNV-14 — the original is kept only when it already is the size asked for', () => {
  const decide = async (dims: { width?: number | null; height?: number | null }) => {
    const original = fixture('sample.png');
    const canvas = await canvasFromFile(original);
    const source = { width: canvas.width, height: canvas.height };
    const request = { targetBytes: 5_000_000, maxDimension: null, ...dims };
    const resized = await resizeToTarget(asSource(canvas), request);
    const choice = chooseSmaller({
      originalBytes: original.byteLength,
      resultBytes: resized.bytes.byteLength,
      originalSatisfies:
        matchesExactSize(source, request) &&
        imageOriginalSatisfies(
          original,
          { sourceWidth: source.width, sourceHeight: source.height },
          request
        )
    });
    return { choice, resized, original };
  };

  it('keeps sample.png when the exact size is its own', async () => {
    expect((await decide({ width: 240, height: 160 })).choice).toBe('original');
    expect((await decide({ width: 240 })).choice).toBe('original');
  });

  it('converts when the exact size differs, even if the JPEG is the bigger file', async () => {
    const { choice, resized, original } = await decide({ width: 1200, height: 800 });
    expect(choice).not.toBe('original');
    expect(await decodedSize(resized.bytes)).toEqual({ width: 1200, height: 800 });
    // Enlarged, so the JPEG is bigger than the PNG: reported as such, not hidden.
    if (resized.bytes.byteLength > original.byteLength) expect(choice).toBe('larger');
  });
});

describe('CNV-14 — panel settings → request', () => {
  const base: ImageSizeSettings = {
    file: null,
    useTarget: false,
    target: { amount: 50, unit: 'KB' },
    maxDimension: 600
  };

  it('off (or absent, as older callers build it) leaves the longest-side box alone', () => {
    expect(imageSizeRequest(base)).toEqual({
      targetBytes: null,
      maxDimension: 600,
      width: null,
      height: null
    });
    expect(imageSizeRequest({ ...base, exact: DEFAULT_EXACT_SIZE }).maxDimension).toBe(600);
  });

  it('locked sends only the side last typed; unlocked sends both', () => {
    const exact = { ...DEFAULT_EXACT_SIZE, on: true, width: 800, height: 300 };
    expect(exactRequest({ ...exact, driver: 'width' })).toEqual({ width: 800, height: null });
    expect(exactRequest({ ...exact, driver: 'height' })).toEqual({ width: null, height: 300 });
    expect(imageSizeRequest({ ...base, exact: { ...exact, lockAspect: false } })).toEqual({
      targetBytes: null,
      maxDimension: null,
      width: 800,
      height: 300
    });
  });

  it('says what is wrong instead of running with another number', () => {
    const exact = { ...DEFAULT_EXACT_SIZE, on: true };
    expect(exactSizeProblem(exact)).toBe('missing');
    expect(exactSizeProblem({ ...exact, width: 0 })).toBe('invalid');
    expect(exactSizeProblem({ ...exact, width: 12.5 })).toBe('invalid');
    expect(exactSizeProblem({ ...exact, width: 20_000 })).toBe('invalid');
    expect(exactSizeProblem({ ...exact, width: 640 })).toBeNull();
    // Unlocked, one empty side follows the other.
    expect(exactSizeProblem({ ...exact, lockAspect: false, height: 480 })).toBeNull();
    expect(exactSizeProblem({ ...exact, on: false, width: 0 })).toBeNull();
  });
});

describe('CNV-14 — an unreachable target says by how much', () => {
  it('gives the achieved size, the target and the overshoot', () => {
    expect(describeTargetMiss(20_000, 20_400)).toEqual({
      target: '20 KB',
      achieved: '21 KB',
      over: '400 B'
    });
    // A 1-byte miss never reads as "at" the target, and the overshoot is exact.
    const tiny = describeTargetMiss(200_000, 200_001);
    expect(tiny.achieved).not.toBe(tiny.target);
    expect(tiny.over).toBe('1 B');
    // Overshoots are rounded up, never down.
    expect(describeTargetMiss(20_000, 41_001).over).toBe('22 KB');
  });

  it('on a real miss, every figure is measured on the returned bytes', async () => {
    const result = await resizeToTarget(asSource(noise(400, 300)), {
      targetBytes: 20_000,
      maxDimension: null,
      width: 400,
      height: 300
    });
    expect(result.reached).toBe(false);
    const miss = describeTargetMiss(20_000, result.bytes.byteLength);
    const overBytes = result.bytes.byteLength - 20_000;
    expect(overBytes).toBeGreaterThan(0);
    expect(miss.target).toBe('20 KB');
    expect(Number.parseFloat(miss.over)).toBeGreaterThan(0);
  });
});

it('fitWithin is unchanged for the longest-side path', () => {
  expect(fitWithin(240, 160, 120)).toEqual({ width: 120, height: 80 });
  expect(fitWithin(240, 160, null)).toEqual({ width: 240, height: 160 });
});
