import fs from 'node:fs';
import { PDFDocument, PDFName, PDFDict, PDFStream } from 'pdf-lib';

async function main() {
  const bytes = fs.readFileSync('tests/fixtures/oversized-mask.pdf');
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPage(0);
  const xobjs = page.node.Resources().lookup(PDFName.of('XObject'), PDFDict);
  for (const [key, ref] of xobjs.entries()) {
    const stream = doc.context.lookup(ref, PDFStream);
    console.log(
      key.asString(),
      '->',
      ref.toString(),
      'w=',
      stream.dict.get(PDFName.of('Width')).toString(),
      'h=',
      stream.dict.get(PDFName.of('Height')).toString()
    );
  }
}
main();
