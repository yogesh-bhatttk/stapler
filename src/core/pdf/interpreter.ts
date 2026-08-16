import { unsupported } from '../errors';

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
}

export class GraphicsState {
  ctm: Matrix = [1, 0, 0, 1, 0, 0];
  textMatrix: Matrix = [1, 0, 0, 1, 0, 0];
  textLineMatrix: Matrix = [1, 0, 0, 1, 0, 0];
  fontSize: number = 0;
  /** Text leading, set by the TL operator. Used by T* (= `0 –TL Td`). */
  textLeading: number = 0;

  clone(): GraphicsState {
    const next = new GraphicsState();
    next.ctm = [...this.ctm] as Matrix;
    next.textMatrix = [...this.textMatrix] as Matrix;
    next.textLineMatrix = [...this.textLineMatrix] as Matrix;
    next.fontSize = this.fontSize;
    next.textLeading = this.textLeading;
    return next;
  }

  saveSnapshot(): SavedState {
    return {
      ctm: [...this.ctm] as Matrix,
      textMatrix: [...this.textMatrix] as Matrix,
      textLineMatrix: [...this.textLineMatrix] as Matrix,
      fontSize: this.fontSize,
      textLeading: this.textLeading
    };
  }

  restoreSnapshot(s: SavedState): void {
    this.ctm = [...s.ctm] as Matrix;
    this.textMatrix = [...s.textMatrix] as Matrix;
    this.textLineMatrix = [...s.textLineMatrix] as Matrix;
    this.fontSize = s.fontSize;
    this.textLeading = s.textLeading;
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

export function filterContentStream(
  statements: Statement[],
  redactionBoxes: Rect[],
  initialState?: GraphicsState,
  resolveXObject?: (name: string) => XObjectInfo | undefined
): FilterContentStreamResult {
  const filtered: Statement[] = [];
  const strippedXObjectNames: string[] = [];
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
        if (intersects(pathBox, r)) {
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
        state.fontSize = parseFloat(String.fromCharCode(...stmt.operands[1].bytes));
      }
    } else if (op === 'Tj' || op === 'TJ' || op === "'" || op === '"') {
      if (op === "'" || op === '"') {
        const lm: Matrix = [1, 0, 0, 1, 0, -state.textLeading];
        state.textLineMatrix = multiplyMatrix(lm, state.textLineMatrix);
        state.textMatrix = [...state.textLineMatrix];
      }

      let textStr = '';
      if (op === 'Tj' || op === "'" || op === '"') {
        if (stmt.operands.length > 0) {
          textStr = String.fromCharCode(...stmt.operands[stmt.operands.length - 1].bytes);
        }
      } else if (op === 'TJ') {
        for (const token of stmt.operands) {
          if (token.type === 'string' || token.type === 'hexstring') {
            textStr += String.fromCharCode(...token.bytes);
          }
        }
      }

      const estimatedWidth = Math.max(1, textStr.length) * state.fontSize * 0.6;

      const trm = multiplyMatrix(state.textMatrix, state.ctm);
      const p1 = transformPoint(trm, 0, 0);
      const p2 = transformPoint(trm, estimatedWidth, state.fontSize);

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
        if (intersects(box, r)) {
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
          if (intersects(box, r)) {
            shouldStrip = true;
            break;
          }
        }
      } else {
        // For Image XObjects, strip if the image box is fully contained within redactions,
        // or if it intersects. (If partially covered, keeping Do paints image + black rect over it).
        let covered = false;
        for (const r of redactionBoxes) {
          if (contains(r, box)) {
            covered = true;
            break;
          }
        }
        shouldStrip = covered;
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

  return { filtered, finalState: state, strippedXObjectNames };
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
