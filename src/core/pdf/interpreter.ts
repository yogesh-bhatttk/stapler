import { unsupported } from '../errors';
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
          'This page contains inline images (the PDF ID operator), which cannot be ' +
            'safely removed by operator-level redaction. Open the file in a PDF editor ' +
            'that supports inline-image redaction, or rasterise the page first.'
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
      fontName: this.fontName
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
 * `widths` is in glyph space (1/1000 em), keyed by character code — which is
 * exactly how both `/Widths` (simple fonts) and `/W` (CID fonts) are indexed.
 */
export interface FontInfo {
  /**
   * True for composite fonts whose CMap uses two-byte codes (`/Type0` with
   * `/Identity-H` and friends). Decides whether a string's bytes are counted
   * singly or in pairs.
   */
  twoByte: boolean;
  /** Character code → width in 1/1000 em. */
  widths?: Map<number, number>;
  /** Width for any code not in `widths`, in 1/1000 em. */
  defaultWidth?: number;
}

/** Fallback advance when the font resource says nothing, in 1/1000 em. */
const FALLBACK_SIMPLE_WIDTH = 600;
const FALLBACK_CID_WIDTH = 1000;

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
 * Horizontal advance of one show-string, in unscaled text-space units.
 *
 * Models what the spec actually says an advance is (PDF 32000 9.4.4): per glyph,
 * `(w/1000 · Tfs + Tc + Tw·isSpace) · Th`. `Tw` applies only to single-byte code
 * 32, never inside a two-byte CID code — applying it there is a classic
 * off-by-a-lot on CJK text.
 */
function showStringWidth(bytes: Uint8Array, state: GraphicsState, font?: FontInfo): number {
  const twoByte = font?.twoByte ?? false;
  const fallback = twoByte ? FALLBACK_CID_WIDTH : FALLBACK_SIMPLE_WIDTH;
  const step = twoByte ? 2 : 1;
  let total = 0;
  for (let i = 0; i + step <= bytes.length; i += step) {
    const code = twoByte ? (bytes[i] << 8) | bytes[i + 1] : bytes[i];
    const glyphWidth = font?.widths?.get(code) ?? font?.defaultWidth ?? fallback;
    total += (glyphWidth / 1000) * state.fontSize + state.charSpacing;
    if (!twoByte && code === 32) total += state.wordSpacing;
  }
  // A trailing odd byte in a two-byte string is malformed input; count it as one
  // more glyph rather than losing the width of whatever the viewer draws there.
  if (twoByte && bytes.length % 2 === 1) {
    total += ((font?.defaultWidth ?? fallback) / 1000) * state.fontSize + state.charSpacing;
  }
  return total * state.horizontalScale;
}

export function filterContentStream(
  statements: Statement[],
  redactionBoxes: RedactionArea[],
  initialState?: GraphicsState,
  resolveXObject?: (name: string) => XObjectInfo | undefined,
  resolveFont?: (name: string) => FontInfo | undefined
): FilterContentStreamResult {
  const filtered: Statement[] = [];
  const strippedXObjectNames: string[] = [];
  const partialImageCoverage: PartialImageCoverage[] = [];
  const state = initialState ? initialState.clone() : new GraphicsState();
  const savedStates: SavedState[] = [];

  // Track vector path construction and painting
  let currentPathStmts: Statement[] = [];
  let currentPathPoints: { x: number; y: number }[] = [];

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

    let overlaps = false;
    if (isPainting && pathBox) {
      for (const r of redactionBoxes) {
        if (areaTouches(r, pathBox)) {
          overlaps = true;
          break;
        }
      }
    }

    if (!overlaps) {
      filtered.push(...currentPathStmts);
      if (paintOpStmt) filtered.push(paintOpStmt);
    }

    currentPathStmts = [];
    currentPathPoints = [];
  };

  for (const stmt of statements) {
    const op = String.fromCharCode(...stmt.operator.bytes);

    // Path construction operators: m l c v y h re
    if (op === 'm' || op === 'l' || op === 'c' || op === 'v' || op === 'y' || op === 're') {
      currentPathStmts.push(stmt);
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

      let estimatedWidth = 0;
      if (op === 'Tj' || op === "'" || op === '"') {
        const token = stmt.operands[stmt.operands.length - 1];
        if (token && (token.type === 'string' || token.type === 'hexstring')) {
          estimatedWidth = showStringWidth(decodeStringToken(token), state, font);
        }
      } else if (op === 'TJ') {
        for (const token of stmt.operands) {
          if (token.type === 'string' || token.type === 'hexstring') {
            estimatedWidth += showStringWidth(decodeStringToken(token), state, font);
          } else if (token.type === 'number') {
            // TJ kerning: a positive number moves the *next* glyph left by
            // n/1000 em. Dropping these made every kerned run measure wider
            // than it draws, which for a right-aligned block pushed the box off
            // the end of the text it was supposed to cover.
            const adjust = parseFloat(String.fromCharCode(...token.bytes));
            if (Number.isFinite(adjust)) {
              estimatedWidth -= (adjust / 1000) * state.fontSize * state.horizontalScale;
            }
          }
        }
      }

      // A zero-width show (an empty string) still occupies its cursor position;
      // give it a hairline box so a caret-position redaction still matches.
      const boxWidth = estimatedWidth === 0 ? state.fontSize * 0.05 : estimatedWidth;
      const trm = multiplyMatrix(state.textMatrix, state.ctm);
      const p1 = transformPoint(trm, 0, 0);
      const p2 = transformPoint(trm, boxWidth, state.fontSize);

      const box: Rect = {
        x: Math.min(p1.x, p2.x),
        y: Math.min(p1.y, p2.y),
        width: Math.abs(p2.x - p1.x),
        height: Math.abs(p2.y - p1.y)
      };

      const advance: Matrix = [1, 0, 0, 1, estimatedWidth, 0];
      state.textMatrix = multiplyMatrix(advance, state.textMatrix);

      let overlaps = false;
      for (const r of redactionBoxes) {
        if (areaTouches(r, box)) {
          overlaps = true;
          break;
        }
      }

      if (overlaps) {
        continue;
      }
    } else if (op === 'Do') {
      let xObjectName = '';
      if (stmt.operands.length > 0 && stmt.operands[stmt.operands.length - 1].type === 'name') {
        xObjectName = String.fromCharCode(...stmt.operands[stmt.operands.length - 1].bytes).slice(
          1
        );
      }

      const info = xObjectName ? resolveXObject?.(xObjectName) : undefined;

      let box: Rect;
      if (info?.subtype === 'Form' && info.bbox) {
        // The Form's own Matrix (if any) applies before the page's CTM.
        const formCtm = info.matrix ? multiplyMatrix(info.matrix, state.ctm) : state.ctm;
        const [llx, lly, urx, ury] = info.bbox;
        const corners = [
          transformPoint(formCtm, llx, lly),
          transformPoint(formCtm, urx, lly),
          transformPoint(formCtm, urx, ury),
          transformPoint(formCtm, llx, ury)
        ];
        const xs = corners.map(c => c.x);
        const ys = corners.map(c => c.y);
        box = {
          x: Math.min(...xs),
          y: Math.min(...ys),
          width: Math.max(...xs) - Math.min(...xs),
          height: Math.max(...ys) - Math.min(...ys)
        };
      } else {
        // Images occupy the unit square in their own space.
        const p1 = transformPoint(state.ctm, 0, 0);
        const p2 = transformPoint(state.ctm, 1, 1);
        box = {
          x: Math.min(p1.x, p2.x),
          y: Math.min(p1.y, p2.y),
          width: Math.abs(p2.x - p1.x),
          height: Math.abs(p2.y - p1.y)
        };
      }

      let shouldStrip = false;
      if (info?.subtype === 'Form') {
        for (const r of redactionBoxes) {
          if (areaCovers(r, box)) {
            shouldStrip = true;
            break;
          }
          if (areaTouches(r, box)) {
            throw unsupported(
              'A redaction mark only partly covers a Form XObject. Removing the entire form ' +
                'would delete content outside the marked region, and Stapler does not yet ' +
                'safely redact inside nested form content. Nothing was changed — your original ' +
                'document is untouched.'
            );
          }
        }
      } else {
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

        if (!covered && xObjectName) {
          const unitRects: RedactionArea[] = [];
          for (const r of redactionBoxes) {
            if (!areaTouches(r, box)) continue;
            const unit = redactionAreaInUnitSpace(state.ctm, r);
            // A singular CTM cannot be inverted, so the covered area is
            // unknowable. Cover the whole image rather than none of it: the
            // placement is degenerate, and an image squashed to a line carries
            // no detail worth preserving.
            unitRects.push(unit ?? { x: 0, y: 0, width: 1, height: 1 });
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

  return { filtered, finalState: state, strippedXObjectNames, partialImageCoverage };
}

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
  const filtered: Statement[] = [];
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
    let invisible = currentTr === '3';
    while (j < statements.length) {
      const inner = statements[j];
      const innerOp = String.fromCharCode(...inner.operator.bytes);
      if (innerOp === 'ET') break;
      if (!TEXT_OPERATORS.has(innerOp)) safe = false;
      if (innerOp === 'Tr' && inner.operands.length === 1) {
        trAfter = String.fromCharCode(...inner.operands[0].bytes);
        if (trAfter === '3') invisible = true;
      }
      j++;
    }

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
    // the span explicitly rendered invisibly.
    removed++;
    i = j + 1;
    currentTr = trAfter;
  }

  return { filtered, removed };
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
    writer.write(bytes);
    writer.close();

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
