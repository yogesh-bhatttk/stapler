import { describe, expect, it, vi } from 'vitest';
import { PDFDocument, PDFArray, PDFName, PDFString, PDFDict, PDFNumber, degrees } from 'pdf-lib';

/**
 * Reads a PDF text object's value without going through pdf-lib's field
 * accessors, so an assertion proves what is in the dictionary a viewer reads.
 * PDFString and PDFHexString share no exported base class, hence the duck type.
 */
function textOfPdfValue(value: unknown): string | undefined {
  const anyValue = value as any;
  return typeof anyValue?.decodeText === 'function' ? String(anyValue.decodeText()) : undefined;
}

/**
 * Everything a page draws, decompressed, as text: its own content streams plus the
 * form XObjects they invoke. Flatten emits each field's appearance as an XObject
 * and a `Do`, so the flattened value is one level down from the page stream.
 */
async function pageContentText(doc: PDFDocument, pageIndex: number): Promise<string> {
  const { decodeStream } = await import('../../src/core/pdf/interpreter');

  async function streamText(stream: any): Promise<string> {
    const raw: Uint8Array = stream.getContents();
    const isFlate = String(stream.dict?.get(PDFName.of('Filter'))) === '/FlateDecode';
    return new TextDecoder('latin1').decode(isFlate ? await decodeStream(raw) : raw);
  }

  const page = doc.getPage(pageIndex);
  const contents = page.node.Contents();
  if (!contents) return '';
  const streams: any[] =
    contents instanceof PDFArray
      ? contents.asArray().map(ref => doc.context.lookup(ref))
      : [contents];

  let text = '';
  for (const stream of streams) text += await streamText(stream);

  const xobjects = page.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict);
  for (const [, ref] of xobjects?.entries() ?? []) {
    const xobject = doc.context.lookup(ref) as any;
    if (typeof xobject?.getContents === 'function') text += await streamText(xobject);
  }

  // pdf-lib writes show-text operands as hex literals when the font is embedded
  // (`<477261636520486F70706572> Tj`), so append their decoding — otherwise an
  // assertion on the visible string would fail on a document that draws it fine.
  return text + decodeHexLiterals(text);
}

/**
 * Decodes every `<hex>` string literal in a content stream. Both widths are
 * emitted because the code width depends on the font: a standard-14 font uses
 * single-byte codes, an embedded CID font two-byte ones, and the test should not
 * have to know which pdf-lib picked.
 */
function decodeHexLiterals(content: string): string {
  let out = '';
  for (const match of content.matchAll(/<([0-9A-Fa-f\s]+)>/g)) {
    const hex = match[1].replace(/\s+/g, '');
    for (const width of [2, 4]) {
      if (hex.length % width !== 0) continue;
      let decoded = '';
      for (let i = 0; i < hex.length; i += width) {
        decoded += String.fromCharCode(parseInt(hex.slice(i, i + width), 16));
      }
      out += `\n${decoded}`;
    }
  }
  return out;
}

vi.mock('comlink', () => ({
  expose: vi.fn(),
  transfer: vi.fn(val => val)
}));
import { processWorkerImpl } from '../../src/core/workers/process.worker';
import { silentJob } from '../../src/core/workers/protocol';

describe('scrubMetadata', () => {
  it('strips all metadata by default', async () => {
    const doc = await PDFDocument.create();
    doc.setTitle('Secret Title');
    doc.setAuthor('Secret Author');
    doc.setSubject('Secret Subject');

    // Add custom info dictionary property
    const info = doc.context.lookup(doc.context.trailerInfo.Info, PDFDict);
    info.set(doc.context.obj('CompanyPath'), PDFString.of('C:\\Users\\JohnDoe\\Documents'));

    const bytes = await doc.save();

    const scrubbedBytes = await processWorkerImpl.scrubMetadata(bytes);

    // Check what is left
    const scrubbedDoc = await PDFDocument.load(scrubbedBytes);
    expect(scrubbedDoc.getTitle()).toBeUndefined();
    expect(scrubbedDoc.getAuthor()).toBeUndefined();
    expect(scrubbedDoc.getSubject()).toBeUndefined();

    const scrubbedInfo = scrubbedDoc.context.lookup(scrubbedDoc.context.trailerInfo.Info, PDFDict);
    expect(scrubbedInfo.get(scrubbedDoc.context.obj('CompanyPath'))).toBeUndefined();
  });

  it('keeps selected metadata based on settings', async () => {
    const doc = await PDFDocument.create();
    doc.setTitle('Kept Title');
    doc.setAuthor('Stripped Author');

    const info = doc.context.lookup(doc.context.trailerInfo.Info, PDFDict);
    info.set(doc.context.obj('CustomData'), PDFString.of('Keep Me'));

    const bytes = await doc.save();

    // We only strip 'author', so title and customInfo are kept
    const scrubbedBytes = await processWorkerImpl.scrubMetadata(bytes, {
      author: true,
      title: false,
      customInfo: false
    });

    const scrubbedDoc = await PDFDocument.load(scrubbedBytes);
    expect(scrubbedDoc.getTitle()).toBe('Kept Title');
    expect(scrubbedDoc.getAuthor()).toBeUndefined();

    const scrubbedInfo = scrubbedDoc.context.lookup(scrubbedDoc.context.trailerInfo.Info, PDFDict);
    expect(scrubbedInfo.get(scrubbedDoc.context.obj('CustomData'))).toBeDefined();
  });
});

/**
 * RED-04's acceptance criteria, asserted against the produced bytes rather than
 * against the parsed convenience accessors alone: everything in the document is
 * decompressed (object streams included) and searched for the strings, because a
 * value that merely stopped being *referenced* is still a disclosure.
 */
async function everyStringInDocument(bytes: Uint8Array): Promise<string> {
  const { decodeStream } = await import('../../src/core/pdf/interpreter');
  const latin1 = new TextDecoder('latin1');
  let text = latin1.decode(bytes);
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    // pdf-lib streams share no exported base class here, so the contents accessor
    // is duck-typed, as elsewhere in this file.
    const stream = obj as any;
    if (typeof stream?.getContents !== 'function') continue;
    const raw: Uint8Array = stream.getContents();
    const filter = String(stream.dict?.get(PDFName.of('Filter')) ?? '');
    try {
      const decoded = filter.includes('FlateDecode') ? await decodeStream(raw) : raw;
      text += latin1.decode(decoded);
    } catch {
      // Undecodable stream: its raw bytes are already in `text` from the file scan.
    }
  }
  // Info strings are written as UTF-16BE hex literals, so the readable form has to
  // be appended or a search for the author name would pass vacuously.
  return text + decodeHexLiterals(text);
}

describe('RED-04 metadata inspector and scrubber', () => {
  it('reports the author and the Windows path from every place they hide', async () => {
    const { metadataLeakPdf, METADATA_LEAK } = await import('../e2e/fixtures');
    const bytes = await metadataLeakPdf();

    const found = await processWorkerImpl.readMetadata(bytes);

    expect(found.author).toBe(METADATA_LEAK.author);
    expect(found.producer).toContain(METADATA_LEAK.producerPath);
    expect(found.customInfo).toContainEqual({
      key: 'SourceFile',
      value: METADATA_LEAK.sourcePath
    });
    expect(found.hasXmp).toBe(true);
    expect(found.hasEmbeddedJavaScript).toBe(true);

    // Each of the three hiding places is named, with the toggle that clears it.
    expect(found.filesystemPaths).toContainEqual({
      source: 'Producer',
      value: METADATA_LEAK.producerPath,
      settingKey: 'producer'
    });
    expect(found.filesystemPaths).toContainEqual({
      source: 'SourceFile (custom property)',
      value: METADATA_LEAK.sourcePath,
      settingKey: 'customInfo'
    });
    expect(found.filesystemPaths).toContainEqual({
      source: 'XMP packet',
      value: METADATA_LEAK.xmpPath,
      settingKey: 'hasXmp'
    });
  });

  it('does not mistake a URL for a filesystem path', async () => {
    const doc = await PDFDocument.create();
    // pdf-lib's own default Producer, which contains `s://` — the shape that made the
    // drive-letter pattern report a path on every document.
    doc.setProducer('pdf-lib (https://github.com/Hopding/pdf-lib)');
    const found = await processWorkerImpl.readMetadata(await doc.save());
    expect(found.filesystemPaths).toEqual([]);
  });

  it('strips only the ticked items when per-item settings are given', async () => {
    const { metadataLeakPdf, METADATA_LEAK } = await import('../e2e/fixtures');
    const bytes = await metadataLeakPdf();

    // Author only: the paths and the JavaScript must survive untouched.
    const out = await processWorkerImpl.scrubMetadata(bytes, { author: true });
    const found = await processWorkerImpl.readMetadata(out);

    expect(found.author).toBeUndefined();
    expect(found.producer).toContain(METADATA_LEAK.producerPath);
    expect(found.customInfo).toContainEqual({
      key: 'SourceFile',
      value: METADATA_LEAK.sourcePath
    });
    expect(found.hasEmbeddedJavaScript).toBe(true);
    // Catalog-level items are the ones the rebuild used to drop unconditionally:
    // before the carry-across, unticking them changed nothing.
    expect(found.hasXmp).toBe(true);
  });

  it('removes the JavaScript when only that item is ticked', async () => {
    const { metadataLeakPdf, METADATA_LEAK } = await import('../e2e/fixtures');
    const bytes = await metadataLeakPdf();

    const out = await processWorkerImpl.scrubMetadata(bytes, { hasEmbeddedJavaScript: true });
    const found = await processWorkerImpl.readMetadata(out);

    expect(found.hasEmbeddedJavaScript).toBe(false);
    expect(await everyStringInDocument(out)).not.toContain(METADATA_LEAK.javascript);
    // Nothing else was taken with it.
    expect(found.author).toBe(METADATA_LEAK.author);
  });

  it('strip-all leaves no trace of the author or the path in the exported bytes', async () => {
    const { metadataLeakPdf, METADATA_LEAK } = await import('../e2e/fixtures');
    const bytes = await metadataLeakPdf();

    const before = await processWorkerImpl.readMetadata(bytes);
    expect(before.author).toBe(METADATA_LEAK.author);
    expect(before.filesystemPaths.length).toBeGreaterThanOrEqual(3);

    const out = await processWorkerImpl.scrubMetadata(bytes);
    const after = await processWorkerImpl.readMetadata(out);

    expect(after.author).toBeUndefined();
    expect(after.producer).toBeUndefined();
    expect(after.customInfo).toEqual([]);
    expect(after.filesystemPaths).toEqual([]);
    expect(after.hasXmp).toBe(false);
    expect(after.hasEmbeddedJavaScript).toBe(false);

    // The bytes themselves, decompressed — not just the accessors.
    const raw = await everyStringInDocument(out);
    expect(raw).not.toContain(METADATA_LEAK.author);
    expect(raw).not.toContain('ghopper');
    expect(raw).not.toContain('board-pack.docx');
    expect(raw).not.toContain('engine.dll');

    // …and the document is still the document.
    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(1);
    expect(await pageContentText(doc, 0)).toContain('Quarterly board pack');
  });
});

describe('applyRedactions', () => {
  it('performs operator-level removal of text within region', async () => {
    // Generate a simple PDF with text
    const { textPdf } = await import('../e2e/fixtures');
    const bytes = await textPdf(1);
    const sourceDoc = await PDFDocument.load(bytes);
    const sourceText = await pageContentText(sourceDoc, 0);
    expect(sourceText).toContain('Line 1 of body text on page 1.');

    // Redact the top half of the page
    const regions = [
      {
        pageIndex: 0,
        x: 0,
        y: 0,
        width: 1,
        height: 0.5 // Top half (y=0 is top in normalized coords)
      }
    ];

    const redactedBytes = await processWorkerImpl.applyRedactions(bytes, regions);

    const redactedDoc = await PDFDocument.load(redactedBytes);
    const redactedText = await pageContentText(redactedDoc, 0);
    expect(redactedText).not.toContain('Line 1 of body text on page 1.');
    expect(redactedText).toContain('Line 24 of body text on page 1.');
  });

  it('drops source outlines from redacted output', async () => {
    const { textPdf } = await import('../e2e/fixtures');
    const doc = await PDFDocument.load(await textPdf(1));
    const ctx = doc.context;
    const page = doc.getPage(0);
    const outlines = ctx.obj({ Type: 'Outlines' });
    const outlinesRef = ctx.register(outlines);
    const item = ctx.obj({
      Title: PDFString.of('Secret bookmark'),
      Parent: outlinesRef,
      Dest: [page.ref, PDFName.of('Fit')]
    });
    const itemRef = ctx.register(item);
    outlines.set(PDFName.of('First'), itemRef);
    outlines.set(PDFName.of('Last'), itemRef);
    doc.catalog.set(PDFName.of('Outlines'), outlinesRef);

    const redacted = await processWorkerImpl.applyRedactions(
      await doc.save({ useObjectStreams: false }),
      [{ pageIndex: 0, x: 0, y: 0, width: 1, height: 0.5 }]
    );

    expect(await processWorkerImpl.readOutline(redacted)).toEqual([]);
  });

  it('does not delete a shared XObject dictionary from sibling pages', async () => {
    const doc = await PDFDocument.create();
    const image = await doc.embedPng(ONE_PIXEL_PNG);
    const sharedResources = doc.context.obj({ XObject: { Im0: image.ref } }) as PDFDict;

    const page0 = doc.addPage([600, 800]);
    page0.node.set(PDFName.of('Resources'), sharedResources);
    page0.node.set(
      PDFName.of('Contents'),
      doc.context.register(doc.context.flateStream('q 600 0 0 800 0 0 cm /Im0 Do Q'))
    );

    const page1 = doc.addPage([600, 800]);
    page1.node.set(PDFName.of('Resources'), sharedResources);
    page1.drawText('Sibling page keeps its image dictionary', { x: 50, y: 750 });

    const redacted = await processWorkerImpl.applyRedactions(
      await doc.save({ useObjectStreams: false }),
      [{ pageIndex: 0, x: 0, y: 0, width: 1, height: 1 }]
    );

    const outDoc = await PDFDocument.load(redacted);
    const siblingResources = outDoc
      .getPage(1)
      .node.Resources()
      ?.lookupMaybe(PDFName.of('XObject'), PDFDict);
    expect(siblingResources?.has(PDFName.of('Im0'))).toBe(true);
  });
});

describe('collectOffPageText (RED-03 blind spot)', () => {
  it('finds a redacted string quoted in a sticky-note annotation on another page', async () => {
    const SECRET = 'SSN-123-45-6789';
    const { StandardFonts } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const p1 = doc.addPage([600, 800]);
    p1.drawText(SECRET, { x: 100, y: 750, size: 12, font });
    const p2 = doc.addPage([600, 800]);
    const annot = doc.context.obj({
      Type: 'Annot',
      Subtype: 'Text',
      Rect: [50, 50, 250, 100],
      Contents: PDFString.of(`Client ${SECRET} flagged`)
    });
    p2.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(annot)]));
    const bytes = await doc.save({ useObjectStreams: false });

    // Redact only the occurrence on page 1 — the sticky note on page 2 is left
    // structurally untouched, exactly as a real search-and-mark run would leave it.
    const redacted = await processWorkerImpl.applyRedactions(bytes, [
      { pageIndex: 0, x: 0.1, y: 0.03, width: 0.5, height: 0.08, text: SECRET }
    ]);

    const offPageText = await processWorkerImpl.collectOffPageText(redacted);
    expect(offPageText.join(' ')).toContain(SECRET);
  });

  it('finds a filled AcroForm text field value', async () => {
    const SECRET = 'Ada Lovelace';
    const doc = await PDFDocument.create();
    const page = doc.addPage([600, 800]);
    const form = doc.getForm();
    const field = form.createTextField('name');
    field.setText(SECRET);
    field.addToPage(page, { x: 100, y: 700, width: 200, height: 40 });
    const bytes = await doc.save({ useObjectStreams: false });

    const offPageText = await processWorkerImpl.collectOffPageText(bytes);
    expect(offPageText).toContain(SECRET);
  });
});

describe('applyRedactions: Form XObject text (RED-02 gap)', () => {
  it('rejects a partial Form XObject overlap rather than deleting the whole form', async () => {
    // A Form XObject invocation is not a unit square like an image — its extent
    // is its own /BBox through its own /Matrix. Before this was handled, every
    // Form Do call was measured with the image-style unit-square approximation,
    // so it could silently delete a whole form even when the mark only touched
    // part of its visible content.
    const { StandardFonts } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([600, 800]);

    const formStream = doc.context.flateStream(
      'BT /F1 24 Tf 1 0 0 1 50 760 Tm (FORM SECRET TEXT) Tj ET',
      {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 400, 600, 800],
        Resources: doc.context.obj({ Font: { F1: font.ref } })
      }
    );
    const formRef = doc.context.register(formStream);
    (page.node.Resources() as PDFDict).set(
      PDFName.of('XObject'),
      doc.context.obj({ Fm0: formRef })
    );
    page.node.set(
      PDFName.of('Contents'),
      doc.context.register(doc.context.flateStream('q /Fm0 Do Q'))
    );
    const bytes = await doc.save({ useObjectStreams: false });
    const before = Uint8Array.from(bytes);

    // A small region inside the form's footprint (top band of the page).
    await expect(
      processWorkerImpl.applyRedactions(bytes, [
        { pageIndex: 0, x: 0.1, y: 0.1, width: 0.3, height: 0.1 }
      ])
    ).rejects.toThrow(/Form XObject/);
    expect(bytes).toEqual(before);
  });
});

describe('imageInventory: colour-space detection through indirection (CMP-01 gap)', () => {
  /** A 1x1 raw image stream carrying whatever /ColorSpace value the caller wants. */
  function addImage(doc: PDFDocument, colorSpace: unknown) {
    const page = doc.addPage([200, 200]);
    const img = doc.context.stream(new Uint8Array([0xfa, 0xce, 0xfe]), {
      Type: 'XObject',
      Subtype: 'Image',
      Width: 1,
      Height: 1,
      ColorSpace: colorSpace,
      BitsPerComponent: 8
    });
    (page.node.Resources() as PDFDict).set(
      PDFName.of('XObject'),
      doc.context.obj({ Im0: doc.context.register(img) })
    );
    return page;
  }

  it('detects Separation given directly as an array', async () => {
    const doc = await PDFDocument.create();
    addImage(doc, doc.context.obj(['Separation', 'Black', 'DeviceGray']));
    const bytes = await doc.save({ useObjectStreams: false });
    const [inventory] = await processWorkerImpl.imageInventory(bytes);
    expect(inventory.images[0].colorSpace).toBe('Separation');
  });

  it('detects Separation given as an indirect reference to the array', async () => {
    const doc = await PDFDocument.create();
    const csRef = doc.context.register(doc.context.obj(['Separation', 'Black', 'DeviceGray']));
    addImage(doc, csRef);
    const bytes = await doc.save({ useObjectStreams: false });
    const [inventory] = await processWorkerImpl.imageInventory(bytes);
    expect(inventory.images[0].colorSpace).toBe('Separation');
  });

  it('detects Separation given as a name resolved through /Resources/ColorSpace', async () => {
    const doc = await PDFDocument.create();
    const page = addImage(doc, PDFName.of('CS0'));
    const csRef = doc.context.register(doc.context.obj(['Separation', 'Black', 'DeviceGray']));
    (page.node.Resources() as PDFDict).set(
      PDFName.of('ColorSpace'),
      doc.context.obj({ CS0: csRef })
    );
    const bytes = await doc.save({ useObjectStreams: false });
    const [inventory] = await processWorkerImpl.imageInventory(bytes);
    expect(inventory.images[0].colorSpace).toBe('Separation');
  });

  it('still resolves an ordinary device colour space given by name', async () => {
    const doc = await PDFDocument.create();
    addImage(doc, PDFName.of('DeviceRGB'));
    const bytes = await doc.save({ useObjectStreams: false });
    const [inventory] = await processWorkerImpl.imageInventory(bytes);
    expect(inventory.images[0].colorSpace).toBe('DeviceRGB');
  });
});

describe('imageInventory: /Filter chains (CMP-03 skip detection)', () => {
  /** An image stream carrying whatever /Filter value the caller wants. */
  function addFiltered(doc: PDFDocument, filter: unknown) {
    const page = doc.addPage([200, 200]);
    const img = doc.context.stream(new Uint8Array([0xfa, 0xce, 0xfe]), {
      Type: 'XObject',
      Subtype: 'Image',
      Width: 800,
      Height: 800,
      ColorSpace: 'DeviceRGB',
      BitsPerComponent: 8
    });
    img.dict.set(PDFName.of('Filter'), filter as never);
    (page.node.Resources() as PDFDict).set(
      PDFName.of('XObject'),
      doc.context.obj({ Im0: doc.context.register(img) })
    );
    return page;
  }

  /*
   * `/Filter` is legally a chain, applied left to right, so the *last* entry is
   * the one that produced the image samples. Reading the head of the array
   * reported `[/ASCII85Decode /JPXDecode]` as `ASCII85Decode` — a name neither
   * skip list matches — and a JPX image behind an ASCII85 wrapper was routed to
   * the surgical re-encode instead of being skipped and reported.
   */
  it('reports the image-defining filter at the end of a chain, not the head', async () => {
    const doc = await PDFDocument.create();
    addFiltered(doc, doc.context.obj(['ASCII85Decode', 'JPXDecode']));
    const bytes = await doc.save({ useObjectStreams: false });
    const [inventory] = await processWorkerImpl.imageInventory(bytes);
    expect(inventory.images[0].filter).toBe('JPXDecode');
    expect(inventory.images[0].filters).toEqual(['ASCII85Decode', 'JPXDecode']);
  });

  it('still reports a single direct filter', async () => {
    const doc = await PDFDocument.create();
    addFiltered(doc, PDFName.of('DCTDecode'));
    const bytes = await doc.save({ useObjectStreams: false });
    const [inventory] = await processWorkerImpl.imageInventory(bytes);
    expect(inventory.images[0].filter).toBe('DCTDecode');
    expect(inventory.images[0].filters).toEqual(['DCTDecode']);
  });

  it('resolves an indirect /Filter array', async () => {
    const doc = await PDFDocument.create();
    const arrayRef = doc.context.register(doc.context.obj(['FlateDecode', 'JBIG2Decode']));
    addFiltered(doc, arrayRef);
    const bytes = await doc.save({ useObjectStreams: false });
    const [inventory] = await processWorkerImpl.imageInventory(bytes);
    expect(inventory.images[0].filter).toBe('JBIG2Decode');
  });
});

describe('imageInventory: images nested inside a Form XObject (CMP-01 gap)', () => {
  it('finds an image only reachable through a Form XObject, and rebuildCompressed can replace it', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);

    const img = doc.context.stream(new Uint8Array(300).fill(0x42), {
      Type: 'XObject',
      Subtype: 'Image',
      Width: 10,
      Height: 10,
      ColorSpace: 'DeviceGray',
      BitsPerComponent: 8
    });
    const imgRef = doc.context.register(img);

    // The image lives only in the Form's own Resources, never on the page.
    const formStream = doc.context.stream('q 200 0 0 200 0 0 cm /Im0 Do Q', {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 200, 200],
      Resources: doc.context.obj({ XObject: { Im0: imgRef } })
    });
    const formRef = doc.context.register(formStream);
    (page.node.Resources() as PDFDict).set(
      PDFName.of('XObject'),
      doc.context.obj({ Fm0: formRef })
    );
    page.node.set(
      PDFName.of('Contents'),
      doc.context.register(doc.context.flateStream('q /Fm0 Do Q'))
    );
    const bytes = await doc.save({ useObjectStreams: false });

    const [inventory] = await processWorkerImpl.imageInventory(bytes);
    expect(inventory.images).toHaveLength(1);
    expect(inventory.images[0].name).toBe('Im0');
    expect(inventory.images[0].objectNumber).toBe(imgRef.objectNumber);

    // A tiny hand-built JPEG (valid SOI/SOF0 header only, no real scan data) is
    // enough here: rebuildCompressed only needs to embed it and find where to
    // point the resource name, not decode it.
    const tinyJpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00,
      0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x02, 0x00, 0x02, 0x01,
      0x01, 0x11, 0x00, 0xff, 0xd9
    ]);
    const { bytes: rebuilt } = await processWorkerImpl.rebuildCompressed(
      bytes,
      {},
      { 0: { [imgRef.objectNumber]: { jpeg: tinyJpeg, width: 2, height: 2 } } }
    );

    const rebuiltDoc = await PDFDocument.load(rebuilt);
    const rebuiltForm = rebuiltDoc.context.lookup(
      (rebuiltDoc.getPage(0).node.Resources() as PDFDict)
        .lookupMaybe(PDFName.of('XObject'), PDFDict)
        ?.get(PDFName.of('Fm0')) as never
    );
    const rebuiltFormDict =
      rebuiltForm instanceof PDFDict ? rebuiltForm : (rebuiltForm as any).dict;
    const rebuiltImgRef = (rebuiltFormDict.get(PDFName.of('Resources')) as PDFDict)
      .lookupMaybe(PDFName.of('XObject'), PDFDict)
      ?.get(PDFName.of('Im0'));
    const rebuiltImg = rebuiltDoc.context.lookup(rebuiltImgRef as never);
    const rebuiltImgDict = rebuiltImg instanceof PDFDict ? rebuiltImg : (rebuiltImg as any).dict;
    expect(rebuiltImgDict.get(PDFName.of('Width'))?.toString()).toBe('2');
    expect(rebuiltImgDict.get(PDFName.of('Filter'))?.toString()).toBe('/DCTDecode');
  });
});

describe('watermark composition', () => {
  it('targets only the requested pages and honours the start number', async () => {
    const { textPdf } = await import('../e2e/fixtures');
    const source = await textPdf(4);
    const pages = Array.from({ length: 4 }, (_, sourceIndex) => ({
      key: `p${sourceIndex}`,
      sourceDocId: 'source',
      sourceIndex,
      rotation: 0
    }));

    const bytes = await processWorkerImpl.compose(
      pages,
      { source },
      [],
      {
        kind: 'text',
        text: 'Page {n} of {total}',
        imageScale: 0.35,
        position: 'bottom-center',
        opacity: 0.5,
        rotation: 0,
        fontSize: 18,
        color: '#111111',
        startAt: 10,
        pageRange: '2-3'
      },
      undefined,
      null,
      null,
      undefined,
      silentJob
    );

    const output = await PDFDocument.load(bytes);
    await expect(pageContentText(output, 0)).resolves.not.toContain('Page 10 of 4');
    await expect(pageContentText(output, 1)).resolves.toContain('Page 11 of 4');
    await expect(pageContentText(output, 2)).resolves.toContain('Page 12 of 4');
    await expect(pageContentText(output, 3)).resolves.not.toContain('Page 13 of 4');
  });

  it('refuses unsupported watermark characters instead of corrupting them', async () => {
    const { textPdf } = await import('../e2e/fixtures');
    const source = await textPdf(1);

    await expect(
      processWorkerImpl.compose(
        [{ key: 'p0', sourceDocId: 'source', sourceIndex: 0, rotation: 0 }],
        { source },
        [],
        {
          kind: 'text',
          text: '中文',
          imageScale: 0.35,
          position: 'center',
          opacity: 0.5,
          rotation: 0,
          fontSize: 18,
          color: '#111111',
          startAt: 1,
          pageRange: 'all'
        },
        undefined,
        null,
        null,
        undefined,
        silentJob
      )
    ).rejects.toMatchObject({ kind: 'UnsupportedFeature' });
  });
});

// A minimal 1x1 PNG, hand-picked so the test needs no canvas (vitest runs in
// the `node` environment, which has none): `createImageBitmap`/`document`
// aren't available here the way they are in the browser-side image picker.
const ONE_PIXEL_PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
);

function hasImageXObject(doc: PDFDocument, pageIndex: number): boolean {
  return hasXObjectOfSubtype(doc, pageIndex, '/Image');
}

/** OPS-18's CODE128 stamp embeds as a Form XObject (vector bars), not an Image one. */
function hasFormXObject(doc: PDFDocument, pageIndex: number): boolean {
  return hasXObjectOfSubtype(doc, pageIndex, '/Form');
}

function hasXObjectOfSubtype(doc: PDFDocument, pageIndex: number, subtype: string): boolean {
  const xobjects = doc
    .getPage(pageIndex)
    .node.Resources()
    ?.lookupMaybe(PDFName.of('XObject'), PDFDict);
  if (!xobjects) return false;
  return [...xobjects.entries()].some(([, ref]) => {
    const obj = doc.context.lookup(ref) as unknown as { dict?: PDFDict };
    return String(obj?.dict?.get(PDFName.of('Subtype'))) === subtype;
  });
}

describe('image watermark composition', () => {
  it('embeds the picked image only on the targeted pages', async () => {
    const { textPdf } = await import('../e2e/fixtures');
    const source = await textPdf(3);
    const pages = Array.from({ length: 3 }, (_, i) => ({
      key: `p${i}`,
      sourceDocId: 'source',
      sourceIndex: i,
      rotation: 0
    }));

    const bytes = await processWorkerImpl.compose(
      pages,
      { source },
      [],
      {
        kind: 'image',
        text: '',
        image: { bytes: ONE_PIXEL_PNG, format: 'png', width: 1, height: 1 },
        imageScale: 0.3,
        position: 'center',
        opacity: 0.5,
        rotation: 30,
        fontSize: 18,
        color: '#111111',
        startAt: 1,
        pageRange: '2'
      },
      undefined,
      null,
      null,
      undefined,
      silentJob
    );

    const output = await PDFDocument.load(bytes);
    expect(hasImageXObject(output, 0)).toBe(false);
    expect(hasImageXObject(output, 1)).toBe(true);
    expect(hasImageXObject(output, 2)).toBe(false);
  });

  /**
   * OPS-17's AC: position, opacity, and scale all have to land where the settings
   * say, not just "an image XObject exists somewhere". `drawImage` at rotation 0
   * emits its placement as three separate `cm` operators (translate, an identity
   * rotate, then scale) rather than one combined matrix — confirmed against
   * pdf-lib's own `drawImage` operation list — so the translate's e/f and the
   * scale's a/d are read directly off the real content stream instead of trusting
   * the settings were honoured.
   */
  it('places the image at the exact position, scale, and opacity the settings specify', async () => {
    const { textPdf } = await import('../e2e/fixtures');
    const source = await textPdf(1);
    const pages = [{ key: 'p0', sourceDocId: 'source', sourceIndex: 0, rotation: 0 }];

    const pageWidth = 595.28;
    const padding = 36;
    const imageScale = 0.3;
    const opacity = 0.42;
    // A 2:1 aspect ratio distinct from square, so a bug that swapped width/height
    // would show up as a wrong boxH rather than accidentally matching.
    const imageWidth = 40;
    const imageHeight = 20;
    const boxW = pageWidth * imageScale;
    const boxH = boxW * (imageHeight / imageWidth);
    // 'bottom-right': flush against the bottom-right margin, inset by the padding.
    const expectedX = pageWidth - boxW - padding;
    const expectedY = padding;

    const bytes = await processWorkerImpl.compose(
      pages,
      { source },
      [],
      {
        kind: 'image',
        text: '',
        image: { bytes: ONE_PIXEL_PNG, format: 'png', width: imageWidth, height: imageHeight },
        imageScale,
        position: 'bottom-right',
        opacity,
        rotation: 0,
        fontSize: 18,
        color: '#111111',
        startAt: 1,
        pageRange: 'all'
      },
      undefined,
      null,
      null,
      undefined,
      silentJob
    );

    const output = await PDFDocument.load(bytes);
    const page = output.getPage(0);

    const text = await pageContentText(output, 0);
    const cms = [
      ...text.matchAll(/(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) cm/g)
    ];
    // translate, rotate (identity), scale, skew (identity) — this fixture's own
    // content has no `cm` of its own, so all four belong to the image draw.
    expect(cms.length).toBe(4);
    const [, , , , translateE, translateF] = cms[0].slice(1).map(Number);
    expect(translateE).toBeCloseTo(expectedX, 1);
    expect(translateF).toBeCloseTo(expectedY, 1);
    const [scaleA, , , scaleD] = cms[2].slice(1).map(Number);
    expect(scaleA).toBeCloseTo(boxW, 1);
    expect(scaleD).toBeCloseTo(boxH, 1);

    const extGState = page.node.Resources()?.lookupMaybe(PDFName.of('ExtGState'), PDFDict);
    expect(extGState).toBeDefined();
    const entries = [...extGState!.entries()];
    expect(entries).toHaveLength(1);
    const gsDict = output.context.lookup(entries[0][1]) as unknown as PDFDict;
    const ca = gsDict.lookup(PDFName.of('ca'));
    expect((ca as PDFNumber).asNumber()).toBeCloseTo(opacity, 2);
  });
});

describe('barcode stamp composition (OPS-18)', () => {
  it('embeds the barcode image only when enabled with non-empty text', async () => {
    const { textPdf } = await import('../e2e/fixtures');
    const source = await textPdf(1);
    const pages = [{ key: 'p0', sourceDocId: 'source', sourceIndex: 0, rotation: 0 }];

    const bytes = await processWorkerImpl.compose(
      pages,
      { source },
      [],
      undefined,
      undefined,
      null,
      null,
      undefined,
      silentJob,
      { barcodeStamp: { kind: 'qr', text: 'DOC-0001', position: 'bottom-right', scale: 0.15 } }
    );

    const output = await PDFDocument.load(bytes);
    expect(hasImageXObject(output, 0)).toBe(true);
  });

  it('omits the stamp entirely when the text is blank', async () => {
    const { textPdf } = await import('../e2e/fixtures');
    const source = await textPdf(1);
    const pages = [{ key: 'p0', sourceDocId: 'source', sourceIndex: 0, rotation: 0 }];

    const bytes = await processWorkerImpl.compose(
      pages,
      { source },
      [],
      undefined,
      undefined,
      null,
      null,
      undefined,
      silentJob,
      { barcodeStamp: { kind: 'qr', text: '   ', position: 'bottom-right', scale: 0.15 } }
    );

    const output = await PDFDocument.load(bytes);
    expect(hasImageXObject(output, 0)).toBe(false);
  });

  it('stamps the same barcode on every page (no page-range targeting, like Bates)', async () => {
    const { textPdf } = await import('../e2e/fixtures');
    const source = await textPdf(3);
    const pages = Array.from({ length: 3 }, (_, i) => ({
      key: `p${i}`,
      sourceDocId: 'source',
      sourceIndex: i,
      rotation: 0
    }));

    const bytes = await processWorkerImpl.compose(
      pages,
      { source },
      [],
      undefined,
      undefined,
      null,
      null,
      undefined,
      silentJob,
      { barcodeStamp: { kind: 'code128', text: 'ABC123', position: 'top-left', scale: 0.2 } }
    );

    const output = await PDFDocument.load(bytes);
    // CODE128 draws as a Form XObject (vector bars), not an Image one — see
    // the doc comment on `encodeCode128Bars` for why a raster is not used here.
    for (let i = 0; i < 3; i++) expect(hasFormXObject(output, i)).toBe(true);
  });

  /**
   * CODE128 is drawn as vector bars via `drawPage` rather than `drawImage`
   * (see `encodeCode128Bars`'s doc comment: a raster round-trip measurably
   * broke real-decoder reads on a 1D barcode, which has no error correction
   * to absorb the antialiasing). This proves that path is honestly still
   * respecting the position/scale settings, the same way the image-watermark
   * and QR geometry tests do for their own draw calls.
   */
  it('places a CODE128 stamp at the exact grid position, with a minimum module width independent of scale', async () => {
    const { textPdf } = await import('../e2e/fixtures');
    const { encodeCode128Bars } = await import('../../src/core/barcode');
    const source = await textPdf(1);
    const pages = [{ key: 'p0', sourceDocId: 'source', sourceIndex: 0, rotation: 0 }];

    const pageWidth = 595.28;
    const padding = 24;
    // A real, moderate-length value (~189 CODE128 modules including
    // start/checksum/stop) at a tiny "Size" setting: at face value 5% of an
    // 8.27in page squeezes those modules to a fraction of a device pixel per
    // module at ordinary print/scan resolutions — undecodable in practice,
    // confirmed live before the width floor was added. `CODE128_QUIET_MODULES`
    // (10 each side) and `CODE128_MIN_MODULE_WIDTH_PT` (1pt) are mirrored here
    // from `process.worker.ts`, not re-derived, the same way this file's other
    // geometry tests hardcode `padding`/`pageWidth` against their own constants.
    const text = 'CODE128-XYZ-99';
    const scale = 0.05;
    const quiet = 10;
    const minModuleWidthPt = 1;
    const bars = encodeCode128Bars(text);
    const unitWidth = bars.length + quiet * 2;

    const bytes = await processWorkerImpl.compose(
      pages,
      { source },
      [],
      undefined,
      undefined,
      null,
      null,
      undefined,
      silentJob,
      { barcodeStamp: { kind: 'code128', text, position: 'bottom-right', scale } }
    );

    const output = await PDFDocument.load(bytes);
    expect(hasFormXObject(output, 0)).toBe(true);
    expect(hasImageXObject(output, 0)).toBe(false);

    // The scale-derived width (595.28 * 0.05 ≈ 29.8pt) is far below the safe
    // module-width floor (209pt) for this text, so the floor is what actually
    // governs — proving this matters, not merely restating the scale setting.
    const naiveBoxW = pageWidth * scale;
    const boxW = Math.max(naiveBoxW, unitWidth * minModuleWidthPt);
    expect(boxW).toBeGreaterThan(naiveBoxW * 5);
    const expectedX = pageWidth - boxW - padding;

    // `pageContentText` also walks into XObject content, which here would
    // include the embedded form's own per-bar `cm`+`re` fills — this stamp's
    // *placement* on the page is only in the page's own content stream, so
    // this reads that stream directly rather than the combined text.
    const page = output.getPage(0);
    const { decodeStream } = await import('../../src/core/pdf/interpreter');
    const contentsRef = page.node.Contents();
    const streamRefs = contentsRef instanceof PDFArray ? contentsRef.asArray() : [contentsRef];
    let pageText = '';
    for (const ref of streamRefs) {
      const streamObj = output.context.lookup(ref) as unknown as {
        getContents(): Uint8Array;
        dict?: PDFDict;
      };
      const isFlate = String(streamObj.dict?.get(PDFName.of('Filter'))) === '/FlateDecode';
      const raw = streamObj.getContents();
      pageText += new TextDecoder('latin1').decode(isFlate ? await decodeStream(raw) : raw);
    }

    const cms = [
      ...pageText.matchAll(/(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) cm/g)
    ];
    expect(cms.length).toBe(4);
    const [, , , , translateE, translateF] = cms[0].slice(1).map(Number);
    expect(translateE).toBeCloseTo(expectedX, 1);
    expect(translateF).toBeCloseTo(padding, 1);

    // `drawPage` scales *relative to the embedded form's own BBox*, unlike
    // `drawImage` (which scales relative to an implicit unit square) — reading
    // the form's real BBox back out of the PDF turns that ratio into the
    // absolute height actually rendered, with no production constant hardcoded.
    const xobjects = page.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict);
    const formRef = [...(xobjects?.entries() ?? [])].find(([, ref]) => {
      const obj = output.context.lookup(ref) as unknown as { dict?: PDFDict };
      return String(obj?.dict?.get(PDFName.of('Subtype'))) === '/Form';
    })?.[1];
    const formDict = (output.context.lookup(formRef) as unknown as { dict: PDFDict }).dict;
    const bbox = formDict.lookup(PDFName.of('BBox')) as unknown as {
      asArray(): { asNumber(): number }[];
    };
    const [, y0, , y1] = bbox.asArray().map(n => n.asNumber());
    const nativeHeight = y1 - y0;

    const [, , , scaleD] = cms[2].slice(1).map(Number);
    const renderedHeight = scaleD * nativeHeight;
    // With the module-width floor active, height rises with it (same aspect
    // ratio, wider box) and lands well clear of the 20pt height floor on its
    // own — this asserts it stays legible, not that this specific floor fired.
    expect(renderedHeight).toBeGreaterThanOrEqual(20 - 0.5); // CODE128_MIN_STAMP_HEIGHT_PT
  });

  it('never draws a CODE128 stamp wider than the page, even for a long value', async () => {
    const { textPdf } = await import('../e2e/fixtures');
    const source = await textPdf(1);
    const pages = [{ key: 'p0', sourceDocId: 'source', sourceIndex: 0, rotation: 0 }];

    const pageWidth = 595.28;
    // Long enough (585 CODE128 modules) that the safe module-width floor alone
    // — with no ceiling — would draw past the right edge of an A4/Letter page.
    const text = 'HTTPS://EXAMPLE.COM/DOCS/2026/CONTRACT-00483-REVISION-C-FINAL';

    const bytes = await processWorkerImpl.compose(
      pages,
      { source },
      [],
      undefined,
      undefined,
      null,
      null,
      undefined,
      silentJob,
      { barcodeStamp: { kind: 'code128', text, position: 'bottom-left', scale: 0.05 } }
    );

    const output = await PDFDocument.load(bytes);
    const page = output.getPage(0);

    const { decodeStream } = await import('../../src/core/pdf/interpreter');
    const contentsRef = page.node.Contents();
    const streamRefs = contentsRef instanceof PDFArray ? contentsRef.asArray() : [contentsRef];
    let pageText = '';
    for (const ref of streamRefs) {
      const streamObj = output.context.lookup(ref) as unknown as {
        getContents(): Uint8Array;
        dict?: PDFDict;
      };
      const isFlate = String(streamObj.dict?.get(PDFName.of('Filter'))) === '/FlateDecode';
      const raw = streamObj.getContents();
      pageText += new TextDecoder('latin1').decode(isFlate ? await decodeStream(raw) : raw);
    }

    const cms = [
      ...pageText.matchAll(/(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) cm/g)
    ];
    const [, , , , translateE] = cms[0].slice(1).map(Number);
    const [scaleA] = cms[2].slice(1).map(Number);

    expect(translateE).toBeGreaterThanOrEqual(0);
    expect(translateE + scaleA).toBeLessThanOrEqual(pageWidth + 0.5);
  });

  /**
   * Mirrors the image-watermark geometry test above: the drawn `cm` translate
   * and scale are read directly off the content stream rather than trusting
   * that "an image exists somewhere" means the position/size settings landed.
   */
  it('places the stamp at the exact grid position and scale', async () => {
    const { textPdf } = await import('../e2e/fixtures');
    const source = await textPdf(1);
    const pages = [{ key: 'p0', sourceDocId: 'source', sourceIndex: 0, rotation: 0 }];

    const pageWidth = 595.28;
    const padding = 24;
    const scale = 0.2;

    const bytes = await processWorkerImpl.compose(
      pages,
      { source },
      [],
      undefined,
      undefined,
      null,
      null,
      undefined,
      silentJob,
      { barcodeStamp: { kind: 'qr', text: 'GEOMETRY-CHECK', position: 'bottom-right', scale } }
    );

    const output = await PDFDocument.load(bytes);
    const boxW = pageWidth * scale;
    const expectedX = pageWidth - boxW - padding;
    const expectedY = padding;

    const text = await pageContentText(output, 0);
    const cms = [
      ...text.matchAll(/(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) cm/g)
    ];
    expect(cms.length).toBe(4);
    const [, , , , translateE, translateF] = cms[0].slice(1).map(Number);
    expect(translateE).toBeCloseTo(expectedX, 1);
    expect(translateF).toBeCloseTo(expectedY, 1);
    const [scaleA] = cms[2].slice(1).map(Number);
    expect(scaleA).toBeCloseTo(boxW, 1);
  });
});

describe('header and footer composition', () => {
  it('draws header and footer text, respecting a page range independent of the watermark', async () => {
    const { textPdf } = await import('../e2e/fixtures');
    const source = await textPdf(3);
    const pages = Array.from({ length: 3 }, (_, i) => ({
      key: `p${i}`,
      sourceDocId: 'source',
      sourceIndex: i,
      rotation: 0
    }));

    const bytes = await processWorkerImpl.compose(
      pages,
      { source },
      [],
      {
        kind: 'text',
        text: 'DRAFT',
        imageScale: 0.35,
        position: 'center',
        opacity: 0.5,
        rotation: 0,
        fontSize: 18,
        color: '#111111',
        startAt: 1,
        pageRange: '1' // watermark only on page 1
      },
      {
        headerText: 'ACME Corp',
        headerAlign: 'left',
        footerText: 'Page {n} of {total}',
        footerAlign: 'right',
        fontSize: 10,
        pageRange: '2-3' // header/footer only on pages 2-3, independent of the watermark
      },
      null,
      null,
      undefined,
      silentJob
    );

    const output = await PDFDocument.load(bytes);
    await expect(pageContentText(output, 0)).resolves.toContain('DRAFT');
    await expect(pageContentText(output, 0)).resolves.not.toContain('ACME Corp');

    await expect(pageContentText(output, 1)).resolves.not.toContain('DRAFT');
    await expect(pageContentText(output, 1)).resolves.toContain('ACME Corp');
    await expect(pageContentText(output, 1)).resolves.toContain('Page 2 of 3');

    await expect(pageContentText(output, 2)).resolves.toContain('ACME Corp');
    await expect(pageContentText(output, 2)).resolves.toContain('Page 3 of 3');
  });

  it('refuses unsupported header/footer characters instead of corrupting them', async () => {
    const { textPdf } = await import('../e2e/fixtures');
    const source = await textPdf(1);

    await expect(
      processWorkerImpl.compose(
        [{ key: 'p0', sourceDocId: 'source', sourceIndex: 0, rotation: 0 }],
        { source },
        [],
        undefined,
        {
          headerText: '中文',
          headerAlign: 'center',
          footerText: '',
          footerAlign: 'center',
          fontSize: 10,
          pageRange: 'all'
        },
        null,
        null,
        undefined,
        silentJob
      )
    ).rejects.toMatchObject({ kind: 'UnsupportedFeature' });
  });
});

describe('applyNUp layout', () => {
  it('creates a 2-up grid from a simple document', async () => {
    const { textPdf } = await import('../e2e/fixtures');
    const bytes = await textPdf(4); // 4 page document

    // Create sources map
    const sources = { doc1: bytes };
    const pages = [
      { key: 'p1', sourceDocId: 'doc1', sourceIndex: 0, rotation: 0 },
      { key: 'p2', sourceDocId: 'doc1', sourceIndex: 1, rotation: 0 },
      { key: 'p3', sourceDocId: 'doc1', sourceIndex: 2, rotation: 0 },
      { key: 'p4', sourceDocId: 'doc1', sourceIndex: 3, rotation: 0 }
    ];

    const composedBytes = await processWorkerImpl.compose(
      pages,
      sources,
      [],
      null,
      undefined,
      null,
      { layout: '2-up', margin: 10, gutter: 10, drawBorders: true },
      undefined,
      silentJob
    );

    const doc = await PDFDocument.load(composedBytes);

    // 4 pages placed 2-up should result in 2 sheets
    expect(doc.getPageCount()).toBe(2);

    // Check orientation of the first sheet (should be standard PDF units)
    const page = doc.getPage(0);
    expect(page.getWidth()).toBeGreaterThan(0);
    expect(page.getHeight()).toBeGreaterThan(0);
  });

  it('creates a booklet layout from an 8 page document', async () => {
    const { textPdf } = await import('../e2e/fixtures');
    const bytes = await textPdf(8);

    const sources = { doc1: bytes };
    const pages = Array.from({ length: 8 }, (_, i) => ({
      key: `p${i}`,
      sourceDocId: 'doc1',
      sourceIndex: i,
      rotation: 0
    }));

    const composedBytes = await processWorkerImpl.compose(
      pages,
      sources,
      [],
      null,
      undefined,
      null,
      { layout: 'booklet', margin: 0, gutter: 0, drawBorders: false },
      undefined,
      silentJob
    );

    const doc = await PDFDocument.load(composedBytes);

    // 8 pages placed in booklet (4 pages per sheet front/back equivalent) -> 4 logical sheets (as pages in PDF)
    // Wait, applyNUp maps booklet into a saddle-stitch order onto 2-up spreads.
    // 8 pages = 8 / 2 pages per sheet = 4 sheets.
    expect(doc.getPageCount()).toBe(4);

    // Check orientation: booklet should rotate to landscape
    const page = doc.getPage(0);
    expect(page.getWidth()).toBeGreaterThan(page.getHeight());
  });

  it('reproduces a rotated source page instead of embedding it sideways', async () => {
    // embedPage's XObject carries only the content stream + CropBox — pdf-lib never
    // bakes /Rotate into it. A page stored portrait but displayed landscape via
    // /Rotate 90 previously landed in its N-up cell unrotated.
    const { textPdf } = await import('../e2e/fixtures');
    const bytes = await textPdf(1);
    const rotatedDoc = await PDFDocument.load(bytes);
    rotatedDoc.getPage(0).setRotation(degrees(90));
    const rotatedBytes = await rotatedDoc.save();

    const composedBytes = await processWorkerImpl.compose(
      [{ key: 'p1', sourceDocId: 'doc1', sourceIndex: 0, rotation: 0 }],
      { doc1: rotatedBytes },
      [],
      null,
      undefined,
      null,
      { layout: '2-up', margin: 0, gutter: 0, drawBorders: false },
      undefined,
      silentJob
    );

    const doc = await PDFDocument.load(composedBytes);
    const page = doc.getPage(0);
    const contents = page.node.Contents();
    const streams =
      contents instanceof PDFArray
        ? contents.asArray().map(ref => doc.context.lookup(ref))
        : [contents];
    const { decodeStream } = await import('../../src/core/pdf/interpreter');
    let raw = '';
    for (const stream of streams as any[]) {
      const bytesOut: Uint8Array = stream.getContents();
      const isFlate = String(stream.dict?.get(PDFName.of('Filter'))) === '/FlateDecode';
      raw += new TextDecoder('latin1').decode(isFlate ? await decodeStream(bytesOut) : bytesOut);
    }

    // Every `cm` matrix drawPage emits for an unrotated placement is either a pure
    // translation or a pure (non-negative) scale — `a`/`d` stay positive and `b`/`c`
    // stay zero. A 90-degree rotation must produce at least one matrix where the
    // off-diagonal terms dominate instead.
    const matrices = [
      ...raw.matchAll(/(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) cm/g)
    ].map(m => m.slice(1, 5).map(Number));
    const hasRotation = matrices.some(
      ([a, b, c, d]) =>
        Math.abs(b) > 0.9 && Math.abs(c) > 0.9 && Math.abs(a) < 0.1 && Math.abs(d) < 0.1
    );
    expect(hasRotation).toBe(true);
  });
});

/**
 * SGN-02 — stamp placement on a rotated page.
 *
 * `page.getSize()` always returns the raw, unrotated MediaBox; pdf.js's viewport
 * (what the sign UI places stamps against) swaps width/height for a 90/270-degree
 * `/Rotate`. Treating those as the same frame put every stamp at a transposed,
 * wrong-sized position on a rotated page.
 */
describe('stamp placement on a rotated page (SGN-02)', () => {
  it('maps a display-space stamp back into the unrotated content space', async () => {
    const { textPdf } = await import('../e2e/fixtures');
    const bytes = await textPdf(1);
    const rotatedDoc = await PDFDocument.load(bytes);
    const { width: rawWidth, height: rawHeight } = rotatedDoc.getPage(0).getSize();
    rotatedDoc.getPage(0).setRotation(degrees(90));
    const rotatedBytes = await rotatedDoc.save();

    const composedBytes = await processWorkerImpl.compose(
      [{ key: 'p1', sourceDocId: 'doc1', sourceIndex: 0, rotation: 0 }],
      { doc1: rotatedBytes },
      [
        {
          pageKey: 'p1',
          type: 'text',
          x: 0,
          y: 0,
          width: 0.2,
          height: 0.1,
          text: 'HI',
          rotation: 0
        }
      ],
      null,
      undefined,
      null,
      null,
      undefined,
      silentJob
    );

    const doc = await PDFDocument.load(composedBytes);
    const page = doc.getPage(0);
    // The composed page keeps the source's /Rotate — only the content position
    // changes, so this is still the raw, unrotated MediaBox.
    expect(page.getSize()).toEqual({ width: rawWidth, height: rawHeight });

    const text = await pageContentText(doc, 0);
    expect(text).toContain('HI');

    const contents = page.node.Contents();
    const streams =
      contents instanceof PDFArray
        ? contents.asArray().map(ref => doc.context.lookup(ref))
        : [contents];
    const { decodeStream } = await import('../../src/core/pdf/interpreter');
    let raw = '';
    for (const stream of streams as any[]) {
      const bytesOut: Uint8Array = stream.getContents();
      const isFlate = String(stream.dict?.get(PDFName.of('Filter'))) === '/FlateDecode';
      raw += new TextDecoder('latin1').decode(isFlate ? await decodeStream(bytesOut) : bytesOut);
    }

    // `Tm` carries both the text's rotation and its position: cos(90)=0, sin(90)=1
    // for the content-space rotation that cancels the page's own 90-degree
    // /Rotate, and a content-space origin computed from the display-space stamp
    // box mapped through the inverse of that rotation.
    const matches = [
      ...raw.matchAll(/(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) Tm/g)
    ];
    expect(matches.length).toBeGreaterThan(0);
    const [a, b, c, d, e, f] = matches[matches.length - 1].slice(1).map(Number);
    expect(a).toBeCloseTo(0, 1);
    expect(b).toBeCloseTo(1, 1);
    expect(c).toBeCloseTo(-1, 1);
    expect(d).toBeCloseTo(0, 1);
    expect(e).toBeCloseTo(43.1, 0);
    expect(f).toBeCloseTo(0, 0);
  });
});

/**
 * SGN-03 — the AcroForm round-trip.
 *
 * The failure this guards is silent data loss, not a crash: the UI showed values
 * as filled, the export "succeeded", and the saved bytes carried an empty form.
 * Every assertion here is against re-parsed output bytes, because that is the only
 * thing an external viewer will ever see.
 */
describe('AcroForm fill survives compose (SGN-03)', () => {
  async function composeOnePage(bytes: Uint8Array, copies = 1) {
    const pages = Array.from({ length: copies }, (_, i) => ({
      key: `p${i}`,
      sourceDocId: 'doc1',
      sourceIndex: 0,
      rotation: 0
    }));
    return processWorkerImpl.compose(
      pages,
      { doc1: bytes },
      [],
      null,
      undefined,
      null,
      null,
      undefined,
      silentJob
    );
  }

  it('keeps /AcroForm and its fields through a compose', async () => {
    const { acroformPdf } = await import('../e2e/fixtures');
    const composed = await composeOnePage(await acroformPdf());

    const doc = await PDFDocument.load(composed);
    expect(doc.getPageCount()).toBe(1);
    const names = doc
      .getForm()
      .getFields()
      .map(f => f.getName())
      .sort();
    expect(names).toEqual(['agreed', 'name.first']);
  });

  it('round-trips a filled value into the exported bytes', async () => {
    const { acroformPdf } = await import('../e2e/fixtures');
    // The real export order: compose first, then fill the composed document.
    const composed = await composeOnePage(await acroformPdf());
    const filled = await processWorkerImpl.fillFormFields(
      composed,
      { 'name.first': 'Ada Lovelace', agreed: false },
      false
    );

    const doc = await PDFDocument.load(filled);
    const form = doc.getForm();
    expect(form.getTextField('name.first').getText()).toBe('Ada Lovelace');
    expect(form.getCheckBox('agreed').isChecked()).toBe(false);

    // /V read straight off the field dict, not through pdf-lib's accessor, so a
    // viewer reading the raw dictionary sees the same thing.
    const field = form.getTextField('name.first').acroField.dict;
    expect(textOfPdfValue(field.get(PDFName.of('V')))).toBe('Ada Lovelace');
  });

  it('flattens with the value drawn into the page content', async () => {
    const { acroformPdf } = await import('../e2e/fixtures');
    const composed = await composeOnePage(await acroformPdf());
    const filled = await processWorkerImpl.fillFormFields(
      composed,
      { 'name.first': 'Grace Hopper', agreed: true },
      true
    );

    const doc = await PDFDocument.load(filled);
    expect(doc.getPageCount()).toBe(1);
    // Flatten removes the interactive form entirely.
    expect(doc.getForm().getFields()).toHaveLength(0);
    // The text now lives in the page's content stream, so it must be there after
    // decompression — an assertion on the raw bytes would pass on an uncompressed
    // stream and fail on a compressed one for no meaningful reason.
    expect(await pageContentText(doc, 0)).toContain('Grace Hopper');
  });

  it('merges one field appearing on two composed pages into a single field', async () => {
    const { acroformPdf } = await import('../e2e/fixtures');
    const composed = await composeOnePage(await acroformPdf(), 2);

    const doc = await PDFDocument.load(composed);
    expect(doc.getPageCount()).toBe(2);
    const names = doc
      .getForm()
      .getFields()
      .map(f => f.getName())
      .sort();
    // Two copies of the page, still two fields — not four, and no duplicate names.
    expect(names).toEqual(['agreed', 'name.first']);

    // And filling by name still reaches it.
    const filled = await processWorkerImpl.fillFormFields(
      composed,
      { 'name.first': 'Katherine Johnson' },
      false
    );
    const out = await PDFDocument.load(filled);
    expect(out.getForm().getTextField('name.first').getText()).toBe('Katherine Johnson');

    // One field with two widgets means the value must appear on *both* pages once
    // flattened — the merge is only correct if the second page is not left blank.
    const flat = await processWorkerImpl.fillFormFields(
      composed,
      { 'name.first': 'Katherine Johnson' },
      true
    );
    const flatDoc = await PDFDocument.load(flat);
    expect(await pageContentText(flatDoc, 0)).toContain('Katherine Johnson');
    expect(await pageContentText(flatDoc, 1)).toContain('Katherine Johnson');
  });

  it('refuses rather than silently dropping a value for an unknown field', async () => {
    const { acroformPdf } = await import('../e2e/fixtures');
    const composed = await composeOnePage(await acroformPdf());
    await expect(
      processWorkerImpl.fillFormFields(composed, { 'no.such.field': 'x' }, false)
    ).rejects.toThrow(/no form field named/i);
  });
});

describe('XFA is detected and never partially processed (SGN-03)', () => {
  async function xfaBytes(): Promise<Uint8Array> {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const path = fileURLToPath(new URL('../fixtures/xfa.pdf', import.meta.url));
    return new Uint8Array(await readFile(path));
  }

  it('detects the XFA fixture from raw bytes', async () => {
    const { hasXfaMarker } = await import('../../src/core/pdf/xfa');
    expect(hasXfaMarker(await xfaBytes())).toBe(true);
  });

  it('does not fire on a plain AcroForm', async () => {
    const { hasXfaMarker } = await import('../../src/core/pdf/xfa');
    const { acroformPdf } = await import('../e2e/fixtures');
    expect(hasXfaMarker(await acroformPdf())).toBe(false);
  });

  it('does not mistake a longer name such as /XFAFoo for the /XFA key', async () => {
    const { hasXfaMarker } = await import('../../src/core/pdf/xfa');
    expect(hasXfaMarker(new TextEncoder().encode('<< /XFAFoo 1 >>'))).toBe(false);
    expect(hasXfaMarker(new TextEncoder().encode('<< /XFA [ 1 0 R ] >>'))).toBe(true);
  });

  it('reports isXfa and enumerates no fillable fields', async () => {
    const bytes = await xfaBytes();
    expect((await processWorkerImpl.inspect(bytes)).isXfa).toBe(true);
    const fields = await processWorkerImpl.getFormFields(bytes);
    expect(fields).toEqual({ isXfa: true, fields: [] });
  });

  it('produces no output bytes at all when asked to fill', async () => {
    const bytes = await xfaBytes();
    const before = Uint8Array.from(bytes);
    await expect(
      processWorkerImpl.fillFormFields(bytes, { anything: 'value' }, true)
    ).rejects.toThrow(/XFA form/);
    // The input buffer was not mutated in place either.
    expect(bytes).toEqual(before);
  });
});

describe('CMP-03: resamples SMask when base image is downscaled', () => {
  /*
   * The classifier refuses these constructs, and `rebuildCompressed` is meant to
   * be the second lock on the same door: if a caller ever hands it one anyway,
   * the original stream must survive untouched rather than be swapped for a
   * JPEG that cannot carry the construct.
   */
  describe('rebuildCompressed refuses what the surgical path must never touch', () => {
    const TINY_JPEG = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00,
      0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x02, 0x00, 0x02, 0x01,
      0x01, 0x11, 0x00, 0xff, 0xd9
    ]);

    /** A page carrying one image whose dict gets `extra` merged in. */
    async function docWithImage(extra: (doc: PDFDocument) => Record<string, unknown>) {
      const doc = await PDFDocument.create();
      const page = doc.addPage([200, 200]);
      const img = doc.context.stream(new Uint8Array(64).fill(0x7f), {
        Type: 'XObject',
        Subtype: 'Image',
        Width: 8,
        Height: 8,
        ColorSpace: 'DeviceRGB',
        BitsPerComponent: 8
      });
      for (const [key, value] of Object.entries(extra(doc))) {
        img.dict.set(PDFName.of(key), value as never);
      }
      const ref = doc.context.register(img);
      (page.node.Resources() as PDFDict).set(PDFName.of('XObject'), doc.context.obj({ Im0: ref }));
      page.node.set(
        PDFName.of('Contents'),
        doc.context.register(doc.context.flateStream('q 200 0 0 200 0 0 cm /Im0 Do Q'))
      );
      return { bytes: await doc.save({ useObjectStreams: false }), objectNumber: ref.objectNumber };
    }

    async function widthOfIm0(bytes: Uint8Array): Promise<string | undefined> {
      const { PDFStream } = await import('pdf-lib');
      const doc = await PDFDocument.load(bytes);
      const xobjs = doc.getPage(0).node.Resources()?.lookup(PDFName.of('XObject'), PDFDict);
      const stream = doc.context.lookup(xobjs!.get(PDFName.of('Im0')), PDFStream);
      return stream.dict.get(PDFName.of('Width'))?.toString();
    }

    /*
     * A colour-key `/Mask` is an array of sample ranges, and the ordinary way to
     * write one is indirectly (`/Mask 12 0 R`). The guard tested only the
     * unresolved value, so an indirect array read as a plain `PDFRef` and was
     * copied verbatim onto a downscaled, lossily re-encoded JPEG whose samples
     * can no longer fall in those ranges — the transparency silently changes.
     */
    it('leaves an image alone when /Mask is an indirect colour-key array', async () => {
      const { bytes, objectNumber } = await docWithImage(doc => ({
        Mask: doc.context.register(doc.context.obj([0, 10, 0, 10, 0, 10]))
      }));
      const result = await processWorkerImpl.rebuildCompressed(
        bytes,
        [],
        { 0: { [objectNumber]: { jpeg: TINY_JPEG, width: 2, height: 2 } } },
        silentJob
      );
      // Still the original 8x8 stream, not the 2x2 replacement.
      expect(await widthOfIm0(result.keptOriginal ? bytes : result.bytes)).toBe('8');
    });

    it('leaves an image alone when its /SMask carries /Matte', async () => {
      const { bytes, objectNumber } = await docWithImage(doc => {
        const smask = doc.context.stream(new Uint8Array(64).fill(0xff), {
          Type: 'XObject',
          Subtype: 'Image',
          Width: 8,
          Height: 8,
          ColorSpace: 'DeviceGray',
          BitsPerComponent: 8,
          Matte: [0, 0, 0]
        });
        return { SMask: doc.context.register(smask) };
      });
      const result = await processWorkerImpl.rebuildCompressed(
        bytes,
        [],
        { 0: { [objectNumber]: { jpeg: TINY_JPEG, width: 2, height: 2 } } },
        silentJob
      );
      expect(await widthOfIm0(result.keptOriginal ? bytes : result.bytes)).toBe('8');
    });

    it('leaves a stencil /ImageMask alone', async () => {
      const { PDFBool } = await import('pdf-lib');
      const { bytes, objectNumber } = await docWithImage(() => ({
        ImageMask: PDFBool.True,
        BitsPerComponent: PDFNumber.of(1)
      }));
      const result = await processWorkerImpl.rebuildCompressed(
        bytes,
        [],
        { 0: { [objectNumber]: { jpeg: TINY_JPEG, width: 2, height: 2 } } },
        silentJob
      );
      expect(await widthOfIm0(result.keptOriginal ? bytes : result.bytes)).toBe('8');
    });
  });

  it('rebuildCompressed creates a new SMask of the requested dimensions', async () => {
    const fs = await import('node:fs');
    const { PDFDocument, PDFName, PDFDict, PDFStream, PDFRef } = await import('pdf-lib');
    let bytes: Uint8Array;
    if (fs.existsSync('tests/fixtures/oversized-mask.pdf')) {
      bytes = fs.readFileSync('tests/fixtures/oversized-mask.pdf');
    } else {
      const { oversizedMaskPdf } = await import('../e2e/fixtures');
      bytes = await oversizedMaskPdf();
      fs.writeFileSync('tests/fixtures/oversized-mask.pdf', bytes);
    }

    // `replacedImages` is keyed by PDF object number, not resource name — look
    // up the object number `/ImStrip` currently points at on page 0.
    const sourceDoc = await PDFDocument.load(bytes);
    const sourceXObjs = sourceDoc
      .getPage(0)
      .node.Resources()
      ?.lookup(PDFName.of('XObject'), PDFDict);
    const imStripSourceRef = sourceXObjs!.get(PDFName.of('ImStrip'));
    if (!(imStripSourceRef instanceof PDFRef)) throw new Error('expected a PDFRef');

    // Supply a mock downscaled base image and downscaled mask bytes.
    const replacedImages = {
      '0': {
        [imStripSourceRef.objectNumber]: {
          jpeg: new Uint8Array(fs.readFileSync('tests/fixtures/tiny.jpg')),
          width: 10,
          height: 210,
          maskBytes: new Uint8Array(10 * 210) // downscaled from 100 x 2100
        }
      }
    };

    const result = await processWorkerImpl.rebuildCompressed(bytes, [], replacedImages, silentJob);
    expect(result.keptOriginal).toBe(false);

    const doc = await PDFDocument.load(result.bytes);
    const page = doc.getPage(0);
    const xobjs = page.node.Resources()?.lookup(PDFName.of('XObject'), PDFDict);
    expect(xobjs).toBeDefined();

    const imStripRef = xobjs!.get(PDFName.of('ImStrip'));
    const imgStream = doc.context.lookup(imStripRef, PDFStream);
    const smaskRef = imgStream.dict.get(PDFName.of('SMask'));
    const smaskStream = doc.context.lookup(smaskRef, PDFStream);

    expect(smaskStream.dict.get(PDFName.of('Width'))?.toString()).toBe('10');
    expect(smaskStream.dict.get(PDFName.of('Height'))?.toString()).toBe('210');
  });

  it('never inflates a mask smaller than the new target — that only grows the file', async () => {
    const fs = await import('node:fs');
    const { PDFDocument, PDFName, PDFDict, PDFStream, PDFRef } = await import('pdf-lib');

    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);

    // A 2x2 soft mask — much smaller than the base image's new (encoded) target
    // of 10x210 below. Resampling this up would only add bytes for no visual
    // gain, since a PDF viewer stretches an SMask to the base image's box at
    // render time regardless of the mask's own resolution.
    const smaskStream = doc.context.flateStream(new Uint8Array([255, 255, 255, 255]), {
      Type: 'XObject',
      Subtype: 'Image',
      Width: 2,
      Height: 2,
      ColorSpace: 'DeviceGray',
      BitsPerComponent: 8
    });
    const smaskRef = doc.context.register(smaskStream);

    const baseStream = doc.context.stream(new Uint8Array([0, 0, 0]), {
      Type: 'XObject',
      Subtype: 'Image',
      Width: 4,
      Height: 4,
      ColorSpace: 'DeviceRGB',
      BitsPerComponent: 8,
      SMask: smaskRef
    });
    const baseRef = doc.context.register(baseStream);
    (page.node.Resources() as PDFDict).set(
      PDFName.of('XObject'),
      doc.context.obj({ Im0: baseRef })
    );
    page.node.set(
      PDFName.of('Contents'),
      doc.context.register(doc.context.flateStream('q 200 0 0 200 0 0 cm /Im0 Do Q'))
    );
    const bytes = await doc.save({ useObjectStreams: false });

    const jpeg = new Uint8Array(fs.readFileSync('tests/fixtures/tiny.jpg')); // 10x210
    const result = await processWorkerImpl.rebuildCompressed(
      bytes,
      [],
      {
        0: {
          [baseRef.objectNumber]: {
            jpeg,
            width: 10,
            height: 210,
            maskBytes: new Uint8Array(10 * 210)
          }
        }
      },
      silentJob
    );

    const outDoc = await PDFDocument.load(result.bytes);
    const xobjs = outDoc.getPage(0).node.Resources()?.lookup(PDFName.of('XObject'), PDFDict);
    const newBaseRef = xobjs!.get(PDFName.of('Im0'));
    const newBase = outDoc.context.lookup(newBaseRef, PDFStream);
    const newSmaskRef = newBase.dict.get(PDFName.of('SMask'));

    expect(newSmaskRef).toBeInstanceOf(PDFRef);
    const newSmask = outDoc.context.lookup(newSmaskRef as InstanceType<typeof PDFRef>, PDFStream);
    // Still the original 2x2 mask, byte for byte — not resampled up to 10x210.
    expect(newSmask.dict.get(PDFName.of('Width'))?.toString()).toBe('2');
    expect(newSmask.dict.get(PDFName.of('Height'))?.toString()).toBe('2');
  });

  it('carries /OC and /StructParent over onto the re-encoded image', async () => {
    const fs = await import('node:fs');
    const { PDFDocument, PDFName, PDFDict, PDFStream } = await import('pdf-lib');

    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);

    // A minimal optional-content group — the image is on a hideable layer.
    const ocg = doc.context.obj({ Type: 'OCG', Name: 'Watermark layer' });
    const ocgRef = doc.context.register(ocg);
    doc.catalog.set(
      PDFName.of('OCProperties'),
      doc.context.obj({ OCGs: [ocgRef], D: { ON: [ocgRef] } })
    );

    const baseStream = doc.context.stream(new Uint8Array([0, 0, 0]), {
      Type: 'XObject',
      Subtype: 'Image',
      Width: 4,
      Height: 4,
      ColorSpace: 'DeviceRGB',
      BitsPerComponent: 8,
      OC: ocgRef,
      StructParent: 7
    });
    const baseRef = doc.context.register(baseStream);
    (page.node.Resources() as PDFDict).set(
      PDFName.of('XObject'),
      doc.context.obj({ Im0: baseRef })
    );
    page.node.set(
      PDFName.of('Contents'),
      doc.context.register(doc.context.flateStream('q 200 0 0 200 0 0 cm /Im0 Do Q'))
    );
    const bytes = await doc.save({ useObjectStreams: false });

    const jpeg = new Uint8Array(fs.readFileSync('tests/fixtures/tiny.jpg'));
    const result = await processWorkerImpl.rebuildCompressed(
      bytes,
      [],
      { 0: { Im0: { jpeg, width: 10, height: 210 } } },
      silentJob
    );

    const outDoc = await PDFDocument.load(result.bytes);
    const xobjs = outDoc.getPage(0).node.Resources()?.lookup(PDFName.of('XObject'), PDFDict);
    const newBase = outDoc.context.lookup(xobjs!.get(PDFName.of('Im0')), PDFStream);

    expect(newBase.dict.get(PDFName.of('OC'))).toBeDefined();
    expect((newBase.dict.get(PDFName.of('StructParent')) as PDFNumber).asNumber()).toBe(7);
  });
});

describe('imagesToPdf options (CNV-01)', () => {
  it('respects a4 page size and margins', async () => {
    const fs = await import('node:fs');
    const { PDFDocument } = await import('pdf-lib');
    const jpeg = new Uint8Array(fs.readFileSync('tests/fixtures/tiny.jpg')); // 10x210

    const bytes = await processWorkerImpl.imagesToPdf([jpeg], {
      pageSize: 'a4',
      orientation: 'portrait',
      margin: 20
    });

    const doc = await PDFDocument.load(bytes);
    const page = doc.getPage(0);

    // A4 Portrait
    expect(page.getWidth()).toBeCloseTo(595.28, 1);
    expect(page.getHeight()).toBeCloseTo(841.89, 1);
  });

  it('respects letter landscape orientation', async () => {
    const fs = await import('node:fs');
    const { PDFDocument } = await import('pdf-lib');
    const jpeg = new Uint8Array(fs.readFileSync('tests/fixtures/tiny.jpg'));

    const bytes = await processWorkerImpl.imagesToPdf([jpeg], {
      pageSize: 'letter',
      orientation: 'landscape',
      margin: 0
    });

    const doc = await PDFDocument.load(bytes);
    const page = doc.getPage(0);

    // Letter Landscape
    expect(page.getWidth()).toBe(792);
    expect(page.getHeight()).toBe(612);
  });
});

/**
 * SGN-05 — flatten form and annotations.
 *
 * Asserted against the output bytes' dictionaries rather than against the
 * report the worker returns: "no annotation dictionaries remaining" is a claim
 * about what a viewer opens, so the test re-parses the saved PDF and looks.
 */
describe('flattenDocument (SGN-05)', () => {
  async function composeOnePage(bytes: Uint8Array) {
    return processWorkerImpl.compose(
      [{ key: 'p0', sourceDocId: 'doc1', sourceIndex: 0, rotation: 0 }],
      { doc1: bytes },
      [],
      null,
      undefined,
      null,
      null,
      undefined,
      silentJob
    );
  }

  it('removes /AcroForm entirely and bakes the filled value into the page', async () => {
    const { acroformPdf } = await import('../e2e/fixtures');
    // The real commit order: compose, fill without flattening, then finalize.
    const composed = await composeOnePage(await acroformPdf());
    const filled = await processWorkerImpl.fillFormFields(
      composed,
      { 'name.first': 'Grace Hopper', agreed: true },
      false
    );
    const result = await processWorkerImpl.flattenDocument(filled);
    expect(result.fields).toBe(2);

    const doc = await PDFDocument.load(result.bytes);
    expect(doc.getPageCount()).toBe(1);
    // Not "an /AcroForm with an empty /Fields" — no /AcroForm key at all.
    expect(doc.catalog.get(PDFName.of('AcroForm'))).toBeUndefined();
    expect(doc.getForm().getFields()).toHaveLength(0);
    // And no widget annotations left behind on the page.
    expect(doc.getPage(0).node.Annots()).toBeUndefined();
    // The value is still findable as text, one XObject down from the page stream.
    expect(await pageContentText(doc, 0)).toContain('Grace Hopper');
  });

  it('bakes annotation appearances into the page and removes every /Annots', async () => {
    const { annotatedPdf, ANNOTATION_TEXT } = await import('../e2e/fixtures');
    const composed = await composeOnePage(await annotatedPdf());

    // Precondition: the annotations really do survive a compose, which is why
    // form.flatten() alone was never enough.
    const before = await PDFDocument.load(composed);
    expect(before.getPage(0).node.Annots()?.size()).toBe(4);

    const result = await processWorkerImpl.flattenDocument(composed);
    expect(result.fields).toBe(0);
    // FreeText and Square carry appearances; Link has none and the /Text is Hidden.
    expect(result.annotationsBaked).toBe(2);
    expect(result.annotationsDropped).toBe(2);

    const doc = await PDFDocument.load(result.bytes);
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getPage(0).node.Annots()).toBeUndefined();

    const content = await pageContentText(doc, 0);
    // Baked in, so text extraction finds it.
    expect(content).toContain(ANNOTATION_TEXT);
    // The page's own text is untouched.
    expect(content).toContain('Stapler fixture page 1');
    // A hidden annotation draws nothing on screen, so it must not appear now.
    expect(content).not.toContain('SHOULD NOT APPEAR');
  });

  it('fits each appearance to its /Rect through the stream’s own /Matrix', async () => {
    const { annotatedPdf } = await import('../e2e/fixtures');
    const result = await processWorkerImpl.flattenDocument(await annotatedPdf());
    const doc = await PDFDocument.load(result.bytes);
    const content = await pageContentText(doc, 0);

    // /FreeText: BBox 100x10 with /Matrix [2 0 0 2 0 0] already covers the
    // 200x20 /Rect, so the fitting transform is a pure translate. A flatten that
    // ignored /Matrix would emit "2 0 0 2 …" and draw it at double size.
    expect(content).toContain('1 0 0 1 50 700 cm');
    // /Square: BBox 100x100 into a 50x50 /Rect — fitted by halving.
    expect(content).toContain('0.5 0 0 0.5 300 400 cm');
  });

  it('refuses an XFA form rather than half-flattening it', async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const bytes = new Uint8Array(
      await readFile(fileURLToPath(new URL('../fixtures/xfa.pdf', import.meta.url)))
    );
    const before = Uint8Array.from(bytes);
    await expect(processWorkerImpl.flattenDocument(bytes)).rejects.toThrow(/XFA form/);
    expect(bytes).toEqual(before);
  });

  it('leaves a document with neither fields nor annotations byte-identical in structure', async () => {
    const { textPdf } = await import('../e2e/fixtures');
    const plain = await textPdf(3);
    const result = await processWorkerImpl.flattenDocument(plain);
    expect(result).toMatchObject({ fields: 0, annotationsBaked: 0, annotationsDropped: 0 });

    const doc = await PDFDocument.load(result.bytes);
    expect(doc.getPageCount()).toBe(3);
    expect(await pageContentText(doc, 2)).toContain('Stapler fixture page 3');
  });
});

/* ------------------------------------------------------------------ *
 * RED-02 — an overlay is not a redaction
 * ------------------------------------------------------------------ */

/**
 * A page whose entire surface is one image XObject, the way a scan is. The
 * image's samples are readable ASCII so a test can assert on the output *bytes*
 * rather than on a report that says the job succeeded.
 */
async function scannedPagePdf(secret: string): Promise<{ bytes: Uint8Array; samples: string }> {
  const { PDFRawStream } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 800]);

  // 8-bit DeviceRGB, so three bytes per pixel: the string is the pixel data.
  const samples = secret.repeat(3).slice(0, 15);
  const stream = PDFRawStream.of(
    doc.context.obj({
      Type: 'XObject',
      Subtype: 'Image',
      Width: 5,
      Height: 1,
      ColorSpace: 'DeviceRGB',
      BitsPerComponent: 8
    }),
    new TextEncoder().encode(samples)
  );
  const imageRef = doc.context.register(stream);
  (page.node.Resources() as PDFDict).set(PDFName.of('XObject'), doc.context.obj({ Im0: imageRef }));
  page.node.set(
    PDFName.of('Contents'),
    doc.context.register(doc.context.flateStream('q 600 0 0 800 0 0 cm /Im0 Do Q'))
  );
  return { bytes: await doc.save({ useObjectStreams: false }), samples };
}

/** Every indirect object in the saved file as text — object streams included. */
async function allObjectsAsText(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  let text = '';
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    text += `${object}\n`;
    const contents = (object as any).contents;
    if (contents instanceof Uint8Array) text += new TextDecoder('latin1').decode(contents);
  }
  return text;
}

describe('applyRedactions: an image only partly covered by a mark (RED-02)', () => {
  it('refuses rather than drawing a black box over intact pixels', async () => {
    const { bytes } = await scannedPagePdf('SECRETIMAGE');

    // A small mark inside a full-page image: the old code kept the image, drew a
    // rectangle on top, and reported success.
    await expect(
      processWorkerImpl.applyRedactions(bytes, [
        { pageIndex: 0, x: 0.1, y: 0.1, width: 0.2, height: 0.2 }
      ])
    ).rejects.toThrow(/only partly covered/);
  });

  it('substitutes the blacked-out pixels when the caller supplies them', async () => {
    const { bytes, samples } = await scannedPagePdf('SECRETIMAGE');
    const { readFile } = await import('node:fs/promises');
    const replacement = new Uint8Array(
      await readFile(new URL('../fixtures/tiny.jpg', import.meta.url))
    );

    const out = await processWorkerImpl.applyRedactions(
      bytes,
      [{ pageIndex: 0, x: 0.1, y: 0.1, width: 0.2, height: 0.2 }],
      { 0: { Im0: { bytes: replacement, format: 'jpeg', width: 5, height: 1 } } }
    );

    // The original samples must be gone from the file, not merely unreferenced.
    expect(await allObjectsAsText(out)).not.toContain(samples);

    const doc = await PDFDocument.load(out);
    const xobjects = doc.getPage(0).node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict);
    expect(xobjects?.keys().map(String)).toContain('/Im0');
    expect(doc.getPageCount()).toBe(1);
  });

  it('still drops an image a mark fully contains, and its bytes with it', async () => {
    const { bytes, samples } = await scannedPagePdf('SECRETIMAGE');
    const out = await processWorkerImpl.applyRedactions(bytes, [
      { pageIndex: 0, x: 0, y: 0, width: 1, height: 1 }
    ]);
    expect(await allObjectsAsText(out)).not.toContain(samples);
  });

  it('reports the covered area in the image own unit space', async () => {
    const { filterContentStream, tokenizeContentStream, parseContentStream } =
      await import('../../src/core/pdf/interpreter');
    const statements = parseContentStream(
      tokenizeContentStream(new TextEncoder().encode('q 600 0 0 800 0 0 cm /Im0 Do Q'))
    );
    // The bottom-left quarter of the page, in PDF user space.
    const { partialImageCoverage, strippedXObjectNames } = filterContentStream(
      statements,
      [{ x: 0, y: 0, width: 300, height: 400 }],
      undefined,
      () => ({ subtype: 'Image' })
    );
    expect(strippedXObjectNames).toEqual([]);
    expect(partialImageCoverage).toHaveLength(1);
    expect(partialImageCoverage[0].name).toBe('Im0');
    const rect = partialImageCoverage[0].rects[0];
    expect(rect.x).toBeCloseTo(0);
    expect(rect.y).toBeCloseTo(0);
    expect(rect.width).toBeCloseTo(0.5);
    expect(rect.height).toBeCloseTo(0.5);
  });
});

describe('applyRedactions: annotations are deleted, not just unhooked (RED-03)', () => {
  it('removes a redacted annotation object from the output bytes', async () => {
    const SECRET = 'SSN-123-45-6789';
    const doc = await PDFDocument.create();
    const page = doc.addPage([600, 800]);
    const annot = doc.context.obj({
      Type: 'Annot',
      Subtype: 'Text',
      Rect: [50, 700, 250, 750],
      Contents: PDFString.of(`Client ${SECRET} flagged`)
    });
    page.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(annot)]));
    const bytes = await doc.save({ useObjectStreams: false });

    // A mark over the annotation's own rectangle (top of the page).
    const out = await processWorkerImpl.applyRedactions(bytes, [
      { pageIndex: 0, x: 0.05, y: 0.05, width: 0.5, height: 0.1 }
    ]);

    expect(await allObjectsAsText(out)).not.toContain(SECRET);
    expect(await processWorkerImpl.collectOffPageText(out)).toEqual([]);
  });

  it('removes a redacted form field value from the output bytes', async () => {
    const SECRET = 'Ada Lovelace';
    const doc = await PDFDocument.create();
    const page = doc.addPage([600, 800]);
    const form = doc.getForm();
    const field = form.createTextField('name');
    field.setText(SECRET);
    field.addToPage(page, { x: 100, y: 700, width: 200, height: 40 });
    const bytes = await doc.save({ useObjectStreams: false });

    const out = await processWorkerImpl.applyRedactions(bytes, [
      { pageIndex: 0, x: 0.1, y: 0.05, width: 0.5, height: 0.2, text: SECRET }
    ]);

    expect(await processWorkerImpl.collectOffPageText(out)).toEqual([]);
    expect(await allObjectsAsText(out)).not.toContain(SECRET);
  });

  it('leaves an annotation that does not overlap any mark alone', async () => {
    const KEPT = 'keep this note';
    const doc = await PDFDocument.create();
    const page = doc.addPage([600, 800]);
    const annot = doc.context.obj({
      Type: 'Annot',
      Subtype: 'Text',
      Rect: [50, 50, 250, 100],
      Contents: PDFString.of(KEPT)
    });
    page.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(annot)]));
    const bytes = await doc.save({ useObjectStreams: false });

    const out = await processWorkerImpl.applyRedactions(bytes, [
      { pageIndex: 0, x: 0.05, y: 0.05, width: 0.3, height: 0.1 }
    ]);
    expect(await processWorkerImpl.collectOffPageText(out)).toEqual([KEPT]);
  });
});

describe('applyRedactions: content-stream filter chains', () => {
  /** A page whose content stream is deflated and then hex-encoded. */
  async function chainedContentPdf(): Promise<Uint8Array> {
    const { PDFRawStream, StandardFonts } = await import('pdf-lib');
    const { deflateSync } = await import('node:zlib');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([600, 800]);
    (page.node.Resources() as PDFDict).set(
      PDFName.of('Font'),
      doc.context.obj({ F1: (font as any).ref })
    );

    const source =
      'BT /F1 24 Tf 1 0 0 1 50 760 Tm (TOP SECRET) Tj ET\n' +
      'BT /F1 24 Tf 1 0 0 1 50 100 Tm (BOTTOM KEPT) Tj ET';
    const deflated = deflateSync(Buffer.from(source, 'latin1'));
    const hex = new TextEncoder().encode(deflated.toString('hex') + '>');

    const stream = PDFRawStream.of(
      doc.context.obj({ Filter: ['ASCIIHexDecode', 'FlateDecode'] }),
      hex
    );
    page.node.set(PDFName.of('Contents'), doc.context.register(stream));
    return doc.save({ useObjectStreams: false });
  }

  it('decodes a multi-filter chain instead of tokenising raw bytes', async () => {
    const bytes = await chainedContentPdf();
    const out = await processWorkerImpl.applyRedactions(bytes, [
      { pageIndex: 0, x: 0, y: 0, width: 1, height: 0.2 }
    ]);
    const text = await pageContentText(await PDFDocument.load(out), 0);
    expect(text).not.toContain('TOP SECRET');
    expect(text).toContain('BOTTOM KEPT');
  });

  it('refuses a filter it cannot decode rather than corrupting the page', async () => {
    const { PDFRawStream } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    const page = doc.addPage([600, 800]);
    const stream = PDFRawStream.of(
      doc.context.obj({ Filter: 'Crypt' }),
      new TextEncoder().encode('not really encrypted')
    );
    page.node.set(PDFName.of('Contents'), doc.context.register(stream));
    const bytes = await doc.save({ useObjectStreams: false });

    await expect(
      processWorkerImpl.applyRedactions(bytes, [
        { pageIndex: 0, x: 0, y: 0, width: 1, height: 0.5 }
      ])
    ).rejects.toThrow(/cannot decode/);
  });
});

/* ------------------------------------------------------------------ *
 * compose: the catalog, page ranges, duplicated pages, XFA
 * ------------------------------------------------------------------ */

function pageRefs(count: number, docId = 'source') {
  return Array.from({ length: count }, (_, sourceIndex) => ({
    key: `p${sourceIndex}`,
    sourceDocId: docId,
    sourceIndex,
    rotation: 0
  }));
}

/** Compose with everything optional left off. */
function composePlain(pages: ReturnType<typeof pageRefs>, sources: Record<string, Uint8Array>) {
  return processWorkerImpl.compose(
    pages,
    sources,
    [],
    undefined,
    undefined,
    null,
    null,
    undefined,
    silentJob
  );
}

describe('composePages preserves the document catalog (OPS-01 gap)', () => {
  /** A document carrying the catalog entries `copyPages` does not bring across. */
  async function taggedPdf(): Promise<Uint8Array> {
    const { textPdf } = await import('../e2e/fixtures');
    const doc = await PDFDocument.load(await textPdf(3));
    doc.catalog.set(
      PDFName.of('PageLabels'),
      doc.context.obj({ Nums: [0, { S: 'r' }, 1, { S: 'D' }] })
    );
    doc.catalog.set(
      PDFName.of('StructTreeRoot'),
      doc.context.register(doc.context.obj({ Type: 'StructTreeRoot' }))
    );
    doc.catalog.set(
      PDFName.of('OutputIntents'),
      doc.context.obj([{ Type: 'OutputIntent', S: 'GTS_PDFA1' }])
    );
    doc.catalog.set(PDFName.of('Lang'), PDFString.of('en-GB'));
    return doc.save({ useObjectStreams: false });
  }

  it('carries structure, labels and output intents through an unchanged compose', async () => {
    const source = await taggedPdf();
    const out = await PDFDocument.load(await composePlain(pageRefs(3), { source }));
    expect(out.catalog.get(PDFName.of('StructTreeRoot'))).toBeDefined();
    expect(out.catalog.get(PDFName.of('PageLabels'))).toBeDefined();
    expect(out.catalog.get(PDFName.of('OutputIntents'))).toBeDefined();
    expect(out.catalog.get(PDFName.of('Lang'))).toBeDefined();
  });

  it('drops the page-indexed entries when the page set changed, and keeps the rest', async () => {
    const source = await taggedPdf();
    // Two of three pages: /PageLabels is indexed by page position, so carrying it
    // would relabel the wrong pages.
    const out = await PDFDocument.load(await composePlain(pageRefs(2), { source }));
    expect(out.catalog.get(PDFName.of('PageLabels'))).toBeUndefined();
    expect(out.catalog.get(PDFName.of('OutputIntents'))).toBeDefined();
    expect(out.catalog.get(PDFName.of('Lang'))).toBeDefined();
  });

  it('carries nothing page-dependent from a multi-document merge', async () => {
    const { textPdf } = await import('../e2e/fixtures');
    const a = await taggedPdf();
    const b = await textPdf(1);
    const out = await PDFDocument.load(
      await composePlain([...pageRefs(3, 'a'), ...pageRefs(1, 'b')], { a, b })
    );
    expect(out.catalog.get(PDFName.of('StructTreeRoot'))).toBeUndefined();
    expect(out.catalog.get(PDFName.of('PageLabels'))).toBeUndefined();
    expect(out.getPageCount()).toBe(4);
  });
});

describe('watermark page ranges are document page numbers, not slice offsets', () => {
  it('does not restamp every split slice as if it were pages 1-3', async () => {
    const { textPdf } = await import('../e2e/fixtures');
    const source = await textPdf(4);
    const watermark = {
      kind: 'text' as const,
      text: 'CONFIDENTIAL',
      imageScale: 0.35,
      position: 'center',
      opacity: 0.5,
      rotation: 0,
      fontSize: 18,
      color: '#111111',
      startAt: 1,
      pageRange: '1-2'
    };

    const result = await processWorkerImpl.composeSplit(
      pageRefs(4),
      { source },
      [2],
      [],
      watermark,
      undefined,
      null,
      null,
      'part',
      undefined,
      silentJob
    );
    expect(result.isZip).toBe(true);

    const { unzipSync } = await import('fflate');
    const files = unzipSync(result.bytes);
    const names = Object.keys(files).sort();
    expect(names).toHaveLength(2);

    const first = await PDFDocument.load(files[names[0]]);
    const second = await PDFDocument.load(files[names[1]]);
    for (const index of [0, 1]) {
      expect(await pageContentText(first, index)).toContain('CONFIDENTIAL');
      // Pages 3 and 4 of the document are outside "1-2" — the second slice must
      // come out clean, not stamped as though it started at page 1 again.
      expect(await pageContentText(second, index)).not.toContain('CONFIDENTIAL');
    }
  });
});

describe('outlines survive duplication and named destinations (OPS-01)', () => {
  /** A 3-page document whose single bookmark points at page 2 by `destKind`. */
  async function bookmarkedPdf(destKind: 'direct' | 'legacy-name' | 'name-tree') {
    const { textPdf } = await import('../e2e/fixtures');
    const doc = await PDFDocument.load(await textPdf(3));
    const targetRef = doc.getPage(1).ref;
    const destArray = doc.context.obj([targetRef, PDFName.of('Fit')]);

    const item: Record<string, unknown> = { Title: PDFString.of('Chapter 2') };
    if (destKind === 'direct') {
      item.Dest = destArray;
    } else if (destKind === 'legacy-name') {
      doc.catalog.set(PDFName.of('Dests'), doc.context.obj({ chap2: destArray }));
      item.Dest = PDFName.of('chap2');
    } else {
      doc.catalog.set(
        PDFName.of('Names'),
        doc.context.obj({
          Dests: { Names: [PDFString.of('chap2'), destArray] }
        })
      );
      item.Dest = PDFString.of('chap2');
    }

    const itemRef = doc.context.register(doc.context.obj(item as never));
    const outlines = doc.context.obj({
      Type: 'Outlines',
      First: itemRef,
      Last: itemRef,
      Count: 1
    });
    doc.catalog.set(PDFName.of('Outlines'), doc.context.register(outlines));
    return doc.save({ useObjectStreams: false });
  }

  /** The page object the first bookmark of `bytes` points at. */
  async function firstBookmarkTarget(bytes: Uint8Array) {
    const doc = await PDFDocument.load(bytes);
    const outlines = doc.catalog.lookupMaybe(PDFName.of('Outlines'), PDFDict);
    const first = outlines?.lookupMaybe(PDFName.of('First'), PDFDict);
    const dest = first?.lookup(PDFName.of('Dest'));
    return { doc, target: dest instanceof PDFArray ? dest.get(0) : undefined };
  }

  it.each(['direct', 'legacy-name', 'name-tree'] as const)(
    'resolves a %s destination instead of dropping the bookmark',
    async destKind => {
      const source = await bookmarkedPdf(destKind);
      const out = await composePlain(pageRefs(3), { source });
      const { doc, target } = await firstBookmarkTarget(out);
      expect(target).toBe(doc.getPage(1).ref);
    }
  );

  it('points a bookmark at the first copy of a duplicated page, not the last', async () => {
    const source = await bookmarkedPdf('direct');
    // Page 2 placed twice: once in its own position, once appended at the end.
    const pages = [
      ...pageRefs(3),
      { key: 'dup', sourceDocId: 'source', sourceIndex: 1, rotation: 0 }
    ];
    const out = await composePlain(pages, { source });
    const { doc, target } = await firstBookmarkTarget(out);
    expect(doc.getPageCount()).toBe(4);
    expect(target).toBe(doc.getPage(1).ref);
    expect(target).not.toBe(doc.getPage(3).ref);
  });
});

describe('XFA is refused by compose as well as by fill (SGN-03)', () => {
  async function xfaFixture(): Promise<Uint8Array> {
    const { readFile } = await import('node:fs/promises');
    return new Uint8Array(await readFile(new URL('../fixtures/xfa.pdf', import.meta.url)));
  }

  it('refuses to merge, split or watermark an XFA form', async () => {
    const bytes = await xfaFixture();
    await expect(composePlain(pageRefs(1), { source: bytes })).rejects.toThrow(/XFA form/);
  });

  it('lets Sign and Annotate opt in, because flattening is what they offer', async () => {
    const bytes = await xfaFixture();
    const out = await processWorkerImpl.compose(
      pageRefs(1),
      { source: bytes },
      [],
      undefined,
      undefined,
      null,
      null,
      undefined,
      silentJob,
      { allowXfaLoss: true }
    );
    expect((await PDFDocument.load(out)).getPageCount()).toBe(1);
  });
});
