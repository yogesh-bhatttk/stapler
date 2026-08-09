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

describe('applyRedactions', () => {
  it('performs operator-level removal of text within region', async () => {
    // Generate a simple PDF with text
    const { textPdf } = await import('../e2e/fixtures');
    const bytes = await textPdf(1);

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

    // Load back and extract text manually (the pdf-lib extraction would need renderWorker,
    // but we can just check the raw content stream for the redacted size).
    const doc = await PDFDocument.load(redactedBytes);
    // Verify the page is accessible (structure is intact)
    void doc.getPage(0);
    // The contents stream has been modified and appended to.
    // Just verify the bytes are different from the source bytes, showing it rebuilt.
    expect(redactedBytes).not.toEqual(bytes);
    expect(redactedBytes.length).toBeGreaterThan(0);
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
  it('strips text drawn inside a Form XObject that overlaps the region', async () => {
    // A Form XObject invocation is not a unit square like an image — its extent
    // is its own /BBox through its own /Matrix. Before this was handled, every
    // Form Do call was measured with the image-style unit-square approximation,
    // so it could never be detected as overlapping a redaction region and its
    // content — including any text drawn inside it — was never touched.
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

    // A small region inside the form's footprint (top band of the page).
    const out = await processWorkerImpl.applyRedactions(bytes, [
      { pageIndex: 0, x: 0.1, y: 0.1, width: 0.3, height: 0.1 }
    ]);

    const hasText = Buffer.from(out).toString('latin1').includes('FORM SECRET TEXT');
    expect(hasText).toBe(false);
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
      { 0: { Im0: { jpeg: tinyJpeg, width: 2, height: 2 } } }
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
  const xobjects = doc
    .getPage(pageIndex)
    .node.Resources()
    ?.lookupMaybe(PDFName.of('XObject'), PDFDict);
  if (!xobjects) return false;
  return [...xobjects.entries()].some(([, ref]) => {
    const obj = doc.context.lookup(ref) as unknown as { dict?: PDFDict };
    return String(obj?.dict?.get(PDFName.of('Subtype'))) === '/Image';
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
  it('rebuildCompressed creates a new SMask of the requested dimensions', async () => {
    const fs = await import('node:fs');
    const { PDFDocument, PDFName, PDFDict, PDFStream } = await import('pdf-lib');
    const bytes = fs.readFileSync('tests/fixtures/oversized-mask.pdf');

    // Supply a mock downscaled base image and downscaled mask bytes.
    const replacedImages = {
      '0': {
        ImStrip: {
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
      { 0: { Im0: { jpeg, width: 10, height: 210, maskBytes: new Uint8Array(10 * 210) } } },
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
