/**
 * GAP-6 — repair: re-save a damaged PDF through a tolerant parser, and say
 * exactly what was fixed.
 *
 * pdf-lib parses a file object by object from the top rather than trusting its
 * cross-reference table, so a broken or missing xref, a wrong `startxref` or a
 * file cut off before its trailer does not stop it reading what is there. What
 * it cannot parse it keeps as an invalid object (`throwOnInvalidObject: false`),
 * and what was cut off mid-stream it drops. This module works from that
 * starting point:
 *
 *  1. objects the parser dropped because the file ends inside them are
 *     salvaged — a truncated compressed stream is inflated as far as it goes,
 *     and a truncated object stream gives up every object that is complete;
 *  2. unparseable objects are removed, and every reference to something that
 *     does not exist (a page's content, an annotation, a catalog entry) is cut;
 *  3. the page tree is validated and, when it is damaged or missing, rebuilt
 *     from the page objects the file still has — or, as a last resort, from
 *     page *content* that survived when every page object was lost;
 *  4. the result is written with a brand-new cross-reference table and loaded
 *     again, strictly, before anything is returned.
 *
 * Encrypted files are refused: rebuilding one would mean writing it back in
 * the clear, which silently removes its protection.
 *
 * Pure pdf-lib + fflate, so the process worker runs it and the unit tests run
 * it against the real fixtures. The pdf.js half of the verification (does the
 * *renderer* open the output?) is the orchestrator's (`operations.ts`).
 */
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFInvalidObject,
  PDFName,
  PDFNumber,
  PDFObjectParser,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFWriter,
  decodePDFRawStream
} from 'pdf-lib';
import type { PDFContext, PDFObject } from 'pdf-lib';
import { Unzlib, Inflate } from 'fflate';
import { corrupt, encrypted } from '../errors';
import { tPlural, translate } from '../i18n';
import { parseContentStream, tokenizeContentStream } from './interpreter';
import { loadPdfDocument } from './load';

export interface RepairOutcome {
  bytes: Uint8Array;
  pageCount: number;
  /** What was wrong and has been fixed, one translated sentence each. */
  findings: string[];
  /** What the repair could not make whole, one translated sentence each. */
  warnings: string[];
  /** False when nothing was found to repair — the caller should not offer a "fixed" file. */
  changed: boolean;
}

type Stage = (fraction: number, label: string) => Promise<void> | void;

const LETTER: [number, number, number, number] = [0, 0, 612, 792];
const A4: [number, number, number, number] = [0, 0, 595.28, 841.89];

function latin1(bytes: Uint8Array, start = 0, end = bytes.length): string {
  let out = '';
  const CHUNK = 0x8000;
  for (let i = start; i < end; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(end, i + CHUNK)));
  }
  return out;
}

function hasPdfHeader(bytes: Uint8Array): boolean {
  return latin1(bytes, 0, Math.min(bytes.length, 1024)).includes('%PDF-');
}

/**
 * Whether `startxref` points at a cross-reference section. A missing,
 * out-of-range or misplaced offset is what makes a strict reader give up, and
 * what a rebuilt table fixes.
 */
function xrefIsSound(text: string): boolean {
  const at = text.lastIndexOf('startxref');
  if (at === -1) return false;
  const match = /^startxref\s+(\d+)/.exec(text.slice(at, at + 40));
  if (!match) return false;
  const offset = Number(match[1]);
  if (!(offset > 0 && offset < text.length)) return false;
  const head = text.slice(offset, offset + 32);
  return /^\s*xref\b/.test(head) || /^\s*\d+\s+\d+\s+obj\b/.test(head);
}

/** Inflates as much of a (possibly truncated) zlib or raw-deflate stream as it can. */
export function inflatePartial(data: Uint8Array): { bytes: Uint8Array; complete: boolean } {
  const attempt = (raw: boolean) => {
    const chunks: Uint8Array[] = [];
    let complete = false;
    const handler = (chunk: Uint8Array, final: boolean) => {
      chunks.push(chunk);
      if (final) complete = true;
    };
    const inflater = raw ? new Inflate(handler) : new Unzlib(handler);
    try {
      // Fed in slices so that everything decodable before a corrupt or missing
      // tail has already been emitted when the error comes.
      const SLICE = 256;
      for (let i = 0; i < data.length; i += SLICE) {
        inflater.push(data.subarray(i, Math.min(data.length, i + SLICE)), false);
      }
      // Signals end of input: a truncated stream throws here ("unexpected
      // EOF") instead of reporting completion.
      inflater.push(new Uint8Array(0), true);
    } catch {
      /* keep what was produced before the damage */
    }
    let total = 0;
    for (const chunk of chunks) total += chunk.length;
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.length;
    }
    return { bytes, complete };
  };
  const zlib = attempt(false);
  if (zlib.bytes.length > 0) return zlib;
  return attempt(true);
}

function lookup(value: unknown, context: PDFContext): unknown {
  return value instanceof PDFRef ? context.lookup(value) : value;
}

function isName(value: unknown, name: string): boolean {
  return value instanceof PDFName && value.decodeText() === name;
}

function typeOf(dict: PDFDict, context: PDFContext): string | null {
  const type = lookup(dict.get(PDFName.of('Type')), context);
  return type instanceof PDFName ? type.decodeText() : null;
}

function exists(value: unknown, context: PDFContext): boolean {
  if (!(value instanceof PDFRef)) return true;
  const target = context.lookup(value);
  return target !== undefined && !(target instanceof PDFInvalidObject);
}

function validBox(value: unknown, context: PDFContext): boolean {
  const box = lookup(value, context);
  if (!(box instanceof PDFArray) || box.size() !== 4) return false;
  const nums: number[] = [];
  for (let i = 0; i < 4; i++) {
    const n = lookup(box.get(i), context);
    if (!(n instanceof PDFNumber)) return false;
    nums.push(n.asNumber());
  }
  return nums.every(Number.isFinite) && nums[2] !== nums[0] && nums[3] !== nums[1];
}

/** `/Encrypt` as a whole name (not `/EncryptMetadata`), wherever it appears. */
const ENCRYPT_KEY = /\/Encrypt(?![^\s/<>[\]()%{}])/;

/**
 * A standard (or third-party) security handler's dictionary: a `/Filter`
 * name with the owner and user password entries beside it (§7.6.1).
 */
function hasSecurityHandler(context: PDFContext): boolean {
  for (const [, object] of context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFDict)) continue;
    if (!(object.get(PDFName.of('Filter')) instanceof PDFName)) continue;
    if (object.get(PDFName.of('O')) !== undefined && object.get(PDFName.of('U')) !== undefined) {
      return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Salvaging objects the parser dropped
 * ------------------------------------------------------------------ */

interface Salvage {
  objects: number;
  partialStreams: number;
}

function parseDictAt(
  bytes: Uint8Array,
  start: number,
  end: number,
  context: PDFContext
): PDFDict | null {
  try {
    const parsed = PDFObjectParser.forBytes(bytes.subarray(start, end), context).parseObject();
    return parsed instanceof PDFDict ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Objects `obj` headers that pdf-lib did not load — nearly always because the
 * file stops inside them. Streams are inflated as far as the data goes; an
 * object stream gives up every member object whose bytes are complete.
 */
/**
 * Where the data of the stream whose dictionary starts at `bodyStart` begins:
 * just after the `stream` keyword and its end-of-line, or -1 when no `stream`
 * keyword follows before the object's `endobj`.
 */
function streamDataStart(text: string, bodyStart: number, limit: number): number {
  const keyword = /stream(\r\n|\r|\n)/g;
  keyword.lastIndex = bodyStart;
  let found: RegExpExecArray | null;
  while ((found = keyword.exec(text)) && found.index < limit) {
    // `endstream` is not the start of a stream.
    if (text.slice(Math.max(0, found.index - 3), found.index) === 'end') continue;
    return found.index + found[0].length;
  }
  return -1;
}

function salvageDroppedObjects(bytes: Uint8Array, text: string, context: PDFContext): Salvage {
  const result: Salvage = { objects: 0, partialStreams: 0 };
  const header = /(\d+)\s+(\d+)\s+obj\b/g;
  let match: RegExpExecArray | null;
  const seen = new Set<number>();
  // The end of the last stream's data seen so far. An `N G obj` inside stream
  // data — a content stream that prints the words, an uncompressed embedded
  // PDF — is data, not an object of this file, and must never be "salvaged"
  // over a real object.
  let insideStreamUntil = -1;
  while ((match = header.exec(text))) {
    if (match.index < insideStreamUntil) continue;
    const objectNumber = Number(match[1]);
    const generation = Number(match[2]);
    const ref = PDFRef.of(objectNumber, generation);
    const existing = context.lookup(ref);
    if (existing !== undefined && !(existing instanceof PDFInvalidObject)) {
      if (existing instanceof PDFStream) {
        const bodyStart = match.index + match[0].length;
        const endobj = text.indexOf('endobj', bodyStart);
        const dataStart = streamDataStart(text, bodyStart, endobj === -1 ? text.length : endobj);
        if (dataStart !== -1) {
          const length = existing instanceof PDFRawStream ? existing.getContents().length : -1;
          const endstream = text.indexOf('endstream', dataStart);
          insideStreamUntil = Math.max(
            insideStreamUntil,
            length >= 0 ? dataStart + length : endstream === -1 ? text.length : endstream
          );
        }
      }
      continue;
    }
    if (seen.has(objectNumber)) continue;
    seen.add(objectNumber);

    const bodyStart = match.index + match[0].length;
    const nextObj = text.indexOf(' obj', bodyStart);
    const endobj = text.indexOf('endobj', bodyStart);
    const streamAt = text.indexOf('stream', bodyStart);
    const limit = endobj === -1 ? text.length : endobj;
    if (
      streamAt === -1 ||
      streamAt > limit ||
      (nextObj !== -1 && streamAt > nextObj && endobj === -1)
    ) {
      continue; // a truncated non-stream object has nothing useful to salvage
    }
    const dict = parseDictAt(bytes, bodyStart, streamAt, context);
    if (!dict) continue;
    let dataStart = streamAt + 'stream'.length;
    if (text[dataStart] === '\r') dataStart++;
    if (text[dataStart] === '\n') dataStart++;
    const endstream = text.indexOf('endstream', dataStart);
    const dataEnd = endstream === -1 ? bytes.length : endstream;
    insideStreamUntil = Math.max(insideStreamUntil, dataEnd);
    const data = bytes.subarray(dataStart, dataEnd);

    const filter = lookup(dict.get(PDFName.of('Filter')), context);
    const flate =
      isName(filter, 'FlateDecode') ||
      (filter instanceof PDFArray && filter.size() === 1 && isName(filter.get(0), 'FlateDecode'));
    let decoded: Uint8Array;
    let complete: boolean;
    if (flate) {
      if (dict.get(PDFName.of('DecodeParms')) !== undefined) continue; // predictors: not safe to guess
      ({ bytes: decoded, complete } = inflatePartial(data));
    } else if (filter === undefined) {
      decoded = data;
      complete = endstream !== -1;
    } else {
      continue;
    }
    if (decoded.length === 0) continue;

    if (typeOf(dict, context) === 'ObjStm') {
      result.objects += salvageObjectStream(dict, decoded, context);
      continue;
    }
    const clean = dict.clone(context);
    for (const key of ['Filter', 'DecodeParms', 'Length', 'DL']) clean.delete(PDFName.of(key));
    context.assign(ref, PDFRawStream.of(clean, decoded));
    result.objects += 1;
    if (!complete) result.partialStreams += 1;
  }
  return result;
}

function salvageObjectStream(dict: PDFDict, decoded: Uint8Array, context: PDFContext): number {
  const n = lookup(dict.get(PDFName.of('N')), context);
  const first = lookup(dict.get(PDFName.of('First')), context);
  if (!(n instanceof PDFNumber) || !(first instanceof PDFNumber)) return 0;
  const count = n.asNumber();
  const firstOffset = first.asNumber();
  const headerText = latin1(decoded, 0, Math.min(decoded.length, firstOffset));
  const numbers = headerText.trim().split(/\s+/).map(Number);
  const entries: { objectNumber: number; offset: number }[] = [];
  for (let i = 0; i + 1 < numbers.length && entries.length < count; i += 2) {
    if (!Number.isInteger(numbers[i]) || !Number.isInteger(numbers[i + 1])) break;
    entries.push({ objectNumber: numbers[i], offset: numbers[i + 1] });
  }
  let recovered = 0;
  for (let i = 0; i < entries.length; i++) {
    const start = firstOffset + entries[i].offset;
    // An object is complete only if the next one's start is also inside the
    // decoded bytes — the last one listed can never be proven complete.
    const end = i + 1 < entries.length ? firstOffset + entries[i + 1].offset : -1;
    if (end === -1 || end > decoded.length || start >= end) continue;
    const ref = PDFRef.of(entries[i].objectNumber, 0);
    const existing = context.lookup(ref);
    if (existing !== undefined && !(existing instanceof PDFInvalidObject)) continue;
    try {
      const object = PDFObjectParser.forBytes(decoded.subarray(start, end), context).parseObject();
      context.assign(ref, object);
      recovered += 1;
    } catch {
      /* incomplete or damaged member — skip it */
    }
  }
  return recovered;
}

/* ------------------------------------------------------------------ *
 * The page tree
 * ------------------------------------------------------------------ */

const INHERITABLE = ['Resources', 'MediaBox', 'CropBox', 'Rotate'];

interface Leaf {
  ref: PDFRef;
  dict: PDFDict;
}

/** Walks a page tree, carrying inherited attributes down onto each leaf. */
function collectLeaves(
  pagesRef: unknown,
  context: PDFContext
): { leaves: Leaf[]; droppedKids: number; countMismatch: boolean } {
  const leaves: Leaf[] = [];
  let droppedKids = 0;
  let countMismatch = false;
  const visited = new Set<string>();

  const walk = (ref: unknown, inherited: Map<string, PDFObject>, depth: number): void => {
    if (!(ref instanceof PDFRef) || depth > 32) {
      droppedKids++;
      return;
    }
    if (visited.has(ref.toString())) {
      droppedKids++;
      return;
    }
    visited.add(ref.toString());
    const node = context.lookup(ref);
    if (!(node instanceof PDFDict)) {
      droppedKids++;
      return;
    }
    const type = typeOf(node, context);
    const kids = lookup(node.get(PDFName.of('Kids')), context);
    if (type === 'Page' || (type !== 'Pages' && !(kids instanceof PDFArray))) {
      for (const [key, value] of inherited) {
        if (node.get(PDFName.of(key)) === undefined) node.set(PDFName.of(key), value);
      }
      leaves.push({ ref, dict: node });
      return;
    }
    if (!(kids instanceof PDFArray)) {
      droppedKids++;
      return;
    }
    const next = new Map(inherited);
    for (const key of INHERITABLE) {
      const value = node.get(PDFName.of(key));
      if (value !== undefined && exists(value, context)) next.set(key, value);
    }
    const before = leaves.length;
    for (let i = 0; i < kids.size(); i++) walk(kids.get(i), next, depth + 1);
    const count = lookup(node.get(PDFName.of('Count')), context);
    if (!(count instanceof PDFNumber) || count.asNumber() !== leaves.length - before) {
      countMismatch = true;
    }
  };

  walk(pagesRef, new Map(), 0);
  return { leaves, droppedKids, countMismatch };
}

/** Rebuilds `/Pages` as one flat node over `leaves`, and the catalog to point at it. */
function installPageTree(
  context: PDFContext,
  catalog: PDFDict | undefined,
  leaves: Leaf[]
): PDFDict {
  const pagesRef = context.nextRef();
  const kids = context.obj(leaves.map(leaf => leaf.ref));
  context.assign(pagesRef, context.obj({ Type: 'Pages', Kids: kids, Count: leaves.length }));
  for (const leaf of leaves) {
    leaf.dict.set(PDFName.of('Type'), PDFName.of('Page'));
    leaf.dict.set(PDFName.of('Parent'), pagesRef);
  }
  const root = catalog ?? context.obj({ Type: 'Catalog' });
  root.set(PDFName.of('Pages'), pagesRef);
  if (!catalog) context.trailerInfo.Root = context.register(root);
  return root;
}

/** Every object number referenced from anywhere in the context. */
function referencedObjects(context: PDFContext): Set<number> {
  const seen = new Set<number>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 64) return;
    if (value instanceof PDFRef) {
      seen.add(value.objectNumber);
      return;
    }
    if (value instanceof PDFStream) {
      visit(value.dict, depth + 1);
      return;
    }
    if (value instanceof PDFDict) {
      for (const [, entry] of value.entries()) visit(entry, depth + 1);
      return;
    }
    if (value instanceof PDFArray) {
      for (let i = 0; i < value.size(); i++) visit(value.get(i), depth + 1);
    }
  };
  for (const [, object] of context.enumerateIndirectObjects()) visit(object, 0);
  return seen;
}

const PAINTING_OPERATORS = new Set([
  'Tj',
  'TJ',
  "'",
  '"',
  're',
  'f',
  'F',
  'f*',
  'S',
  's',
  'B',
  'b',
  'Do',
  'sh',
  'l',
  'c'
]);

/**
 * The last resort: every page object is gone, but page *content* survived —
 * orphaned content streams (no `/Type`, no `/Subtype`, referenced by nothing,
 * and made of painting operators). Each becomes a page again. The fonts they
 * name are gone with the resources that held them, so text is drawn in
 * Helvetica; the report says so.
 */
function pagesFromOrphanContent(context: PDFContext): {
  leaves: Leaf[];
  substitutedFonts: boolean;
  guessedSize: boolean;
} {
  const referenced = referencedObjects(context);
  const candidates: { ref: PDFRef; stream: PDFStream; bytes: Uint8Array }[] = [];
  for (const [ref, object] of context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFStream) || referenced.has(ref.objectNumber)) continue;
    const dict = object.dict;
    if (dict.get(PDFName.of('Type')) !== undefined || dict.get(PDFName.of('Subtype')) !== undefined)
      continue;
    let bytes: Uint8Array;
    try {
      bytes =
        object instanceof PDFRawStream && dict.get(PDFName.of('Filter')) !== undefined
          ? decodePDFRawStream(object).decode()
          : object.getContents();
    } catch {
      continue;
    }
    candidates.push({ ref, stream: object, bytes });
  }
  candidates.sort((a, b) => a.ref.objectNumber - b.ref.objectNumber);

  const leaves: Leaf[] = [];
  let substitutedFonts = false;
  const helvetica = context.register(
    context.obj({
      Type: 'Font',
      Subtype: 'Type1',
      BaseFont: 'Helvetica',
      Encoding: 'WinAnsiEncoding'
    })
  );
  for (const candidate of candidates) {
    let statements;
    try {
      statements = parseContentStream(tokenizeContentStream(candidate.bytes));
    } catch {
      continue;
    }
    const ops = statements.map(s => String.fromCharCode(...s.operator.bytes));
    if (!ops.some(op => PAINTING_OPERATORS.has(op))) continue;

    // Page size from the furthest coordinate the content draws at.
    let maxX = 0;
    let maxY = 0;
    const fonts = new Set<string>();
    for (const statement of statements) {
      const op = String.fromCharCode(...statement.operator.bytes);
      const nums = statement.operands
        .filter(t => t.type === 'number')
        .map(t => Number(String.fromCharCode(...t.bytes)));
      if ((op === 'Tm' || op === 'cm') && nums.length === 6) {
        maxX = Math.max(maxX, nums[4]);
        maxY = Math.max(maxY, nums[5]);
      } else if (op === 're' && nums.length === 4) {
        maxX = Math.max(maxX, nums[0] + nums[2]);
        maxY = Math.max(maxY, nums[1] + nums[3]);
      } else if ((op === 'm' || op === 'l') && nums.length === 2) {
        maxX = Math.max(maxX, nums[0]);
        maxY = Math.max(maxY, nums[1]);
      } else if (op === 'Tf' && statement.operands[0]?.type === 'name') {
        fonts.add(String.fromCharCode(...statement.operands[0].bytes).slice(1));
      }
    }
    const box =
      maxX <= LETTER[2] && maxY <= LETTER[3]
        ? LETTER
        : maxX <= A4[2] && maxY <= A4[3]
          ? A4
          : ([0, 0, Math.ceil(maxX + 36), Math.ceil(maxY + 36)] as [
              number,
              number,
              number,
              number
            ]);
    const fontDict = context.obj({});
    for (const font of fonts) {
      fontDict.set(
        PDFName.of(
          font.replace(/#([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
        ),
        helvetica
      );
      substitutedFonts = true;
    }
    const page = context.obj({
      Type: 'Page',
      MediaBox: box,
      Resources: { Font: fontDict },
      Contents: candidate.ref
    });
    leaves.push({ ref: context.register(page), dict: page });
  }
  return { leaves, substitutedFonts, guessedSize: leaves.length > 0 };
}

/* ------------------------------------------------------------------ *
 * The repair
 * ------------------------------------------------------------------ */

export async function repairPdfBytes(bytes: Uint8Array, stage?: Stage): Promise<RepairOutcome> {
  const findings: string[] = [];
  const warnings: string[] = [];
  await stage?.(0, translate('Checking the file'));

  if (bytes.length === 0)
    throw corrupt(translate('The file is empty, so there is nothing to repair.'));
  if (!hasPdfHeader(bytes)) {
    throw corrupt(
      translate(
        'The file does not start with a PDF header, so it is not a PDF and cannot be repaired.'
      )
    );
  }
  const text = latin1(bytes);
  const xrefSound = xrefIsSound(text);
  const hasEof = text.lastIndexOf('%%EOF') !== -1;

  await stage?.(0.1, translate('Reading every object the file still has'));
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, {
      throwOnInvalidObject: false,
      ignoreEncryption: true,
      updateMetadata: false
    });
  } catch (err) {
    throw corrupt(
      translate('Not even the tolerant parser could read this file: {message}', {
        message: err instanceof Error ? err.message : String(err)
      })
    );
  }
  const context = doc.context;
  // `isEncrypted` reads the trailer's /Encrypt — exactly what a file cut off
  // before its trailer has lost, while every string and stream in it is still
  // ciphertext. The security handler's own dictionary, or the /Encrypt key
  // anywhere in the raw bytes, is evidence enough.
  if (doc.isEncrypted || hasSecurityHandler(context) || ENCRYPT_KEY.test(text)) {
    throw encrypted(
      translate(
        'This file is encrypted. Repairing it would mean writing it back without its protection, so nothing was changed.'
      )
    );
  }

  if (!xrefSound)
    findings.push(
      translate(
        'The cross-reference table was missing or pointed to the wrong place, and has been rebuilt.'
      )
    );
  if (!hasEof)
    findings.push(
      translate('The file was cut off before its end; everything up to the cut was read.')
    );

  await stage?.(0.3, translate('Recovering damaged objects'));
  // Salvage regex-scans the file for object headers. On a file with a sound
  // xref, an end marker and nothing the parser had to give up on there is no
  // damaged part to recover from — and the scan could only find false
  // positives.
  let hasInvalid = false;
  for (const [, object] of context.enumerateIndirectObjects()) {
    if (object instanceof PDFInvalidObject) {
      hasInvalid = true;
      break;
    }
  }
  const damaged = !xrefSound || !hasEof || hasInvalid;
  const salvage: Salvage = damaged
    ? salvageDroppedObjects(bytes, text, context)
    : { objects: 0, partialStreams: 0 };
  if (salvage.objects > 0) {
    findings.push(
      tPlural('Recovered {count} objects from the damaged part of the file.', salvage.objects)
    );
  }
  if (salvage.partialStreams > 0) {
    warnings.push(
      tPlural(
        '{count} content streams were cut off; the part before the cut was kept.',
        salvage.partialStreams
      )
    );
  }

  let invalid = 0;
  for (const [ref, object] of [...context.enumerateIndirectObjects()]) {
    if (object instanceof PDFInvalidObject) {
      context.delete(ref);
      invalid++;
    }
  }
  if (invalid > 0)
    findings.push(tPlural('Dropped {count} broken objects that could not be read.', invalid));

  await stage?.(0.5, translate('Checking the page tree'));
  let catalog = lookup(context.trailerInfo.Root, context);
  if (!(catalog instanceof PDFDict) || typeOf(catalog, context) !== 'Catalog') {
    catalog = undefined;
    for (const [ref, object] of context.enumerateIndirectObjects()) {
      if (object instanceof PDFDict && typeOf(object, context) === 'Catalog') {
        catalog = object;
        context.trailerInfo.Root = ref;
        findings.push(
          translate('The document catalog was not linked from the trailer, and has been relinked.')
        );
        break;
      }
    }
  }
  const catalogDict = catalog instanceof PDFDict ? catalog : undefined;

  let leaves: Leaf[] = [];
  let treeRebuilt = false;
  if (catalogDict) {
    const walk = collectLeaves(catalogDict.get(PDFName.of('Pages')), context);
    leaves = walk.leaves;
    if (leaves.length > 0 && (walk.droppedKids > 0 || walk.countMismatch)) {
      treeRebuilt = true;
      if (walk.droppedKids > 0) {
        findings.push(
          tPlural('Removed {count} missing entries from the page tree.', walk.droppedKids)
        );
      }
    }
  }
  if (leaves.length === 0) {
    // Page objects that are still in the file, in object order.
    for (const [ref, object] of context.enumerateIndirectObjects()) {
      if (object instanceof PDFDict && typeOf(object, context) === 'Page') {
        leaves.push({ ref, dict: object });
      }
    }
    leaves.sort((a, b) => a.ref.objectNumber - b.ref.objectNumber);
    if (leaves.length > 0) {
      treeRebuilt = true;
      findings.push(
        tPlural(
          'The page tree was lost; rebuilt it from {count} page objects found in the file.',
          leaves.length
        )
      );
    }
  }
  if (leaves.length === 0) {
    const orphan = pagesFromOrphanContent(context);
    leaves = orphan.leaves;
    if (leaves.length > 0) {
      treeRebuilt = true;
      findings.push(
        tPlural(
          'Every page object was lost; rebuilt {count} pages from page content found in the file.',
          leaves.length
        )
      );
      if (orphan.substitutedFonts) {
        warnings.push(
          translate(
            'The fonts were lost with the pages, so text is shown in Helvetica and may look different.'
          )
        );
      }
      if (orphan.guessedSize) {
        warnings.push(translate('The page size was lost too; it was estimated from the content.'));
      }
    }
  }
  if (leaves.length === 0) {
    throw corrupt(
      translate(
        'No pages could be recovered — the file stops before any page or page content. Nothing was saved; your original file is untouched.'
      )
    );
  }
  if (treeRebuilt) installPageTree(context, catalogDict, leaves);

  await stage?.(0.7, translate('Checking every page'));
  let brokenContents = 0;
  let brokenAnnots = 0;
  let missingBoxes = 0;
  for (const leaf of leaves) {
    const page = leaf.dict;
    const contents = page.get(PDFName.of('Contents'));
    const resolvedContents = lookup(contents, context);
    if (resolvedContents instanceof PDFArray) {
      const kept = resolvedContents.asArray().filter(entry => {
        const ok = exists(entry, context) && lookup(entry, context) instanceof PDFStream;
        if (!ok) brokenContents++;
        return ok;
      });
      if (kept.length !== resolvedContents.size()) {
        if (kept.length === 0) page.delete(PDFName.of('Contents'));
        else page.set(PDFName.of('Contents'), context.obj(kept));
      }
    } else if (contents !== undefined && !(resolvedContents instanceof PDFStream)) {
      page.delete(PDFName.of('Contents'));
      brokenContents++;
    }

    const annots = lookup(page.get(PDFName.of('Annots')), context);
    if (annots instanceof PDFArray) {
      const kept = annots.asArray().filter(entry => {
        const dict = lookup(entry, context);
        const ok =
          exists(entry, context) &&
          dict instanceof PDFDict &&
          validBox(dict.get(PDFName.of('Rect')), context);
        if (!ok) brokenAnnots++;
        return ok;
      });
      if (kept.length !== annots.size()) {
        if (kept.length === 0) page.delete(PDFName.of('Annots'));
        else page.set(PDFName.of('Annots'), context.obj(kept));
      }
    } else if (page.get(PDFName.of('Annots')) !== undefined) {
      page.delete(PDFName.of('Annots'));
      brokenAnnots++;
    }

    const resources = page.get(PDFName.of('Resources'));
    if (resources === undefined || !(lookup(resources, context) instanceof PDFDict)) {
      page.set(PDFName.of('Resources'), context.obj({}));
    }
    if (!validBox(page.get(PDFName.of('MediaBox')), context)) {
      page.set(PDFName.of('MediaBox'), context.obj([...LETTER]));
      missingBoxes++;
    }
    if (
      page.get(PDFName.of('CropBox')) !== undefined &&
      !validBox(page.get(PDFName.of('CropBox')), context)
    ) {
      page.delete(PDFName.of('CropBox'));
    }
  }
  if (brokenContents > 0) {
    findings.push(
      tPlural('Removed {count} references to page content that no longer exists.', brokenContents)
    );
  }
  if (brokenAnnots > 0) {
    findings.push(tPlural('Dropped {count} broken annotations.', brokenAnnots));
  }
  if (missingBoxes > 0) {
    warnings.push(
      tPlural('{count} pages had no readable size and were set to US Letter.', missingBoxes)
    );
  }

  // Catalog entries that point at nothing (a lost outline, a lost form).
  let danglingCatalog = 0;
  const root = lookup(context.trailerInfo.Root, context);
  if (root instanceof PDFDict) {
    for (const [key, value] of root.entries()) {
      if (key.decodeText() === 'Pages') continue;
      if (!exists(value, context)) {
        root.delete(key);
        danglingCatalog++;
      }
    }
  }
  if (danglingCatalog > 0) {
    findings.push(
      tPlural(
        'Removed {count} document-level entries that pointed to missing objects.',
        danglingCatalog
      )
    );
  }
  if (context.trailerInfo.Info !== undefined && !exists(context.trailerInfo.Info, context)) {
    context.trailerInfo.Info = undefined;
  }

  await stage?.(0.85, translate('Writing a fresh copy'));
  let output: Uint8Array;
  try {
    output = await PDFWriter.forContext(context, Infinity).serializeToBuffer();
  } catch (err) {
    throw corrupt(
      translate('The repaired file could not be written: {message}. Nothing was saved.', {
        message: err instanceof Error ? err.message : String(err)
      })
    );
  }

  // Proven, not assumed: the output must open through the same strict load
  // every other tool uses, with the page count this repair claims.
  await stage?.(0.95, translate('Verifying the repaired file'));
  let pageCount: number;
  try {
    const check = await loadPdfDocument(output);
    pageCount = check.getPageCount();
    check.getPages().forEach(page => page.getSize());
  } catch (err) {
    throw corrupt(
      translate('The repaired file did not pass verification ({message}), so it was not saved.', {
        message: err instanceof Error ? err.message : String(err)
      })
    );
  }
  if (pageCount !== leaves.length || pageCount === 0) {
    throw corrupt(
      translate('The repaired file did not pass verification ({message}), so it was not saved.', {
        message: `${pageCount} ≠ ${leaves.length}`
      })
    );
  }

  return {
    bytes: output,
    pageCount,
    findings,
    warnings,
    changed: findings.length > 0 || warnings.length > 0
  };
}
