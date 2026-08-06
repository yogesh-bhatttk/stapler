/**
 * Image normalisation for CNV-01.
 *
 * Uses `createImageBitmap` rather than `<img>` + `<canvas>`: it decodes off the
 * main thread, so importing 20 phone photos does not stall the UI for seconds, and
 * `imageOrientation: 'from-image'` applies EXIF rotation — the acceptance
 * criterion that a sideways photo must not stay sideways.
 */
import { corrupt } from './errors';
import { DOC_PAGE_WHITE } from './doc-colors';

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
export async function imageFileToJpeg(file: File, quality = 0.9): Promise<Uint8Array> {
  let sourceBlob: Blob = file;

  if (file.name.toLowerCase().endsWith('.heic') || file.type === 'image/heic') {
    try {
      const heic2any = (await import('heic2any')).default;
      const result = await heic2any({ blob: file, toType: 'image/png' });
      sourceBlob = Array.isArray(result) ? result[0] : result;
    } catch (err) {
      throw corrupt(
        `Failed to decode HEIC file ${file.name}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  } else if (
    file.name.toLowerCase().endsWith('.tiff') ||
    file.name.toLowerCase().endsWith('.tif') ||
    file.type === 'image/tiff'
  ) {
    try {
      const UTIF = await import('utif');
      const buffer = await file.arrayBuffer();
      const ifds = UTIF.decode(buffer);
      UTIF.decodeImage(buffer, ifds[0]);
      const rgba = UTIF.toRGBA8(ifds[0]);

      const width = ifds[0].width;
      const height = ifds[0].height;
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('No 2d context for TIFF conversion');

      const imageData = new ImageData(new Uint8ClampedArray(rgba.buffer), width, height);
      ctx.putImageData(imageData, 0, 0);

      sourceBlob = await canvas.convertToBlob({ type: 'image/png' });
    } catch (err) {
      throw corrupt(
        `Failed to decode TIFF file ${file.name}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(sourceBlob, { imageOrientation: 'from-image' });
  } catch (err) {
    throw corrupt(
      `${file.name} could not be decoded as an image: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw corrupt('A 2D canvas context was unavailable for image conversion.');

    ctx.fillStyle = DOC_PAGE_WHITE;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0);

    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    return new Uint8Array(await blob.arrayBuffer());
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
