/**
 * Audit 2026-10-01, image tools — IMG-1, IMG-2, IMG-8, IMG-9, IMG-10, IMG-11,
 * IMG-12, measured on real fixture bytes and real encodes wherever the code
 * under test runs in Node.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resizeToTarget, type DrawableSource } from '../../src/core/image-resize';
import {
  IMAGE_QUALITY_MAX,
  searchImageTargetSize,
  type ImageSize
} from '../../src/core/image-target';
import {
  MAX_RESIZE_INPUT_BYTES,
  imageOriginalSatisfies,
  isBrowserRenderableImage
} from '../../src/core/image';
import {
  MAX_RASTER_PIXELS,
  assertDrawableSize,
  decodeTiffPages,
  gifFrameCount,
  orientFrame,
  sniffWebImageFormat,
  storedImageSize,
  type RgbaFrame
} from '../../src/core/raster-decode';
import { chooseSmaller } from '../../src/core/size-guard';
import {
  IMAGE_TARGET_BOUNDS,
  PDF_TARGET_BOUNDS,
  convertSizeUnit,
  parseSizeParam,
  sizeParamBytes,
  validateSizeParam
} from '../../src/core/deep-link';
import { canvasFromFile, installOffscreenCanvas } from './helpers/node-canvas';

const F = 'tests/fixtures/';
const fixture = (name: string) => new Uint8Array(readFileSync(F + name));

beforeAll(() => installOffscreenCanvas());

describe('IMG-1 — never save a re-encode larger than an original that already fits', () => {
  // The audit's probe: with a generous 5 MB target (or none), PNG and WebP
  // sources re-encoded as JPEG grow, and used to be saved as "Reached".
  it.each(['sample.png', 'sample.webp', 'face-chip.png', 'tiny.jpg'])(
    '%s: the saved bytes are never larger than the original',
    async name => {
      const original = fixture(name);
      const canvas = await canvasFromFile(original);
      const decoded = { sourceWidth: canvas.width, sourceHeight: canvas.height };
      for (const targetBytes of [5_000_000, null]) {
        const request = { targetBytes, maxDimension: null };
        const resized = await resizeToTarget(canvas as unknown as DrawableSource, {
          ...request,
          sourceBytes: original.byteLength
        });
        const choice = chooseSmaller({
          originalBytes: original.byteLength,
          resultBytes: resized.bytes.byteLength,
          originalSatisfies: imageOriginalSatisfies(original, decoded, request)
        });
        const saved = choice === 'original' ? original : resized.bytes;
        expect(saved.byteLength).toBeLessThanOrEqual(original.byteLength);
      }
    }
  );

  it('the PNG and WebP of the audit are kept byte for byte', async () => {
    for (const name of ['sample.png', 'sample.webp']) {
      const original = fixture(name);
      const canvas = await canvasFromFile(original);
      const request = { targetBytes: 5_000_000, maxDimension: null };
      expect(
        imageOriginalSatisfies(
          original,
          { sourceWidth: canvas.width, sourceHeight: canvas.height },
          request
        )
      ).toBe(true);
    }
  });

  it('an original does not satisfy a request it misses in any way', async () => {
    const png = fixture('sample.png');
    const canvas = await canvasFromFile(png);
    const decoded = { sourceWidth: canvas.width, sourceHeight: canvas.height };
    // Target smaller than the file.
    expect(
      imageOriginalSatisfies(png, decoded, { targetBytes: png.byteLength - 1, maxDimension: null })
    ).toBe(false);
    // Box smaller than the image.
    const longest = Math.max(canvas.width, canvas.height);
    expect(
      imageOriginalSatisfies(png, decoded, { targetBytes: null, maxDimension: longest - 1 })
    ).toBe(false);
    // Decoded size differs from the stored one (an EXIF turn was applied).
    expect(
      imageOriginalSatisfies(
        png,
        { sourceWidth: decoded.sourceHeight + 1, sourceHeight: decoded.sourceWidth },
        { targetBytes: null, maxDimension: null }
      )
    ).toBe(false);
    // A format that has to change: HEIC and TIFF are the conversion itself.
    for (const name of ['sample.heic', 'sample.tiff']) {
      expect(
        imageOriginalSatisfies(fixture(name), decoded, { targetBytes: null, maxDimension: null })
      ).toBe(false);
    }
  });

  it('a sideways JPEG is not kept, even when it is small enough', () => {
    const jpeg = fixture('tiny.jpg');
    // Rewrite it with an EXIF APP1 carrying Orientation = 6.
    const exif = new Uint8Array([
      0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x4d, 0x4d, 0x00, 0x2a, 0x00,
      0x00, 0x00, 0x08, 0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x06,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00
    ]);
    const rotated = new Uint8Array(jpeg.byteLength + exif.byteLength);
    rotated.set(jpeg.subarray(0, 2), 0);
    rotated.set(exif, 2);
    rotated.set(jpeg.subarray(2), 2 + exif.byteLength);
    const request = { targetBytes: null, maxDimension: null };
    const decoded = { sourceWidth: 210, sourceHeight: 10 };
    expect(imageOriginalSatisfies(jpeg, { sourceWidth: 10, sourceHeight: 210 }, request)).toBe(
      true
    );
    expect(imageOriginalSatisfies(rotated, decoded, request)).toBe(false);
  });

  it('the quality search does not answer with a 92% fit that is larger than the source', async () => {
    // A synthetic, monotone encoder: bytes grow with quality.
    const encode = async (size: ImageSize, quality: number) => ({
      output: quality,
      byteLength: Math.round(size.width * size.height * quality * 0.01)
    });
    const base = { width: 1000, height: 1000, targetBytes: 5_000_000, maxDimension: null, encode };
    const plain = await searchImageTargetSize(base);
    expect(plain.chosen.quality).toBe(IMAGE_QUALITY_MAX);

    const capped = await searchImageTargetSize({ ...base, preferAtMostBytes: 7_000 });
    expect(capped.reached).toBe(true);
    expect(capped.chosen.bytes).toBeLessThanOrEqual(7_000);
    expect(capped.chosen.quality).toBeLessThan(IMAGE_QUALITY_MAX);
    // Still the full size: resolution is never traded just to beat the source.
    expect(capped.chosen.width).toBe(1000);
  });

  it('falls back to the best fit for the target when no quality beats the source', async () => {
    const encode = async (_size: ImageSize, quality: number) => ({
      output: quality,
      byteLength: 50_000 + Math.round(quality * 1000)
    });
    const outcome = await searchImageTargetSize({
      width: 800,
      height: 600,
      targetBytes: 1_000_000,
      maxDimension: null,
      preferAtMostBytes: 10_000,
      encode
    });
    expect(outcome.reached).toBe(true);
    expect(outcome.chosen.quality).toBe(IMAGE_QUALITY_MAX);
    expect(outcome.chosen.width).toBe(800);
  });
});

describe('IMG-2 / IMG-12 — target amounts', () => {
  it('converts the amount when the unit changes, so the size stays the same', () => {
    expect(convertSizeUnit({ amount: 0.5, unit: 'MB' }, 'KB')).toEqual({ amount: 500, unit: 'KB' });
    expect(convertSizeUnit({ amount: 500, unit: 'KB' }, 'MB')).toEqual({ amount: 0.5, unit: 'MB' });
    expect(convertSizeUnit({ amount: 50, unit: 'KB' }, 'KB')).toEqual({ amount: 50, unit: 'KB' });
    const there = convertSizeUnit({ amount: 1234, unit: 'KB' }, 'MB');
    expect(sizeParamBytes(there)).toBe(1_230_000);
  });

  it('reports an out-of-range or empty amount instead of replacing it', () => {
    expect(validateSizeParam({ amount: 4, unit: 'KB' }, IMAGE_TARGET_BOUNDS)).toMatchObject({
      ok: false,
      reason: 'too-small'
    });
    expect(validateSizeParam({ amount: 500, unit: 'MB' }, IMAGE_TARGET_BOUNDS)).toMatchObject({
      ok: false,
      reason: 'too-large'
    });
    expect(validateSizeParam({ amount: NaN, unit: 'KB' }, IMAGE_TARGET_BOUNDS)).toMatchObject({
      ok: false,
      reason: 'invalid'
    });
    expect(validateSizeParam({ amount: 50, unit: 'KB' }, IMAGE_TARGET_BOUNDS)).toEqual({
      ok: true,
      bytes: 50_000
    });
  });

  it('Compress uses the same bounds the deep link clamps to (IMG-12)', () => {
    // 50 B used to be accepted by the field; the link clamps to 10 KB.
    expect(validateSizeParam({ amount: 0.05, unit: 'KB' }, PDF_TARGET_BOUNDS).ok).toBe(false);
    expect(parseSizeParam('0.05KB', PDF_TARGET_BOUNDS)).toEqual({ amount: 10, unit: 'KB' });
    expect(validateSizeParam({ amount: 10, unit: 'KB' }, PDF_TARGET_BOUNDS).ok).toBe(true);
  });
});

describe('IMG-11 — byte limits and binary units', () => {
  it('the "200 MB" resize limit is 200,000,000 bytes', () => {
    expect(MAX_RESIZE_INPUT_BYTES).toBe(200_000_000);
  });

  it('KiB/MiB are scaled by 1024 and never rounded above the limit', () => {
    expect(sizeParamBytes(parseSizeParam('500KiB')!)).toBe(512_000);
    const mib = sizeParamBytes(parseSizeParam('1MiB')!);
    expect(mib).toBeLessThanOrEqual(1024 * 1024);
    expect(mib).toBeGreaterThan(1024 * 1024 - 10);
    expect(sizeParamBytes(parseSizeParam('500KB')!)).toBe(500_000);
  });
});

describe('IMG-10 — isBrowserRenderableImage', () => {
  const file = (bytes: BlobPart[], name: string, type: string) => new File(bytes, name, { type });

  it('is false for a HEIC/TIFF however it is named, and for an empty file', () => {
    const heic = fixture('sample.heic');
    expect(isBrowserRenderableImage(file([heic], 'photo.jpg', 'image/heic'))).toBe(false);
    expect(isBrowserRenderableImage(file([heic], 'photo.heic', 'image/jpeg'))).toBe(false);
    expect(isBrowserRenderableImage(file([fixture('sample.tiff')], 'scan.png', 'image/tiff'))).toBe(
      false
    );
    expect(isBrowserRenderableImage(file([], 'empty.png', 'image/png'))).toBe(false);
  });

  it('is still true for a real PNG/JPEG/WebP/GIF', () => {
    expect(isBrowserRenderableImage(file([fixture('sample.png')], 'a.png', 'image/png'))).toBe(
      true
    );
    expect(isBrowserRenderableImage(file([fixture('tiny.jpg')], 'a.jpg', ''))).toBe(true);
  });
});

describe('IMG-8 — the browser-decoded path has the pixel limit too', () => {
  it('reads PNG/WebP header sizes', async () => {
    const png = fixture('sample.png');
    const canvas = await canvasFromFile(png);
    expect(sniffWebImageFormat(png)).toBe('png');
    expect(storedImageSize(png)).toMatchObject({ width: canvas.width, height: canvas.height });
    const webp = fixture('sample.webp');
    const webpCanvas = await canvasFromFile(webp);
    expect(sniffWebImageFormat(webp)).toBe('webp');
    expect(storedImageSize(webp)).toMatchObject({
      width: webpCanvas.width,
      height: webpCanvas.height
    });
    expect(sniffWebImageFormat(fixture('sample.heic'))).toBeNull();
  });

  it('refuses a 20000×20000 image with its dimensions, before decoding it', () => {
    const png = fixture('sample.png').slice();
    const view = new DataView(png.buffer);
    view.setUint32(16, 20_000);
    view.setUint32(20, 20_000);
    const declared = storedImageSize(png)!;
    expect(declared).toMatchObject({ width: 20_000, height: 20_000 });
    expect(20_000 * 20_000).toBeGreaterThan(MAX_RASTER_PIXELS);
    let caught: unknown;
    try {
      assertDrawableSize(declared.width, declared.height, 'huge.png');
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ kind: 'UnsupportedFeature' });
    expect(String((caught as Error).message)).toContain('20000×20000');
    expect(() => assertDrawableSize(4000, 3000, 'ok.png')).not.toThrow();
  });
});

describe('IMG-9 — TIFF orientation and animated GIFs', () => {
  /** A 2×3 frame whose pixels are numbered 0..5 in the red channel. */
  const numbered = (): RgbaFrame => {
    const data = new Uint8ClampedArray(2 * 3 * 4);
    for (let i = 0; i < 6; i++) {
      data[i * 4] = i;
      data[i * 4 + 3] = 255;
    }
    return { width: 2, height: 3, data };
  };
  const reds = (f: RgbaFrame) =>
    Array.from({ length: f.width * f.height }, (_, i) => f.data[i * 4]);

  it('applies every orientation value', () => {
    // Source rows: [0 1] [2 3] [4 5]
    expect(reds(orientFrame(numbered(), 1))).toEqual([0, 1, 2, 3, 4, 5]);
    expect(reds(orientFrame(numbered(), 2))).toEqual([1, 0, 3, 2, 5, 4]);
    expect(reds(orientFrame(numbered(), 3))).toEqual([5, 4, 3, 2, 1, 0]);
    expect(reds(orientFrame(numbered(), 4))).toEqual([4, 5, 2, 3, 0, 1]);
    const six = orientFrame(numbered(), 6); // 90° clockwise
    expect([six.width, six.height]).toEqual([3, 2]);
    expect(reds(six)).toEqual([4, 2, 0, 5, 3, 1]);
    const eight = orientFrame(numbered(), 8); // 90° counter-clockwise
    expect(reds(eight)).toEqual([1, 3, 5, 0, 2, 4]);
    expect(reds(orientFrame(numbered(), 5))).toEqual([0, 2, 4, 1, 3, 5]);
    expect(reds(orientFrame(numbered(), 7))).toEqual([5, 3, 1, 4, 2, 0]);
    expect(reds(orientFrame(numbered(), 99))).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('decodeTiffPages turns a page tagged Orientation = 6 upright', async () => {
    const UTIF = (await import('utif')).default ?? (await import('utif'));
    // 4×2, left half red, right half blue.
    const w = 4;
    const h = 2;
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        rgba[i] = x < 2 ? 255 : 0;
        rgba[i + 2] = x < 2 ? 0 : 255;
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
    expect(frames).toHaveLength(1);
    const [frame] = frames;
    // Rotated 90° clockwise: 2 wide, 4 tall, red (the old left) on top.
    expect([frame.width, frame.height]).toEqual([2, 4]);
    expect(Array.from(frame.data.subarray(0, 4))).toEqual([255, 0, 0, 255]);
    const last = (frame.width * frame.height - 1) * 4;
    expect(Array.from(frame.data.subarray(last, last + 4))).toEqual([0, 0, 255, 255]);
  });

  /** A minimal GIF89a: 1×1, global table of two colours, `frames` image blocks. */
  const gif = (frames: number) => {
    const parts: number[] = [
      ...Array.from('GIF89a', c => c.charCodeAt(0)),
      1,
      0,
      1,
      0,
      0x80,
      0,
      0, // screen 1×1, global table, 2 entries
      0,
      0,
      0,
      255,
      255,
      255
    ];
    for (let i = 0; i < frames; i++) {
      parts.push(0x21, 0xf9, 4, 0, 10, 0, 0, 0); // graphic control extension
      parts.push(0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0); // image descriptor
      parts.push(2, 2, 0x44, 0x01, 0); // LZW data
    }
    parts.push(0x3b);
    return new Uint8Array(parts);
  };

  it('counts GIF frames, so an animation is reported', () => {
    expect(sniffWebImageFormat(gif(1))).toBe('gif');
    expect(gifFrameCount(gif(1))).toBe(1);
    expect(gifFrameCount(gif(3))).toBe(3);
    expect(gifFrameCount(fixture('sample.png'))).toBe(0);
    // Truncated mid-way: the frames that are there.
    const cut = gif(3).subarray(0, gif(3).length - 10);
    expect(gifFrameCount(cut)).toBeGreaterThanOrEqual(2);
  });
});
