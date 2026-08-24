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

/**
 * True when `quad` is (within `tolerance` pixels) the whole frame — the shape that
 * means "do not de-warp this page". Callers use it to skip the warp entirely rather
 * than resampling every pixel through an identity homography.
 */
export function isFrameQuad(quad: Quad, width: number, height: number, tolerance = 1): boolean {
  const corners: [Point, Point][] = [
    [quad.tl, { x: 0, y: 0 }],
    [quad.tr, { x: width, y: 0 }],
    [quad.br, { x: width, y: height }],
    [quad.bl, { x: 0, y: height }]
  ];
  return corners.every(
    ([a, b]) => Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance
  );
}

function lumaAt(image: ImageData, x: number, y: number): number | null {
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || py < 0 || px >= image.width || py >= image.height) return null;
  const i = (py * image.width + px) * 4;
  return luma(image.data[i], image.data[i + 1], image.data[i + 2]);
}

/**
 * How strongly the image actually supports `quad` being a page boundary: the
 * difference in mean luminance just inside versus just outside the quad's four
 * edges, alongside the sample noise that difference has to beat.
 *
 * Exported because it is the measurement {@link detectCorners}'s confidence rests
 * on, and a measurement worth trusting is worth testing directly.
 */
export function quadEdgeSupport(
  image: ImageData,
  quad: Quad,
  samplesPerEdge = 24
): { contrast: number; noise: number } {
  const edges: [Point, Point][] = [
    [quad.tl, quad.tr],
    [quad.tr, quad.br],
    [quad.br, quad.bl],
    [quad.bl, quad.tl]
  ];
  // Far enough out to clear the 5x5 blur and any soft focus at the paper edge,
  // near enough to still be measuring the border rather than the scene.
  const offset = Math.max(3, Math.round(Math.min(image.width, image.height) * 0.01));

  const inside: number[] = [];
  const outside: number[] = [];

  for (const [a, b] of edges) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    if (length < 1) continue;
    // Inward normal for the tl→tr→br→bl winding used throughout this module.
    const nx = -dy / length;
    const ny = dx / length;

    for (let s = 0; s < samplesPerEdge; s++) {
      // Skip the last 10% at each end: corners are where both edges' blur meets,
      // and sampling there measures the corner rather than the edge.
      const t = 0.1 + (0.8 * s) / Math.max(1, samplesPerEdge - 1);
      const px = a.x + dx * t;
      const py = a.y + dy * t;
      const vin = lumaAt(image, px + nx * offset, py + ny * offset);
      const vout = lumaAt(image, px - nx * offset, py - ny * offset);
      if (vin === null || vout === null) continue;
      inside.push(vin);
      outside.push(vout);
    }
  }

  if (inside.length === 0) return { contrast: 0, noise: 0 };

  const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;
  const variance = (xs: number[], m: number) =>
    xs.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, xs.length - 1);

  const mIn = mean(inside);
  const mOut = mean(outside);
  // Pooled standard deviation of the two sample sets: the scene's own grain and
  // lighting variation, which a real page boundary has to stand out from.
  const noise = Math.sqrt((variance(inside, mIn) + variance(outside, mOut)) / 2);
  // Absolute so a dark page on a light desk counts the same as the reverse.
  return { contrast: Math.abs(mIn - mOut), noise };
}

/**
 * Minimum border contrast, in luma, before a detected quad is believed. Below this
 * the "page edge" is indistinguishable from print, a shadow, or sensor grain.
 */
const MIN_EDGE_CONTRAST = 12;
/**
 * …and it must also stand this many standard deviations clear of the scene's own
 * noise. Contrast alone passes a noisy frame whose grain happens to average out.
 */
const MIN_CONTRAST_TO_NOISE = 1.5;

import { extractDocumentQuad } from './edgeDetection';

/**
 * Finds the paper using an edge detection pipeline (Grayscale -> Blur -> Sobel -> Contours -> Largest Quad).
 *
 * The contour stage answers "is there a large convex quadrilateral in the edge map",
 * which a low-contrast photo can satisfy with a quad traced out of grain — it was
 * returning `confident: true` on a scene whose corners were 25% of the image diagonal
 * away from the real page. Confidence is therefore a second, independent question,
 * asked of the original pixels rather than the edge map: does the image actually get
 * brighter or darker as you cross this boundary?
 *
 * When the answer is no, the returned quad is the **whole frame**, not an inset of it.
 * A detection we do not believe must not remove 2% of the user's page on its way out.
 */
export function detectCorners(imageData: ImageData): CornerDetection {
  const result = extractDocumentQuad(imageData);
  if (result.confident && result.quad) {
    const { contrast, noise } = quadEdgeSupport(imageData, result.quad);
    if (contrast >= MIN_EDGE_CONTRAST && contrast >= MIN_CONTRAST_TO_NOISE * noise) {
      return { quad: result.quad, confident: true };
    }
  }
  return { quad: frameQuad(imageData.width, imageData.height, 0), confident: false };
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

/** The frame the quad's coordinates are expressed in — a captured image. */
export interface FrameSize {
  width: number;
  height: number;
}

/**
 * Focal length assumed when the corners cannot reveal it, as a multiple of the
 * frame diagonal. 0.6·diagonal is a ~26mm-equivalent lens: the main camera of
 * essentially every phone, and so the overwhelmingly likely source of a photo
 * of a document.
 */
const NOMINAL_FOCAL_PER_DIAGONAL = 0.6;
/**
 * The range a recovered focal length has to fall in to be believed, again in
 * frame diagonals — roughly a 17mm ultra-wide through a 65mm short telephoto.
 * Anything outside it is noise in the corner positions rather than a camera, and
 * is pulled back to the nearest plausible value instead of being trusted.
 */
const MIN_FOCAL_PER_DIAGONAL = 0.4;
const MAX_FOCAL_PER_DIAGONAL = 1.5;
/**
 * How far a vanishing point may sit from the page before the focal length solved
 * from it stops being believable, as a multiple of the length of the edges that
 * point at it. This *extrapolation factor* is the right scale for the question:
 * finding a vanishing point means extending two edges until they meet, so the
 * further out it is relative to the edges themselves, the more a pixel of corner
 * error moves it — and at the limit, where the edges are parallel on screen, it is
 * at infinity and carries no focal length at all.
 *
 * Below `FULL` the solve is used as-is. Above `NONE` only the assumed lens is.
 * Between them the two are mixed, so a photo just either side of the boundary does
 * not get a visibly different page shape. Measured over ~6000 randomized synthetic
 * captures (lens 0.4–1.3 diagonals, tilt 0–40°, ±1px corner noise) this mix beats
 * every hard cutoff tried: mean aspect error 3.1% against 3.25% for the best
 * cutoff, and 11.4% against 12.6% on the 40–65° tilts nothing handles well.
 */
const FULL_TRUST_EXTRAPOLATION = 40;
const NO_TRUST_EXTRAPOLATION = 400;
/**
 * Cap on how much correcting the aspect ratio may inflate the output pixel count.
 * The correction factor is unbounded as the camera approaches the plane of the
 * page, and a 12MP photo must not be allowed to warp into a 40MP buffer.
 */
const MAX_PIXEL_GROWTH = 2;

type Vec3 = readonly [number, number, number];

const cross3 = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0]
];
const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export interface AspectEstimate {
  /** width ÷ height of the physical rectangle, before it was photographed. */
  ratio: number;
  /**
   * Which case produced `ratio`. Exposed because "we solved for the camera" and
   * "we assumed a camera" are very different confidences in the same number, and
   * the tests need to know which one they are exercising.
   */
  method: 'projective' | 'blended' | 'assumed-focal' | 'projected-edges';
  /**
   * How much of the focal length came from the corners rather than from the
   * assumed lens, in `[0, 1]`. 1 is a fully determined camera.
   */
  focalWeight: number;
}

/**
 * The true width÷height of a rectangle, recovered from its four projected corners.
 *
 * The projected edge lengths cannot answer this on their own: perspective makes
 * the far edge of a tilted page shorter than the near one, so the longest edge in
 * each direction is a measure of how close that edge was to the lens, not of the
 * paper. Taking those lengths as the output size stretches the page by 27% at a
 * 30° tilt and by 127% at 60°.
 *
 * What does answer it is the pinhole camera the photo came out of (Zhang & He,
 * *Whiteboard Scanning and Image Enhancement*, MSR-TR-2003-39, §2.2). Two
 * opposing edges of the rectangle meet, when extended, at the vanishing point of
 * that direction; the two vanishing points are the images of two directions that
 * are perpendicular in the world. Writing `n₂`/`n₃` for those two points in
 * homogeneous coordinates and `ω = A⁻ᵀA⁻¹` for the image of the absolute conic of
 * a camera with square pixels, no skew, and its principal point at the centre of
 * the frame, perpendicularity is one scalar equation, `n₂ᵀ ω n₃ = 0`, whose only
 * unknown is the focal length. Solve it, and the same `ω` turns the two edge
 * directions into world lengths whose ratio is the aspect ratio:
 *
 *     ratio² = (n₂ᵀ ω n₂) ÷ (n₃ᵀ ω n₃)
 *
 * Two configurations carry no focal length and are handled rather than trusted:
 *
 * - **A page square to the lens.** Both vanishing points are at infinity, there is
 *   no perspective to undo, and the focal length cancels out of the ratio anyway —
 *   so the assumed one costs nothing and the answer is exact.
 * - **A page tilted about one axis only** (the top and bottom edges stay parallel
 *   on screen, the common phone-held-level shot). One vanishing point is at
 *   infinity, `n₂ᵀ ω n₃ = 0` loses its focal term, and the aspect ratio genuinely
 *   is ambiguous — a long lens far away and a short lens close up produce the same
 *   four corners from differently-shaped pages. No method recovers it from the
 *   corners alone; this falls back on the nominal phone lens, which lands within a
 *   few percent for real phone cameras and degrades smoothly as the guess is wrong.
 *
 * Between "solvable" and "ambiguous" is a continuum rather than a line, so how much
 * of the solved focal length is used is weighted by how well-conditioned the solve
 * was — see {@link FULL_TRUST_EXTRAPOLATION}. `focalWeight` on the result reports
 * where a given quad landed.
 */
export function estimateQuadAspectRatio(quad: Quad, frame: FrameSize): AspectEstimate {
  const top = Math.hypot(quad.tr.x - quad.tl.x, quad.tr.y - quad.tl.y);
  const bottom = Math.hypot(quad.br.x - quad.bl.x, quad.br.y - quad.bl.y);
  const left = Math.hypot(quad.bl.x - quad.tl.x, quad.bl.y - quad.tl.y);
  const right = Math.hypot(quad.br.x - quad.tr.x, quad.br.y - quad.tr.y);
  // Last resort for a quad that is not the projection of any rectangle: the old
  // measured-edge behaviour. Wrong in the ways described above, but finite and
  // positive, which is what the caller must have.
  const projected: AspectEstimate = {
    ratio: Math.max(top, bottom) / Math.max(1e-6, Math.max(left, right)),
    method: 'projected-edges',
    focalWeight: 0
  };

  const diagonal = Math.hypot(frame.width, frame.height);
  if (!(diagonal > 0)) return projected;

  // Zhang's correspondence: m1..m4 are the images of rectangle corners (0,0),
  // (w,0), (0,h) and (w,h) — so m2 lies along the width axis from m1 and m3 along
  // the height axis, i.e. tl, tr, bl, br in this module's winding.
  const m1: Vec3 = [quad.tl.x, quad.tl.y, 1];
  const m2: Vec3 = [quad.tr.x, quad.tr.y, 1];
  const m3: Vec3 = [quad.bl.x, quad.bl.y, 1];
  const m4: Vec3 = [quad.br.x, quad.br.y, 1];

  // Scale factors that put m2 and m3 on the same projective scale as m1, so that
  // n2/n3 below are the two vanishing points. Their denominators vanish only for
  // a degenerate quad (three corners collinear), which is not a rectangle.
  const denom2 = dot3(cross3(m2, m4), m3);
  const denom3 = dot3(cross3(m3, m4), m2);
  // Relative to the quad's own scale: an absolute epsilon would call a small quad
  // degenerate and a large one healthy for the same shape.
  const scale = Math.max(1, quadArea(quad));
  if (Math.abs(denom2) < 1e-9 * scale || Math.abs(denom3) < 1e-9 * scale) return projected;

  const k2 = dot3(cross3(m1, m4), m3) / denom2;
  const k3 = dot3(cross3(m1, m4), m2) / denom3;
  if (!Number.isFinite(k2) || !Number.isFinite(k3)) return projected;

  // Third components are k−1: exactly 0 when that pair of edges is parallel on
  // screen, i.e. when the vanishing point is at infinity.
  const n2: Vec3 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 - 1];
  const n3: Vec3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 - 1];

  // ω for this camera model is diagonal in the principal-point-centred frame, so
  // every quadratic form below reduces to these offsets over f², plus w².
  const cx = frame.width / 2;
  const cy = frame.height / 2;
  const du2 = n2[0] - cx * n2[2];
  const dv2 = n2[1] - cy * n2[2];
  const du3 = n3[0] - cx * n3[2];
  const dv3 = n3[1] - cy * n3[2];
  const len2 = du2 * du2 + dv2 * dv2;
  const len3 = du3 * du3 + dv3 * dv3;
  if (!Number.isFinite(len2) || !Number.isFinite(len3)) return projected;

  // n₂ᵀ ω n₃ = 0  ⟹  (du₂·du₃ + dv₂·dv₃)/f² + w₂·w₃ = 0.
  let focalSq = -(du2 * du3 + dv2 * dv3) / (n2[2] * n3[2]);

  // How far each vanishing point had to be extrapolated to be found at all, which
  // is what decides whether that solve meant anything — see the constants above.
  const cxQuad = (quad.tl.x + quad.tr.x + quad.br.x + quad.bl.x) / 4;
  const cyQuad = (quad.tl.y + quad.tr.y + quad.br.y + quad.bl.y) / 4;
  const extrapolation = Math.max(
    Math.hypot(n2[0] / n2[2] - cxQuad, n2[1] / n2[2] - cyQuad) / Math.max(1e-9, (top + bottom) / 2),
    Math.hypot(n3[0] / n3[2] - cxQuad, n3[1] / n3[2] - cyQuad) / Math.max(1e-9, (left + right) / 2)
  );

  // Weight on the solved focal length: all of it when the vanishing points are
  // close, none when they are effectively at infinity, log-interpolated between.
  let focalWeight = 0;
  if (Number.isFinite(focalSq) && focalSq > 0 && Number.isFinite(extrapolation)) {
    if (extrapolation <= FULL_TRUST_EXTRAPOLATION) focalWeight = 1;
    else if (extrapolation < NO_TRUST_EXTRAPOLATION) {
      focalWeight =
        (Math.log(NO_TRUST_EXTRAPOLATION) - Math.log(extrapolation)) /
        (Math.log(NO_TRUST_EXTRAPOLATION) - Math.log(FULL_TRUST_EXTRAPOLATION));
    }
    // Corner noise can solve to a lens no camera has; pull it back to the nearest
    // one that exists rather than discard an otherwise well-conditioned solve.
    const focal = Math.sqrt(focalSq);
    const min = MIN_FOCAL_PER_DIAGONAL * diagonal;
    const max = MAX_FOCAL_PER_DIAGONAL * diagonal;
    if (focal < min) focalSq = min * min;
    else if (focal > max) focalSq = max * max;
  }

  // Mix in 1/f², the form the focal length actually enters the ratio in. Written
  // so that a rejected (NaN or negative) solve contributes nothing at all rather
  // than multiplying a zero weight by a NaN.
  const nominalSq = (NOMINAL_FOCAL_PER_DIAGONAL * diagonal) ** 2;
  const inverseFocalSq =
    focalWeight > 0
      ? focalWeight / focalSq + (1 - focalWeight) / nominalSq
      : 1 / nominalSq;
  const method: AspectEstimate['method'] =
    focalWeight >= 0.999 ? 'projective' : focalWeight <= 0.001 ? 'assumed-focal' : 'blended';

  const ratioSq =
    (len2 * inverseFocalSq + n2[2] * n2[2]) / (len3 * inverseFocalSq + n3[2] * n3[2]);
  const ratio = Math.sqrt(ratioSq);
  // A page is not 50× longer than it is wide. Anything out here came from corners
  // that are not a rectangle's, and the measured edges are the better guess.
  if (!Number.isFinite(ratio) || ratio < 0.02 || ratio > 50) return projected;
  return { ratio, method, focalWeight };
}

/**
 * Output size for a warp: the aspect ratio of the real page, at the finest
 * resolution the photo of it actually holds.
 *
 * The shape comes from {@link estimateQuadAspectRatio} rather than from the
 * projected edge lengths, which is what keeps a tilted page from coming out
 * stretched. The scale keeps each axis at least as long as the longest edge
 * measured along it, so correcting the shape never throws away detail the near
 * edge of the page had — bounded by {@link MAX_PIXEL_GROWTH}, since that longest
 * edge grows without limit as the camera drops towards the plane of the page.
 */
export function warpTargetSize(quad: Quad, frame: FrameSize): { width: number; height: number } {
  const top = Math.hypot(quad.tr.x - quad.tl.x, quad.tr.y - quad.tl.y);
  const bottom = Math.hypot(quad.br.x - quad.bl.x, quad.br.y - quad.bl.y);
  const left = Math.hypot(quad.bl.x - quad.tl.x, quad.bl.y - quad.tl.y);
  const right = Math.hypot(quad.br.x - quad.tr.x, quad.br.y - quad.tr.y);
  const baseWidth = Math.max(top, bottom);
  const baseHeight = Math.max(left, right);

  const { ratio } = estimateQuadAspectRatio(quad, frame);

  let width = Math.max(baseWidth, baseHeight * ratio);
  let height = width / ratio;
  const budget = baseWidth * baseHeight * MAX_PIXEL_GROWTH;
  if (budget > 0 && width * height > budget) {
    const shrink = Math.sqrt(budget / (width * height));
    width *= shrink;
    height *= shrink;
  }

  // A non-finite size reaches `new ImageData` as a throw or a blank page, so fall
  // back to the measured box rather than pass one on.
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return {
      width: Math.max(1, Math.round(baseWidth) || 1),
      height: Math.max(1, Math.round(baseHeight) || 1)
    };
  }
  return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
}
