/**
 * Page-edge detection and perspective correction (SCN-01).
 *
 * Detection is a heuristic and will sometimes be wrong, which is why
 * {@link detectCorners} reports its own confidence and the UI always offers
 * draggable corner handles as the fallback rather than treating the guess as
 * final.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Quad {
  tl: Point;
  tr: Point;
  br: Point;
  bl: Point;
}

export interface CornerDetection {
  quad: Quad;
  /**
   * False when detection fell back to an inset of the whole frame — the caller
   * must then present the manual handles rather than silently cropping.
   */
  confident: boolean;
}

function luma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Otsu's method: picks the luminance threshold that best separates the histogram
 * into two classes. Replaces a fixed `average × 1.2`, which classified a dim
 * photo as all-paper and a bright one as all-background.
 */
export function otsuThreshold(data: Uint8ClampedArray | Uint8Array): number {
  const histogram = new Float64Array(256);
  let total = 0;
  for (let i = 0; i < data.length; i += 4) {
    histogram[Math.round(luma(data[i], data[i + 1], data[i + 2]))] += 1;
    total += 1;
  }
  if (total === 0) return 128;

  let sum = 0;
  for (let v = 0; v < 256; v++) sum += v * histogram[v];

  let weightBelow = 0;
  let sumBelow = 0;
  let bestVariance = -1;
  let best = 128;

  for (let v = 0; v < 256; v++) {
    weightBelow += histogram[v];
    if (weightBelow === 0) continue;
    const weightAbove = total - weightBelow;
    if (weightAbove === 0) break;
    sumBelow += v * histogram[v];
    const meanBelow = sumBelow / weightBelow;
    const meanAbove = (sum - sumBelow) / weightAbove;
    const variance = weightBelow * weightAbove * (meanBelow - meanAbove) ** 2;
    if (variance > bestVariance) {
      bestVariance = variance;
      best = v;
    }
  }
  return best;
}

export function quadArea(q: Quad): number {
  const xs = [q.tl.x, q.tr.x, q.br.x, q.bl.x];
  const ys = [q.tl.y, q.tr.y, q.br.y, q.bl.y];
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    area += xs[i] * ys[j] - xs[j] * ys[i];
  }
  return Math.abs(area / 2);
}

/** An inset of the whole frame, used when detection is not trustworthy. */
export function frameQuad(width: number, height: number, insetRatio = 0.02): Quad {
  const inset = Math.min(width, height) * insetRatio;
  return {
    tl: { x: inset, y: inset },
    tr: { x: width - inset, y: inset },
    br: { x: width - inset, y: height - inset },
    bl: { x: inset, y: height - inset }
  };
}

import { extractDocumentQuad } from './edgeDetection';

/**
 * Finds the paper using an edge detection pipeline (Grayscale -> Blur -> Sobel -> Contours -> Largest Quad).
 */
export function detectCorners(imageData: ImageData): CornerDetection {
  const result = extractDocumentQuad(imageData);
  if (result.confident && result.quad) {
    return { quad: result.quad, confident: true };
  }
  return { quad: frameQuad(imageData.width, imageData.height), confident: false };
}

/** Solves A·x = B by Gaussian elimination with partial pivoting. */
function solve(A: number[][], B: number[]): number[] | null {
  const n = B.length;
  for (let i = 0; i < n; i++) {
    let pivot = i;
    for (let k = i + 1; k < n; k++) {
      if (Math.abs(A[k][i]) > Math.abs(A[pivot][i])) pivot = k;
    }
    if (Math.abs(A[pivot][i]) < 1e-12) return null;
    [A[i], A[pivot]] = [A[pivot], A[i]];
    [B[i], B[pivot]] = [B[pivot], B[i]];

    for (let k = i + 1; k < n; k++) {
      const factor = A[k][i] / A[i][i];
      if (factor === 0) continue;
      for (let j = i; j < n; j++) A[k][j] -= factor * A[i][j];
      B[k] -= factor * B[i];
    }
  }

  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = B[i];
    for (let j = i + 1; j < n; j++) sum -= A[i][j] * x[j];
    x[i] = sum / A[i][i];
  }
  return x;
}

/** Homography mapping `src` corners onto `dst` corners, as a row-major 3×3. */
export function getPerspectiveTransform(src: Quad, dst: Quad): number[] {
  const from = [src.tl, src.tr, src.br, src.bl];
  const to = [dst.tl, dst.tr, dst.br, dst.bl];
  const A: number[][] = [];
  const B: number[] = [];

  for (let i = 0; i < 4; i++) {
    A.push([from[i].x, from[i].y, 1, 0, 0, 0, -from[i].x * to[i].x, -from[i].y * to[i].x]);
    B.push(to[i].x);
    A.push([0, 0, 0, from[i].x, from[i].y, 1, -from[i].x * to[i].y, -from[i].y * to[i].y]);
    B.push(to[i].y);
  }

  const h = solve(A, B);
  // Identity, so a degenerate quad returns the image unchanged instead of blank.
  if (!h) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  return [...h, 1];
}

/**
 * Warps the quadrilateral `srcQuad` onto a `dstWidth`×`dstHeight` rectangle,
 * sampling bilinearly. Pixels with no source are white, not transparent — a
 * transparent edge becomes black once the page is flattened into a PDF.
 */
export function warpPerspective(
  srcData: ImageData,
  srcQuad: Quad,
  dstWidth: number,
  dstHeight: number
): ImageData {
  const width = Math.max(1, Math.floor(dstWidth));
  const height = Math.max(1, Math.floor(dstHeight));

  // Map destination → source so every output pixel is written exactly once.
  const transform = getPerspectiveTransform(
    {
      tl: { x: 0, y: 0 },
      tr: { x: width - 1, y: 0 },
      br: { x: width - 1, y: height - 1 },
      bl: { x: 0, y: height - 1 }
    },
    srcQuad
  );

  const out = new ImageData(width, height);
  const dst = out.data;
  const src = srcData.data;
  const sw = srcData.width;
  const sh = srcData.height;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const w = transform[6] * x + transform[7] * y + transform[8];
      const sx = (transform[0] * x + transform[1] * y + transform[2]) / w;
      const sy = (transform[3] * x + transform[4] * y + transform[5]) / w;
      const di = (y * width + x) * 4;

      if (
        !Number.isFinite(sx) ||
        !Number.isFinite(sy) ||
        sx < 0 ||
        sy < 0 ||
        sx >= sw - 1 ||
        sy >= sh - 1
      ) {
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
      const i00 = (y0 * sw + x0) * 4;
      const i10 = i00 + 4;
      const i01 = i00 + sw * 4;
      const i11 = i01 + 4;

      for (let c = 0; c < 4; c++) {
        dst[di + c] =
          src[i00 + c] * (1 - fx) * (1 - fy) +
          src[i10 + c] * fx * (1 - fy) +
          src[i01 + c] * (1 - fx) * fy +
          src[i11 + c] * fx * fy;
      }
      dst[di + 3] = 255;
    }
  }

  return out;
}

/** Output size for a warp, from the longest opposing edges of the quad. */
export function warpTargetSize(quad: Quad): { width: number; height: number } {
  const top = Math.hypot(quad.tr.x - quad.tl.x, quad.tr.y - quad.tl.y);
  const bottom = Math.hypot(quad.br.x - quad.bl.x, quad.br.y - quad.bl.y);
  const left = Math.hypot(quad.bl.x - quad.tl.x, quad.bl.y - quad.tl.y);
  const right = Math.hypot(quad.br.x - quad.tr.x, quad.br.y - quad.tr.y);
  return {
    width: Math.max(1, Math.round(Math.max(top, bottom))),
    height: Math.max(1, Math.round(Math.max(left, right)))
  };
}
