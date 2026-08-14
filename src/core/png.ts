/**
 * CNV-06 — a minimal, exact PNG writer.
 *
 * Extraction must not put pixels through a canvas: an `OffscreenCanvas` round
 * trip promotes everything to 8-bit RGBA, applies whatever colour management the
 * browser feels like, and cannot represent a 1-bit stencil or a palette at all.
 * A PDF raster image's samples are already laid out exactly the way a PNG
 * scanline wants them — big-endian, byte-aligned per row, the same bit depths
 * (1/2/4/8/16) and the same greyscale/truecolour/indexed models — so for the
 * decodable-filter path the honest "extraction" is to re-frame the *same sample
 * bytes* in a PNG container. No sample value changes; only the zlib wrapper
 * differs from the PDF's own `/FlateDecode` stream.
 *
 * Deliberately not a general PNG encoder: no interlacing, no filter heuristics
 * (every scanline is written with filter type 0, so the IDAT payload is the
 * source samples verbatim and can be checked against the PDF stream
 * byte-for-byte), and no alpha colour types — a PDF's transparency lives in a
 * separate `/SMask` object, which CNV-06 extracts as its own file rather than
 * merging in.
 */
import { zlibSync } from 'fflate';

/** Greyscale, truecolour, or palette — the three PNG colour types PDF rasters map onto. */
export type PngColorType = 0 | 2 | 3;

export interface PngImage {
  width: number;
  height: number;
  /** Bits per component/index, matching PDF's `/BitsPerComponent`. */
  bitDepth: 1 | 2 | 4 | 8 | 16;
  colorType: PngColorType;
  /**
   * Raw samples, rows byte-aligned exactly as PDF stores them (`ceil(width *
   * channels * bitDepth / 8)` bytes per row) and in the same order.
   */
  samples: Uint8Array;
  /** RGB triples, required for `colorType` 3 and ignored otherwise. */
  palette?: Uint8Array;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length + 12);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(out.length - 4, crc32(out.subarray(4, out.length - 4)));
  return out;
}

/** Channels carried per pixel by a PNG colour type. */
function channelsOf(colorType: PngColorType): number {
  return colorType === 2 ? 3 : 1;
}

/** Bytes one scanline occupies — PDF and PNG agree exactly on this formula. */
export function bytesPerRow(image: Pick<PngImage, 'width' | 'bitDepth' | 'colorType'>): number {
  return Math.ceil((image.width * channelsOf(image.colorType) * image.bitDepth) / 8);
}

/**
 * Encodes `image` as PNG bytes. Throws rather than padding or truncating when
 * `samples` is short: a half-written image file is exactly the silent corruption
 * `CLAUDE.md` forbids, so the caller reports that image as skipped instead.
 */
export function encodePng(image: PngImage): Uint8Array {
  if (image.width <= 0 || image.height <= 0) throw new Error('Image has no pixels');
  if (image.colorType === 3) {
    if (!image.palette || image.palette.length === 0) throw new Error('Palette image has no PLTE');
    if (image.bitDepth === 16) throw new Error('A palette image cannot be 16-bit');
  }

  const rowBytes = bytesPerRow(image);
  const needed = rowBytes * image.height;
  if (image.samples.length < needed) {
    throw new Error(
      `Image data is truncated: ${image.samples.length} bytes for a ${image.width}×${image.height} raster needing ${needed}`
    );
  }

  const raw = new Uint8Array((rowBytes + 1) * image.height);
  for (let y = 0; y < image.height; y++) {
    raw[y * (rowBytes + 1)] = 0; // filter type "None"
    raw.set(image.samples.subarray(y * rowBytes, (y + 1) * rowBytes), y * (rowBytes + 1) + 1);
  }

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, image.width);
  view.setUint32(4, image.height);
  ihdr[8] = image.bitDepth;
  ihdr[9] = image.colorType;
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method 0
  ihdr[12] = 0; // no interlace

  const parts: Uint8Array[] = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr)
  ];
  if (image.colorType === 3 && image.palette) parts.push(chunk('PLTE', image.palette));
  parts.push(chunk('IDAT', zlibSync(raw, { level: 6 })));
  parts.push(chunk('IEND', new Uint8Array(0)));

  const total = parts.reduce((n, part) => n + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
