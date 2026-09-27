/**
 * GAP-6 — PDF function evaluation (ISO 32000-1 §7.10).
 *
 * Greyscale conversion has to know what colour a Separation/DeviceN tint, or a
 * shading, actually paints — and in a PDF that answer is a *function*: a
 * sampled table (type 0), an exponential interpolation (type 2), a stitch of
 * other functions (type 3) or a PostScript calculator program (type 4, what
 * Illustrator and InDesign write for nearly every spot-colour tint transform).
 *
 * Every parser here returns `null` for anything it does not fully understand,
 * never a guess: the caller turns `null` into "this page is rasterised instead",
 * which is honest, where a wrong function would silently paint the wrong grey.
 */
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream } from 'pdf-lib';
import type { PDFContext } from 'pdf-lib';
import { decodePDFRawStream } from 'pdf-lib';

export interface PdfFunction {
  /** Input domain, `[min0, max0, min1, max1, …]`. */
  domain: number[];
  /** Number of outputs. */
  outputs: number;
  evaluate(input: readonly number[]): number[];
}

function resolve(value: unknown, context: PDFContext): unknown {
  return value instanceof PDFRef ? context.lookup(value) : value;
}

function numbers(value: unknown, context: PDFContext): number[] | null {
  const array = resolve(value, context);
  if (!(array instanceof PDFArray)) return null;
  const out: number[] = [];
  for (let i = 0; i < array.size(); i++) {
    const entry = resolve(array.get(i), context);
    if (!(entry instanceof PDFNumber)) return null;
    out.push(entry.asNumber());
  }
  return out;
}

function clip(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function interpolate(x: number, x0: number, x1: number, y0: number, y1: number): number {
  return x1 === x0 ? y0 : y0 + ((x - x0) * (y1 - y0)) / (x1 - x0);
}

/** Decoded stream bytes, or null when the filter chain cannot be decoded. */
function streamBytes(stream: PDFStream): Uint8Array | null {
  try {
    if (stream instanceof PDFRawStream) return decodePDFRawStream(stream).decode();
    const maybe = stream as unknown as { getUnencodedContents?: () => Uint8Array };
    if (typeof maybe.getUnencodedContents === 'function') return maybe.getUnencodedContents();
    return stream.getContents();
  } catch {
    return null;
  }
}

function withRange(fn: PdfFunction, range: number[] | null): PdfFunction {
  if (!range) return fn;
  return {
    domain: fn.domain,
    outputs: fn.outputs,
    evaluate(input) {
      const out = fn.evaluate(input);
      return out.map((v, i) =>
        2 * i + 1 < range.length ? clip(v, range[2 * i], range[2 * i + 1]) : v
      );
    }
  };
}

/** Reads `bits`-wide unsigned samples from a big-endian bit stream. */
function readSample(data: Uint8Array, index: number, bits: number): number {
  if (bits === 8) return data[index] ?? 0;
  if (bits === 16) return ((data[index * 2] ?? 0) << 8) | (data[index * 2 + 1] ?? 0);
  let bitPos = index * bits;
  let value = 0;
  for (let i = 0; i < bits; i++) {
    const byte = data[bitPos >> 3] ?? 0;
    const bit = (byte >> (7 - (bitPos & 7))) & 1;
    value = value * 2 + bit;
    bitPos++;
  }
  return value;
}

function sampledFunction(stream: PDFStream, context: PDFContext): PdfFunction | null {
  const dict = stream.dict;
  const domain = numbers(dict.get(PDFName.of('Domain')), context);
  const range = numbers(dict.get(PDFName.of('Range')), context);
  const size = numbers(dict.get(PDFName.of('Size')), context);
  const bpsValue = resolve(dict.get(PDFName.of('BitsPerSample')), context);
  if (!domain || !range || !size || !(bpsValue instanceof PDFNumber)) return null;
  const bps = bpsValue.asNumber();
  if (![1, 2, 4, 8, 12, 16, 24, 32].includes(bps)) return null;
  const m = domain.length / 2;
  const n = range.length / 2;
  if (m < 1 || n < 1 || size.length !== m || size.some(s => !(s >= 1))) return null;
  const encode = numbers(dict.get(PDFName.of('Encode')), context) ?? size.flatMap(s => [0, s - 1]);
  const decode = numbers(dict.get(PDFName.of('Decode')), context) ?? range;
  const data = streamBytes(stream);
  if (!data) return null;
  const maxSample = 2 ** bps - 1;

  const sampleAt = (indices: number[], output: number): number => {
    let offset = 0;
    let stride = 1;
    for (let i = 0; i < m; i++) {
      offset += indices[i] * stride;
      stride *= size[i];
    }
    return readSample(data, offset * n + output, bps);
  };

  return withRange(
    {
      domain,
      outputs: n,
      evaluate(input) {
        const positions: number[] = [];
        for (let i = 0; i < m; i++) {
          const x = clip(input[i] ?? 0, domain[2 * i], domain[2 * i + 1]);
          const e = interpolate(
            x,
            domain[2 * i],
            domain[2 * i + 1],
            encode[2 * i],
            encode[2 * i + 1]
          );
          positions.push(clip(e, 0, size[i] - 1));
        }
        const out: number[] = [];
        for (let j = 0; j < n; j++) {
          let sample: number;
          if (m === 1) {
            // Linear interpolation for the common one-input case (tint
            // transforms, axial/radial shadings).
            const lo = Math.floor(positions[0]);
            const hi = Math.min(size[0] - 1, lo + 1);
            const t = positions[0] - lo;
            sample = sampleAt([lo], j) * (1 - t) + sampleAt([hi], j) * t;
          } else {
            sample = sampleAt(
              positions.map(p => Math.round(p)),
              j
            );
          }
          out.push(interpolate(sample, 0, maxSample, decode[2 * j], decode[2 * j + 1]));
        }
        return out;
      }
    },
    range
  );
}

function exponentialFunction(dict: PDFDict, context: PDFContext): PdfFunction | null {
  const domain = numbers(dict.get(PDFName.of('Domain')), context);
  if (!domain || domain.length < 2) return null;
  const c0 = numbers(dict.get(PDFName.of('C0')), context) ?? [0];
  const c1 = numbers(dict.get(PDFName.of('C1')), context) ?? [1];
  const nValue = resolve(dict.get(PDFName.of('N')), context);
  if (!(nValue instanceof PDFNumber) || c0.length !== c1.length) return null;
  const exponent = nValue.asNumber();
  const range = numbers(dict.get(PDFName.of('Range')), context);
  return withRange(
    {
      domain: domain.slice(0, 2),
      outputs: c0.length,
      evaluate(input) {
        const x = clip(input[0] ?? 0, domain[0], domain[1]);
        const xn = x ** exponent;
        return c0.map((a, i) => a + xn * (c1[i] - a));
      }
    },
    range
  );
}

function stitchingFunction(dict: PDFDict, context: PDFContext, depth: number): PdfFunction | null {
  const domain = numbers(dict.get(PDFName.of('Domain')), context);
  const bounds = numbers(dict.get(PDFName.of('Bounds')), context);
  const encode = numbers(dict.get(PDFName.of('Encode')), context);
  const list = resolve(dict.get(PDFName.of('Functions')), context);
  if (!domain || !bounds || !encode || !(list instanceof PDFArray)) return null;
  const functions: PdfFunction[] = [];
  for (let i = 0; i < list.size(); i++) {
    const fn = parseFunctionInternal(list.get(i), context, depth + 1);
    if (!fn) return null;
    functions.push(fn);
  }
  const k = functions.length;
  if (k === 0 || bounds.length !== k - 1 || encode.length !== 2 * k) return null;
  const outputs = functions[0].outputs;
  if (functions.some(f => f.outputs !== outputs)) return null;
  const range = numbers(dict.get(PDFName.of('Range')), context);
  return withRange(
    {
      domain: domain.slice(0, 2),
      outputs,
      evaluate(input) {
        const x = clip(input[0] ?? 0, domain[0], domain[1]);
        let i = 0;
        while (i < bounds.length && x >= bounds[i]) i++;
        const lo = i === 0 ? domain[0] : bounds[i - 1];
        const hi = i === bounds.length ? domain[1] : bounds[i];
        const e = interpolate(x, lo, hi, encode[2 * i], encode[2 * i + 1]);
        return functions[i].evaluate([e]);
      }
    },
    range
  );
}

/* ------------------------------------------------------------------ *
 * Type 4 — the PostScript calculator subset (§7.10.5).
 * ------------------------------------------------------------------ */

type PsNode = number | boolean | string | { ifTrue: PsNode[]; ifFalse?: PsNode[] };

/** Parses `{ … }` into a tree; `if`/`ifelse` bind to the preceding procedures. */
function parsePostScript(text: string): PsNode[] | null {
  const tokens = text.match(/[{}]|[^\s{}]+/g);
  if (!tokens || tokens[0] !== '{') return null;
  let pos = 1;
  const parseBlock = (): PsNode[] | null => {
    const out: PsNode[] = [];
    const procs: PsNode[][] = [];
    while (pos < tokens.length) {
      const token = tokens[pos++];
      if (token === '}') {
        return procs.length === 0 ? out : null;
      }
      if (token === '{') {
        const block = parseBlock();
        if (!block) return null;
        procs.push(block);
        continue;
      }
      if (token === 'if') {
        const body = procs.pop();
        if (!body || procs.length !== 0) return null;
        out.push({ ifTrue: body });
        continue;
      }
      if (token === 'ifelse') {
        const ifFalse = procs.pop();
        const ifTrue = procs.pop();
        if (!ifTrue || !ifFalse || procs.length !== 0) return null;
        out.push({ ifTrue, ifFalse });
        continue;
      }
      if (procs.length !== 0) return null;
      if (token === 'true' || token === 'false') {
        out.push(token === 'true');
        continue;
      }
      const number = Number(token);
      if (Number.isFinite(number) && /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(token)) {
        out.push(number);
        continue;
      }
      out.push(token);
    }
    return null;
  };
  return parseBlock();
}

const PS_OPERATORS = new Set([
  'abs',
  'add',
  'atan',
  'ceiling',
  'cos',
  'cvi',
  'cvr',
  'div',
  'exp',
  'floor',
  'idiv',
  'ln',
  'log',
  'mod',
  'mul',
  'neg',
  'round',
  'sin',
  'sqrt',
  'sub',
  'truncate',
  'and',
  'bitshift',
  'eq',
  'ge',
  'gt',
  'le',
  'lt',
  'ne',
  'not',
  'or',
  'xor',
  'copy',
  'dup',
  'exch',
  'index',
  'pop',
  'roll'
]);

function validProgram(nodes: PsNode[]): boolean {
  return nodes.every(node => {
    if (typeof node === 'string') return PS_OPERATORS.has(node);
    if (typeof node === 'object') {
      return validProgram(node.ifTrue) && (!node.ifFalse || validProgram(node.ifFalse));
    }
    return true;
  });
}

/** Limits that stop a hostile program from spinning the worker. */
const PS_MAX_STACK = 100;
const PS_MAX_STEPS = 10_000;

function runPostScript(program: PsNode[], stack: (number | boolean)[]): boolean {
  let steps = 0;
  const num = (): number => {
    const v = stack.pop();
    return typeof v === 'boolean' ? (v ? 1 : 0) : (v ?? 0);
  };
  const run = (nodes: PsNode[]): boolean => {
    for (const node of nodes) {
      if (++steps > PS_MAX_STEPS || stack.length > PS_MAX_STACK) return false;
      if (typeof node === 'number' || typeof node === 'boolean') {
        stack.push(node);
        continue;
      }
      if (typeof node === 'object') {
        const cond = stack.pop();
        const branch = cond === true || cond === 1 ? node.ifTrue : node.ifFalse;
        if (branch && !run(branch)) return false;
        continue;
      }
      switch (node) {
        case 'abs':
          stack.push(Math.abs(num()));
          break;
        case 'add': {
          const b = num();
          stack.push(num() + b);
          break;
        }
        case 'sub': {
          const b = num();
          stack.push(num() - b);
          break;
        }
        case 'mul': {
          const b = num();
          stack.push(num() * b);
          break;
        }
        case 'div': {
          const b = num();
          const a = num();
          stack.push(b === 0 ? 0 : a / b);
          break;
        }
        case 'idiv': {
          const b = Math.trunc(num());
          const a = Math.trunc(num());
          stack.push(b === 0 ? 0 : Math.trunc(a / b));
          break;
        }
        case 'mod': {
          const b = Math.trunc(num());
          const a = Math.trunc(num());
          stack.push(b === 0 ? 0 : a % b);
          break;
        }
        case 'neg':
          stack.push(-num());
          break;
        case 'ceiling':
          stack.push(Math.ceil(num()));
          break;
        case 'floor':
          stack.push(Math.floor(num()));
          break;
        case 'round':
          stack.push(Math.round(num()));
          break;
        case 'truncate':
        case 'cvi':
          stack.push(Math.trunc(num()));
          break;
        case 'cvr':
          stack.push(num());
          break;
        case 'sqrt':
          stack.push(Math.sqrt(Math.max(0, num())));
          break;
        case 'sin':
          stack.push(Math.sin((num() * Math.PI) / 180));
          break;
        case 'cos':
          stack.push(Math.cos((num() * Math.PI) / 180));
          break;
        case 'atan': {
          const den = num();
          const numer = num();
          let deg = (Math.atan2(numer, den) * 180) / Math.PI;
          if (deg < 0) deg += 360;
          stack.push(deg);
          break;
        }
        case 'exp': {
          const e = num();
          stack.push(num() ** e);
          break;
        }
        case 'ln':
          stack.push(Math.log(num()));
          break;
        case 'log':
          stack.push(Math.log10(num()));
          break;
        case 'eq': {
          const b = stack.pop();
          const a = stack.pop();
          stack.push(a === b);
          break;
        }
        case 'ne': {
          const b = stack.pop();
          const a = stack.pop();
          stack.push(a !== b);
          break;
        }
        case 'gt': {
          const b = num();
          stack.push(num() > b);
          break;
        }
        case 'ge': {
          const b = num();
          stack.push(num() >= b);
          break;
        }
        case 'lt': {
          const b = num();
          stack.push(num() < b);
          break;
        }
        case 'le': {
          const b = num();
          stack.push(num() <= b);
          break;
        }
        case 'and': {
          const b = stack.pop();
          const a = stack.pop();
          stack.push(typeof a === 'boolean' ? a && b === true : Number(a) & Number(b));
          break;
        }
        case 'or': {
          const b = stack.pop();
          const a = stack.pop();
          stack.push(typeof a === 'boolean' ? a || b === true : Number(a) | Number(b));
          break;
        }
        case 'xor': {
          const b = stack.pop();
          const a = stack.pop();
          stack.push(typeof a === 'boolean' ? a !== (b === true) : Number(a) ^ Number(b));
          break;
        }
        case 'not': {
          const a = stack.pop();
          stack.push(typeof a === 'boolean' ? !a : ~Number(a));
          break;
        }
        case 'bitshift': {
          const shift = num();
          const a = Math.trunc(num());
          stack.push(shift >= 0 ? a << shift : a >> -shift);
          break;
        }
        case 'dup': {
          const a = stack[stack.length - 1];
          if (a === undefined) return false;
          stack.push(a);
          break;
        }
        case 'exch': {
          const b = stack.pop();
          const a = stack.pop();
          if (a === undefined || b === undefined) return false;
          stack.push(b, a);
          break;
        }
        case 'pop':
          stack.pop();
          break;
        case 'copy': {
          const n = Math.trunc(num());
          if (n < 0 || n > stack.length) return false;
          stack.push(...stack.slice(stack.length - n));
          break;
        }
        case 'index': {
          const n = Math.trunc(num());
          const v = stack[stack.length - 1 - n];
          if (v === undefined) return false;
          stack.push(v);
          break;
        }
        case 'roll': {
          const j = Math.trunc(num());
          const n = Math.trunc(num());
          if (n < 0 || n > stack.length) return false;
          if (n === 0) break;
          const part = stack.splice(stack.length - n, n);
          const shift = ((j % n) + n) % n;
          stack.push(...part.slice(n - shift), ...part.slice(0, n - shift));
          break;
        }
        default:
          return false;
      }
    }
    return true;
  };
  return run(program);
}

function postScriptFunction(stream: PDFStream, context: PDFContext): PdfFunction | null {
  const domain = numbers(stream.dict.get(PDFName.of('Domain')), context);
  const range = numbers(stream.dict.get(PDFName.of('Range')), context);
  if (!domain || !range) return null;
  const bytes = streamBytes(stream);
  if (!bytes) return null;
  let text = '';
  for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
  const program = parsePostScript(text);
  if (!program || !validProgram(program)) return null;
  const outputs = range.length / 2;
  const inputs = domain.length / 2;
  // Evaluated once at the domain's midpoint so a program that cannot run at
  // all (a stack underflow, an unknown operator) is refused up front rather
  // than silently returning zeros for every colour.
  const probe: (number | boolean)[] = [];
  for (let i = 0; i < inputs; i++) probe.push((domain[2 * i] + domain[2 * i + 1]) / 2);
  if (!runPostScript(program, probe) || probe.length < outputs) return null;
  return {
    domain,
    outputs,
    evaluate(input) {
      const stack: (number | boolean)[] = [];
      for (let i = 0; i < inputs; i++) {
        stack.push(clip(input[i] ?? 0, domain[2 * i], domain[2 * i + 1]));
      }
      if (!runPostScript(program, stack)) return new Array(outputs).fill(0);
      const out = stack
        .slice(stack.length - outputs)
        .map(v => (typeof v === 'boolean' ? (v ? 1 : 0) : v));
      return out.map((v, i) => clip(v, range[2 * i], range[2 * i + 1]));
    }
  };
}

function parseFunctionInternal(
  value: unknown,
  context: PDFContext,
  depth: number
): PdfFunction | null {
  if (depth > 8) return null;
  const resolved = resolve(value, context);
  const dict =
    resolved instanceof PDFStream ? resolved.dict : resolved instanceof PDFDict ? resolved : null;
  if (!dict) return null;
  const type = resolve(dict.get(PDFName.of('FunctionType')), context);
  if (!(type instanceof PDFNumber)) return null;
  switch (type.asNumber()) {
    case 0:
      return resolved instanceof PDFStream ? sampledFunction(resolved, context) : null;
    case 2:
      return exponentialFunction(dict, context);
    case 3:
      return stitchingFunction(dict, context, depth);
    case 4:
      return resolved instanceof PDFStream ? postScriptFunction(resolved, context) : null;
    default:
      return null;
  }
}

/** Parses one function object, or null when it cannot be evaluated faithfully. */
export function parseFunction(value: unknown, context: PDFContext): PdfFunction | null {
  return parseFunctionInternal(value, context, 0);
}

/**
 * A shading's `/Function` may be one n-output function or an array of n
 * one-output functions (§8.7.4.5). Both become one n-output function here.
 */
export function parseFunctionOrArray(value: unknown, context: PDFContext): PdfFunction | null {
  const resolved = resolve(value, context);
  if (!(resolved instanceof PDFArray)) return parseFunction(resolved, context);
  const parts: PdfFunction[] = [];
  for (let i = 0; i < resolved.size(); i++) {
    const fn = parseFunction(resolved.get(i), context);
    if (!fn || fn.outputs !== 1) return null;
    parts.push(fn);
  }
  if (parts.length === 0) return null;
  return {
    domain: parts[0].domain,
    outputs: parts.length,
    evaluate: input => parts.map(fn => fn.evaluate(input)[0])
  };
}
