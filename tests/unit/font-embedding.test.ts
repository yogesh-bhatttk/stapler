/**
 * DOC-12 — font-embedding checker.
 *
 * The fixture needs one genuinely embedded font and one genuinely not. The
 * embedded half reuses the exact pattern `ocr.test.ts` already established for
 * embedding the vendored NotoSansDevanagari.ttf via fontkit — a real
 * `/FontFile2`, not a stand-in. The non-embedded half is a hand-built font
 * dict (`/BaseFont /Arial`, no `/FontDescriptor` at all), the same
 * raw-dictionary approach `golden.test.ts` and `signature-integrity.test.ts`
 * already use for structures pdf-lib's own high-level API cannot produce.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  PDFDocument,
  PDFName,
  PDFDict,
  PDFArray,
  PDFNumber,
  PDFRawStream,
  StandardFonts,
  decodePDFRawStream,
  type PDFPage
} from 'pdf-lib';
import { readFile } from 'node:fs/promises';

vi.mock('comlink', () => ({
  expose: vi.fn(),
  transfer: vi.fn(val => val)
}));

import { processWorkerImpl } from '../../src/core/workers/process.worker';

const SUBSTITUTE_LABEL = 'Liberation Sans Regular (Arial-compatible)';

/** A blank page has a `/Resources` dict but no `/Font` sub-dict until something needs one. */
function ensureFontsDict(page: PDFPage): PDFDict {
  const resources = page.node.Resources()!;
  let fonts = resources.lookupMaybe(PDFName.of('Font'), PDFDict);
  if (!fonts) {
    fonts = page.doc.context.obj({});
    resources.set(PDFName.of('Font'), fonts);
  }
  return fonts;
}

/**
 * Mirrors `descriptorHostOf` in process.worker.ts: a fontkit-embedded custom
 * font is written as a `/Type0` composite, whose `/FontDescriptor` lives one
 * level down in `/DescendantFonts[0]`, not on the font dict itself.
 */
function descriptorOf(doc: PDFDocument, fontDict: PDFDict): PDFDict {
  let host = fontDict;
  if (fontDict.get(PDFName.of('Subtype')) === PDFName.of('Type0')) {
    const descendants = doc.context.lookup(fontDict.get(PDFName.of('DescendantFonts')), PDFArray);
    host = doc.context.lookup(descendants.get(0), PDFDict);
  }
  return doc.context.lookup(host.get(PDFName.of('FontDescriptor')), PDFDict);
}

function addRawFont(page: PDFPage, resourceName: string, baseFont: string): void {
  const ctx = page.doc.context;
  const dict = ctx.obj({
    Type: 'Font',
    Subtype: 'TrueType',
    BaseFont: baseFont,
    FirstChar: 32,
    LastChar: 32,
    Widths: [278]
  });
  ensureFontsDict(page).set(PDFName.of(resourceName), ctx.register(dict));
}

async function buildFixture(): Promise<Uint8Array> {
  const fontkitModule = await import('fontkit');
  const fontBytes = await readFile(
    new URL('../../src/core/ocr/assets/NotoSansDevanagari.ttf', import.meta.url)
  );

  const doc = await PDFDocument.create();
  doc.registerFontkit((fontkitModule as { default?: unknown }).default ?? fontkitModule);
  const embeddedFont = await doc.embedFont(fontBytes, { subset: true });

  const page = doc.addPage([300, 300]);
  // Draws with the real embedded font, so it lands in /Resources/Font with a
  // genuine /FontFile2 the same way any normal pdf-lib document would.
  page.drawText('Embedded text', { x: 20, y: 250, font: embeddedFont, size: 14 });

  // A second, hand-built font resource: `/BaseFont /Arial`, no
  // `/FontDescriptor` at all — exactly what a document referencing a system
  // font without embedding it looks like.
  addRawFont(page, 'NonEmbedded1', 'Arial');

  return doc.save();
}

describe('checkFontEmbedding (DOC-12)', () => {
  it('reports exactly the non-embedded font, not the embedded one', async () => {
    const bytes = await buildFixture();
    const report = await processWorkerImpl.checkFontEmbedding(bytes);

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].baseFont).toBe('Arial');
    expect(report.findings[0].pages).toEqual([0]);
    expect(report.findings[0].standardFontMatch).toBe(SUBSTITUTE_LABEL);
  });

  it('strips a subset tag before reporting, and reports no match for an unmapped font', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);
    addRawFont(page, 'F1', 'ABCDEF+SomeObscureFont');
    const bytes = await doc.save();

    const report = await processWorkerImpl.checkFontEmbedding(bytes);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].baseFont).toBe('SomeObscureFont');
    expect(report.findings[0].standardFontMatch).toBeNull();
  });

  it('reports no match for a bold/italic Arial variant — only the regular weight is vendored', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);
    addRawFont(page, 'F1', 'Arial-BoldMT');
    const bytes = await doc.save();

    const report = await processWorkerImpl.checkFontEmbedding(bytes);
    expect(report.findings[0].baseFont).toBe('Arial-BoldMT');
    expect(report.findings[0].standardFontMatch).toBeNull();
  });

  it('reports nothing for a document with no fonts at all', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    const bytes = await doc.save();
    const report = await processWorkerImpl.checkFontEmbedding(bytes);
    expect(report.findings).toEqual([]);
  });
});

describe('embedMissingFont (DOC-12)', () => {
  it('embeds the real substitute and the export shows a real /FontFile*', async () => {
    const bytes = await buildFixture();
    const before = await processWorkerImpl.checkFontEmbedding(bytes);
    expect(before.findings[0].baseFont).toBe('Arial');

    const fixed = await processWorkerImpl.embedMissingFont(bytes, 'Arial');

    // Independent re-parse, not the worker's own before/after state.
    const reparsed = await PDFDocument.load(fixed);
    const page = reparsed.getPages()[0];
    const fontsDict = page.node.Resources()!.lookupMaybe(PDFName.of('Font'), PDFDict)!;
    const nonEmbeddedRef = fontsDict.get(PDFName.of('NonEmbedded1'));
    const fontDict = reparsed.context.lookup(nonEmbeddedRef, PDFDict);
    const descriptor = descriptorOf(reparsed, fontDict);
    expect(
      descriptor.get(PDFName.of('FontFile')) ??
        descriptor.get(PDFName.of('FontFile2')) ??
        descriptor.get(PDFName.of('FontFile3'))
    ).toBeDefined();

    // The checker itself now reports it clean.
    const after = await processWorkerImpl.checkFontEmbedding(fixed);
    expect(after.findings).toEqual([]);
  });

  it('does not touch the font that was already embedded', async () => {
    const bytes = await buildFixture();
    const before = await PDFDocument.load(bytes);
    const beforeFonts = before
      .getPages()[0]
      .node.Resources()!
      .lookupMaybe(PDFName.of('Font'), PDFDict)!;
    // The embedded font's resource name is whatever pdf-lib assigned it —
    // find it as "whichever entry is not NonEmbedded1".
    const embeddedName = [...beforeFonts.keys()]
      .map(k => k.asString().replace(/^\//, ''))
      .find(k => k !== 'NonEmbedded1')!;

    const fixed = await processWorkerImpl.embedMissingFont(bytes, 'Arial');
    const after = await PDFDocument.load(fixed);
    const afterFonts = after
      .getPages()[0]
      .node.Resources()!
      .lookupMaybe(PDFName.of('Font'), PDFDict)!;
    const embeddedDict = after.context.lookup(afterFonts.get(PDFName.of(embeddedName)), PDFDict);
    const descriptor = descriptorOf(after, embeddedDict);
    // Still embedded, untouched by the fix applied to the other font.
    expect(descriptor.get(PDFName.of('FontFile2'))).toBeDefined();
  });

  it('refuses a font with no safe standard substitute, leaving the document unwritten', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);
    addRawFont(page, 'F1', 'SomeObscureFont');
    const bytes = await doc.save();

    await expect(processWorkerImpl.embedMissingFont(bytes, 'SomeObscureFont')).rejects.toThrow();
  });

  it('refuses a bold Arial variant rather than substituting the wrong weight', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);
    addRawFont(page, 'F1', 'Arial-BoldMT');
    const bytes = await doc.save();

    await expect(processWorkerImpl.embedMissingFont(bytes, 'Arial-BoldMT')).rejects.toThrow();
  });
});

/* ------------------------------------------------------------------ *
 * AUDIT-2026-09-25 PDF-2 / PDF-15 — the substitute must keep the text.
 *
 * The first implementation wrote a Type0/Identity-H font behind a content
 * stream of one-byte WinAnsi codes, so every run became `.notdef` garbage while
 * the check above (which only looks for a /FontFile*) passed. These assertions
 * read the text back out of the output with pdf.js, and check that every shown
 * code lands on a real glyph in the embedded program.
 * ------------------------------------------------------------------ */

type PdfjsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let pdfjsCached: PdfjsModule | undefined;
async function pdfjsText(bytes: Uint8Array): Promise<string[]> {
  pdfjsCached ??= await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjsCached.getDocument({ data: bytes.slice(), useSystemFonts: false }).promise;
  const pages: string[] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const content = await (await pdf.getPage(n)).getTextContent();
    pages.push(
      content.items
        .map(item => ('str' in item ? item.str : ''))
        .join('')
        .trim()
    );
  }
  await pdf.cleanup();
  return pages;
}

function contentText(doc: PDFDocument, page: PDFPage): string {
  const contents = page.node.Contents()!;
  const streams =
    contents instanceof PDFArray
      ? contents.asArray().map(ref => doc.context.lookup(ref) as PDFRawStream)
      : [contents as PDFRawStream];
  return streams
    .map(s => new TextDecoder('latin1').decode(decodePDFRawStream(s).decode()))
    .join('\n');
}

async function helveticaHelloWorld(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([600, 800]);
  page.drawText('Hello World', { x: 50, y: 700, size: 20, font });
  return doc.save();
}

/** A page drawing `show` (raw content) with a hand-built non-embedded font. */
async function rawFontDoc(
  fontEntries: Record<string, unknown>,
  show: string,
  inForm = false
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  const ctx = doc.context;
  const fontRef = ctx.register(ctx.obj({ Type: 'Font', ...fontEntries } as never));
  if (!inForm) {
    ensureFontsDict(page).set(PDFName.of('F1'), fontRef);
    page.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream(show)));
  } else {
    // The font lives only in a Form XObject's resources, and the page's own
    // /Resources are *inherited* from the page-tree root: PDF-15's two blind
    // spots at once.
    const form = ctx.flateStream(show, {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 400, 400],
      Resources: ctx.obj({ Font: ctx.obj({ F1: fontRef }) })
    });
    doc.catalog
      .Pages()
      .set(PDFName.of('Resources'), ctx.obj({ XObject: ctx.obj({ Fm0: ctx.register(form) }) }));
    page.node.delete(PDFName.of('Resources'));
    page.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream('/Fm0 Do')));
  }
  return doc.save();
}

async function outputFont(bytes: Uint8Array, resource = 'F1') {
  const doc = await PDFDocument.load(bytes);
  const fonts = doc.getPages()[0].node.Resources()!.lookup(PDFName.of('Font'), PDFDict);
  const font = doc.context.lookup(fonts.get(PDFName.of(resource)), PDFDict);
  return { doc, font };
}

interface FontkitFont {
  unitsPerEm: number;
  glyphForCodePoint(cp: number): { id: number; advanceWidth: number };
}

describe('embedMissingFont keeps the text (PDF-2)', () => {
  it('keeps "Hello World" readable: simple TrueType, WinAnsi, real glyphs, content untouched', async () => {
    const bytes = await helveticaHelloWorld();
    const beforeDoc = await PDFDocument.load(bytes);
    const beforeContent = contentText(beforeDoc, beforeDoc.getPages()[0]);
    const fontName = [
      ...beforeDoc.getPages()[0].node.Resources()!.lookup(PDFName.of('Font'), PDFDict).keys()
    ][0]
      .asString()
      .slice(1);

    const fixed = await processWorkerImpl.embedMissingFont(bytes, 'Helvetica');

    expect(await pdfjsText(fixed)).toEqual(['Hello World']);

    const { doc, font } = await outputFont(fixed, fontName);
    expect(font.get(PDFName.of('Subtype'))).toBe(PDFName.of('TrueType'));
    expect(font.get(PDFName.of('Encoding'))).toBe(PDFName.of('WinAnsiEncoding'));
    expect(contentText(doc, doc.getPages()[0])).toBe(beforeContent);

    // Every code the page shows maps to a real (non-.notdef) glyph in the
    // embedded program, and /Widths are that glyph's advance.
    const descriptor = doc.context.lookup(font.get(PDFName.of('FontDescriptor')), PDFDict);
    const fontFile = doc.context.lookup(descriptor.get(PDFName.of('FontFile2')));
    expect(fontFile).toBeInstanceOf(PDFRawStream);
    const file = fontFile as PDFRawStream;
    const fontkit = (await import('fontkit')) as unknown as {
      default?: { create(b: Uint8Array): FontkitFont };
      create(b: Uint8Array): FontkitFont;
    };
    const program = (fontkit.default ?? fontkit).create(decodePDFRawStream(file).decode());
    const first = font.lookup(PDFName.of('FirstChar'), PDFNumber).asNumber();
    const widths = font.lookup(PDFName.of('Widths'), PDFArray);
    for (const ch of 'Hello World') {
      const glyph = program.glyphForCodePoint(ch.charCodeAt(0));
      expect(glyph.id).not.toBe(0);
      const width = (widths.get(ch.charCodeAt(0) - first) as PDFNumber).asNumber();
      expect(width).toBe(Math.round((glyph.advanceWidth * 1000) / program.unitsPerEm));
    }

    // And the checker agrees the font is now embedded.
    expect((await processWorkerImpl.checkFontEmbedding(fixed)).findings).toEqual([]);
  });

  it("keeps a StandardEncoding font's own glyph at 0x27 (quoteright) via /Differences", async () => {
    // No /Encoding: a Type1 Helvetica's built-in encoding is Standard, where
    // code 0x27 is ’ (quoteright), not WinAnsi's ' (quotesingle).
    const bytes = await rawFontDoc(
      { Subtype: 'Type1', BaseFont: 'Helvetica' },
      'BT /F1 12 Tf 20 300 Td (It\\047s) Tj ET'
    );
    const beforeText = await pdfjsText(bytes);
    expect(beforeText).toEqual(['It’s']);

    const fixed = await processWorkerImpl.embedMissingFont(bytes, 'Helvetica');
    expect(await pdfjsText(fixed)).toEqual(beforeText);
    const { doc, font } = await outputFont(fixed);
    const encoding = doc.context.lookup(font.get(PDFName.of('Encoding')), PDFDict);
    const diffs = encoding.lookup(PDFName.of('Differences'), PDFArray).asArray().map(String);
    expect(diffs.slice(0, 2)).toEqual(['39', '/quoteright']);
  });

  it('carries an original /Differences through', async () => {
    const bytes = await rawFontDoc(
      {
        Subtype: 'TrueType',
        BaseFont: 'Arial',
        Encoding: { Type: 'Encoding', BaseEncoding: 'WinAnsiEncoding', Differences: [65, 'Euro'] }
      },
      'BT /F1 12 Tf 20 300 Td (AB) Tj ET'
    );
    const fixed = await processWorkerImpl.embedMissingFont(bytes, 'Arial');
    expect(await pdfjsText(fixed)).toEqual(['€B']);
  });

  it('refuses (throws, so the caller keeps the original) when a shown glyph has no substitute', async () => {
    const bytes = await rawFontDoc(
      {
        Subtype: 'TrueType',
        BaseFont: 'Arial',
        Encoding: {
          Type: 'Encoding',
          BaseEncoding: 'WinAnsiEncoding',
          Differences: [65, 'noSuchGlyph']
        }
      },
      'BT /F1 12 Tf 20 300 Td (A) Tj ET'
    );
    await expect(processWorkerImpl.embedMissingFont(bytes, 'Arial')).rejects.toThrow(
      /no glyph for noSuchGlyph.*untouched/
    );
  });

  it('refuses a non-embedded composite (Type0) Arial instead of guessing its CIDs', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);
    const ctx = doc.context;
    const cid = ctx.register(
      ctx.obj({ Type: 'Font', Subtype: 'CIDFontType2', BaseFont: 'Arial' } as never)
    );
    const type0 = ctx.register(
      ctx.obj({
        Type: 'Font',
        Subtype: 'Type0',
        BaseFont: 'Arial',
        Encoding: 'Identity-H',
        DescendantFonts: [cid]
      } as never)
    );
    ensureFontsDict(page).set(PDFName.of('F1'), type0);
    page.node.set(
      PDFName.of('Contents'),
      ctx.register(ctx.flateStream('BT /F1 12 Tf 20 100 Td <0024> Tj ET'))
    );
    await expect(processWorkerImpl.embedMissingFont(await doc.save(), 'Arial')).rejects.toThrow(
      /composite/
    );
  });
});

describe('font inventory reaches inherited resources and forms (PDF-15)', () => {
  it('finds, and fixes, a non-embedded font used only inside a form on a page that inherits /Resources', async () => {
    const bytes = await rawFontDoc(
      { Subtype: 'TrueType', BaseFont: 'Arial', Encoding: 'WinAnsiEncoding' },
      'BT /F1 12 Tf 20 300 Td (Form text) Tj ET',
      true
    );
    const report = await processWorkerImpl.checkFontEmbedding(bytes);
    expect(report.findings.map(f => f.baseFont)).toEqual(['Arial']);

    const fixed = await processWorkerImpl.embedMissingFont(bytes, 'Arial');
    expect(await pdfjsText(fixed)).toEqual(['Form text']);
    expect((await processWorkerImpl.checkFontEmbedding(fixed)).findings).toEqual([]);
  });
});
