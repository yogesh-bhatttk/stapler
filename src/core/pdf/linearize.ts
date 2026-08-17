/**
 * DOC-08 — first-page-first object ordering on export.
 *
 * Honest naming matters here, so read this before changing the copy anywhere in the UI:
 * **this is not ISO 32000-1 §F linearization.** A truly linearized ("fast web view")
 * file needs a `/Linearized` parameter dictionary as the first object, a first-page
 * cross-reference section, and `/H` hint tables — none of which pdf-lib can emit, and
 * none of which we fabricate. What this module does is reorder the objects pdf-lib is
 * about to write so everything reachable for page 1 is emitted before the objects that
 * only later pages need. A viewer streaming the file byte-by-byte can therefore reach
 * page 1's content sooner; a viewer looking for a `/Linearized` dict will correctly
 * conclude the file is not linearized, because it isn't.
 *
 * Two further caveats, both real:
 *
 *  • Most save sites pass `useObjectStreams: true`. pdf-lib's `PDFStreamWriter` then
 *    diverts every non-stream object — page dictionaries, the page tree, the catalog —
 *    into compressed object streams that it appends *after* the content streams,
 *    regardless of the order handed to it. On that path the reordering below buys
 *    nothing beyond ordering the page content streams themselves. It is left applied
 *    because it is free and because it does hold on the `useObjectStreams: false`
 *    save sites; `tests/unit/linearize.test.ts` asserts both halves of that sentence
 *    rather than letting the claim rot.
 *  • The reordering is a pure permutation. No object is added, removed or rewritten, so
 *    output always re-parses to the same pages in the same order.
 *
 * The behaviour is optional: `setFastWebViewOrdering(false)` turns it off process-wide,
 * and `pseudoLinearize(doc, false)` turns it off for one save.
 */
import { PDFDocument, PDFDict, PDFArray, PDFRef, PDFObject, PDFStream } from 'pdf-lib';

let orderingEnabled = true;

/** Global default for {@link pseudoLinearize}. Off means "write pdf-lib's own order". */
export function setFastWebViewOrdering(enabled: boolean) {
  orderingEnabled = enabled;
}

export function isFastWebViewOrderingEnabled() {
  return orderingEnabled;
}

/**
 * Installs first-page-first object ordering on `doc`, returning the same document so it
 * can be used inline (`await pseudoLinearize(doc).save(...)`).
 *
 * @param enabled overrides the global setting for this document only.
 */
export function pseudoLinearize(doc: PDFDocument, enabled: boolean = orderingEnabled) {
  if (!enabled) return doc;

  const context = doc.context as unknown as {
    __isPseudoLinearized?: boolean;
    enumerateIndirectObjects: () => [PDFRef, PDFObject][];
  };
  if (context.__isPseudoLinearized) return doc;
  context.__isPseudoLinearized = true;

  const originalEnumerate = context.enumerateIndirectObjects.bind(context);

  context.enumerateIndirectObjects = () => {
    const allObjects = originalEnumerate();
    try {
      return sortForFastWebView(doc, allObjects);
    } catch {
      // Ordering is an optimisation, never a correctness requirement: if the document
      // is shaped in a way this traversal cannot walk, save it in pdf-lib's own order
      // rather than failing the export.
      return allObjects;
    }
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
