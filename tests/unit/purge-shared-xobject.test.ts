import { describe, it, expect } from 'vitest';
import {
  PDFDocument,
  PDFName,
  PDFStream,
  PDFDict,
  PDFRef,
  pushGraphicsState,
  popGraphicsState,
  concatTransformationMatrix,
  drawObject
} from 'pdf-lib';

const RED_PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/**
 * Page A paints an embedded image directly. Page B paints the *same* image,
 * but only indirectly — through a Form XObject (the shape a stamp, watermark,
 * or repeated letterhead takes), whose own `/Resources/XObject` dict is where
 * the real reference lives. Page B's own top-level `/XObject` dict names only
 * the form, never the image.
 */
async function documentWithImageSharedViaForm(): Promise<{
  bytes: Uint8Array;
  imageName: string;
}> {
  const doc = await PDFDocument.create();
  const pageA = doc.addPage([100, 100]);
  const pageB = doc.addPage([100, 100]);

  const image = await doc.embedPng(Uint8Array.from(atob(RED_PNG_1X1), c => c.charCodeAt(0)));
  pageA.drawImage(image, { x: 0, y: 0, width: 100, height: 100 });
  const imageName = pageA.node
    .Resources()!
    .lookup(PDFName.of('XObject'), PDFDict)
    .keys()
    .find(
      key => pageA.node.Resources()!.lookup(PDFName.of('XObject'), PDFDict).get(key) === image.ref
    )!
    .decodeText();

  const formStream = doc.context.formXObject(
    [
      pushGraphicsState(),
      concatTransformationMatrix(100, 0, 0, 100, 0, 0),
      drawObject(PDFName.of('Im0')),
      popGraphicsState()
    ],
    { BBox: [0, 0, 1, 1], Resources: { XObject: { Im0: image.ref } } }
  );
  const formRef = doc.context.register(formStream);
  const formName = pageB.node.newXObject('Fm', formRef);
  const formContentRef = doc.context.register(
    doc.context.contentStream([pushGraphicsState(), drawObject(formName), popGraphicsState()])
  );
  pageB.node.addContentStream(formContentRef);

  return { bytes: await doc.save(), imageName };
}

describe('purgeXObjectIfUnreferenced sees through Form XObjects (RED-02/RED-08 shared fix)', () => {
  it('keeps an image alive for a Form XObject on another page after it is replaced elsewhere', async () => {
    const { processWorkerImpl } = await import('../../src/core/workers/process.worker');
    const { encodePng } = await import('../../src/core/png');
    const { bytes, imageName } = await documentWithImageSharedViaForm();

    const written = await processWorkerImpl.replacePageImages(bytes, {
      0: {
        [imageName]: {
          bytes: encodePng({
            width: 1,
            height: 1,
            bitDepth: 8,
            colorType: 2,
            samples: new Uint8Array([0, 255, 0])
          }),
          format: 'png' as const,
          width: 1,
          height: 1
        }
      }
    });

    const output = await PDFDocument.load(written);
    const pageB = output.getPage(1);

    const bXObjects = pageB.node.Resources()!.lookup(PDFName.of('XObject'), PDFDict);
    const formRef = [...bXObjects.keys()]
      .map(key => bXObjects.get(key))
      .find((v): v is PDFRef => v instanceof PDFRef)!;
    const form = output.context.lookup(formRef) as PDFStream & { dict: PDFDict };

    const formResources = output.context.lookup(
      form.dict.get(PDFName.of('Resources')) as PDFRef,
      PDFDict
    );
    const formXObjects = formResources.lookup(PDFName.of('XObject'), PDFDict);
    const nestedImageRef = formXObjects.get(PDFName.of('Im0')) as PDFRef;

    // Before the fix, `purgeXObjectIfUnreferenced` only looked at each page's
    // own top-level `/XObject` dict, never inside a Form XObject's nested
    // resources — so it saw the image as unreferenced the moment page A
    // stopped naming it directly, deleted the underlying object, and left
    // this exact reference dangling.
    const resolvedImage = output.context.lookup(nestedImageRef);
    expect(resolvedImage).toBeInstanceOf(PDFStream);
  });
});
