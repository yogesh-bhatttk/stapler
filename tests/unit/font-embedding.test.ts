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
import { PDFDocument, PDFName, PDFDict, PDFArray, type PDFPage } from 'pdf-lib';
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
