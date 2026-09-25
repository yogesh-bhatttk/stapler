/**
 * Page-tree-aware rebuild primitives shared by every path that copies pages from
 * one document into a fresh one: compose (merge/extract/split/organise), the
 * compression rebuild, the metadata scrub and redaction.
 *
 * The bug these exist to prevent (audit 2026-09-25, PDF-1/PDF-6/PDF-7):
 * pdf-lib's `PDFObjectCopier.copy(pageLeaf)` never records the *page's own
 * reference* in its `traversedObjects` map. Every other reference to that page
 * — an annotation's `/P`, a link's `/Dest [pageRef …]` or `/A /GoTo /D`, a
 * widget's `/Parent → /Kids → sibling → /P`, an article bead, a structure
 * element's `/Pg` — was therefore copied as a *second*, orphan page dictionary
 * still pointing at the page's original `/Contents` and resources. On the
 * redaction path that orphan carried the unredacted content stream into the
 * output; on extract it dragged in pages the user deliberately left out; and
 * everywhere it broke internal links, which pointed at the orphan rather than
 * at the page in the tree.
 *
 * The fix is to decide, *before anything is copied*, where every source page
 * goes: each exported page's reference is pre-registered in the copier against
 * the destination reference its copy will occupy, and each page that is *not*
 * exported is pre-registered against a single "tombstone" reference that is
 * never given an object. After the rebuild {@link resolvePageTombstone} removes
 * every reference to the tombstone — dropping links to pages that are not in
 * the output, clearing `/P` and `/Dest` entries, nulling anything else — and
 * {@link sweepUnreachableObjects} deletes whatever the finished catalog can no
 * longer reach.
 */
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNull,
  PDFObjectCopier,
  PDFPage,
  PDFRef,
  PDFStream
} from 'pdf-lib';
import type { PDFObject } from 'pdf-lib';
import { internal } from '../errors';

/** The one private field of `PDFObjectCopier` this module needs. */
interface CopierInternals {
  traversedObjects: Map<PDFObject, PDFObject>;
}

function traversedObjectsOf(copier: PDFObjectCopier): Map<PDFObject, PDFObject> {
  // `traversedObjects` is `private readonly` in pdf-lib's typings, but it is the
  // only way to tell the copier "this reference is already mapped" before the
  // copy starts. Checked at runtime so a pdf-lib upgrade that renames it fails
  // loudly here instead of silently bringing the orphan-page leak back.
  const map = (copier as unknown as Partial<CopierInternals>).traversedObjects;
  if (!(map instanceof Map)) {
    throw internal('pdf-lib object copier internals changed: cannot pre-map page references');
  }
  return map;
}

/** Every `/Pages` node reference in `doc`'s page tree (not the leaves). */
function pageTreeNodeRefs(doc: PDFDocument): PDFRef[] {
  const found: PDFRef[] = [];
  const seen = new Set<string>();
  const walk = (ref: unknown, depth: number) => {
    if (!(ref instanceof PDFRef) || depth > 64 || seen.has(ref.toString())) return;
    seen.add(ref.toString());
    const node = doc.context.lookup(ref);
    if (!(node instanceof PDFDict)) return;
    if (node.get(PDFName.of('Type')) !== PDFName.of('Pages')) return;
    found.push(ref);
    const kids = node.lookupMaybe(PDFName.of('Kids'), PDFArray);
    for (let i = 0; kids && i < kids.size(); i++) walk(kids.get(i), depth + 1);
  };
  walk(doc.catalog.get(PDFName.of('Pages')), 0);
  return found;
}

/**
 * Reserves the destination reference a page copy will be assigned to, so it can
 * be named before the copy exists. `nextRef()` only allocates a number; the
 * object is assigned by {@link copyPageInto}.
 */
export function reservePageRef(out: PDFDocument): PDFRef {
  return out.context.nextRef();
}

/** A reference that stands for "a page that is not in this output". Never assigned. */
export function createPageTombstone(out: PDFDocument): PDFRef {
  return out.context.nextRef();
}

/**
 * Pre-registers every page of `source` in `copier`: page `i` maps to
 * `targets.get(i)` when it is exported, and to `tombstone` when it is not.
 * `/Pages` tree nodes map to the tombstone too — nothing in an output should
 * point back into the source's page tree.
 *
 * Must run before the copier copies anything that could reference a page.
 * Existing mappings are overwritten, so a copier used for a *duplicate* of a
 * page can be re-pointed at that duplicate's own reference.
 */
export function premapSourcePages(
  copier: PDFObjectCopier,
  source: PDFDocument,
  targets: ReadonlyMap<number, PDFRef>,
  tombstone: PDFRef
): void {
  const traversed = traversedObjectsOf(copier);
  for (const ref of pageTreeNodeRefs(source)) traversed.set(ref, tombstone);
  source.getPages().forEach((page, index) => {
    traversed.set(page.ref, targets.get(index) ?? tombstone);
  });
}

/**
 * Copies `srcPage` through `copier` into the reserved `dstRef` and returns it as
 * a page of `out`. Not added to the page tree — the caller decides the order.
 */
export function copyPageInto(
  copier: PDFObjectCopier,
  srcPage: PDFPage,
  dstRef: PDFRef,
  out: PDFDocument
): PDFPage {
  const leaf = copier.copy(srcPage.node);
  out.context.assign(dstRef, leaf);
  return PDFPage.of(leaf, dstRef, out);
}

function isTomb(value: unknown, tombstone: PDFRef): boolean {
  return value instanceof PDFRef && value.toString() === tombstone.toString();
}

/** A destination (array, or a dict with `/D`) whose target page is the tombstone. */
function destPointsAtTomb(value: unknown, doc: PDFDocument, tombstone: PDFRef): boolean {
  const resolved = value instanceof PDFRef ? doc.context.lookup(value) : value;
  if (resolved instanceof PDFArray)
    return resolved.size() > 0 && isTomb(resolved.get(0), tombstone);
  if (resolved instanceof PDFDict)
    return destPointsAtTomb(resolved.get(PDFName.of('D')), doc, tombstone);
  return false;
}

/** A `/GoTo` action (or a chain through `/Next`) that lands on the tombstone. */
function actionPointsAtTomb(value: unknown, doc: PDFDocument, tombstone: PDFRef): boolean {
  const action = value instanceof PDFRef ? doc.context.lookup(value) : value;
  if (!(action instanceof PDFDict)) return false;
  const kind = action.get(PDFName.of('S'));
  return (
    kind === PDFName.of('GoTo') && destPointsAtTomb(action.get(PDFName.of('D')), doc, tombstone)
  );
}

/**
 * Removes every reference to `tombstone` from `out`.
 *
 *  • A link annotation whose `/Dest` or `/GoTo` action targets a page not in the
 *    output is removed from its page — a link that goes nowhere is worse than no
 *    link, and keeping the target would mean keeping the page.
 *  • A widget that sits on a page not in the output (reached through a field's
 *    `/Kids` from a sibling that was exported) is removed from its field.
 *  • An outline item or any other dictionary loses the `/Dest`, `/A` or `/P`
 *    entry that pointed there, keeping the item itself.
 *  • Anything else — a name-tree destination, an array slot — becomes `null`.
 *
 * Returns how many references were resolved, for tests and diagnostics.
 */
export function resolvePageTombstone(out: PDFDocument, tombstone: PDFRef): number {
  let resolved = 0;
  const context = out.context;
  const dropAnnots = new Set<string>();
  const dropWidgets: { ref: PDFRef; parent: unknown }[] = [];
  const visited = new Set<PDFObject>();

  const visitDict = (dict: PDFDict, ownRef: PDFRef | undefined) => {
    const subtype = dict.get(PDFName.of('Subtype'));
    const isAnnot =
      dict.get(PDFName.of('Type')) === PDFName.of('Annot') ||
      (dict.has(PDFName.of('Rect')) && subtype instanceof PDFName);

    if (isAnnot && ownRef) {
      const linksAway =
        destPointsAtTomb(dict.get(PDFName.of('Dest')), out, tombstone) ||
        actionPointsAtTomb(dict.get(PDFName.of('A')), out, tombstone);
      if (linksAway && subtype === PDFName.of('Link')) dropAnnots.add(ownRef.toString());
      if (subtype === PDFName.of('Widget') && isTomb(dict.get(PDFName.of('P')), tombstone)) {
        dropWidgets.push({ ref: ownRef, parent: dict.get(PDFName.of('Parent')) });
      }
    }

    if (destPointsAtTomb(dict.get(PDFName.of('Dest')), out, tombstone)) {
      dict.delete(PDFName.of('Dest'));
      resolved += 1;
    }
    if (actionPointsAtTomb(dict.get(PDFName.of('A')), out, tombstone)) {
      dict.delete(PDFName.of('A'));
      resolved += 1;
    }
    for (const [key, value] of dict.entries()) {
      if (isTomb(value, tombstone)) {
        dict.delete(key);
        resolved += 1;
      } else {
        visit(value, undefined);
      }
    }
  };

  const visit = (value: unknown, ownRef: PDFRef | undefined): void => {
    if (value instanceof PDFRef || value === undefined || value === null) return;
    if (!(value instanceof PDFDict || value instanceof PDFArray || value instanceof PDFStream)) {
      return;
    }
    if (visited.has(value)) return;
    visited.add(value);
    if (value instanceof PDFStream) {
      visitDict(value.dict, ownRef);
      return;
    }
    if (value instanceof PDFDict) {
      visitDict(value, ownRef);
      return;
    }
    for (let i = 0; i < value.size(); i++) {
      const entry = value.get(i);
      if (isTomb(entry, tombstone)) {
        value.set(i, PDFNull);
        resolved += 1;
      } else {
        visit(entry, undefined);
      }
    }
  };

  for (const [ref, object] of context.enumerateIndirectObjects()) visit(object, ref);

  if (dropAnnots.size > 0) {
    for (const page of out.getPages()) {
      const annots = page.node.Annots();
      if (!annots) continue;
      const kept = PDFArray.withContext(context);
      let changed = false;
      for (let i = 0; i < annots.size(); i++) {
        const entry = annots.get(i);
        if (entry instanceof PDFRef && dropAnnots.has(entry.toString())) {
          changed = true;
          continue;
        }
        kept.push(entry);
      }
      if (changed) page.node.set(PDFName.of('Annots'), kept);
    }
    resolved += dropAnnots.size;
  }

  for (const { ref, parent } of dropWidgets) {
    const parentDict = parent instanceof PDFRef ? context.lookup(parent) : parent;
    if (!(parentDict instanceof PDFDict)) continue;
    const kids = parentDict.lookupMaybe(PDFName.of('Kids'), PDFArray);
    if (!kids) continue;
    for (let i = kids.size() - 1; i >= 0; i--) {
      const kid = kids.get(i);
      if (kid instanceof PDFRef && kid.toString() === ref.toString()) kids.remove(i);
    }
    resolved += 1;
  }

  return resolved;
}

/**
 * Deletes every indirect object no longer reachable from the trailer.
 *
 * pdf-lib's `save()` writes the whole object table, not the live reference
 * graph, so "removed" content survives in the bytes of any document this worker
 * mutates rather than rebuilds. On the redaction path that is not untidiness,
 * it is a failed redaction: the string is still in the file. Reachability is
 * walked from the catalog and the trailer's own entries, so nothing a viewer
 * could ever reach is collected.
 *
 * Callers holding pdf-lib embeddables (fonts, images, embedded pages) must
 * `flush()` first: their objects are only linked into the graph at flush time,
 * and an embedded page's copied content streams would otherwise look
 * unreachable and be deleted from under it.
 */
export function sweepUnreachableObjects(doc: PDFDocument): number {
  const context = doc.context;
  const reachable = new Set<string>();
  const queue: unknown[] = [doc.catalog];

  const trailer = context.trailerInfo as unknown as Record<string, unknown>;
  for (const key of ['Root', 'Info', 'Encrypt', 'ID']) {
    if (trailer[key] !== undefined) queue.push(trailer[key]);
  }

  while (queue.length > 0) {
    const item = queue.pop();
    if (item instanceof PDFRef) {
      const key = item.toString();
      if (reachable.has(key)) continue;
      reachable.add(key);
      const target = context.lookup(item);
      if (target !== undefined) queue.push(target);
      continue;
    }
    if (item instanceof PDFStream) {
      queue.push(item.dict);
      continue;
    }
    if (item instanceof PDFDict) {
      for (const [, value] of item.entries()) queue.push(value);
      continue;
    }
    if (item instanceof PDFArray) {
      for (let i = 0; i < item.size(); i++) queue.push(item.get(i));
    }
  }

  // `indirectObjects` is private on PDFContext, but the underlying Map is the
  // only way to remove an object without rebuilding the context.
  const objects = (context as unknown as { indirectObjects: Map<PDFRef, unknown> }).indirectObjects;
  let removed = 0;
  for (const ref of [...objects.keys()]) {
    if (reachable.has(ref.toString())) continue;
    objects.delete(ref);
    removed += 1;
  }
  return removed;
}
