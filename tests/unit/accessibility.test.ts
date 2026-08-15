import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFDict, PDFArray } from 'pdf-lib';
import { applyAltTextToDoc } from '../../src/core/pdf/accessibility';
import { unzipSync } from 'zlib';

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
    expect(structElem.lookup(PDFName.of('Alt')).toString()).toContain('A test image description');

    // 2. Check Content Stream for BDC and EMC
    const contents = page.node.lookup(PDFName.of('Contents'));
    expect(contents).toBeDefined();
    // In our implementation, we read and rewrite the stream, keeping it as a flateStream
    // We'd have to decode it to see the BDC, but pdf-lib's save() will serialize it
    const pako = require('pako');
    const savedBytes = await doc.save({ useObjectStreams: false });
    const text = pako.inflate(doc.context.lookup(contents).contents, { to: 'string' });

    expect(text).toContain('/Figure << /MCID 0 >> BDC');
    expect(text).toContain('EMC');
  });
});
