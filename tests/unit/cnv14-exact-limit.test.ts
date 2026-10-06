/**
 * CNV-14 fix-up — one limit for an exact width × height in both "Image to
 * size" and PDF → Images (area and per side, the canvas a browser can
 * allocate), the aspect-lock driver across unlock → edit → re-lock, and the
 * source size read from the header (EXIF orientation applied) instead of a
 * full decode.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  MAX_RENDER_PIXELS,
  MAX_RENDER_SIDE,
  assertExactSizeWithinLimit,
  exactSizeLimitMessage,
  exactSizeOverLimit
} from '../../src/core/render-limits';
import { resizeToTarget, type DrawableSource } from '../../src/core/image-resize';
import { exactOutputSize } from '../../src/core/image-target';
import {
  ORIENTED_SIZE_PROBE_BYTES,
  orientedHeaderSize,
  orientedHeaderSizeOf
} from '../../src/core/raster-decode';
import {
  DEFAULT_EXACT_SIZE,
  editExactSide,
  exactOutputFor,
  exactRequest,
  exactSizeProblem,
  toggleExactLock,
  type ExactSizeSettings
} from '../../src/ui/tools/image-size/state';
import { exactSizeOverCap } from '../../src/ui/tools/convert/pdf-to-img-state';
import { canvasLib, installOffscreenCanvas } from './helpers/node-canvas';

const fixture = (name: string) => new Uint8Array(readFileSync('tests/fixtures/' + name));

beforeAll(() => installOffscreenCanvas());

/** Inserts an EXIF APP1 segment with Orientation = `orientation` right after SOI. */
function withOrientation(jpeg: Uint8Array, orientation: number): Uint8Array {
  // prettier-ignore
  const tiff = [
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, // little-endian header, IFD at 8
    0x01, 0x00, // one entry
    0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, orientation, 0x00, 0x00, 0x00, // 0x0112 SHORT
    0x00, 0x00, 0x00, 0x00 // no next IFD
  ];
  const body = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff];
  const length = body.length + 2;
  const app1 = [0xff, 0xe1, length >> 8, length & 0xff, ...body];
  return new Uint8Array([...jpeg.subarray(0, 2), ...app1, ...jpeg.subarray(2)]);
}

/** A PNG signature and IHDR declaring `width × height` — enough for the header readers. */
function pngHeader(width: number, height: number): Uint8Array {
  const out = new Uint8Array(8 + 25 + 12);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(out.buffer);
  view.setUint32(8, 13);
  out.set([0x49, 0x48, 0x44, 0x52], 12); // IHDR
  view.setUint32(16, width);
  view.setUint32(20, height);
  out.set([8, 6, 0, 0, 0], 24);
  view.setUint32(33, 0);
  out.set([0x49, 0x45, 0x4e, 0x44], 37); // IEND
  return out;
}

describe('one exact-size limit: area and per side', () => {
  it('the area limit is the render cap, inclusive', () => {
    expect(exactSizeOverLimit({ width: 8192, height: 8192 })).toBe(false);
    expect(exactSizeOverLimit({ width: 8193, height: 8192 })).toBe(true);
    // Exactly the area cap, on the longest side allowed.
    expect(MAX_RENDER_SIDE * 4096).toBe(MAX_RENDER_PIXELS);
    expect(exactSizeOverLimit({ width: MAX_RENDER_SIDE, height: 4096 })).toBe(false);
    expect(exactSizeOverLimit({ width: MAX_RENDER_SIDE, height: 4097 })).toBe(true);
    // Unlocked at the largest typeable sides: 16384² is past the area cap.
    expect(exactSizeOverLimit({ width: 16_384, height: 16_384 })).toBe(true);
    expect(exactSizeLimitMessage({ width: 16_384, height: 16_384 })).toBe(
      '16384×16384 px is larger than the 67,108,864-pixel limit a browser can draw. Choose a smaller size.'
    );
  });

  it('the side limit applies even when the area is small', () => {
    expect(exactSizeOverLimit({ width: MAX_RENDER_SIDE, height: 1 })).toBe(false);
    expect(exactSizeOverLimit({ width: MAX_RENDER_SIDE + 1, height: 1 })).toBe(true);
    expect(exactSizeOverLimit({ width: 1, height: MAX_RENDER_SIDE + 1 })).toBe(true);
    expect(exactSizeLimitMessage({ width: 1, height: 16_385 })).toBe(
      '1×16385 px has a side longer than the 16,384 px a browser can draw. Choose a smaller size.'
    );
  });

  it('a locked width on a 1:400 panorama is refused by its following side', () => {
    const output = exactOutputSize({ width: 10, height: 4000 }, { width: 100 });
    expect(output).toEqual({ width: 100, height: 40_000 });
    expect(output!.width * output!.height).toBeLessThan(MAX_RENDER_PIXELS);
    expect(exactSizeOverLimit(output!)).toBe(true);
    expect(() => assertExactSizeWithinLimit(output!)).toThrow(/has a side longer than/);
    expect(exactSizeOverCap([{ pageIndex: 2, ...output! }])?.pageIndex).toBe(2);
  });

  it('resizeToTarget refuses both before allocating a canvas', async () => {
    const panorama = canvasLib.createCanvas(10, 4000) as unknown as DrawableSource;
    await expect(
      resizeToTarget(panorama, { targetBytes: null, maxDimension: null, width: 100 })
    ).rejects.toMatchObject({
      kind: 'UnsupportedFeature',
      message: expect.stringMatching(/100×40000 px has a side longer than the 16,384 px/)
    });
    const small = canvasLib.createCanvas(20, 20) as unknown as DrawableSource;
    await expect(
      resizeToTarget(small, {
        targetBytes: null,
        maxDimension: null,
        width: 16_384,
        height: 16_384
      })
    ).rejects.toThrow(/16384×16384 px is larger than the 67,108,864-pixel limit/);
  });
});

describe('the aspect-lock driver is the side last edited', () => {
  const start: ExactSizeSettings = {
    ...DEFAULT_EXACT_SIZE,
    on: true,
    width: 1200,
    driver: 'width'
  };
  const source = { width: 1200, height: 800 };
  const output = (value: ExactSizeSettings) => exactOutputSize(source, exactRequest(value));

  it('unlock → edit the height → re-lock keeps the height exact', () => {
    let value = toggleExactLock(start, output(start));
    expect(value).toMatchObject({ lockAspect: false, width: 1200, height: 800 });
    value = editExactSide(value, 'height', 600);
    expect(value.driver).toBe('height');
    value = toggleExactLock(value, output(value));
    expect(value).toMatchObject({ lockAspect: true, driver: 'height', height: 600 });
    expect(exactRequest(value)).toEqual({ width: null, height: 600 });
    expect(output(value)).toEqual({ width: 900, height: 600 });
  });

  it('a cleared side never drives over a value on screen', () => {
    // Unlocked, the person types a height, then clears the width.
    let value = toggleExactLock(start, output(start));
    value = editExactSide(value, 'height', 600);
    value = editExactSide(value, 'width', NaN);
    value = toggleExactLock(value, output(value));
    expect(value).toMatchObject({ lockAspect: true, driver: 'height', height: 600 });
    expect(exactSizeProblem(value)).toBeNull();
  });

  it('locked edits still set the driver', () => {
    const value = editExactSide(start, 'height', 400);
    expect(exactRequest(value)).toEqual({ width: null, height: 400 });
  });

  it('exactOutputFor needs a source only when locked', () => {
    expect(exactOutputFor({ width: 300, height: 200 }, null)).toEqual({ width: 300, height: 200 });
    expect(exactOutputFor({ width: 300, height: null }, null)).toBeNull();
    expect(exactOutputFor({ width: 300, height: null }, source)).toEqual({
      width: 300,
      height: 200
    });
  });
});

describe('the source size comes from the header, oriented', () => {
  const tiny = fixture('tiny.jpg'); // stored 10 wide, 210 high

  it('a JPEG uses its frame size; orientation 6 swaps the sides', () => {
    expect(orientedHeaderSize(tiny)).toEqual({ width: 10, height: 210 });
    expect(orientedHeaderSize(withOrientation(tiny, 6))).toEqual({ width: 210, height: 10 });
    for (const orientation of [5, 7, 8]) {
      expect(orientedHeaderSize(withOrientation(tiny, orientation))).toEqual({
        width: 210,
        height: 10
      });
    }
    for (const orientation of [1, 2, 3, 4]) {
      expect(orientedHeaderSize(withOrientation(tiny, orientation))).toEqual({
        width: 10,
        height: 210
      });
    }
  });

  it('a PNG uses its IHDR; HEIC, TIFF and garbage are unknown', () => {
    expect(orientedHeaderSize(fixture('sample.png'))).toEqual({ width: 240, height: 160 });
    expect(orientedHeaderSize(pngHeader(10, 4000))).toEqual({ width: 10, height: 4000 });
    expect(orientedHeaderSize(fixture('sample.heic'))).toBeNull();
    expect(orientedHeaderSize(fixture('sample.tiff'))).toBeNull();
    expect(orientedHeaderSize(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull();
  });

  it('reads only the head of the file', async () => {
    const sideways = withOrientation(tiny, 6);
    // A file far larger than the probe: only its first 1 MB is read.
    const padded = new Uint8Array(ORIENTED_SIZE_PROBE_BYTES * 3);
    padded.set(sideways);
    let sliced: [number | undefined, number | undefined] | null = null;
    const file = new File([padded], 'big.jpg', { type: 'image/jpeg' });
    const slice = file.slice.bind(file);
    file.slice = (start?: number, end?: number) => {
      sliced = [start, end];
      return slice(start, end);
    };
    expect(await orientedHeaderSizeOf(file)).toEqual({ width: 210, height: 10 });
    expect(sliced).toEqual([0, ORIENTED_SIZE_PROBE_BYTES]);
    expect(await orientedHeaderSizeOf(new File([fixture('sample.heic')], 'a.heic'))).toBeNull();
  });
});
