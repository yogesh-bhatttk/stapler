/**
 * Pure geometry and pixel helpers used by the render worker.
 *
 * These live outside the worker module so unit tests can exercise them without
 * pulling in pdf.js and `Comlink.expose` — the reading-order heuristics and the
 * 1-bit unpacking are where the actual bugs hide, not in the pdf.js call.
 */
import { isRtlText } from './convert/text-direction';

/** A pdf.js text run, narrowed to the fields we depend on. */
export interface TextRun {
  str: string;
  /** [scaleX, skewY, skewX, scaleY, tx, ty] — tx/ty are the baseline origin. */
  transform: number[];
  width: number;
  height: number;
  /** True when pdf.js ended a line after this run. Used by RED-05's scanner. */
  hasEOL?: boolean;
}

/**
 * How far above the page's body size a line's type must be to read as a heading
 * (CNV-05's promotion rule). One constant, read by the Markdown export and by
 * CNV-08's DOCX export through {@link layoutLines}.
 */
const HEADING_SIZE_RATIO = 1.25;

/** How pdf.js labels the pixel layout of a decoded image. Mirrors `ImageKind`. */
export const IMAGE_KIND = {
  GRAYSCALE_1BPP: 1,
  RGB_24BPP: 2,
  RGBA_32BPP: 3
} as const;

/**
 * One reading-order line, with the runs it was assembled from still attached.
 *
 * CNV-04 only ever needed the `text`, so the grouping used to be inlined in
 * {@link layoutText} and threw the runs away. CNV-08 (PDF → DOCX) needs the same
 * lines *and* their runs — a run carries the font the DOCX writer turns into a
 * bold/italic `TextRun`, and a run's x-extent is what tells a table row's cells
 * apart from a sentence's words. Sharing this function is what keeps the two
 * exports agreeing about where a paragraph or a heading starts; a second copy of
 * the heuristics would drift from this one on the first tuning change.
 */
export interface LaidOutLine {
  /**
   * The line's own runs in reading order: left to right, or right to left on a
   * right-to-left line. Blank runs are kept. On a page whose text is set at an
   * angle these are upright copies of the runs (see `layoutLines`).
   */
  runs: TextRun[];
  /** Reading-order text, whitespace collapsed and trimmed. Never empty. */
  text: string;
  /** Baseline in PDF space, so a larger value is higher on the page. */
  baseline: number;
  /** The largest glyph size on the line. */
  maxSize: number;
  /** True when a paragraph-sized vertical gap separates this line from the last. */
  startsParagraph: boolean;
  /**
   * CNV-05's promotion rule: the line's type is well above the page's body size.
   * `layoutText` renders this as `## `; the DOCX writer renders it as a real
   * heading style.
   */
  isHeading: boolean;
}

export interface PageTextLayout {
  /** Non-empty lines, top to bottom. */
  lines: LaidOutLine[];
  /** The size covering the most characters on the page — see `dominantSize`. */
  bodySize: number;
}

/**
 * A run's type size whichever way it is turned: the length of its transformed
 * up-vector. `|d|` alone is the size only for upright text — a run turned 90°
 * has `d = 0` (CV3).
 */
export function runTypeSize(run: TextRun): number {
  const size = Math.hypot(run.transform[2], run.transform[3]);
  return Number.isFinite(size) ? size : 0;
}

/**
 * The horizontal gap between two runs of one line, whichever order they are
 * read in: positive when they are apart, negative when they overlap. A
 * right-to-left line is ordered right to left (CV5), so "the next run starts
 * after the previous one ends" is not the test there.
 */
export function runGap(previous: TextRun, run: TextRun): number {
  return Math.max(
    run.transform[4] - (previous.transform[4] + previous.width),
    previous.transform[4] - (run.transform[4] + run.width)
  );
}

/**
 * The baseline angle most of a page's text is set at, in whole degrees
 * (counter-clockwise), weighted by character count. 0 for an ordinary page.
 */
function dominantTextAngle(items: readonly TextRun[]): number {
  const weight = new Map<number, number>();
  for (const item of items) {
    const [a, b] = item.transform;
    if (!(Number.isFinite(a) && Number.isFinite(b)) || (a === 0 && b === 0)) continue;
    const degrees = Math.round((Math.atan2(b, a) * 180) / Math.PI);
    const angle = degrees === -180 ? 180 : degrees;
    weight.set(angle, (weight.get(angle) ?? 0) + Math.max(1, item.str.trim().length));
  }
  let best = 0;
  let bestWeight = -1;
  for (const [angle, total] of weight) {
    if (total > bestWeight || (total === bestWeight && angle === 0)) {
      bestWeight = total;
      best = angle;
    }
  }
  return best;
}

/**
 * CV3 — the runs of a page whose text is set at an angle (a sideways page
 * drawn upright under `/Rotate`, a landscape table turned on a portrait page),
 * turned by the inverse of that angle so their baselines run left to right
 * again. Each run is a copy (every other field kept) whose transform is the
 * original pre-multiplied by the inverse rotation, shifted so no coordinate is
 * negative. Grouping by raw `transform[5]` would otherwise put every word of
 * one line on its own "line" and read the page column by column.
 */
function uprightRuns(items: TextRun[], angle: number): TextRun[] {
  const radians = (angle * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  // Rotation by −angle: [x', y'] = [x cos + y sin, −x sin + y cos].
  const turned = items.map(item => {
    const [a, b, c, d, e, f] = item.transform;
    return {
      ...item,
      transform: [
        a * cos + b * sin,
        -a * sin + b * cos,
        c * cos + d * sin,
        -c * sin + d * cos,
        e * cos + f * sin,
        -e * sin + f * cos
      ]
    };
  });
  let minX = 0;
  let minY = 0;
  for (const item of turned) {
    minX = Math.min(minX, item.transform[4]);
    minY = Math.min(minY, item.transform[5]);
  }
  for (const item of turned) {
    item.transform[4] -= minX;
    item.transform[5] -= minY;
  }
  return turned;
}

/**
 * Groups runs into lines and lines into paragraphs, deciding for each line
 * whether a paragraph break precedes it and whether it reads as a heading.
 *
 * Pure geometry: no text is dropped, reordered beyond reading order, or
 * rewritten beyond collapsing runs of whitespace.
 *
 * When most of the page's text is set at an angle, the runs are first turned
 * upright ({@link uprightRuns}); the returned lines then carry those turned
 * copies, so every consumer measures gaps and columns along the text's own
 * baseline. A line that reads right to left (Hebrew, Arabic) is ordered right
 * to left (CV5).
 */
export function layoutLines(input: TextRun[]): PageTextLayout {
  if (input.length === 0) return { lines: [], bodySize: 12 };

  const angle = dominantTextAngle(input);
  const items = angle === 0 ? input : uprightRuns(input, angle);
  const bodySize = dominantSize(items);
  // Runs on one line share a baseline but not exactly — subscripts and mixed font
  // sizes shift it. Scale the tolerance to the type size rather than using a fixed
  // number of points.
  const tolerance = Math.max(2, bodySize * 0.4);

  // Only the most-recently-opened line can ever match: items are visited in
  // strictly non-increasing baseline order, so once an item's baseline falls
  // outside the *current* line's tolerance window (measured from that line's
  // first item), it is by construction further from every earlier line's
  // (higher) baseline too — no earlier line can ever match again. Scanning
  // just that one line instead of every line already opened turns this from
  // O(items × lines) into O(items), which matters for a table-heavy PDF with
  // thousands of text runs.
  const lines: TextRun[][] = [];
  for (const item of [...items].sort((a, b) => b.transform[5] - a.transform[5])) {
    const current = lines[lines.length - 1];
    if (current && Math.abs(current[0].transform[5] - item.transform[5]) <= tolerance) {
      current.push(item);
    } else {
      lines.push([item]);
    }
  }

  const baselines = lines.map(line => line[0].transform[5]);
  const paragraphGap = paragraphThreshold(baselines, bodySize);

  const out: LaidOutLine[] = [];
  let previousBaseline: number | null = null;

  for (const line of lines) {
    line.sort((a, b) => a.transform[4] - b.transform[4]);
    // CV5: a right-to-left line's first word is its rightmost run. pdf.js
    // already puts each run's own characters in logical order.
    if (isRtlText(line.map(run => run.str).join(''))) line.reverse();

    let text = '';
    let maxSize = 0;
    for (let i = 0; i < line.length; i++) {
      const item = line[i];
      const size = runTypeSize(item);
      maxSize = Math.max(maxSize, size);
      // A gap wider than roughly a space means the producer split the run instead
      // of emitting a space character.
      if (i > 0 && runGap(line[i - 1], item) > size * 0.25) text += ' ';
      text += item.str;
    }

    text = text.replace(/\s+/g, ' ').trim();
    // A line that carried nothing but whitespace is not a line. It is skipped
    // *before* `previousBaseline` moves, so the paragraph gap is measured between
    // lines that have text — otherwise a stray blank run would halve every gap.
    if (!text) continue;

    const baseline = line[0].transform[5];
    const startsParagraph = previousBaseline !== null && previousBaseline - baseline > paragraphGap;
    previousBaseline = baseline;

    out.push({
      runs: line,
      text,
      baseline,
      maxSize,
      startsParagraph,
      isHeading: maxSize >= bodySize * HEADING_SIZE_RATIO
    });
  }

  return { lines: out, bodySize };
}

/**
 * Groups runs into lines, lines into paragraphs, and returns reading-order text
 * (CNV-04). In `markdown` mode a line whose largest glyph is well above the page
 * median is promoted to a heading.
 */
export function layoutText(items: TextRun[], mode: 'text' | 'markdown'): string {
  const out: string[] = [];
  for (const line of layoutLines(items).lines) {
    if (line.startsParagraph) out.push('');
    out.push(mode === 'markdown' && line.isHeading ? `## ${line.text}` : line.text);
  }

  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The size that covers the most *characters*, not the median of the run sizes.
 *
 * A median over runs is skewed by a page's headings and footnotes — a two-run page of
 * a 24pt title and 12pt body has a median of 24, so the title never reads as larger
 * than the body and heading detection silently never fires.
 */
function dominantSize(items: TextRun[]): number {
  const weight = new Map<number, number>();
  for (const item of items) {
    // Round to the nearest point: the same font is often emitted at 11.999998.
    const size = Math.round(runTypeSize(item));
    if (size <= 0) continue;
    weight.set(size, (weight.get(size) ?? 0) + Math.max(1, item.str.trim().length));
  }
  let best = 12;
  let bestWeight = -1;
  for (const [size, total] of weight) {
    if (total > bestWeight) {
      bestWeight = total;
      best = size;
    }
  }
  return best;
}

/**
 * The vertical gap that means "new paragraph", calibrated from the page's own
 * leading.
 *
 * Deriving it from the font size instead does not work: single-spaced 12pt text leads
 * at ~14pt but double-spaced legal text leads at ~24pt, so any fixed multiple of the
 * type size either splits every line of a double-spaced document into its own
 * paragraph or never finds a break at all.
 */
function paragraphThreshold(baselines: number[], bodySize: number): number {
  const gaps: number[] = [];
  for (let i = 1; i < baselines.length; i++) {
    const gap = baselines[i - 1] - baselines[i];
    if (gap > 0) gaps.push(gap);
  }
  if (gaps.length < 3) return bodySize * 2.2;
  gaps.sort((a, b) => a - b);
  const typical = gaps[Math.floor(gaps.length / 2)];
  // Half again the usual leading: enough to clear ordinary line-height jitter,
  // tight enough to catch a real blank line.
  return typical * 1.5;
}

/**
 * Blank-page sensitivity (0..100 from the UI) → the ink coverage we still call
 * blank. A genuinely blank scan carries speckle, so even the strictest setting
 * tolerates a little; the loosest tolerates 1%, about one short line on A4.
 */
export function blankCoverageLimit(threshold: number): number {
  const clamped = Math.min(100, Math.max(0, threshold));
  return (clamped / 100) * 0.01;
}

/** Fraction of pixels darker than `cutoff`, over an RGBA buffer. */
export function inkCoverage(rgba: Uint8ClampedArray | Uint8Array, cutoff = 250): number {
  const pixels = rgba.length / 4;
  if (pixels === 0) return 0;
  let inked = 0;
  for (let p = 0; p < rgba.length; p += 4) {
    if ((rgba[p] + rgba[p + 1] + rgba[p + 2]) / 3 < cutoff) inked += 1;
  }
  return inked / pixels;
}

/**
 * Normalises a pdf.js image buffer to RGBA.
 *
 * Returns null for a layout we do not recognise: guessing wrong here silently
 * corrupts the image, and the compressor would then write that corruption into
 * the user's file. Refusing is the only safe answer (PLAN §5.2).
 */
// A 10,000×10,000 scan is already ~400MB as RGBA with nothing to catch a
// failed allocation; well above any real scanned page (a 600dpi A3 page is
// ~34 megapixels), so refusing past this is the same "guessing wrong here
// silently corrupts the image" refusal this function already applies to a
// layout it does not recognise, not a new failure mode.
const MAX_TOTAL_PIXELS = 40_000_000;

export function toRgba(
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  kind: number
): Uint8ClampedArray | null {
  if (width <= 0 || height <= 0 || width * height > MAX_TOTAL_PIXELS) return null;
  const rgba = new Uint8ClampedArray(width * height * 4);

  if (kind === IMAGE_KIND.RGBA_32BPP) {
    if (pixels.length < rgba.length) return null;
    rgba.set(pixels.subarray(0, rgba.length));
    return rgba;
  }

  if (kind === IMAGE_KIND.RGB_24BPP) {
    if (pixels.length < width * height * 3) return null;
    for (let src = 0, dst = 0; dst < rgba.length; src += 3, dst += 4) {
      rgba[dst] = pixels[src];
      rgba[dst + 1] = pixels[src + 1];
      rgba[dst + 2] = pixels[src + 2];
      rgba[dst + 3] = 255;
    }
    return rgba;
  }

  if (kind === IMAGE_KIND.GRAYSCALE_1BPP) {
    // One bit per pixel, MSB first, each row padded to a byte boundary. In
    // pdf.js's 1bpp output a set bit is white.
    const rowBytes = (width + 7) >> 3;
    if (pixels.length < rowBytes * height) return null;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const value = ((pixels[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1) === 1 ? 255 : 0;
        const dst = (y * width + x) * 4;
        rgba[dst] = value;
        rgba[dst + 1] = value;
        rgba[dst + 2] = value;
        rgba[dst + 3] = 255;
      }
    }
    return rgba;
  }

  return null;
}
