/**
 * CONV-1 / CONV-16 — HEIC and TIFF decode, against the real fixtures.
 *
 * HEIC goes through the same libheif-js WASM build the image worker ships, booted
 * the same way (`createLibheif` over the binary's bytes). The pixels are checked, not just "no throw":
 * `photo-rotated.heic` is stored sideways with a rotation transform, and must come
 * out upright 400×300 with red top-left and blue bottom-right.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  createLibheif,
  decodeHeicToRgba,
  decodeTiffPages,
  flattenOnWhite,
  type LibHeif,
  type RgbaFrame
} from '../../src/core/raster-decode';

const require = createRequire(import.meta.url);
const WASM_DIR = 'node_modules/libheif-js/libheif-wasm/';

let lib: LibHeif | undefined;
async function loadLib(): Promise<LibHeif> {
  // The same synchronous `wasmBinary` boot the worker does, from the same files.
  lib ??= createLibheif(
    require(`../../${WASM_DIR}libheif.js`),
    new Uint8Array(readFileSync(`${WASM_DIR}libheif.wasm`))
  );
  return lib;
}

const px = (f: RgbaFrame, x: number, y: number) => {
  const i = (y * f.width + x) * 4;
  return [f.data[i], f.data[i + 1], f.data[i + 2], f.data[i + 3]];
};

describe('HEIC decode (CONV-1)', () => {
  it('boots from the wasm bytes and decodes sample.heic', async () => {
    const frame = await decodeHeicToRgba(
      await loadLib(),
      new Uint8Array(readFileSync('tests/fixtures/sample.heic'))
    );
    expect(frame.width).toBe(1440);
    expect(frame.height).toBe(960);
    expect(frame.data.length).toBe(1440 * 960 * 4);
    // A real photo: opaque, and not a flat fill.
    expect(px(frame, 5, 5)[3]).toBe(255);
    expect(px(frame, 5, 5)).not.toEqual(px(frame, 1434, 954));
  });

  it('applies the HEIF rotation: photo-rotated.heic comes out upright', async () => {
    const frame = await decodeHeicToRgba(
      await loadLib(),
      new Uint8Array(readFileSync('tests/fixtures/photo-rotated.heic'))
    );
    expect([frame.width, frame.height]).toEqual([400, 300]);
    const [r1, , b1] = px(frame, 20, 20);
    expect(r1).toBeGreaterThan(150);
    expect(r1 - b1).toBeGreaterThan(50);
    const [r2, , b2] = px(frame, 380, 280);
    expect(b2).toBeGreaterThan(150);
    expect(b2 - r2).toBeGreaterThan(50);
  });

  it('refuses a file that is not HEIC with a clear message', async () => {
    await expect(
      decodeHeicToRgba(
        await loadLib(),
        new Uint8Array(readFileSync('tests/fixtures/sample.png')),
        'fake.heic'
      )
    ).rejects.toThrow(/fake\.heic contains no readable image/);
  });

  it('refuses a truncated HEIC rather than returning garbage', async () => {
    const bytes = new Uint8Array(readFileSync('tests/fixtures/sample.heic'));
    await expect(
      decodeHeicToRgba(await loadLib(), bytes.subarray(0, 4096), 'cut.heic')
    ).rejects.toThrow(/cut\.heic/);
  });
});

describe('TIFF decode (CONV-16)', () => {
  it('decodes sample.tiff page by page with a checkpoint before each page', async () => {
    const before: number[] = [];
    const frames: RgbaFrame[] = [];
    const count = await decodeTiffPages(
      new Uint8Array(readFileSync('tests/fixtures/sample.tiff')),
      {
        beforePage: i => {
          before.push(i);
        },
        onPage: frame => {
          frames.push(frame);
        }
      }
    );
    expect(count).toBeGreaterThanOrEqual(1);
    expect(before).toEqual([...Array(count).keys()]);
    expect(frames[0].width).toBeGreaterThan(0);
    expect(frames[0].data.length).toBe(frames[0].width * frames[0].height * 4);
  });

  it('stops before the next page when beforePage throws (cancel)', async () => {
    const onPage: number[] = [];
    await expect(
      decodeTiffPages(new Uint8Array(readFileSync('tests/fixtures/sample.tiff')), {
        beforePage: () => {
          throw new Error('cancelled');
        },
        onPage: (_, i) => {
          onPage.push(i);
        }
      })
    ).rejects.toThrow('cancelled');
    expect(onPage).toEqual([]);
  });
});

describe('flattenOnWhite', () => {
  it('composites transparency over white and leaves opaque pixels alone', () => {
    const frame = {
      width: 3,
      height: 1,
      data: new Uint8ClampedArray([0, 0, 0, 0, 0, 0, 0, 255, 0, 0, 0, 128])
    };
    flattenOnWhite(frame);
    expect(Array.from(frame.data)).toEqual([255, 255, 255, 255, 0, 0, 0, 255, 127, 127, 127, 255]);
  });
});
