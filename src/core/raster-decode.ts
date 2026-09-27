/**
 * HEIC and TIFF decoding to raw RGBA (CONV-1, CONV-16).
 *
 * Pure: no DOM, no canvas, no worker plumbing — `workers/image.worker.ts` runs
 * these off the main thread and encodes the result, and the unit tests run them
 * in Node against the real fixtures.
 *
 * HEIC goes through `libheif-js`'s WebAssembly build of libheif + libde265
 * (LGPL-3.0; the `.wasm` is its own lazily loaded chunk, see the image worker). It replaced
 * heic2any, whose libheif build compiles its bindings with `new Function` —
 * forbidden by both builds' CSP, so HEIC never decoded in either. This build's
 * embind glue was generated without dynamic code execution (checked: no
 * `new Function`/`eval` anywhere in `libheif-wasm/libheif.js`), so it needs only
 * `'wasm-unsafe-eval'`, which the CSP already grants.
 *
 * Orientation: libheif applies the HEIF transform properties (`irot`/`imir`/
 * `clap`) when it decodes, and reports the transformed size — which is how an
 * iPhone (and `pillow-heif`, which built `photo-rotated.heic`) records "this
 * photo is sideways". The pixels that come back are already upright.
 */
import { corrupt, unsupported } from './errors';
import { translate } from './i18n';

/** Which worker decoder an image needs (`workers/image.worker.ts`). */
export type RasterKind = 'heic' | 'tiff';

/** One decoded frame, top-to-bottom rows of RGBA, 4 bytes per pixel. */
export interface RgbaFrame {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/**
 * The largest frame decoded. Chrome's canvas area limit is 2^28 pixels, and the
 * frame is encoded through a canvas afterwards; refusing here says why instead
 * of failing later with an opaque canvas error — and before allocating 1 GB.
 */
export const MAX_RASTER_PIXELS = 16384 * 16384;

function assertFrameSize(width: number, height: number, name: string): void {
  if (!(width > 0 && height > 0)) {
    throw corrupt(
      translate('{name} has an image with no pixels, so it could not be imported.', { name })
    );
  }
  if (width * height > MAX_RASTER_PIXELS) {
    throw unsupported(
      translate(
        '{name} is {width}×{height} pixels, larger than the {limit}-pixel ' +
          'limit a browser can draw. Downscale it and import that instead.',
        { name, width, height, limit: MAX_RASTER_PIXELS.toLocaleString('en-US') }
      ),
      { width, height }
    );
  }
}

/* ------------------------------------------------------------------ *
 * HEIC
 * ------------------------------------------------------------------ */

/** The subset of `libheif-js`'s API used here (it ships no usable types). */
export interface LibHeifImage {
  get_width(): number;
  get_height(): number;
  is_primary(): boolean;
  display(
    target: { data: Uint8ClampedArray; width: number; height: number },
    callback: (result: unknown) => void
  ): void;
  free(): void;
}
export interface LibHeif {
  HeifDecoder: new () => { decode(bytes: Uint8Array): LibHeifImage[] };
}

/**
 * Boots libheif-js's Emscripten module from the `.wasm` file's bytes.
 *
 * Synchronously, by design: this build's glue binds its exports to local
 * variables the moment the factory runs, so it only works when the module is
 * instantiated inside that call (`wasmBinary`, compiled with the synchronous
 * `new WebAssembly.Module`). An asynchronous `instantiateWasm` leaves those
 * bindings undefined ("Ur is not a function"). Synchronous compilation of a
 * 1.4 MB module is fine in a worker — Chrome's 8 MB cap applies only to the
 * main thread — and this only ever runs in the image worker (and the tests).
 *
 * The factory returns the module object itself, not a promise, despite its
 * bundled `.d.ts`.
 */
export function createLibheif(factory: unknown, wasmBinary: Uint8Array): LibHeif {
  const lib = (factory as (module: { wasmBinary: Uint8Array }) => unknown)({ wasmBinary });
  if (!lib || typeof (lib as Partial<LibHeif>).HeifDecoder !== 'function') {
    throw new Error(translate('The HEIC decoder failed to start.'));
  }
  return lib as LibHeif;
}

/**
 * Decodes the primary image of a HEIC/HEIF file.
 *
 * Only the primary: an iPhone photo has exactly one top-level image, and a HEIF
 * that carries several (a burst, a sequence) marks which one it *is* — the same
 * single image heic2any returned without `multiple: true`.
 */
export async function decodeHeicToRgba(
  lib: LibHeif,
  bytes: Uint8Array,
  name = translate('This HEIC file')
): Promise<RgbaFrame> {
  const images = new lib.HeifDecoder().decode(bytes);
  if (images.length === 0) {
    throw corrupt(
      translate('{name} contains no readable image — it may be damaged or not really HEIC.', {
        name
      })
    );
  }
  const image = images.find(im => im.is_primary()) ?? images[0];
  try {
    const width = image.get_width();
    const height = image.get_height();
    assertFrameSize(width, height, name);
    const data = new Uint8ClampedArray(width * height * 4);
    const ok = await new Promise<unknown>(resolve =>
      image.display({ data, width, height }, resolve)
    );
    if (!ok)
      throw corrupt(
        translate('{name} could not be decoded — its image data is damaged.', { name })
      );
    return { width, height, data };
  } finally {
    for (const im of images) im.free();
  }
}

/* ------------------------------------------------------------------ *
 * TIFF
 * ------------------------------------------------------------------ */

/**
 * Decodes each page of a TIFF in turn and hands it to `onPage` before decoding
 * the next, so only one page's RGBA is alive at a time. `beforePage` runs before
 * each decode so the caller can cancel and report progress between pages — a
 * multi-page TIFF is the slow case this exists for. Returns the page count.
 */
export async function decodeTiffPages(
  bytes: Uint8Array,
  visit: {
    beforePage?: (index: number, count: number) => Promise<void> | void;
    onPage: (frame: RgbaFrame, index: number, count: number) => Promise<void> | void;
  },
  name = translate('This TIFF file')
): Promise<number> {
  const UTIF = await import('utif');
  // UTIF wants an ArrayBuffer that is exactly the file.
  const buffer = bytes.slice().buffer as ArrayBuffer;
  const ifds = UTIF.decode(buffer);
  if (ifds.length === 0) throw corrupt(translate('{name} contains no pages.', { name }));
  for (let i = 0; i < ifds.length; i++) {
    await visit.beforePage?.(i, ifds.length);
    const ifd = ifds[i];
    // Checked from the tags *before* decoding, so an absurd declared size is
    // refused without allocating it.
    const declaredWidth = Number((ifd.t256 as number[] | undefined)?.[0] ?? 0);
    const declaredHeight = Number((ifd.t257 as number[] | undefined)?.[0] ?? 0);
    if (declaredWidth > 0 && declaredHeight > 0) {
      assertFrameSize(declaredWidth, declaredHeight, name);
    }
    UTIF.decodeImage(buffer, ifd);
    const width = ifd.width;
    const height = ifd.height;
    assertFrameSize(width, height, name);
    const rgba = UTIF.toRGBA8(ifd);
    // The decoded strips hang off the IFD; drop them once converted.
    (ifd as { data?: unknown }).data = undefined;
    await visit.onPage(
      {
        width,
        height,
        data: new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, width * height * 4)
      },
      i,
      ifds.length
    );
  }
  return ifds.length;
}

/**
 * Composites a frame over white, in place. A transparent pixel placed on a PDF
 * page would otherwise show black where the page shows through (same reason
 * `bitmapToJpeg` paints a white matte first).
 */
export function flattenOnWhite(frame: RgbaFrame): RgbaFrame {
  const d = frame.data;
  for (let i = 3; i < d.length; i += 4) {
    const a = d[i];
    if (a === 255) continue;
    const inv = 255 - a;
    d[i - 3] = (d[i - 3] * a + 255 * inv) / 255; // Uint8ClampedArray rounds
    d[i - 2] = (d[i - 2] * a + 255 * inv) / 255;
    d[i - 1] = (d[i - 1] * a + 255 * inv) / 255;
    d[i] = 255;
  }
  return frame;
}
