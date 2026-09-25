/**
 * Image normalisation for CNV-01.
 *
 * Uses `createImageBitmap` rather than `<img>` + `<canvas>`: it decodes off the
 * main thread, so importing 20 phone photos does not stall the UI for seconds, and
 * `imageOrientation: 'from-image'` applies EXIF rotation — the acceptance
 * criterion that a sideways photo must not stay sideways.
 */
import {
  cancelled,
  corrupt,
  fromUnknown,
  isCancellation,
  type StaplerError,
  unsupported
} from './errors';
import { DOC_PAGE_WHITE } from './doc-colors';
import { translate } from './i18n';
import type { RasterKind } from './raster-decode';

export type { RasterKind };

const SUPPORTED = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/tiff'
]);
const SUPPORTED_EXTENSIONS = /\.(png|jpe?g|webp|gif|heic|tiff?)$/i;

export function isSupportedImage(file: File): boolean {
  // The MIME check covers browsers that report the type correctly.
  // The extension fallback is specifically for browsers that don't — e.g.,
  // macOS Safari/Chrome report type '' for HEIC — so it must not be gated on
  // the MIME type (Bug 7).
  return SUPPORTED.has(file.type) || SUPPORTED_EXTENSIONS.test(file.name);
}

/**
 * Decodes an image file and re-encodes it as JPEG.
 *
 * JPEG because the file goes straight into a PDF via `embedJpg`, and because a
 * white matte is composited first — a transparent PNG placed on a PDF page would
 * otherwise show black where the page shows through.
 */
export async function bitmapToJpeg(bitmap: ImageBitmap, quality = 0.9): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw corrupt(translate('A 2D canvas context was unavailable for image conversion.'));

  ctx.fillStyle = DOC_PAGE_WHITE;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0);

  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * The same flattening as {@link bitmapToJpeg}, encoded as PNG — the lossless
 * path for the "100% (Lossless)" import option (CONV-10). It used to be a
 * quality-1.0 JPEG, which is still DCT: text edges ring and colours shift.
 * The white matte is kept for the same reason as the JPEG path.
 */
export async function bitmapToPng(bitmap: ImageBitmap): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw corrupt(translate('A 2D canvas context was unavailable for image conversion.'));

  ctx.fillStyle = DOC_PAGE_WHITE;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0);

  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}

/** What {@link readJpegInfo} learns from a JPEG's markers without decoding it. */
export interface JpegInfo {
  width: number;
  height: number;
  /** Sample precision in bits (8 for every ordinary JPEG). */
  precision: number;
  components: number;
  /** EXIF orientation 1–8; 1 when the file has no EXIF orientation tag. */
  orientation: number;
}

/**
 * Walks a JPEG's marker segments up to the first frame header. Returns null for
 * anything that is not a well-formed JPEG up to that point.
 */
export function readJpegInfo(bytes: Uint8Array): JpegInfo | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let orientation = 1;
  let p = 2;
  while (p + 4 <= bytes.length) {
    if (bytes[p] !== 0xff) return null;
    const marker = bytes[p + 1];
    // Fill bytes and standalone markers carry no length.
    if (marker === 0xff) {
      p += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      p += 2;
      continue;
    }
    const length = (bytes[p + 2] << 8) | bytes[p + 3];
    if (length < 2 || p + 2 + length > bytes.length) return null;
    const seg = p + 4;
    if (marker === 0xe1 && length >= 16) {
      orientation = exifOrientation(bytes, seg, p + 2 + length) ?? orientation;
    }
    // SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (length < 8) return null;
      return {
        precision: bytes[seg],
        height: (bytes[seg + 1] << 8) | bytes[seg + 2],
        width: (bytes[seg + 3] << 8) | bytes[seg + 4],
        components: bytes[seg + 5],
        orientation
      };
    }
    if (marker === 0xda || marker === 0xd9) return null; // scan before any frame header
    p += 2 + length;
  }
  return null;
}

/** The orientation tag (0x0112) of an APP1 "Exif" segment, if it has one. */
function exifOrientation(b: Uint8Array, start: number, end: number): number | null {
  // "Exif\0\0" then a TIFF header.
  if (
    b[start] !== 0x45 ||
    b[start + 1] !== 0x78 ||
    b[start + 2] !== 0x69 ||
    b[start + 3] !== 0x66
  ) {
    return null;
  }
  const tiff = start + 6;
  if (tiff + 8 > end) return null;
  const little = b[tiff] === 0x49 && b[tiff + 1] === 0x49;
  if (!little && !(b[tiff] === 0x4d && b[tiff + 1] === 0x4d)) return null;
  const u16 = (o: number) => (little ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
  const u32 = (o: number) =>
    little
      ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0
      : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > end) return null;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > end) return null;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : null;
    }
  }
  return null;
}

/**
 * True when a JPEG's own bytes can go straight into the PDF (`embedJpg`) and
 * look exactly as the browser would draw them: upright (no EXIF rotation to
 * apply — pdf-lib ignores EXIF, so a rotated photo must still be re-encoded),
 * 8-bit, and grey or RGB. CMYK is excluded because pdf-lib assumes Adobe's
 * inverted CMYK, which not every producer writes. (CONV-10)
 */
export function canEmbedJpegAsIs(bytes: Uint8Array): boolean {
  const info = readJpegInfo(bytes);
  return (
    info !== null &&
    info.orientation === 1 &&
    info.precision === 8 &&
    (info.components === 1 || info.components === 3) &&
    info.width > 0 &&
    info.height > 0
  );
}

/* ------------------------------------------------------------------ *
 * HEIC and TIFF (CONV-1, CONV-16)
 * ------------------------------------------------------------------ */

/** Base wait for one HEIC/TIFF decode, plus a per-megabyte allowance, capped. */
const RASTER_TIMEOUT_BASE_MS = 20_000;
const RASTER_TIMEOUT_PER_MB_MS = 2_000;
const RASTER_TIMEOUT_MAX_MS = 120_000;

export function heicTimeoutMs(byteLength: number): number {
  return Math.min(
    RASTER_TIMEOUT_MAX_MS,
    RASTER_TIMEOUT_BASE_MS + Math.ceil(byteLength / (1024 * 1024)) * RASTER_TIMEOUT_PER_MB_MS
  );
}

/** Which worker decoder a file needs, or null for one the browser decodes itself. */
export function rasterKindOf(file: File): RasterKind | null {
  const name = file.name.toLowerCase();
  if (name.endsWith('.heic') || file.type === 'image/heic') return 'heic';
  if (name.endsWith('.tiff') || name.endsWith('.tif') || file.type === 'image/tiff') return 'tiff';
  return null;
}

export interface RasterDecodeOptions {
  signal?: AbortSignal;
  /** Overrides {@link heicTimeoutMs}; for tests. */
  timeoutMs?: number;
  onProgress?: (fraction: number | null, label: string) => void;
}

/**
 * Decodes a HEIC or TIFF in the image worker (`workers/image.worker.ts`) and
 * returns what `imagesToPdf` embeds: JPEG at `quality`, or PNG when
 * `quality >= 1`.
 *
 * The decoders are synchronous inside the worker, so cancel and the size-scaled
 * timeout *terminate* it — the decode really stops, and the next import gets a
 * fresh worker. Before CONV-1 a cancelled or hung HEIC decode (heic2any) was
 * only abandoned and kept running; TIFF decoded on the main thread.
 */
export async function decodeRasterInWorker(
  file: File,
  kind: RasterKind,
  quality: number,
  options: RasterDecodeOptions = {}
): Promise<Uint8Array[]> {
  const { signal } = options;
  if (signal?.aborted) throw cancelled();
  const [{ imageWorker }, { createJobHandle }, Comlink] = await Promise.all([
    import('./workers'),
    import('./workers/protocol'),
    import('comlink')
  ]);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (signal?.aborted) throw cancelled();

  const timeoutMs = options.timeoutMs ?? heicTimeoutMs(file.size);
  const label = kind === 'heic' ? 'HEIC' : 'TIFF';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  let stopped: StaplerError | undefined;
  const guard = new Promise<never>((_, reject) => {
    const stop = (err: StaplerError) => {
      if (stopped) return;
      stopped = err;
      reject(err);
      // Every Stapler decode is one WASM/JS call that cannot be interrupted;
      // terminating the (single-instance) pool is what actually stops it.
      imageWorker.terminate();
    };
    timer = setTimeout(
      () =>
        stop(
          unsupported(
            translate(
              'Decoding {name} did not finish within {seconds} seconds, ' +
                'so it was stopped. The {kind} file may be damaged or unusually large — convert it ' +
                'to JPEG or PNG and import that instead.',
              { name: file.name, seconds: Math.round(timeoutMs / 1000), kind: label }
            ),
            { reason: 'timeout', timeoutMs }
          )
        ),
      timeoutMs
    );
    onAbort = () => stop(cancelled());
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  guard.catch(() => {});

  const job = createJobHandle({ signal, onProgress: options.onProgress });
  try {
    return await Promise.race([
      imageWorker.lease(api =>
        api.decodeToPdfImages(
          kind,
          Comlink.transfer(bytes, [bytes.buffer as ArrayBuffer]),
          quality,
          file.name,
          job
        )
      ),
      guard
    ]);
  } catch (err) {
    // The lease rejects with "worker crashed" once `stop` terminated it; the
    // reason it was stopped is the real error.
    if (stopped) throw stopped;
    if (isCancellation(err)) throw cancelled();
    const e = fromUnknown(err);
    if (e.kind === 'UnsupportedFeature' || e.kind === 'CorruptDocument') throw e;
    throw corrupt(
      translate('Failed to decode {kind} file {name}: {message}', {
        kind: label,
        name: file.name,
        message: e.message
      })
    );
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Decodes an image file into bytes `imagesToPdf` can embed: JPEG, or PNG on
 * the lossless path.
 *
 * HEIC and TIFF decode in the image worker ({@link decodeRasterInWorker}).
 * PNG/JPEG/WebP/GIF go through `createImageBitmap`, which decodes off the main
 * thread already and applies EXIF orientation.
 *
 * At `quality >= 1` ("100% (Lossless)") nothing lossy happens (CONV-10): an
 * upright 8-bit grey/RGB JPEG is passed through byte for byte, and everything
 * else — PNG, WebP, GIF, TIFF, HEIC, or a JPEG whose EXIF rotation has to be
 * applied — is decoded (with orientation) and written as PNG. Below 1 the
 * image is re-encoded as JPEG at that quality, as before.
 */
export async function imageFileToPdfImages(
  file: File,
  quality = 0.9,
  signal?: AbortSignal
): Promise<Uint8Array[]> {
  const lossless = quality >= 1;
  const kind = rasterKindOf(file);
  if (kind) return decodeRasterInWorker(file, kind, quality, { signal });

  if (signal?.aborted) throw cancelled();
  if (lossless) {
    const original = new Uint8Array(await file.arrayBuffer());
    if (canEmbedJpegAsIs(original)) return [original];
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (err) {
    throw corrupt(
      translate('{name} could not be decoded as an image: {message}', {
        name: file.name,
        message: err instanceof Error ? err.message : String(err)
      })
    );
  }
  try {
    return [lossless ? await bitmapToPng(bitmap) : await bitmapToJpeg(bitmap, quality)];
  } finally {
    bitmap.close();
  }
}

/**
 * Trims fully transparent margins and returns a PNG with its alpha intact.
 *
 * Used for signatures (SGN-01): the acceptance criterion is that a drawn signature
 * exports with genuine alpha and no white box over coloured page content, so this
 * must never composite a background.
 */
export async function trimTransparentToPng(
  source: ImageBitmap | OffscreenCanvas,
  padding = 8
): Promise<{ png: Uint8Array; width: number; height: number } | null> {
  const width = source.width;
  const height = source.height;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(source as unknown as CanvasImageSource, 0, 0);

  const { data } = ctx.getImageData(0, 0, width, height);
  let top = height;
  let left = width;
  let right = -1;
  let bottom = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] === 0) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }

  if (right < left || bottom < top) return null; // nothing drawn

  const cropWidth = right - left + 1;
  const cropHeight = bottom - top + 1;
  const out = new OffscreenCanvas(cropWidth + padding * 2, cropHeight + padding * 2);
  const outCtx = out.getContext('2d');
  if (!outCtx) return null;
  outCtx.drawImage(
    canvas,
    left,
    top,
    cropWidth,
    cropHeight,
    padding,
    padding,
    cropWidth,
    cropHeight
  );

  const blob = await out.convertToBlob({ type: 'image/png' });
  return {
    png: new Uint8Array(await blob.arrayBuffer()),
    width: out.width,
    height: out.height
  };
}

/**
 * Turns a near-white background into real transparency, for an imported signature
 * photographed or scanned on paper (SGN-01). Pixels above `cutoff` luminance with
 * low saturation become transparent; ink is left alone.
 */
export async function removeWhiteBackground(
  bitmap: ImageBitmap,
  cutoff = 235
): Promise<OffscreenCanvas | null> {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0);

  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    // Only neutral light pixels are paper. A coloured highlight stays.
    if (min >= cutoff && max - min < 24) data[i + 3] = 0;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}
