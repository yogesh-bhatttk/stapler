/**
 * AUDIT-FINDINGS §7 — a form Stapler creates must carry the resources its own
 * fields name, or the appearance pass that flattening runs resolves nothing.
 */
import { describe, expect, it } from 'vitest';
import { PDFDict, PDFDocument, PDFName, PDFString, PDFHexString } from 'pdf-lib';
import { processWorkerImpl } from '../../src/core/workers/process.worker';

async function blankPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  return doc.save();
}

const composeWithField = async () => {
  const bytes = await blankPdf();
  return processWorkerImpl.compose(
    [{ key: 'p0', sourceDocId: 'doc', sourceIndex: 0, rotation: 0 }],
    { doc: bytes },
    [],
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      formFieldsToCreate: [
        {
          pageKey: 'p0',
          type: 'text',
          name: 'signer',
          x: 0.1,
          y: 0.1,
          width: 0.4,
          height: 0.05
        }
      ]
    }
  );
};

describe('a generated AcroForm resolves its own font', () => {
  it('writes /DR with a Helvetica font resource and a document /DA', async () => {
    const out = await composeWithField();
    const doc = await PDFDocument.load(out);

    const form = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
    expect(form).toBeDefined();

    const dr = form!.lookupMaybe(PDFName.of('DR'), PDFDict);
    expect(dr).toBeDefined();
    const fonts = dr!.lookupMaybe(PDFName.of('Font'), PDFDict);
    expect(fonts).toBeDefined();

    // pdf-lib's field /DA names `/Helvetica`; Acrobat's convention is `/Helv`.
    // Both must resolve or one producer or the other draws nothing.
    for (const name of ['Helvetica', 'Helv']) {
      const ref = fonts!.get(PDFName.of(name));
      expect(ref, `${name} missing from /DR/Font`).toBeDefined();
      const font = doc.context.lookup(ref!) as PDFDict;
      expect(String(font.get(PDFName.of('BaseFont')))).toContain('Helvetica');
    }

    const da = form!.get(PDFName.of('DA'));
    expect(da).toBeInstanceOf(PDFString);
    expect((da as PDFString).decodeText()).toContain('Tf');
  });

  it("resolves every field's /DA font name inside /DR", async () => {
    const out = await composeWithField();
    const doc = await PDFDocument.load(out);
    const form = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict)!;
    const fonts = form
      .lookupMaybe(PDFName.of('DR'), PDFDict)!
      .lookupMaybe(PDFName.of('Font'), PDFDict)!;

    for (const field of doc.getForm().getFields()) {
      const da = field.acroField.dict.get(PDFName.of('DA'));
      const text =
        da instanceof PDFString || da instanceof PDFHexString ? da.decodeText() : undefined;
      if (!text) continue;
      const named = text.match(/\/([^\s/]+)\s+[\d.]+\s+Tf/);
      expect(named, `field /DA has no font operator: ${text}`).toBeTruthy();
      expect(fonts.get(PDFName.of(named![1])), `/DR has no ${named![1]}`).toBeDefined();
    }
  });

  it('flattens the generated form without refusing', async () => {
    const composed = await composeWithField();
    const result = await processWorkerImpl.flattenDocument(composed);
    expect(result.fields).toBe(1);

    const flattened = await PDFDocument.load(result.bytes);
    expect(flattened.catalog.get(PDFName.of('AcroForm'))).toBeUndefined();
    expect(flattened.getPageCount()).toBe(1);
  });

  it('does not overwrite a /DR carried in from the source document', async () => {
    const source = await PDFDocument.create();
    source.addPage([400, 400]);
    const form = source.getForm();
    form.createTextField('inherited').addToPage(source.getPage(0), {
      x: 10,
      y: 10,
      width: 100,
      height: 20
    });
    const acro = source.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict)!;
    acro.set(PDFName.of('DA'), PDFString.of('/Custom 12 Tf 0 g'));
    const bytes = await source.save();

    const out = await processWorkerImpl.compose(
      [{ key: 'p0', sourceDocId: 'doc', sourceIndex: 0, rotation: 0 }],
      { doc: bytes },
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {}
    );

    const doc = await PDFDocument.load(out);
    const outForm = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict)!;
    const da = outForm.get(PDFName.of('DA')) as PDFString;
    expect(da.decodeText()).toBe('/Custom 12 Tf 0 g');
  });
});
