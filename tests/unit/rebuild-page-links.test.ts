/**
 * Audit 2026-09-25, PDF-1 / PDF-6 / PDF-7 / PDF-11 / PDF-12 / PDF-13 and M7.
 *
 * pdf-lib's object copier never records a page's own reference, so every other
 * reference to that page — an annotation's `/P`, a TOC link's `/Dest`, a widget
 * sibling — was copied as an orphan page dictionary still pointing at the
 * page's *original* content. On redaction that carried the unredacted content
 * stream into the output; on extract it dragged in pages the user left out; and
 * everywhere it broke internal links.
 *
 * Every assertion re-parses the produced bytes and decodes every stream in the
 * file — "absent" means absent from the file, not from the page tree.
 */
import { describe, expect, it, vi } from 'vitest';
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
import type { PDFPage } from 'pdf-lib';

vi.mock('comlink', () => ({
  expose: vi.fn(),
  transfer: vi.fn(value => value),
  proxy: vi.fn(value => value)
}));

const { processWorkerImpl: W } = await import('../../src/core/workers/process.worker');
const { scanResidualText } = await import('../../src/core/pdf/residual-text');

const hex = (s: string) => Buffer.from(s, 'latin1').toString('hex').toUpperCase();

/** The raw file plus every decodable stream, as one latin1 string. */
async function everything(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  let s = Buffer.from(bytes).toString('latin1');
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream) {
      try {
        s += Buffer.from(decodePDFRawStream(obj).decode()).toString('latin1');
      } catch {
        // An undecodable stream (an image codec) cannot hold our plain text.
      }
    }
  }
  return s;
}

async function contains(bytes: Uint8Array, secret: string): Promise<boolean> {
  const all = await everything(bytes);
  return all.includes(secret) || all.toUpperCase().includes(hex(secret));
}

/** `/Type /Page` dictionaries in the object table that are not tree pages. */
async function orphanPages(bytes: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(bytes);
  const tree = new Set<unknown>(doc.getPages().map(p => p.node));
  let n = 0;
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFDict && obj.get(PDFName.of('Type')) === PDFName.of('Page')) {
      if (!tree.has(obj)) n += 1;
    }
  }
  return n;
}

function linkOn(page: PDFPage, target: PDFPage, doc: PDFDocument): void {
  const link = doc.context.register(
    doc.context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [400, 50, 500, 80],
      Dest: [target.ref, 'Fit']
    })
  );
  page.node.set(PDFName.of('Annots'), doc.context.obj([link]));
}

/** Where page `pageIndex`'s first link annotation lands: an output page index, or -1. */
function linkTarget(doc: PDFDocument, pageIndex: number): number | 'none' {
  const annots = doc.getPage(pageIndex).node.lookupMaybe(PDFName.of('Annots'), PDFArray);
  if (!annots || annots.size() === 0) return 'none';
  const link = doc.context.lookup(annots.get(0)) as PDFDict;
  const dest = link.lookupMaybe(PDFName.of('Dest'), PDFArray);
  const target = dest?.get(0);
  if (!(target instanceof PDFRef)) return 'none';
  return doc.getPages().findIndex(p => p.ref === target);
}

const SECRET = 'TOPSECRET123';
const mark = { pageIndex: 0, x: 0.05, y: 0.1, width: 0.4, height: 0.05 };

async function twoPageDoc(variant: 'annotP' | 'tocLink' | 'linkOut') {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p1 = doc.addPage([600, 800]);
  const p2 = doc.addPage([600, 800]);
  const secretPage = variant === 'linkOut' ? p2 : p1;
  secretPage.drawText(SECRET, { x: 50, y: 700, size: 12, font });
  (variant === 'linkOut' ? p1 : p2).drawText('other', { x: 50, y: 700, size: 12, font });
  if (variant === 'annotP') {
    const note = doc.context.register(
      doc.context.obj({
        Type: 'Annot',
        Subtype: 'Text',
        Rect: [400, 50, 420, 70],
        P: p1.ref,
        Contents: 'note'
      })
    );
    p1.node.set(PDFName.of('Annots'), doc.context.obj([note]));
  } else if (variant === 'tocLink') {
    linkOn(p2, p1, doc);
  } else {
    linkOn(p1, p2, doc);
  }
  return { bytes: await doc.save(), pageIndex: variant === 'linkOut' ? 1 : 0 };
}

/** Ten pages drawing one shared ~120 KB image XObject, plus one shared font. */
async function sharedImageDoc(pages = 10): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const side = 200;
  const pixels = new Uint8Array(side * side * 3);
  let seed = 12345;
  for (let i = 0; i < pixels.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    pixels[i] = seed & 0xff;
  }
  const image = doc.context.register(
    doc.context.stream(pixels, {
      Type: 'XObject',
      Subtype: 'Image',
      Width: side,
      Height: side,
      ColorSpace: 'DeviceRGB',
      BitsPerComponent: 8
    })
  );
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([612, 792]);
    page.drawText(`page ${i + 1}`, { x: 50, y: 740, size: 12, font });
    const name = page.node.newXObject('Im', image);
    const content = doc.context.register(
      doc.context.flateStream(`q 200 0 0 200 100 300 cm ${name.asString()} Do Q`)
    );
    const existing = page.node.Contents();
    const parts = existing instanceof PDFArray ? existing.asArray() : existing ? [existing] : [];
    page.node.set(PDFName.of('Contents'), doc.context.obj([...parts, content]));
  }
  return doc.save();
}

const imageCount = async (bytes: Uint8Array) =>
  (await PDFDocument.load(bytes)).context
    .enumerateIndirectObjects()
    .filter(
      ([, o]) =>
        o instanceof PDFRawStream && o.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')
    ).length;

describe('PDF-1 — redaction leaves no orphan copy of the unredacted page', () => {
  for (const variant of ['annotP', 'tocLink', 'linkOut'] as const) {
    it(`${variant}: the secret is absent from every decoded stream, after redact and after scrub`, async () => {
      const { bytes, pageIndex } = await twoPageDoc(variant);
      expect(await contains(bytes, SECRET)).toBe(true);

      const out = await W.applyRedactions(bytes, [{ ...mark, pageIndex }]);
      expect(await contains(out, SECRET)).toBe(false);
      expect(await orphanPages(out)).toBe(0);

      const scrubbed = await W.scrubMetadata(out);
      expect(await contains(scrubbed, SECRET)).toBe(false);
      expect(await orphanPages(scrubbed)).toBe(0);
      expect((await PDFDocument.load(scrubbed)).getPageCount()).toBe(2);
    });
  }

  it('keeps the TOC link pointing at the (redacted) page in the tree', async () => {
    const { bytes } = await twoPageDoc('tocLink');
    const out = await PDFDocument.load(await W.applyRedactions(bytes, [mark]));
    expect(linkTarget(out, 1)).toBe(0);
  });
});

describe('PDF-6 — links survive every rebuild, and extract does not drag excluded pages in', () => {
  async function threePages() {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const ps = [0, 1, 2].map(() => doc.addPage([600, 800]));
    ps[0].drawText('toc page', { x: 50, y: 700, size: 12, font });
    ps[1].drawText('middle', { x: 50, y: 700, size: 12, font });
    ps[2].drawText('PAGE3SECRET', { x: 50, y: 700, size: 12, font });
    linkOn(ps[0], ps[2], doc);
    return doc.save();
  }
  const place = (i: number) => ({ key: `k${i}`, sourceDocId: 'd', sourceIndex: i, rotation: 0 });
  const compose = (bytes: Uint8Array, idx: number[]) =>
    W.compose(
      idx.map(place),
      { d: bytes },
      [],
      undefined,
      undefined,
      null,
      null,
      undefined,
      undefined,
      {}
    );

  it('extracting page 1 does not carry page 3 content, and drops the dead link', async () => {
    const bytes = await threePages();
    const out = await compose(bytes, [0]);
    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(1);
    expect(await contains(out, 'PAGE3SECRET')).toBe(false);
    expect(await orphanPages(out)).toBe(0);
    expect(linkTarget(doc, 0)).toBe('none');
  });

  it('full compose points the link at the in-tree page', async () => {
    const out = await PDFDocument.load(await compose(await threePages(), [0, 1, 2]));
    expect(linkTarget(out, 0)).toBe(2);
  });

  it('reordered compose follows the page to its new position', async () => {
    const out = await PDFDocument.load(await compose(await threePages(), [2, 0, 1]));
    expect(linkTarget(out, 1)).toBe(0);
  });

  it('a page placed twice keeps links resolving to the first placement', async () => {
    const out = await compose(await threePages(), [0, 2, 0]);
    const doc = await PDFDocument.load(out);
    expect(linkTarget(doc, 0)).toBe(1);
    expect(linkTarget(doc, 2)).toBe(1);
    expect(await orphanPages(out)).toBe(0);
  });

  it('scrub and redact point the link at the in-tree page', async () => {
    const bytes = await threePages();
    const scrubbed = await PDFDocument.load(await W.scrubMetadata(bytes));
    expect(linkTarget(scrubbed, 0)).toBe(2);
    const redacted = await PDFDocument.load(
      await W.applyRedactions(bytes, [{ ...mark, pageIndex: 1 }])
    );
    expect(linkTarget(redacted, 0)).toBe(2);
  });

  it('the compression rebuild points the link at the in-tree page', async () => {
    const bytes = await threePages();
    // Pad page 2 with a large junk stream so the rasterised rebuild is smaller.
    const padded = await PDFDocument.load(bytes);
    const junk = padded.context.register(padded.context.stream(new Uint8Array(200000).fill(32)));
    const p = padded.getPage(1);
    p.node.set(
      PDFName.of('Contents'),
      padded.context.obj([p.node.get(PDFName.of('Contents'))!, junk])
    );
    const input = await padded.save({ useObjectStreams: false });
    const { readFile } = await import('node:fs/promises');
    const jpg = new Uint8Array(await readFile(new URL('../fixtures/tiny.jpg', import.meta.url)));
    const result = await W.rebuildCompressed(input, { 1: jpg }, {});
    expect(result.keptOriginal).toBe(false);
    const doc = await PDFDocument.load(result.bytes);
    expect(linkTarget(doc, 0)).toBe(2);
    expect(await orphanPages(result.bytes)).toBe(0);
  });
});

describe('PDF-7 / PDF-12 — shared resources stay shared', () => {
  it('redacting one corner of a shared-image document does not multiply the image', async () => {
    const bytes = await sharedImageDoc();
    expect(await imageCount(bytes)).toBe(1);
    const out = await W.applyRedactions(bytes, [
      { pageIndex: 0, x: 0.9, y: 0.9, width: 0.05, height: 0.05 }
    ]);
    expect(await imageCount(out)).toBe(1);
    expect(out.byteLength).toBeLessThan(bytes.byteLength * 1.5);
  });

  it('redacting the whole image on page 1 keeps it for the other pages', async () => {
    const bytes = await sharedImageDoc(3);
    // The image sits at 100..300 x 300..500 on a 612x792 page (top-left origin).
    const out = await W.applyRedactions(bytes, [
      { pageIndex: 0, x: 90 / 612, y: (792 - 510) / 792, width: 220 / 612, height: 220 / 792 }
    ]);
    const doc = await PDFDocument.load(out);
    expect(await imageCount(out)).toBe(1);
    for (const i of [1, 2]) {
      const xo = doc.getPage(i).node.Resources()!.lookup(PDFName.of('XObject'), PDFDict);
      const [ref] = xo.values();
      expect(doc.context.lookup(ref)).toBeInstanceOf(PDFRawStream);
    }
  });

  it('2-up of a shared-image document embeds the image once', async () => {
    const bytes = await sharedImageDoc();
    const pages = Array.from({ length: 10 }, (_, i) => ({
      key: `k${i}`,
      sourceDocId: 'd',
      sourceIndex: i,
      rotation: 0
    }));
    const nup = await W.compose(
      pages,
      { d: bytes },
      [],
      undefined,
      undefined,
      null,
      { layout: '2-up', margin: 10, gutter: 10, drawBorders: false },
      undefined,
      undefined,
      {}
    );
    expect((await PDFDocument.load(nup)).getPageCount()).toBe(5);
    expect(await imageCount(nup)).toBe(1);
    expect(nup.byteLength).toBeLessThan(bytes.byteLength * 1.5);
  });

  it('2-up accepts a blank page with no /Contents (found by the differential run)', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([600, 800]).drawText('first', { x: 50, y: 700, size: 12, font });
    doc.addPage([600, 800]); // never drawn on: no /Contents at all
    const blank = doc.getPage(1).node;
    blank.delete(PDFName.of('Contents'));
    const bytes = await doc.save();
    const pages = [0, 1].map(i => ({
      key: `k${i}`,
      sourceDocId: 'd',
      sourceIndex: i,
      rotation: 0
    }));
    const nup = await W.compose(
      pages,
      { d: bytes },
      [],
      undefined,
      undefined,
      null,
      { layout: '2-up', margin: 10, gutter: 10, drawBorders: false },
      undefined,
      undefined,
      {}
    );
    expect((await PDFDocument.load(nup)).getPageCount()).toBe(1);
  });
});

describe('PDF-11 — a redacted field value does not survive on sibling widgets', () => {
  it('clears the value and every sibling appearance', async () => {
    const d = await PDFDocument.create();
    const p1 = d.addPage([600, 800]);
    const p2 = d.addPage([600, 800]);
    const tf = d.getForm().createTextField('ssn');
    tf.setText('SSN123456789');
    tf.addToPage(p1, { x: 50, y: 680, width: 200, height: 30 });
    tf.addToPage(p2, { x: 50, y: 100, width: 200, height: 30 });
    const bytes = await d.save();

    const out = await W.applyRedactions(bytes, [
      { pageIndex: 0, x: 0.05, y: 0.1, width: 0.45, height: 0.1 }
    ]);
    expect(await contains(out, 'SSN123456789')).toBe(false);
    expect(await W.collectOffPageText(out)).not.toContain('SSN123456789');
    const doc = await PDFDocument.load(out);
    // The page-2 widget survives, empty.
    const fields = doc.getForm().getFields();
    expect(fields.map(f => f.getName())).toEqual(['ssn']);
    expect(doc.getForm().getTextField('ssn').getText()).toBeUndefined();
  });
});

describe('PDF-13 — metadata scrub keeps navigation and structure', () => {
  async function structuredDoc() {
    const doc = await PDFDocument.create();
    const pages = [0, 1, 2].map(() => doc.addPage([300, 300]));
    const ctx = doc.context;
    const outlines = ctx.register(ctx.obj({ Type: 'Outlines' }));
    const item = ctx.register(
      ctx.obj({ Title: 'Chapter 3', Parent: outlines, Dest: [pages[2].ref, 'Fit'] })
    );
    const o = ctx.lookup(outlines, PDFDict);
    o.set(PDFName.of('First'), item);
    o.set(PDFName.of('Last'), item);
    o.set(PDFName.of('Count'), ctx.obj(1));
    doc.catalog.set(PDFName.of('Outlines'), outlines);
    doc.catalog.set(PDFName.of('PageLabels'), ctx.obj({ Nums: [0, { S: 'r' }] }));
    doc.catalog.set(PDFName.of('Lang'), PDFString.of('en-GB'));
    doc.catalog.set(PDFName.of('ViewerPreferences'), ctx.obj({ DisplayDocTitle: true }));
    doc.catalog.set(PDFName.of('MarkInfo'), ctx.obj({ Marked: true }));
    const elem = ctx.register(ctx.obj({ Type: 'StructElem', S: 'P', Pg: pages[1].ref }));
    doc.catalog.set(
      PDFName.of('StructTreeRoot'),
      ctx.register(ctx.obj({ Type: 'StructTreeRoot', K: [elem] }))
    );
    doc.catalog.set(
      PDFName.of('OutputIntents'),
      ctx.obj([{ Type: 'OutputIntent', S: 'GTS_PDFA1', OutputConditionIdentifier: 'sRGB' }])
    );
    return doc.save();
  }

  const nothing = {
    title: false,
    author: false,
    subject: false,
    creator: false,
    producer: false,
    creationDate: false,
    modificationDate: false,
    keywords: false,
    hasXmp: false,
    hasEmbeddedJavaScript: false,
    hasOpenAction: false,
    hasAdditionalActions: false,
    hasEmbeddedFiles: false,
    hasPageThumbnails: false,
    hasOptionalContent: false,
    customInfo: false
  };

  for (const [label, settings] of [
    ['nothing selected', nothing],
    ['defaults', undefined]
  ] as const) {
    it(`carries outlines, labels, struct tree, Lang, OutputIntents, ViewerPreferences (${label})`, async () => {
      const out = await W.scrubMetadata(await structuredDoc(), settings);
      const doc = await PDFDocument.load(out);
      const keys = new Set(doc.catalog.keys().map(k => k.asString()));
      for (const key of [
        '/Outlines',
        '/PageLabels',
        '/StructTreeRoot',
        '/Lang',
        '/OutputIntents',
        '/ViewerPreferences',
        '/MarkInfo'
      ]) {
        expect(keys).toContain(key);
      }
      // The bookmark and the structure element still name pages in the tree.
      const outlines = doc.catalog.lookup(PDFName.of('Outlines'), PDFDict);
      const first = outlines.lookup(PDFName.of('First'), PDFDict);
      const dest = first.lookup(PDFName.of('Dest'), PDFArray);
      expect(doc.getPages().findIndex(p => p.ref === dest.get(0))).toBe(2);
      const root = doc.catalog.lookup(PDFName.of('StructTreeRoot'), PDFDict);
      const elem = root.lookup(PDFName.of('K'), PDFArray).lookup(0, PDFDict);
      expect(doc.getPages().findIndex(p => p.ref === elem.get(PDFName.of('Pg')))).toBe(1);
      expect(await orphanPages(out)).toBe(0);
    });
  }
});

describe('M7 — the residual scan sees what the viewer-level checks cannot', () => {
  it('finds a secret held only by an orphan page and counts the orphan', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([300, 300]).drawText('visible', { x: 10, y: 10, font, size: 12 });
    // An orphan page dict, reachable from nothing in the tree.
    const orphanContent = doc.context.register(
      doc.context.flateStream('BT /F1 12 Tf 10 10 Td [(ORPH) -20 (ANSECRET)] TJ ET')
    );
    doc.context.register(doc.context.obj({ Type: 'Page', Contents: orphanContent }));
    const bytes = await doc.save({ useObjectStreams: true });

    const scan = await scanResidualText(bytes, ['orphansecret', 'visible', 'absent-term']);
    expect(scan.orphanPages).toBe(1);
    expect(scan.found).toContain('orphansecret');
    expect(scan.found).not.toContain('absent-term');
  });

  it('finds a secret in an outline title and ignores operator names', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([300, 300]).drawRectangle({ x: 1, y: 1, width: 5, height: 5 });
    const ctx = doc.context;
    const outlines = ctx.register(ctx.obj({ Type: 'Outlines' }));
    const item = ctx.register(
      ctx.obj({ Title: PDFString.of('Case 4471 notes'), Parent: outlines })
    );
    ctx.lookup(outlines, PDFDict).set(PDFName.of('First'), item);
    doc.catalog.set(PDFName.of('Outlines'), outlines);
    const scan = await scanResidualText(await doc.save(), ['case 4471', 're']);
    expect(scan.found).toEqual(['case 4471']);
    expect(scan.orphanPages).toBe(0);
  });

  it('a redacted output passes: no orphans, no residual secret', async () => {
    const { bytes } = await twoPageDoc('annotP');
    const out = await W.scrubMetadata(await W.applyRedactions(bytes, [mark]));
    const scan = await W.scanResidualText(out, [SECRET]);
    expect(scan).toMatchObject({ found: [], orphanPages: 0 });
  });
});
