/**
 * AUDIT 2026-10-10 P2–P6 — document structure a page-by-page rebuild used to
 * lose or corrupt without a word. Every assertion is on re-parsed output bytes.
 *
 *  P2  merging two filled copies of one form fused their same-named fields.
 *  P3  flatten drew hidden fields, misplaced rotated widgets, lost values quietly.
 *  P4  delete / reorder / merge dropped attachments, portfolios and named dests.
 *  P5  every rebuild dropped /Info, XMP and how the document opens.
 *  P6  normalize page size revealed cropped content and left annotations behind.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  StandardFonts,
  decodePDFRawStream,
  degrees
} from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

vi.mock('comlink', () => ({
  expose: vi.fn(),
  transfer: vi.fn(value => value),
  proxy: vi.fn(value => value)
}));

const { processWorkerImpl } = await import('../../src/core/workers/process.worker');
const { silentJob } = await import('../../src/core/workers/protocol');
type PageSource = import('../../src/core/workers/process.worker').PageSource;

const page = (docId: string, index: number, rotation = 0): PageSource => ({
  key: `${docId}-${index}-${rotation}`,
  sourceDocId: docId,
  sourceIndex: index,
  rotation
});

/** Composes like the app does, collecting every notice the worker reports. */
async function compose(
  pages: PageSource[],
  sources: Record<string, Uint8Array>,
  normalize: unknown = undefined
) {
  const notices: string[] = [];
  const job = { ...silentJob, notice: (m: string) => void notices.push(m) };
  const bytes = await processWorkerImpl.compose(
    pages,
    sources,
    [],
    undefined,
    undefined,
    normalize as never,
    undefined,
    undefined,
    job
  );
  return { bytes, doc: await PDFDocument.load(bytes, { updateMetadata: false }), notices };
}

interface TextItem {
  str: string;
  x: number;
  y: number;
}

async function pageText(bytes: Uint8Array, pageNumber = 1): Promise<TextItem[]> {
  const pdf = await getDocument({ data: bytes.slice() }).promise;
  const p = await pdf.getPage(pageNumber);
  const content = await p.getTextContent();
  const items = content.items as { str: string; transform: number[] }[];
  return items
    .filter(i => i.str.trim())
    .map(i => ({ str: i.str, x: i.transform[4], y: i.transform[5] }));
}

/** name → decoded file contents, from /Names /EmbeddedFiles (walking /Kids). */
function attachments(doc: PDFDocument): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (node: PDFDict | undefined) => {
    if (!node) return;
    const names = node.lookupMaybe(PDFName.of('Names'), PDFArray);
    for (let i = 0; names && i + 1 < names.size(); i += 2) {
      const key = names.lookup(i) as PDFString | PDFHexString;
      const spec = names.lookup(i + 1, PDFDict);
      const stream = spec.lookup(PDFName.of('EF'), PDFDict).lookup(PDFName.of('F'));
      const raw = stream as PDFRawStream;
      out.set(key.decodeText(), new TextDecoder().decode(decodePDFRawStream(raw).decode()));
    }
    const kids = node.lookupMaybe(PDFName.of('Kids'), PDFArray);
    for (let i = 0; kids && i < kids.size(); i++) visit(kids.lookupMaybe(i, PDFDict));
  };
  visit(
    doc.catalog
      .lookupMaybe(PDFName.of('Names'), PDFDict)
      ?.lookupMaybe(PDFName.of('EmbeddedFiles'), PDFDict)
  );
  return out;
}

function rectOf(dict: PDFDict): number[] {
  return dict
    .lookup(PDFName.of('Rect'), PDFArray)
    .asArray()
    .map(v => (v as PDFNumber).asNumber());
}

async function filledForm(value: string, pages = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const form = doc.getForm();
  const field = form.createTextField('Name');
  field.setText(value);
  for (let i = 0; i < pages; i++) {
    field.addToPage(doc.addPage([612, 792]), { x: 50, y: 700, width: 200, height: 20 });
  }
  return doc.save();
}

describe('P2 — merging same-named fields from different files', () => {
  it('keeps both values under distinct names and says so', async () => {
    const a = await filledForm('Alice');
    const b = await filledForm('Bob');
    const { doc, notices } = await compose([page('A', 0), page('B', 0)], { A: a, B: b });

    const fields = doc.getForm().getFields();
    const byName = new Map(fields.map(f => [f.getName(), doc.getForm().getTextField(f.getName())]));
    expect([...byName.keys()].sort()).toEqual(['Name', 'Name_2']);
    expect(byName.get('Name')!.getText()).toBe('Alice');
    expect(byName.get('Name_2')!.getText()).toBe('Bob');
    // Each value's widget is on its own file's page.
    expect(byName.get('Name')!.acroField.getWidgets()[0].P()).toBe(doc.getPage(0).ref);
    expect(byName.get('Name_2')!.acroField.getWidgets()[0].P()).toBe(doc.getPage(1).ref);
    expect(notices.join(' ')).toContain('"Name" → "Name_2"');
  });

  it('still merges one file’s field placed on two pages into one field', async () => {
    const a = await filledForm('Alice', 2);
    const { doc, notices } = await compose([page('A', 0), page('A', 1)], { A: a });
    const fields = doc.getForm().getFields();
    expect(fields.map(f => f.getName())).toEqual(['Name']);
    expect(fields[0].acroField.getWidgets()).toHaveLength(2);
    expect(notices.some(n => n.includes('renaming'))).toBe(false);
  });
});

async function flattenFixture() {
  const doc = await PDFDocument.create();
  const p = doc.addPage([612, 792]);
  const form = doc.getForm();
  const hidden = form.createTextField('internal');
  hidden.setText('SECRETNOTE');
  hidden.addToPage(p, { x: 50, y: 700, width: 200, height: 20 });
  hidden.acroField.getWidgets()[0].dict.set(PDFName.of('F'), PDFNumber.of(2)); // Hidden
  const noView = form.createTextField('reviewer');
  noView.setText('NOVIEWNOTE');
  noView.addToPage(p, { x: 50, y: 650, width: 200, height: 20 });
  noView.acroField.getWidgets()[0].dict.set(PDFName.of('F'), PDFNumber.of(32)); // NoView
  const rotated = form.createTextField('rot');
  rotated.setText('ROTATED');
  rotated.addToPage(p, { x: 300, y: 300, width: 20, height: 150, rotate: degrees(90) });
  const plain = form.createTextField('plain');
  plain.setText('PLAINVALUE');
  plain.addToPage(p, { x: 50, y: 500, width: 200, height: 20 });
  const bytes = await doc.save();
  const rotRect = rectOf(rotated.acroField.getWidgets()[0].dict);
  return { bytes, rotRect };
}

describe('P3 — flatten honours /F, places by §12.5.5, never loses a value', () => {
  it('does not draw Hidden or NoView fields, and keeps visible values', async () => {
    const { bytes } = await flattenFixture();
    const out = await processWorkerImpl.flattenDocument(bytes, silentJob);
    const text = (await pageText(out.bytes)).map(i => i.str).join(' ');
    expect(text).not.toContain('SECRETNOTE');
    expect(text).not.toContain('NOVIEWNOTE');
    expect(text).toContain('PLAINVALUE');
    expect(text).toContain('ROTATED');

    const doc = await PDFDocument.load(out.bytes);
    expect(doc.catalog.get(PDFName.of('AcroForm'))).toBeUndefined();
    expect(doc.getPage(0).node.Annots()).toBeUndefined();
    // The hidden value is not left behind as an unreferenced object either.
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      const dict = obj instanceof PDFDict ? obj : obj instanceof PDFStream ? obj.dict : null;
      const v = dict?.get(PDFName.of('V'));
      if (v instanceof PDFString || v instanceof PDFHexString) {
        expect(v.decodeText()).not.toBe('SECRETNOTE');
      }
    }
  });

  it('puts a 90°-rotated widget’s value inside its /Rect', async () => {
    const { bytes, rotRect } = await flattenFixture();
    const out = await processWorkerImpl.flattenDocument(bytes, silentJob);
    const item = (await pageText(out.bytes)).find(i => i.str.includes('ROTATED'));
    expect(item).toBeDefined();
    const [x1, y1, x2, y2] = rotRect;
    expect(item!.x).toBeGreaterThanOrEqual(Math.min(x1, x2) - 0.5);
    expect(item!.x).toBeLessThanOrEqual(Math.max(x1, x2) + 0.5);
    expect(item!.y).toBeGreaterThanOrEqual(Math.min(y1, y2) - 0.5);
    expect(item!.y).toBeLessThanOrEqual(Math.max(y1, y2) + 0.5);
  });

  it('the fill-and-flatten path drops a hidden field undrawn too', async () => {
    const { bytes } = await flattenFixture();
    const out = await processWorkerImpl.fillFormFields(bytes, { plain: 'FILLED' }, true, silentJob);
    const text = (await pageText(out)).map(i => i.str).join(' ');
    expect(text).toContain('FILLED');
    expect(text).not.toContain('SECRETNOTE');
    expect((await PDFDocument.load(out)).getForm().getFields()).toHaveLength(0);
  });

  it('generates an appearance for a widget that has none', async () => {
    const doc = await PDFDocument.create();
    const field = doc.getForm().createTextField('bare');
    field.setText('GENERATED');
    field.addToPage(doc.addPage([400, 400]), { x: 40, y: 40, width: 200, height: 24 });
    field.acroField.getWidgets()[0].dict.delete(PDFName.of('AP'));
    const bytes = await doc.save({ updateFieldAppearances: false });
    expect(
      (await PDFDocument.load(bytes))
        .getForm()
        .getTextField('bare')
        .acroField.getWidgets()[0]
        .dict.get(PDFName.of('AP'))
    ).toBeUndefined();

    const out = await processWorkerImpl.flattenDocument(bytes, silentJob);
    expect((await pageText(out.bytes)).map(i => i.str).join(' ')).toContain('GENERATED');
  });

  it('refuses the whole flatten when a value cannot be drawn', async () => {
    const doc = await PDFDocument.create();
    const p = doc.addPage([400, 400]);
    const ok = doc.getForm().createTextField('ok');
    ok.setText('FINE');
    ok.addToPage(p, { x: 40, y: 300, width: 200, height: 24 });
    // A ticked box whose "on" appearance is broken (not a stream): pdf-lib sees
    // an appearance dictionary with the state present and regenerates nothing,
    // yet there is nothing drawable for the tick. Flattening would lose it.
    const box = doc.getForm().createCheckBox('agree');
    box.addToPage(p, { x: 40, y: 40, width: 20, height: 20 });
    box.check();
    box.defaultUpdateAppearances();
    const widget = box.acroField.getWidgets()[0].dict;
    const normal = widget.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N'), PDFDict);
    const onState = widget.get(PDFName.of('AS')) as PDFName;
    normal.set(onState, doc.context.register(doc.context.obj({ Broken: true })));
    const bytes = await doc.save({ updateFieldAppearances: false });

    await expect(processWorkerImpl.flattenDocument(bytes, silentJob)).rejects.toThrow(
      /"agree".*nothing was saved/i
    );
    await expect(processWorkerImpl.fillFormFields(bytes, {}, true, silentJob)).rejects.toThrow(
      /"agree".*nothing was saved/i
    );
  });
});

async function withAttachment(pages = 2, name = 'invoice.csv', data = 'invoice data') {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([300, 300]);
  await doc.attach(new TextEncoder().encode(data), name, { mimeType: 'text/csv' });
  return doc;
}

describe('P4 — attachments, portfolios and named destinations survive page changes', () => {
  it('delete page 2 and reorder keep invoice.csv', async () => {
    const bytes = await (await withAttachment()).save();
    for (const pages of [[page('d', 0)], [page('d', 1), page('d', 0)]]) {
      const { doc } = await compose(pages, { d: bytes });
      expect(doc.getPageCount()).toBe(pages.length);
      expect(attachments(doc).get('invoice.csv')).toBe('invoice data');
    }
  });

  it('merge keeps every file’s attachments, renaming a clash', async () => {
    const a = await (await withAttachment(1, 'invoice.csv', 'from A')).save();
    const b = await (await withAttachment(1, 'invoice.csv', 'from B')).save();
    const { doc } = await compose([page('A', 0), page('B', 0)], { A: a, B: b });
    const files = attachments(doc);
    expect(files.get('invoice.csv')).toBe('from A');
    expect(files.get('invoice.csv_2')).toBe('from B');
  });

  it('keeps a portfolio /Collection and /AF', async () => {
    // `attach` is lazy; the name tree exists once the document is written.
    const src = await PDFDocument.load(await (await withAttachment()).save());
    const names = src.catalog.lookup(PDFName.of('Names'), PDFDict);
    const spec = names
      .lookup(PDFName.of('EmbeddedFiles'), PDFDict)
      .lookup(PDFName.of('Names'), PDFArray)
      .get(1);
    src.catalog.set(PDFName.of('Collection'), src.context.obj({ Type: 'Collection', View: 'D' }));
    src.catalog.set(PDFName.of('AF'), src.context.obj([spec]));
    const bytes = await src.save();
    for (const pages of [[page('d', 0), page('d', 1)], [page('d', 1)]]) {
      const { doc } = await compose(pages, { d: bytes });
      const collection = doc.catalog.lookup(PDFName.of('Collection'), PDFDict);
      expect(collection.get(PDFName.of('View'))).toBe(PDFName.of('D'));
      const af = doc.catalog.lookup(PDFName.of('AF'), PDFArray);
      expect(af.size()).toBe(1);
      expect(attachments(doc).get('invoice.csv')).toBe('invoice data');
    }
  });

  it('rebuilds named destinations through the page map, dropping only removed pages', async () => {
    const src = await PDFDocument.create();
    const p0 = src.addPage([300, 300]);
    const p1 = src.addPage([300, 300]);
    const p2 = src.addPage([300, 300]);
    const dest = (p: typeof p0) => src.context.obj([p.ref, PDFName.of('Fit')]);
    src.catalog.set(
      PDFName.of('Names'),
      src.context.obj({
        Dests: src.context.obj({
          Names: [
            PDFString.of('first'),
            dest(p0),
            PDFString.of('second'),
            dest(p1),
            PDFString.of('third'),
            dest(p2)
          ]
        })
      })
    );
    const bytes = await src.save();
    const { doc } = await compose([page('d', 2), page('d', 0)], { d: bytes });
    const tree = doc.catalog
      .lookup(PDFName.of('Names'), PDFDict)
      .lookup(PDFName.of('Dests'), PDFDict)
      .lookup(PDFName.of('Names'), PDFArray);
    const map = new Map<string, PDFRef>();
    for (let i = 0; i + 1 < tree.size(); i += 2) {
      map.set(
        (tree.lookup(i) as PDFString).decodeText(),
        tree.lookup(i + 1, PDFArray).get(0) as PDFRef
      );
    }
    expect([...map.keys()].sort()).toEqual(['first', 'third']);
    expect(map.get('first')).toBe(doc.getPage(1).ref);
    expect(map.get('third')).toBe(doc.getPage(0).ref);
  });

  it('discloses what it still cannot carry', async () => {
    const src = await PDFDocument.create();
    src.addPage([300, 300]);
    src.addPage([300, 300]);
    src.catalog.set(PDFName.of('PageLabels'), src.context.obj({ Nums: [0, { S: 'r' }] }));
    const { notices } = await compose([page('d', 1)], { d: await src.save() });
    expect(notices.join(' ')).toContain('page labels');
  });
});

async function metadataDoc() {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.addPage([300, 300]);
  doc.addPage([300, 300]);
  doc.setTitle('Quarterly Report');
  doc.setAuthor('Jane');
  doc.setProducer('Original Producer 1.0');
  doc.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));
  doc.catalog.set(PDFName.of('PageLayout'), PDFName.of('TwoColumnLeft'));
  const xmp = doc.context.stream(
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><pdfaid:part>2</pdfaid:part></x:xmpmeta>',
    { Type: 'Metadata', Subtype: 'XML' }
  );
  doc.catalog.set(PDFName.of('Metadata'), doc.context.register(xmp));
  return doc;
}

function expectMetadataKept(doc: PDFDocument) {
  expect(doc.getTitle()).toBe('Quarterly Report');
  expect(doc.getAuthor()).toBe('Jane');
  expect(doc.getProducer()).toBe('Original Producer 1.0');
  expect(doc.catalog.get(PDFName.of('PageMode'))).toBe(PDFName.of('UseOutlines'));
  expect(doc.catalog.get(PDFName.of('PageLayout'))).toBe(PDFName.of('TwoColumnLeft'));
  const xmp = doc.catalog.lookup(PDFName.of('Metadata'), PDFStream) as PDFRawStream;
  expect(new TextDecoder().decode(decodePDFRawStream(xmp).decode())).toContain('pdfaid:part');
}

describe('P5 — /Info, XMP and opening settings survive rebuilds', () => {
  it('rotate one page keeps them, without stamping pdf-lib as Producer', async () => {
    const bytes = await (await metadataDoc()).save();
    const { doc } = await compose([page('d', 0), page('d', 1, 90)], { d: bytes });
    expectMetadataKept(doc);
  });

  it('compress keeps them', async () => {
    const src = await metadataDoc();
    const image = src.context.stream(new Uint8Array(4096).fill(0x7f), {
      Type: 'XObject',
      Subtype: 'Image',
      Width: 32,
      Height: 32,
      ColorSpace: 'DeviceGray',
      BitsPerComponent: 8
    });
    const ref = src.context.register(image);
    const p = src.getPage(0);
    (p.node.Resources() as PDFDict).set(PDFName.of('XObject'), src.context.obj({ Im0: ref }));
    p.node.set(
      PDFName.of('Contents'),
      src.context.register(src.context.flateStream('q 200 0 0 200 0 0 cm /Im0 Do Q'))
    );
    const bytes = await src.save({ useObjectStreams: false });
    const tinyJpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00,
      0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x02, 0x00, 0x02, 0x01,
      0x01, 0x11, 0x00, 0xff, 0xd9
    ]);
    const result = await processWorkerImpl.rebuildCompressed(
      bytes,
      {},
      { 0: { [ref.objectNumber]: { jpeg: tinyJpeg, width: 2, height: 2 } } },
      silentJob
    );
    expect(result.keptOriginal).toBe(false);
    expectMetadataKept(await PDFDocument.load(result.bytes, { updateMetadata: false }));
  });

  it('the metadata scrub still removes them', async () => {
    const bytes = await (await metadataDoc()).save();
    const out = await processWorkerImpl.scrubMetadata(bytes, {
      title: true,
      author: true,
      producer: true,
      hasXmp: true
    });
    const doc = await PDFDocument.load(out, { updateMetadata: false });
    expect(doc.getTitle()).toBeUndefined();
    expect(doc.getAuthor()).toBeUndefined();
    expect(doc.catalog.get(PDFName.of('Metadata'))).toBeUndefined();
  });
});

describe('P6 — normalize page size scales the visible box and moves annotations', () => {
  it('content cropped away stays outside the visible content region, clipped', async () => {
    const src = await PDFDocument.create();
    const p = src.addPage([1000, 1000]);
    const font = await src.embedFont(StandardFonts.Helvetica);
    p.drawText('VISIBLE', { x: 50, y: 50, size: 20, font });
    // Above the crop — and, unclipped, inside the new A4 page's top margin.
    p.drawText('HIDDEN', { x: 100, y: 560, size: 20, font });
    p.setCropBox(0, 0, 500, 500);
    const bytes = await src.save();
    const { bytes: out, doc } = await compose(
      [page('d', 0)],
      { d: bytes },
      {
        targetSize: 'A4',
        scaleMode: 'fit'
      }
    );
    const pg = doc.getPage(0);
    expect(pg.getMediaBox()).toEqual({ x: 0, y: 0, width: 595.28, height: 841.89 });
    expect(pg.getCropBox()).toEqual({ x: 0, y: 0, width: 595.28, height: 841.89 });

    const factor = 595.28 / 500;
    const dy = (841.89 - 500 * factor) / 2;
    const region = { x0: 0, y0: dy, x1: 595.28, y1: dy + 500 * factor };
    const items = await pageText(out);
    const visible = items.find(i => i.str === 'VISIBLE')!;
    expect(visible.x).toBeCloseTo(50 * factor, 1);
    expect(visible.y).toBeCloseTo(50 * factor + dy, 1);
    const hidden = items.find(i => i.str === 'HIDDEN');
    if (hidden) expect(hidden.y).toBeGreaterThan(region.y1);

    // And a clip to exactly that region wraps the original content.
    const contents = pg.node.Contents() as PDFArray;
    const first = doc.context.lookup(contents.get(0)) as PDFRawStream;
    const ops = new TextDecoder().decode(
      first.dict.has(PDFName.of('Filter')) ? decodePDFRawStream(first).decode() : first.contents
    );
    expect(ops).toMatch(/0 0 500 500 re\s+W\s+n/);
  });

  it('an offset MediaBox comes out at the origin with the target size', async () => {
    const src = await PDFDocument.create();
    const p = src.addPage([612, 792]);
    p.setMediaBox(100, 100, 612, 792);
    const { doc } = await compose(
      [page('d', 0)],
      { d: await src.save() },
      {
        targetSize: 'A4',
        scaleMode: 'fit'
      }
    );
    const pg = doc.getPage(0);
    expect(pg.getMediaBox()).toEqual({ x: 0, y: 0, width: 595.28, height: 841.89 });
    expect(pg.getCropBox()).toEqual({ x: 0, y: 0, width: 595.28, height: 841.89 });
  });

  it('a link annotation moves with the content it sits on', async () => {
    const src = await PDFDocument.create();
    const p = src.addPage([612, 792]);
    const font = await src.embedFont(StandardFonts.Helvetica);
    p.drawText('LINKTARGET', { x: 100, y: 100, size: 12, font });
    const link = src.context.register(
      src.context.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [100, 100, 200, 120],
        Border: [0, 0, 0],
        A: { S: 'URI', URI: PDFString.of('https://example.invalid/') }
      })
    );
    p.node.set(PDFName.of('Annots'), src.context.obj([link]));
    const { bytes, doc } = await compose(
      [page('d', 0)],
      { d: await src.save() },
      {
        targetSize: 'A4',
        scaleMode: 'fit'
      }
    );
    const text = (await pageText(bytes)).find(i => i.str === 'LINKTARGET')!;
    const annot = doc.getPage(0).node.Annots()!.lookup(0, PDFDict);
    const [x1, y1, x2] = rectOf(annot);
    expect(x1).toBeCloseTo(text.x, 1);
    expect(y1).toBeCloseTo(text.y, 1);
    expect(x2 - x1).toBeCloseTo(100 * (595.28 / 612), 1);
  });
});

describe('P6 follow-up — annotations wholly in the cropped-away area', () => {
  it('removes a link and its markup there, keeps a widget, and says both', async () => {
    const src = await PDFDocument.create();
    const p = src.addPage([1000, 1000]);
    const annot = (subtype: string, rect: number[]) =>
      src.context.register(src.context.obj({ Type: 'Annot', Subtype: subtype, Rect: rect }));
    const inside = annot('Link', [10, 10, 60, 30]);
    const outsideLink = annot('Link', [700, 700, 760, 720]);
    const outsideNote = annot('Square', [600, 50, 650, 90]);
    const popup = src.context.register(
      src.context.obj({
        Type: 'Annot',
        Subtype: 'Popup',
        Rect: [10, 10, 90, 60],
        Parent: outsideNote
      })
    );
    const field = src.getForm().createTextField('offcrop');
    field.setText('KEEPME');
    field.addToPage(p, { x: 700, y: 100, width: 100, height: 20 });
    const annots = p.node.Annots()!;
    for (const ref of [inside, outsideLink, outsideNote, popup]) annots.push(ref);
    p.setCropBox(0, 0, 500, 500);

    const { doc, notices } = await compose(
      [page('d', 0)],
      { d: await src.save() },
      {
        targetSize: 'A4',
        scaleMode: 'fit'
      }
    );
    const kept = doc
      .getPage(0)
      .node.Annots()!
      .asArray()
      .map(ref => doc.context.lookup(ref, PDFDict).get(PDFName.of('Subtype')));
    expect(kept.filter(s => s === PDFName.of('Link'))).toHaveLength(1);
    expect(kept).not.toContain(PDFName.of('Square'));
    expect(kept).not.toContain(PDFName.of('Popup'));
    expect(kept).toContain(PDFName.of('Widget'));
    expect(doc.getForm().getTextField('offcrop').getText()).toBe('KEEPME');
    expect(notices.join(' ')).toContain(
      'Annotations that lay outside the cropped area were removed (pages 1)'
    );
    expect(notices.join(' ')).toContain('Form fields that lay outside the cropped area were kept');
  });

  it('says nothing when every annotation is inside the visible area', async () => {
    const src = await PDFDocument.create();
    const p = src.addPage([612, 792]);
    p.node.set(
      PDFName.of('Annots'),
      src.context.obj([
        src.context.register(
          src.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [10, 10, 60, 30] })
        )
      ])
    );
    const { notices } = await compose(
      [page('d', 0)],
      { d: await src.save() },
      {
        targetSize: 'A4',
        scaleMode: 'fit'
      }
    );
    expect(notices.filter(n => n.includes('cropped area'))).toEqual([]);
  });
});

describe('P4 follow-up — compress discloses what its rebuild did not carry', () => {
  it('reports a dropped open action through the job, only when the rebuild is kept', async () => {
    const src = await PDFDocument.create();
    const p = src.addPage([200, 200]);
    const image = src.context.stream(new Uint8Array(4096).fill(0x7f), {
      Type: 'XObject',
      Subtype: 'Image',
      Width: 32,
      Height: 32,
      ColorSpace: 'DeviceGray',
      BitsPerComponent: 8
    });
    const ref = src.context.register(image);
    (p.node.Resources() as PDFDict).set(PDFName.of('XObject'), src.context.obj({ Im0: ref }));
    p.node.set(
      PDFName.of('Contents'),
      src.context.register(src.context.flateStream('q 200 0 0 200 0 0 cm /Im0 Do Q'))
    );
    src.catalog.set(
      PDFName.of('OpenAction'),
      src.context.obj({ S: 'JavaScript', JS: PDFString.of('app.alert(1)') })
    );
    const bytes = await src.save({ useObjectStreams: false });
    const notices: string[] = [];
    const job = { ...silentJob, notice: (m: string) => void notices.push(m) };
    const tinyJpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00,
      0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x02, 0x00, 0x02, 0x01,
      0x01, 0x11, 0x00, 0xff, 0xd9
    ]);
    const result = await processWorkerImpl.rebuildCompressed(
      bytes,
      {},
      { 0: { [ref.objectNumber]: { jpeg: tinyJpeg, width: 2, height: 2 } } },
      job
    );
    expect(result.keptOriginal).toBe(false);
    expect(notices).toEqual([
      'Not carried into the compressed file: document scripts and open actions.'
    ]);
  });
});

describe('job protocol — notices', () => {
  it('createJobHandle forwards notices; reportNotice never throws', async () => {
    const { createJobHandle, reportNotice } = await import('../../src/core/workers/protocol');
    const heard: string[] = [];
    await reportNotice(createJobHandle({ onNotice: m => void heard.push(m) }), 'hello');
    expect(heard).toEqual(['hello']);
    // A port whose notice rejects (a Comlink remote without one) and a port
    // without one at all are both silently fine.
    await expect(
      reportNotice({ ...silentJob, notice: () => Promise.reject(new Error('no')) }, 'x')
    ).resolves.toBeUndefined();
    await expect(reportNotice(silentJob, 'x')).resolves.toBeUndefined();
    await expect(reportNotice(undefined, 'x')).resolves.toBeUndefined();
  });
});
