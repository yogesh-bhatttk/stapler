/**
 * CNV-12 — where a page actually *draws* each of its image XObjects.
 *
 * CNV-08 needed only "which images does this page hold", and CNV-06's
 * `extractImages` answers that from the page's `/Resources /XObject` dictionary.
 * A resource dictionary is unordered and says nothing about position, which is
 * why `blocks.ts` states outright that it does not reconstruct where an image sat
 * and appends images after the page's text instead.
 *
 * A slide has no "after the text". One slide per page, at the page's own size,
 * only means something if an image lands where the page drew it — so this module
 * answers the question the resource dictionary cannot: it walks the page's
 * **content stream** and reports the device-space rectangle of every `Do` that
 * paints an image.
 *
 * Nothing here is new machinery. The tokenizer, the parser, the matrix algebra
 * and the graphics-state stack are RED-02's (`interpreter.ts`), the same code
 * that decides which operators a redaction removes; this file is a second, much
 * smaller consumer of them. Writing a private content-stream walker for the
 * PowerPoint export would have meant two implementations of `q`/`Q`/`cm` that
 * could disagree about the same page.
 *
 * Two things it deliberately does *not* do:
 *
 *  • **It never decodes an image.** pdf.js can map an image to its object number
 *    (CMP-03 does exactly that, in `render.worker.ts`), but only by awaiting the
 *    decoded pixels — tens of megabytes and seconds of work for a number that is
 *    already written in the resource dictionary. The object number here comes
 *    from the `/XObject` entry's own indirect reference, resolved by the caller.
 *  • **It never guesses.** A `Do` whose resource cannot be resolved, or whose CTM
 *    is degenerate, produces no placement rather than a plausible-looking box.
 *    The caller reports the image as left out; see `slides.ts`.
 */

import { polygonBounds, type Box } from '../geometry';
import {
  multiplyMatrix,
  transformPoint,
  type Matrix,
  type Statement,
  type Token
} from './interpreter';

/** One `Do` that paints an image, measured in the page's own user space. */
export interface PlacedImage {
  /**
   * The `/XObject` resource name at the `Do`, without the slash. For an image
   * inside a Form XObject this is the name in the *form's* resource dictionary,
   * which is also the name CNV-06's `extractImages` reports for it — the two
   * walk the same nested dictionaries.
   */
  name: string;
  /**
   * Object number of the image's stream. `-1` when the resource entry is a
   * direct (non-indirect) object, which cannot be addressed by number and so
   * cannot be matched to an extracted file. Reported rather than dropped so the
   * caller can say what it left out.
   */
  objectNumber: number;
  /**
   * Axis-aligned bounds in unrotated **raw** page user space, y up from the
   * origin the content stream's own operands use — which is *not* necessarily
   * the corner of the page a reader sees. A `/MediaBox` may start anywhere and a
   * `/CropBox` usually does, so subtracting the displayed box's origin is the
   * caller's job; `convert/slides.ts` does it once, for text and pictures alike,
   * and the comment at this walker's call site in `process.worker.ts` says why
   * that is better than seeding a translated `initialCtm` here.
   */
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * False when the CTM rotated, skewed or mirrored the unit square, so drawing
   * the image upright inside the rectangle above is an approximation of what the
   * page paints. A caller that cannot reproduce the transform (a PowerPoint
   * picture frame can rotate, but only about its own centre) needs to know that.
   *
   * Note the mirror case: `[-w 0 0 h x y]` is *geometrically* axis-aligned — the
   * rectangle is its exact outline — but the image inside it is flipped, and a
   * caller that placed it without saying so would draw the page wrong and call
   * it exact. Same for a 180° turn, `[-w 0 0 -h x y]`, which has no skew at all.
   * Both are reported here as not axis-aligned, because the question every
   * caller is actually asking is "can I place this as-is?".
   */
  axisAligned: boolean;
}

/**
 * What the caller has to tell this walker about one `/XObject` resource. Modelled
 * on `interpreter.ts`'s `XObjectInfo` — the caller resolves names against pdf-lib
 * dictionaries, and this module stays free of a pdf-lib import so it can be unit
 * tested against literals.
 */
export type PlacementXObject =
  | { subtype: 'Image'; objectNumber: number }
  | {
      subtype: 'Form';
      /** The form's own `/Matrix`, applied before the CTM in force at the `Do`. */
      matrix?: Matrix;
      /**
       * The form's `/BBox`, as `[llx, lly, urx, ury]` in form space. Per spec a
       * form's content is clipped to it, so an image inside a form is reported
       * intersected with it — without that, a big image clipped to a small
       * window would be placed at its unclipped size, which is a visible lie
       * about the page.
       */
      bbox?: [number, number, number, number];
      /** The form's decoded content stream, already parsed. */
      statements: Statement[];
      /** Resolver for the *form's* own resource dictionary. */
      resolve: PlacementResolver;
    }
  | { subtype: 'Other' };

export type PlacementResolver = (name: string) => PlacementXObject | undefined;

/**
 * How deep a Form XObject chain is followed.
 *
 * A form may paint another form, and a malformed file may make that cycle. The
 * cap is what makes this terminate on hostile input without needing a visited
 * set that a legitimately repeated form would trip over (a letterhead drawn twice
 * is two placements, not a cycle). Eight is far past anything a real producer
 * nests; past it the images are simply not reported, which the caller discloses.
 */
export const MAX_FORM_DEPTH = 8;

/**
 * How many placements are collected before the walk stops.
 *
 * A pathological page can invoke one image thousands of times (a tiled
 * background). Each placement becomes a picture on the slide, and a deck with
 * 50,000 pictures on one slide is not a document. The caller reports the
 * overflow.
 */
export const MAX_PLACEMENTS_PER_PAGE = 400;

/** Below this, a matrix component counts as zero for the axis-aligned test. */
const SKEW_EPSILON = 1e-6;

/**
 * True when the image can be drawn upright inside the reported rectangle and
 * look like the page does.
 *
 * Two conditions, and the second one is the easy one to miss. Zero skew (`b`
 * and `c`) means the rectangle is the outline rather than a bounding box — but
 * a zero-skew matrix can still flip the unit square, and `[-w 0 0 h …]` (a
 * horizontal mirror) or `[-w 0 0 -h …]` (a 180° turn) draw an image that is not
 * the image a caller would place from these numbers alone. A negative scale
 * term is exactly that flip, so both are excluded. `unitSquareBounds` has
 * already rejected a zero scale by the time this is asked.
 */
function isAxisAligned(ctm: Matrix): boolean {
  if (Math.abs(ctm[1]) >= SKEW_EPSILON || Math.abs(ctm[2]) >= SKEW_EPSILON) return false;
  return ctm[0] > 0 && ctm[3] > 0;
}

function numberAt(operands: readonly Token[], index: number): number {
  const token = operands[index];
  if (!token) return NaN;
  return parseFloat(String.fromCharCode(...token.bytes));
}

function isMatrixOperands(operands: readonly Token[]): boolean {
  if (operands.length !== 6) return false;
  for (let i = 0; i < 6; i++) if (!Number.isFinite(numberAt(operands, i))) return false;
  return true;
}

/** The last name operand of a statement, without its slash. `''` when absent. */
function nameOperand(operands: readonly Token[]): string {
  const token = operands[operands.length - 1];
  if (!token || token.type !== 'name') return '';
  return String.fromCharCode(...token.bytes).slice(1);
}

/**
 * A quadrilateral through `ctm`, as an axis-aligned box in device space.
 *
 * The min/max is `geometry.ts`'s `polygonBounds` — the same one RED-07's marks
 * are measured with — rather than a fourth hand-rolled copy of it. What is added
 * here is the two rejections a placement needs and a bounding box does not: a
 * corner that is not a finite number (a `cm` with a division by zero in it, or a
 * matrix a producer wrote as garbage), and a zero-area result, which is a
 * degenerate CTM painting no pixels. Reporting either would put an invisible,
 * unplaceable object on the slide.
 */
function transformedBounds(
  ctm: Matrix,
  corners: readonly (readonly [number, number])[]
): Box | null {
  const points = corners.map(([x, y]) => transformPoint(ctm, x, y));
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  }
  const box = polygonBounds(points);
  if (!(box.width > 0) || !(box.height > 0)) return null;
  return box;
}

/** The unit square through `ctm` — where an image XObject's `Do` paints. */
function unitSquareBounds(ctm: Matrix): Box | null {
  return transformedBounds(ctm, [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1]
  ]);
}

/** A form's `/BBox` through `ctm`, as an axis-aligned device-space box. */
function bboxBounds(
  ctm: Matrix,
  [llx, lly, urx, ury]: [number, number, number, number]
): Box | null {
  return transformedBounds(ctm, [
    [llx, lly],
    [urx, lly],
    [urx, ury],
    [llx, ury]
  ]);
}

/** `box` clipped to `clip`, or `null` when they do not meet. */
function intersect(box: Box | null, clip?: Box): Box | null {
  if (!box) return null;
  if (!clip) return box;
  const x = Math.max(box.x, clip.x);
  const y = Math.max(box.y, clip.y);
  const right = Math.min(box.x + box.width, clip.x + clip.width);
  const top = Math.min(box.y + box.height, clip.y + clip.height);
  if (!(right > x) || !(top > y)) return null;
  return { x, y, width: right - x, height: top - y };
}

/** What one page's walk found. */
export interface ImagePlacementScan {
  /** Every image `Do`, in the order the page paints them. */
  placements: PlacedImage[];
  /**
   * How many further image `Do`s were seen after the cap was reached. Reported
   * rather than silently dropped: a page that draws 1,200 tiles has to say so.
   */
  overflow: number;
}

/**
 * Every image `Do` in a page's content stream, in painting order.
 *
 * The same image drawn twice yields two placements. That is the point: a logo in
 * a header and again in a footer is two pictures on the slide, and collapsing
 * them (which CMP-03's own `imagePlacements` in `render.worker.ts` does, because
 * it only wants the largest size to re-encode at) would silently drop one.
 */
export function findImagePlacements(
  statements: readonly Statement[],
  resolve: PlacementResolver,
  initialCtm?: Matrix
): ImagePlacementScan {
  const scan: ImagePlacementScan = { placements: [], overflow: 0 };
  walk(statements, resolve, scan, { initialCtm, depth: 0 });
  return scan;
}

function walk(
  statements: readonly Statement[],
  resolve: PlacementResolver,
  scan: ImagePlacementScan,
  options: {
    initialCtm?: Matrix;
    depth: number;
    /** Device-space clip inherited from an enclosing form's `/BBox`. */
    clip?: { x: number; y: number; width: number; height: number };
  }
): void {
  const out = scan.placements;
  const depth = options.depth;
  let ctm: Matrix = options.initialCtm ? ([...options.initialCtm] as Matrix) : [1, 0, 0, 1, 0, 0];
  const stack: Matrix[] = [];

  for (const statement of statements) {
    const op = String.fromCharCode(...statement.operator.bytes);

    if (op === 'q') {
      stack.push([...ctm] as Matrix);
      continue;
    }
    if (op === 'Q') {
      // An unbalanced `Q` is common in generated files. Falling back to the
      // stream's initial CTM matches what every viewer does with one, and is the
      // same fallback `interpreter.ts` uses.
      ctm =
        stack.pop() ??
        (options.initialCtm ? ([...options.initialCtm] as Matrix) : [1, 0, 0, 1, 0, 0]);
      continue;
    }
    if (op === 'cm') {
      if (isMatrixOperands(statement.operands)) {
        const m = Array.from({ length: 6 }, (_, i) => numberAt(statement.operands, i)) as Matrix;
        ctm = multiplyMatrix(m, ctm);
      }
      continue;
    }
    if (op !== 'Do') continue;

    const name = nameOperand(statement.operands);
    if (!name) continue;
    const info = resolve(name);
    if (!info) continue;

    if (info.subtype === 'Image') {
      const bounds = intersect(unitSquareBounds(ctm), options.clip);
      if (!bounds) continue;
      if (out.length >= MAX_PLACEMENTS_PER_PAGE) {
        scan.overflow += 1;
        continue;
      }
      out.push({
        name,
        objectNumber: info.objectNumber,
        ...bounds,
        axisAligned: isAxisAligned(ctm)
      });
      continue;
    }

    if (info.subtype === 'Form') {
      if (depth >= MAX_FORM_DEPTH) continue;
      // The form's own `/Matrix` applies before the CTM in force at the `Do` —
      // the same composition order `interpreter.ts` uses to measure a form's
      // extent, so the two cannot disagree about where a form's content lands.
      const nested = info.matrix ? multiplyMatrix(info.matrix, ctm) : ctm;
      const clip = info.bbox
        ? intersect(bboxBounds(nested, info.bbox), options.clip)
        : options.clip;
      // A form whose `/BBox` does not meet the inherited clip paints nothing at
      // all, so its images are not on the page and must not be placed.
      if (info.bbox && !clip) continue;
      walk(info.statements, info.resolve, scan, {
        initialCtm: nested,
        depth: depth + 1,
        ...(clip ? { clip } : {})
      });
    }
  }
}
