/**
 * SGN-01 / HRD-27 H3 (AUDIT-FINDINGS §14) — the signature tool's per-pixel
 * work, run in the cv worker: trimming transparent margins and turning
 * photographed paper-white into real transparency.
 *
 * Both used to loop over every pixel on the main thread, from
 * `SignatureModal.tsx`; an imported 4000×3000 photo blocked it for seconds.
 * `image.ts`'s `trimTransparentToPng` and `removeWhiteBackground` keep their
 * signatures and hand the bitmap over to this. The pixel rules are unchanged
 * byte for byte (`tests/unit/signature-pixels-worker.test.ts` runs the old
 * main-thread code against this on the same input).
 */
import * as Comlink from 'comlink';

export interface TrimmedSignaturePng {
  png: Uint8Array;
  width: number;
  height: number;
}

/** Inclusive pixel bounds of everything that is not fully transparent. */
export interface OpaqueBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface SignaturePixelsJob {
  /** The opaque content of `bitmap`, cropped with `padding` px of margin, as PNG. Closes `bitmap`. */
  trimSignature(bitmap: ImageBitmap, padding: number): Promise<TrimmedSignaturePng | null>;
  /** `bitmap` with its neutral near-white pixels made transparent. Closes `bitmap`. */
  removeSignatureBackground(bitmap: ImageBitmap, cutoff: number): Promise<ImageBitmap | null>;
}

/** Bounds of every pixel whose alpha is not 0, or null for an empty image. */
export function opaqueBounds(
  data: Uint8ClampedArray,
  width: number,
  height: number
): OpaqueBounds | null {
  let top = height;
  let left = width;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (data[row + x * 4 + 3] === 0) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  if (right < left || bottom < top) return null;
  return { left, top, right, bottom };
}

/**
 * Makes paper transparent in place: a pixel whose darkest channel is at least
 * `cutoff` and whose channels differ by less than 24 (neutral, light) gets
 * alpha 0. Ink and coloured highlights are left alone.
 */
export function clearPaperWhite(data: Uint8ClampedArray, cutoff: number): void {
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (min >= cutoff && max - min < 24) data[i + 3] = 0;
  }
}

type PixelSource = CanvasImageSource & { width: number; height: number };

/** The canvas half of {@link SignaturePixelsJob.trimSignature}, for any drawable source. */
export async function trimSourceToPng(
  source: PixelSource,
  padding: number
): Promise<TrimmedSignaturePng | null> {
  const width = source.width;
  const height = source.height;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0);

  const bounds = opaqueBounds(ctx.getImageData(0, 0, width, height).data, width, height);
  if (!bounds) return null; // nothing drawn

  const cropWidth = bounds.right - bounds.left + 1;
  const cropHeight = bounds.bottom - bounds.top + 1;
  const out = new OffscreenCanvas(cropWidth + padding * 2, cropHeight + padding * 2);
  const outCtx = out.getContext('2d');
  if (!outCtx) return null;
  outCtx.drawImage(
    canvas,
    bounds.left,
    bounds.top,
    cropWidth,
    cropHeight,
    padding,
    padding,
    cropWidth,
    cropHeight
  );
  const blob = await out.convertToBlob({ type: 'image/png' });
  return { png: new Uint8Array(await blob.arrayBuffer()), width: out.width, height: out.height };
}

/** The canvas half of {@link SignaturePixelsJob.removeSignatureBackground}. */
export function removeWhiteFromSource(source: PixelSource, cutoff: number): OffscreenCanvas | null {
  const canvas = new OffscreenCanvas(source.width, source.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0);
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  clearPaperWhite(image.data, cutoff);
  ctx.putImageData(image, 0, 0);
  return canvas;
}

export const signaturePixelsApi: SignaturePixelsJob = {
  async trimSignature(bitmap, padding) {
    try {
      const trimmed = await trimSourceToPng(bitmap, padding);
      return trimmed && Comlink.transfer(trimmed, [trimmed.png.buffer as ArrayBuffer]);
    } finally {
      bitmap.close();
    }
  },

  async removeSignatureBackground(bitmap, cutoff) {
    let canvas: OffscreenCanvas | null = null;
    try {
      canvas = removeWhiteFromSource(bitmap, cutoff);
      if (!canvas) return null;
      const result = await createImageBitmap(canvas);
      return Comlink.transfer(result, [result]);
    } finally {
      bitmap.close();
      // H13: a scratch canvas is zeroed once its pixels have been handed on.
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
    }
  }
};
