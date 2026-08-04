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

export function filterContentStream(statements: Statement[], redactionBoxes: Rect[]): Statement[] {
  const filtered: Statement[] = [];
  const stateStack: GraphicsState[] = [];
  let state = new GraphicsState();

  for (const stmt of statements) {
    const op = String.fromCharCode(...stmt.operator.bytes);

    if (op === 'q') {
      stateStack.push(state.clone());
    } else if (op === 'Q') {
      if (stateStack.length > 0) {
        state = stateStack.pop()!;
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
        const m: Matrix = [1, 0, 0, 1, tx, ty];
        state.textLineMatrix = multiplyMatrix(m, state.textLineMatrix);
        state.textMatrix = [...state.textLineMatrix];
      }
    } else if (op === 'TL') {
      // Set text leading. Stored so T* can apply it.
      if (stmt.operands.length === 1) {
        state.textLeading = parseFloat(String.fromCharCode(...stmt.operands[0].bytes));
      }
    } else if (op === 'T*') {
      // PDF spec: T* is equivalent to `0 –TL Td`.
      const m: Matrix = [1, 0, 0, 1, 0, -state.textLeading];
      state.textLineMatrix = multiplyMatrix(m, state.textLineMatrix);
      state.textMatrix = [...state.textLineMatrix];
    } else if (op === 'Tf') {
      if (stmt.operands.length === 2) {
        state.fontSize = parseFloat(String.fromCharCode(...stmt.operands[1].bytes));
      }
    } else if (op === 'Tj' || op === 'TJ' || op === "'" || op === '"') {
      // Calculate approximate bounding box
      let textStr = '';
      if (op === 'Tj' || op === "'" || op === '"') {
        // Last operand is the string ("'" and '"' prepend a line move, but the
        // last operand is always the text to draw).
        if (stmt.operands.length > 0) {
          textStr = String.fromCharCode(...stmt.operands[stmt.operands.length - 1].bytes);
        }
      } else if (op === 'TJ') {
        // TJ takes an array: [ (str1) kern (str2) kern … ]
        // Walk every token in the operand list and concatenate the string elements.
        // Number tokens are kerning adjustments and do not contribute to the visible
        // text width (they shift position, which the string-length estimate already
        // ignores), so they are skipped.
        for (const token of stmt.operands) {
          if (token.type === 'string' || token.type === 'hexstring') {
            textStr += String.fromCharCode(...token.bytes);
          }
        }
      }

      // We approximate the width.
      // This is a gross overestimate to ensure we catch anything near the redaction region.
      // Average char width ~ 0.6 * fontSize.
      const estimatedWidth = Math.max(1, textStr.length) * state.fontSize;

      const p1 = transformPoint(state.ctm, state.textMatrix[4], state.textMatrix[5]);
      const p2 = transformPoint(
        state.ctm,
        state.textMatrix[4] + estimatedWidth,
        state.textMatrix[5] + state.fontSize
      );

      const box: Rect = {
        x: Math.min(p1.x, p2.x),
        y: Math.min(p1.y, p2.y),
        width: Math.abs(p2.x - p1.x),
        height: Math.abs(p2.y - p1.y)
      };

      let overlaps = false;
      for (const r of redactionBoxes) {
        if (intersects(box, r)) {
          overlaps = true;
          break;
        }
      }

      if (overlaps) {
        // Strip it!
        continue;
      }
    } else if (op === 'Do') {
      // XObject (Image or Form)
      // We assume it's drawn at (0,0) to (1,1) in its local space.
      const p1 = transformPoint(state.ctm, 0, 0);
      const p2 = transformPoint(state.ctm, 1, 1);

      const box: Rect = {
        x: Math.min(p1.x, p2.x),
        y: Math.min(p1.y, p2.y),
        width: Math.abs(p2.x - p1.x),
        height: Math.abs(p2.y - p1.y)
      };

      let overlaps = false;
      for (const r of redactionBoxes) {
        if (intersects(box, r)) {
          overlaps = true;
          break;
        }
      }

      if (overlaps) {
        // Strip the image!
        continue;
      }
    }

    filtered.push(stmt);
  }

  return filtered;
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
