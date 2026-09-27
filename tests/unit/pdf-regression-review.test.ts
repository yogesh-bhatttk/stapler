/**
 * Regression review of the AUDIT-2026-09-25 PDF-internals fixes (R-PDF-1,
 * R-PDF-2, N-1, N-4). Every assertion re-parses real output bytes.
 *
 *  • R-PDF-1 — the residual-text scan must not fail a correct redaction because
 *    the redacted word also appears in file *structure*: a language tag, a CID
 *    font's registry, a font family, a form's default-appearance string, a
 *    page-label prefix. It must still find the real leaks.
 *  • N-4 — a content stream it cannot decode, on a page that carries a mark, is
 *    reported instead of silently passing.
 *  • R-PDF-2 — the metadata scrub removes JavaScript written *inline* into a
 *    bookmark, an annotation, an `/AA` dictionary or a `/Next` chain.
 *  • N-1 — the compression rebuild of a bookmarked document carries no orphan
 *    page copies, so the compression is kept.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFString,
  StandardFonts,
  decodePDFRawStream
} from 'pdf-lib';

vi.mock('comlink', () => ({
  expose: vi.fn(),
  transfer: vi.fn(value => value),
  proxy: vi.fn(value => value)
}));

const { processWorkerImpl: W } = await import('../../src/core/workers/process.worker');
const { scanResidualText } = await import('../../src/core/pdf/residual-text');

const FIXTURES = path.resolve(__dirname, '../fixtures');

/** One page, "Name <word> end" on the first line, plus whatever `extra` adds. */
async function docWith(word: string, extra: (doc: PDFDocument) => void): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([400, 400]);
  page.drawText(`Name ${word} end`, { x: 40, y: 340, size: 14, font });
  page.drawText('Other line kept', { x: 40, y: 200, size: 14, font });
  extra(doc);
  return doc.save();
}

/** Covers the first line of {@link docWith}. */
const firstLine = (text: string) => ({
  pageIndex: 0,
  x: 0.05,
  y: 0.1,
  width: 0.8,
  height: 0.08,
  text
});

function fontsOf(doc: PDFDocument): PDFDict {
  return doc.getPage(0).node.Resources()!.lookup(PDFName.of('Font'), PDFDict);
}

function addType0(doc: PDFDocument) {
  const cid = doc.context.register(
    doc.context.obj({
      Type: 'Font',
      Subtype: 'CIDFontType2',
      BaseFont: 'X',
      CIDSystemInfo: {
        Registry: PDFString.of('Adobe'),
        Ordering: PDFString.of('Identity'),
        Supplement: 0
      }
    })
  );
  const type0 = doc.context.register(
    doc.context.obj({
      Type: 'Font',
      Subtype: 'Type0',
      BaseFont: 'X',
      Encoding: 'Identity-H',
      DescendantFonts: [cid]
    })
  );
  fontsOf(doc).set(PDFName.of('FX'), type0);
}

const structuralCases: [string, string, (doc: PDFDocument) => void][] = [
  [
    'a catalog /Lang (en-US), redacting "US"',
    'US',
    doc => doc.catalog.set(PDFName.of('Lang'), PDFString.of('en-US'))
  ],
  [
    'a catalog /Lang (en-US), redacting "en"',
    'en',
    doc => doc.catalog.set(PDFName.of('Lang'), PDFString.of('en-US'))
  ],
  ['a CID font registry, redacting "Adobe"', 'Adobe', addType0],
  ['a CID font ordering, redacting "Identity"', 'Identity', addType0],
  [
    'a /FontFamily string, redacting "Arial"',
    'Arial',
    doc => {
      const descriptor = doc.context.register(
        doc.context.obj({
          Type: 'FontDescriptor',
          FontName: 'Arial',
          FontFamily: PDFString.of('Arial'),
          Flags: 32
        })
      );
      const font = doc.context.register(
        doc.context.obj({
          Type: 'Font',
          Subtype: 'TrueType',
          BaseFont: 'Arial',
          FontDescriptor: descriptor
        })
      );
      fontsOf(doc).set(PDFName.of('FArial'), font);
    }
  ],
  [
    'a form /DA naming the font, redacting "Helvetica"',
    'Helvetica',
    doc => {
      const field = doc.getForm().createTextField('fld');
      field.addToPage(doc.getPage(0), { x: 40, y: 100, width: 100, height: 20 });
      field.acroField.setDefaultAppearance('/Helvetica 12 Tf 0 g');
    }
  ],
  [
    'a form /DA naming the size, redacting "12"',
    '12',
    doc => {
      const field = doc.getForm().createTextField('fld');
      field.addToPage(doc.getPage(0), { x: 40, y: 100, width: 100, height: 20 });
      field.acroField.setDefaultAppearance('/Helv 12 Tf 0 g');
    }
  ],
  [
    'a page-label prefix, redacting "Appendix"',
    'Appendix',
    doc =>
      doc.catalog.set(
        PDFName.of('PageLabels'),
        doc.context.obj({ Nums: [0, { S: 'D', P: PDFString.of('Appendix-') }] })
      )
  ],
  [
    'an annotation /M date and /NM id, redacting "2025" and "ab"',
    '2025',
    doc => {
      const annot = doc.context.register(
        doc.context.obj({
          Type: 'Annot',
          Subtype: 'Square',
          Rect: [300, 20, 350, 60],
          M: PDFString.of('D:20250131120000Z'),
          NM: PDFString.of('f6162e00-2025')
        })
      );
      doc.getPage(0).node.set(PDFName.of('Annots'), doc.context.obj([annot]));
    }
  ]
];

describe('R-PDF-1 — structure is not document text', () => {
  for (const [label, word, extra] of structuralCases) {
    it(`a correct redaction passes the residual scan despite ${label}`, async () => {
      const bytes = await docWith(word, extra);
      const out = await W.scrubMetadata(await W.applyRedactions(bytes, [firstLine(word)]));
      const scan = await W.scanResidualText(out, [word], [0]);
      expect(scan).toMatchObject({ found: [], orphanPages: 0, undecodablePages: [] });
    });
  }

  it('the hex spelling of a needle is not matched against decoded strings', async () => {
    const bytes = await docWith('x', doc => {
      doc.setTitle('id 3132 9f');
    });
    const scan = await scanResidualText(bytes, ['12']);
    expect(scan.found).toEqual([]);
  });

  it('still finds the real leaks: annotation text, field value, outline title, Info, content', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([300, 300]);
    page.drawText('kept', { x: 10, y: 10, font, size: 12 });
    const ctx = doc.context;
    const note = ctx.register(
      ctx.obj({
        Type: 'Annot',
        Subtype: 'Text',
        Rect: [0, 0, 10, 10],
        Contents: PDFString.of('call alpha1')
      })
    );
    page.node.set(PDFName.of('Annots'), ctx.obj([note]));
    const field = doc.getForm().createTextField('f');
    field.setText('value bravo2');
    field.addToPage(page, { x: 50, y: 50, width: 100, height: 20 });
    const outlines = ctx.register(ctx.obj({ Type: 'Outlines' }));
    const item = ctx.register(ctx.obj({ Title: PDFString.of('charlie3 notes'), Parent: outlines }));
    ctx.lookup(outlines, PDFDict).set(PDFName.of('First'), item);
    doc.catalog.set(PDFName.of('Outlines'), outlines);
    doc.setAuthor('delta4');
    const hidden = ctx.register(ctx.flateStream('BT /F1 9 Tf [(ech) -20 (o5)] TJ ET'));
    const contents = page.node.get(PDFName.of('Contents'));
    page.node.set(
      PDFName.of('Contents'),
      ctx.obj([...(contents instanceof PDFArray ? contents.asArray() : [contents!]), hidden])
    );
    const scan = await scanResidualText(await doc.save(), [
      'alpha1',
      'bravo2',
      'charlie3',
      'delta4',
      'echo5',
      'absent'
    ]);
    expect(scan.found.sort()).toEqual(['alpha1', 'bravo2', 'charlie3', 'delta4', 'echo5']);
  });
});

describe('N-4 — an undecodable content stream on a marked page is reported', () => {
  async function undecodable(): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    doc.addPage([300, 300]);
    doc.addPage([300, 300]);
    const bad = doc.context.register(
      doc.context.stream(new Uint8Array([1, 2, 3, 4]), { Filter: 'FooDecode' })
    );
    doc.getPage(0).node.set(PDFName.of('Contents'), bad);
    return doc.save();
  }

  it('lists the marked page and names the filter', async () => {
    const scan = await scanResidualText(await undecodable(), [], undefined, [0]);
    expect(scan.undecodablePages).toEqual([0]);
    expect(scan.undecodableFilters[0]).toBe('FooDecode');
  });

  it('does not report it when no mark is on that page', async () => {
    const scan = await scanResidualText(await undecodable(), ['anything'], undefined, [1]);
    expect(scan.undecodablePages).toEqual([]);
    expect(scan.undecodableStreams).toBe(1);
  });
});

describe('R-PDF-2 — the scrub removes inline JavaScript actions', () => {
  it('drops JavaScript on bookmarks, links, /AA and /Next chains, and keeps other actions', async () => {
    const doc = await PDFDocument.create();
    const ctx = doc.context;
    const page = doc.addPage([300, 300]);
    const second = doc.addPage([300, 300]);
    const js = (tag: string) =>
      ctx.obj({ S: 'JavaScript', JS: PDFString.of(`app.alert("${tag}")`) });

    const outlines = ctx.register(ctx.obj({ Type: 'Outlines' }));
    const jsItem = ctx.register(ctx.obj({ Title: PDFString.of('Run'), Parent: outlines }));
    const goItem = ctx.register(ctx.obj({ Title: PDFString.of('Go'), Parent: outlines }));
    const indirectItem = ctx.register(ctx.obj({ Title: PDFString.of('Ind'), Parent: outlines }));
    ctx.lookup(jsItem, PDFDict).set(PDFName.of('A'), js('EVIL_OUTLINE'));
    ctx.lookup(jsItem, PDFDict).set(PDFName.of('Next'), goItem);
    ctx.lookup(goItem, PDFDict).set(PDFName.of('Dest'), ctx.obj([second.ref, 'Fit']));
    ctx.lookup(goItem, PDFDict).set(PDFName.of('Next'), indirectItem);
    ctx.lookup(indirectItem, PDFDict).set(PDFName.of('A'), ctx.register(js('EVIL_INDIRECT')));
    const outlineDict = ctx.lookup(outlines, PDFDict);
    outlineDict.set(PDFName.of('First'), jsItem);
    outlineDict.set(PDFName.of('Last'), indirectItem);
    outlineDict.set(PDFName.of('Count'), ctx.obj(3));
    doc.catalog.set(PDFName.of('Outlines'), outlines);

    const uriThenJs = ctx.obj({
      S: 'URI',
      URI: PDFString.of('https://example.org/'),
      Next: [js('EVIL_NEXT')]
    });
    const link = ctx.register(
      ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 50, 50], A: uriThenJs })
    );
    const jsLink = ctx.register(
      ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [60, 0, 90, 50], A: js('EVIL_LINK') })
    );
    page.node.set(PDFName.of('Annots'), ctx.obj([link, jsLink]));
    page.node.set(PDFName.of('AA'), ctx.obj({ O: js('EVIL_PAGE_AA') }));

    const out = await W.scrubMetadata(await doc.save(), {
      title: true,
      author: true,
      subject: true,
      creator: true,
      producer: true,
      creationDate: true,
      modificationDate: true,
      keywords: true,
      hasXmp: true,
      hasEmbeddedJavaScript: true,
      hasOpenAction: true,
      // Kept deliberately: the page's /AA is then carried, and must still lose
      // its JavaScript because the JavaScript toggle is on.
      hasAdditionalActions: false,
      hasEmbeddedFiles: true,
      hasPageThumbnails: true,
      hasOptionalContent: false,
      customInfo: true
    });

    const reparsed = await PDFDocument.load(out);
    let all = Buffer.from(out).toString('latin1');
    for (const [, obj] of reparsed.context.enumerateIndirectObjects()) {
      if (obj instanceof PDFRawStream) {
        all += Buffer.from(decodePDFRawStream(obj).decode()).toString('latin1');
      }
    }
    expect(all).not.toMatch(/EVIL_/);
    expect(all).not.toMatch(/\/JavaScript/);

    // The bookmarks themselves, the GoTo bookmark's destination and the URI link survive.
    const first = reparsed.catalog
      .lookup(PDFName.of('Outlines'), PDFDict)
      .lookup(PDFName.of('First'), PDFDict);
    const go = first.lookup(PDFName.of('Next'), PDFDict);
    const dest = go.lookup(PDFName.of('Dest'), PDFArray);
    expect(dest.get(0)).toBe(reparsed.getPage(1).ref);
    const annots = reparsed.getPage(0).node.Annots()!;
    const uri = reparsed.context.lookup(annots.get(0), PDFDict).lookup(PDFName.of('A'), PDFDict);
    expect(uri.get(PDFName.of('S'))).toBe(PDFName.of('URI'));
    // No reference into a deleted object is left behind.
    for (const [, obj] of reparsed.context.enumerateIndirectObjects()) {
      const text = (obj instanceof PDFRawStream ? obj.dict : obj).toString();
      for (const match of text.matchAll(/(\d+) 0 R/g)) {
        expect(reparsed.context.lookup(PDFRef.of(Number(match[1])))).toBeDefined();
      }
    }
  });
});

describe('N-1 — the compression rebuild of a bookmarked document', () => {
  it('keeps the compression and carries no orphan pages', async () => {
    // bookmarked-9 with a heavy content stream on the three pages its
    // bookmarks point at — the pages that are rasterised below. An orphan copy
    // of any of them drags that weight back in and the never-grow gate then
    // keeps the original, which is exactly the failure being guarded.
    const source = await PDFDocument.load(
      new Uint8Array(readFileSync(path.join(FIXTURES, 'bookmarked-9.pdf')))
    );
    for (const index of [0, 3, 6]) {
      const page = source.getPage(index);
      const pad = source.context.register(source.context.stream(`% ${'padding '.repeat(20000)}\n`));
      const contents = page.node.get(PDFName.of('Contents'));
      page.node.set(
        PDFName.of('Contents'),
        source.context.obj([
          ...(contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : []),
          pad
        ])
      );
    }
    const bytes = await source.save({ useObjectStreams: false });
    // A header-only baseline JPEG: enough for `embedJpg`, tiny on purpose so the
    // rasterised page is smaller than the original.
    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00,
      0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x10, 0x00, 0x10, 0x01,
      0x01, 0x11, 0x00, 0xff, 0xd9
    ]);
    const result = await W.rebuildCompressed(bytes, { 0: jpeg, 3: jpeg, 6: jpeg }, {});
    expect(result.keptOriginal).toBe(false);
    expect(result.bytes.byteLength).toBeLessThan(bytes.byteLength);

    const out = await PDFDocument.load(result.bytes);
    expect(out.getPageCount()).toBe(9);
    const tree = new Set(out.getPages().map(p => p.node));
    let orphans = 0;
    for (const [, obj] of out.context.enumerateIndirectObjects()) {
      if (
        obj instanceof PDFDict &&
        obj.get(PDFName.of('Type')) === PDFName.of('Page') &&
        !tree.has(obj as never)
      ) {
        orphans += 1;
      }
    }
    expect(orphans).toBe(0);

    // Every bookmark still lands on a page of the tree.
    const pageRefs = out.getPages().map(p => p.ref.toString());
    let item = out.catalog
      .lookup(PDFName.of('Outlines'), PDFDict)
      .lookupMaybe(PDFName.of('First'), PDFDict);
    let items = 0;
    while (item) {
      const dest = item.lookupMaybe(PDFName.of('Dest'), PDFArray);
      if (dest) expect(pageRefs).toContain(dest.get(0).toString());
      items += 1;
      item = item.lookupMaybe(PDFName.of('Next'), PDFDict);
    }
    expect(items).toBeGreaterThan(0);
  });
});
