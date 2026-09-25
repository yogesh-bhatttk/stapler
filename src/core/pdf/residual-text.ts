/**
 * M7 — defence-in-depth for the redaction verifier.
 *
 * The verifier's other checks read what a *viewer* reaches: pdf.js page text over
 * the page tree, a whitelist of annotation and field keys, rendered pixels.
 * Anything outside those paths — an orphan copy of a page dictionary still
 * pointing at the unredacted content stream (audit PDF-1), a stale appearance
 * stream, an outline title, a structure element's `/ActualText` — sailed past all
 * of them while `strings file.pdf` found the secret in seconds.
 *
 * This scan looks at the file the way an extraction tool does:
 *
 *  1. Every string object anywhere in the object table, decoded.
 *  2. Every stream, decoded. For content streams (page contents, form XObjects,
 *     tiling patterns, Type 3 glyph procedures) only the string *operands* are
 *     read, concatenated — `[(TOP) -20 (SECRET)] TJ` must match `TOPSECRET` —
 *     so an operator name can never be mistaken for a redacted word. Other
 *     text-bearing streams (XMP, JavaScript, embedded files) are read whole.
 *     Binary streams whose bytes are not text — images, font programs, ICC
 *     profiles, functions, CMaps — are skipped, since a short search term would
 *     match their data by chance and block a correct save.
 *  3. Every `/Type /Page` dictionary in the object table that is not a page of
 *     the page tree. There is no legitimate reason for one to exist in a
 *     redacted output, and its content is exactly what the redaction removed.
 */
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  decodePDFRawStream
} from 'pdf-lib';
import type { PDFObject } from 'pdf-lib';
import { decodeStringToken, tokenizeContentStream } from './interpreter';

export interface ResidualTextScan {
  /** The needles (as given) found anywhere in the file's strings or streams. */
  found: string[];
  /** `/Type /Page` dictionaries present in the file but not in the page tree. */
  orphanPages: number;
  /** Text-bearing streams whose filters could not be decoded, so were not read. */
  undecodableStreams: number;
}

const FONT_PROGRAM_SUBTYPES = new Set(['Type1C', 'CIDFontType0C', 'OpenType']);

const latin1 = (bytes: Uint8Array): string => {
  let out = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return out;
};

/** The ways a needle can be spelled in raw PDF bytes, lower-cased. */
function spellings(needle: string): string[] {
  const lower = needle.toLowerCase();
  const variants = new Set<string>([lower]);
  let hex = '';
  let utf16 = '';
  let latinOnly = true;
  for (const ch of needle) {
    const code = ch.codePointAt(0)!;
    if (code > 0xff) latinOnly = false;
    if (code <= 0xffff) utf16 += String.fromCharCode(code >> 8, code & 0xff);
    if (code <= 0xff) hex += code.toString(16).padStart(2, '0');
  }
  if (latinOnly && hex) variants.add(hex);
  if (utf16) variants.add(utf16.toLowerCase());
  return [...variants];
}

/** Stream-level classification from the stream's own dictionary. */
function streamKind(stream: PDFStream): 'content' | 'binary' | 'text' {
  const dict = stream.dict;
  const subtype = dict.get(PDFName.of('Subtype'));
  const type = dict.get(PDFName.of('Type'));
  const subtypeName = subtype instanceof PDFName ? subtype.decodeText() : '';
  if (subtypeName === 'Image') return 'binary';
  if (subtypeName === 'Form') return 'content';
  if (dict.has(PDFName.of('PatternType'))) return 'content';
  if (FONT_PROGRAM_SUBTYPES.has(subtypeName)) return 'binary';
  if (dict.has(PDFName.of('Length1')) || dict.has(PDFName.of('Length2'))) return 'binary';
  if (dict.has(PDFName.of('FunctionType'))) return 'binary';
  if (type === PDFName.of('CMap')) return 'binary';
  if (type === PDFName.of('XRef') || type === PDFName.of('ObjStm')) return 'binary';
  return 'text';
}

/**
 * Streams whose role is decided by *where* they are referenced, not by their own
 * dictionary: page `/Contents`, Type 3 `/CharProcs` (content); `/ICCBased`
 * profiles and `/ToUnicode` CMaps (binary).
 */
function classifyByReference(doc: PDFDocument): Map<string, 'content' | 'binary'> {
  const roles = new Map<string, 'content' | 'binary'>();
  const mark = (value: unknown, role: 'content' | 'binary') => {
    if (value instanceof PDFRef) roles.set(value.toString(), role);
    else if (value instanceof PDFArray) {
      for (let i = 0; i < value.size(); i++) mark(value.get(i), role);
    }
  };
  const visitDict = (dict: PDFDict) => {
    if (dict.get(PDFName.of('Type')) === PDFName.of('Page')) {
      const contents = dict.get(PDFName.of('Contents'));
      const resolved = contents instanceof PDFRef ? doc.context.lookup(contents) : contents;
      mark(resolved instanceof PDFArray ? resolved : contents, 'content');
    }
    mark(dict.get(PDFName.of('ToUnicode')), 'binary');
    const encoding = dict.get(PDFName.of('Encoding'));
    if (encoding instanceof PDFRef) mark(encoding, 'binary');
    const charProcs = dict.lookupMaybe(PDFName.of('CharProcs'), PDFDict);
    for (const [, proc] of charProcs?.entries() ?? []) mark(proc, 'content');
  };
  const visited = new Set<PDFObject>();
  const walk = (value: unknown) => {
    if (!(value instanceof PDFDict || value instanceof PDFArray)) return;
    if (visited.has(value)) return;
    visited.add(value);
    if (value instanceof PDFDict) {
      visitDict(value);
      for (const [, entry] of value.entries()) walk(entry);
      return;
    }
    if (value.size() >= 2 && value.get(0) === PDFName.of('ICCBased')) mark(value.get(1), 'binary');
    for (let i = 0; i < value.size(); i++) walk(value.get(i));
  };
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    walk(object instanceof PDFStream ? object.dict : object);
  }
  return roles;
}

function stringOperandText(decoded: Uint8Array): string {
  let text = '';
  for (const token of tokenizeContentStream(decoded)) {
    if (token.type === 'string' || token.type === 'hexstring') {
      text += latin1(decodeStringToken(token));
    }
  }
  return text;
}

/**
 * Scans `bytes` for any of `needles` (case-insensitive) and for page
 * dictionaries outside the page tree. Read-only.
 */
export async function scanResidualText(
  bytes: Uint8Array,
  needles: string[],
  load: (bytes: Uint8Array) => Promise<PDFDocument> = b =>
    PDFDocument.load(b, { ignoreEncryption: true, updateMetadata: false })
): Promise<ResidualTextScan> {
  const doc = await load(bytes);
  const wanted = needles
    .filter(n => n.trim().length > 0)
    .map(n => ({ needle: n, forms: spellings(n) }));
  const found = new Set<string>();
  const check = (haystack: string) => {
    if (!haystack) return;
    const lower = haystack.toLowerCase();
    for (const { needle, forms } of wanted) {
      if (!found.has(needle) && forms.some(f => lower.includes(f))) found.add(needle);
    }
  };

  const treePages = new Set<PDFObject>(doc.getPages().map(p => p.node));
  let orphanPages = 0;
  let undecodableStreams = 0;
  const roles = wanted.length > 0 ? classifyByReference(doc) : new Map();

  const strings: string[] = [];
  const visited = new Set<PDFObject>();
  const collectStrings = (value: unknown) => {
    if (value instanceof PDFString || value instanceof PDFHexString) {
      try {
        strings.push(value.decodeText());
      } catch {
        // Undecodable text is also checked as its raw bytes below.
      }
      strings.push(latin1(value.asBytes()));
      return;
    }
    if (!(value instanceof PDFDict || value instanceof PDFArray)) return;
    if (visited.has(value)) return;
    visited.add(value);
    if (value instanceof PDFDict) {
      for (const [, entry] of value.entries()) collectStrings(entry);
      return;
    }
    for (let i = 0; i < value.size(); i++) collectStrings(value.get(i));
  };

  for (const [ref, object] of doc.context.enumerateIndirectObjects()) {
    const dict = object instanceof PDFStream ? object.dict : object;
    if (
      dict instanceof PDFDict &&
      dict.get(PDFName.of('Type')) === PDFName.of('Page') &&
      !treePages.has(dict)
    ) {
      orphanPages += 1;
    }
    if (wanted.length === 0) continue;
    collectStrings(dict);

    if (!(object instanceof PDFStream)) continue;
    const kind = roles.get(ref.toString()) ?? streamKind(object);
    if (kind === 'binary') continue;
    let decoded: Uint8Array;
    try {
      decoded =
        object instanceof PDFRawStream ? decodePDFRawStream(object).decode() : object.getContents();
    } catch {
      undecodableStreams += 1;
      continue;
    }
    if (kind === 'content') {
      try {
        check(stringOperandText(decoded));
        continue;
      } catch {
        // Not parseable as content after all: read it as text instead.
      }
    }
    check(latin1(decoded));
  }
  if (wanted.length > 0) {
    // Every string object from every indirect object's dictionaries and arrays
    // (outline titles, `/ActualText`, Info entries, annotation text), one per line.
    check(strings.join('\n'));
  }

  return { found: [...found], orphanPages, undecodableStreams };
}
