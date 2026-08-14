import {
  PDFDocument,
  PDFDict,
  PDFName,
  PDFArray,
  PDFString,
  PDFRef,
  PDFStream,
  PDFObject
} from 'pdf-lib';
import {
  parseContentStream,
  serializeStatements,
  tokenizeContentStream,
  Statement,
  Token
} from './interpreter';
import { decodeStream } from './interpreter';

function encodeString(str: string): Uint8Array {
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i);
  return bytes;
}

export async function applyAltTextToDoc(
  doc: PDFDocument,
  altTexts: Record<string, string> // key is `${pageIndex}:${objectNumber}`
): Promise<void> {
  const pages = doc.getPages();

  // 1. Set up MarkInfo
  let markInfo = doc.catalog.lookupMaybe(PDFName.of('MarkInfo'), PDFDict);
  if (!markInfo) {
    markInfo = doc.context.obj({ Marked: true });
    doc.catalog.set(PDFName.of('MarkInfo'), markInfo);
  } else {
    markInfo.set(PDFName.of('Marked'), doc.context.obj(true));
  }

  let structTreeRoot = doc.catalog.lookupMaybe(PDFName.of('StructTreeRoot'), PDFDict);
  let numsArray: PDFObject[];

  if (!structTreeRoot) {
    numsArray = [];
    const newParentTree = doc.context.obj(numsArray) as unknown as PDFArray;
    const numsDict = doc.context.obj({ Nums: newParentTree });

    structTreeRoot = doc.context.obj({
      Type: 'StructTreeRoot',
      K: [],
      ParentTree: numsDict
    });
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRoot);
  } else {
    const pTree = structTreeRoot.lookupMaybe(PDFName.of('ParentTree'), PDFDict);
    if (pTree) {
      const nums = pTree.lookupMaybe(PDFName.of('Nums'), PDFArray);
      if (nums) {
        numsArray = nums.asArray();
      } else {
        numsArray = [];
        const newParentTree = doc.context.obj(numsArray) as unknown as PDFArray;
        pTree.set(PDFName.of('Nums'), newParentTree);
      }
    } else {
      numsArray = [];
      const newParentTree = doc.context.obj(numsArray) as unknown as PDFArray;
      const numsDict = doc.context.obj({ Nums: newParentTree });
      structTreeRoot.set(PDFName.of('ParentTree'), numsDict);
    }
  }

  // 3. Process each page
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const page = pages[pageIndex];
    const resources = page.node.Resources();
    const xobjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);

    // We need to resolve names to object numbers to check against altTexts
    const nameToObjectNum = new Map<string, number>();
    if (xobjects) {
      for (const [key, value] of xobjects.entries()) {
        if (value instanceof PDFRef) {
          nameToObjectNum.set(key.asString().replace(/^\//, ''), value.objectNumber);
        }
      }
    }

    // Get content stream
    let rawBytes: Uint8Array;

    const contents = page.node.get(PDFName.of('Contents'));
    if (contents instanceof PDFRef) {
      const stream = doc.context.lookup(contents, PDFStream);
      rawBytes = stream.getContents();
      const filter = stream.dict.lookup(PDFName.of('Filter'));
      if (
        filter === PDFName.of('FlateDecode') ||
        (filter instanceof PDFArray && filter.get(0) === PDFName.of('FlateDecode'))
      ) {
        rawBytes = await decodeStream(rawBytes);
      }
    } else if (contents instanceof PDFArray) {
      // Multiple content streams - unsupported by our simple editor for now
      // A more robust implementation would merge them or process each
      continue;
    } else {
      continue;
    }

    const tokens = tokenizeContentStream(rawBytes);
    const statements = parseContentStream(tokens);

    let mcid = 0;
    // Find highest existing MCID to avoid collisions
    for (const stmt of statements) {
      const op = String.fromCharCode(...stmt.operator.bytes);
      if (op === 'BDC' && stmt.operands.length === 2 && stmt.operands[1].type === 'dict_start') {
        // Very basic attempt to parse BDC props for MCID
        // In reality, property dictionaries can be references, but we do our best
        for (let i = 0; i < stmt.operands.length - 1; i++) {
          if (
            stmt.operands[i].type === 'name' &&
            String.fromCharCode(...stmt.operands[i].bytes) === '/MCID'
          ) {
            const num = parseInt(String.fromCharCode(...stmt.operands[i + 1].bytes), 10);
            if (!isNaN(num) && num >= mcid) {
              mcid = num + 1;
            }
          }
        }
      }
    }

    const modifiedStatements: Statement[] = [];
    const structElems: PDFDict[] = [];

    for (const stmt of statements) {
      const op = String.fromCharCode(...stmt.operator.bytes);
      if (op === 'Do' && stmt.operands.length === 1 && stmt.operands[0].type === 'name') {
        const xobjName = String.fromCharCode(...stmt.operands[0].bytes).replace(/^\//, '');
        const objNum = nameToObjectNum.get(xobjName);

        if (objNum !== undefined) {
          const key = `${pageIndex}:${objNum}`;
          const altText = altTexts[key];

          if (altText) {
            // Wrap in BDC ... EMC
            const bdcOperands: Token[] = [
              { type: 'name', bytes: encodeString('/Figure') },
              { type: 'dict_start', bytes: encodeString('<<') },
              { type: 'name', bytes: encodeString('/MCID') },
              { type: 'number', bytes: encodeString(mcid.toString()) },
              { type: 'dict_end', bytes: encodeString('>>') }
            ];
            modifiedStatements.push({
              operands: bdcOperands,
              operator: { type: 'operator', bytes: encodeString('BDC') }
            });

            modifiedStatements.push(stmt);

            modifiedStatements.push({
              operands: [],
              operator: { type: 'operator', bytes: encodeString('EMC') }
            });

            // Create StructElem
            const structElem = doc.context.obj({
              Type: 'StructElem',
              S: 'Figure',
              P: structTreeRoot,
              Pg: page.ref,
              K: mcid,
              Alt: PDFString.of(altText)
            });
            structElems.push(structElem);

            mcid++;
            continue;
          }
        }
      }

      modifiedStatements.push(stmt);
    }

    if (structElems.length > 0) {
      // 1. Update content stream
      const newBytes = serializeStatements(modifiedStatements);
      const newStream = doc.context.flateStream(newBytes);
      page.node.set(PDFName.of('Contents'), doc.context.register(newStream));

      // 2. Add to ParentTree
      const pageRefsArray = doc.context.obj(structElems.map(e => doc.context.register(e)));
      numsArray.push(doc.context.obj(pageIndex), doc.context.register(pageRefsArray));

      // 3. Add to StructTreeRoot's K array
      let kArr = structTreeRoot.lookupMaybe(PDFName.of('K'), PDFArray);
      if (!kArr) {
        kArr = doc.context.obj([]) as unknown as PDFArray;
        structTreeRoot.set(PDFName.of('K'), kArr);
      }
      for (const e of structElems) {
        kArr.push(doc.context.register(e));
      }
    }
  }
}
