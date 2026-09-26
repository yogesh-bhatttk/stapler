/**
 * The encoding rule for the image importer's "Maximum" quality (CONV-10,
 * regression review R-CONV-1). Shared by the main thread (`image.ts`, for
 * images the browser decodes) and the image worker (HEIC/TIFF), so both apply
 * one rule.
 *
 * - A JPEG never gets here when it can be embedded as-is (`jpeg-info.ts`):
 *   its original bytes are used, rotation included.
 * - A source that is itself lossless (PNG, GIF, lossless WebP), or anything
 *   with transparency, is written as PNG: nothing is lost.
 * - A *photographic* source that has been decoded — HEIC, TIFF, lossy WebP, or
 *   a JPEG that could not be passed through (CMYK, lossless/arithmetic JPEG) —
 *   is written as a 95% JPEG when that is smaller than the PNG. Writing these
 *   as PNG made a 12 MP photo about 23 MB, 2.7× the old quality-1.0 JPEG,
 *   for no visible gain over a source that was already lossy or photographic.
 *   "Photographic" is measured, not guessed: a PNG under
 *   {@link PHOTO_MIN_BITS_PER_PIXEL} bits per pixel is flat artwork, a
 *   screenshot or a scan of text, where PNG is both smaller and sharper, and
 *   stays PNG.
 */

/** JPEG quality used for photographic sources at "Maximum". */
export const MAXIMUM_JPEG_QUALITY = 0.95;

/**
 * Below this many bits per pixel as PNG an image is line art, text or flat
 * colour rather than a photograph (photographs land at 8–16 bpp as PNG).
 */
export const PHOTO_MIN_BITS_PER_PIXEL = 4;

/** Whether the 95% JPEG should be used instead of the PNG. */
export function preferJpegAtMaximum(pngBytes: number, jpegBytes: number, pixels: number): boolean {
  if (pixels <= 0) return false;
  return (pngBytes * 8) / pixels >= PHOTO_MIN_BITS_PER_PIXEL && jpegBytes < pngBytes;
}

/** True when any pixel of an RGBA buffer is not fully opaque. */
export function hasTransparency(rgba: Uint8ClampedArray | Uint8Array): boolean {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) return true;
  return false;
}

/**
 * Encodes an already flattened (opaque) canvas for "Maximum": PNG, unless
 * `photographic` and the 95% JPEG is the smaller file by the rule above.
 */
export async function encodeCanvasAtMaximum(
  canvas: OffscreenCanvas,
  photographic: boolean
): Promise<Uint8Array> {
  const png = await canvas.convertToBlob({ type: 'image/png' });
  if (photographic) {
    const pixels = canvas.width * canvas.height;
    if ((png.size * 8) / Math.max(1, pixels) >= PHOTO_MIN_BITS_PER_PIXEL) {
      const jpeg = await canvas.convertToBlob({
        type: 'image/jpeg',
        quality: MAXIMUM_JPEG_QUALITY
      });
      if (preferJpegAtMaximum(png.size, jpeg.size, pixels)) {
        return new Uint8Array(await jpeg.arrayBuffer());
      }
    }
  }
  return new Uint8Array(await png.arrayBuffer());
}

/**
 * What a WebP's container says about it, without decoding: whether it is
 * lossless (VP8L) and whether it carries alpha. `null` when the bytes are not
 * a RIFF/WEBP container.
 */
export function webpTraits(bytes: Uint8Array): { lossless: boolean; alpha: boolean } | null {
  const tag = (o: number) =>
    String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (bytes.length < 16 || tag(0) !== 'RIFF' || tag(8) !== 'WEBP') return null;
  let lossless = false;
  let alpha = false;
  let p = 12;
  while (p + 8 <= bytes.length) {
    const id = tag(p);
    const size =
      (bytes[p + 4] | (bytes[p + 5] << 8) | (bytes[p + 6] << 16) | (bytes[p + 7] << 24)) >>> 0;
    const data = p + 8;
    if (id === 'VP8X' && data < bytes.length) {
      if (bytes[data] & 0x10) alpha = true;
    } else if (id === 'ALPH') {
      alpha = true;
    } else if (id === 'VP8L') {
      lossless = true;
      // VP8L header: signature 0x2f, then 14+14 bits of size, then alpha_is_used.
      if (data + 5 <= bytes.length && (bytes[data + 4] >> 4) & 0x1) alpha = true;
    }
    p = data + size + (size & 1);
  }
  return { lossless, alpha };
}
