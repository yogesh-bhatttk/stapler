/**
 * X-3 — `img` resampled (bilinear) to `width`×`height`; the image itself when
 * it already is that size. A Letter page against an A4 page, or a page that
 * turned, is compared at one size instead of refused.
 */
export function resampleImageData(img: ImageData, width: number, height: number): ImageData {
  if (img.width === width && img.height === height) return img;
  const out = new ImageData(Math.max(1, width), Math.max(1, height));
  const src = img.data;
  const dst = out.data;
  const sw = img.width;
  const sh = img.height;
  if (sw === 0 || sh === 0) return out;
  const xRatio = sw / out.width;
  const yRatio = sh / out.height;
  for (let y = 0; y < out.height; y++) {
    const sy = Math.min(sh - 1, Math.max(0, (y + 0.5) * yRatio - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(sh - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < out.width; x++) {
      const sx = Math.min(sw - 1, Math.max(0, (x + 0.5) * xRatio - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(sw - 1, x0 + 1);
      const fx = sx - x0;
      const i00 = (y0 * sw + x0) * 4;
      const i01 = (y0 * sw + x1) * 4;
      const i10 = (y1 * sw + x0) * 4;
      const i11 = (y1 * sw + x1) * 4;
      const o = (y * out.width + x) * 4;
      for (let c = 0; c < 4; c++) {
        const top = src[i00 + c] + (src[i01 + c] - src[i00 + c]) * fx;
        const bottom = src[i10 + c] + (src[i11 + c] - src[i10 + c]) * fx;
        dst[o + c] = Math.round(top + (bottom - top) * fy);
      }
    }
  }
  return out;
}

/**
 * A red-on-transparent overlay, `img1`'s size, marking every pixel where the
 * two images differ by more than the sensitivity allows.
 *
 * X-3 — images of different sizes (A4 against Letter, a rotated page) used to
 * throw, so such a pair could be viewed in Compare (which resampled first)
 * but never exported. `img2` is now resampled to `img1`'s size, the same way
 * the Compare view always did.
 */
export function pixelDiff(img1: ImageData, rawImg2: ImageData, sensitivity: number): ImageData {
  const img2 = resampleImageData(rawImg2, img1.width, img1.height);
  const width = img1.width;
  const height = img1.height;
  const out = new ImageData(width, height);
  const data1 = img1.data;
  const data2 = img2.data;
  const outData = out.data;

  // sensitivity is 0 to 100. Higher means more sensitive (lower threshold).
  // max diff for RGB is 255*3 = 765.
  // if sensitivity = 0, threshold = 765 (everything matches)
  // if sensitivity = 100, threshold = 0 (exact match)
  const threshold = ((100 - sensitivity) / 100) * 765;

  for (let i = 0; i < data1.length; i += 4) {
    const r1 = data1[i];
    const g1 = data1[i + 1];
    const b1 = data1[i + 2];

    const r2 = data2[i];
    const g2 = data2[i + 1];
    const b2 = data2[i + 2];

    // RGB only, matching the RGB-only threshold above (765 = 255×3) — a pixel
    // identical in colour but different only in alpha must not be flagged as
    // "changed" just because its alpha byte happened to move.
    const diff = Math.abs(r1 - r2) + Math.abs(g1 - g2) + Math.abs(b1 - b2);

    if (diff > threshold) {
      // Differing pixel: Color it red
      outData[i] = 255;
      outData[i + 1] = 0;
      outData[i + 2] = 0;
      outData[i + 3] = 255;
    } else {
      // Matching pixel: Make it transparent or faded (we can just show the original image)
      // We'll leave it transparent so we can overlay it on top of image 2
      outData[i] = 0;
      outData[i + 1] = 0;
      outData[i + 2] = 0;
      outData[i + 3] = 0;
    }
  }

  return out;
}
