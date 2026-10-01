/**
 * HEIC and TIFF decoding off the main thread (CONV-1, CONV-16).
 *
 * Both decoders are synchronous — libheif is one WebAssembly call per image,
 * UTIF one JS call per page — so a big photo or a multi-page scan used to block
 * the main thread for seconds (TIFF) or could not run at all (HEIC: heic2any's
 * blob worker needs `eval`, which the CSP forbids). Here they run in a bundled
 * module worker, and each decoded frame is encoded to exactly what
 * `imagesToPdf` embeds: JPEG at the chosen quality, or PNG on the lossless path.
 *
 * Cancelling mid-decode cannot be cooperative (a WASM call cannot be
 * interrupted), so the main thread terminates this worker on abort or timeout
 * (`image.ts`); the pool spawns a fresh one for the next import. Between TIFF
 * pages the ordinary {@link checkpoint} applies, with determinate progress.
 */
import './network-guard'; // PLT-2: first, so it wraps the network APIs before any library runs
import * as Comlink from 'comlink';
import { loadLocale, translate } from '../i18n';
import type { LocaleAware } from './client';
import { checkpoint, releaseJobHandlesAfterCall, type JobHandle } from './protocol';
import {
  createLibheif,
  decodeHeicToRgba,
  assertDrawableSize,
  decodeTiffPages,
  flattenOnWhite,
  gifFrameCount,
  sniffWebImageFormat,
  storedImageSize,
  type LibHeif,
  type RasterKind,
  type RgbaFrame
} from '../raster-decode';
import { corrupt, internal } from '../errors';
import { encodeCanvasAtMaximum, hasTransparency } from '../max-quality';
import {
  resizeToTarget,
  type DrawableSource,
  type SizedImageRequest,
  type SizedImageResult
} from '../image-resize';

/** Which decoder a single-image resize needs: the worker's own, or the browser's. */
export type ResizeSourceKind = RasterKind | 'bitmap';

/** GAP-5 — a resized image plus what the source was. */
export interface ResizedImage extends SizedImageResult {
  /** Pages in the source; only the first is used (a multi-page TIFF). */
  sourcePages: number;
  /** Frames in the source; only the first is used (an animated GIF). */
  sourceFrames: number;
}

export interface ImageJob extends LocaleAware {
  /**
   * Decodes a HEIC (primary image) or TIFF (every page) and returns one encoded
   * image per frame: JPEG at `quality`, or at `quality >= 1` PNG/95% JPEG
   * by the `max-quality.ts` rule.
   */
  decodeToPdfImages(
    kind: RasterKind,
    bytes: Uint8Array,
    quality: number,
    name: string,
    job?: JobHandle
  ): Promise<Uint8Array[]>;
  /**
   * GAP-5 — decodes one image (HEIC/TIFF here, anything else through
   * `createImageBitmap` with EXIF orientation applied) and returns a JPEG at or
   * under `request.targetBytes` and/or within `request.maxDimension`, found by
   * the measured search in `image-target.ts`. A multi-page TIFF uses its first
   * page and says how many it had.
   */
  resizeImage(
    kind: ResizeSourceKind,
    bytes: Uint8Array,
    request: SizedImageRequest,
    name: string,
    job?: JobHandle
  ): Promise<ResizedImage>;
}

/** Thrown from inside the TIFF page loop to stop after the first page. */
const STOP_AFTER_FIRST = Symbol('stop-after-first-page');

function frameToCanvas(frame: RgbaFrame): OffscreenCanvas {
  flattenOnWhite(frame);
  const canvas = new OffscreenCanvas(frame.width, frame.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw corrupt(translate('A 2D canvas context was unavailable for image conversion.'));
  ctx.putImageData(new ImageData(frame.data, frame.width, frame.height), 0, 0);
  return canvas;
}

async function decodeForResize(
  kind: ResizeSourceKind,
  bytes: Uint8Array,
  name: string,
  job?: JobHandle
): Promise<{ source: DrawableSource; pages: number }> {
  if (kind === 'heic') {
    await checkpoint(job, 0, translate('Loading the HEIC decoder'));
    const lib = await loadLibheif();
    await checkpoint(job, 0.05, translate('Decoding {name}', { name }));
    return { source: frameToCanvas(await decodeHeicToRgba(lib, bytes, name)), pages: 1 };
  }
  if (kind === 'tiff') {
    await checkpoint(job, 0.05, translate('Decoding {name}', { name }));
    let first: OffscreenCanvas | null = null;
    let pages = 1;
    try {
      await decodeTiffPages(
        bytes,
        {
          beforePage: (i, count) => {
            pages = count;
            if (i > 0) throw STOP_AFTER_FIRST;
          },
          onPage: frame => {
            first = frameToCanvas(frame);
          }
        },
        name
      );
    } catch (err) {
      if (err !== STOP_AFTER_FIRST) throw err;
    }
    if (!first) throw corrupt(translate('{name} contains no pages.', { name }));
    return { source: first, pages };
  }
  await checkpoint(job, 0.05, translate('Decoding {name}', { name }));
  // IMG-8: refuse an image too large to draw from its header, before
  // `createImageBitmap` allocates it, and again from the bitmap itself (a
  // JPEG's size is not read here). Either way the message names the size.
  const declared = storedImageSize(bytes);
  if (declared) assertDrawableSize(declared.width, declared.height, name);
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes as BlobPart]), {
      imageOrientation: 'from-image'
    });
  } catch (err) {
    throw corrupt(
      translate('{name} could not be decoded as an image: {message}', {
        name,
        message: err instanceof Error ? err.message : String(err)
      })
    );
  }
  try {
    assertDrawableSize(bitmap.width, bitmap.height, name);
  } catch (err) {
    bitmap.close();
    throw err;
  }
  return { source: bitmap, pages: 1 };
}

let libheif: Promise<LibHeif> | undefined;

/**
 * Loads libheif on first use. The glue needs the binary's *bytes* up front
 * (see `createLibheif`), and fetching our own asset is off-limits, so the
 * `.wasm` is inlined by Vite as a `data:` URI (`?url&inline`, the same
 * mechanism `faceblur/bundledWeights.ts` uses) — in its own chunk, imported
 * only when a HEIC is actually decoded, so a TIFF import never loads it.
 */
function loadLibheif(): Promise<LibHeif> {
  libheif ??= (async () => {
    const [{ default: factory }, { default: wasmDataUrl }] = await Promise.all([
      import('libheif-js/libheif-wasm/libheif.js'),
      import('libheif-js/libheif-wasm/libheif.wasm?url&inline')
    ]);
    return createLibheif(factory, dataUrlToBytes(wasmDataUrl));
  })().catch((err: unknown) => {
    // A failed init is not cached: the next import tries again.
    libheif = undefined;
    throw err;
  });
  return libheif;
}

function dataUrlToBytes(url: string): Uint8Array {
  const comma = url.indexOf(',');
  if (!url.startsWith('data:') || !url.slice(0, comma).endsWith(';base64')) {
    throw internal('The HEIC decoder binary was not bundled inline.');
  }
  const binary = atob(url.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Encodes one decoded frame: JPEG at `quality`, or at "Maximum" (`quality >=
 * 1`) the `max-quality.ts` rule — PNG for anything with transparency or that
 * is not photographic, otherwise a 95% JPEG when it is the smaller file. HEIC
 * and TIFF pages are photographic candidates; a flat scan of text stays PNG
 * because its PNG is already small.
 */
async function encode(frame: RgbaFrame, quality: number): Promise<Uint8Array> {
  const transparent = quality >= 1 && hasTransparency(frame.data);
  flattenOnWhite(frame);
  const canvas = new OffscreenCanvas(frame.width, frame.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw corrupt(translate('A 2D canvas context was unavailable for image conversion.'));
  ctx.putImageData(new ImageData(frame.data, frame.width, frame.height), 0, 0);
  let out: Uint8Array;
  if (quality >= 1) {
    out = await encodeCanvasAtMaximum(canvas, !transparent);
  } else {
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    out = new Uint8Array(await blob.arrayBuffer());
  }
  // Release the backing store now rather than at GC: a 20-page TIFF would
  // otherwise hold every page's canvas at once.
  canvas.width = 0;
  canvas.height = 0;
  return out;
}

const api: ImageJob = {
  setLocale: loadLocale,
  async decodeToPdfImages(kind, bytes, quality, name, job) {
    const out: Uint8Array[] = [];
    if (kind === 'heic') {
      await checkpoint(job, 0, translate('Loading the HEIC decoder'));
      const lib = await loadLibheif();
      await checkpoint(job, 0.1, translate('Decoding {name}', { name }));
      const frame = await decodeHeicToRgba(lib, bytes, name);
      await checkpoint(job, 0.8, translate('Encoding {name}', { name }));
      out.push(await encode(frame, quality));
    } else {
      // Decoded and encoded page by page, so only one page's RGBA is alive at once.
      await decodeTiffPages(
        bytes,
        {
          beforePage: (i, count) =>
            checkpoint(
              job,
              i / count,
              translate('Decoding page {page} of {total}', { page: i + 1, total: count })
            ),
          onPage: async (frame, i, count) => {
            await checkpoint(
              job,
              (i + 0.5) / count,
              translate('Encoding page {page} of {total}', { page: i + 1, total: count })
            );
            out.push(await encode(frame, quality));
          }
        },
        name
      );
    }
    await checkpoint(job, 1, translate('Done'));
    return Comlink.transfer(
      out,
      out.map(b => b.buffer as ArrayBuffer)
    );
  },

  async resizeImage(kind, bytes, request, name, job) {
    // IMG-9: an animated GIF decodes to its first frame only; count the rest
    // so the result can say so rather than drop them silently.
    const frames =
      kind === 'bitmap' && sniffWebImageFormat(bytes) === 'gif' ? gifFrameCount(bytes) : 1;
    const sourceBytes = bytes.byteLength;
    const { source, pages } = await decodeForResize(kind, bytes, name, job);
    try {
      // The source's own size steers the quality search away from a "fit"
      // that is bigger than the file it came from (IMG-1).
      const result = await resizeToTarget(
        source,
        { ...request, sourceBytes },
        {
          onTrial: (index, max) =>
            checkpoint(
              job,
              0.1 + (0.85 * index) / max,
              translate('Trying size {attempt} of up to {max}', { attempt: index + 1, max })
            )
        }
      );
      await checkpoint(job, 1, translate('Done'));
      const out: ResizedImage = {
        ...result,
        sourcePages: pages,
        sourceFrames: Math.max(1, frames)
      };
      return Comlink.transfer(out, [out.bytes.buffer as ArrayBuffer]);
    } finally {
      if ('close' in source) source.close();
      else {
        source.width = 0;
        source.height = 0;
      }
    }
  }
};

Comlink.expose(releaseJobHandlesAfterCall(api));
