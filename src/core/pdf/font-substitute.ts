/**
 * DOC-12 — substituting a real, embedded program for a non-embedded simple font
 * *without changing a single content-stream byte*.
 *
 * Why this module exists (AUDIT-2026-09-25 PDF-2). The first implementation
 * called `doc.embedFont(ttf)`, which through fontkit always writes a `/Type0`
 * composite font with `/Encoding /Identity-H` — a font that reads *two*-byte
 * CIDs. The page content was left alone, so `<48656C6C6F> Tj` shown with the
 * old one-byte WinAnsi font was suddenly read as CIDs 0x4865, 0x6C6C, … — glyph
 * ids past the end of the program, i.e. `.notdef` boxes or nothing at all, on
 * every run in that font, while the UI reported "embedded".
 *
 * The only substitution that leaves the content untouched is another *simple*
 * font: the same one-byte codes, the same code → glyph-name encoding, and a
 * `/TrueType` dictionary whose `/FontFile2` is the real program. That is what
 * {@link buildSimpleTrueTypeSubstitute} writes. {@link textShowSignature} is the
 * proof: every show string in the document, decoded to glyph names through the
 * font dictionary it actually resolves to. The caller computes it before the
 * change and again on the *re-parsed output bytes*, and refuses the result
 * unless the two agree exactly — a composite font, a lost `/Differences`, a
 * font repointed on the wrong resource name all change that signature.
 *
 * Encoding tables are transcribed from pdf.js (`src/core/encodings.js`,
 * Apache-2.0) — the same tables the viewer this app renders with uses, which is
 * what makes "same glyph name" mean "same glyph drawn".
 */
import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFStream,
  type PDFContext,
  type PDFDocument
} from 'pdf-lib';
import { Encodings } from '@pdf-lib/standard-fonts';
import { decodeStringToken, parseContentStream, tokenizeContentStream } from './interpreter';
import type { Statement } from './interpreter';
import { tPlural, translate } from '../i18n';

const fromDotted = (list: string): readonly string[] =>
  Object.freeze(list.split(' ').map(name => (name === '.' ? '' : name)));

/** Code → glyph name; `''` for a code the encoding leaves undefined. */
export const STANDARD_ENCODING = fromDotted(
  [
    '. . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . space exclam',
    'quotedbl numbersign dollar percent ampersand quoteright parenleft parenright',
    'asterisk plus comma hyphen period slash zero one two three four five six',
    'seven eight nine colon semicolon less equal greater question at A B C D',
    'E F G H I J K L M N O P Q R S T U V W X Y Z bracketleft backslash bracketright',
    'asciicircum underscore quoteleft a b c d e f g h i j k l m n o p q r s t',
    'u v w x y z braceleft bar braceright asciitilde . . . . . . . . . . . .',
    '. . . . . . . . . . . . . . . . . . . . . . exclamdown cent sterling fraction',
    'yen florin section currency quotesingle quotedblleft guillemotleft guilsinglleft',
    'guilsinglright fi fl . endash dagger daggerdbl periodcentered . paragraph',
    'bullet quotesinglbase quotedblbase quotedblright guillemotright ellipsis',
    'perthousand . questiondown . grave acute circumflex tilde macron breve dotaccent',
    'dieresis . ring cedilla . hungarumlaut ogonek caron emdash . . . . . . .',
    '. . . . . . . . . AE . ordfeminine . . . . Lslash Oslash OE ordmasculine',
    '. . . . . ae . . . dotlessi . . lslash oslash oe germandbls . . . .'
  ].join(' ')
);
export const MAC_ROMAN_ENCODING = fromDotted(
  [
    '. . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . space exclam',
    'quotedbl numbersign dollar percent ampersand quotesingle parenleft parenright',
    'asterisk plus comma hyphen period slash zero one two three four five six',
    'seven eight nine colon semicolon less equal greater question at A B C D',
    'E F G H I J K L M N O P Q R S T U V W X Y Z bracketleft backslash bracketright',
    'asciicircum underscore grave a b c d e f g h i j k l m n o p q r s t u v',
    'w x y z braceleft bar braceright asciitilde . Adieresis Aring Ccedilla Eacute',
    'Ntilde Odieresis Udieresis aacute agrave acircumflex adieresis atilde aring',
    'ccedilla eacute egrave ecircumflex edieresis iacute igrave icircumflex idieresis',
    'ntilde oacute ograve ocircumflex odieresis otilde uacute ugrave ucircumflex',
    'udieresis dagger degree cent sterling section bullet paragraph germandbls',
    'registered copyright trademark acute dieresis notequal AE Oslash infinity',
    'plusminus lessequal greaterequal yen mu partialdiff summation product pi',
    'integral ordfeminine ordmasculine Omega ae oslash questiondown exclamdown',
    'logicalnot radical florin approxequal Delta guillemotleft guillemotright',
    'ellipsis space Agrave Atilde Otilde OE oe endash emdash quotedblleft quotedblright',
    'quoteleft quoteright divide lozenge ydieresis Ydieresis fraction currency',
    'guilsinglleft guilsinglright fi fl daggerdbl periodcentered quotesinglbase',
    'quotedblbase perthousand Acircumflex Ecircumflex Aacute Edieresis Egrave',
    'Iacute Icircumflex Idieresis Igrave Oacute Ocircumflex apple Ograve Uacute',
    'Ucircumflex Ugrave dotlessi circumflex tilde macron breve dotaccent ring',
    'cedilla hungarumlaut ogonek caron'
  ].join(' ')
);
export const WIN_ANSI_ENCODING = fromDotted(
  [
    '. . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . space exclam',
    'quotedbl numbersign dollar percent ampersand quotesingle parenleft parenright',
    'asterisk plus comma hyphen period slash zero one two three four five six',
    'seven eight nine colon semicolon less equal greater question at A B C D',
    'E F G H I J K L M N O P Q R S T U V W X Y Z bracketleft backslash bracketright',
    'asciicircum underscore grave a b c d e f g h i j k l m n o p q r s t u v',
    'w x y z braceleft bar braceright asciitilde bullet Euro bullet quotesinglbase',
    'florin quotedblbase ellipsis dagger daggerdbl circumflex perthousand Scaron',
    'guilsinglleft OE bullet Zcaron bullet bullet quoteleft quoteright quotedblleft',
    'quotedblright bullet endash emdash tilde trademark scaron guilsinglright',
    'oe bullet zcaron Ydieresis space exclamdown cent sterling currency yen brokenbar',
    'section dieresis copyright ordfeminine guillemotleft logicalnot hyphen registered',
    'macron degree plusminus twosuperior threesuperior acute mu paragraph periodcentered',
    'cedilla onesuperior ordmasculine guillemotright onequarter onehalf threequarters',
    'questiondown Agrave Aacute Acircumflex Atilde Adieresis Aring AE Ccedilla',
    'Egrave Eacute Ecircumflex Edieresis Igrave Iacute Icircumflex Idieresis',
    'Eth Ntilde Ograve Oacute Ocircumflex Otilde Odieresis multiply Oslash Ugrave',
    'Uacute Ucircumflex Udieresis Yacute Thorn germandbls agrave aacute acircumflex',
    'atilde adieresis aring ae ccedilla egrave eacute ecircumflex edieresis igrave',
    'iacute icircumflex idieresis eth ntilde ograve oacute ocircumflex otilde',
    'odieresis divide oslash ugrave uacute ucircumflex udieresis yacute thorn',
    'ydieresis'
  ].join(' ')
);

/**
 * The base table a simple font's `/Encoding` (or `/BaseEncoding`) names.
 * Absent means the font's built-in encoding, which for the only fonts DOC-12
 * substitutes (non-symbolic Arial/Helvetica) is StandardEncoding. Anything else
 * (MacExpertEncoding, a misspelling) is `undefined`: we do not know which glyph
 * each code meant, so we cannot promise to keep it.
 */
export function baseEncodingTable(name: string | undefined): readonly string[] | undefined {
  if (name === undefined || name === 'StandardEncoding') return STANDARD_ENCODING;
  if (name === 'WinAnsiEncoding') return WIN_ANSI_ENCODING;
  if (name === 'MacRomanEncoding') return MAC_ROMAN_ENCODING;
  return undefined;
}

/**
 * Glyph names that the three Latin base encodings use but WinAnsi does not
 * cover, with their Adobe Glyph List code points. WinAnsi's own names come from
 * `@pdf-lib/standard-fonts` below.
 */
const EXTRA_GLYPH_UNICODE: Readonly<Record<string, number>> = {
  fraction: 0x2044,
  fi: 0xfb01,
  fl: 0xfb02,
  dotlessi: 0x0131,
  breve: 0x02d8,
  dotaccent: 0x02d9,
  ring: 0x02da,
  hungarumlaut: 0x02dd,
  ogonek: 0x02db,
  caron: 0x02c7,
  Lslash: 0x0141,
  lslash: 0x0142,
  notequal: 0x2260,
  infinity: 0x221e,
  lessequal: 0x2264,
  greaterequal: 0x2265,
  partialdiff: 0x2202,
  summation: 0x2211,
  product: 0x220f,
  pi: 0x03c0,
  integral: 0x222b,
  Omega: 0x2126,
  radical: 0x221a,
  approxequal: 0x2248,
  Delta: 0x2206,
  lozenge: 0x25ca,
  minus: 0x2212,
  apple: 0xf8ff
};

let winAnsiNameUnicode: Map<string, number> | undefined;

/**
 * A glyph name's Unicode value, the way a viewer resolves it for a
 * non-symbolic TrueType font (name → Unicode → the program's (3,1) cmap):
 * the AGL names the Latin encodings use, plus `uniXXXX` / `uXXXX[XX]`.
 */
export function glyphNameToUnicode(name: string): number | undefined {
  if (!winAnsiNameUnicode) {
    winAnsiNameUnicode = new Map();
    for (const codePoint of Encodings.WinAnsi.supportedCodePoints) {
      const { name: glyph } = Encodings.WinAnsi.encodeUnicodeCodePoint(codePoint);
      if (!winAnsiNameUnicode.has(glyph)) winAnsiNameUnicode.set(glyph, codePoint);
    }
  }
  const known = winAnsiNameUnicode.get(name) ?? EXTRA_GLYPH_UNICODE[name];
  if (known !== undefined) return known;
  const uni = /^uni([0-9A-F]{4})$/.exec(name);
  if (uni) return parseInt(uni[1], 16);
  const u = /^u([0-9A-F]{4,6})$/.exec(name);
  if (u) return parseInt(u[1], 16);
  return undefined;
}

function resolve(value: unknown, context: PDFContext): unknown {
  return value instanceof PDFRef ? context.lookup(value) : value;
}

function dictOf(value: unknown, context: PDFContext): PDFDict | undefined {
  const resolved = resolve(value, context);
  return resolved instanceof PDFDict ? resolved : undefined;
}

function nameText(value: unknown): string | undefined {
  return value instanceof PDFName ? value.asString().replace(/^\//, '') : undefined;
}

const SIMPLE_SUBTYPES = new Set(['Type1', 'MMType1', 'TrueType']);

/** True for a single-byte-code font whose glyphs are named by its `/Encoding`. */
export function isSimpleNamedFont(fontDict: PDFDict): boolean {
  return SIMPLE_SUBTYPES.has(nameText(fontDict.get(PDFName.of('Subtype'))) ?? '');
}

/**
 * The full code → glyph-name table a simple font's `/Encoding` denotes, or
 * `undefined` when its base encoding is one we cannot name with certainty.
 */
export function simpleFontGlyphNames(fontDict: PDFDict, context: PDFContext): string[] | undefined {
  const raw = resolve(fontDict.get(PDFName.of('Encoding')), context);
  let baseName: string | undefined;
  let differences: PDFArray | undefined;
  if (raw instanceof PDFName) baseName = nameText(raw);
  else if (raw instanceof PDFDict) {
    baseName = nameText(raw.get(PDFName.of('BaseEncoding')));
    const diffs = resolve(raw.get(PDFName.of('Differences')), context);
    differences = diffs instanceof PDFArray ? diffs : undefined;
  } else if (raw !== undefined) {
    return undefined;
  }
  const base = baseEncodingTable(baseName);
  if (!base) return undefined;
  const names = [...base];
  if (differences) {
    let code = -1;
    for (let i = 0; i < differences.size(); i++) {
      const entry = resolve(differences.get(i), context);
      if (entry instanceof PDFNumber) code = entry.asNumber();
      else if (entry instanceof PDFName && code >= 0 && code <= 255) {
        names[code] = nameText(entry) ?? '';
        code++;
      }
    }
  }
  return names;
}

/** The subset of the fontkit API used here; fontkit ships no types. */
export interface FontProgram {
  unitsPerEm: number;
  postscriptName: string;
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
  ascent: number;
  descent: number;
  capHeight: number;
  italicAngle: number;
  glyphForCodePoint(codePoint: number): { id: number; advanceWidth: number };
}

/** Why a substitution cannot be made safely. Carries a user-facing message. */
export class SubstitutionRefused extends Error {}

/**
 * Writes a `/TrueType` simple font dictionary equivalent to `original`: the
 * same code → glyph-name encoding (and `/ToUnicode`, when there is one),
 * `/Widths` measured from `program`, and `/FontDescriptor /FontFile2` pointing
 * at `fontFile` (one stream shared by every substitute).
 *
 * `usedCodes` are the codes the document actually shows in `original`. Every one
 * must resolve to a real glyph in the program, or this refuses — a code that
 * lands on `.notdef` is precisely the silent loss the substitution must never
 * cause. Codes the encoding names but nobody shows get width 0 when the program
 * lacks them, which is harmless.
 */
export function buildSimpleTrueTypeSubstitute(
  original: PDFDict,
  context: PDFContext,
  program: FontProgram,
  fontFile: PDFRef,
  usedCodes: ReadonlySet<number>
): PDFDict {
  if (!isSimpleNamedFont(original)) {
    throw new SubstitutionRefused(
      translate(
        'it is a composite (CID) or Type 3 font; substituting it would need a glyph mapping ' +
          'this file does not carry'
      )
    );
  }
  const names = simpleFontGlyphNames(original, context);
  if (!names) {
    throw new SubstitutionRefused(
      translate('its /Encoding names a base encoding Stapler cannot map')
    );
  }

  const scale = 1000 / program.unitsPerEm;
  const glyphFor = (code: number) => {
    const name = names[code];
    if (!name || name === '.notdef') return undefined;
    const unicode = glyphNameToUnicode(name);
    if (unicode === undefined) return undefined;
    const glyph = program.glyphForCodePoint(unicode);
    return glyph && glyph.id !== 0 ? glyph : undefined;
  };

  const missing: string[] = [];
  for (const code of usedCodes) {
    if (!glyphFor(code)) missing.push(names[code] || translate('code {code}', { code }));
  }
  if (missing.length > 0) {
    const glyphs = missing.slice(0, 5).join(', ');
    throw new SubstitutionRefused(
      missing.length > 5
        ? tPlural(
            'the substitute font has no glyph for {glyphs} and {count} more',
            missing.length - 5,
            { glyphs }
          )
        : translate('the substitute font has no glyph for {glyphs}', { glyphs })
    );
  }

  let firstChar = 256;
  let lastChar = -1;
  for (let code = 0; code < 256; code++) {
    if (!names[code]) continue;
    firstChar = Math.min(firstChar, code);
    lastChar = Math.max(lastChar, code);
  }
  if (lastChar < firstChar) {
    throw new SubstitutionRefused(translate('its encoding names no glyphs'));
  }
  const widths: number[] = [];
  for (let code = firstChar; code <= lastChar; code++) {
    const glyph = glyphFor(code);
    widths.push(glyph ? Math.round(glyph.advanceWidth * scale) : 0);
  }

  // Emit the encoding as WinAnsi plus exactly the codes whose glyph differs.
  // A TrueType simple font may only name WinAnsi/MacRoman as its base, so a
  // Standard-encoded (or encoding-less) original becomes WinAnsi + Differences
  // that restore every Standard name — the same glyph for every code.
  const differences: (number | string)[] = [];
  let run = -2;
  for (let code = 0; code < 256; code++) {
    const name = names[code];
    if (!name || name === WIN_ANSI_ENCODING[code]) continue;
    if (code !== run + 1) differences.push(code);
    differences.push(name);
    run = code;
  }
  const encoding =
    differences.length === 0
      ? PDFName.of('WinAnsiEncoding')
      : context.obj({
          Type: 'Encoding',
          BaseEncoding: 'WinAnsiEncoding',
          Differences: differences.map(entry =>
            typeof entry === 'number' ? PDFNumber.of(entry) : PDFName.of(entry)
          )
        });

  const fontName = PDFName.of(program.postscriptName);
  const descriptor = context.obj({
    Type: 'FontDescriptor',
    FontName: fontName,
    // Non-symbolic: glyphs are selected by name → Unicode → (3,1) cmap.
    Flags: 32,
    FontBBox: [
      Math.round(program.bbox.minX * scale),
      Math.round(program.bbox.minY * scale),
      Math.round(program.bbox.maxX * scale),
      Math.round(program.bbox.maxY * scale)
    ],
    ItalicAngle: program.italicAngle,
    Ascent: Math.round(program.ascent * scale),
    Descent: Math.round(program.descent * scale),
    CapHeight: Math.round(program.capHeight * scale),
    StemV: 80,
    FontFile2: fontFile
  });

  const dict = context.obj({
    Type: 'Font',
    Subtype: 'TrueType',
    BaseFont: fontName,
    FirstChar: firstChar,
    LastChar: lastChar,
    Widths: widths,
    FontDescriptor: context.register(descriptor),
    Encoding: encoding
  });
  const toUnicode = original.get(PDFName.of('ToUnicode'));
  if (toUnicode) dict.set(PDFName.of('ToUnicode'), toUnicode);
  return dict;
}

/** Decodes one show string shown in `font` to a comparable token. */
export type ShowDecoder = (font: PDFDict | undefined, codes: Uint8Array) => string;

/**
 * The default decoder: glyph names for a simple font, raw codes (tagged with
 * the subtype, so a font turning composite cannot compare equal) otherwise.
 */
export function glyphNameDecoder(context: PDFContext): ShowDecoder {
  const cache = new Map<PDFDict, string[] | undefined>();
  return (font, codes) => {
    const hex = Array.from(codes, byte => byte.toString(16).padStart(2, '0')).join('');
    if (!font) return `missing:${hex}`;
    if (!isSimpleNamedFont(font)) {
      return `raw:${nameText(font.get(PDFName.of('Subtype'))) ?? '?'}:${hex}`;
    }
    if (!cache.has(font)) cache.set(font, simpleFontGlyphNames(font, context));
    const names = cache.get(font);
    if (!names) return `unmapped:${hex}`;
    return Array.from(codes, code => names[code] || `#${code}`).join(' ');
  };
}

/**
 * Every show string in the document, in content order (pages, then the Form
 * XObjects they draw, recursively), decoded through the font each one is
 * actually shown in. Tracks `q`/`Q`, since the current font is part of the
 * graphics state a `Q` restores.
 */
export async function textShowSignature(
  doc: PDFDocument,
  decode: ShowDecoder,
  decodeContent: (stream: PDFStream) => Promise<Uint8Array>
): Promise<string[]> {
  const context = doc.context;
  const out: string[] = [];
  const formCache = new Map<PDFStream, Statement[]>();
  const operandName = (statement: Statement) =>
    statement.operands[0]
      ? String.fromCharCode(...statement.operands[0].bytes).replace(/^\//, '')
      : '';

  const walk = async (
    statements: Statement[],
    resources: PDFDict | undefined,
    chain: Set<PDFStream>
  ): Promise<void> => {
    const fonts = dictOf(resources?.get(PDFName.of('Font')), context);
    const xobjects = dictOf(resources?.get(PDFName.of('XObject')), context);
    let font: PDFDict | undefined;
    const saved: (PDFDict | undefined)[] = [];
    for (const statement of statements) {
      const op = String.fromCharCode(...statement.operator.bytes);
      if (op === 'q') saved.push(font);
      else if (op === 'Q') font = saved.length > 0 ? saved.pop() : font;
      else if (op === 'Tf') {
        font = dictOf(fonts?.get(PDFName.of(operandName(statement))), context);
      } else if (op === 'Tj' || op === 'TJ' || op === "'" || op === '"') {
        for (const token of statement.operands) {
          if (token.type === 'string' || token.type === 'hexstring') {
            out.push(decode(font, decodeStringToken(token)));
          }
        }
      } else if (op === 'Do' && chain.size < 8 && xobjects) {
        const stream = resolve(xobjects.get(PDFName.of(operandName(statement))), context);
        if (!(stream instanceof PDFStream) || chain.has(stream)) continue;
        if (nameText(stream.dict.get(PDFName.of('Subtype'))) !== 'Form') continue;
        let parsed = formCache.get(stream);
        if (!parsed) {
          parsed = parseContentStream(tokenizeContentStream(await decodeContent(stream)));
          formCache.set(stream, parsed);
        }
        const formResources = dictOf(stream.dict.get(PDFName.of('Resources')), context);
        await walk(parsed, formResources ?? resources, new Set([...chain, stream]));
      }
    }
  };

  for (const page of doc.getPages()) {
    const contents = page.node.Contents();
    if (!contents) continue;
    const streams: PDFStream[] = [];
    if (contents instanceof PDFArray) {
      for (let i = 0; i < contents.size(); i++) {
        const part = resolve(contents.get(i), context);
        if (part instanceof PDFStream) streams.push(part);
      }
    } else {
      streams.push(contents);
    }
    // One logical stream split in chunks: concatenated, as a viewer reads it.
    const chunks = await Promise.all(streams.map(stream => decodeContent(stream)));
    const total = chunks.reduce((sum, chunk) => sum + chunk.length + 1, 0);
    const merged = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      merged.set(chunk, at);
      at += chunk.length;
      merged[at++] = 0x0a;
    }
    await walk(parseContentStream(tokenizeContentStream(merged)), page.node.Resources(), new Set());
  }
  return out;
}
