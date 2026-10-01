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
 * photo is sideways". The pixels that come back are already upright. A TIFF
 * page is turned by its own Orientation tag (274) in `decodeTiffPages` (IMG-9).
 */
import { corrupt, unsupported } from './errors';
import { translate } from './i18n';
import { jpegPassthrough, readJpegInfo } from './jpeg-info';

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
    // IMG-9: a scanner or camera that records "this page is sideways" in the
    // Orientation tag (274) means it — the pixels are stored as captured.
    const frame = orientFrame(
      {
        width,
        height,
        data: new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, width * height * 4)
      },
      tiffOrientation(ifd as unknown as Record<string, unknown>)
    );
    await visit.onPage(frame, i, ifds.length);
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

/* ------------------------------------------------------------------ *
 * Orientation (IMG-9)
 * ------------------------------------------------------------------ */

/**
 * Applies a TIFF/EXIF Orientation value (tag 274: 1 = upright, 2–8 = the
 * mirrors and quarter turns) so the frame comes back the way it is meant to be
 * viewed — the same thing `createImageBitmap(…, { imageOrientation:
 * 'from-image' })` does for a JPEG. 5–8 swap width and height. Values outside
 * 2..8 (absent, 1, garbage) return the frame unchanged.
 */
export function orientFrame(frame: RgbaFrame, orientation: number): RgbaFrame {
  if (!Number.isInteger(orientation) || orientation < 2 || orientation > 8) return frame;
  const { width: w, height: h, data } = frame;
  const swap = orientation >= 5;
  const outW = swap ? h : w;
  const outH = swap ? w : h;
  const out = new Uint8ClampedArray(outW * outH * 4);
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      let sx: number;
      let sy: number;
      switch (orientation) {
        case 2: // mirror horizontally
          sx = w - 1 - x;
          sy = y;
          break;
        case 3: // rotate 180°
          sx = w - 1 - x;
          sy = h - 1 - y;
          break;
        case 4: // mirror vertically
          sx = x;
          sy = h - 1 - y;
          break;
        case 5: // transpose
          sx = y;
          sy = x;
          break;
        case 6: // rotate 90° clockwise
          sx = y;
          sy = h - 1 - x;
          break;
        case 7: // transverse
          sx = w - 1 - y;
          sy = h - 1 - x;
          break;
        default: // 8: rotate 90° counter-clockwise
          sx = w - 1 - y;
          sy = x;
      }
      const from = (sy * w + sx) * 4;
      const to = (y * outW + x) * 4;
      out[to] = data[from];
      out[to + 1] = data[from + 1];
      out[to + 2] = data[from + 2];
      out[to + 3] = data[from + 3];
    }
  }
  return { width: outW, height: outH, data: out };
}

/** The Orientation tag (274) of a decoded UTIF IFD, or 1 when absent. */
export function tiffOrientation(ifd: Record<string, unknown>): number {
  const value = (ifd.t274 as number[] | undefined)?.[0];
  return typeof value === 'number' ? value : 1;
}

/* ------------------------------------------------------------------ *
 * Browser-decoded formats: what the bytes say about themselves
 * ------------------------------------------------------------------ */

/** A format every browser and upload form takes as-is. */
export type WebImageFormat = 'jpeg' | 'png' | 'gif' | 'webp';

function ascii(bytes: Uint8Array, at: number, length: number): string {
  let out = '';
  for (let i = at; i < at + length && i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

/** The format the bytes really are (by signature, never by name), or null. */
export function sniffWebImageFormat(bytes: Uint8Array): WebImageFormat | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpeg';
  }
  if (ascii(bytes, 0, 8) === '\x89PNG\r\n\x1a\n') return 'png';
  if (ascii(bytes, 0, 4) === 'GIF8') return 'gif';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'webp';
  return null;
}

/**
 * The pixel size a PNG, GIF or WebP declares in its header — as stored, before
 * any orientation — and whether it carries EXIF that a browser may rotate it
 * by. Null for JPEG (its orientation is read by `jpeg-info.ts`) and for
 * anything unrecognised or truncated.
 */
export function storedImageSize(
  bytes: Uint8Array
): { width: number; height: number; hasExif: boolean } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const format = sniffWebImageFormat(bytes);
  try {
    if (format === 'png') {
      if (ascii(bytes, 12, 4) !== 'IHDR') return null;
      let hasExif = false;
      for (let p = 8; p + 8 <= bytes.length;) {
        const length = view.getUint32(p);
        const type = ascii(bytes, p + 4, 4);
        if (type === 'eXIf') hasExif = true;
        if (type === 'IDAT' || type === 'IEND') break;
        p += 12 + length;
      }
      return { width: view.getUint32(16), height: view.getUint32(20), hasExif };
    }
    if (format === 'gif') {
      return { width: view.getUint16(6, true), height: view.getUint16(8, true), hasExif: false };
    }
    if (format === 'webp') {
      const chunk = ascii(bytes, 12, 4);
      if (chunk === 'VP8X') {
        const flags = bytes[20];
        const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
        const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
        return { width, height, hasExif: (flags & 0x08) !== 0 };
      }
      if (chunk === 'VP8 ') {
        return {
          width: view.getUint16(26, true) & 0x3fff,
          height: view.getUint16(28, true) & 0x3fff,
          hasExif: false
        };
      }
      if (chunk === 'VP8L') {
        const bits = view.getUint32(21, true);
        return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, hasExif: false };
      }
    }
  } catch {
    return null; // truncated header
  }
  return null;
}

/**
 * The pixel size an image declares before it is decoded, for the IMG-8 limit:
 * the PNG/GIF/WebP header ({@link storedImageSize}), or a JPEG's start-of-frame
 * marker (SOF0–SOF15 except DHT, JPG and DAC), found by `jpeg-info.ts`'s
 * bounds-checked segment walk. Null when nothing trustworthy is found — a
 * truncated or garbled header, no frame header before the scan, or a JPEG
 * whose height is deferred to a DNL marker (0) — so the caller falls back to
 * checking the decoded bitmap. Never throws.
 */
export function declaredImageSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (sniffWebImageFormat(bytes) === 'jpeg') {
    const info = readJpegInfo(bytes);
    return info && info.width > 0 && info.height > 0
      ? { width: info.width, height: info.height }
      : null;
  }
  const stored = storedImageSize(bytes);
  return stored ? { width: stored.width, height: stored.height } : null;
}

/**
 * How many frames (image descriptors) a GIF holds: more than one is an
 * animation, of which a still-image tool can only use the first. Counts by
 * walking the block structure; stops at the trailer or the first malformed
 * block, so a damaged file reports the frames it really has up to there.
 */
export function gifFrameCount(bytes: Uint8Array): number {
  const counter = new GifFrameCounter();
  counter.push(bytes);
  return counter.finish();
}

/**
 * Counts a GIF's image blocks from chunks of the file, holding only the chunk
 * in hand — so an animated GIF's frames can be counted straight from a `File`
 * stream without reading it into memory whole (IMG-9). A file that is not a
 * GIF counts 0; a truncated last frame whose descriptor arrived still counts.
 */
export class GifFrameCounter {
  private header: number[] = [];
  private phase: 'header' | 'block' | 'label' | 'desc' | 'sub' | 'done' = 'header';
  private skip = 0;
  private desc: number[] = [];
  private pendingFrame = false;
  private frames = 0;
  private gif = false;

  push(chunk: Uint8Array): void {
    let i = 0;
    while (i < chunk.length && this.phase !== 'done') {
      if (this.skip > 0) {
        const n = Math.min(this.skip, chunk.length - i);
        this.skip -= n;
        i += n;
        continue;
      }
      const byte = chunk[i++];
      switch (this.phase) {
        case 'header':
          this.header.push(byte);
          if (this.header.length === 13) {
            const head = new Uint8Array(this.header);
            this.gif = sniffWebImageFormat(head) === 'gif';
            if (!this.gif) {
              this.phase = 'done';
              break;
            }
            if (head[10] & 0x80) this.skip = 3 * (1 << ((head[10] & 0x07) + 1));
            this.phase = 'block';
          }
          break;
        case 'block':
          if (byte === 0x3b)
            this.phase = 'done'; // trailer
          else if (byte === 0x21) this.phase = 'label';
          else if (byte === 0x2c) {
            this.desc = [];
            this.phase = 'desc';
          } else this.phase = 'done';
          break;
        case 'label':
          this.phase = 'sub'; // the extension label byte itself
          break;
        case 'desc':
          this.desc.push(byte);
          if (this.desc.length === 9) {
            this.pendingFrame = true;
            const local = this.desc[8];
            // Local colour table, then the LZW minimum code size byte.
            this.skip = (local & 0x80 ? 3 * (1 << ((local & 0x07) + 1)) : 0) + 1;
            this.phase = 'sub';
          }
          break;
        case 'sub':
          if (byte === 0) {
            if (this.pendingFrame) this.frames++;
            this.pendingFrame = false;
            this.phase = 'block';
          } else {
            this.skip = byte;
          }
          break;
      }
    }
  }

  /** The count once the whole file (or as much of it as there is) was pushed. */
  finish(): number {
    if (!this.gif) return 0;
    if (this.pendingFrame) {
      this.frames++;
      this.pendingFrame = false;
    }
    this.phase = 'done';
    return this.frames;
  }
}

/**
 * Refuses a browser-decoded image larger than {@link MAX_RASTER_PIXELS}
 * before (from its header) and after (from the bitmap) decoding, with the same
 * message a HEIC/TIFF of that size gets (IMG-8).
 */
export function assertDrawableSize(width: number, height: number, name: string): void {
  assertFrameSize(width, height, name);
}

/**
 * IMG-1 — whether an image file, kept byte for byte, already satisfies an
 * "Image to size" request, so a re-encode that is not smaller should be
 * discarded in its favour.
 *
 * Every limit has to hold on the original as it is, not as it would be after
 * conversion:
 *  - its real format (by signature, not name) is one every browser and upload
 *    form takes — JPEG, PNG, GIF or WebP. A HEIC, a TIFF, or a file whose bytes
 *    are not what its name says must be converted, which is the request;
 *  - it is stored upright: a JPEG with orientation 1 that every viewer can
 *    decode (`jpegPassthrough`), or a PNG/GIF/WebP with no EXIF and a header
 *    size equal to the decoded one. A sideways original "fits" only in
 *    viewers that honour its tag;
 *  - its decoded size fits the longest-side box, and its byte length the target;
 *  - it is a single page (a multi-page TIFF is already excluded by format).
 */
export function imageOriginalSatisfies(
  original: Uint8Array,
  decoded: { sourceWidth: number; sourceHeight: number },
  request: { targetBytes: number | null; maxDimension: number | null }
): boolean {
  const format = sniffWebImageFormat(original);
  if (!format) return false;
  if (format === 'jpeg') {
    if (jpegPassthrough(original)?.orientation !== 1) return false;
  } else {
    const stored = storedImageSize(original);
    if (
      !stored ||
      stored.hasExif ||
      stored.width !== decoded.sourceWidth ||
      stored.height !== decoded.sourceHeight
    ) {
      return false;
    }
  }
  const fitsBox =
    request.maxDimension === null ||
    Math.max(decoded.sourceWidth, decoded.sourceHeight) <= request.maxDimension;
  const fitsTarget = request.targetBytes === null || original.byteLength <= request.targetBytes;
  return fitsBox && fitsTarget;
}
