/**
 * RED-08 — the "or a marked logo" half, which needs no model at all.
 *
 * A face detector will not find a logo: it is trained on faces, and pointing it
 * at a wordmark returns nothing. The honest answer for "blur this specific
 * graphic wherever else it appears" is not a second neural network, it is
 * template matching — the user marks the thing once, and we look for that exact
 * patch elsewhere.
 *
 * Zero-mean normalised cross-correlation (ZNCC) is the measure, because it is
 * invariant to brightness and contrast: the same logo over a grey header and
 * over white paper, or in a page scanned two stops darker, still scores as the
 * same patch. Plain sum-of-differences does not survive either.
 *
 * What this deliberately does **not** do, stated here rather than discovered by
 * a user: it does not find a rotated logo, a recoloured one, or one at a wildly
 * different size. It searches a modest scale ladder around the marked size,
 * which covers the real case (the same asset repeated across a letterhead) and
 * nothing more exotic. Everything in this file is pure and synchronous, so it
 * is exercised directly by unit tests rather than through a worker.
 */
import type { RgbaImage } from './detect';
import type { UnitRect } from '../pdf/image-redaction';

export interface GrayImage {
  data: Uint8Array;
  width: number;
  height: number;
}

export interface TemplateMatchOptions {
  /**
   * Minimum ZNCC score, 0..1. 0.75 is loose enough for a logo that has been
   * through a JPEG round trip at a different quality and tight enough that
   * unrelated page furniture does not score.
   */
  minScore?: number;
  /** Longest edge the haystack is searched at. Cost is quadratic in this. */
  searchEdge?: number;
  /** Scale factors applied to the template, relative to its marked size. */
  scales?: number[];
  /** Cap on returned matches, after suppression. */
  maxMatches?: number;
}

export const DEFAULT_LOGO_MIN_SCORE = 0.75;
const DEFAULT_SEARCH_EDGE = 320;
const DEFAULT_SCALES = [0.8, 0.9, 1, 1.1, 1.25];
const DEFAULT_MAX_MATCHES = 64;

/** A template can never be usefully matched below this many pixels on a side. */
const MIN_TEMPLATE_EDGE = 6;

/** How far below `minScore` a first-pass hit may score and still be refined. */
const COARSE_SLACK = 0.25;

/** Ceiling on fine-pass re-scans per scale, so a repetitive page cannot stall. */
const MAX_REFINEMENTS = 256;

/** Reduction factors tried for the first pass, largest (cheapest) first. */
const PYRAMID_FACTORS = [4, 2, 1];

/** Rec. 601 luma. Same weighting `core/cv/enhance.ts` uses, so the two agree. */
export function toGray(image: RgbaImage): GrayImage {
  const { rgba, width, height } = image;
  const data = new Uint8Array(width * height);
  for (let p = 0; p < width * height; p++) {
    data[p] = Math.round(0.299 * rgba[p * 4] + 0.587 * rgba[p * 4 + 1] + 0.114 * rgba[p * 4 + 2]);
  }
  return { data, width, height };
}

/** Box-average resample. Nearest-neighbour aliases fine logo detail into noise. */
export function resizeGray(source: GrayImage, width: number, height: number): GrayImage {
  if (width === source.width && height === source.height) return source;
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const sy0 = Math.floor((y * source.height) / height);
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * source.height) / height));
    for (let x = 0; x < width; x++) {
      const sx0 = Math.floor((x * source.width) / width);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * source.width) / width));
      let sum = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          sum += source.data[sy * source.width + sx];
          n += 1;
        }
      }
      data[y * width + x] = Math.round(sum / n);
    }
  }
  return { data, width, height };
}

/** The sub-rectangle of `image` named by a unit-space rect (y up from bottom). */
export function cropUnitRect(image: RgbaImage, rect: UnitRect): RgbaImage | null {
  const x0 = Math.max(0, Math.floor(rect.x * image.width));
  const x1 = Math.min(image.width, Math.ceil((rect.x + rect.width) * image.width));
  const y0 = Math.max(0, Math.floor((1 - rect.y - rect.height) * image.height));
  const y1 = Math.min(image.height, Math.ceil((1 - rect.y) * image.height));
  const width = x1 - x0;
  const height = y1 - y0;
  if (width <= 0 || height <= 0) return null;

  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const from = ((y + y0) * image.width + x0) * 4;
    rgba.set(image.rgba.subarray(from, from + width * 4), y * width * 4);
  }
  return { rgba, width, height };
}

export interface TemplateMatch extends UnitRect {
  /** ZNCC score of the match, 0..1. */
  score: number;
}

/**
 * Finds every place `needle` appears in `haystack`, as unit-space rectangles.
 *
 * Two passes, because a single-pixel-stride search at a useful resolution is
 * tens of millions of multiply-adds and would blow the worker's time budget on
 * a page of photographs.
 *
 * The first pass searches a **quarter-size copy of both** field and template,
 * at stride 1, and the second re-scores a few pixels around each hit at full
 * search resolution. Reducing both signals is the part that matters, and the
 * obvious cheaper alternative — searching the full-size field on a coarse grid
 * — was tried and does not work: correlation against a patch with any fine
 * detail collapses two pixels off the peak, so a strided grid steps straight
 * over real matches. Downsampling low-passes the detail away instead of
 * skipping it, which leaves a correlation surface that is genuinely smooth
 * rather than assumed to be.
 */
export function matchTemplate(
  haystack: RgbaImage,
  needle: RgbaImage,
  options: TemplateMatchOptions = {}
): TemplateMatch[] {
  const minScore = options.minScore ?? DEFAULT_LOGO_MIN_SCORE;
  const searchEdge = options.searchEdge ?? DEFAULT_SEARCH_EDGE;
  const scales = options.scales ?? DEFAULT_SCALES;
  const maxMatches = options.maxMatches ?? DEFAULT_MAX_MATCHES;

  const longest = Math.max(haystack.width, haystack.height);
  const ratio = longest > searchEdge ? searchEdge / longest : 1;
  const searchWidth = Math.max(1, Math.round(haystack.width * ratio));
  const searchHeight = Math.max(1, Math.round(haystack.height * ratio));
  const field = resizeGray(toGray(haystack), searchWidth, searchHeight);
  const sums = integral(field);
  /** Reduced copies of the field, built once and shared across the scale ladder. */
  const pyramid = new Map<number, { field: GrayImage; sums: Integral }>();
  const level = (factor: number) => {
    let entry = pyramid.get(factor);
    if (!entry) {
      const reduced =
        factor === 1
          ? field
          : resizeGray(
              field,
              Math.max(1, Math.floor(searchWidth / factor)),
              Math.max(1, Math.floor(searchHeight / factor))
            );
      entry = { field: reduced, sums: factor === 1 ? sums : integral(reduced) };
      pyramid.set(factor, entry);
    }
    return entry;
  };

  const templateGray = toGray(needle);
  const found: TemplateMatch[] = [];

  for (const scale of scales) {
    const tw = Math.round(needle.width * ratio * scale);
    const th = Math.round(needle.height * ratio * scale);
    if (tw < MIN_TEMPLATE_EDGE || th < MIN_TEMPLATE_EDGE) continue;
    if (tw > searchWidth || th > searchHeight) continue;

    const template = resizeGray(templateGray, tw, th);
    const stats = zeroMean(template);
    // A flat patch has no signal to correlate against — every window would
    // score 1 or NaN. Refusing is better than blurring the whole page.
    if (stats.norm === 0) continue;

    // The largest reduction that still leaves a template big enough to mean
    // something. A 6×6 patch is the floor: below that, "correlation" is noise.
    const factor =
      PYRAMID_FACTORS.find(
        candidate =>
          Math.floor(tw / candidate) >= MIN_TEMPLATE_EDGE &&
          Math.floor(th / candidate) >= MIN_TEMPLATE_EDGE
      ) ?? 1;
    const coarse = level(factor);
    const coarseW = Math.max(MIN_TEMPLATE_EDGE, Math.floor(tw / factor));
    const coarseH = Math.max(MIN_TEMPLATE_EDGE, Math.floor(th / factor));
    const coarseStats = zeroMean(resizeGray(template, coarseW, coarseH));
    if (coarseStats.norm === 0) continue;

    const candidates: { x: number; y: number; score: number }[] = [];
    for (let y = 0; y + coarseH <= coarse.field.height; y++) {
      for (let x = 0; x + coarseW <= coarse.field.width; x++) {
        const score = zncc(coarse.field, coarse.sums, x, y, coarseStats, coarseW, coarseH);
        if (score > minScore - COARSE_SLACK) {
          candidates.push({ x: x * factor, y: y * factor, score });
        }
      }
    }

    // Cheap ceiling on the fine pass: a repetitive page can nominate thousands
    // of windows and each one costs a (2·factor+1)² re-scan. Taking the
    // strongest first keeps the real peaks, which always out-score their own
    // neighbourhood.
    candidates.sort((a, b) => b.score - a.score);
    for (const candidate of candidates.slice(0, MAX_REFINEMENTS)) {
      let best = { x: candidate.x, y: candidate.y, score: -Infinity };
      const x0 = Math.max(0, candidate.x - factor);
      const y0 = Math.max(0, candidate.y - factor);
      const x1 = Math.min(searchWidth - tw, candidate.x + factor);
      const y1 = Math.min(searchHeight - th, candidate.y + factor);
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const score = zncc(field, sums, x, y, stats, tw, th);
          if (score > best.score) best = { x, y, score };
        }
      }
      if (best.score < minScore) continue;
      found.push({
        x: best.x / searchWidth,
        y: 1 - (best.y + th) / searchHeight,
        width: tw / searchWidth,
        height: th / searchHeight,
        score: best.score
      });
    }
  }

  return suppressOverlaps(found, maxMatches);
}

interface Integral {
  sum: Float64Array;
  sumSquares: Float64Array;
  width: number;
}

/** Summed-area tables, so a window's mean and variance are four lookups. */
function integral(image: GrayImage): Integral {
  const w = image.width + 1;
  const h = image.height + 1;
  const sum = new Float64Array(w * h);
  const sumSquares = new Float64Array(w * h);
  for (let y = 1; y < h; y++) {
    let rowSum = 0;
    let rowSquares = 0;
    for (let x = 1; x < w; x++) {
      const value = image.data[(y - 1) * image.width + (x - 1)];
      rowSum += value;
      rowSquares += value * value;
      sum[y * w + x] = sum[(y - 1) * w + x] + rowSum;
      sumSquares[y * w + x] = sumSquares[(y - 1) * w + x] + rowSquares;
    }
  }
  return { sum, sumSquares, width: w };
}

function windowSum(table: Float64Array, w: number, x: number, y: number, tw: number, th: number) {
  return (
    table[(y + th) * w + x + tw] -
    table[y * w + x + tw] -
    table[(y + th) * w + x] +
    table[y * w + x]
  );
}

interface TemplateStats {
  /** Template values with their mean removed. */
  centred: Float64Array;
  /** Euclidean norm of `centred`. */
  norm: number;
}

function zeroMean(template: GrayImage): TemplateStats {
  const n = template.width * template.height;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += template.data[i];
  mean /= n;
  const centred = new Float64Array(n);
  let squares = 0;
  for (let i = 0; i < n; i++) {
    const value = template.data[i] - mean;
    centred[i] = value;
    squares += value * value;
  }
  return { centred, norm: Math.sqrt(squares) };
}

/**
 * ZNCC of the template against the window at `(x, y)`.
 *
 * `Σ(f - f̄)(t - t̄)` reduces to `Σ f·t̃` once the template is already
 * zero-mean, because `Σ t̃ = 0` kills the `f̄` term — so the window's own mean
 * never has to be subtracted pixel by pixel, only its norm computed, and that
 * comes from the summed-area tables in constant time.
 */
function zncc(
  field: GrayImage,
  sums: Integral,
  x: number,
  y: number,
  stats: TemplateStats,
  tw: number,
  th: number
): number {
  const n = tw * th;
  const total = windowSum(sums.sum, sums.width, x, y, tw, th);
  const totalSquares = windowSum(sums.sumSquares, sums.width, x, y, tw, th);
  const variance = totalSquares - (total * total) / n;
  if (variance <= 1e-6) return 0;

  let cross = 0;
  for (let ty = 0; ty < th; ty++) {
    const fieldRow = (y + ty) * field.width + x;
    const templateRow = ty * tw;
    for (let tx = 0; tx < tw; tx++) {
      cross += field.data[fieldRow + tx] * stats.centred[templateRow + tx];
    }
  }
  return cross / (Math.sqrt(variance) * stats.norm);
}

/**
 * Greedy non-maximum suppression.
 *
 * The scale ladder and the fine pass both produce several near-identical hits
 * on one logo; without this the same graphic is reported five times and
 * mosaicked five times, which is harmless but makes the report a lie about how
 * many logos are on the page.
 */
function suppressOverlaps(matches: TemplateMatch[], limit: number): TemplateMatch[] {
  const sorted = [...matches].sort((a, b) => b.score - a.score);
  const kept: TemplateMatch[] = [];
  for (const candidate of sorted) {
    if (kept.some(existing => intersectionOverUnion(existing, candidate) > 0.3)) continue;
    kept.push(candidate);
    if (kept.length >= limit) break;
  }
  return kept;
}

export function intersectionOverUnion(a: UnitRect, b: UnitRect): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  if (x1 <= x0 || y1 <= y0) return 0;
  const overlap = (x1 - x0) * (y1 - y0);
  return overlap / (a.width * a.height + b.width * b.height - overlap);
}
