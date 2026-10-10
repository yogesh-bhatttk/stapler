/**
 * Audit 2026-10-10 — TIFF decode hardening.
 *
 * CV1: UTIF follows next-IFD (and SubIFD/EXIF/MakerNote) offsets with no
 * cycle or bounds guard; a 26-byte TIFF whose IFD points at itself ran the tab
 * out of memory. `assertTiffStructure` walks the chain first and refuses.
 * CV14: the decode cap allowed ~2.8 GB at its edge; now each frame's peak
 * decode memory is budgeted, and mirror/half-turn orientation works in place.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  MAX_DECODE_BYTES,
  MAX_TIFF_IFDS,
  assertTiffStructure,
  decodeTiffPages,
  orientFrame,
  type RgbaFrame
} from '../../src/core/raster-decode';

/** A little-endian TIFF built entry by entry: `ifds[i]` is a list of [tag, type, count, value]. */
function tiff(
  ifds: Array<Array<[number, number, number, number]>>,
  opts: { next?: (index: number, offsets: number[]) => number; tail?: number[] } = {}
): Uint8Array {
  const offsets: number[] = [];
  let at = 8;
  for (const entries of ifds) {
    offsets.push(at);
    at += 2 + entries.length * 12 + 4;
  }
  const tail = opts.tail ?? [];
  const out = new Uint8Array(at + tail.length);
  const v = new DataView(out.buffer);
  out[0] = 0x49;
  out[1] = 0x49;
  v.setUint16(2, 42, true);
  v.setUint32(4, offsets[0] ?? 0, true);
  ifds.forEach((entries, i) => {
    let p = offsets[i];
    v.setUint16(p, entries.length, true);
    p += 2;
    for (const [tag, type, count, value] of entries) {
      v.setUint16(p, tag, true);
      v.setUint16(p + 2, type, true);
      v.setUint32(p + 4, count, true);
      v.setUint32(p + 8, value, true);
      p += 12;
    }
    const next = opts.next ? opts.next(i, offsets) : i + 1 < offsets.length ? offsets[i + 1] : 0;
    v.setUint32(p, next, true);
  });
  out.set(tail, at);
  return out;
}

const decode = (bytes: Uint8Array) =>
  decodeTiffPages(bytes, { onPage: () => undefined }, 'evil.tif');

describe('CV1 — TIFF IFD chain is walked before UTIF', () => {
  it('refuses the 26-byte self-referencing TIFF (loop.tif) instead of running out of memory', async () => {
    // Byte for byte the audit's reproduction: one IFD (ImageWidth = 1) whose next-IFD is itself.
    const loop = new Uint8Array([
      0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x01, 0x03, 0x00, 0x01,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00
    ]);
    expect(loop.length).toBe(26);
    const t0 = Date.now();
    await expect(decode(loop)).rejects.toThrow(/evil\.tif is a damaged TIFF.*loop back/);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('refuses a longer cycle (IFD 3 → IFD 1)', async () => {
    const page: Array<[number, number, number, number]> = [[256, 3, 1, 1]];
    const bytes = tiff([page, page, page], { next: (i, o) => (i === 2 ? o[0] : o[i + 1]) });
    await expect(decode(bytes)).rejects.toThrow(/loop back/);
  });

  it('refuses a next-IFD pointer outside the file (UTIF reads NaN and loops forever)', async () => {
    const bytes = tiff([[[256, 3, 1, 1]]], { next: () => 0x7fff_0000 });
    await expect(decode(bytes)).rejects.toThrow(/points outside the file/);
  });

  it('refuses a truncated next-IFD pointer', async () => {
    const bytes = tiff([[[256, 3, 1, 1]]]).subarray(0, 8 + 2 + 12 + 2);
    await expect(decode(bytes)).rejects.toThrow(/runs past the end/);
  });

  it('refuses a field whose count runs past the end of the file (unbounded push)', async () => {
    const bytes = tiff([[[256, 3, 0xffff_ffff, 8]]]);
    await expect(decode(bytes)).rejects.toThrow(/field runs past the end/);
  });

  it('refuses a SubIFD (330) that points back at its own IFD', async () => {
    const bytes = tiff([
      [
        [256, 3, 1, 1],
        [330, 4, 1, 8]
      ]
    ]);
    await expect(decode(bytes)).rejects.toThrow(/loop back/);
  });

  it('refuses a Nikon MakerNote whose nested TIFF loops', async () => {
    // MakerNote bytes: "Nikon\0" + 4 bytes, then the 26-byte looping TIFF.
    const nested = [
      0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x01, 0x03, 0x00, 0x01,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00
    ];
    const note = [...'Nikon'].map(c => c.charCodeAt(0)).concat([0, 2, 0, 0, 0], nested);
    const tailAt = 8 + 2 + 2 * 12 + 4;
    const bytes = tiff(
      [
        [
          [256, 3, 1, 1],
          [37500, 7, note.length, tailAt]
        ]
      ],
      { tail: note }
    );
    await expect(decode(bytes)).rejects.toThrow(/loop back/);
  });

  it(`refuses more than ${MAX_TIFF_IFDS} IFDs`, () => {
    const page: Array<[number, number, number, number]> = [[256, 3, 1, 1]];
    const bytes = tiff(Array.from({ length: MAX_TIFF_IFDS + 1 }, () => page));
    expect(() => assertTiffStructure(bytes, 'many.tif')).toThrow(/more than 1000/);
  });

  it('refuses a BigTIFF with a clear message', () => {
    const big = new Uint8Array(16);
    big.set([0x49, 0x49, 43, 0, 8, 0, 0, 0]);
    expect(() => assertTiffStructure(big, 'big.tif')).toThrow(/BigTIFF/);
  });

  it('still decodes the real single- and multi-page fixtures', async () => {
    for (const name of ['sample.tiff', 'multipage.tiff']) {
      const bytes = new Uint8Array(readFileSync(`tests/fixtures/${name}`));
      expect(() => assertTiffStructure(bytes, name)).not.toThrow();
      const frames: RgbaFrame[] = [];
      const count = await decodeTiffPages(bytes, { onPage: f => void frames.push(f) });
      expect(count).toBeGreaterThanOrEqual(1);
      expect(frames).toHaveLength(count);
    }
  });
});

describe('CV14 — decode memory is budgeted', () => {
  const header = (w: number, h: number, bits: number[], orientation = 1) => {
    const entries: Array<[number, number, number, number]> = [
      [256, 4, 1, w],
      [257, 4, 1, h],
      [274, 3, 1, orientation],
      [277, 3, 1, bits.length]
    ];
    return entries;
  };

  it('refuses a 16-bit RGB 12000×12000 TIFF (strips + RGBA > 1 GB) before decoding', async () => {
    // t258 BitsPerSample = 16,16,16 stored out of line.
    const ifd = header(12_000, 12_000, [16, 16, 16]);
    const tailAt = 8 + 2 + (ifd.length + 1) * 12 + 4;
    ifd.push([258, 3, 3, tailAt]);
    ifd.sort((a, b) => a[0] - b[0]);
    const bytes = tiff([ifd], { tail: [16, 0, 16, 0, 16, 0] });
    // 864 MB of 16-bit strips + 576 MB of RGBA.
    await expect(decode(bytes)).rejects.toThrow(/about 1\.44 GB of memory, more than the 1 GB/);
  });

  it('refuses an 8-bit RGBA 16384×10000 page tagged Orientation 6 (two RGBA frames)', async () => {
    const ifd = header(16_384, 10_000, [8, 8, 8, 8], 6);
    expect(16_384 * 10_000 * 4 * 2).toBeGreaterThan(MAX_DECODE_BYTES);
    await expect(decode(tiff([ifd]))).rejects.toThrow(/Downscale it/);
  });

  it('mirrors and half-turns in place — no second frame is allocated', () => {
    const numbered = (): RgbaFrame => {
      const data = new Uint8ClampedArray(3 * 2 * 4);
      for (let i = 0; i < 6; i++) data[i * 4] = i;
      return { width: 3, height: 2, data };
    };
    const reds = (f: RgbaFrame) => Array.from({ length: 6 }, (_, i) => f.data[i * 4]);
    for (const [o, want] of [
      [2, [2, 1, 0, 5, 4, 3]],
      [3, [5, 4, 3, 2, 1, 0]],
      [4, [3, 4, 5, 0, 1, 2]]
    ] as const) {
      const src = numbered();
      const out = orientFrame(src, o);
      expect(out.data).toBe(src.data);
      expect(reds(out)).toEqual(want);
    }
    // An unaligned view still flips correctly (byte-wise path).
    const buf = new Uint8ClampedArray(1 + 2 * 1 * 4).subarray(1);
    buf[0] = 7;
    buf[4] = 9;
    const flipped = orientFrame({ width: 2, height: 1, data: buf }, 2);
    expect([flipped.data[0], flipped.data[4]]).toEqual([9, 7]);
  });
});
