/**
 * Scan enhancement (SCN-02). Pure functions over `ImageData`, so they unit test
 * without a DOM and run in the CV worker.
 */

export type Preset = 'auto' | 'bw' | 'photo' | 'original';

/** Rec. 709 luma. Perceptually correct where a channel average is not. */
function luma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Builds a summed-area table of luminance.
 *
 * Float64Array, not Uint32Array: a 4000×6000 scan sums to ~6.1e9, which overflows
 * a Uint32 and wraps the running total back to near zero — thresholding then
 * paints whole bands of the page black.
 */
export function integralLuma(
  data: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number
): Float64Array {
  const sum = new Float64Array(width * height);
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      rowSum += luma(data[i], data[i + 1], data[i + 2]);
      sum[y * width + x] = rowSum + (y > 0 ? sum[(y - 1) * width + x] : 0);
    }
  }
  return sum;
}

/**
 * Mean luminance of the inclusive rectangle (x1,y1)-(x2,y2).
 *
 * The previous implementation read the table at `x1`/`y1` instead of one before
 * them, and divided by `(x2-x1)*(y2-y1)` instead of the inclusive count — so both
 * the sum and the pixel count were wrong, biasing the threshold and thinning
 * strokes.
 */
export function windowMean(
  sum: Float64Array,
  width: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): number {
  const total =
    sum[y2 * width + x2] -
    (x1 > 0 ? sum[y2 * width + (x1 - 1)] : 0) -
    (y1 > 0 ? sum[(y1 - 1) * width + x2] : 0) +
    (x1 > 0 && y1 > 0 ? sum[(y1 - 1) * width + (x1 - 1)] : 0);
  const count = (x2 - x1 + 1) * (y2 - y1 + 1);
  return count > 0 ? total / count : 255;
}

/**
 * Bradley–Roth adaptive threshold: a pixel goes black when it is more than `t`
 * percent darker than the mean of its `window`-sized neighbourhood. Handles the
 * uneven lighting of a phone photo, which a global threshold cannot.
 */
export function applyAdaptiveThreshold(imageData: ImageData, window = 15, t = 15): ImageData {
  const { width, height, data } = imageData;
  const out = new ImageData(width, height);
  const result = out.data;
  const sum = integralLuma(data, width, height);
  const half = Math.max(1, Math.floor(window / 2));
  const factor = (100 - t) / 100;

  for (let y = 0; y < height; y++) {
    const y1 = Math.max(0, y - half);
    const y2 = Math.min(height - 1, y + half);
    for (let x = 0; x < width; x++) {
      const x1 = Math.max(0, x - half);
      const x2 = Math.min(width - 1, x + half);
      const mean = windowMean(sum, width, x1, y1, x2, y2);
      const i = (y * width + x) * 4;
      const value = luma(data[i], data[i + 1], data[i + 2]) <= mean * factor ? 0 : 255;
      result[i] = value;
      result[i + 1] = value;
      result[i + 2] = value;
      result[i + 3] = 255;
    }
  }
  return out;
}

/**
 * Fast salt-and-pepper noise removal on binary images.
 * Looks at a 3x3 window around each black pixel; if 7 or 8 of its
 * neighbors are white, it flips the pixel to white, removing isolated 1-2px noise
 * without breaking thin strokes.
 * Assumes the input image is already thresholded to 0 or 255.
 */
export function applyDespeckle(imageData: ImageData): ImageData {
  const { width, height, data } = imageData;
  const out = new ImageData(width, height);
  const result = out.data;

  // Process rows 1 to height-2, cols 1 to width-2 for speed without boundary checks in the inner loop
  // The edges are just copied over.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const v = data[i];

      // If it's already white, or we're on the very edge, keep it as is.
      if (v === 255 || y === 0 || y === height - 1 || x === 0 || x === width - 1) {
        result[i] = v;
        result[i + 1] = v;
        result[i + 2] = v;
        result[i + 3] = data[i + 3];
        continue;
      }

      // It's a black pixel in the interior. Count white neighbors in the 3x3 window.
      let whiteCount = 0;
      if (data[((y - 1) * width + (x - 1)) * 4] === 255) whiteCount++;
      if (data[((y - 1) * width + x) * 4] === 255) whiteCount++;
      if (data[((y - 1) * width + (x + 1)) * 4] === 255) whiteCount++;

      if (data[(y * width + (x - 1)) * 4] === 255) whiteCount++;
      if (data[(y * width + (x + 1)) * 4] === 255) whiteCount++;

      if (data[((y + 1) * width + (x - 1)) * 4] === 255) whiteCount++;
      if (data[((y + 1) * width + x) * 4] === 255) whiteCount++;
      if (data[((y + 1) * width + (x + 1)) * 4] === 255) whiteCount++;

      // 7 or 8 white neighbors -> isolated speckle of 1 or 2 pixels -> flip to white
      const outV = whiteCount >= 7 ? 255 : v;
      result[i] = outV;
      result[i + 1] = outV;
      result[i + 2] = outV;
      result[i + 3] = data[i + 3];
    }
  }

  return out;
}

/** Contrast and brightness, both -100..100. */
export function applyContrastBrightness(
  imageData: ImageData,
  contrast: number,
  brightness: number
): ImageData {
  const { width, height, data } = imageData;
  const out = new ImageData(width, height);
  const result = out.data;
  const clamped = Math.max(-100, Math.min(100, contrast));
  const factor = (259 * (clamped + 255)) / (255 * (259 - clamped));

  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const shifted = data[i + c] + brightness;
      result[i + c] = Math.max(0, Math.min(255, factor * (shifted - 128) + 128));
    }
    // Preserve alpha rather than forcing opacity — a transparent source would
    // otherwise gain a black background.
    result[i + 3] = data[i + 3];
  }
  return out;
}

/**
 * Rotates by `angleDeg`, sampling bilinearly and filling exposed corners white.
 *
 * Positive `angleDeg` rotates the *content* one way and {@link detectSkew} measures
 * it the other, so the correcting rotation is `-detectSkew(image)`. Do not pair them
 * by hand — the previous code did, got the sign wrong, and doubled the skew instead of
 * removing it. Use {@link deskew}.
 */
export function rotateImageData(imageData: ImageData, angleDeg: number, fit = false): ImageData {
  if (angleDeg === 0) return imageData;

  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const { width: w, height: h, data: src } = imageData;

  // With `fit`, the canvas grows to the rotated bounding box. Without it the
  // canvas keeps its size and the corners that rotate outside it are lost —
  // which is what deskewing a full-bleed scan did: at the ±15° limit a straight
  // rotation shears roughly 13% off each corner, taking the page's own corners
  // (and any content near them) with it.
  const outWidth = fit ? Math.ceil(Math.abs(w * cos) + Math.abs(h * sin)) : w;
  const outHeight = fit ? Math.ceil(Math.abs(w * sin) + Math.abs(h * cos)) : h;

  const out = new ImageData(outWidth, outHeight);
  const dst = out.data;
  const cx = w / 2;
  const cy = h / 2;
  const outCx = outWidth / 2;
  const outCy = outHeight / 2;

  for (let y = 0; y < outHeight; y++) {
    for (let x = 0; x < outWidth; x++) {
      const dx = x - outCx;
      const dy = y - outCy;
      // Inverse map: which source pixel does this destination pixel come from?
      const sx = cos * dx + sin * dy + cx;
      const sy = -sin * dx + cos * dy + cy;
      const di = (y * outWidth + x) * 4;

      if (sx < 0 || sy < 0 || sx >= w - 1 || sy >= h - 1) {
        dst[di] = 255;
        dst[di + 1] = 255;
        dst[di + 2] = 255;
        dst[di + 3] = 255;
        continue;
      }

      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      const i00 = (y0 * w + x0) * 4;
      const i10 = i00 + 4;
      const i01 = i00 + w * 4;
      const i11 = i01 + 4;

      for (let c = 0; c < 4; c++) {
        dst[di + c] =
          src[i00 + c] * (1 - fx) * (1 - fy) +
          src[i10 + c] * fx * (1 - fy) +
          src[i01 + c] * (1 - fx) * fy +
          src[i11 + c] * fx * fy;
      }
    }
  }
  return out;
}

/**
 * Measures the page's skew and straightens it in one call.
 *
 * The only correct way to pair {@link detectSkew} with {@link rotateImageData}: their
 * angle conventions are opposite, so applying the measured angle directly doubles the
 * skew. Returns the measured angle alongside the corrected image so the UI can report
 * what it did.
 */
export function deskew(
  imageData: ImageData,
  maxDegrees = 15,
  minCorrection = 0.5
): { angle: number; image: ImageData } {
  const angle = detectSkew(imageData, maxDegrees);
  // Below half a degree the resample costs sharpness and buys nothing visible.
  if (Math.abs(angle) < minCorrection) return { angle: 0, image: imageData };
  // `fit` grows the canvas to the rotated bounding box: straightening a page
  // must not cost it its own corners.
  return { angle, image: rotateImageData(imageData, -angle, true) };
}

/**
 * Estimates page skew in degrees by projection profile: text lines give the
 * highest row-to-row variance when horizontal. Searches ±`maxDegrees` (SCN-02
 * specifies ±15°) coarsely, then refines.
 *
 * Returns the *measured* skew: positive means the page's lines run down to the right.
 * To straighten, call {@link deskew} rather than negating this by hand.
 */
export function detectSkew(imageData: ImageData, maxDegrees = 15): number {
  const coarse = searchSkew(imageData, -maxDegrees, maxDegrees, 1);
  // A degree of residual skew is still visible across a full page of text, so
  // refine around the winner instead of returning the integer estimate.
  return searchSkew(imageData, coarse - 1, coarse + 1, 0.25);
}

function searchSkew(imageData: ImageData, from: number, to: number, step: number): number {
  const { width, height, data } = imageData;
  // Sampling every third pixel keeps a 12MP photo interactive and does not change
  // which angle wins.
  const stride = 3;
  let bestAngle = 0;
  let bestScore = -1;

  for (let angle = from; angle <= to + 1e-9; angle += step) {
    const rad = (angle * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const cx = width / 2;
    const cy = height / 2;
    const projection = new Float64Array(height);

    for (let y = 0; y < height; y += stride) {
      for (let x = 0; x < width; x += stride) {
        const row = Math.round(-sin * (x - cx) + cos * (y - cy) + cy);
        if (row < 0 || row >= height) continue;
        const i = (y * width + x) * 4;
        if (luma(data[i], data[i + 1], data[i + 2]) < 128) projection[row] += 1;
      }
    }

    // Variance of the row histogram: sharply peaked means aligned text lines.
    let sum = 0;
    for (let i = 0; i < height; i++) sum += projection[i];
    const mean = sum / height;
    let variance = 0;
    for (let i = 0; i < height; i++) variance += (projection[i] - mean) ** 2;

    if (variance > bestScore) {
      bestScore = variance;
      bestAngle = angle;
    }
  }

  return Number(bestAngle.toFixed(2));
}
