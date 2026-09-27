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
import { jpegPassthrough, readJpegInfo, type JpegInfo } from './jpeg-info';
import { encodeCanvasAtMaximum, webpTraits } from './max-quality';
import type { PdfImageSource } from './image-embed';
import type { Remote } from 'comlink';
import type { ImageJob, ResizedImage } from './workers/image.worker';
import type { JobHandle } from './workers/protocol';
import type { SizedImageRequest } from './image-resize';

export type { RasterKind, JpegInfo, PdfImageSource };
export { jpegPassthrough, readJpegInfo };

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
 * The same flattening as {@link bitmapToJpeg}, encoded for the "Maximum"
 * import option (CONV-10): PNG, or — for a `photographic` source whose 95%
 * JPEG is the smaller file — that JPEG (`max-quality.ts` has the rule). The
 * white matte is kept for the same reason as the JPEG path.
 */
export async function bitmapToMaximum(
  bitmap: ImageBitmap,
  photographic: boolean
): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw corrupt(translate('A 2D canvas context was unavailable for image conversion.'));

  ctx.fillStyle = DOC_PAGE_WHITE;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0);

  const out = await encodeCanvasAtMaximum(canvas, photographic);
  canvas.width = 0;
  canvas.height = 0;
  return out;
}

/**
 * True when an upright JPEG's own bytes can go straight into the PDF: see
 * {@link jpegPassthrough}, which also accepts a rotated one (the rotation is
 * then applied at placement).
 */
export function canEmbedJpegAsIs(bytes: Uint8Array): boolean {
  return jpegPassthrough(bytes)?.orientation === 1;
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
 * HEIC/TIFF decodes run one at a time, in the order they were asked for
 * (R-CONV-3). The image worker is a single instance and a stuck decode can
 * only be stopped by terminating it, so if two imports shared it, cancelling
 * (or timing out) one killed the other's decode mid-way — and the second
 * import's timeout was already running while it merely waited its turn. With
 * this queue only the decode that owns the turn is ever on the worker, so
 * terminating it touches nothing else, and each timeout starts when its own
 * decode does.
 */
let decodeQueue: Promise<void> = Promise.resolve();

/**
 * Waits for this caller's turn on the image worker and returns the function
 * that hands the turn on. An abort while still waiting rejects at once (as a
 * cancellation) without disturbing the queue or the decode that is running.
 */
async function takeDecodeTurn(signal?: AbortSignal): Promise<() => void> {
  const previous = decodeQueue;
  let release!: () => void;
  const mine = new Promise<void>(resolve => {
    release = resolve;
  });
  decodeQueue = previous.then(() => mine);
  let onAbort: (() => void) | undefined;
  try {
    await Promise.race([
      previous,
      new Promise<never>((_, reject) => {
        if (!signal) return;
        onAbort = () => reject(cancelled());
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      })
    ]);
  } catch (err) {
    release();
    throw err;
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
  return release;
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

  // The timeout below starts only once this decode owns the worker.
  const release = await takeDecodeTurn(signal);
  try {
    return await onOwnedImageWorker(
      file,
      kind === 'heic' ? 'HEIC' : 'TIFF',
      options,
      { imageWorker, createJobHandle },
      (api, job) =>
        api.decodeToPdfImages(
          kind,
          Comlink.transfer(bytes, [bytes.buffer as ArrayBuffer]),
          quality,
          file.name,
          job
        )
    );
  } finally {
    release();
  }
}

/**
 * Runs one call on the image worker this caller already owns (see
 * {@link takeDecodeTurn}), under the size-scaled timeout and the caller's
 * abort — either of which *terminates* the worker, because a WASM decode
 * cannot be interrupted. Errors other than cancellation, a timeout, or the
 * worker's own unsupported/corrupt verdicts are reported as "failed to decode".
 */
async function onOwnedImageWorker<T>(
  file: File,
  label: string,
  options: RasterDecodeOptions,
  deps: {
    imageWorker: (typeof import('./workers'))['imageWorker'];
    createJobHandle: (typeof import('./workers/protocol'))['createJobHandle'];
  },
  call: (api: Remote<ImageJob>, job: JobHandle) => Promise<T>
): Promise<T> {
  const { signal } = options;
  const { imageWorker, createJobHandle } = deps;
  if (signal?.aborted) throw cancelled();
  const timeoutMs = options.timeoutMs ?? heicTimeoutMs(file.size);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  let stopped: StaplerError | undefined;
  const guard = new Promise<never>((_, reject) => {
    const stop = (err: StaplerError) => {
      if (stopped) return;
      stopped = err;
      reject(err);
      // Every Stapler decode is one WASM/JS call that cannot be interrupted;
      // terminating the (single-instance) pool is what actually stops it —
      // and because of the decode queue, this decode is the only thing on it.
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
    return await Promise.race([imageWorker.lease(api => call(api, job)), guard]);
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

/** GAP-5 — the most a single-image resize will read into memory, in bytes. */
export const MAX_RESIZE_INPUT_BYTES = 200 * 1024 * 1024;

/**
 * GAP-5 — one image file as a JPEG at or under `request.targetBytes` and/or
 * within `request.maxDimension` on its longest side.
 *
 * Decode, the measured search and every encode run in the image worker
 * (`resizeImage`), queued behind any HEIC/TIFF import decode and stopped by
 * terminating the worker on cancel or timeout, exactly like
 * {@link decodeRasterInWorker}. The result's sizes are measured on the bytes
 * returned; `reached: false` means the smallest file the search produced is
 * still over the target.
 */
export async function resizeImageFile(
  file: File,
  request: SizedImageRequest,
  options: RasterDecodeOptions = {}
): Promise<ResizedImage> {
  const { signal } = options;
  if (signal?.aborted) throw cancelled();
  if (!isSupportedImage(file)) {
    throw unsupported(
      translate('{name} is not an image Stapler can read (JPEG, PNG, WebP, GIF, HEIC or TIFF).', {
        name: file.name
      })
    );
  }
  if (file.size > MAX_RESIZE_INPUT_BYTES) {
    throw unsupported(
      translate('{name} is larger than {size}, which is more than this tool will open.', {
        name: file.name,
        size: '200 MB'
      })
    );
  }
  const [{ imageWorker }, { createJobHandle }, Comlink] = await Promise.all([
    import('./workers'),
    import('./workers/protocol'),
    import('comlink')
  ]);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (signal?.aborted) throw cancelled();
  const kind = rasterKindOf(file) ?? 'bitmap';
  const extension = /\.([a-z0-9]+)$/i.exec(file.name)?.[1] ?? 'image';
  const label = (kind === 'bitmap' ? extension : kind).toUpperCase();

  const release = await takeDecodeTurn(signal);
  try {
    return await onOwnedImageWorker(
      file,
      label,
      // Decode plus up to MAX_IMAGE_TRIALS encodes: twice a plain decode's allowance.
      {
        ...options,
        timeoutMs:
          options.timeoutMs ?? Math.min(RASTER_TIMEOUT_MAX_MS, 2 * heicTimeoutMs(file.size))
      },
      { imageWorker, createJobHandle },
      (api, job) =>
        api.resizeImage(
          kind,
          Comlink.transfer(bytes, [bytes.buffer as ArrayBuffer]),
          request,
          file.name,
          job
        )
    );
  } finally {
    release();
  }
}

/**
 * Decodes an image file into what `imagesToPdf` embeds: encoded JPEG/PNG
 * bytes, or — at "Maximum" — a JPEG's own bytes plus the EXIF orientation to
 * apply when it is placed.
 *
 * HEIC and TIFF decode in the image worker ({@link decodeRasterInWorker}).
 * PNG/JPEG/WebP/GIF go through `createImageBitmap`, which decodes off the main
 * thread already and applies EXIF orientation.
 *
 * At `quality >= 1` ("Maximum", CONV-10):
 *  - a JPEG every viewer can decode is passed through byte for byte — upright
 *    or not; a rotation is applied by the placement matrix, and an embedded
 *    ICC profile goes into the PDF with it (`image-embed.ts`);
 *  - PNG, GIF and lossless WebP stay lossless (PNG);
 *  - a photographic source that has to be decoded (lossy WebP, a JPEG that
 *    cannot be passed through, and HEIC/TIFF in the worker) becomes a 95% JPEG
 *    when that is smaller than the PNG (`max-quality.ts`).
 * Below 1 the image is re-encoded as JPEG at that quality, as before.
 */
export async function imageFileToPdfImages(
  file: File,
  quality = 0.9,
  signal?: AbortSignal
): Promise<PdfImageSource[]> {
  const lossless = quality >= 1;
  const kind = rasterKindOf(file);
  if (kind) return decodeRasterInWorker(file, kind, quality, { signal });

  if (signal?.aborted) throw cancelled();
  let photographic = false;
  if (lossless) {
    const original = new Uint8Array(await file.arrayBuffer());
    const passthrough = jpegPassthrough(original);
    if (passthrough) {
      return [
        passthrough.orientation === 1
          ? original
          : { bytes: original, orientation: passthrough.orientation }
      ];
    }
    // A JPEG that could not be passed through is photographic by nature; a
    // WebP is when it is lossy and opaque. PNG and GIF stay lossless.
    const webp = webpTraits(original);
    photographic =
      readJpegInfo(original) !== null || (webp !== null && !webp.lossless && !webp.alpha);
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
    return [
      lossless ? await bitmapToMaximum(bitmap, photographic) : await bitmapToJpeg(bitmap, quality)
    ];
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
