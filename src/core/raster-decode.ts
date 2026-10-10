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
import { formatBytes, formatBytesUp } from './bytes';
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

/**
 * CV14 — the most memory one HEIC/TIFF frame may need while it is decoded in
 * the worker. {@link MAX_RASTER_PIXELS} alone allowed ~2.8 GB at its edge (a
 * TIFF's decoded strips, UTIF's RGBA copy, then the oriented copy), which
 * takes the tab down instead of refusing. 1 GB still decodes a 100 MP 8-bit
 * RGB scan with a quarter-turn Orientation tag.
 */
export const MAX_DECODE_BYTES = 1_000_000_000;

/**
 * Refuses a frame whose peak decode memory (`bytesPerPixel` over the whole
 * frame, plus `extraBytes` such as a TIFF's decoded strips) would pass
 * {@link MAX_DECODE_BYTES}, before anything that size is allocated.
 */
function assertDecodeBudget(
  width: number,
  height: number,
  bytesPerPixel: number,
  extraBytes: number,
  name: string
): void {
  const peak = width * height * bytesPerPixel + extraBytes;
  if (peak > MAX_DECODE_BYTES) {
    throw unsupported(
      translate(
        '{name} is {width}×{height} pixels; decoding it would need about {size} of ' +
          'memory, more than the {limit} Stapler allows for one image. Downscale it ' +
          'and import that instead.',
        { name, width, height, size: formatBytesUp(peak), limit: formatBytes(MAX_DECODE_BYTES) }
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
    // The RGBA target, plus libheif's own decoded planes (about 2 bytes a pixel).
    assertDecodeBudget(width, height, 6, 0, name);
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
  // CV1: UTIF has no loop or bounds guards of its own — check the structure first.
  assertTiffStructure(bytes, name);
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
    const orientation = tiffOrientation(ifd as unknown as Record<string, unknown>);
    if (declaredWidth > 0 && declaredHeight > 0) {
      assertFrameSize(declaredWidth, declaredHeight, name);
      // CV14: UTIF's decoded strips and its RGBA copy are alive together, and a
      // quarter-turn Orientation then needs a second RGBA frame (the strips are
      // dropped by then; 2–4 are turned in place).
      const bits = (ifd.t258 as number[] | undefined) ?? [
        Number((ifd.t277 as number[] | undefined)?.[0] ?? 1)
      ];
      const bitsPerPixel = bits.reduce((sum, b) => sum + Math.min(32, Number(b) || 0), 0);
      const strips = Math.ceil((declaredWidth * Math.max(1, bitsPerPixel)) / 8) * declaredHeight;
      const rgba = declaredWidth * declaredHeight * 4;
      assertDecodeBudget(
        declaredWidth,
        declaredHeight,
        0,
        Math.max(strips + rgba, orientation >= 5 && orientation <= 8 ? 2 * rgba : 0),
        name
      );
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
      orientation
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
 * 'from-image' })` does for a JPEG. 5–8 swap width and height and return a new
 * frame; 2–4 turn the given frame in place and return it. Values outside
 * 2..8 (absent, 1, garbage) return the frame unchanged.
 */
export function orientFrame(frame: RgbaFrame, orientation: number): RgbaFrame {
  if (!Number.isInteger(orientation) || orientation < 2 || orientation > 8) return frame;
  // CV14: a mirror or half turn keeps the shape, so it swaps pixels in place
  // instead of allocating a second full frame.
  if (orientation <= 4) return flipInPlace(frame, orientation !== 4, orientation !== 2);
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

/**
 * Mirrors a frame horizontally (`flipX`), vertically (`flipY`) or both (a half
 * turn), in place: each pixel is swapped with its mirror image once.
 */
function flipInPlace(frame: RgbaFrame, flipX: boolean, flipY: boolean): RgbaFrame {
  const { width: w, height: h, data } = frame;
  // One 32-bit word per pixel when the buffer allows it (UTIF's always does).
  const aligned = data.byteOffset % 4 === 0;
  const px = aligned ? new Uint32Array(data.buffer, data.byteOffset, w * h) : null;
  const swap = (i: number, j: number) => {
    if (px) {
      const t = px[i];
      px[i] = px[j];
      px[j] = t;
      return;
    }
    for (let k = 0; k < 4; k++) {
      const t = data[i * 4 + k];
      data[i * 4 + k] = data[j * 4 + k];
      data[j * 4 + k] = t;
    }
  };
  if (flipX && flipY) {
    // A half turn reverses the pixel order.
    for (let i = 0, j = w * h - 1; i < j; i++, j--) swap(i, j);
  } else if (flipX) {
    for (let y = 0; y < h; y++) {
      for (let i = y * w, j = i + w - 1; i < j; i++, j--) swap(i, j);
    }
  } else if (flipY) {
    for (let top = 0, bottom = h - 1; top < bottom; top++, bottom--) {
      for (let x = 0; x < w; x++) swap(top * w + x, bottom * w + x);
    }
  }
  return frame;
}

/** The Orientation tag (274) of a decoded UTIF IFD, or 1 when absent. */
export function tiffOrientation(ifd: Record<string, unknown>): number {
  const value = (ifd.t274 as number[] | undefined)?.[0];
  return typeof value === 'number' ? value : 1;
}

/* ------------------------------------------------------------------ *
 * TIFF structure check (CV1)
 * ------------------------------------------------------------------ */

/** More IFDs than any real TIFF holds (a 1,000-page fax is already absurd). */
export const MAX_TIFF_IFDS = 1000;
/** Nesting depth for SubIFD / EXIF / MakerNote IFDs (UTIF recurses into them). */
const MAX_TIFF_IFD_DEPTH = 8;
/** Bytes per value of the TIFF field types UTIF reads; it skips the others. */
const TIFF_TYPE_SIZE: Readonly<Record<number, number>> = {
  1: 1,
  2: 1,
  3: 2,
  4: 4,
  5: 8,
  7: 1,
  8: 2,
  9: 4,
  10: 8,
  11: 4,
  12: 8
};

/**
 * Walks every IFD `UTIF.decode` would visit — the main next-IFD chain, the
 * SubIFD (330), EXIF (34665), DNG private (50740) and MakerNote (37500) IFDs
 * it recurses into, and a Nikon MakerNote's nested TIFF — and refuses, with a
 * clear message, anything that would send UTIF into an endless loop or an
 * unbounded allocation (it has no guards of its own):
 *  - an IFD offset seen before: a chain that loops back on itself makes UTIF's
 *    `while (true)` push one IFD per lap until the tab runs out of memory (a
 *    26-byte file is enough);
 *  - an IFD, its entry table or its next-IFD pointer outside the file: UTIF
 *    reads `undefined`, gets NaN, and loops the same way;
 *  - a field whose declared count runs past the end of the file: UTIF pushes
 *    `count` values one at a time — up to four billion of them;
 *  - more than {@link MAX_TIFF_IFDS} IFDs, or nesting deeper than
 *    {@link MAX_TIFF_IFD_DEPTH}.
 * Reads the raw bytes only; nothing is allocated per entry.
 */
export function assertTiffStructure(bytes: Uint8Array, name: string): void {
  const damaged = (reason: string): never => {
    throw corrupt(
      translate('{name} is a damaged TIFF ({reason}), so it could not be imported.', {
        name,
        reason
      })
    );
  };
  const tooDeep = () => damaged(translate('its directories nest too deeply'));
  let visited = 0;

  const walkFile = (data: Uint8Array, fileDepth: number): void => {
    if (data.length < 8) damaged(translate('the file is too short'));
    // UTIF takes anything but "II" as big-endian, and never checks the magic.
    const le = data[0] === 0x49 && data[1] === 0x49;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const u16 = (at: number) => view.getUint16(at, le);
    const u32 = (at: number) => view.getUint32(at, le);
    if (fileDepth === 0) {
      if (!le && !(data[0] === 0x4d && data[1] === 0x4d)) {
        damaged(translate('no TIFF byte-order mark'));
      }
      if (u16(2) === 43) {
        throw unsupported(
          translate(
            '{name} is a BigTIFF, which Stapler cannot read. Save it as a standard TIFF and import that.',
            { name }
          )
        );
      }
      if (u16(2) !== 42) damaged(translate('no TIFF signature'));
    }
    const seen = new Set<number>();
    /** Whether UTIF would find an entry count at `offset` (else it reads NaN and stops). */
    const readable = (offset: number) => offset + 2 <= data.length;

    const readIfd = (offset: number, depth: number): number => {
      if (depth > MAX_TIFF_IFD_DEPTH) tooDeep();
      if (seen.has(offset)) damaged(translate('its page directories loop back on themselves'));
      seen.add(offset);
      if (++visited > MAX_TIFF_IFDS) {
        damaged(translate('more than {max} page directories', { max: MAX_TIFF_IFDS }));
      }
      const count = u16(offset);
      const end = offset + 2 + count * 12;
      if (end + 4 > data.length) {
        damaged(translate('a page directory runs past the end of the file'));
      }
      for (let i = 0; i < count; i++) {
        const entry = offset + 2 + i * 12;
        const tag = u16(entry);
        const type = u16(entry + 2);
        const num = u32(entry + 4);
        const voff = u32(entry + 8);
        const size = TIFF_TYPE_SIZE[type];
        if (size === undefined) continue; // UTIF skips a type it does not know
        const length = size * num;
        // Up to 4 bytes sit in the entry itself (UTIF tests the count; same thing).
        const valueAt = length <= 4 ? entry + 8 : voff;
        if (valueAt + length > data.length) {
          damaged(translate('a field runs past the end of the file'));
        }
        const values = (): number[] => {
          const out: number[] = [];
          for (let j = 0; j < num; j++) {
            if (type === 3) out.push(u16(valueAt + 2 * j));
            else if (type === 4) out.push(u32(valueAt + 4 * j));
            else if (type === 8) out.push(view.getInt16(valueAt + 2 * j, le));
            else if (type === 9) out.push(view.getInt32(valueAt + 4 * j, le));
            else if (type === 1 || type === 7) out.push(data[valueAt + j]);
          }
          return out;
        };
        if (tag === 330 || tag === 34665) {
          // UTIF takes every value as an IFD offset, whatever the field type.
          for (const sub of values()) {
            if (Number.isInteger(sub) && sub >= 0 && readable(sub)) readIfd(sub, depth + 1);
          }
        } else if (tag === 50740 && (type === 1 || type === 7) && num >= 4) {
          const sub = u32(valueAt);
          if (readable(sub) && u16(sub) < 300) readIfd(sub, depth + 1);
        } else if (tag === 37500) {
          const nikon =
            (type === 1 || type === 7) &&
            num > 10 &&
            String.fromCharCode(...data.subarray(valueAt, valueAt + 5)) === 'Nikon';
          if (nikon) {
            // UTIF decodes a Nikon MakerNote as a whole TIFF of its own.
            if (fileDepth >= MAX_TIFF_IFD_DEPTH) tooDeep();
            walkFile(data.subarray(valueAt + 10, valueAt + num), fileDepth + 1);
          } else if (readable(voff) && u16(voff) < 300) {
            readIfd(voff, depth + 1);
          }
        }
      }
      return end;
    };

    let next = u32(4);
    for (;;) {
      if (!readable(next) || next < 8) {
        damaged(translate('a page directory points outside the file'));
      }
      next = u32(readIfd(next, 0));
      if (next === 0) break;
    }
  };
  walkFile(bytes, 0);
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
 * CNV-14 — the size an image is drawn at (EXIF orientation applied, as
 * `createImageBitmap(…, { imageOrientation: 'from-image' })` does), read from
 * the head of the file without decoding it. A JPEG's start-of-frame size is
 * turned by its EXIF orientation (5–8 swap the sides); a PNG, GIF or WebP's
 * header size is used as is. Null when that is not known from the header: a
 * HEIC or TIFF (only the worker decodes those), a PNG/WebP that carries EXIF
 * a browser may rotate it by, or a header that is truncated or garbled.
 */
export function orientedHeaderSize(head: Uint8Array): { width: number; height: number } | null {
  if (sniffWebImageFormat(head) === 'jpeg') {
    const info = readJpegInfo(head);
    if (!info || !(info.width > 0) || !(info.height > 0)) return null;
    return info.orientation >= 5 && info.orientation <= 8
      ? { width: info.height, height: info.width }
      : { width: info.width, height: info.height };
  }
  const stored = storedImageSize(head);
  if (!stored || stored.hasExif || !(stored.width > 0) || !(stored.height > 0)) return null;
  return { width: stored.width, height: stored.height };
}

/**
 * How much of a file {@link orientedHeaderSizeOf} reads: as for the IMG-8
 * probe in `image.ts`, a JPEG's frame header follows the APPn segments (each
 * at most 64 KB), so 1 MB covers any real file without reading a large one.
 */
export const ORIENTED_SIZE_PROBE_BYTES = 1_000_000;

/** {@link orientedHeaderSize} of a file, reading only its head. Never throws. */
export async function orientedHeaderSizeOf(
  file: Blob
): Promise<{ width: number; height: number } | null> {
  try {
    const head = new Uint8Array(await file.slice(0, ORIENTED_SIZE_PROBE_BYTES).arrayBuffer());
    return orientedHeaderSize(head);
  } catch {
    return null;
  }
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
