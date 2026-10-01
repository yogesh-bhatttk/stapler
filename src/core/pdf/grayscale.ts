/**
 * GAP-6 — greyscale / black-and-white conversion, the pdf-lib half.
 *
 * The goal is a document with no colour left in it that is otherwise the same
 * document: text stays text, vectors stay vectors. So conversion is done on the
 * PDF's own objects wherever possible —
 *
 *  • colour operators (`rg`/`RG`, `k`/`K`, `cs`+`sc`/`scn` over DeviceRGB,
 *    DeviceCMYK, ICCBased, CalRGB, Lab, Indexed, Separation and DeviceN) are
 *    rewritten to `g`/`G` with the colour's luminance;
 *  • shadings get their colour function resampled to one grey output;
 *  • coloured tiling patterns, Form XObjects, Type 3 glyphs and annotation
 *    appearance streams are rewritten the same way, recursively;
 *  • image XObjects are replaced by DeviceGray images decoded by pdf.js in the
 *    render worker (it is the decoder that knows CMYK JPEGs, Indexed palettes,
 *    16-bit samples and ICC profiles), keeping `/SMask` and every other entry.
 *
 * Anything this cannot convert faithfully — an inline image, a mesh shading
 * with per-vertex colour, a tint transform it cannot evaluate, a `/None`
 * separation — is not guessed at. The page is reported with the reason and
 * rasterised instead (the orchestrator renders it through pdf.js), and the
 * report names every rasterised page.
 *
 * Every object this rewrites is written as a *new* object; nothing reachable
 * from a page the user did not select is ever mutated, so converting pages 2–3
 * of a document that shares a logo form with page 1 leaves page 1 in colour.
 * Shared objects are converted once (memoised by object number) and the new
 * copy is shared again by every converted page that used the original.
 *
 * The same walker runs three ways: `plan` on a throwaway copy (what needs
 * pixels, which pages need rasterising), `apply` with the pixels in hand, and
 * `plan` again on the *output* as the verification — a converted page must come
 * back with nothing left to convert.
 */
import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  decodePDFRawStream
} from 'pdf-lib';
import type { PDFContext, PDFDocument, PDFObject } from 'pdf-lib';
import { zlibSync } from 'fflate';
import {
  parseContentStream,
  serializeStatements,
  tokenizeContentStream,
  type Statement,
  type Token
} from './interpreter';
import { parseFunction, parseFunctionOrArray, type PdfFunction } from './functions';
import { encodeGrayJpeg } from '../jpeg-gray';
import { translate } from '../i18n';

export type GrayMode = 'gray' | 'bw';

/**
 * Grey samples already encoded as a DeviceGray image stream's data. The render
 * worker encodes each image and page raster as soon as it has the pixels, so
 * a whole document's worth of raw pixels is never held at once (PDF-5): only
 * the compressed payloads travel to the process worker.
 */
export interface EncodedGray {
  data: Uint8Array;
  filter: 'FlateDecode' | 'DCTDecode';
  bitsPerComponent: 1 | 8;
}

/** The JPEG quality grey images and page rasters are written at. */
export const GRAY_JPEG_QUALITY = 0.85;

/** Decoded pixels for one image XObject, from the render worker. */
export interface GrayImageData {
  objectNumber: number;
  width: number;
  height: number;
  /**
   * One byte per pixel, 0 = black … 255 = white. In `bw` mode already 0 or
   * 255. Absent when `encoded` carries the samples instead.
   */
  gray?: Uint8Array;
  /** The samples, already encoded — used as is when present. */
  encoded?: EncodedGray;
  /** Alpha, when pdf.js reported transparency — needed only to replace a colour-key `/Mask`. */
  alpha?: Uint8Array;
}

/** One page rendered to grey pixels, for pages the vector path cannot convert. */
export interface GrayRaster {
  pageIndex: number;
  width: number;
  height: number;
  /** Raw samples; absent when `encoded` carries them instead. */
  gray?: Uint8Array;
  encoded?: EncodedGray;
  /** The box pdf.js rendered (unrotated user space): `[x0, y0, x1, y1]`. */
  view: [number, number, number, number];
  /**
   * True when the page's annotations were rendered into the raster (one of
   * them could not be converted as vectors). They are then hidden on the
   * output page so they are not drawn a second time, in colour, on top.
   */
  annotationsIncluded?: boolean;
}

export interface GrayPagePlan {
  pageIndex: number;
  /** Why the page cannot be converted as vectors. Empty when it can. Translated. */
  rasterReasons: string[];
  /** Colour (or, in `bw` mode, not-yet-1-bit) image XObjects, by object number. */
  images: number[];
  /** Of `images`, those in an encoding pdf.js cannot decode (JPX, JBIG2). */
  undecodable: number[];
  /** Of `images`, those stored lossily (DCT, JPX) — their grey copy is written as JPEG. */
  lossy: number[];
  /**
   * True when a *visible* annotation on the page could not be converted as
   * vectors: a raster of the page must then include the annotations (and the
   * annotations be hidden), or their colour would stay on top of it.
   */
  flattenAnnotations: boolean;
  /** Colour constructs found: operators, shadings, patterns, images, annotation colours. */
  colourConstructs: number;
  /** Of those, the ones that visibly carry colour — zero means "already grey". */
  chromaticConstructs: number;
}

export interface GrayPageOutcome {
  pageIndex: number;
  route: 'vector' | 'raster' | 'unchanged' | 'failed';
  reasons: string[];
  imagesConverted: number;
  imagesLeftInColour: number;
}

/* ------------------------------------------------------------------ *
 * Colour maths
 * ------------------------------------------------------------------ */

/** Rec. 709 luma — the weighting scan cleanup already uses (`cv/enhance.ts`). */
export function luma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function cmykToGray(c: number, m: number, y: number, k: number): number {
  return luma((1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k));
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0;
}

/** Four decimals, never exponent notation — a content stream cannot parse `1e-5`. */
export function formatNumber(v: number): string {
  const fixed = Number(clamp01(v).toFixed(4));
  return String(fixed);
}

type ColorSpace =
  | { kind: 'gray' }
  | { kind: 'rgb' }
  | { kind: 'cmyk' }
  | { kind: 'lab'; range: number[] }
  | { kind: 'indexed'; base: ColorSpace; hival: number; lookup: Uint8Array }
  | { kind: 'tint'; inputs: number; alt: ColorSpace; fn: PdfFunction }
  | { kind: 'pattern'; base: ColorSpace | null }
  | { kind: 'unsupported'; reason: string };

const GRAY: ColorSpace = { kind: 'gray' };
const RGB: ColorSpace = { kind: 'rgb' };
const CMYK: ColorSpace = { kind: 'cmyk' };

function components(cs: ColorSpace): number {
  switch (cs.kind) {
    case 'gray':
    case 'indexed':
      return 1;
    case 'rgb':
    case 'lab':
      return 3;
    case 'cmyk':
      return 4;
    case 'tint':
      return cs.inputs;
    case 'pattern':
      return cs.base ? components(cs.base) : 0;
    default:
      return 0;
  }
}

/** Luminance 0..1 of `comps` in `cs`, or null when `cs` cannot be converted. */
function toGray(cs: ColorSpace, comps: readonly number[]): number | null {
  switch (cs.kind) {
    case 'gray':
      return clamp01(comps[0] ?? 0);
    case 'rgb':
      return clamp01(luma(comps[0] ?? 0, comps[1] ?? 0, comps[2] ?? 0));
    case 'cmyk':
      return clamp01(cmykToGray(comps[0] ?? 0, comps[1] ?? 0, comps[2] ?? 0, comps[3] ?? 0));
    case 'lab':
      return clamp01((comps[0] ?? 0) / 100);
    case 'indexed': {
      const n = components(cs.base);
      const index = Math.max(0, Math.min(cs.hival, Math.round(comps[0] ?? 0)));
      const base: number[] = [];
      for (let i = 0; i < n; i++) {
        const byte = cs.lookup[index * n + i] ?? 0;
        if (cs.base.kind === 'lab') {
          // Lab lookup bytes map onto L 0..100 and the a/b ranges.
          const lo = i === 0 ? 0 : (cs.base.range[(i - 1) * 2] ?? -100);
          const hi = i === 0 ? 100 : (cs.base.range[(i - 1) * 2 + 1] ?? 100);
          base.push(lo + (byte / 255) * (hi - lo));
        } else {
          base.push(byte / 255);
        }
      }
      return toGray(cs.base, base);
    }
    case 'tint': {
      const alt = cs.fn.evaluate(comps);
      return alt ? toGray(cs.alt, alt) : null;
    }
    default:
      return null;
  }
}

/** The colour a `cs` operator installs (§8.6.8 Table 74's initial values). */
function initialComponents(cs: ColorSpace): number[] {
  switch (cs.kind) {
    case 'cmyk':
      return [0, 0, 0, 1];
    case 'tint':
      return new Array<number>(cs.inputs).fill(1);
    case 'lab':
      return [0, 0, 0];
    default:
      return new Array<number>(Math.max(1, components(cs))).fill(0);
  }
}

/** True when `nums` is a grey already (R = G = B, or C = M = Y), so converting it changes nothing visible. */
function neutral(cs: ColorSpace, nums: readonly number[] | null): boolean {
  if (!nums) return false;
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-4;
  if (cs.kind === 'gray') return true;
  if (cs.kind === 'rgb') return near(nums[0], nums[1]) && near(nums[1], nums[2]);
  if (cs.kind === 'cmyk') return near(nums[0], nums[1]) && near(nums[1], nums[2]);
  return false;
}

function convertible(cs: ColorSpace): boolean {
  return cs.kind !== 'gray' && cs.kind !== 'pattern' && cs.kind !== 'unsupported';
}

/* ------------------------------------------------------------------ *
 * Small pdf-lib helpers
 * ------------------------------------------------------------------ */

function lookup(value: unknown, context: PDFContext): unknown {
  return value instanceof PDFRef ? context.lookup(value) : value;
}

function nameString(value: unknown): string | null {
  return value instanceof PDFName ? value.decodeText() : null;
}

function numberList(value: unknown, context: PDFContext): number[] | null {
  const array = lookup(value, context);
  if (!(array instanceof PDFArray)) return null;
  const out: number[] = [];
  for (let i = 0; i < array.size(); i++) {
    const entry = lookup(array.get(i), context);
    if (!(entry instanceof PDFNumber)) return null;
    out.push(entry.asNumber());
  }
  return out;
}

function filterNames(dict: PDFDict, context: PDFContext): string[] {
  const value = lookup(dict.get(PDFName.of('Filter')), context);
  if (value instanceof PDFName) return [value.decodeText()];
  if (value instanceof PDFArray) {
    const names: string[] = [];
    for (let i = 0; i < value.size(); i++) {
      const entry = lookup(value.get(i), context);
      names.push(entry instanceof PDFName ? entry.decodeText() : 'unknown');
    }
    return names;
  }
  return [];
}

/** Decoded stream bytes; throws when the filter chain is one pdf-lib cannot undo. */
function decodedBytes(stream: PDFStream): Uint8Array {
  if (stream instanceof PDFRawStream) {
    const filters = filterNames(stream.dict, stream.dict.context);
    if (filters.length === 0) return stream.getContents();
    return decodePDFRawStream(stream).decode();
  }
  const maybe = stream as unknown as { getUnencodedContents?: () => Uint8Array };
  if (typeof maybe.getUnencodedContents === 'function') return maybe.getUnencodedContents();
  return stream.getContents();
}

function ascii(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

function tokenText(token: Token): string {
  let s = '';
  for (let i = 0; i < token.bytes.length; i++) s += String.fromCharCode(token.bytes[i]);
  return s;
}

/** A content-stream name token (`/CS0`, or one with a hex escape) as the key pdf-lib stores. */
function nameFromToken(token: Token): string | null {
  if (token.type !== 'name') return null;
  const raw = tokenText(token).slice(1);
  return raw.replace(/#([0-9a-fA-F]{2})/g, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16))
  );
}

function numberToken(v: number): Token {
  return { type: 'number', bytes: ascii(formatNumber(v)) };
}

function nameToken(name: string): Token {
  // Anything outside the regular-character set is #-escaped, as §7.3.5 asks.
  let out = '/';
  for (const ch of name) {
    const code = ch.charCodeAt(0);
    out +=
      code < 0x21 || code > 0x7e || '()<>[]{}/%#'.includes(ch)
        ? `#${code.toString(16).padStart(2, '0')}`
        : ch;
  }
  return { type: 'name', bytes: ascii(out) };
}

function operatorToken(op: string): Token {
  return { type: 'operator', bytes: ascii(op) };
}

function numericOperands(operands: Token[]): number[] | null {
  const out: number[] = [];
  for (const token of operands) {
    if (token.type !== 'number') return null;
    const value = Number(tokenText(token));
    if (!Number.isFinite(value)) return null;
    out.push(value);
  }
  return out;
}

function flateStream(
  context: PDFContext,
  bytes: Uint8Array,
  template?: PDFDict,
  drop: string[] = []
): PDFRef {
  const dict = template ? template.clone(context) : context.obj({});
  for (const key of ['Filter', 'DecodeParms', 'Length', 'DL', ...drop]) {
    dict.delete(PDFName.of(key));
  }
  dict.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
  return context.register(PDFRawStream.of(dict, zlibSync(bytes)));
}

/* ------------------------------------------------------------------ *
 * Resource scopes — copy-on-write views of a /Resources dictionary
 * ------------------------------------------------------------------ */

type Category = 'ColorSpace' | 'XObject' | 'Pattern' | 'Shading' | 'Font';

class ResourceScope {
  private readonly copies = new Map<Category, PDFDict>();
  private changed = false;

  constructor(
    private readonly context: PDFContext,
    readonly original: PDFDict | undefined
  ) {}

  get(category: Category, name: string): unknown {
    const copy = this.copies.get(category);
    const fromCopy = copy?.get(PDFName.of(name));
    if (fromCopy !== undefined) return fromCopy;
    const dict = this.original?.lookupMaybe(PDFName.of(category), PDFDict);
    return dict?.get(PDFName.of(name));
  }

  private writable(category: Category): PDFDict {
    let copy = this.copies.get(category);
    if (!copy) {
      const existing = this.original?.lookupMaybe(PDFName.of(category), PDFDict);
      copy = existing ? existing.clone(this.context) : this.context.obj({});
      this.copies.set(category, copy);
    }
    return copy;
  }

  /** Points `name` at `value`, returning the name actually used (never clobbers a different value). */
  set(category: Category, name: string, value: PDFObject): string {
    const dict = this.writable(category);
    const current = dict.get(PDFName.of(name));
    const originalValue = this.original
      ?.lookupMaybe(PDFName.of(category), PDFDict)
      ?.get(PDFName.of(name));
    if (current === value) return name;
    if (current === undefined || current === originalValue) {
      dict.set(PDFName.of(name), value);
      this.changed = true;
      return name;
    }
    // The same name already carries a *different* conversion (a form drawn
    // twice under different inherited colour state). Keep both.
    return this.add(category, `${name}_g`, value);
  }

  add(category: Category, preferred: string, value: PDFObject): string {
    const dict = this.writable(category);
    let name = preferred;
    for (let i = 1; dict.get(PDFName.of(name)) !== undefined; i++) name = `${preferred}${i}`;
    dict.set(PDFName.of(name), value);
    this.changed = true;
    return name;
  }

  private grayPattern: string | undefined;

  /** The name of a `[/Pattern /DeviceGray]` entry in this scope, added once. */
  grayPatternSpace(): string {
    this.grayPattern ??= this.add(
      'ColorSpace',
      'StaplerGrayPattern',
      this.context.obj([PDFName.of('Pattern'), PDFName.of('DeviceGray')])
    );
    return this.grayPattern;
  }

  private built: PDFDict | undefined;
  private identityKey: string | undefined;

  /**
   * What the original resources *say* — two scopes whose dictionaries list
   * the same names for the same objects resolve every name identically, even
   * when they are different dictionary objects (each page's own direct
   * /Resources, say).
   */
  identity(): string {
    this.identityKey ??= this.original ? this.original.toString() : '';
    return this.identityKey;
  }

  /** The resources to write, or `undefined` when nothing changed. */
  result(): PDFDict | undefined {
    if (!this.changed) return undefined;
    if (!this.built) {
      this.built = this.original ? this.original.clone(this.context) : this.context.obj({});
    }
    for (const [category, copy] of this.copies) this.built.set(PDFName.of(category), copy);
    return this.built;
  }
}

/* ------------------------------------------------------------------ *
 * The converter
 * ------------------------------------------------------------------ */

interface Effects {
  reasons: Set<string>;
  images: Set<number>;
  undecodable: Set<number>;
  lossy: Set<number>;
  /** Visible annotations whose conversion gave a reason. */
  annotationFailures: number;
  constructs: number;
  /** Of `constructs`, those that actually carry colour (not black written as `0 0 0 rg`). */
  chromatic: number;
}

function newEffects(): Effects {
  return {
    reasons: new Set(),
    images: new Set(),
    undecodable: new Set(),
    lossy: new Set(),
    annotationFailures: 0,
    constructs: 0,
    chromatic: 0
  };
}

function mergeEffects(into: Effects, from: Effects): void {
  for (const r of from.reasons) into.reasons.add(r);
  for (const i of from.images) into.images.add(i);
  for (const u of from.undecodable) into.undecodable.add(u);
  for (const l of from.lossy) into.lossy.add(l);
  into.annotationFailures += from.annotationFailures;
  into.constructs += from.constructs;
  into.chromatic += from.chromatic;
}

interface ColorState {
  fill: ColorSpace;
  stroke: ColorSpace;
}

interface Converted {
  value: PDFObject;
  changed: boolean;
}

interface FormMemo {
  converted: Converted;
  effects: Effects;
  inherited: ColorState;
  dependsFill: boolean;
  dependsStroke: boolean;
}

const MAX_DEPTH = 12;

/** Lossy image filters: their replacement is re-encoded as JPEG, lossless ones as Flate. */
const LOSSY_FILTERS = new Set(['DCTDecode', 'JPXDecode']);
const UNDECODABLE = new Set(['JPXDecode', 'JBIG2Decode']);

/** Keys of an image dictionary that describe the *samples* and are rewritten. */
const IMAGE_SAMPLE_KEYS = [
  'Width',
  'Height',
  'ColorSpace',
  'BitsPerComponent',
  'Filter',
  'DecodeParms',
  'Decode',
  'Length',
  'DL',
  'SMaskInData',
  'Alternates',
  'Mask'
];

export class GrayConverter {
  private readonly context: PDFContext;
  private effects: Effects = newEffects();
  private readonly csCache = new Map<unknown, ColorSpace>();
  private readonly imageMemo = new Map<number, { converted: Converted; effects: Effects }>();
  /**
   * Keyed by object number — plus, for a form with no /Resources of its own,
   * the resources it inherits, since what its names mean depends on them. A
   * resource-less form shared by many pages with the same resources is then
   * converted once, not once per page (PDF-6).
   */
  private readonly formMemo = new Map<string, FormMemo>();
  private readonly objectMemo = new Map<string, { converted: Converted; effects: Effects }>();
  private readonly smaskMemo = new Map<number, PDFRef>();
  /** Set while converting one content stream: which inherited spaces an `sc` relied on. */
  private inheritedUse: { state: ColorState; fill: boolean; stroke: boolean } | null = null;
  readonly convertedImages = new Set<number>();

  constructor(
    private readonly doc: PDFDocument,
    private readonly mode: GrayMode,
    /** Decoded pixels by object number; `null` in plan mode, where nothing is replaced. */
    private readonly images: Map<number, GrayImageData> | null,
    private readonly jpegQuality = GRAY_JPEG_QUALITY
  ) {
    this.context = doc.context;
  }

  private get planning(): boolean {
    return this.images === null;
  }

  private mapGray(v: number): number {
    return this.mode === 'bw' ? (v < 0.5 ? 0 : 1) : clamp01(v);
  }

  private lastChromatic = false;

  private hit(chromatic: boolean): void {
    this.effects.constructs++;
    if (chromatic) this.effects.chromatic++;
  }

  private reason(text: string): void {
    this.effects.reasons.add(text);
  }

  private capture<T>(fn: () => T): { result: T; effects: Effects } {
    const saved = this.effects;
    const captured = newEffects();
    this.effects = captured;
    try {
      return { result: fn(), effects: captured };
    } finally {
      this.effects = saved;
      mergeEffects(saved, captured);
    }
  }

  /* -------------------------- colour spaces --------------------------- */

  resolveColorSpace(value: unknown, scope: ResourceScope | undefined, depth = 0): ColorSpace {
    if (depth > 4) return { kind: 'unsupported', reason: 'depth' };
    const cacheKey = value instanceof PDFRef ? value.toString() : value;
    const cached =
      cacheKey instanceof PDFArray || typeof cacheKey === 'string'
        ? this.csCache.get(cacheKey)
        : undefined;
    if (cached) return cached;
    const cs = this.resolveColorSpaceUncached(value, scope, depth);
    if (cacheKey instanceof PDFArray || typeof cacheKey === 'string')
      this.csCache.set(cacheKey, cs);
    return cs;
  }

  private resolveColorSpaceUncached(
    value: unknown,
    scope: ResourceScope | undefined,
    depth: number
  ): ColorSpace {
    const resolved = lookup(value, this.context);
    const name = nameString(resolved);
    if (name !== null) {
      switch (name) {
        case 'DeviceGray':
        case 'G':
        case 'CalGray':
          return GRAY;
        case 'DeviceRGB':
        case 'RGB':
        case 'CalRGB':
          return RGB;
        case 'DeviceCMYK':
        case 'CMYK':
          return CMYK;
        case 'Pattern':
          return { kind: 'pattern', base: null };
        default: {
          const named = scope?.get('ColorSpace', name);
          if (named === undefined) {
            return { kind: 'unsupported', reason: `/${name}` };
          }
          return this.resolveColorSpace(named, undefined, depth + 1);
        }
      }
    }
    if (!(resolved instanceof PDFArray) || resolved.size() === 0) {
      return { kind: 'unsupported', reason: 'not a colour space' };
    }
    const family = nameString(lookup(resolved.get(0), this.context));
    switch (family) {
      case 'DeviceGray':
      case 'CalGray':
      case 'G':
        return GRAY;
      case 'DeviceRGB':
      case 'CalRGB':
      case 'RGB':
        return RGB;
      case 'DeviceCMYK':
      case 'CMYK':
        return CMYK;
      case 'ICCBased': {
        const stream = lookup(resolved.get(1), this.context);
        const n = stream instanceof PDFStream ? stream.dict.lookup(PDFName.of('N')) : undefined;
        const count = n instanceof PDFNumber ? n.asNumber() : 0;
        if (count === 1) return GRAY;
        if (count === 3) return RGB;
        if (count === 4) return CMYK;
        return { kind: 'unsupported', reason: 'ICCBased' };
      }
      case 'Lab': {
        const dict = lookup(resolved.get(1), this.context);
        const range = (dict instanceof PDFDict
          ? numberList(dict.get(PDFName.of('Range')), this.context)
          : null) ?? [-100, 100, -100, 100];
        return { kind: 'lab', range };
      }
      case 'Indexed':
      case 'I': {
        const base = this.resolveColorSpace(resolved.get(1), scope, depth + 1);
        const hival = lookup(resolved.get(2), this.context);
        const table = lookup(resolved.get(3), this.context);
        if (!convertible(base) && base.kind !== 'gray') {
          return { kind: 'unsupported', reason: 'Indexed' };
        }
        if (!(hival instanceof PDFNumber)) return { kind: 'unsupported', reason: 'Indexed' };
        let bytes: Uint8Array | null = null;
        if (table instanceof PDFString || table instanceof PDFHexString) bytes = table.asBytes();
        else if (table instanceof PDFStream) {
          try {
            bytes = decodedBytes(table);
          } catch {
            bytes = null;
          }
        }
        if (!bytes) return { kind: 'unsupported', reason: 'Indexed' };
        return { kind: 'indexed', base, hival: hival.asNumber(), lookup: bytes };
      }
      case 'Separation':
      case 'DeviceN': {
        const names = lookup(resolved.get(1), this.context);
        const inputs = family === 'Separation' ? 1 : names instanceof PDFArray ? names.size() : 0;
        const colorant = family === 'Separation' ? nameString(names) : null;
        if (colorant === 'None') {
          // `/None` paints nothing at all; DeviceGray has no way to say that.
          return { kind: 'unsupported', reason: 'Separation /None' };
        }
        const alt = this.resolveColorSpace(resolved.get(2), scope, depth + 1);
        const fn = parseFunction(resolved.get(3), this.context);
        if (!fn || inputs < 1 || alt.kind === 'unsupported' || alt.kind === 'pattern') {
          return { kind: 'unsupported', reason: family };
        }
        return { kind: 'tint', inputs, alt, fn };
      }
      case 'Pattern': {
        if (resolved.size() < 2) return { kind: 'pattern', base: null };
        const base = this.resolveColorSpace(resolved.get(1), scope, depth + 1);
        return { kind: 'pattern', base };
      }
      default:
        return { kind: 'unsupported', reason: family ?? 'unknown' };
    }
  }

  /* -------------------------- content streams --------------------------- */

  /**
   * The luminance of `nums` in `cs`, or null — with the reason recorded, so
   * the page is rasterised — when it cannot be computed (a tint transform
   * that fails at this input). Never a guessed grey.
   */
  private grayOrReason(cs: ColorSpace, nums: readonly number[]): number | null {
    const gray = toGray(cs, nums);
    if (gray === null) {
      this.reason(
        translate('uses a colour space Stapler cannot convert ({space})', {
          space: cs.kind === 'tint' ? 'Separation/DeviceN' : cs.kind
        })
      );
    }
    return gray;
  }

  /**
   * Rewrites one content stream's statements. `scope` receives any resource
   * that had to change (converted forms, images, patterns, shadings, fonts).
   */
  private convertStatements(
    statements: Statement[],
    scope: ResourceScope,
    inherited: ColorState,
    depth: number
  ): { statements: Statement[]; changed: boolean } {
    const out: Statement[] = [];
    let changed = false;
    let state: ColorState = { ...inherited };
    const stack: ColorState[] = [];
    const tracker = this.inheritedUse;

    const emit = (operands: Token[], op: string) => {
      out.push({ operands, operator: operatorToken(op) });
      changed = true;
    };

    for (const statement of statements) {
      const op = tokenText(statement.operator);
      const operands = statement.operands;
      switch (op) {
        case 'q':
          stack.push({ ...state });
          out.push(statement);
          break;
        case 'Q':
          state = stack.pop() ?? state;
          out.push(statement);
          break;
        case 'g':
        case 'G': {
          const stroke = op === 'G';
          state = stroke ? { ...state, stroke: GRAY } : { ...state, fill: GRAY };
          const nums = numericOperands(operands);
          if (this.mode === 'bw' && nums && nums.length === 1) {
            const v = this.mapGray(nums[0]);
            if (v !== nums[0]) {
              this.hit(true);
              emit([numberToken(v)], op);
              break;
            }
          }
          out.push(statement);
          break;
        }
        case 'rg':
        case 'RG':
        case 'k':
        case 'K': {
          const stroke = op === 'RG' || op === 'K';
          const cs = op.toLowerCase() === 'rg' ? RGB : CMYK;
          state = stroke ? { ...state, stroke: cs } : { ...state, fill: cs };
          const nums = numericOperands(operands);
          if (!nums || nums.length !== components(cs)) {
            out.push(statement);
            break;
          }
          this.hit(!neutral(cs, nums));
          emit([numberToken(this.mapGray(toGray(cs, nums) ?? 0))], stroke ? 'G' : 'g');
          break;
        }
        case 'cs':
        case 'CS': {
          const stroke = op === 'CS';
          const name = operands.length === 1 ? nameFromToken(operands[0]) : null;
          if (name === null) {
            out.push(statement);
            break;
          }
          const cs = this.resolveColorSpace(PDFName.of(name), scope);
          state = stroke ? { ...state, stroke: cs } : { ...state, fill: cs };
          if (cs.kind === 'gray') {
            out.push(statement);
            break;
          }
          if (cs.kind === 'unsupported') {
            this.reason(
              translate('uses a colour space Stapler cannot convert ({space})', {
                space: cs.reason
              })
            );
            out.push(statement);
            break;
          }
          if (cs.kind === 'pattern') {
            if (cs.base === null || cs.base.kind === 'gray') {
              out.push(statement);
              break;
            }
            if (!convertible(cs.base)) {
              this.reason(
                translate('uses an uncoloured pattern in a colour space Stapler cannot convert')
              );
              out.push(statement);
              break;
            }
            const grayPattern = scope.grayPatternSpace();
            this.hit(true);
            emit([nameToken(grayPattern)], op);
            break;
          }
          const initialGray = this.grayOrReason(cs, initialComponents(cs));
          if (initialGray === null) {
            out.push(statement);
            break;
          }
          this.hit(false);
          emit([nameToken('DeviceGray')], op);
          const initial = this.mapGray(initialGray);
          if (initial !== 0) emit([numberToken(initial)], stroke ? 'SC' : 'sc');
          break;
        }
        case 'sc':
        case 'scn':
        case 'SC':
        case 'SCN': {
          const stroke = op === 'SC' || op === 'SCN';
          const cs = stroke ? state.stroke : state.fill;
          if (tracker && cs === (stroke ? tracker.state.stroke : tracker.state.fill)) {
            if (stroke) tracker.stroke = true;
            else tracker.fill = true;
          }
          if (cs.kind === 'gray') {
            const nums = numericOperands(operands);
            if (this.mode === 'bw' && nums && nums.length === 1) {
              const v = this.mapGray(nums[0]);
              if (v !== nums[0]) {
                this.hit(true);
                emit([numberToken(v)], op);
                break;
              }
            }
            out.push(statement);
            break;
          }
          if (cs.kind === 'pattern') {
            const last = operands[operands.length - 1];
            const patternName = last ? nameFromToken(last) : null;
            if (patternName !== null) this.usePattern(patternName, scope, depth);
            if (cs.base && convertible(cs.base) && patternName !== null) {
              const nums = numericOperands(operands.slice(0, -1));
              const baseGray =
                nums && nums.length === components(cs.base)
                  ? this.grayOrReason(cs.base, nums)
                  : null;
              if (nums && baseGray !== null) {
                this.hit(
                  cs.base.kind !== 'rgb' && cs.base.kind !== 'cmyk' ? true : !neutral(cs.base, nums)
                );
                emit([numberToken(this.mapGray(baseGray)), nameToken(patternName)], op);
                break;
              }
            }
            out.push(statement);
            break;
          }
          if (cs.kind === 'unsupported') {
            out.push(statement);
            break;
          }
          const nums = numericOperands(operands);
          if (!nums || nums.length !== components(cs)) {
            out.push(statement);
            break;
          }
          const gray = this.grayOrReason(cs, nums);
          if (gray === null) {
            out.push(statement);
            break;
          }
          this.hit(!neutral(cs, nums));
          emit([numberToken(this.mapGray(gray))], stroke ? 'SC' : 'sc');
          break;
        }
        case 'sh': {
          const name = operands.length === 1 ? nameFromToken(operands[0]) : null;
          if (name !== null) {
            const original = scope.get('Shading', name);
            if (original !== undefined) {
              const converted = this.convertShading(original, scope);
              if (converted.changed) scope.set('Shading', name, converted.value);
            }
          }
          out.push(statement);
          break;
        }
        case 'Do': {
          const name = operands.length === 1 ? nameFromToken(operands[0]) : null;
          if (name === null) {
            out.push(statement);
            break;
          }
          const original = scope.get('XObject', name);
          if (original === undefined) {
            out.push(statement);
            break;
          }
          const converted = this.convertXObject(original, scope, state, depth);
          if (!converted.changed) {
            out.push(statement);
            break;
          }
          const used = scope.set('XObject', name, converted.value);
          if (used === name) out.push(statement);
          else emit([nameToken(used)], 'Do');
          break;
        }
        case 'Tf': {
          const name = operands.length === 2 ? nameFromToken(operands[0]) : null;
          if (name !== null) {
            const original = scope.get('Font', name);
            if (original !== undefined) {
              const converted = this.convertType3(original, scope, depth);
              if (converted.changed) scope.set('Font', name, converted.value);
            }
          }
          out.push(statement);
          break;
        }
        default:
          out.push(statement);
      }
    }
    return { statements: out, changed };
  }

  /** Parses and converts one content stream's bytes; `null` when it had to give up. */
  private convertContentBytes(
    bytes: Uint8Array,
    scope: ResourceScope,
    inherited: ColorState,
    depth: number
  ): { bytes: Uint8Array; changed: boolean } | null {
    let tokens: Token[];
    let statements: Statement[];
    try {
      tokens = tokenizeContentStream(bytes);
    } catch {
      this.reason(translate('has drawing instructions Stapler cannot read'));
      return null;
    }
    try {
      statements = parseContentStream(tokens);
    } catch {
      // The parser refuses inline images (`BI … ID … EI`); anything else it
      // throws on is reported as what it is, not as an inline image (PDF-8).
      const inline = tokens.some(t => t.type === 'operator' && tokenText(t) === 'ID');
      this.reason(
        inline
          ? translate('contains an inline image')
          : translate('has drawing instructions Stapler cannot read')
      );
      return null;
    }
    const converted = this.convertStatements(statements, scope, inherited, depth);
    return {
      bytes: converted.changed ? serializeStatements(converted.statements) : bytes,
      changed: converted.changed
    };
  }

  /* -------------------------- XObjects --------------------------- */

  private convertXObject(
    value: unknown,
    scope: ResourceScope,
    state: ColorState,
    depth: number
  ): Converted {
    const stream = lookup(value, this.context);
    if (!(stream instanceof PDFStream)) return { value: value as PDFObject, changed: false };
    const subtype = nameString(stream.dict.lookup(PDFName.of('Subtype')));
    if (subtype === 'Image') return this.convertImage(value as PDFObject, stream, scope);
    if (subtype === 'Form')
      return this.convertForm(value as PDFObject, stream, scope, state, depth);
    return { value: value as PDFObject, changed: false };
  }

  private imageIsGray(stream: PDFStream, scope: ResourceScope): boolean | 'unknown' {
    const dict = stream.dict;
    const imageMask = dict.lookup(PDFName.of('ImageMask'));
    if (imageMask && imageMask.toString() === 'true') return true; // a stencil paints the fill colour
    const filters = filterNames(dict, this.context);
    if (filters.includes('JBIG2Decode')) return true; // JBIG2 is always 1-bit grey
    const csValue = dict.get(PDFName.of('ColorSpace'));
    if (csValue === undefined) return filters.includes('JPXDecode') ? 'unknown' : true;
    const cs = this.resolveColorSpace(csValue, scope);
    if (cs.kind === 'gray') return true;
    if (cs.kind === 'indexed' && cs.base.kind === 'gray') return true;
    return false;
  }

  private convertImage(value: PDFObject, stream: PDFStream, scope: ResourceScope): Converted {
    const ref = value instanceof PDFRef ? value : undefined;
    const unchanged: Converted = { value, changed: false };
    if (!ref) {
      // A direct image stream cannot be addressed by object number, which is
      // how pdf.js reports what it decoded; there is no safe way to match it.
      if (this.imageIsGray(stream, scope) !== true) {
        this.reason(translate('contains an image Stapler cannot address for conversion'));
      }
      return unchanged;
    }
    const memo = this.imageMemo.get(ref.objectNumber);
    if (memo) {
      mergeEffects(this.effects, memo.effects);
      return memo.converted;
    }
    const { result, effects } = this.capture(() => this.convertImageUncached(ref, stream, scope));
    this.imageMemo.set(ref.objectNumber, { converted: result, effects });
    return result;
  }

  private convertImageUncached(ref: PDFRef, stream: PDFStream, scope: ResourceScope): Converted {
    const unchanged: Converted = { value: ref, changed: false };
    const dict = stream.dict;
    const gray = this.imageIsGray(stream, scope);
    const bpc = dict.lookup(PDFName.of('BitsPerComponent'));
    const oneBit = bpc instanceof PDFNumber && bpc.asNumber() === 1;
    const imageMask = dict.lookup(PDFName.of('ImageMask'));
    const isStencil = imageMask !== undefined && imageMask.toString() === 'true';
    const filters = filterNames(dict, this.context);
    const needsWork =
      gray === true
        ? this.mode === 'bw' && !oneBit && !isStencil && !filters.includes('JBIG2Decode')
        : true;
    if (!needsWork) return unchanged;

    this.hit(true);
    this.effects.images.add(ref.objectNumber);
    if (filters.some(f => UNDECODABLE.has(f))) this.effects.undecodable.add(ref.objectNumber);
    if (filters.some(f => LOSSY_FILTERS.has(f))) this.effects.lossy.add(ref.objectNumber);
    if (this.planning) return unchanged;

    const data = this.images?.get(ref.objectNumber);
    if (!data) return unchanged;
    const replacement = this.buildGrayImage(stream, filters, data);
    this.convertedImages.add(ref.objectNumber);
    return { value: replacement, changed: true };
  }

  /** Encodes raw grey samples the way this conversion writes them. */
  private encode(
    data: { gray?: Uint8Array; width: number; height: number },
    lossy: boolean
  ): EncodedGray {
    if (!data.gray) throw new Error('grey image has neither samples nor an encoding');
    return encodeGraySamples(
      data.gray,
      data.width,
      data.height,
      this.mode,
      lossy,
      this.jpegQuality
    );
  }

  private buildGrayImage(original: PDFStream, filters: string[], data: GrayImageData): PDFRef {
    const context = this.context;
    const dict = original.dict.clone(context);
    for (const key of IMAGE_SAMPLE_KEYS) dict.delete(PDFName.of(key));
    dict.set(PDFName.of('Type'), PDFName.of('XObject'));
    dict.set(PDFName.of('Subtype'), PDFName.of('Image'));
    dict.set(PDFName.of('Width'), PDFNumber.of(data.width));
    dict.set(PDFName.of('Height'), PDFNumber.of(data.height));
    dict.set(PDFName.of('ColorSpace'), PDFName.of('DeviceGray'));

    const encoded =
      data.encoded ??
      this.encode(
        data,
        filters.some(f => LOSSY_FILTERS.has(f))
      );
    const payload = encoded.data;
    dict.set(PDFName.of('BitsPerComponent'), PDFNumber.of(encoded.bitsPerComponent));
    dict.set(PDFName.of('Filter'), PDFName.of(encoded.filter));

    // Masks. An /SMask is already DeviceGray by definition and is kept as the
    // same object — unless it carries /Matte, the pre-blend colour in the
    // *base* image's colour space, which pdf.js has already un-blended while
    // decoding (see `ImageFacts.maskKind`), so a copy without it is attached.
    // A stencil /Mask stream is kept as is. A colour-key /Mask array names
    // exact sample values in the old colour space, which mean nothing in the
    // new one — it is replaced by a soft mask built from the alpha pdf.js
    // produced when it applied the key.
    const smask = original.dict.get(PDFName.of('SMask'));
    const smaskStream = lookup(smask, context);
    if (smaskStream instanceof PDFStream && smask instanceof PDFRef) {
      if (smaskStream.dict.get(PDFName.of('Matte')) !== undefined) {
        let copy = this.smaskMemo.get(smask.objectNumber);
        if (!copy) {
          const maskDict = smaskStream.dict.clone(context);
          maskDict.delete(PDFName.of('Matte'));
          copy = context.register(PDFRawStream.of(maskDict, smaskStream.getContents()));
          this.smaskMemo.set(smask.objectNumber, copy);
        }
        dict.set(PDFName.of('SMask'), copy);
      }
    }
    const mask = original.dict.get(PDFName.of('Mask'));
    const maskValue = lookup(mask, context);
    if (maskValue instanceof PDFStream && mask !== undefined) {
      dict.set(PDFName.of('Mask'), mask);
    } else if (maskValue instanceof PDFArray && data.alpha && smask === undefined) {
      const maskDict = context.obj({
        Type: 'XObject',
        Subtype: 'Image',
        Width: data.width,
        Height: data.height,
        ColorSpace: 'DeviceGray',
        BitsPerComponent: 8
      });
      dict.set(PDFName.of('SMask'), flateStream(context, data.alpha, maskDict));
    }

    return context.register(PDFRawStream.of(dict, payload));
  }

  private convertForm(
    value: PDFObject,
    stream: PDFStream,
    scope: ResourceScope,
    state: ColorState,
    depth: number
  ): Converted {
    const ref = value instanceof PDFRef ? value : undefined;
    const ownResources = stream.dict.lookupMaybe(PDFName.of('Resources'), PDFDict);
    const memoKey = ref
      ? ownResources
        ? String(ref.objectNumber)
        : `${ref.objectNumber}|${scope.identity()}`
      : undefined;
    const memo = memoKey !== undefined ? this.formMemo.get(memoKey) : undefined;
    if (
      memo &&
      !(memo.dependsFill && memo.inherited.fill !== state.fill) &&
      !(memo.dependsStroke && memo.inherited.stroke !== state.stroke)
    ) {
      mergeEffects(this.effects, memo.effects);
      return memo.converted;
    }
    const savedTracker = this.inheritedUse;
    const tracker = { state, fill: false, stroke: false };
    this.inheritedUse = tracker;
    let captured: { result: Converted; effects: Effects };
    try {
      captured = this.capture(() =>
        this.convertFormUncached(value, stream, ownResources, scope, state, depth)
      );
    } finally {
      this.inheritedUse = savedTracker;
    }
    if (memoKey !== undefined) {
      this.formMemo.set(memoKey, {
        converted: captured.result,
        effects: captured.effects,
        inherited: state,
        dependsFill: tracker.fill,
        dependsStroke: tracker.stroke
      });
    }
    return captured.result;
  }

  private convertFormUncached(
    value: PDFObject,
    stream: PDFStream,
    ownResources: PDFDict | undefined,
    parent: ResourceScope,
    state: ColorState,
    depth: number
  ): Converted {
    const unchanged: Converted = { value, changed: false };
    if (depth >= MAX_DEPTH) {
      this.reason(translate('nests drawings too deeply to convert'));
      return unchanged;
    }
    let bytes: Uint8Array;
    try {
      bytes = decodedBytes(stream);
    } catch {
      this.reason(translate('has a drawing stored in an encoding Stapler cannot read'));
      return unchanged;
    }
    // A form without its own /Resources reads the invoking scope's (§7.8.3).
    const scope = new ResourceScope(this.context, ownResources ?? parent.original);
    const converted = this.convertContentBytes(bytes, scope, state, depth + 1);
    if (!converted) return unchanged;
    const resources = scope.result();
    if (!converted.changed && !resources) return unchanged;
    if (this.planning) return unchanged;
    const dict = stream.dict.clone(this.context);
    if (resources) dict.set(PDFName.of('Resources'), resources);
    return { value: flateStream(this.context, converted.bytes, dict), changed: true };
  }

  /* -------------------------- patterns, shadings, fonts --------------------------- */

  private memoised(key: string | null, fn: () => Converted): Converted {
    if (key !== null) {
      const hit = this.objectMemo.get(key);
      if (hit) {
        mergeEffects(this.effects, hit.effects);
        return hit.converted;
      }
    }
    const { result, effects } = this.capture(fn);
    if (key !== null) this.objectMemo.set(key, { converted: result, effects });
    return result;
  }

  private usePattern(name: string, scope: ResourceScope, depth: number): void {
    const original = scope.get('Pattern', name);
    if (original === undefined) return;
    const key = original instanceof PDFRef ? `pattern:${original.objectNumber}` : null;
    const converted = this.memoised(key, () => this.convertPattern(original as PDFObject, depth));
    if (converted.changed) scope.set('Pattern', name, converted.value);
  }

  private convertPattern(value: PDFObject, depth: number): Converted {
    const unchanged: Converted = { value, changed: false };
    const resolved = lookup(value, this.context);
    const dict =
      resolved instanceof PDFStream ? resolved.dict : resolved instanceof PDFDict ? resolved : null;
    if (!dict) return unchanged;
    const type = dict.lookup(PDFName.of('PatternType'));
    const patternType = type instanceof PDFNumber ? type.asNumber() : 0;

    if (patternType === 2) {
      const shading = dict.get(PDFName.of('Shading'));
      if (shading === undefined) return unchanged;
      const converted = this.convertShading(shading, undefined);
      if (!converted.changed || this.planning) return unchanged;
      const copy = dict.clone(this.context);
      copy.set(PDFName.of('Shading'), converted.value);
      return { value: this.context.register(copy), changed: true };
    }

    if (patternType === 1 && resolved instanceof PDFStream) {
      const paint = dict.lookup(PDFName.of('PaintType'));
      // An uncoloured pattern's colour comes from the `scn` that selects it,
      // which the caller converts; its own content must not set colour.
      if (paint instanceof PDFNumber && paint.asNumber() === 2) return unchanged;
      const ownResources = dict.lookupMaybe(PDFName.of('Resources'), PDFDict);
      let bytes: Uint8Array;
      try {
        bytes = decodedBytes(resolved);
      } catch {
        this.reason(translate('has a pattern stored in an encoding Stapler cannot read'));
        return unchanged;
      }
      if (depth >= MAX_DEPTH) {
        this.reason(translate('nests drawings too deeply to convert'));
        return unchanged;
      }
      const scope = new ResourceScope(this.context, ownResources);
      const converted = this.convertContentBytes(
        bytes,
        scope,
        { fill: GRAY, stroke: GRAY },
        depth + 1
      );
      if (!converted) return unchanged;
      const resources = scope.result();
      if ((!converted.changed && !resources) || this.planning) return unchanged;
      const copy = dict.clone(this.context);
      if (resources) copy.set(PDFName.of('Resources'), resources);
      return { value: flateStream(this.context, converted.bytes, copy), changed: true };
    }
    return unchanged;
  }

  private convertShading(value: unknown, scope: ResourceScope | undefined): Converted {
    const key = value instanceof PDFRef ? `shading:${value.objectNumber}` : null;
    return this.memoised(key, () => this.convertShadingUncached(value as PDFObject, scope));
  }

  private convertShadingUncached(value: PDFObject, scope: ResourceScope | undefined): Converted {
    const unchanged: Converted = { value, changed: false };
    const resolved = lookup(value, this.context);
    const stream = resolved instanceof PDFStream ? resolved : null;
    const dict = stream ? stream.dict : resolved instanceof PDFDict ? resolved : null;
    if (!dict) return unchanged;
    const cs = this.resolveColorSpace(dict.get(PDFName.of('ColorSpace')), scope);
    if (cs.kind === 'gray' && this.mode === 'gray') return unchanged;
    if (cs.kind === 'unsupported' || cs.kind === 'pattern') {
      this.reason(translate('has a colour gradient Stapler cannot convert'));
      return unchanged;
    }
    const typeValue = dict.lookup(PDFName.of('ShadingType'));
    const type = typeValue instanceof PDFNumber ? typeValue.asNumber() : 0;
    const fnValue = dict.get(PDFName.of('Function'));
    const fn = fnValue === undefined ? null : parseFunctionOrArray(fnValue, this.context);

    if (type < 1 || type > 7) {
      this.reason(translate('has a colour gradient Stapler cannot convert'));
      return unchanged;
    }
    if (!fn) {
      this.reason(
        fnValue === undefined
          ? translate('has a mesh gradient with per-point colour')
          : translate('has a colour gradient Stapler cannot convert')
      );
      return unchanged;
    }

    const inputs = type === 1 ? 2 : 1;
    const domain =
      type === 1
        ? (numberList(dict.get(PDFName.of('Domain')), this.context) ?? [0, 1, 0, 1])
        : type <= 3
          ? (numberList(dict.get(PDFName.of('Domain')), this.context) ?? [0, 1])
          : fn.domain.slice(0, 2);
    if (domain.length < inputs * 2) {
      this.reason(translate('has a colour gradient Stapler cannot convert'));
      return unchanged;
    }

    const size = inputs === 1 ? 256 : 64;
    const samples = new Uint8Array(size ** inputs);
    let failed = false;
    for (let j = 0; j < (inputs === 2 ? size : 1); j++) {
      for (let i = 0; i < size; i++) {
        const input = [domain[0] + ((domain[1] - domain[0]) * i) / (size - 1)];
        if (inputs === 2) input.push(domain[2] + ((domain[3] - domain[2]) * j) / (size - 1));
        const outputs = fn.evaluate(input);
        const gray = outputs ? toGray(cs, outputs) : null;
        if (gray === null) failed = true;
        samples[j * size + i] = Math.round(this.mapGray(gray ?? 0) * 255);
      }
    }
    const background = numberList(dict.get(PDFName.of('Background')), this.context);
    const backgroundGray = background ? toGray(cs, background) : null;
    if (failed || (background && backgroundGray === null)) {
      this.reason(translate('has a colour gradient Stapler cannot convert'));
      return unchanged;
    }
    this.hit(true);
    if (this.planning) return unchanged;

    const sampled = this.context.register(
      PDFRawStream.of(
        this.context.obj({
          FunctionType: 0,
          Domain: domain.slice(0, inputs * 2),
          Range: [0, 1],
          Size: inputs === 1 ? [size] : [size, size],
          BitsPerSample: 8
        }),
        samples
      )
    );
    const copy = dict.clone(this.context);
    copy.set(PDFName.of('ColorSpace'), PDFName.of('DeviceGray'));
    copy.set(PDFName.of('Function'), sampled);
    if (backgroundGray !== null) {
      copy.set(PDFName.of('Background'), this.context.obj([this.mapGray(backgroundGray)]));
    }
    if (stream) {
      return {
        value: this.context.register(PDFRawStream.of(copy, stream.getContents())),
        changed: true
      };
    }
    return { value: this.context.register(copy), changed: true };
  }

  private convertType3(value: unknown, parent: ResourceScope, depth: number): Converted {
    const font = lookup(value, this.context);
    const unchanged: Converted = { value: value as PDFObject, changed: false };
    if (!(font instanceof PDFDict)) return unchanged;
    if (nameString(font.lookup(PDFName.of('Subtype'))) !== 'Type3') return unchanged;
    const key = value instanceof PDFRef ? `font:${value.objectNumber}` : null;
    return this.memoised(key, () => {
      const charProcs = font.lookupMaybe(PDFName.of('CharProcs'), PDFDict);
      if (!charProcs) return unchanged;
      const ownResources = font.lookupMaybe(PDFName.of('Resources'), PDFDict);
      const scope = new ResourceScope(this.context, ownResources ?? parent.original);
      const newProcs = charProcs.clone(this.context);
      let changed = false;
      for (const [glyph, procValue] of charProcs.entries()) {
        const proc = lookup(procValue, this.context);
        if (!(proc instanceof PDFStream)) continue;
        let bytes: Uint8Array;
        try {
          bytes = decodedBytes(proc);
        } catch {
          this.reason(translate('has a glyph stored in an encoding Stapler cannot read'));
          continue;
        }
        const converted = this.convertContentBytes(
          bytes,
          scope,
          { fill: GRAY, stroke: GRAY },
          depth + 1
        );
        if (!converted?.changed || this.planning) continue;
        newProcs.set(glyph, flateStream(this.context, converted.bytes, proc.dict));
        changed = true;
      }
      const resources = scope.result();
      if ((!changed && !resources) || this.planning) return unchanged;
      const copy = font.clone(this.context);
      copy.set(PDFName.of('CharProcs'), newProcs);
      if (resources) copy.set(PDFName.of('Resources'), resources);
      return { value: this.context.register(copy), changed: true };
    });
  }

  /* -------------------------- annotations --------------------------- */

  private grayArray(value: unknown): PDFObject | null {
    const nums = numberList(value, this.context);
    if (!nums || (nums.length !== 3 && nums.length !== 4)) {
      if (nums && nums.length === 1 && this.mode === 'bw') {
        const v = this.mapGray(nums[0]);
        this.lastChromatic = true;
        return v === nums[0] ? null : this.context.obj([v]);
      }
      return null;
    }
    const cs = nums.length === 3 ? RGB : CMYK;
    this.lastChromatic = !neutral(cs, nums);
    return this.context.obj([this.mapGray(toGray(cs, nums) ?? 0)]);
  }

  /** Rewrites an appearance-string's colour operators (`/DA (0 0 1 rg /Helv 12 Tf)`). */
  grayDefaultAppearance(da: string): string {
    return da
      .replace(
        /(^|\s)(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(k|K)(?=\s|$)/g,
        (_m, lead: string, c: string, m: string, y: string, k: string, op: string) =>
          `${lead}${formatNumber(this.mapGray(cmykToGray(+c, +m, +y, +k)))} ${op === 'k' ? 'g' : 'G'}`
      )
      .replace(
        /(^|\s)(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(rg|RG)(?=\s|$)/g,
        (_m, lead: string, r: string, g: string, b: string, op: string) =>
          `${lead}${formatNumber(this.mapGray(luma(+r, +g, +b)))} ${op === 'rg' ? 'g' : 'G'}`
      );
  }

  private convertDaEntry(dict: PDFDict): void {
    const da = dict.lookup(PDFName.of('DA'));
    if (!(da instanceof PDFString || da instanceof PDFHexString)) return;
    const text = da.decodeText();
    const gray = this.grayDefaultAppearance(text);
    if (gray === text) return;
    this.hit(false);
    if (!this.planning) dict.set(PDFName.of('DA'), PDFString.of(gray));
  }

  private convertAppearance(value: unknown, depth: number): Converted {
    const resolved = lookup(value, this.context);
    const empty = new ResourceScope(this.context, undefined);
    if (resolved instanceof PDFStream) {
      return this.convertForm(
        value as PDFObject,
        resolved,
        empty,
        { fill: GRAY, stroke: GRAY },
        depth
      );
    }
    if (resolved instanceof PDFDict) {
      // A state dictionary (`/N << /On … /Off … >>`).
      const copy = resolved.clone(this.context);
      let changed = false;
      for (const [state, entry] of resolved.entries()) {
        const stream = lookup(entry, this.context);
        if (!(stream instanceof PDFStream)) continue;
        const converted = this.convertForm(
          entry,
          stream,
          empty,
          { fill: GRAY, stroke: GRAY },
          depth
        );
        if (converted.changed) {
          copy.set(state, converted.value);
          changed = true;
        }
      }
      return changed
        ? { value: copy, changed: true }
        : { value: value as PDFObject, changed: false };
    }
    return { value: value as PDFObject, changed: false };
  }

  /**
   * Annotations are rewritten in place — they are referenced from `/AcroForm
   * /Fields` and popups' `/Parent`, so a copy would orphan them — but every
   * appearance *stream* they point at is converted into a new object.
   */
  private convertAnnotations(annots: PDFArray | undefined): void {
    if (!annots) return;
    for (let i = 0; i < annots.size(); i++) {
      const annot = lookup(annots.get(i), this.context);
      if (!(annot instanceof PDFDict)) continue;
      // Each annotation's effects are kept apart: one that cannot be
      // converted is either invisible (nothing to rasterise for it) or makes
      // the page's raster include the annotations (PDF-2).
      const saved = this.effects;
      const local = newEffects();
      this.effects = local;
      try {
        this.convertAnnotation(annot);
      } finally {
        this.effects = saved;
        if (local.reasons.size > 0) {
          if (annotationVisible(annot, this.context)) local.annotationFailures++;
          else local.reasons.clear();
        }
        mergeEffects(saved, local);
      }
    }
  }

  private convertAnnotation(annot: PDFDict): void {
    const ap = annot.lookupMaybe(PDFName.of('AP'), PDFDict);
    if (ap) {
      const apCopy = ap.clone(this.context);
      let apChanged = false;
      for (const key of ['N', 'R', 'D']) {
        const entry = ap.get(PDFName.of(key));
        if (entry === undefined) continue;
        const converted = this.convertAppearance(entry, 0);
        if (converted.changed) {
          apCopy.set(PDFName.of(key), converted.value);
          apChanged = true;
        }
      }
      if (apChanged && !this.planning) annot.set(PDFName.of('AP'), apCopy);
    }
    for (const key of ['C', 'IC']) {
      const gray = this.grayArray(annot.get(PDFName.of(key)));
      if (gray) {
        this.hit(this.lastChromatic);
        if (!this.planning) annot.set(PDFName.of(key), gray);
      }
    }
    const mk = annot.lookupMaybe(PDFName.of('MK'), PDFDict);
    if (mk) {
      const mkCopy = mk.clone(this.context);
      let mkChanged = false;
      for (const key of ['BG', 'BC']) {
        const gray = this.grayArray(mk.get(PDFName.of(key)));
        if (gray) {
          mkCopy.set(PDFName.of(key), gray);
          mkChanged = true;
          this.hit(this.lastChromatic);
        }
      }
      if (mkChanged && !this.planning) annot.set(PDFName.of('MK'), mkCopy);
    }
    this.convertDaEntry(annot);
  }

  /** The AcroForm's document-wide default appearance, for a whole-document conversion. */
  convertAcroFormDefaults(): void {
    const acroForm = this.doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
    if (acroForm) this.convertDaEntry(acroForm);
  }

  /* -------------------------- pages --------------------------- */

  private pageContentBytes(pageIndex: number): Uint8Array | null {
    const page = this.doc.getPage(pageIndex);
    const raw = page.node.get(PDFName.of('Contents'));
    const resolved = lookup(raw, this.context);
    const parts: unknown[] = resolved instanceof PDFArray ? resolved.asArray() : [raw];
    const chunks: Uint8Array[] = [];
    for (const part of parts) {
      const stream = lookup(part, this.context);
      if (!(stream instanceof PDFStream)) continue;
      chunks.push(decodedBytes(stream));
    }
    let total = 0;
    for (const chunk of chunks) total += chunk.length + 1;
    const merged = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      merged.set(chunk, at);
      at += chunk.length;
      merged[at++] = 0x0a;
    }
    return merged;
  }

  /**
   * Converts one page's content, resources and annotations. In plan mode it
   * only measures. Returns the effects; in apply mode the page is rewritten
   * only when the vector conversion succeeded completely.
   */
  convertPage(pageIndex: number, skipContent = false): { effects: Effects; wrote: boolean } {
    const saved = this.effects;
    this.effects = newEffects();
    let wrote = false;
    try {
      const page = this.doc.getPage(pageIndex);
      if (!skipContent) {
        let bytes: Uint8Array | null = null;
        try {
          bytes = this.pageContentBytes(pageIndex);
        } catch {
          this.reason(translate('has page content stored in an encoding Stapler cannot read'));
        }
        if (bytes) {
          const scope = new ResourceScope(this.context, page.node.Resources());
          const converted = this.convertContentBytes(bytes, scope, { fill: GRAY, stroke: GRAY }, 0);
          if (
            converted &&
            !this.planning &&
            this.effects.reasons.size === 0 &&
            (converted.changed || scope.result())
          ) {
            if (converted.changed) {
              page.node.set(PDFName.of('Contents'), flateStream(this.context, converted.bytes));
            }
            const resources = scope.result();
            if (resources) page.node.set(PDFName.of('Resources'), resources);
            wrote = true;
          }
        }
      }
      this.convertAnnotations(page.node.Annots());
      return { effects: this.effects, wrote };
    } finally {
      this.effects = saved;
    }
  }

  /** Replaces a page's content with a grey raster of itself; returns the annotations flattened. */
  applyRaster(pageIndex: number, raster: GrayRaster): number {
    const page = this.doc.getPage(pageIndex);
    const context = this.context;
    const imageDict = context.obj({
      Type: 'XObject',
      Subtype: 'Image',
      Width: raster.width,
      Height: raster.height,
      ColorSpace: 'DeviceGray'
    });
    const encoded = raster.encoded ?? this.encode(raster, true);
    imageDict.set(PDFName.of('BitsPerComponent'), PDFNumber.of(encoded.bitsPerComponent));
    imageDict.set(PDFName.of('Filter'), PDFName.of(encoded.filter));
    const image = context.register(PDFRawStream.of(imageDict, encoded.data));
    const [x0, y0, x1, y1] = raster.view;
    const content =
      `q ${formatBox(x1 - x0)} 0 0 ${formatBox(y1 - y0)} ${formatBox(x0)} ${formatBox(y0)} cm ` +
      '/StaplerGrayPage Do Q';
    page.node.set(PDFName.of('Contents'), flateStream(context, ascii(content)));
    page.node.set(PDFName.of('Resources'), context.obj({ XObject: { StaplerGrayPage: image } }));
    return raster.annotationsIncluded ? this.hideRasterisedAnnotations(page.node.Annots()) : 0;
  }

  /**
   * The annotations a raster rendered *with* annotations already shows. Each
   * is hidden (flag bit 2) rather than removed — it is still referenced from
   * the AcroForm and from its popup — so it is not drawn a second time, in
   * its original colour, over the grey raster. A link keeps working: only its
   * appearance is dropped. Popups draw nothing of their own. Returns how many
   * annotations were flattened.
   */
  private hideRasterisedAnnotations(annots: PDFArray | undefined): number {
    if (!annots) return 0;
    let hidden = 0;
    for (let i = 0; i < annots.size(); i++) {
      const annot = lookup(annots.get(i), this.context);
      if (!(annot instanceof PDFDict) || !annotationVisible(annot, this.context)) continue;
      const subtype = nameString(annot.lookup(PDFName.of('Subtype')));
      if (subtype === 'Popup') continue;
      if (subtype === 'Link') {
        if (annot.get(PDFName.of('AP')) !== undefined) {
          annot.delete(PDFName.of('AP'));
          hidden++;
        }
        continue;
      }
      const flags = annot.lookup(PDFName.of('F'));
      const value = flags instanceof PDFNumber ? flags.asNumber() : 0;
      annot.set(PDFName.of('F'), PDFNumber.of(value | ANNOT_HIDDEN));
      hidden++;
    }
    return hidden;
  }
}

/** Annotation flag bits (§12.5.3): Hidden and NoView. */
const ANNOT_HIDDEN = 1 << 1;
const ANNOT_NOVIEW = 1 << 5;

/** Whether a viewer draws `annot` on screen at all. */
function annotationVisible(annot: PDFDict, context: PDFContext): boolean {
  const flags = lookup(annot.get(PDFName.of('F')), context);
  const value = flags instanceof PDFNumber ? flags.asNumber() : 0;
  return (value & (ANNOT_HIDDEN | ANNOT_NOVIEW)) === 0;
}

/**
 * Encodes grey samples as a DeviceGray image's data: 1-bit Flate in `bw`
 * mode, JPEG where the original was lossy (or for a page raster), otherwise
 * 8-bit Flate. Pure — the render worker runs the same choice through its own
 * copy (it does not load pdf-lib); `grayscale.test.ts` checks both agree.
 */
export function encodeGraySamples(
  gray: Uint8Array,
  width: number,
  height: number,
  mode: GrayMode,
  lossy: boolean,
  quality = GRAY_JPEG_QUALITY
): EncodedGray {
  if (mode === 'bw') {
    return {
      data: zlibSync(packOneBit(gray, width, height)),
      filter: 'FlateDecode',
      bitsPerComponent: 1
    };
  }
  if (lossy) {
    return {
      data: encodeGrayJpeg(gray, width, height, { quality }),
      filter: 'DCTDecode',
      bitsPerComponent: 8
    };
  }
  return { data: zlibSync(gray), filter: 'FlateDecode', bitsPerComponent: 8 };
}

function formatBox(v: number): string {
  return String(Number(v.toFixed(4)));
}

/** 8-bit 0/255 samples → 1-bit rows (1 = white, as DeviceGray 1bpc reads). */
export function packOneBit(gray: Uint8Array, width: number, height: number): Uint8Array {
  const rowBytes = Math.ceil(width / 8);
  const out = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (gray[y * width + x] >= 128) out[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Entry points
 * ------------------------------------------------------------------ */

function pagePlanFrom(pageIndex: number, effects: Effects): GrayPagePlan {
  return {
    pageIndex,
    rasterReasons: [...effects.reasons],
    images: [...effects.images],
    undecodable: [...effects.undecodable],
    lossy: [...effects.lossy],
    flattenAnnotations: effects.annotationFailures > 0,
    colourConstructs: effects.constructs,
    chromaticConstructs: effects.chromatic
  };
}

/** What converting `pageIndices` involves. Never modifies anything a caller keeps. */
export async function planGrayscale(
  doc: PDFDocument,
  pageIndices: readonly number[],
  mode: GrayMode,
  onPage?: (done: number, total: number) => Promise<void>
): Promise<GrayPagePlan[]> {
  const converter = new GrayConverter(doc, mode, null);
  const plans: GrayPagePlan[] = [];
  for (let i = 0; i < pageIndices.length; i++) {
    await onPage?.(i, pageIndices.length);
    const { effects } = converter.convertPage(pageIndices[i]);
    plans.push(pagePlanFrom(pageIndices[i], effects));
  }
  return plans;
}

export interface ApplyGrayscaleInput {
  pageIndices: readonly number[];
  mode: GrayMode;
  images: Map<number, GrayImageData>;
  rasters: Map<number, GrayRaster>;
  /** True when every page of the document is being converted. */
  wholeDocument: boolean;
  jpegQuality?: number;
}

/** Rewrites `doc` in place. The caller saves (and verifies) the result. */
export async function applyGrayscale(
  doc: PDFDocument,
  input: ApplyGrayscaleInput,
  onPage?: (done: number, total: number) => Promise<void>
): Promise<GrayPageOutcome[]> {
  const converter = new GrayConverter(doc, input.mode, input.images, input.jpegQuality);
  const outcomes: GrayPageOutcome[] = [];
  for (let i = 0; i < input.pageIndices.length; i++) {
    await onPage?.(i, input.pageIndices.length);
    const pageIndex = input.pageIndices[i];
    const raster = input.rasters.get(pageIndex);
    const { effects, wrote } = converter.convertPage(pageIndex, raster !== undefined);
    const converted = [...effects.images].filter(n => converter.convertedImages.has(n)).length;
    const leftInColour = effects.images.size - converted;
    if (raster) {
      const flattened = converter.applyRaster(pageIndex, raster);
      outcomes.push({
        pageIndex,
        route: 'raster',
        reasons: [
          ...effects.reasons,
          ...(flattened > 0
            ? [translate('its annotations and form fields were flattened into the page image')]
            : [])
        ],
        imagesConverted: 0,
        imagesLeftInColour: 0
      });
      continue;
    }
    if (effects.reasons.size > 0) {
      outcomes.push({
        pageIndex,
        route: 'failed',
        reasons: [...effects.reasons],
        imagesConverted: 0,
        imagesLeftInColour: effects.images.size
      });
      continue;
    }
    outcomes.push({
      pageIndex,
      route: wrote || effects.constructs > 0 ? 'vector' : 'unchanged',
      reasons: [],
      imagesConverted: converted,
      imagesLeftInColour: leftInColour
    });
  }
  if (input.wholeDocument) converter.convertAcroFormDefaults();
  return outcomes;
}
