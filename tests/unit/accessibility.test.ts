import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFNumber } from 'pdf-lib';
import {
  applyAltTextToDoc,
  readAltText,
  readAltTextFromDoc
} from '../../src/core/pdf/accessibility';
import { decodeStream } from '../../src/core/pdf/interpreter';

/** A minimal one-page document with a single image XObject drawn once. */
async function makeDocWithImage() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([100, 100]);
  const imageRef = doc.context.register(
    doc.context.obj({ Type: 'XObject', Subtype: 'Image', Width: 10, Height: 10 })
  );
  const xobjects = doc.context.obj({ Im1: imageRef });
  const resources = doc.context.obj({ XObject: xobjects });
  page.node.set(PDFName.of('Resources'), doc.context.register(resources));
  const contentStream = doc.context.flateStream(new Uint8Array(Buffer.from('/Im1 Do\n')));
  page.node.set(PDFName.of('Contents'), doc.context.register(contentStream));
  return { doc, page, imageRef };
}

describe('accessibility', () => {
  it('applies alt text to a document with an image', async () => {
    // Create a basic document with an image Do operator
    const doc = await PDFDocument.create();
    const page = doc.addPage([100, 100]);

    // Create a dummy image XObject
    const imageRef = doc.context.register(
      doc.context.obj({
        Type: 'XObject',
        Subtype: 'Image',
        Width: 10,
        Height: 10
      })
    );

    // Add image to page resources
    const xobjects = doc.context.obj({
      Im1: imageRef
    });
    const resources = doc.context.obj({
      XObject: xobjects
    });
    page.node.set(PDFName.of('Resources'), doc.context.register(resources));

    // Add Do /Im1 to content stream
    const contentStream = doc.context.flateStream(new Uint8Array(Buffer.from('/Im1 Do\n')));
    page.node.set(PDFName.of('Contents'), doc.context.register(contentStream));

    // Apply alt text
    const altTexts = {
      [`0:${imageRef.objectNumber}`]: 'A test image description'
    };

    await applyAltTextToDoc(doc, altTexts);

    // 1. Check StructTreeRoot
    const structTreeRoot = doc.catalog.lookupMaybe(PDFName.of('StructTreeRoot'), PDFDict);
    expect(structTreeRoot).toBeDefined();

    const kArray = structTreeRoot!.lookup(PDFName.of('K'), PDFArray);
    expect(kArray.size()).toBe(1);

    const structElem = kArray.lookup(0, PDFDict);
    expect(structElem.lookup(PDFName.of('S'), PDFName).asString()).toBe('/Figure');
    expect(structElem.lookup(PDFName.of('Alt')).toString()).toContain('004100200074006500730074'); // Contains "A test" in UTF-16BE hex
    // Alternatively we can use:
    // expect((structElem.lookup(PDFName.of('Alt')) as PDFHexString).decodeText()).toBe('A test image description');

    // 2. Check Content Stream for BDC and EMC
    const contents = page.node.lookup(PDFName.of('Contents'));
    expect(contents).toBeDefined();
    // In our implementation, we read and rewrite the stream, keeping it as a flateStream
    // We'd have to decode it to see the BDC, but pdf-lib's save() will serialize it
    await doc.save({ useObjectStreams: false });
    const stream = doc.context.lookup(contents) as any;
    const decodedBytes = await decodeStream(stream.getContents());
    const text = new TextDecoder('latin1').decode(decodedBytes);

    expect(text).toContain('/Figure << /MCID 0 >> BDC');
    expect(text).toContain('EMC');
  });

  it('sets a /StructParents integer on the tagged page, keyed into the ParentTree', async () => {
    const { doc, page, imageRef } = await makeDocWithImage();
    await applyAltTextToDoc(doc, { [`0:${imageRef.objectNumber}`]: 'Round-trip image' });

    const structParents = page.node.lookupMaybe(PDFName.of('StructParents'), PDFNumber);
    expect(structParents).toBeDefined();

    const structTreeRoot = doc.catalog.lookup(PDFName.of('StructTreeRoot'), PDFDict);
    const parentTree = structTreeRoot.lookup(PDFName.of('ParentTree'), PDFDict);
    const nums = parentTree.lookup(PDFName.of('Nums'), PDFArray).asArray();
    const keys = nums.filter((_, i) => i % 2 === 0).map(k => (k as PDFNumber).asNumber());
    expect(keys).toContain(structParents!.asNumber());
  });

  it('reads alt text back from the live document it was just written to', async () => {
    const { doc, imageRef } = await makeDocWithImage();
    const key = `0:${imageRef.objectNumber}`;
    await applyAltTextToDoc(doc, { [key]: 'A round-tripped description' });

    const recovered = await readAltTextFromDoc(doc);
    expect(recovered[key]).toBe('A round-tripped description');
  });

  it('round-trips alt text through a real save and re-parse of the bytes', async () => {
    const { doc, imageRef } = await makeDocWithImage();
    const key = `0:${imageRef.objectNumber}`;
    await applyAltTextToDoc(doc, { [key]: 'Survives a save' });

    const bytes = await doc.save({ useObjectStreams: false });
    const recovered = await readAltText(bytes);

    // The object number is only stable across save/reload because pdf-lib
    // preserves it on a same-document save — this is what a real export/reimport
    // cycle actually does, so asserting on the original key is the honest check.
    expect(recovered[key]).toBe('Survives a save');
  });

  it('also accepts the stable image-name key used by the alt-text editor', async () => {
    const { doc, imageRef } = await makeDocWithImage();
    await applyAltTextToDoc(doc, { '0:Im1': 'Stable key survives compose' });

    const bytes = await doc.save({ useObjectStreams: false });
    const recovered = await readAltText(bytes);

    expect(recovered[`0:${imageRef.objectNumber}`]).toBe('Stable key survives compose');
    expect(recovered['0:Im1']).toBe('Stable key survives compose');
  });

  it('reads nothing back from a document with no structure tree', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([100, 100]);
    const bytes = await doc.save();
    expect(await readAltText(bytes)).toEqual({});
  });

  it('keeps each tagged page on its own /StructParents key across multiple pages', async () => {
    const doc = await PDFDocument.create();
    const refs: number[] = [];
    for (let i = 0; i < 2; i++) {
      const page = doc.addPage([100, 100]);
      const imageRef = doc.context.register(
        doc.context.obj({ Type: 'XObject', Subtype: 'Image', Width: 10, Height: 10 })
      );
      refs.push(imageRef.objectNumber);
      const xobjects = doc.context.obj({ Im1: imageRef });
      const resources = doc.context.obj({ XObject: xobjects });
      page.node.set(PDFName.of('Resources'), doc.context.register(resources));
      const contentStream = doc.context.flateStream(new Uint8Array(Buffer.from('/Im1 Do\n')));
      page.node.set(PDFName.of('Contents'), doc.context.register(contentStream));
    }

    await applyAltTextToDoc(doc, {
      [`0:${refs[0]}`]: 'First page image',
      [`1:${refs[1]}`]: 'Second page image'
    });

    const structParentsByPage = doc
      .getPages()
      .map(p => p.node.lookup(PDFName.of('StructParents'), PDFNumber).asNumber());
    expect(new Set(structParentsByPage).size).toBe(2);

    const bytes = await doc.save({ useObjectStreams: false });
    const recovered = await readAltText(bytes);
    expect(recovered[`0:${refs[0]}`]).toBe('First page image');
    expect(recovered[`1:${refs[1]}`]).toBe('Second page image');
  });
});
