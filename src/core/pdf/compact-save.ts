/**
 * HRD-40 — keep rebuilt documents from growing on save.
 *
 * `@cantoo/pdf-lib`'s `PDFStreamWriter` deliberately writes the catalog, every
 * `/Pages` node and every page leaf as a plain, uncompressed indirect object,
 * even with `useObjectStreams: true` — it tests `instanceof PDFCatalog /
 * PDFPageTree / PDFPageLeaf`, not anything the PDF format requires (ISO
 * 32000-1 §7.5.7 only keeps streams, the encryption dictionary, objects with a
 * non-zero generation and the linearization dictionary out of object streams).
 * A fresh rebuild (redaction, the metadata scrub) re-creates every page as a
 * `PDFPageLeaf`, so a text-only file whose producer had packed its page
 * dictionaries into compressed object streams came back with all of them
 * spelled out in clear text: a 100-page fixture went from 28 KB to 47 KB, and
 * the audit measured 75 KB → 150 KB on another, with nothing removed and every
 * font and content stream copied exactly once.
 *
 * {@link compactStructuralObjects} lets those dictionaries be compressed on a
 * *full* save. While `doc.save()` runs, the writer is handed each catalog, page
 * tree node and page leaf as a plain `PDFDict` carrying the same entries, which
 * it then packs into an object stream like any other dictionary. Nothing is
 * rewritten: the bytes inside the object stream are exactly the bytes that
 * would have been written outside it, the reference numbers are unchanged, and
 * the live document keeps its typed objects. An incremental save is left alone
 * — the increment's structure is pdf-lib's to decide.
 */
import { PDFCatalog, PDFDict, PDFPageLeaf, PDFPageTree } from 'pdf-lib';
import type { PDFDocument, PDFObject, PDFRef } from 'pdf-lib';

type Enumerate = () => [PDFRef, PDFObject][];

interface CompactableContext {
  __compactStructural?: boolean;
  enumerateIndirectObjects: Enumerate;
  pdfFileDetails?: { originalBytes?: Uint8Array };
  snapshot?: unknown;
}

function isStructural(object: PDFObject): object is PDFDict {
  return (
    object instanceof PDFCatalog || object instanceof PDFPageTree || object instanceof PDFPageLeaf
  );
}

/**
 * Installs the compaction on `doc` and returns it, so it composes inline with
 * `pseudoLinearize` (either order works: both only wrap the context's object
 * enumeration, and this one is active only inside `save()`).
 */
export function compactStructuralObjects(doc: PDFDocument): PDFDocument {
  const context = doc.context as unknown as CompactableContext;
  if (context.__compactStructural) return doc;
  context.__compactStructural = true;

  let saving = false;
  const originalEnumerate: Enumerate = context.enumerateIndirectObjects.bind(context);
  context.enumerateIndirectObjects = () => {
    const entries = originalEnumerate();
    if (!saving) return entries;
    return entries.map(([ref, object]): [PDFRef, PDFObject] =>
      isStructural(object)
        ? [ref, PDFDict.fromMapWithContext(new Map(object.entries()), doc.context)]
        : [ref, object]
    );
  };

  const originalSave = doc.save.bind(doc);
  doc.save = async (...args: Parameters<PDFDocument['save']>) => {
    // Mirrors `PDFDocument.save`'s own test for an incremental update.
    const incremental =
      args[0]?.rewrite !== true && !!context.pdfFileDetails?.originalBytes && !!context.snapshot;
    saving = !incremental;
    try {
      return await originalSave(...args);
    } finally {
      saving = false;
    }
  };
  return doc;
}
