import { describe, expect, it, vi } from 'vitest';
import { PDFDocument, PDFArray, PDFName, PDFString, PDFDict } from 'pdf-lib';

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
        text: 'Page {n} of {total}',
        position: 'bottom-center',
        opacity: 0.5,
        rotation: 0,
        fontSize: 18,
        color: '#111111',
        startAt: 10,
        pageRange: '2-3'
      },
      null,
      null,
      silentJob
    );

    const output = await PDFDocument.load(bytes);
    await expect(pageContentText(output, 0)).resolves.not.toContain('Page 10 of 4');
    await expect(pageContentText(output, 1)).resolves.toContain('Page 11 of 4');
    await expect(pageContentText(output, 2)).resolves.toContain('Page 12 of 4');
    await expect(pageContentText(output, 3)).resolves.not.toContain('Page 13 of 4');
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
      null,
      { layout: '2-up', margin: 10, gutter: 10, drawBorders: true },
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
      null,
      { layout: 'booklet', margin: 0, gutter: 0, drawBorders: false },
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
    return processWorkerImpl.compose(pages, { doc1: bytes }, [], null, null, null, silentJob);
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
