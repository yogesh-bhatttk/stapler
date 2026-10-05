/**
 * HRD-23 / DOC-08 — the opt-in "Fast web view" save.
 *
 * DOC-05 saves with object streams, which is smaller, but pdf-lib then writes the
 * page dictionaries and most other non-stream objects inside compressed object
 * streams near the end of the file, whatever order they were handed in. Page 1's
 * objects can only come first on a plain-xref save, so the option trades object
 * streams for ordering — and it is opt-in for that reason.
 *
 * This is still not ISO 32000-1 Annex F linearization: no `/Linearized`
 * dictionary, no hint tables (see `linearize.ts`). What it guarantees, and what
 * `tests/unit/fast-web-view.test.ts` checks on the output bytes, is that every
 * object page 1 needs is written before any object only a later page needs, and
 * that no object stream is written.
 *
 * Ordering is done by **renumbering**, not by permuting the write order:
 * object `1 0 obj` onwards are page 1's objects. pdf-lib writes a plain xref in
 * ascending object-number order, so the order survives any later plain-xref
 * re-save of these bytes — in particular RED-06's encryption and the re-applied
 * import restrictions, which load the file afresh and could not see a permutation
 * installed on another `PDFDocument`.
 */
import { PDFArray, PDFDict, PDFNull, PDFRef, PDFStream } from 'pdf-lib';
import type { PDFDocument, PDFObject } from 'pdf-lib';
import { sortForFastWebView } from './linearize';

interface RenumberableContext {
  indirectObjects: Map<PDFRef, PDFObject>;
  largestObjectNumber: number;
  enumerateIndirectObjects: () => [PDFRef, PDFObject][];
  trailerInfo: { Root?: PDFObject; Encrypt?: PDFObject; Info?: PDFObject; ID?: PDFObject };
}

/**
 * Renumbers every indirect object of `doc` so page 1's objects take the lowest
 * numbers, then everything else in its existing relative order. Every reference
 * in the document and trailer is rewritten to match. A reference to an object
 * that does not exist is already `null` by definition (ISO 32000-1 §7.3.10) and
 * is written as `null`, so it cannot collide with a renumbered object.
 *
 * Only call this immediately before `save()` on a document nothing else holds
 * page or form handles into: those wrappers cache the old references.
 */
export function renumberFirstPageFirst(doc: PDFDocument): void {
  const context = doc.context as unknown as RenumberableContext;
  const ordered = sortForFastWebView(doc, context.enumerateIndirectObjects());

  const renumbered = new Map<PDFRef, PDFRef>();
  ordered.forEach(([ref], at) => renumbered.set(ref, PDFRef.of(at + 1, 0)));

  // Direct containers are rewritten in place, so a container shared by two
  // parents must be rewritten once: a second pass would map new numbers again.
  const seen = new Set<PDFObject>();
  const remap = (value: PDFObject): PDFObject => {
    if (value instanceof PDFRef) return renumbered.get(value) ?? PDFNull;
    if (seen.has(value)) return value;
    if (value instanceof PDFDict) {
      seen.add(value);
      for (const [key, entry] of value.entries()) value.set(key, remap(entry));
    } else if (value instanceof PDFArray) {
      seen.add(value);
      for (let i = 0; i < value.size(); i++) value.set(i, remap(value.get(i)));
    } else if (value instanceof PDFStream) {
      seen.add(value);
      remap(value.dict);
    }
    return value;
  };

  for (const [, object] of ordered) remap(object);

  const trailer = context.trailerInfo;
  if (trailer.Root) trailer.Root = remap(trailer.Root);
  if (trailer.Info) trailer.Info = remap(trailer.Info);
  if (trailer.Encrypt) trailer.Encrypt = remap(trailer.Encrypt);
  if (trailer.ID) trailer.ID = remap(trailer.ID);

  context.indirectObjects.clear();
  context.largestObjectNumber = 0;
  for (const [ref, object] of ordered) {
    const next = renumbered.get(ref)!;
    context.indirectObjects.set(next, object);
    context.largestObjectNumber = Math.max(context.largestObjectNumber, next.objectNumber);
  }
}

/**
 * Saves `doc` for fast web view: renumbered first-page-first, plain xref, no
 * object streams. Field appearances are left as they are — regenerating them is
 * a content change, and this save must only change the file's layout.
 */
export async function saveFastWebView(doc: PDFDocument): Promise<Uint8Array> {
  renumberFirstPageFirst(doc);
  return doc.save({
    useObjectStreams: false,
    addDefaultPage: false,
    updateFieldAppearances: false
  });
}
