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
 *
 * What it deliberately does *not* read (regression review R-PDF-1): strings
 * that are file structure rather than document text. A redaction of "US" must
 * not fail because the catalog says `/Lang (en-US)`, nor one of "Adobe" because
 * every CID font declares `/Registry (Adobe)`. Those strings — language tags,
 * default-appearance operator strings, font names and descriptors, dates,
 * annotation unique names, page-label prefixes, output intents, encryption and
 * signature blobs — can never carry what a user redacted from a page, and
 * matching them only blocks a correct save the user has no way to fix.
 *
 * And what it must not let pass silently (N-4): a content stream it could not
 * decode on a page that carries a mark. Its text is unknown, so the page is
 * reported in `undecodablePages` and the caller fails that page's marks.
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
  /**
   * Pages (0-based, of the ones asked about) whose own content — `/Contents` or
   * a Form XObject the page draws — could not be decoded. Nothing is known about
   * what those streams show, so a mark on such a page is unproven.
   */
  undecodablePages: number[];
  /** For each of `undecodablePages`, the filter chain that could not be decoded. */
  undecodableFilters: Record<number, string>;
}

/**
 * Dictionary keys whose string values are structure, never document text.
 *
 * `P` is a page-label prefix (a page's `/P` in an annotation is a reference, not
 * a string, so nothing else is lost); `DA`/`DS` are default-appearance operator
 * strings (`/Helv 12 Tf 0 g`); `M`/`NM`/dates are timestamps and unique ids.
 */
const STRUCTURAL_STRING_KEYS = new Set([
  'Lang',
  'DA',
  'DS',
  'Registry',
  'Ordering',
  'FontFamily',
  'FontName',
  'FontStretch',
  'Style',
  'CharSet',
  'Panose',
  'BaseFont',
  'M',
  'NM',
  'CreationDate',
  'ModDate',
  'ID',
  'P',
  'OutputCondition',
  'OutputConditionIdentifier',
  'RegistryName',
  'ByteRange',
  'Filter',
  'SubFilter',
  'CFM'
]);

/** Dictionary types whose strings are all structure; their subtrees are skipped. */
const STRUCTURAL_DICT_TYPES = new Set([
  'Font',
  'FontDescriptor',
  'Encoding',
  'OutputIntent',
  'XRef',
  'ObjStm',
  'Sig',
  'DocTimeStamp',
  'CryptFilter'
]);

/** Image codecs: the stream's bytes are compressed pixels, never text. */
const IMAGE_CODECS = new Set([
  'DCTDecode',
  'DCT',
  'JPXDecode',
  'JBIG2Decode',
  'CCITTFaxDecode',
  'CCF'
]);

function isStructuralDict(dict: PDFDict): boolean {
  const type = dict.get(PDFName.of('Type'));
  if (type instanceof PDFName && STRUCTURAL_DICT_TYPES.has(type.decodeText())) return true;
  // A CIDSystemInfo dictionary carries no /Type.
  if (dict.has(PDFName.of('Registry')) && dict.has(PDFName.of('Ordering'))) return true;
  // The standard security handler's /O, /U, /OE, /UE and /Perms are binary.
  if (dict.get(PDFName.of('Filter')) === PDFName.of('Standard') && dict.has(PDFName.of('O'))) {
    return true;
  }
  return false;
}

const FONT_PROGRAM_SUBTYPES = new Set(['Type1C', 'CIDFontType0C', 'OpenType']);

const latin1 = (bytes: Uint8Array): string => {
  let out = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return out;
};

/**
 * The ways a needle can be spelled, lower-cased: as decoded text (`forms`), and
 * additionally as hex digits (`rawForms`) — the hex spelling is only meaningful
 * in a stream read as raw text (a `<534543…>` literal in JavaScript, say).
 * Matched against decoded strings it would fire on any id or date that happens
 * to contain those digits: "12" is `3132`.
 */
function spellings(needle: string): { forms: string[]; rawForms: string[] } {
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
  if (utf16) variants.add(utf16.toLowerCase());
  const forms = [...variants];
  return { forms, rawForms: latinOnly && hex ? [...forms, hex] : forms };
}

/** Stream-level classification from the stream's own dictionary. */
function streamKind(stream: PDFStream): 'content' | 'binary' | 'text' {
  const dict = stream.dict;
  const subtype = dict.get(PDFName.of('Subtype'));
  const type = dict.get(PDFName.of('Type'));
  const subtypeName = subtype instanceof PDFName ? subtype.decodeText() : '';
  if (subtypeName === 'Image') return 'binary';
  const filter = dict.get(PDFName.of('Filter'));
  const filters =
    filter instanceof PDFName ? [filter] : filter instanceof PDFArray ? filter.asArray() : [];
  if (filters.some(f => f instanceof PDFName && IMAGE_CODECS.has(f.decodeText()))) return 'binary';
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
    mark(dict.get(PDFName.of('Thumb')), 'binary');
    mark(dict.get(PDFName.of('JBIG2Globals')), 'binary');
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
 * Every stream that paints page `page`: its `/Contents` and the Form XObjects
 * (and tiling patterns) its resources name, recursively.
 */
function pageContentStreamRefs(doc: PDFDocument, page: PDFDict): Set<string> {
  const refs = new Set<string>();
  const visitedResources = new Set<PDFDict>();
  const addContents = (value: unknown) => {
    if (value instanceof PDFRef) {
      const target = doc.context.lookup(value);
      if (target instanceof PDFArray) addContents(target);
      else refs.add(value.toString());
    } else if (value instanceof PDFArray) {
      for (let i = 0; i < value.size(); i++) addContents(value.get(i));
    }
  };
  const walkResources = (value: unknown, depth: number) => {
    const resources = value instanceof PDFRef ? doc.context.lookup(value) : value;
    if (!(resources instanceof PDFDict) || visitedResources.has(resources) || depth > 16) return;
    visitedResources.add(resources);
    for (const key of ['XObject', 'Pattern']) {
      const group = resources.lookupMaybe(PDFName.of(key), PDFDict);
      for (const [, entry] of group?.entries() ?? []) {
        if (!(entry instanceof PDFRef) || refs.has(entry.toString())) continue;
        const stream = doc.context.lookup(entry);
        if (!(stream instanceof PDFStream)) continue;
        if (stream.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')) continue;
        refs.add(entry.toString());
        walkResources(stream.dict.get(PDFName.of('Resources')), depth + 1);
      }
    }
  };
  addContents(page.get(PDFName.of('Contents')));
  let node: PDFDict | undefined = page;
  for (let depth = 0; node && depth < 32; depth++) {
    if (node.has(PDFName.of('Resources'))) {
      walkResources(node.get(PDFName.of('Resources')), 0);
      break;
    }
    const parent: unknown = node.get(PDFName.of('Parent'));
    const next: unknown = parent instanceof PDFRef ? doc.context.lookup(parent) : undefined;
    node = next instanceof PDFDict ? next : undefined;
  }
  return refs;
}

/**
 * Scans `bytes` for any of `needles` (case-insensitive) and for page
 * dictionaries outside the page tree. Read-only.
 *
 * `markedPages` are the pages that carry a redaction mark: a content stream of
 * one of those that cannot be decoded is reported in `undecodablePages`
 * whether or not there are needles to look for.
 */
export async function scanResidualText(
  bytes: Uint8Array,
  needles: string[],
  load: (bytes: Uint8Array) => Promise<PDFDocument> = b =>
    PDFDocument.load(b, { ignoreEncryption: true, updateMetadata: false }),
  markedPages: number[] = []
): Promise<ResidualTextScan> {
  const doc = await load(bytes);
  const wanted = needles
    .filter(n => n.trim().length > 0)
    .map(n => ({ needle: n, ...spellings(n) }));
  const found = new Set<string>();
  const check = (haystack: string, raw = false) => {
    if (!haystack) return;
    const lower = haystack.toLowerCase();
    for (const { needle, forms, rawForms } of wanted) {
      if (found.has(needle)) continue;
      if ((raw ? rawForms : forms).some(f => lower.includes(f))) found.add(needle);
    }
  };

  const treePageList = doc.getPages();
  const treePages = new Set<PDFObject>(treePageList.map(p => p.node));
  let orphanPages = 0;
  let undecodableStreams = 0;
  const roles = wanted.length > 0 ? classifyByReference(doc) : new Map();

  // Which marked page(s) each content stream paints, for N-4.
  const markedByStream = new Map<string, number[]>();
  for (const index of new Set(markedPages)) {
    const page = treePageList[index];
    if (!page) continue;
    for (const ref of pageContentStreamRefs(doc, page.node)) {
      const list = markedByStream.get(ref) ?? [];
      list.push(index);
      markedByStream.set(ref, list);
    }
  }
  const undecodablePages = new Set<number>();
  const undecodableFilters: Record<number, string> = {};
  const filterChain = (stream: PDFStream): string => {
    const filter = stream.dict.get(PDFName.of('Filter'));
    const names =
      filter instanceof PDFName ? [filter] : filter instanceof PDFArray ? filter.asArray() : [];
    return names.map(n => (n instanceof PDFName ? n.decodeText() : String(n))).join(' → ');
  };

  const strings: string[] = [];
  const visited = new Set<PDFObject>();
  const pushString = (value: PDFString | PDFHexString) => {
    try {
      strings.push(value.decodeText());
    } catch {
      // Undecodable text is also checked as its raw bytes below.
    }
    strings.push(latin1(value.asBytes()));
  };
  const collectStrings = (value: unknown) => {
    if (value instanceof PDFString || value instanceof PDFHexString) {
      pushString(value);
      return;
    }
    if (!(value instanceof PDFDict || value instanceof PDFArray)) return;
    if (visited.has(value)) return;
    visited.add(value);
    if (value instanceof PDFDict) {
      // R-PDF-1: structure is not document text — see the module comment.
      if (isStructuralDict(value)) return;
      for (const [key, entry] of value.entries()) {
        if (STRUCTURAL_STRING_KEYS.has(key.decodeText())) continue;
        collectStrings(entry);
      }
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
    const paintsMarkedPages = markedByStream.get(ref.toString());
    if (wanted.length === 0 && !paintsMarkedPages) continue;
    if (wanted.length > 0) collectStrings(dict);

    if (!(object instanceof PDFStream)) continue;
    const kind = paintsMarkedPages ? 'content' : (roles.get(ref.toString()) ?? streamKind(object));
    if (kind === 'binary') continue;
    let decoded: Uint8Array;
    try {
      decoded =
        object instanceof PDFRawStream ? decodePDFRawStream(object).decode() : object.getContents();
    } catch {
      undecodableStreams += 1;
      for (const page of paintsMarkedPages ?? []) {
        undecodablePages.add(page);
        undecodableFilters[page] ??= filterChain(object);
      }
      continue;
    }
    if (wanted.length === 0) continue;
    if (kind === 'content') {
      try {
        check(stringOperandText(decoded));
        continue;
      } catch {
        // Not parseable as content after all: read it as text instead.
      }
    }
    check(latin1(decoded), true);
  }
  if (wanted.length > 0) {
    // Every text-bearing string object from every indirect object's dictionaries
    // and arrays (outline titles, `/ActualText`, Info entries, annotation text),
    // one per line.
    check(strings.join('\n'));
  }

  return {
    found: [...found],
    orphanPages,
    undecodableStreams,
    undecodablePages: [...undecodablePages].sort((a, b) => a - b),
    undecodableFilters
  };
}
