import { unsupported } from '../errors';
import { translate } from '../i18n';
import { polygonContainsBox, polygonOverlapsBox, type Point } from '../geometry';

export type TokenType =
  | 'string'
  | 'hexstring'
  | 'name'
  | 'number'
  | 'operator'
  | 'array_start'
  | 'array_end'
  | 'dict_start'
  | 'dict_end'
  | 'boolean'
  | 'null';

export interface Token {
  type: TokenType;
  bytes: Uint8Array;
}

export interface Statement {
  operands: Token[];
  operator: Token;
}

function isWhitespace(ch: number): boolean {
  return ch === 0x00 || ch === 0x09 || ch === 0x0a || ch === 0x0c || ch === 0x0d || ch === 0x20;
}

function isDelimiter(ch: number): boolean {
  return (
    ch === 0x28 || // (
    ch === 0x29 || // )
    ch === 0x3c || // <
    ch === 0x3e || // >
    ch === 0x5b || // [
    ch === 0x5d || // ]
    ch === 0x7b || // {
    ch === 0x7d || // }
    ch === 0x2f || // /
    ch === 0x25 // %
  );
}

export function tokenizeContentStream(bytes: Uint8Array): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < bytes.length) {
    const ch = bytes[i];

    if (isWhitespace(ch)) {
      i++;
      continue;
    }

    if (ch === 0x25) {
      // Comment %
      while (i < bytes.length && bytes[i] !== 0x0a && bytes[i] !== 0x0d) {
        i++;
      }
      continue;
    }

    if (ch === 0x28) {
      // String (...)
      const start = i;
      let depth = 1;
      i++;
      while (i < bytes.length && depth > 0) {
        if (bytes[i] === 0x5c) {
          // Escape \
          i += 2;
          continue;
        }
        if (bytes[i] === 0x28) depth++;
        else if (bytes[i] === 0x29) depth--;
        i++;
      }
      tokens.push({ type: 'string', bytes: bytes.slice(start, i) });
      continue;
    }

    if (ch === 0x3c) {
      // Hexstring <...> or Dict start <<
      if (i + 1 < bytes.length && bytes[i + 1] === 0x3c) {
        tokens.push({ type: 'dict_start', bytes: bytes.slice(i, i + 2) });
        i += 2;
      } else {
        const start = i;
        while (i < bytes.length && bytes[i] !== 0x3e) {
          i++;
        }
        if (i < bytes.length) i++; // Include >
        tokens.push({ type: 'hexstring', bytes: bytes.slice(start, i) });
      }
      continue;
    }

    if (ch === 0x3e) {
      // Dict end >>
      if (i + 1 < bytes.length && bytes[i + 1] === 0x3e) {
        tokens.push({ type: 'dict_end', bytes: bytes.slice(i, i + 2) });
        i += 2;
      } else {
        // Technically > by itself is invalid or part of hexstring missing start
        i++;
      }
      continue;
    }

    if (ch === 0x5b) {
      tokens.push({ type: 'array_start', bytes: bytes.slice(i, i + 1) });
      i++;
      continue;
    }

    if (ch === 0x5d) {
      tokens.push({ type: 'array_end', bytes: bytes.slice(i, i + 1) });
      i++;
      continue;
    }

    if (ch === 0x2f) {
      // Name /...
      const start = i;
      i++;
      while (i < bytes.length && !isWhitespace(bytes[i]) && !isDelimiter(bytes[i])) {
        i++;
      }
      tokens.push({ type: 'name', bytes: bytes.slice(start, i) });
      continue;
    }

    // Regular token (number, boolean, null, or operator)
    const start = i;
    while (i < bytes.length && !isWhitespace(bytes[i]) && !isDelimiter(bytes[i])) {
      i++;
    }
    const chunk = bytes.slice(start, i);
    const str = String.fromCharCode(...chunk);

    if (str === 'true' || str === 'false') {
      tokens.push({ type: 'boolean', bytes: chunk });
    } else if (str === 'null') {
      tokens.push({ type: 'null', bytes: chunk });
    } else if (/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(str)) {
      tokens.push({ type: 'number', bytes: chunk });
    } else {
      tokens.push({ type: 'operator', bytes: chunk });
    }
  }

  return tokens;
}

export function parseContentStream(tokens: Token[]): Statement[] {
  const statements: Statement[] = [];
  let currentOperands: Token[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === 'operator') {
      const op = String.fromCharCode(...token.bytes);
      statements.push({ operands: currentOperands, operator: token });
      currentOperands = [];

      // Inline images: the binary payload between ID and EI is not text-safe and
      // the tokenizer has already consumed it as garbage tokens. There is no way
      // to filter inline-image content without a full binary parser, so we refuse
      // rather than silently leaving the image bytes in the output stream — which
      // would produce a "verified" redaction that actually removed nothing.
      if (op === 'ID') {
        throw unsupported(
          translate(
            'This page contains inline images (the PDF ID operator), which cannot be ' +
              'safely removed by operator-level redaction. Open the file in a PDF editor ' +
              'that supports inline-image redaction, or rasterise the page first.'
          )
        );
      }
    } else {
      currentOperands.push(token);
    }
  }

  return statements;
}

export type Matrix = [number, number, number, number, number, number];

export interface SavedState {
  ctm: Matrix;
  textMatrix: Matrix;
  textLineMatrix: Matrix;
  fontSize: number;
  textLeading: number;
  charSpacing: number;
  wordSpacing: number;
  horizontalScale: number;
  fontName: string;
  fillPattern: string;
  strokePattern: string;
  lineWidth: number;
  lineCap: number;
  lineJoin: number;
  miterLimit: number;
  textRenderMode: number;
}

/**
 * The subset of the PDF graphics state this filter needs.
 *
 * `q` snapshots it and `Q` restores it. Both are O(1) — a fixed number of
 * six-element matrices and scalars, allocated per `q` and never copied again.
 * They are deliberately *not* implemented by cloning the saved-state stack:
 * doing that made every `q` copy every entry below it, so filtering cost
 * 2^depth and an Illustrator export nested 30 deep (routine) never returned.
 * See `tests/unit/interpreter.test.ts` for the depth-40 guard.
 */
export class GraphicsState {
  ctm: Matrix = [1, 0, 0, 1, 0, 0];
  textMatrix: Matrix = [1, 0, 0, 1, 0, 0];
  textLineMatrix: Matrix = [1, 0, 0, 1, 0, 0];
  fontSize: number = 0;
  /** Text leading, set by the TL operator. Used by T* (= `0 –TL Td`). */
  textLeading: number = 0;
  /** Tc — extra space added after every glyph, in unscaled text units. */
  charSpacing: number = 0;
  /** Tw — extra space added after every single-byte code 32. */
  wordSpacing: number = 0;
  /** Tz as a factor (100% → 1). Scales every horizontal advance. */
  horizontalScale: number = 1;
  /** The resource name from the last `Tf`, so widths can be looked up. */
  fontName: string = '';
  /**
   * HRD-41 — the `/Pattern` resource name the non-stroking (fill) colour was
   * last set to with `scn`, or `''` for any other colour. A name starting with
   * {@link INHERITED_PATTERN} was selected by an enclosing content stream and
   * cannot be resolved against this one's resources.
   */
  fillPattern: string = '';
  /** The same for the stroking colour (`SCN`). */
  strokePattern: string = '';
  /**
   * Stroke geometry (`w`, `J`, `j`, `M`), in user space at the paint. A
   * stroke's ink reaches past its path's points by up to half the line width —
   * further at a mitred corner or a projecting cap — so the extent a mark is
   * tested against has to include it.
   */
  lineWidth: number = 1;
  lineCap: number = 0;
  lineJoin: number = 0;
  miterLimit: number = 10;
  /**
   * `Tr` — text rendering mode. Modes 1, 2, 5 and 6 stroke the glyph outlines,
   * so their ink reaches past the glyph box by the stroke's reach, exactly as a
   * stroked path's does. Graphics state, not reset by `BT`/`ET`.
   */
  textRenderMode: number = 0;

  clone(): GraphicsState {
    const next = new GraphicsState();
    next.restoreSnapshot(this.saveSnapshot());
    return next;
  }

  saveSnapshot(): SavedState {
    return {
      ctm: [...this.ctm] as Matrix,
      textMatrix: [...this.textMatrix] as Matrix,
      textLineMatrix: [...this.textLineMatrix] as Matrix,
      fontSize: this.fontSize,
      textLeading: this.textLeading,
      charSpacing: this.charSpacing,
      wordSpacing: this.wordSpacing,
      horizontalScale: this.horizontalScale,
      fontName: this.fontName,
      fillPattern: this.fillPattern,
      strokePattern: this.strokePattern,
      lineWidth: this.lineWidth,
      lineCap: this.lineCap,
      lineJoin: this.lineJoin,
      miterLimit: this.miterLimit,
      textRenderMode: this.textRenderMode
    };
  }

  restoreSnapshot(s: SavedState): void {
    this.ctm = [...s.ctm] as Matrix;
    this.textMatrix = [...s.textMatrix] as Matrix;
    this.textLineMatrix = [...s.textLineMatrix] as Matrix;
    this.fontSize = s.fontSize;
    this.textLeading = s.textLeading;
    this.charSpacing = s.charSpacing;
    this.wordSpacing = s.wordSpacing;
    this.horizontalScale = s.horizontalScale;
    this.fontName = s.fontName;
    this.fillPattern = s.fillPattern;
    this.strokePattern = s.strokePattern;
    this.lineWidth = s.lineWidth;
    this.lineCap = s.lineCap;
    this.lineJoin = s.lineJoin;
    this.miterLimit = s.miterLimit;
    this.textRenderMode = s.textRenderMode;
  }
}

export function multiplyMatrix(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5]
  ];
}

export function transformPoint(m: Matrix, x: number, y: number): { x: number; y: number } {
  return {
    x: x * m[0] + y * m[2] + m[4],
    y: x * m[1] + y * m[3] + m[5]
  };
}

/**
 * Inverse of a PDF affine matrix, or `null` when it is singular (a degenerate
 * CTM — a zero scale — which maps the whole image to a line and cannot be
 * inverted). Callers must treat `null` as "the placement cannot be measured",
 * never as "nothing overlaps".
 */
export function invertMatrix(m: Matrix): Matrix | null {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

export function serializeStatements(statements: Statement[]): Uint8Array {
  // Rough estimate of size
  let size = 0;
  for (const s of statements) {
    for (const op of s.operands) size += op.bytes.length + 1;
    size += s.operator.bytes.length + 1;
  }

  const out = new Uint8Array(size);
  let pos = 0;

  for (const s of statements) {
    for (const op of s.operands) {
      out.set(op.bytes, pos);
      pos += op.bytes.length;
      out[pos++] = 0x20; // Space
    }
    out.set(s.operator.bytes, pos);
    pos += s.operator.bytes.length;
    out[pos++] = 0x0a; // Newline
  }

  return out.slice(0, pos);
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function intersects(r1: Rect, r2: Rect): boolean {
  return !(
    r2.x >= r1.x + r1.width ||
    r2.x + r2.width <= r1.x ||
    r2.y >= r1.y + r1.height ||
    r2.y + r2.height <= r1.y
  );
}

export function contains(container: Rect, target: Rect): boolean {
  return (
    target.x >= container.x - 1e-4 &&
    target.y >= container.y - 1e-4 &&
    target.x + target.width <= container.x + container.width + 1e-4 &&
    target.y + target.height <= container.y + container.height + 1e-4
  );
}

/**
 * One redaction mark, in whatever space the caller is working in (content space
 * here, an image's unit square in `redactionAreaInUnitSpace`).
 *
 * RED-07 added shaped marks as an **optional polygon on the existing rectangle**
 * rather than a second kind of mark: `x`/`y`/`width`/`height` always hold the
 * bounding box, so every consumer that only knows about rectangles — annotation
 * overlap, the drawn cover's fallback, the pixel verifier's render window — keeps
 * working unchanged, and only the two predicates below learn about shapes.
 */
export interface RedactionArea extends Rect {
  /** Closed polygon in the same space as the box, or absent for a plain rectangle. */
  polygon?: Point[];
}

/**
 * Does this mark touch `box` at all? The bounding box is tested first because it
 * is cheap and, for a plain rectangle mark, it is the whole answer — a shaped
 * mark then has to actually enclose part of the box.
 *
 * Without the second half, a shaped mark would remove everything in the corners
 * of its bounding box that the shape itself never covered.
 */
export function areaTouches(area: RedactionArea, box: Rect): boolean {
  if (!intersects(box, area)) return false;
  return area.polygon ? polygonOverlapsBox(area.polygon, box) : true;
}

/** Does this mark cover every part of `box`? */
export function areaCovers(area: RedactionArea, box: Rect): boolean {
  if (!contains(area, box)) return false;
  return area.polygon ? polygonContainsBox(area.polygon, box) : true;
}

export interface FilterContentStreamResult {
  filtered: Statement[];
  /** Graphics state at the end of this stream, to carry into the next chunk of a `/Contents` array. */
  finalState: GraphicsState;
  /**
   * Names of XObjects (from the `Do` operand) whose `Do` call was removed because
   * they overlapped a redaction region. The caller must delete these from the page's
   * `/Resources/XObject` dictionary so the image bytes are not recoverable from the
   * saved file even though the painting operator is gone.
   */
  strippedXObjectNames: string[];
  /**
   * Image XObjects a redaction rectangle *overlaps without fully containing*.
   *
   * Dropping the `Do` here would erase content the user did not mark, and
   * keeping it — which is what this module used to do, silently — leaves the
   * full-resolution image, redacted content and all, embedded in the output and
   * recoverable with `pdfimages`. The black rectangle painted on top is an
   * overlay, not a redaction.
   *
   * So the overlap is *reported* instead: the caller must black out the covered
   * pixels in the image itself, or refuse the operation. Never neither.
   */
  partialImageCoverage: PartialImageCoverage[];
  /**
   * Form XObject placements whose content a mark reached into. See
   * {@link FormRewrite} — the caller must create each replacement object and
   * retire the original name.
   */
  formRewrites: FormRewrite[];
  /**
   * HRD-41 — tiling patterns whose paint a mark reached, with the area of the
   * pattern's *cell* that the mark covers in any tile. The cell is a content
   * stream of its own that nothing on the page names directly, so the filter
   * cannot remove what it draws: the caller must filter the cell against these
   * areas and substitute the result, or refuse. A paint a mark reaches whose
   * every colour is such a pattern is *kept* (the pattern is what gets
   * redacted); any other paint a mark reaches is dropped, exactly as before.
   */
  patternFootprints: PatternFootprint[];
}

/**
 * HRD-41 — what the redaction filter needs to know about one `/Pattern`
 * resource. Only a tiling pattern (`/PatternType 1`) has content of its own;
 * a shading pattern is a gradient, and dropping its paint removes it.
 */
export interface PatternInfo {
  tiling: boolean;
  /** Pattern space, [llx, lly, urx, ury]. Absent when unreadable. */
  bbox?: [number, number, number, number];
  xStep?: number;
  yStep?: number;
  /** Pattern space → the default space of the stream that names it. */
  matrix?: Matrix;
}

/** The cell-space area of one tiling pattern that a mark covers. */
export interface PatternFootprint {
  /** The `/Pattern` resource name, without the slash. */
  name: string;
  /** In the cell's own space (pattern space with the tile offset removed). */
  rects: RedactionArea[];
}

/** Prefix of a pattern name selected by an enclosing stream (see `fillPattern`). */
export const INHERITED_PATTERN = '^';

/** Above this many tiles under one mark, the whole cell is treated as covered. */
const MAX_FOOTPRINT_TILES = 4096;
/** Above this many cell-space pieces, they are merged into their bounds. */
const MAX_FOOTPRINT_RECTS = 64;

/**
 * HRD-41 — the part of a tiling pattern's cell that `area` covers, wherever a
 * tile lands under it.
 *
 * A tiling pattern repeats its cell every `XStep`/`YStep` in pattern space, and
 * pattern space is fixed to the *default* space of the content stream that
 * names the pattern (`base`), not to the CTM at the paint — so the mark, clipped
 * to what the paint covers, is taken into pattern space and folded back onto the
 * cell tile by tile. A rotated pattern matrix makes the mark a rotated box in
 * pattern space; its bounds are used, which over-covers the cell rather than
 * under-covers it. When the mark spans more tiles than is worth enumerating, the
 * whole cell is returned: every part of it is under the mark somewhere.
 */
export function patternCellFootprint(
  info: PatternInfo,
  base: Matrix,
  area: RedactionArea,
  paintBox: Rect
): RedactionArea[] {
  const bbox = info.bbox!;
  const bx0 = Math.min(bbox[0], bbox[2]);
  const bx1 = Math.max(bbox[0], bbox[2]);
  const by0 = Math.min(bbox[1], bbox[3]);
  const by1 = Math.max(bbox[1], bbox[3]);
  const whole: RedactionArea[] = [{ x: bx0, y: by0, width: bx1 - bx0, height: by1 - by0 }];

  const cx0 = Math.max(area.x, paintBox.x);
  const cy0 = Math.max(area.y, paintBox.y);
  const cx1 = Math.min(area.x + area.width, paintBox.x + paintBox.width);
  const cy1 = Math.min(area.y + area.height, paintBox.y + paintBox.height);
  // A degenerate paint box (a hairline) still touched the mark; keep the mark.
  const clip =
    cx1 > cx0 && cy1 > cy0
      ? { x0: cx0, y0: cy0, x1: cx1, y1: cy1 }
      : { x0: area.x, y0: area.y, x1: area.x + area.width, y1: area.y + area.height };

  const inverse = invertMatrix(multiplyMatrix(info.matrix ?? [1, 0, 0, 1, 0, 0], base));
  if (!inverse) return whole;
  const corners = [
    transformPoint(inverse, clip.x0, clip.y0),
    transformPoint(inverse, clip.x1, clip.y0),
    transformPoint(inverse, clip.x1, clip.y1),
    transformPoint(inverse, clip.x0, clip.y1)
  ];
  const px0 = Math.min(...corners.map(c => c.x));
  const px1 = Math.max(...corners.map(c => c.x));
  const py0 = Math.min(...corners.map(c => c.y));
  const py1 = Math.max(...corners.map(c => c.y));
  if (![px0, px1, py0, py1].every(Number.isFinite)) return whole;
  const polygon = area.polygon?.map(p => transformPoint(inverse, p.x, p.y));

  const xs = Math.abs(info.xStep ?? 0);
  const ys = Math.abs(info.yStep ?? 0);
  if (!(xs > 0) || !(ys > 0)) return whole;
  const iMin = Math.floor((px0 - bx1) / xs) - 1;
  const iMax = Math.ceil((px1 - bx0) / xs) + 1;
  const jMin = Math.floor((py0 - by1) / ys) - 1;
  const jMax = Math.ceil((py1 - by0) / ys) + 1;
  if ((iMax - iMin + 1) * (jMax - jMin + 1) > MAX_FOOTPRINT_TILES) return whole;

  const rects: RedactionArea[] = [];
  for (let i = iMin; i <= iMax; i++) {
    for (let j = jMin; j <= jMax; j++) {
      const ox = i * xs;
      const oy = j * ys;
      const x0 = Math.max(px0 - ox, bx0);
      const x1 = Math.min(px1 - ox, bx1);
      const y0 = Math.max(py0 - oy, by0);
      const y1 = Math.min(py1 - oy, by1);
      if (!(x1 > x0) || !(y1 > y0)) continue;
      const piece: RedactionArea = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
      if (polygon) piece.polygon = polygon.map(p => ({ x: p.x - ox, y: p.y - oy }));
      // A shaped mark keeps only the tiles its outline actually reaches.
      if (!piece.polygon || areaTouches(piece, piece)) rects.push(piece);
    }
  }
  if (rects.length <= MAX_FOOTPRINT_RECTS) return rects;
  const ux0 = Math.min(...rects.map(r => r.x));
  const uy0 = Math.min(...rects.map(r => r.y));
  const ux1 = Math.max(...rects.map(r => r.x + r.width));
  const uy1 = Math.max(...rects.map(r => r.y + r.height));
  return [{ x: ux0, y: uy0, width: ux1 - ux0, height: uy1 - uy0 }];
}

/**
 * One image XObject placement that a redaction rectangle partially covers.
 *
 * `rects` are in the image's own unit space — the unit square every PDF image is
 * drawn into, x rightwards and y *upwards* from the bottom-left corner, clipped
 * to [0,1]. Converting to pixels is `col = x * Width`, `row = (1 - y - height) *
 * Height`. Reported per placement, so an image drawn twice on one page
 * contributes two entries and the caller unions them.
 */
export interface PartialImageCoverage {
  /** The `/XObject` resource name from the `Do` operand, without the slash. */
  name: string;
  /**
   * Each covered area, as a box and — for a shaped mark (RED-07) — the polygon
   * inside it, both already mapped into the image's unit space.
   */
  rects: RedactionArea[];
}

/**
 * The axis-aligned area of `rect` (device space) inside the unit square that
 * `ctm` maps onto the page, or `null` when they do not meet.
 *
 * A rotated or skewed CTM turns the redaction rectangle into a rotated rectangle
 * in unit space; the bounding box of that is used, which over-covers rather than
 * under-covers. Over-covering a redaction destroys slightly more of the image
 * than asked for. Under-covering leaves the secret readable, so the bias is
 * deliberate and one-directional.
 */
export function redactionRectInUnitSpace(ctm: Matrix, rect: Rect): Rect | null {
  const inverse = invertMatrix(ctm);
  if (!inverse) return null;
  const corners = [
    transformPoint(inverse, rect.x, rect.y),
    transformPoint(inverse, rect.x + rect.width, rect.y),
    transformPoint(inverse, rect.x + rect.width, rect.y + rect.height),
    transformPoint(inverse, rect.x, rect.y + rect.height)
  ];
  const x0 = Math.max(0, Math.min(...corners.map(c => c.x)));
  const y0 = Math.max(0, Math.min(...corners.map(c => c.y)));
  const x1 = Math.min(1, Math.max(...corners.map(c => c.x)));
  const y1 = Math.min(1, Math.max(...corners.map(c => c.y)));
  if (!(x1 > x0) || !(y1 > y0)) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * The same mapping for a whole mark: the box exactly as above, plus a shaped
 * mark's polygon carried through the same inverse CTM.
 *
 * The polygon is *not* clipped to the unit square — the caller rasterises it
 * against the image's own pixel grid, where anything outside is simply never
 * visited, and clipping a concave shape here would need real polygon clipping to
 * avoid inventing edges the user never drew. The box stays clipped, so it remains
 * the tight bound the pixel loop iterates.
 */
export function redactionAreaInUnitSpace(ctm: Matrix, area: RedactionArea): RedactionArea | null {
  const box = redactionRectInUnitSpace(ctm, area);
  if (!box) return null;
  if (!area.polygon) return box;
  const inverse = invertMatrix(ctm);
  if (!inverse) return box;
  return {
    ...box,
    polygon: area.polygon.map(p => transformPoint(inverse, p.x, p.y))
  };
}

/**
 * What's needed to compute a Form XObject's true device-space extent. Unlike an
 * image (which always occupies the unit square in its own space), a Form's
 * extent is its own `/BBox`, optionally transformed by its own `/Matrix`, before
 * the page's CTM is applied. Treating every `Do` as a unit square — which this
 * module used to do — silently gave every Form XObject invocation a bogus tiny
 * box, so a Form's content could never be detected as overlapping a redaction
 * region and was never stripped, however large it actually was on the page.
 */
export interface XObjectInfo {
  subtype: 'Form' | 'Image' | 'Unknown';
  /** Form space, as [llx, lly, urx, ury]. Unused for images. */
  bbox?: [number, number, number, number];
  /** Form's own transform, applied before the page CTM. Unused for images. */
  matrix?: Matrix;
  /**
   * HRD-41 — an image with `/ImageMask true`: a stencil that paints the
   * current *fill colour* through its set samples. Filled with a tiling
   * pattern, it shows that pattern's cell, so the cell under the mark has to be
   * redacted as well as the stencil.
   */
  imageMask?: boolean;
  /**
   * The Form's own content, so a mark that covers only part of it can be
   * resolved by looking *inside* rather than refused. Absent when the caller
   * could not decode the stream, or would not (a form that nests into itself,
   * or deeper than {@link MAX_FORM_DEPTH}).
   */
  content?: FormContent;
}

/**
 * One Form XObject's parsed content plus the resolvers its own `/Resources`
 * imply — decoded by the caller, because decoding is asynchronous and this
 * module is not.
 */
export interface FormContent {
  statements: Statement[];
  resolveXObject?: (name: string) => XObjectInfo | undefined;
  resolveFont?: (name: string) => FontInfo | undefined;
  /** HRD-41 — the form's own `/Pattern` resources. */
  resolvePattern?: (name: string) => PatternInfo | undefined;
  /** The form's own `/ExtGState` resources (see {@link ExtGStateInfo}). */
  resolveExtGState?: (name: string) => ExtGStateInfo | undefined;
}

/**
 * The stroke parameters one `/ExtGState` resource sets, as read for the
 * redaction filter. A key the dictionary does not carry is absent and leaves
 * the graphics state alone; `/D` (dash) is deliberately not represented — a
 * dash pattern only ever removes ink from a stroke, so the undashed extent is
 * already an upper bound on it.
 *
 * A resolver returns `undefined` for a name it cannot resolve (missing from
 * the dictionary, not a dictionary, or a stroke key whose value is not a
 * number). The filter then treats the line width as **unknown** — see
 * {@link UNKNOWN_STROKE_REACH} — rather than as unchanged, because an
 * unchanged width under-measures a `/LW 20` it could not read.
 */
export interface ExtGStateInfo {
  lineWidth?: number;
  lineCap?: number;
  lineJoin?: number;
  miterLimit?: number;
}

/**
 * How far, in device space, a stroke whose line width is unknown is assumed to
 * reach: further than any page (14 400 units is the largest a PDF page may
 * be), so every stroke painted under an unreadable `/ExtGState` is treated as
 * touching every mark on the page. That over-removes strokes rather than
 * refusing the redaction; leaving one whose ink entered a mark is not an option.
 */
export const UNKNOWN_STROKE_REACH = 1e6;

/**
 * A Form XObject placement whose content had to change, and the replacement
 * that was emitted in its place.
 *
 * The filtered content is *not* written back over the original form: one form
 * is routinely drawn at several places on a page, and only some of those
 * placements fall under a mark. So each placement that changed gets its own
 * object, and the caller defines {@link newName} in whichever resource
 * dictionary the `Do` was resolved against — the page's for a top-level
 * rewrite, the enclosing rewritten form's for a {@link nested} one.
 *
 * The caller must also drop the original name once no surviving `Do` still
 * uses it: the unfiltered form still holds the text the mark covered, and
 * leaving it named by the page leaves it in the saved bytes.
 */
export interface FormRewrite {
  /** The `/XObject` resource name the original `Do` used, without the slash. */
  originalName: string;
  /** The name the emitted `Do` now uses. */
  newName: string;
  /** The form's content after filtering, to be written as the new stream. */
  filtered: Statement[];
  /** Rewrites made inside this form, scoped to *its* `/Resources/XObject`. */
  nested: FormRewrite[];
}

/** How deep a chain of forms drawing forms is followed before giving up. */
const MAX_FORM_DEPTH = 8;

/** Extra wiring `filterContentStream` needs to rewrite forms rather than refuse. */
export interface FormRecursionOptions {
  /**
   * Returns a resource name not used anywhere in the page's XObject
   * dictionaries. Without one, a partial overlap with a form is refused
   * exactly as it was before recursion existed.
   */
  allocateFormName: () => string;
  /** Current nesting depth; callers leave this at its default. */
  depth?: number;
  /** HRD-41 — this stream's `/Pattern` resources. */
  resolvePattern?: (name: string) => PatternInfo | undefined;
  /**
   * This stream's `/ExtGState` resources. Absent means none could be read:
   * every `gs` then makes the line width unknown (fail closed).
   */
  resolveExtGState?: (name: string) => ExtGStateInfo | undefined;
  /**
   * HRD-41 — the default space of this content stream, which pattern space is
   * fixed to: identity for a page, the form's matrix at its `Do` for a form.
   */
  patternBase?: Matrix;
}

/**
 * What a font resource has to tell us to measure a string.
 *
 * The old model was `bytes.length * fontSize * 0.6` for every font in every
 * document. That is wrong twice over on a `/Type0` font: the codes are
 * two bytes, so a ten-glyph CJK run was counted as twenty glyphs, and CJK
 * glyphs are full-width, not 0.6em. The estimate is also fed back into the text
 * matrix, so the error compounds across a BT/ET block until a run's measured box
 * sits in a different part of the page from the glyphs it describes — and a
 * redaction that misses its box leaves the text in the file.
 *
 * `widths` is in glyph space, keyed by character code — which is exactly how
 * both `/Widths` (simple fonts) and `/W` (CID fonts) are indexed. Glyph space
 * is 1/1000 em for every font type *except* `/Type3`, which declares its own
 * `/FontMatrix`; see {@link FontInfo.glyphSpaceScale}.
 */
export interface FontInfo {
  /**
   * True for composite fonts whose CMap uses two-byte codes (`/Type0` with
   * `/Identity-H` and friends). Decides whether a string's bytes are counted
   * singly or in pairs.
   */
  twoByte: boolean;
  /** Character code → width in glyph space. */
  widths?: Map<number, number>;
  /** Width for any code not in `widths`, in glyph space. */
  defaultWidth?: number;
  /**
   * Glyph space → text space, as the horizontal scale factor every width here
   * is multiplied by. `1/1000` (the default when this is absent) for every
   * font whose glyph space the spec fixes at 1/1000 em.
   *
   * A `/Type3` font does not have one: it carries its own `/FontMatrix`, and
   * its `/Widths` are in whatever units that matrix maps to text space — 1 unit
   * per em for `[1 0 0 1 0 0]`, 2048 for a hinted outline conversion, anything
   * at all for the `dvips`/LaTeX bitmap fonts that produce most Type 3 in the
   * wild. Measuring those through the fixed 1/1000 made a 10-glyph, 24pt run
   * spanning ~144pt of page measure ~0.14pt wide, so no mark could ever be
   * found to overlap it; `checkRegionText` then caught the mismatch and refused
   * every save, which is safe but makes redaction unusable on the document.
   */
  glyphSpaceScale?: number;
  /**
   * An upper bound on the advance of *any* glyph in this font, in glyph space —
   * the widest entry in `widths`, `/MissingWidth`, and the `/FontBBox` span,
   * whichever is largest. Used **only** to widen the hit-testing box of a code
   * whose width had to be guessed, never to position anything.
   *
   * Why it exists: a font declared with no `/Widths` at all (a bare
   * `/BaseFont /Helvetica` reference, which every viewer resolves from its own
   * built-in standard-14 metrics) used to be measured at a flat 0.6 em per
   * glyph. Real Helvetica averages well above that, so the *estimated* run was
   * shorter than the run a viewer draws, and a mark over the end of such a run
   * intersected nothing — RED-02's own pass left the marked glyphs in the file
   * and only RED-03's independent re-scan caught it. Measuring the coverage box
   * against this bound instead makes the estimate err wide, which over-removes
   * at worst; erring narrow leaves the secret readable.
   */
  maxGlyphWidth?: number;
}

/**
 * Fallback advance when the font resource says nothing, in **em** rather than
 * glyph space: a guess about a typical glyph is a guess about a fraction of the
 * type size, and it must not change meaning just because the font declared an
 * unusual `/FontMatrix`.
 */
const FALLBACK_SIMPLE_EM = 0.6;
const FALLBACK_CID_EM = 1;

/**
 * Coverage bound for a guessed width when the font declares nothing to bound it
 * with (no `/Widths`, no `/MissingWidth`, no `/FontBBox`): one full em, which is
 * wider than all but a handful of glyphs in any text face.
 */
const FALLBACK_MAX_GLYPH_EM = 1;

/** Glyph space → text space for every font whose glyph space the spec fixes. */
const DEFAULT_GLYPH_SPACE_SCALE = 1 / 1000;

/**
 * The bytes a `(...)` or `<...>` operand actually denotes.
 *
 * The tokenizer keeps the raw source bytes including delimiters and escapes, so
 * counting them directly counts backslashes and hex digits as glyphs.
 */
export function decodeStringToken(token: Token): Uint8Array {
  const raw = token.bytes;
  if (token.type === 'hexstring') {
    const digits: number[] = [];
    for (let i = 1; i < raw.length; i++) {
      const ch = raw[i];
      if (ch === 0x3e) break; // >
      const v =
        ch >= 0x30 && ch <= 0x39
          ? ch - 0x30
          : ch >= 0x41 && ch <= 0x46
            ? ch - 0x37
            : ch >= 0x61 && ch <= 0x66
              ? ch - 0x57
              : -1;
      if (v >= 0) digits.push(v);
    }
    // An odd number of digits is padded with a trailing zero (PDF 32000 7.3.4.3).
    if (digits.length % 2 === 1) digits.push(0);
    const out = new Uint8Array(digits.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = (digits[2 * i] << 4) | digits[2 * i + 1];
    return out;
  }

  const out: number[] = [];
  // Skip the opening '(' and stop before the closing ')'.
  const end = raw.length > 0 && raw[raw.length - 1] === 0x29 ? raw.length - 1 : raw.length;
  for (let i = 1; i < end; i++) {
    const ch = raw[i];
    if (ch !== 0x5c) {
      out.push(ch);
      continue;
    }
    const next = raw[++i];
    if (next === undefined) break;
    switch (next) {
      case 0x6e:
        out.push(0x0a);
        break; // \n
      case 0x72:
        out.push(0x0d);
        break; // \r
      case 0x74:
        out.push(0x09);
        break; // \t
      case 0x62:
        out.push(0x08);
        break; // \b
      case 0x66:
        out.push(0x0c);
        break; // \f
      case 0x0a:
        break; // line continuation
      case 0x0d:
        if (raw[i + 1] === 0x0a) i++;
        break;
      default:
        if (next >= 0x30 && next <= 0x37) {
          let value = next - 0x30;
          for (let k = 0; k < 2; k++) {
            const d = raw[i + 1];
            if (d === undefined || d < 0x30 || d > 0x37) break;
            value = value * 8 + (d - 0x30);
            i++;
          }
          out.push(value & 0xff);
        } else {
          out.push(next);
        }
    }
  }
  return Uint8Array.from(out);
}

/**
 * One glyph of a show-string, measured in unscaled text-space units — the space
 * the text matrix's translation lives in, with `Tz` already folded in.
 */
interface GlyphAdvance {
  /** Byte range of this glyph's character code inside the decoded string. */
  start: number;
  end: number;
  /**
   * The metric advance: the best available estimate, and the only number ever
   * fed back into the text matrix or written out as a replacement displacement.
   */
  advance: number;
  /**
   * An upper bound on the advance, never smaller than `advance`. Identical to it
   * whenever the width came out of the font's own `/Widths`/`/W` table (the
   * overwhelming majority of runs, so the coverage box stays tight); wider only
   * where the width had to be guessed. See {@link FontInfo.maxGlyphWidth}.
   */
  coverAdvance: number;
  /**
   * True when `advance` came out of the font's own metrics rather than a guess.
   *
   * A run is split glyph by glyph only when *every* glyph in it is exact. A
   * guessed width is not merely imprecise, it is imprecise in an unknown
   * *direction*: the flat 0.6 em fallback over-measures Helvetica prose by a
   * fifth (real average, for mixed text, is nearer 0.48 em) and under-measures a
   * bold heading — and the error compounds along the run, so a cursor built on
   * guesses can sit well to the left *or* the right of the glyph it claims to
   * describe. A split made on that can cut in the wrong place, leaving some of
   * the marked glyphs behind while taking unmarked ones. Whichever way it lands
   * that is a half-processed redaction, so such a run falls back to
   * whole-operator removal, which cannot leave part of the mark behind.
   */
  exact: boolean;
}

/**
 * Per-glyph advances of one show-string.
 *
 * Models what the spec actually says an advance is (PDF 32000 9.4.4): per glyph,
 * `(w/1000 · Tfs + Tc + Tw·isSpace) · Th`. `Tw` applies only to single-byte code
 * 32, never inside a two-byte CID code — applying it there is a classic
 * off-by-a-lot on CJK text.
 *
 * Per *glyph* rather than per string because a redaction mark is not obliged to
 * line up with a show operator: the common case, for nearly every producer, is a
 * whole line typeset as one `Tj` or one justified `TJ`, of which the user marked
 * one field. Measuring only the total makes that an all-or-nothing decision.
 */
function glyphAdvances(bytes: Uint8Array, state: GraphicsState, font?: FontInfo): GlyphAdvance[] {
  const twoByte = font?.twoByte ?? false;
  const fallbackEm = twoByte ? FALLBACK_CID_EM : FALLBACK_SIMPLE_EM;
  // Every declared width below is in the font's own glyph space, so it only
  // becomes a text-space advance through this. A Type 3 font sets it from its
  // `/FontMatrix`; everyone else is the spec's fixed 1/1000 em.
  const scale = font?.glyphSpaceScale ?? DEFAULT_GLYPH_SPACE_SCALE;
  const step = twoByte ? 2 : 1;
  const out: GlyphAdvance[] = [];

  const push = (start: number, end: number, code: number | null) => {
    // `/Widths` or `/W` for this exact code, else the font's declared default
    // (`/MissingWidth`, `/DW`) — both of which the spec makes authoritative.
    // A trailing half-code (`code === null`) is malformed input, never exact.
    const declared = code === null ? undefined : (font?.widths?.get(code) ?? font?.defaultWidth);
    const widthEm = declared !== undefined ? declared * scale : fallbackEm;
    // A width the font itself states is exact. A guessed one may be narrower
    // than the glyph a viewer actually draws, so its coverage bound must not be.
    const boundEm =
      declared !== undefined
        ? widthEm
        : Math.max(
            widthEm,
            font?.maxGlyphWidth !== undefined ? font.maxGlyphWidth * scale : FALLBACK_MAX_GLYPH_EM
          );
    const extra = state.charSpacing + (!twoByte && code === 32 ? state.wordSpacing : 0);
    out.push({
      start,
      end,
      advance: (widthEm * state.fontSize + extra) * state.horizontalScale,
      coverAdvance: (boundEm * state.fontSize + extra) * state.horizontalScale,
      exact: declared !== undefined
    });
  };

  let i = 0;
  for (; i + step <= bytes.length; i += step) {
    push(i, i + step, twoByte ? (bytes[i] << 8) | bytes[i + 1] : bytes[i]);
  }
  // A trailing odd byte in a two-byte string is malformed input; count it as one
  // more glyph rather than losing the width of whatever the viewer draws there.
  if (i < bytes.length) push(i, bytes.length, null);
  return out;
}

/**
 * One element of a text run in the order a viewer consumes it: a decoded
 * show-string's glyphs, or (inside a `TJ` array) a kerning displacement.
 */
type RunElement =
  | { kind: 'glyphs'; bytes: Uint8Array; glyphs: GlyphAdvance[] }
  | { kind: 'adjust'; token: Token; shift: number };

const ARRAY_START_TOKEN: Token = { type: 'array_start', bytes: Uint8Array.of(0x5b) };
const ARRAY_END_TOKEN: Token = { type: 'array_end', bytes: Uint8Array.of(0x5d) };

function asciiToken(type: TokenType, text: string): Token {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return { type, bytes };
}

/**
 * A PDF real, in fixed notation. Never exponential: `1e-7` reads back as a
 * number followed by an operator, which would corrupt the stream.
 */
function numberToken(value: number): Token {
  const fixed = (Number.isFinite(value) ? value : 0).toFixed(4);
  const trimmed = fixed.replace(/\.?0+$/, '');
  return asciiToken('number', trimmed === '' || trimmed === '-' ? '0' : trimmed);
}

const HEX_DIGITS = '0123456789ABCDEF';

/**
 * A show-string operand as a hex literal.
 *
 * Hex rather than `(...)`: the surviving slice of a run is an arbitrary byte
 * range of the original codes, and hex needs no escaping analysis to stay
 * byte-identical to what it replaces — for a two-byte CID font as much as a
 * simple one.
 */
function hexStringToken(bytes: Uint8Array): Token {
  let text = '<';
  for (const b of bytes) text += HEX_DIGITS[(b >> 4) & 0xf] + HEX_DIGITS[b & 0xf];
  return asciiToken('hexstring', `${text}>`);
}

function statementOf(operands: Token[], operator: string): Statement {
  return { operands, operator: asciiToken('operator', operator) };
}

/** A Form XObject's `/BBox`, in device space, under the matrix that places it. */
function formBoxOf(formCtm: Matrix, bbox: [number, number, number, number]): Rect {
  const [llx, lly, urx, ury] = bbox;
  const corners = [
    transformPoint(formCtm, llx, lly),
    transformPoint(formCtm, urx, lly),
    transformPoint(formCtm, urx, ury),
    transformPoint(formCtm, llx, ury)
  ];
  const xs = corners.map(c => c.x);
  const ys = corners.map(c => c.y);
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys)
  };
}

/**
 * Did the filter leave this statement list exactly as it found it?
 *
 * Identity, not equality: every statement the filter keeps unchanged is pushed
 * through by reference, and every statement it rewrites is a freshly built
 * object. So this answers "was anything removed, replaced or reordered" without
 * having to serialise and compare bytes.
 */
export function sameStatements(filtered: Statement[], original: Statement[]): boolean {
  if (filtered.length !== original.length) return false;
  for (let i = 0; i < filtered.length; i++) if (filtered[i] !== original[i]) return false;
  return true;
}

export function filterContentStream(
  statements: Statement[],
  redactionBoxes: RedactionArea[],
  initialState?: GraphicsState,
  resolveXObject?: (name: string) => XObjectInfo | undefined,
  resolveFont?: (name: string) => FontInfo | undefined,
  formOptions?: FormRecursionOptions
): FilterContentStreamResult {
  const filtered: Statement[] = [];
  const strippedXObjectNames: string[] = [];
  const partialImageCoverage: PartialImageCoverage[] = [];
  const formRewrites: FormRewrite[] = [];
  const formDepth = formOptions?.depth ?? 0;
  const state = initialState ? initialState.clone() : new GraphicsState();
  const savedStates: SavedState[] = [];
  const patternFootprints: PatternFootprint[] = [];
  const patternBase: Matrix = formOptions?.patternBase ?? [1, 0, 0, 1, 0, 0];

  /**
   * HRD-41 — what a colour set to pattern `name` paints with: nothing to look
   * into (`none`: not a pattern, or a name no resource defines, which viewers
   * paint as nothing), a gradient (`shading`), a cell of content (`tiling`), or
   * a pattern an enclosing stream selected (`inherited`).
   */
  const patternKind = (name: string): 'none' | 'shading' | 'tiling' | 'inherited' => {
    // No pattern resolver means the caller is not tracking patterns at all
    // (face/logo blur's image planning): every paint is judged on its own, as
    // it was before HRD-41, and nothing is recorded or refused for a pattern.
    if (!name || !formOptions?.resolvePattern) return 'none';
    if (name.startsWith(INHERITED_PATTERN)) return 'inherited';
    const info = formOptions?.resolvePattern?.(name);
    if (!info) return 'none';
    return info.tiling ? 'tiling' : 'shading';
  };

  /**
   * Records that `area` reached a paint (whose extent is `box`) in pattern
   * `name`. Returns whether the paint can be kept: only when the pattern's cell
   * is what will be redacted instead.
   */
  const recordPatternPaint = (name: string, area: RedactionArea, box: Rect): boolean => {
    const kind = patternKind(name);
    if (kind === 'none' || kind === 'shading') return false;
    if (kind === 'inherited') {
      // Cannot be resolved from here; the enclosing filter refuses.
      patternFootprints.push({ name, rects: [] });
      return false;
    }
    const info = formOptions!.resolvePattern!(name)!;
    const bbox = info.bbox;
    if (!bbox || bbox[0] === bbox[2] || bbox[1] === bbox[3]) {
      throw unsupported(
        translate(
          'A redaction mark falls across an area filled with a tiling pattern that has no ' +
            'usable /BBox, so what the mark covers inside the pattern cannot be determined. ' +
            'Nothing was changed — your original document is untouched. Rasterise the page ' +
            'first.'
        )
      );
    }
    const rects = patternCellFootprint(info, patternBase, area, box);
    const existing = patternFootprints.find(f => f.name === name);
    if (existing) existing.rects.push(...rects);
    else patternFootprints.push({ name, rects });
    return true;
  };

  /**
   * HRD-41 review — which of the current fill and stroke patterns a form drawn
   * now (at `formCtm`) paints with, in this stream's names. A form that sets a
   * colour of its own before every paint uses neither; one whose content cannot
   * be read, or cannot be walked to the end, is assumed to use both — assuming
   * otherwise would leave the cell under the mark in the file.
   */
  const inheritedPatternsPainted = (info: XObjectInfo, formCtm: Matrix): string[] => {
    const candidates = [state.fillPattern, state.strokePattern].filter((name, index, all) => {
      const kind = patternKind(name);
      return (kind === 'tiling' || kind === 'inherited') && all.indexOf(name) === index;
    });
    if (candidates.length === 0) return [];
    if (!info.content || formDepth >= MAX_FORM_DEPTH) return candidates;
    const inherited = (name: string) =>
      name.startsWith(INHERITED_PATTERN) ? name : INHERITED_PATTERN + name;
    const innerState = state.clone();
    innerState.ctm = formCtm;
    if (innerState.fillPattern) innerState.fillPattern = inherited(innerState.fillPattern);
    if (innerState.strokePattern) innerState.strokePattern = inherited(innerState.strokePattern);
    try {
      const inner = filterContentStream(
        info.content.statements,
        redactionBoxes,
        innerState,
        info.content.resolveXObject,
        info.content.resolveFont,
        {
          // A probe: nothing it rewrites is kept, so its names need not be unique.
          allocateFormName: () => 'StaplerProbe',
          depth: formDepth + 1,
          resolvePattern: info.content.resolvePattern ?? (() => undefined),
          resolveExtGState: info.content.resolveExtGState,
          patternBase: formCtm
        }
      );
      const used = new Set(inner.patternFootprints.map(f => f.name));
      return candidates.filter(name => used.has(inherited(name)));
    } catch {
      return candidates;
    }
  };

  // Track vector path construction and painting
  let currentPathStmts: Statement[] = [];
  let currentPathPoints: { x: number; y: number }[] = [];
  /** Segments in the current subpath, so a join between two can be detected. */
  let subpathSegments = 0;
  /** The path has a join other than `re`'s right angles (see `strokeOutset`). */
  let pathHasFreeJoin = false;

  /**
   * How far, in device space, a stroke's ink reaches past its path's points:
   * `[dx, dy]`. Half the line width at a butt end or a round join; up to
   * `√2 ×` that at a projecting square cap or a right-angled mitre (`re`); up
   * to `miterLimit ×` that at a sharper mitred join. The full line width covers
   * the first two, and the mitre limit the third when the path has a join that
   * is not `re`'s — so the box is never smaller than the ink. Over-reach only
   * ever widens what is removed, which is the safe direction.
   */
  const strokeOutset = (freeJoin: boolean = pathHasFreeJoin): [number, number] => {
    const width = Math.abs(state.lineWidth);
    // Unknown (an `/ExtGState` that could not be read): fail closed.
    if (width === Number.POSITIVE_INFINITY) return [UNKNOWN_STROKE_REACH, UNKNOWN_STROKE_REACH];
    if (!Number.isFinite(width) || width === 0) return [0, 0];
    let reach = width; // = (width / 2) · 2
    if (freeJoin && state.lineJoin === 0) {
      const limit = Number.isFinite(state.miterLimit) ? Math.max(1, state.miterLimit) : 10;
      reach = Math.max(reach, (width / 2) * limit);
    }
    const [a, b, c, d] = state.ctm;
    return [reach * Math.hypot(a, c), reach * Math.hypot(b, d)];
  };

  const flushPath = (paintOpStmt: Statement | null, isPainting: boolean) => {
    if (currentPathStmts.length === 0 && !paintOpStmt) return;

    let pathBox: Rect | null = null;
    if (currentPathPoints.length > 0) {
      const xs = currentPathPoints.map(p => p.x);
      const ys = currentPathPoints.map(p => p.y);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      pathBox = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }

    // A stroke paints past its points (HRD-41 review): a 20pt pattern stroke
    // whose centre line sits just outside a mark still paints under it, and its
    // cell footprint must reach as far as its ink does.
    const paintOpName = paintOpStmt ? String.fromCharCode(...paintOpStmt.operator.bytes) : '';
    if (pathBox && STROKE_PAINT_OPS.has(paintOpName)) {
      const [dx, dy] = strokeOutset();
      if (dx > 0 || dy > 0) {
        pathBox = {
          x: pathBox.x - dx,
          y: pathBox.y - dy,
          width: pathBox.width + 2 * dx,
          height: pathBox.height + 2 * dy
        };
      }
    }

    let overlaps = false;
    if (isPainting && pathBox) {
      // HRD-41 — the colours this paint uses. A paint filled (or stroked) with
      // a tiling pattern shows that pattern's cell content; dropping the paint
      // hides the cell but leaves it in the file, so the cell itself is what
      // gets redacted and a paint that uses nothing *but* such patterns stays.
      const colours: string[] = [];
      if (FILL_PAINT_OPS.has(paintOpName)) colours.push(state.fillPattern);
      if (STROKE_PAINT_OPS.has(paintOpName)) colours.push(state.strokePattern);
      let keepable = colours.length > 0;
      for (const r of redactionBoxes) {
        if (!areaTouches(r, pathBox)) continue;
        overlaps = true;
        for (const name of colours) {
          if (!recordPatternPaint(name, r, pathBox)) keepable = false;
        }
      }
      if (overlaps && keepable) overlaps = false;
    }

    if (!overlaps) {
      filtered.push(...currentPathStmts);
      if (paintOpStmt) filtered.push(paintOpStmt);
    }

    currentPathStmts = [];
    currentPathPoints = [];
    subpathSegments = 0;
    pathHasFreeJoin = false;
  };

  for (const stmt of statements) {
    const op = String.fromCharCode(...stmt.operator.bytes);

    // Path construction operators: m l c v y h re
    if (op === 'm' || op === 'l' || op === 'c' || op === 'v' || op === 'y' || op === 're') {
      currentPathStmts.push(stmt);
      if (op === 'm') {
        subpathSegments = 0;
      } else if (op === 're') {
        // A closed rectangle of right angles, which the full-width reach covers;
        // anything appended to it joins it at its origin, which may not.
        subpathSegments = 1;
      } else if (++subpathSegments >= 2) {
        pathHasFreeJoin = true;
      }
      if (op === 're' && stmt.operands.length === 4) {
        const rx = parseFloat(String.fromCharCode(...stmt.operands[0].bytes));
        const ry = parseFloat(String.fromCharCode(...stmt.operands[1].bytes));
        const rw = parseFloat(String.fromCharCode(...stmt.operands[2].bytes));
        const rh = parseFloat(String.fromCharCode(...stmt.operands[3].bytes));
        currentPathPoints.push(
          transformPoint(state.ctm, rx, ry),
          transformPoint(state.ctm, rx + rw, ry),
          transformPoint(state.ctm, rx + rw, ry + rh),
          transformPoint(state.ctm, rx, ry + rh)
        );
      } else if (stmt.operands.length >= 2) {
        for (let idx = 0; idx + 1 < stmt.operands.length; idx += 2) {
          const px = parseFloat(String.fromCharCode(...stmt.operands[idx].bytes));
          const py = parseFloat(String.fromCharCode(...stmt.operands[idx + 1].bytes));
          if (!isNaN(px) && !isNaN(py)) {
            currentPathPoints.push(transformPoint(state.ctm, px, py));
          }
        }
      }
      continue;
    } else if (op === 'h') {
      currentPathStmts.push(stmt);
      // Closing adds a segment back to the start, and a join at each end of it.
      if (subpathSegments >= 1) pathHasFreeJoin = true;
      continue;
    }

    // Path painting operators: S s f F f* B B* b b* n sh
    if (
      op === 'S' ||
      op === 's' ||
      op === 'f' ||
      op === 'F' ||
      op === 'f*' ||
      op === 'B' ||
      op === 'B*' ||
      op === 'b' ||
      op === 'b*' ||
      op === 'n' ||
      op === 'sh'
    ) {
      flushPath(stmt, op !== 'n');
      continue;
    }

    // If there was an unpainted path when encountering another operator, flush it
    if (currentPathStmts.length > 0) {
      flushPath(null, false);
    }

    if (op === 'scn' || op === 'SCN') {
      const last = stmt.operands[stmt.operands.length - 1];
      const name =
        last?.type === 'name' ? String.fromCharCode(...last.bytes).replace(/^\//, '') : '';
      if (op === 'scn') state.fillPattern = name;
      else state.strokePattern = name;
    } else if (op === 'cs' || op === 'sc' || op === 'g' || op === 'rg' || op === 'k') {
      state.fillPattern = '';
    } else if (op === 'CS' || op === 'SC' || op === 'G' || op === 'RG' || op === 'K') {
      state.strokePattern = '';
    }

    if (op === 'w' || op === 'J' || op === 'j' || op === 'M') {
      const value =
        stmt.operands.length >= 1
          ? parseFloat(String.fromCharCode(...stmt.operands[0].bytes))
          : Number.NaN;
      if (Number.isFinite(value)) {
        if (op === 'w') state.lineWidth = value;
        else if (op === 'J') state.lineCap = value;
        else if (op === 'j') state.lineJoin = value;
        else state.miterLimit = value;
      }
    } else if (op === 'gs') {
      const last = stmt.operands[stmt.operands.length - 1];
      const name =
        last?.type === 'name' ? String.fromCharCode(...last.bytes).replace(/^\//, '') : '';
      const ext = name ? formOptions?.resolveExtGState?.(name) : undefined;
      if (!ext) {
        // Not resolvable from here — a name the resources do not define, a
        // value that is not a dictionary, an unreadable stroke key, or no
        // resolver at all. Whatever it set, the width is no longer known.
        state.lineWidth = Number.POSITIVE_INFINITY;
      } else {
        if (ext.lineWidth !== undefined) state.lineWidth = ext.lineWidth;
        if (ext.lineCap !== undefined) state.lineCap = ext.lineCap;
        if (ext.lineJoin !== undefined) state.lineJoin = ext.lineJoin;
        if (ext.miterLimit !== undefined) state.miterLimit = ext.miterLimit;
      }
    } else if (op === 'Tr') {
      const value =
        stmt.operands.length >= 1
          ? parseFloat(String.fromCharCode(...stmt.operands[0].bytes))
          : Number.NaN;
      if (Number.isFinite(value)) state.textRenderMode = value;
    }

    if (op === 'q') {
      savedStates.push(state.saveSnapshot());
    } else if (op === 'Q') {
      if (savedStates.length > 0) {
        const popped = savedStates.pop()!;
        state.restoreSnapshot(popped);
      }
    } else if (op === 'cm') {
      if (stmt.operands.length === 6) {
        const m = stmt.operands.map(t => parseFloat(String.fromCharCode(...t.bytes))) as Matrix;
        state.ctm = multiplyMatrix(m, state.ctm);
      }
    } else if (op === 'BT') {
      state.textMatrix = [1, 0, 0, 1, 0, 0];
      state.textLineMatrix = [1, 0, 0, 1, 0, 0];
    } else if (op === 'ET') {
      state.textMatrix = [1, 0, 0, 1, 0, 0];
      state.textLineMatrix = [1, 0, 0, 1, 0, 0];
    } else if (op === 'Tm') {
      if (stmt.operands.length === 6) {
        const m = stmt.operands.map(t => parseFloat(String.fromCharCode(...t.bytes))) as Matrix;
        state.textMatrix = [...m];
        state.textLineMatrix = [...m];
      }
    } else if (op === 'Td' || op === 'TD') {
      if (stmt.operands.length === 2) {
        const tx = parseFloat(String.fromCharCode(...stmt.operands[0].bytes));
        const ty = parseFloat(String.fromCharCode(...stmt.operands[1].bytes));
        if (op === 'TD') state.textLeading = -ty;
        const m: Matrix = [1, 0, 0, 1, tx, ty];
        state.textLineMatrix = multiplyMatrix(m, state.textLineMatrix);
        state.textMatrix = [...state.textLineMatrix];
      }
    } else if (op === 'TL') {
      if (stmt.operands.length === 1) {
        state.textLeading = parseFloat(String.fromCharCode(...stmt.operands[0].bytes));
      }
    } else if (op === 'T*') {
      const m: Matrix = [1, 0, 0, 1, 0, -state.textLeading];
      state.textLineMatrix = multiplyMatrix(m, state.textLineMatrix);
      state.textMatrix = [...state.textLineMatrix];
    } else if (op === 'Tf') {
      if (stmt.operands.length === 2) {
        state.fontName = String.fromCharCode(...stmt.operands[0].bytes).replace(/^\//, '');
        state.fontSize = parseFloat(String.fromCharCode(...stmt.operands[1].bytes));
      }
    } else if (op === 'Tc' || op === 'Tw' || op === 'Tz') {
      // Text-state parameters that scale every advance below. Ignoring them was
      // worth up to a whole line of drift on a justified paragraph (Tw is how
      // most producers justify) and a factor of two on condensed type (Tz 50).
      if (stmt.operands.length >= 1) {
        const value = parseFloat(String.fromCharCode(...stmt.operands[0].bytes));
        if (Number.isFinite(value)) {
          if (op === 'Tc') state.charSpacing = value;
          else if (op === 'Tw') state.wordSpacing = value;
          else state.horizontalScale = value / 100;
        }
      }
    } else if (op === 'Tj' || op === 'TJ' || op === "'" || op === '"') {
      if (op === "'" || op === '"') {
        const lm: Matrix = [1, 0, 0, 1, 0, -state.textLeading];
        state.textLineMatrix = multiplyMatrix(lm, state.textLineMatrix);
        state.textMatrix = [...state.textLineMatrix];
      }

      // The `"` operator's string is its last operand; its first two are aw/ac,
      // which set the word and character spacing for this show and stay set.
      if (op === '"' && stmt.operands.length >= 3) {
        const aw = parseFloat(String.fromCharCode(...stmt.operands[0].bytes));
        const ac = parseFloat(String.fromCharCode(...stmt.operands[1].bytes));
        if (Number.isFinite(aw)) state.wordSpacing = aw;
        if (Number.isFinite(ac)) state.charSpacing = ac;
      }

      const font = state.fontName ? resolveFont?.(state.fontName) : undefined;

      const elements: RunElement[] = [];
      if (op === 'TJ') {
        for (const token of stmt.operands) {
          if (token.type === 'string' || token.type === 'hexstring') {
            const bytes = decodeStringToken(token);
            elements.push({ kind: 'glyphs', bytes, glyphs: glyphAdvances(bytes, state, font) });
          } else if (token.type === 'number') {
            // TJ kerning: a positive number moves the *next* glyph left by
            // n/1000 em. Dropping these made every kerned run measure wider
            // than it draws, which for a right-aligned block pushed the box off
            // the end of the text it was supposed to cover.
            const adjust = parseFloat(String.fromCharCode(...token.bytes));
            if (Number.isFinite(adjust)) {
              elements.push({
                kind: 'adjust',
                token,
                shift: -(adjust / 1000) * state.fontSize * state.horizontalScale
              });
            }
          }
        }
      } else {
        // Tj takes one string; ' takes one; " takes aw, ac, then the string.
        const token = stmt.operands[stmt.operands.length - 1];
        if (token && (token.type === 'string' || token.type === 'hexstring')) {
          const bytes = decodeStringToken(token);
          elements.push({ kind: 'glyphs', bytes, glyphs: glyphAdvances(bytes, state, font) });
        }
      }

      // Walk the run once, laying every glyph out on the text-space axis. `lo`
      // tracks the metric cursor (what the text matrix advances by); `hi` the
      // cursor built from the coverage bounds, which runs ahead of it only where
      // a width had to be guessed. A glyph's hit-test span is the union of the
      // two, so the position a viewer actually draws it at is inside the span
      // even when every width in the run was a guess.
      const spans: { lo: number; hi: number; advance: number }[] = [];
      let metricCursor = 0;
      let coverCursor = 0;
      let allExact = true;
      for (const element of elements) {
        if (element.kind === 'adjust') {
          metricCursor += element.shift;
          coverCursor += element.shift;
          continue;
        }
        for (const glyph of element.glyphs) {
          const metricEnd = metricCursor + glyph.advance;
          const coverEnd = coverCursor + glyph.coverAdvance;
          spans.push({
            lo: Math.min(metricCursor, coverCursor, metricEnd, coverEnd),
            hi: Math.max(metricCursor, coverCursor, metricEnd, coverEnd),
            advance: glyph.advance
          });
          metricCursor = metricEnd;
          coverCursor = coverEnd;
          if (!glyph.exact) allExact = false;
        }
      }
      const totalAdvance = metricCursor;

      // Both the mark and the verifier model a run as evenly spaced characters.
      // pdf.js reports one width per *text item*, not per glyph, so RED-01's
      // search-and-mark (`locatePatterns`) and RED-03's re-scan
      // (`textRunViewportBox`) each slice that one width by character index.
      // Real proportional metrics put a glyph up to a glyph or two away from
      // where that model puts it — Helvetica's `1` is 556/1000 em against an `S`
      // at 667.
      //
      // So a glyph is removed if it overlaps the mark under *either* model: the
      // true metrics measured above, or the even spacing the mark was drawn
      // against. Testing only the true metrics leaves the glyph at the far edge
      // of a marked field in the file whenever the two models disagree there —
      // which RED-03, using the other model, then correctly refuses to save. The
      // union is only ever wider, so nothing the mark covers under either
      // reading survives; and it changes nothing at all for a monospaced run, or
      // for any run whose glyphs really are evenly spaced.
      if (spans.length > 0 && Number.isFinite(totalAdvance)) {
        const evenAdvance = totalAdvance / spans.length;
        for (let i = 0; i < spans.length; i++) {
          const evenStart = evenAdvance * i;
          const evenEnd = evenAdvance * (i + 1);
          spans[i].lo = Math.min(spans[i].lo, evenStart, evenEnd);
          spans[i].hi = Math.max(spans[i].hi, evenStart, evenEnd);
        }
      }

      const trm = multiplyMatrix(state.textMatrix, state.ctm);
      // Stroked text (modes 1, 2, 5, 6) paints the glyph outlines with the
      // current line width, which is in user space — the CTM scales it, the
      // text matrix does not (PDF 32000 9.3.6; pdf.js divides it back out of
      // the text matrix too). A glyph outline is all joins, so the mitre reach
      // applies. Modes 0, 3, 4 and 7 draw no stroke and keep the plain box.
      const [glyphDx, glyphDy] = STROKED_TEXT_MODES.has(state.textRenderMode)
        ? strokeOutset(true)
        : [0, 0];
      // A zero-width span (an empty show, a zero-width glyph) still occupies its
      // cursor position; give it a hairline so a caret-position mark matches.
      const hairline = Math.abs(state.fontSize) * 0.05 || 0.05;
      const boxOf = (lo: number, hi: number): Rect => {
        const end = Math.abs(hi - lo) < 1e-9 ? lo + hairline : hi;
        // All four corners, not two: under a rotated CTM the box of the diagonal
        // pair is a *subset* of the real extent, and a coverage box that is a
        // subset of the glyph is how a mark misses text it sits on top of.
        const corners = [
          transformPoint(trm, lo, 0),
          transformPoint(trm, end, 0),
          transformPoint(trm, end, state.fontSize),
          transformPoint(trm, lo, state.fontSize)
        ];
        const xs = corners.map(c => c.x);
        const ys = corners.map(c => c.y);
        return {
          x: Math.min(...xs) - glyphDx,
          y: Math.min(...ys) - glyphDy,
          width: Math.max(...xs) - Math.min(...xs) + 2 * glyphDx,
          height: Math.max(...ys) - Math.min(...ys) + 2 * glyphDy
        };
      };

      let runLo = 0;
      let runHi = 0;
      for (const span of spans) {
        if (span.lo < runLo) runLo = span.lo;
        if (span.hi > runHi) runHi = span.hi;
      }
      const runBox = boxOf(runLo, runHi);

      state.textMatrix = multiplyMatrix([1, 0, 0, 1, totalAdvance, 0], state.textMatrix);

      // The whole-run test first, so a page of thousands of glyphs pays one
      // overlap test per run — including the polygon test, which is the
      // expensive one — and only a run a mark actually reaches is walked again
      // glyph by glyph.
      const touching = redactionBoxes.filter(r => areaTouches(r, runBox));
      if (touching.length === 0) {
        filtered.push(stmt);
        continue;
      }

      // HRD-41 — glyphs painted with a tiling pattern show the cell through
      // their outlines; the cell under the mark is redacted as well as the
      // glyphs. Whatever the text rendering mode, both colours are taken: the
      // over-removal is confined to the cell area under the mark.
      for (const r of touching) {
        for (const name of [state.fillPattern, state.strokePattern]) {
          recordPatternPaint(name, r, runBox);
        }
      }

      /**
       * `'` and `"` are not only show operators: `'` moves to the next line and
       * `"` also sets `Tw`/`Tc` for everything after it. Dropping the statement
       * therefore drops a *state* change the rest of the text object depends on
       * — every following line of kept text lands one leading too high. So the
       * side effects are re-emitted on their own whenever the glyphs go.
       */
      const pushSideEffectsOnly = () => {
        if (op !== "'" && op !== '"') return;
        if (op === '"' && stmt.operands.length >= 3) {
          filtered.push(statementOf([stmt.operands[0]], 'Tw'));
          filtered.push(statementOf([stmt.operands[1]], 'Tc'));
        }
        filtered.push(statementOf([], 'T*'));
      };

      if (spans.length === 0) {
        // Nothing to split: an empty or unreadable show operand, sitting under a
        // mark. Its state changes still have to survive.
        pushSideEffectsOnly();
        continue;
      }

      // At least one glyph in this run was measured from a guess, so no cut
      // inside it can be trusted to fall between the marked glyphs and the kept
      // ones (see `GlyphAdvance.exact`). The run box above is built from the
      // coverage bounds and so contains wherever the glyphs really are; take all
      // of it. Over-removal loses text the user kept, which is bad; leaving half
      // a marked field in the file is worse.
      if (!allExact) {
        pushSideEffectsOnly();
        continue;
      }

      const removed = spans.map(span =>
        touching.some(r => areaTouches(r, boxOf(span.lo, span.hi)))
      );
      const removedCount = removed.reduce((n, flag) => n + (flag ? 1 : 0), 0);

      // Byte-untouched when the mark reached the run's box but no glyph in it —
      // the gap a kern opens up, or the corner of a shaped mark.
      if (removedCount === 0) {
        filtered.push(stmt);
        continue;
      }

      if (removedCount === spans.length) {
        pushSideEffectsOnly();
        continue;
      }

      // A partial hit. Emit the surviving glyphs as a `TJ`, with each removed
      // stretch replaced by the displacement it used to advance by, so what
      // stays keeps its position — PDF text positioning being left-to-right and
      // advance-based, dropping the glyphs alone would slide the rest of the
      // line leftwards into the hole.
      //
      // A TJ displacement is expressed as a multiple of `Tfs · Th`, so with
      // either at zero there is no way to write that advance at all. Take the
      // whole run instead: over-removal is the only safe direction to be wrong
      // in, and text at zero size or zero scale draws nothing anyway.
      const scale = state.fontSize * state.horizontalScale;
      if (!Number.isFinite(scale) || scale === 0) {
        pushSideEffectsOnly();
        continue;
      }

      const operands: Token[] = [ARRAY_START_TOKEN];
      let pendingAdvance = 0;
      const flushPending = () => {
        if (pendingAdvance === 0) return;
        operands.push(numberToken((-1000 * pendingAdvance) / scale));
        pendingAdvance = 0;
      };
      let glyphIndex = 0;
      for (const element of elements) {
        if (element.kind === 'adjust') {
          // Kept verbatim, and in order: it displaces the cursor whether or not
          // the glyphs around it survived.
          flushPending();
          operands.push(element.token);
          continue;
        }
        let segmentStart = -1;
        const flushSegment = (endExclusive: number) => {
          if (segmentStart < 0) return;
          flushPending();
          operands.push(hexStringToken(element.bytes.slice(segmentStart, endExclusive)));
          segmentStart = -1;
        };
        for (const glyph of element.glyphs) {
          if (removed[glyphIndex]) {
            flushSegment(glyph.start);
            // The removed codes are never written anywhere in the output: what
            // replaces them is a bare number, so there is no operator left in
            // the stream that references those glyphs.
            pendingAdvance += glyph.advance;
          } else if (segmentStart < 0) {
            segmentStart = glyph.start;
          }
          glyphIndex++;
        }
        flushSegment(element.bytes.length);
      }
      flushPending();
      operands.push(ARRAY_END_TOKEN);

      if (op === '"' && stmt.operands.length >= 3) {
        filtered.push(statementOf([stmt.operands[0]], 'Tw'));
        filtered.push(statementOf([stmt.operands[1]], 'Tc'));
      }
      if (op === "'" || op === '"') filtered.push(statementOf([], 'T*'));
      filtered.push(statementOf(operands, 'TJ'));
      continue;
    } else if (op === 'Do') {
      let xObjectName = '';
      if (stmt.operands.length > 0 && stmt.operands[stmt.operands.length - 1].type === 'name') {
        xObjectName = String.fromCharCode(...stmt.operands[stmt.operands.length - 1].bytes).slice(
          1
        );
      }

      const info = xObjectName ? resolveXObject?.(xObjectName) : undefined;

      let shouldStrip = false;
      if (info?.subtype === 'Form') {
        // The Form's own Matrix (if any) applies before the page's CTM.
        const formCtm = info.matrix ? multiplyMatrix(info.matrix, state.ctm) : state.ctm;

        // `/BBox` is required by the spec, but producers omit it. Without one
        // there is no extent to test, so neither of the two shortcuts below is
        // available and the content itself has to answer the question — which
        // it can, now that the content is walked. Treating a missing box as
        // "the unit square", which is what fell out of the old image branch,
        // described a 1×1pt form at the origin and was wrong every time.
        const box = info.bbox ? formBoxOf(formCtm, info.bbox) : null;

        // Fully covered: the whole form goes, exactly as before. Nothing the
        // user kept is inside it.
        if (box && redactionBoxes.some(r => areaCovers(r, box))) {
          shouldStrip = true;
          // HRD-41 review — a form drawn while the colour is a tiling pattern
          // can paint with that colour (it inherits the graphics state), and
          // what it paints is the pattern's cell. Dropping the `Do` hides the
          // cell there but leaves it in the file, so the cell under the mark
          // is redacted as for any other paint in that pattern.
          for (const name of inheritedPatternsPainted(info, formCtm)) {
            for (const r of redactionBoxes) {
              if (areaTouches(r, box)) recordPatternPaint(name, r, box);
            }
          }
        } else if (box && !redactionBoxes.some(r => areaTouches(r, box))) {
          // Nowhere near a mark. Byte-untouched.
        } else if (info.content && formOptions && formDepth < MAX_FORM_DEPTH) {
          // A partial overlap, resolved by filtering the form's own content at
          // the placement's own matrix. Refusing here instead — which is what
          // this did before — makes redaction unusable on every producer that
          // wraps a page, or a whole region of one, in a single form.
          //
          // The form's content runs with the graphics state as it stands at the
          // `Do` (spec 8.10.1), so the state is cloned rather than reset; only
          // the CTM changes. Its final state is discarded because `Do` brackets
          // the form in an implicit save/restore.
          const innerState = state.clone();
          innerState.ctm = formCtm;
          // A colour the form inherits names a pattern in *this* stream's
          // resources, not the form's.
          if (innerState.fillPattern && !innerState.fillPattern.startsWith(INHERITED_PATTERN)) {
            innerState.fillPattern = INHERITED_PATTERN + innerState.fillPattern;
          }
          if (innerState.strokePattern && !innerState.strokePattern.startsWith(INHERITED_PATTERN)) {
            innerState.strokePattern = INHERITED_PATTERN + innerState.strokePattern;
          }
          const inner = filterContentStream(
            info.content.statements,
            redactionBoxes,
            innerState,
            info.content.resolveXObject,
            info.content.resolveFont,
            {
              allocateFormName: formOptions.allocateFormName,
              depth: formDepth + 1,
              resolvePattern: info.content.resolvePattern,
              resolveExtGState: info.content.resolveExtGState,
              patternBase: formCtm
            }
          );

          if (inner.patternFootprints.length > 0) {
            // HRD-41 — a pattern's cell drawn through a form. The cell would
            // have to be rewritten through the form's own resources, which this
            // path does not do; leaving the cell intact would leave what the
            // mark covers in the file.
            throw unsupported(
              translate(
                'A redaction mark falls across an area that a Form XObject fills with a tiling ' +
                  'pattern. Stapler can remove content from a pattern drawn by the page itself, ' +
                  'but not from one drawn through a form, and covering it would leave the ' +
                  'pattern’s content inside the file. Nothing was changed — your original ' +
                  'document is untouched. Rasterise the page first.'
              )
            );
          }

          if (inner.strippedXObjectNames.length > 0 || inner.partialImageCoverage.length > 0) {
            // An image or a nested form inside this one falls under the mark.
            // Both are removals this module cannot complete from in here: the
            // image's pixels are edited by the caller against *page*-level
            // resource names, and dropping a nested form's `Do` would leave its
            // stream named by resources the caller is not rewriting. Refusing
            // is what the whole `Do` used to do for any overlap at all, so this
            // is strictly narrower than before — and it never leaves marked
            // content in the file.
            throw unsupported(
              translate(
                'A redaction mark falls across an image (or a nested form) that is drawn from ' +
                  'inside a Form XObject. Stapler can filter text and vectors inside a form, but ' +
                  'not remove an image through one. Nothing was changed — your original document ' +
                  'is untouched. Cover the whole form with the mark, or rasterise the page first.'
              )
            );
          }

          if (sameStatements(inner.filtered, info.content.statements)) {
            // The mark reached the form's box but nothing it draws — a margin,
            // the gap around a table rule. Keep the `Do` exactly as it was.
            filtered.push(stmt);
            continue;
          }

          const newName = formOptions.allocateFormName();
          formRewrites.push({
            originalName: xObjectName,
            newName,
            filtered: inner.filtered,
            nested: inner.formRewrites
          });
          filtered.push(statementOf([asciiToken('name', `/${newName}`)], 'Do'));
          continue;
        } else {
          throw unsupported(
            box
              ? translate(
                  'A redaction mark only partly covers a Form XObject whose content Stapler ' +
                    'could not read — so what the mark covers inside it cannot be determined. ' +
                    'Removing the whole form would delete content outside the marked region. ' +
                    'Nothing was changed — your original document is untouched.'
                )
              : translate(
                  'A redaction mark overlaps a Form XObject that declares no /BBox and whose ' +
                    'content Stapler could not read — so what the mark covers inside it cannot ' +
                    'be determined. Removing the whole form would delete content outside the ' +
                    'marked region. Nothing was changed — your original document is untouched.'
                )
          );
        }
      } else {
        // Images occupy the unit square in their own space. All four corners
        // are transformed, as `formBoxOf` does: two diagonal corners give a
        // sliver for a rotated CTM (zero width at 45°), so a mark over part of
        // the image touched neither path and only an overlay was drawn over
        // intact pixels (AUDIT-2026-09-25 PDF-4). The axis-aligned bounds of
        // the true quad are conservative for "covers" — a rectangle mark
        // contains the quad iff it contains its bounds, and a polygon mark
        // containing the bounds contains the quad.
        const box = formBoxOf(state.ctm, [0, 0, 1, 1]);

        // An Image XObject is only safe to drop wholesale when a single
        // redaction rectangle fully contains it — then nothing the user kept is
        // lost with it. A *partial* overlap cannot be resolved here at all: the
        // painting operator has to stay (the uncovered part of the image is
        // still wanted) while the covered pixels must physically go, and this
        // module does not decode images. It is reported to the caller instead of
        // being quietly left as a black rectangle drawn over intact pixels.
        let covered = false;
        for (const r of redactionBoxes) {
          if (areaCovers(r, box)) {
            covered = true;
            break;
          }
        }
        shouldStrip = covered;

        // HRD-41 review — a stencil mask paints the fill colour through its
        // samples, so filled with a tiling pattern it shows the pattern's cell.
        // Whether the stencil itself is dropped (covered) or blacked out
        // (partly), the cell under the mark is redacted too.
        if (info?.imageMask) {
          for (const r of redactionBoxes) {
            if (areaTouches(r, box)) recordPatternPaint(state.fillPattern, r, box);
          }
        }

        if (!covered && xObjectName) {
          const unitRects: RedactionArea[] = [];
          for (const r of redactionBoxes) {
            if (!areaTouches(r, box)) continue;
            // A singular CTM cannot be inverted, so the covered area is
            // unknowable. Cover the whole image rather than none of it: the
            // placement is degenerate, and an image squashed to a line carries
            // no detail worth preserving.
            if (!invertMatrix(state.ctm)) {
              unitRects.push({ x: 0, y: 0, width: 1, height: 1 });
              continue;
            }
            // The bounds of a rotated quad include corners the image does not
            // occupy; mapped into unit space, a mark that only meets those
            // corners misses the unit square and is correctly skipped.
            const unit = redactionAreaInUnitSpace(state.ctm, r);
            if (unit) unitRects.push(unit);
          }
          if (unitRects.length > 0) {
            partialImageCoverage.push({ name: xObjectName, rects: unitRects });
          }
        }
      }

      if (shouldStrip) {
        if (xObjectName) strippedXObjectNames.push(xObjectName);
        continue;
      }
    }

    filtered.push(stmt);
  }

  if (currentPathStmts.length > 0) {
    flushPath(null, false);
  }

  return {
    filtered,
    finalState: state,
    strippedXObjectNames,
    partialImageCoverage,
    formRewrites,
    patternFootprints
  };
}

/** Painting operators that use the non-stroking colour. */
const FILL_PAINT_OPS = new Set(['f', 'F', 'f*', 'B', 'B*', 'b', 'b*']);
/** Painting operators that use the stroking colour. */
const STROKE_PAINT_OPS = new Set(['S', 's', 'B', 'B*', 'b', 'b*']);
/** Text rendering modes (`Tr`) that stroke the glyph outlines. */
const STROKED_TEXT_MODES = new Set([1, 2, 5, 6]);

/** Text-showing and text-state operators — everything legal inside `BT`...`ET`. */
const TEXT_OPERATORS = new Set([
  'BT',
  'ET',
  'Tc',
  'Tw',
  'Tz',
  'TL',
  'Tf',
  'Tr',
  'Ts',
  'Td',
  'TD',
  'Tm',
  'T*',
  'Tj',
  'TJ',
  "'",
  '"'
]);

/** Text-state operators whose values outlive the text object that sets them. */
const PERSISTENT_TEXT_STATE = new Set(['Tc', 'Tw', 'Tz', 'TL', 'Tf', 'Tr', 'Ts']);

export interface StripTextObjectsResult {
  filtered: Statement[];
  /** Number of `BT`...`ET` spans removed. */
  removed: number;
}

/**
 * Removes every *invisible* text object (`BT`...`ET`, inclusive, rendered
 * under `Tr` mode 3) from a content stream — used to clear a broken or
 * duplicate pre-existing OCR text layer (a scanning app's own bad OCR, or a
 * previous Stapler OCR run) before writing a fresh one, rather than stacking
 * a second layer on top of the first.
 *
 * Requiring rendering mode 3 is the actual safety property here, not a detail:
 * every mainstream "searchable scan" producer — Adobe Scan, Acrobat's own OCR,
 * this codebase's own `textLayer.ts` — draws recognised text invisibly over
 * the page image, specifically so it can be searched and selected without
 * being seen. Real, user-authored visible text never uses it (there is no
 * reason to draw text no one can see). So a `Tr 3` block is unambiguously OCR
 * metadata, and a block that never enters that mode is left alone even if
 * every other operator inside it would otherwise qualify — dropping the fill
 * colour a *visible* word was drawn in would still be silent, real content
 * loss.
 *
 * `Tr` is graphics state, not text state: unlike `Tf`/`Tm`, it is not reset by
 * `BT`/`ET` and is commonly set *once*, outside the text object, covering
 * several `BT`...`ET` blocks after it — exactly what this codebase's own
 * `textLayer.ts` emits (`setTextRenderingMode` once, before a whole page's
 * words). So this tracks `Tr` across the *whole* stream, scoped by `q`/`Q`
 * like any other graphics-state value, rather than only looking inside each
 * span. A span whose safety cannot be fully accounted for (see below) marks
 * the running `Tr` value unknown rather than trusting a flat textual scan
 * that might have missed its own internal `q`/`Q` scoping — a later span
 * cannot be misjudged invisible from a guess.
 *
 * The "every statement in the span is a text operator" check is a second,
 * independent guard: `q`/`Q`, `cm`, a path, or a `Do` inside a text object is
 * a shape this function does not expect, so that span is left untouched
 * rather than risk unbalancing state something after it depends on.
 * Malformed input (a `BT` with no matching `ET`) is left alone for the same
 * reason.
 */
export function stripTextObjects(statements: Statement[]): StripTextObjectsResult {
  const out: Statement[] = [];
  // Text state left behind by removed spans, re-emitted (text-state operators
  // are legal outside a text object) just before the next statement that is
  // kept — so a run of removed OCR words costs one set of state operators, not
  // one per word. Nothing is emitted after the last statement: no later
  // operator in this stream could read it.
  const pendingState = new Map<string, Statement>();
  const filtered = {
    push(statement: Statement) {
      for (const pending of pendingState.values()) out.push(pending);
      pendingState.clear();
      out.push(statement);
    }
  };
  let removed = 0;
  let i = 0;

  // `null` means "unknown" — never treated as invisible.
  let currentTr: string | null = '0';
  const trStack: (string | null)[] = [];

  while (i < statements.length) {
    const stmt = statements[i];
    const op = String.fromCharCode(...stmt.operator.bytes);

    if (op === 'q') {
      trStack.push(currentTr);
      filtered.push(stmt);
      i++;
      continue;
    }
    if (op === 'Q') {
      if (trStack.length > 0) currentTr = trStack.pop()!;
      filtered.push(stmt);
      i++;
      continue;
    }
    if (op === 'Tr' && stmt.operands.length === 1) {
      currentTr = String.fromCharCode(...stmt.operands[0].bytes);
      filtered.push(stmt);
      i++;
      continue;
    }
    if (op !== 'BT') {
      filtered.push(stmt);
      i++;
      continue;
    }

    let j = i + 1;
    let safe = true;
    let trAfter: string | null = currentTr;
    // PDF-16: the span is removable only if *every* show operator in it runs
    // under Tr 3. A span that switches back to a visible mode part-way (or
    // shows before switching to 3) draws visible text, and removing it would
    // be silent content loss.
    let sawShow = false;
    let everyShowInvisible = true;
    // Text-state values persist past ET (PDF 32000 9.3.1), so a removed span
    // that set one must leave it set for whatever follows.
    const lastState = new Map<string, Statement>();
    while (j < statements.length) {
      const inner = statements[j];
      const innerOp = String.fromCharCode(...inner.operator.bytes);
      if (innerOp === 'ET') break;
      if (!TEXT_OPERATORS.has(innerOp)) safe = false;
      if (innerOp === 'Tr' && inner.operands.length === 1) {
        trAfter = String.fromCharCode(...inner.operands[0].bytes);
      }
      if (PERSISTENT_TEXT_STATE.has(innerOp)) lastState.set(innerOp, inner);
      if (innerOp === 'Tj' || innerOp === 'TJ' || innerOp === "'" || innerOp === '"') {
        sawShow = true;
        if (trAfter !== '3') everyShowInvisible = false;
      }
      j++;
    }
    const invisible = sawShow ? everyShowInvisible : currentTr === '3' || trAfter === '3';

    if (j >= statements.length || !safe) {
      for (let k = i; k <= Math.min(j, statements.length - 1); k++) filtered.push(statements[k]);
      i = j + 1;
      // This span's own q/Q (if any) were not tracked above — a flat scan
      // cannot know what state they leave `Tr` in — so anything after it is
      // treated as unknown rather than trusted from a guess.
      currentTr = null;
      continue;
    }

    if (!invisible) {
      for (let k = i; k <= j; k++) filtered.push(statements[k]);
      i = j + 1;
      currentTr = trAfter;
      continue;
    }

    // Every statement from BT through ET (inclusive) is a text operator, and
    // everything it shows is rendered invisibly. Re-emit the text state it
    // leaves behind (legal outside a text object) so later text is unchanged.
    for (const [key, statement] of lastState) {
      pendingState.delete(key);
      pendingState.set(key, statement);
    }
    removed++;
    i = j + 1;
    currentTr = trAfter;
  }

  return { filtered: out, removed };
}

/**
 * Decompresses a PDF FlateDecode stream.
 *
 * Most FlateDecode streams are zlib-wrapped deflate (`'deflate'`). Some PDF
 * producers (notably certain older Acrobat versions) emit raw deflate with no
 * zlib header (`'deflate-raw'`). Both are permitted by the spec. We try the
 * common case first; if it fails we fall back to raw deflate. A double failure
 * re-throws the original error so the caller can decide whether to abort or skip.
 */
export async function decodeStream(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('DecompressionStream is not supported in this environment');
  }

  async function tryAlgorithm(algorithm: CompressionFormat): Promise<Uint8Array> {
    const ds = new DecompressionStream(algorithm);
    const writer = ds.writable.getWriter();
    // Not awaited — the readable side has to be drained concurrently or the
    // write never resolves. A corrupt stream rejects these as well as the
    // read below; the read's rejection is the one reported, so these are
    // observed here rather than left as unhandled rejections.
    writer.write(bytes).catch(() => {});
    writer.close().catch(() => {});

    const reader = ds.readable.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
    const out = new Uint8Array(totalLength);
    let pos = 0;
    for (const c of chunks) {
      out.set(c, pos);
      pos += c.length;
    }
    return out;
  }

  // Try zlib-wrapped deflate first (the common case), then fall back to raw
  // deflate for producers that omit the two-byte zlib header.
  try {
    return await tryAlgorithm('deflate');
  } catch {
    return await tryAlgorithm('deflate-raw');
  }
}
