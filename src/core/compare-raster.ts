/**
 * X-3, X-5, X-6 (AUDIT-2026-10-01) — the per-page pixel work behind the
 * Compare exports, as pure functions over `ImageData`.
 *
 * Pure (no DOM, no canvas) so the same code runs in the cv worker — where the
 * exports call it, one page at a time, so no page's diff, sample packing or
 * compression touches the main thread — and directly in unit tests.
 *
 * The output of a page is a {@link FlateRaster}: 8-bit RGB samples already
 * zlib-compressed, which is exactly a PDF `/FlateDecode` image stream. The
 * main thread only wraps those bytes in an image XObject
 * ({@link embedFlateRaster}); a PNG would make pdf-lib decode and re-deflate
 * every page on the main thread instead.
 */
import { zlibSync } from 'fflate';
import {
  PDFName,
  PDFNumber,
  type PDFDocument,
  type PDFPage,
  type PDFRef,
  concatTransformationMatrix,
  drawObject,
  popGraphicsState,
  pushGraphicsState
} from 'pdf-lib';
import { pixelDiff, resampleImageData } from './pixel-diff';

export { resampleImageData };

/** RGB samples, 3 bytes a pixel, rows top to bottom. */
export interface RgbRaster {
  width: number;
  height: number;
  rgb: Uint8Array;
}

/** {@link RgbRaster} samples, zlib-compressed: a ready `/FlateDecode` image stream. */
export interface FlateRaster {
  width: number;
  height: number;
  flate: Uint8Array;
}

/** The RGB samples of `img`, alpha dropped. */
export function rgbOf(img: ImageData): RgbRaster {
  const { width, height, data } = img;
  const rgb = new Uint8Array(width * height * 3);
  for (let p = 0, q = 0; p < data.length; p += 4, q += 3) {
    rgb[q] = data[p];
    rgb[q + 1] = data[p + 1];
    rgb[q + 2] = data[p + 2];
  }
  return { width, height, rgb };
}

export function deflateRaster(raster: RgbRaster): FlateRaster {
  return { width: raster.width, height: raster.height, flate: zlibSync(raster.rgb, { level: 6 }) };
}

/** Whether a `pixelDiff` overlay marks any pixel. */
function anyMarked(diff: ImageData): boolean {
  const data = diff.data;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 0) return true;
  return false;
}

/**
 * ANN-05 — one visual-diff page: the "after" page (or the "before" page when
 * there is no "after") with every pixel that differs painted red. Sized to the
 * diff overlay, else the "before" page, else the "after" page; any other
 * image is resampled to that size (X-3).
 */
export function visualDiffRaster(
  base: ImageData | undefined,
  compare: ImageData | undefined,
  sensitivity: number,
  precomputedDiff?: ImageData
): RgbRaster & { changed: boolean } {
  let diff = precomputedDiff;
  if (!diff && base && compare) diff = pixelDiff(base, compare, sensitivity);
  const width = diff?.width ?? base?.width ?? compare?.width ?? 1;
  const height = diff?.height ?? base?.height ?? compare?.height ?? 1;
  const backgroundSource = compare ?? base;
  const background = backgroundSource
    ? resampleImageData(backgroundSource, width, height)
    : undefined;
  const pixelCount = width * height;
  const rgb = new Uint8Array(pixelCount * 3);
  const bg = background?.data;
  const marks = diff && diff.width === width && diff.height === height ? diff.data : undefined;
  let changed = !base || !compare;
  for (let p = 0; p < pixelCount; p++) {
    const idx = p * 4;
    const o = p * 3;
    const isDiff =
      marks !== undefined &&
      marks[idx + 3] > 0 &&
      marks[idx] === 255 &&
      marks[idx + 1] === 0 &&
      marks[idx + 2] === 0;
    if (isDiff) {
      changed = true;
      rgb[o] = 255;
      rgb[o + 1] = 0;
      rgb[o + 2] = 0;
    } else if (bg) {
      rgb[o] = bg[idx];
      rgb[o + 1] = bg[idx + 1];
      rgb[o + 2] = bg[idx + 2];
    } else if (marks && marks[idx + 3] > 0) {
      rgb[o] = marks[idx];
      rgb[o + 1] = marks[idx + 1];
      rgb[o + 2] = marks[idx + 2];
    } else {
      rgb[o] = 255;
      rgb[o + 1] = 255;
      rgb[o + 2] = 255;
    }
  }
  return { width, height, rgb, changed };
}

/**
 * ANN-06 — whether a page pair differs. A page missing on one side, or of a
 * different size, always counts as changed; otherwise any pixel past the
 * sensitivity does.
 */
export function pagePairChanged(
  a: ImageData | undefined,
  b: ImageData | undefined,
  sensitivity: number
): boolean {
  if (!a || !b) return true;
  if (a.width !== b.width || a.height !== b.height) return true;
  return anyMarked(pixelDiff(a, b, sensitivity));
}

/** ANN-06 — one redline page pair: whether it changed, and each side's compressed pixels. */
export interface RedlinePageRaster {
  changed: boolean;
  a: FlateRaster | null;
  b: FlateRaster | null;
}

export function redlinePageRaster(
  a: ImageData | undefined,
  b: ImageData | undefined,
  sensitivity: number,
  unchangedMode: 'skip' | 'mark'
): RedlinePageRaster {
  const changed = pagePairChanged(a, b, sensitivity);
  // A skipped page's pixels are never drawn: do not spend time compressing them.
  if (!changed && unchangedMode === 'skip') return { changed, a: null, b: null };
  return {
    changed,
    a: a ? deflateRaster(rgbOf(a)) : null,
    b: b ? deflateRaster(rgbOf(b)) : null
  };
}

/** Wraps a {@link FlateRaster} in a DeviceRGB image XObject, without decoding it. */
export function embedFlateRaster(pdfDoc: PDFDocument, raster: FlateRaster): PDFRef {
  const stream = pdfDoc.context.stream(raster.flate, {
    Type: 'XObject',
    Subtype: 'Image',
    Width: raster.width,
    Height: raster.height,
    ColorSpace: 'DeviceRGB',
    BitsPerComponent: 8,
    Filter: 'FlateDecode'
  });
  // `Length` is set from the contents by pdf-lib; asserted here for clarity.
  stream.dict.set(PDFName.of('Length'), PDFNumber.of(raster.flate.length));
  return pdfDoc.context.register(stream);
}

/** Draws an embedded image XObject into `page` at `x, y` (bottom-left), `width`×`height` points. */
export function drawImageRef(
  page: PDFPage,
  image: PDFRef,
  box: { x: number; y: number; width: number; height: number }
): void {
  const name = page.node.newXObject('Im', image);
  page.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(box.width, 0, 0, box.height, box.x, box.y),
    drawObject(name),
    popGraphicsState()
  );
}
