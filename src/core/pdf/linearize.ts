import { PDFDocument, PDFDict, PDFArray, PDFRef, PDFObject, PDFStream } from 'pdf-lib';

export function pseudoLinearize(doc: PDFDocument) {
  const context = doc.context as unknown as {
    __isPseudoLinearized?: boolean;
    enumerateIndirectObjects: () => [PDFRef, PDFObject][];
  };
  if (context.__isPseudoLinearized) return doc;
  context.__isPseudoLinearized = true;

  const originalEnumerate = context.enumerateIndirectObjects.bind(context);

  context.enumerateIndirectObjects = () => {
    const allObjects = originalEnumerate();
    return sortForFastWebView(doc, allObjects);
  };
  return doc;
}

function getRefs(obj: PDFObject, refs: PDFRef[] = []): PDFRef[] {
  if (obj instanceof PDFRef) {
    refs.push(obj);
  } else if (obj instanceof PDFDict) {
    for (const [, val] of obj.entries()) {
      getRefs(val, refs);
    }
  } else if (obj instanceof PDFArray) {
    for (const val of obj.asArray()) {
      getRefs(val, refs);
    }
  } else if (obj instanceof PDFStream) {
    getRefs(obj.dict, refs);
  }
  return refs;
}

function sortForFastWebView(doc: PDFDocument, allObjects: [PDFRef, PDFObject][]) {
  const context = doc.context;

  const pageCount = doc.getPageCount();
  if (pageCount <= 1) return allObjects; // Nothing to reorder for 1-page docs

  const otherPageRefs = new Set<PDFRef>();
  for (let i = 1; i < pageCount; i++) {
    otherPageRefs.add(doc.getPage(i).ref);
  }

  const catalogRef = context.trailerInfo.Root;
  const firstPageSet = new Set<PDFRef>();

  const toVisit: PDFRef[] = [];
  if (catalogRef instanceof PDFRef) {
    toVisit.push(catalogRef);
  }

  while (toVisit.length > 0) {
    const ref = toVisit.pop()!;
    if (firstPageSet.has(ref) || otherPageRefs.has(ref)) continue;
    firstPageSet.add(ref);

    const obj = context.lookup(ref) as PDFObject;
    if (obj) {
      const childRefs = getRefs(obj);
      for (const child of childRefs) {
        toVisit.push(child);
      }
    }
  }

  const firstPageObjects: [PDFRef, PDFObject][] = [];
  const restObjects: [PDFRef, PDFObject][] = [];

  for (const entry of allObjects) {
    const [ref] = entry;
    if (firstPageSet.has(ref)) {
      firstPageObjects.push(entry);
    } else {
      restObjects.push(entry);
    }
  }

  return [...firstPageObjects, ...restObjects];
}
