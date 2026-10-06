/**
 * Encodes grey samples as a DeviceGray image's data. Shared by the grayscale
 * converter (`pdf/grayscale.ts`) and the render worker, which encodes images
 * and page rasters as it decodes them (PDF-5). Kept free of pdf-lib so the
 * render worker can import it without loading that library.
 */
import { zlibSync } from 'fflate';
import { encodeGrayJpeg } from './jpeg-gray';
import type { GrayMode } from './pdf/grayscale';

export interface EncodedGray {
  data: Uint8Array;
  filter: 'FlateDecode' | 'DCTDecode';
  bitsPerComponent: 1 | 8;
}

/** The JPEG quality grey images and page rasters are written at. */
export const GRAY_JPEG_QUALITY = 0.85;

/** 8-bit 0/255 samples → 1-bit rows (1 = white, as DeviceGray 1bpc reads). */
export function packOneBit(gray: Uint8Array, width: number, height: number): Uint8Array {
  const rowBytes = Math.ceil(width / 8);
  const out = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (gray[y * width + x] >= 128) out[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return out;
}

/**
 * 1-bit Flate in `bw` mode, JPEG where the original was lossy (or for a page
 * raster), otherwise 8-bit Flate.
 */
export function encodeGraySamples(
  gray: Uint8Array,
  width: number,
  height: number,
  mode: GrayMode,
  lossy: boolean,
  quality = GRAY_JPEG_QUALITY
): EncodedGray {
  if (mode === 'bw') {
    return {
      data: zlibSync(packOneBit(gray, width, height)),
      filter: 'FlateDecode',
      bitsPerComponent: 1
    };
  }
  if (lossy) {
    return {
      data: encodeGrayJpeg(gray, width, height, { quality }),
      filter: 'DCTDecode',
      bitsPerComponent: 8
    };
  }
  return { data: zlibSync(gray), filter: 'FlateDecode', bitsPerComponent: 8 };
}
