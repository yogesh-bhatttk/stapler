/**
 * DOC-01 — the document model and workspace store.
 *
 * A `StaplerDoc` is the *workspace* view of a document: an ordered list of
 * `PageRef`s pointing into source documents' bytes. Merging never copies bytes; it
 * appends refs. That is what makes reordering a 300-page merge cheap.
 *
 * Session persistence of *this* module's own signals was removed here on
 * purpose, and stayed removed: the previous version ran a debounced effect
 * that wrote every open document — `bytes` included — into IndexedDB on any
 * change, so reordering one page structured-cloned every byte of every open
 * file. On the 100MB fixture that is a multi-second main-thread stall and a
 * quota error. Recents are handled by persisting file *handles* (F-06/DS-05),
 * which is what the plan specifies.
 *
 * DOC-11's session recovery (`core/session-recovery.ts`) is not that feature
 * revived: it persists `documents`/`sources` exactly as they sit here — page
 * lists, source ids, rotations, never a byte array — which is why it can
 * afford to do so on every commit rather than never. Document bytes live in
 * OPFS (`opfs.ts`), keyed by source id, and already survive a reload on their
 * own; recovery only restores the pointers that say which OPFS files matter.
 */
import { batch, computed, signal } from '@preact/signals';
import { commit, forgetDocumentInHistory, historySourceRefCount } from './history';
import { normalizeRotation } from './rotation';
import { pruneRenderHandles } from './render-cache';
import { deleteSourceBytes, readSourceBytes } from './opfs';
import { logEvent } from './errors';
import { sideBySideSourceId } from '../ui/tools/side-by-side/state';
import { compareSettings } from '../ui/tools/compare/state';
import { cropBoxes, type CropBox } from '../ui/tools/crop/state';
// Aliased: this module already declares its own, unrelated `Annotation`
// (form/signature marks on `doc.annotations`) — `annotate/state.ts`'s is the
// Annotate tool's freehand/highlight/etc. marks, keyed by page in
// `pageAnnotations`, a different concept that happens to share a name.
import { pageAnnotations, type Annotation as PageAnnotation } from '../ui/tools/annotate/state';
export interface PageRef {
  /** Stable across reorders, so thumbnails and selection survive a move. */
  key: string;
  sourceDocId: string;
  sourceIndex: number;
  /** Always one of 0, 90, 180, 270 — see {@link normalizeRotation}. */
  rotation: number;
}

export interface Annotation {
  id: string;
  pageKey: string;
  type: 'signature' | 'text' | 'date' | 'check' | 'form-text' | 'form-checkbox' | 'form-radio';
  fieldName?: string;
  exportValue?: string;
  /** Normalised to the page, origin top-left. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Clockwise rotation in degrees (e.g. 0 to 359). */
  rotation?: number;
  /** Signature id, or the literal text for text/date stamps. */
  data: string;
}

export interface SourceDocument {
  id: string;
  name: string;
  pageCount: number;
  /** Unrotated page sizes in points, for correct thumbnail aspect ratios. */
  pageSizes: { width: number; height: number }[];
  /**
   * The `/P` permission flags this file was imported with, when it restricted
   * printing/copying/modifying but opened with no password (`DocumentFacts`).
   *
   * Recorded per *source*, not per document, because a merge can mix a
   * restricted file with an unrestricted one and the result has to keep the
   * restriction — see {@link documentRestrictions}. Absent means "nothing to
   * preserve", which is the overwhelmingly common case.
   */
  restrictions?: number;
}

export interface StaplerDoc {
  id: string;
  name: string;
  pages: PageRef[];
  annotations: Annotation[];
  dirty: boolean;
  /**
   * The file handle this document was opened from, when the platform can write
   * back to it (DOC-05, save-over-original). Only ever set for a document opened
   * from exactly one file — a merge or an insert produces a document that no
   * longer corresponds to any single file on disk, so it is not carried forward
   * by those operations.
   */
  sourceHandle?: { fileId: string; writable: boolean };
  /**
   * `pages` as of the last import or successful save — what a "before" export
   * review diffs against, so rotate/reorder/delete/duplicate (which mutate
   * `pages` immediately, long before Export is clicked) show up as real changes
   * instead of being baked equally into both sides of the diff. Refreshed only
   * by `refreshBaseline`, never by `mutateDoc` — it is not a user edit and must
   * not push undo history or flip `dirty`.
   */
  baseline: PageRef[];
}

/** Workspace documents — what the file tabs show. */
export const documents = signal<StaplerDoc[]>([]);

/**
 * Drops `cropBoxes`/`pageAnnotations` entries for page keys that are no
 * longer reachable from any open document's `pages` *or* `baseline` (a
 * discard/export-review diff can still reach a baseline-only page). Called
 * from `deletePages` and `closeDocument` — the two mutators that can make a
 * page key unreachable — with the keys each is about to orphan; undo/redo
 * needs no equivalent, since every snapshot already carries its own full copy
 * of both maps (`history.ts`), independent of what the live signal holds.
 */
function pruneOrphanedPageState(candidateKeys: Iterable<string>): void {
  const stillLive = new Set<string>();
  for (const doc of documents.value) {
    for (const page of doc.pages) stillLive.add(page.key);
    for (const page of doc.baseline ?? []) stillLive.add(page.key);
  }
  const toDrop = new Set<string>();
  for (const key of candidateKeys) {
    if (!stillLive.has(key)) toDrop.add(key);
  }
  if (toDrop.size === 0) return;
  if (Object.keys(cropBoxes.value).some(key => toDrop.has(key))) {
    const next = { ...cropBoxes.value };
    for (const key of toDrop) delete next[key];
    cropBoxes.value = next;
  }
  if (Object.keys(pageAnnotations.value).some(key => toDrop.has(key))) {
    const next = { ...pageAnnotations.value };
    for (const key of toDrop) delete next[key];
    pageAnnotations.value = next;
  }
}

/**
 * Byte sources, keyed by id. Separate from `documents` so a source can back pages
 * in several workspace documents without being a tab itself — the previous version
 * pushed every imported file into `documents`, so merging five PDFs opened five
 * extra tabs the user then had to close.
 */
export const sources = signal<Record<string, SourceDocument>>({});

/**
 * Original raw image File(s) behind a source, when it was built by importing
 * image(s) directly rather than opening a PDF. Lets the standalone "Images to
 * PDF" tool (CNV-01) offer to reuse an image the user already has open as a
 * document instead of asking them to re-pick the same file from disk — the
 * confusing alternative being a document that visibly holds the image while
 * the tool insists none was added. Deliberately not a signal and never
 * persisted: unlike `sources`, session recovery has no need to survive a
 * reload with these, and a `File` handle is cheap to keep for the tab's
 * lifetime.
 */
const sourceOriginalFiles = new Map<string, File[]>();

export function getSourceOriginalFiles(sourceId: string): File[] | undefined {
  return sourceOriginalFiles.get(sourceId);
}

export const activeDocId = signal<string | null>(null);
export const selectedPageKeys = signal<Set<string>>(new Set());

export const activeDoc = computed(
  () => documents.value.find(d => d.id === activeDocId.value) ?? null
);

/** Sources actually referenced by the active document, in first-use order. */
export const activeSources = computed<SourceDocument[]>(() => {
  const doc = activeDoc.value;
  if (!doc) return [];
  // Use a Set for O(1) membership tests — Array.includes() is O(n) per call,
  // making the previous loop O(n²) over pages.
  const seen = new Set<string>();
  const order: string[] = [];
  for (const page of doc.pages) {
    if (!seen.has(page.sourceDocId)) {
      seen.add(page.sourceDocId);
      order.push(page.sourceDocId);
    }
  }
  return order.map(id => sources.value[id]).filter((s): s is SourceDocument => Boolean(s));
});

/**
 * The `/P` flags an export of this document still has to carry, or `null`.
 *
 * Every source the document's pages come from contributes: a source with no
 * restrictions denies nothing (`-4`, all permission bits set), so ANDing the
 * lot yields the union of every restriction in the file. Merging a restricted
 * document into an unrestricted one therefore keeps the restriction rather
 * than laundering it away, which is the conservative reading and the only one
 * that cannot lose a protection the user never asked to drop.
 *
 * `null` when no contributing source was restricted — the common case, and the
 * one where the export must come out byte-identical to what it was before any
 * of this existed. Note that this deliberately answers for the *document*, not
 * for a page range: an extract of pages that all came from the unrestricted
 * half of a merge still carries the restriction.
 */
export function documentRestrictions(doc: StaplerDoc): number | null {
  let combined: number | null = null;
  const seen = new Set<string>();
  for (const page of doc.pages) {
    if (seen.has(page.sourceDocId)) continue;
    seen.add(page.sourceDocId);
    const restrictions = sources.value[page.sourceDocId]?.restrictions;
    if (restrictions === undefined) continue;
    combined = combined === null ? restrictions : combined & restrictions;
  }
  return combined;
}

export function registerSource(source: SourceDocument, originalFiles?: File[]): void {
  sources.value = { ...sources.value, [source.id]: source };
  if (originalFiles && originalFiles.length > 0) {
    sourceOriginalFiles.set(source.id, originalFiles);
  }
}

/* ---------------- source reference counting ---------------- */

/**
 * How many `PageRef`s, across **every** currently-open document, point at each
 * source id.
 *
 * Derived from `documents` rather than maintained by hand at each mutation site.
 * That is the whole point: a manual counter has to be incremented in
 * `registerSource`, `repointPage`, `replaceWithSource`, `insertPages`,
 * `appendPages`, `deletePages`, `duplicatePages`, `closeDocument` *and* every
 * future one, and the failure mode of forgetting one is an over-count (a
 * permanently un-transferable source, harmless) or an under-count (a detached
 * buffer under a live document, catastrophic). A computed cannot drift.
 */
export const sourceRefCounts = computed<Record<string, number>>(() => {
  const counts: Record<string, number> = {};
  for (const doc of documents.value) {
    for (const page of doc.pages) {
      counts[page.sourceDocId] = (counts[page.sourceDocId] ?? 0) + 1;
    }
  }
  return counts;
});

/**
 * How many distinct open documents reference each source id.
 *
 * This, not {@link sourceRefCounts}, is the number that matters for buffer
 * ownership: all N pages of one document resolve through the *same*
 * `sources[id].bytes` object, so ten pages in one document are one owner, while
 * one page each in two documents are two.
 */
export const sourceDocRefCounts = computed<Record<string, number>>(() => {
  const counts: Record<string, number> = {};
  for (const doc of documents.value) {
    const seen = new Set<string>();
    for (const page of doc.pages) {
      if (seen.has(page.sourceDocId)) continue;
      seen.add(page.sourceDocId);
      counts[page.sourceDocId] = (counts[page.sourceDocId] ?? 0) + 1;
    }
  }
  return counts;
});

export function sourceRefCount(sourceId: string): number {
  return sourceRefCounts.value[sourceId] ?? 0;
}

export function sourceDocRefCount(sourceId: string): number {
  return sourceDocRefCounts.value[sourceId] ?? 0;
}

/**
 * ANN-07 — frees a source's bytes and registry entry once nothing references
 * it: no workspace document page, and it is no longer the side-by-side or
 * Compare comparison source either. Meant to be called with the *previous*
 * `sideBySideSourceId`/`compareSettings.compareSourceId` right before it is
 * replaced — `closeDocument` already does the equivalent check for a closed
 * tab, but switching the comparison file never went through `closeDocument`
 * at all, so its old source was simply orphaned (never released) every time
 * the user picked a different file to compare against.
 */
export function releaseSourceIfUnused(sourceId: string): void {
  if (
    sourceRefCount(sourceId) > 0 ||
    sideBySideSourceId.value === sourceId ||
    compareSettings.value.compareSourceId === sourceId
  )
    return;
  if (!(sourceId in sources.value)) return;
  const rest = { ...sources.value };
  delete rest[sourceId];
  sources.value = rest;
  sourceOriginalFiles.delete(sourceId);
  deleteSourceBytes(sourceId).catch(() => {});
}

/** Every place that can still read a source's bytes after the current call. */
export interface SourceOwners {
  /** `PageRef`s across all open documents. */
  pages: number;
  /** Distinct open documents. */
  documents: number;
  /** Occurrences in the undo/redo snapshots — see `historySourceRefCount`. */
  history: number;
  /** A pdf.js handle in the render worker keyed on this exact byte array. */
  renderHandle: boolean;
}

export function sourceOwners(sourceId: string): SourceOwners {
  return {
    pages: sourceRefCount(sourceId),
    documents: sourceDocRefCount(sourceId),
    history: historySourceRefCount(sourceId),
    renderHandle: false // Obsolete with OPFS
  };
}

/** Bytes for every source the given pages refer to, and nothing else. */
export async function bytesForPages(pages: PageRef[]): Promise<Record<string, Uint8Array>> {
  const ids = new Set<string>();
  for (const page of pages) {
    if (sources.value[page.sourceDocId]) ids.add(page.sourceDocId);
  }
  const out: Record<string, Uint8Array> = {};
  await Promise.all(
    [...ids].map(async id => {
      out[id] = await readSourceBytes(id);
    })
  );
  return out;
}

export function makePageRefs(sourceDocId: string, pageCount: number): PageRef[] {
  return Array.from({ length: pageCount }, (_, i) => ({
    key: crypto.randomUUID(),
    sourceDocId,
    sourceIndex: i,
    rotation: 0
  }));
}

export function addDocument(doc: Omit<StaplerDoc, 'baseline'>): void {
  batch(() => {
    documents.value = [...documents.value, { ...doc, baseline: doc.pages }];
    activeDocId.value = doc.id;
    if (selectedPageKeys.value.size > 0) selectedPageKeys.value = new Set();
    activePageIndex.value = 0;
  });
}

export function switchDocument(id: string): void {
  const target = documents.value.find(d => d.id === id);
  if (!target) return;
  batch(() => {
    activeDocId.value = id;
    if (selectedPageKeys.value.size > 0) selectedPageKeys.value = new Set();
    activePageIndex.value = Math.max(0, Math.min(activePageIndex.value, target.pages.length - 1));
  });
}

/**
 * Re-anchors the "before" an export review diffs against to the page list just
 * written to disk. Called only from `save()`'s two success paths (commit.ts) —
 * not a user edit, so it bypasses `mutateDoc`/`commit()` on purpose: it must not
 * flip `dirty` or push an undo entry.
 */
export function refreshBaseline(docId: string, pages: PageRef[]): void {
  documents.value = documents.value.map(d => (d.id === docId ? { ...d, baseline: pages } : d));
}

export function closeDocument(id: string): void {
  const closed = documents.value.find(d => d.id === id);
  batch(() => {
    documents.value = documents.value.filter(d => d.id !== id);
    if (activeDocId.value === id) {
      const nextDoc = documents.value[0];
      activeDocId.value = nextDoc?.id ?? null;
      if (selectedPageKeys.value.size > 0) selectedPageKeys.value = new Set();
      if (nextDoc) {
        activePageIndex.value = Math.max(
          0,
          Math.min(activePageIndex.value, nextDoc.pages.length - 1)
        );
      }
    }
  });
  // Drop sources nothing references any more, so closing a tab frees its bytes.
  // ANN-07's side-by-side comparison document, and Compare's own comparison
  // document, are sources that live outside every `StaplerDoc.pages` array —
  // neither is ever a workspace tab — so they have to be named explicitly
  // here or closing any unrelated tab deletes their OPFS bytes and closes
  // their render handle out from under an open comparison view.
  const stillUsed = new Set(
    documents.value.flatMap(d => [...d.pages, ...d.baseline].map(p => p.sourceDocId))
  );
  if (sideBySideSourceId.value) stillUsed.add(sideBySideSourceId.value);
  if (compareSettings.value.compareSourceId) stillUsed.add(compareSettings.value.compareSourceId);
  const kept: Record<string, SourceDocument> = {};
  for (const [key, value] of Object.entries(sources.value)) {
    if (stillUsed.has(key)) {
      kept[key] = value;
    } else {
      sourceOriginalFiles.delete(key);
      deleteSourceBytes(key).catch(err =>
        logEvent('warn', 'store', `Failed to delete source bytes for ${key}: ${String(err)}`)
      );
    }
  }
  sources.value = kept;
  pruneRenderHandles(stillUsed);
  clearPageSelection();
  if (closed) {
    pruneOrphanedPageState([...closed.pages, ...(closed.baseline ?? [])].map(p => p.key));
  }
  // A snapshot that still holds this document would otherwise point at the
  // source bytes just freed above — but only *this* document's entries are
  // invalid, not the other open documents' undo/redo history, so this trims
  // just those instead of wiping every open document's history via
  // resetHistory() (which remains reserved for the workspace actually being
  // replaced wholesale, e.g. on session load).
  forgetDocumentInHistory(id);
}

/** Applies `mutate` to one document and marks it dirty. */
function mutateDoc(docId: string, mutate: (doc: StaplerDoc) => StaplerDoc): void {
  documents.value = documents.value.map(doc =>
    doc.id === docId ? { ...mutate(doc), dirty: true } : doc
  );
}

export function renameDocument(docId: string, name: string): void {
  commit();
  mutateDoc(docId, doc => ({ ...doc, name }));
}

export function deletePages(docId: string, pageKeys: Iterable<string>): void {
  const keys = new Set(pageKeys);
  if (keys.size === 0) return;
  const doc = documents.value.find(d => d.id === docId);
  const activeKey =
    doc && activeDocId.value === docId ? doc.pages[activePageIndex.value]?.key : undefined;

  // A PDF must have at least one page; deleting every last one closes the
  // document instead of creating an invalid zero-page PDF.
  if (doc && keys.size >= doc.pages.length && doc.pages.every(p => keys.has(p.key))) {
    closeDocument(docId);
    return;
  }

  commit();
  batch(() => {
    let remainingCount = 0;
    mutateDoc(docId, d => {
      const pages = d.pages.filter(p => !keys.has(p.key));
      remainingCount = pages.length;
      return { ...d, pages };
    });
    selectedPageKeys.value = new Set([...selectedPageKeys.value].filter(key => !keys.has(key)));
    pruneOrphanedPageState(keys);
    // `activePageIndex` indexes into whichever document is active and is not
    // itself reset by this mutation — left unclamped, a delete that shrinks the
    // page array below the current index leaves it pointing out of bounds,
    // which several consumers (`Canvas.tsx`, `CropPanel.tsx`, `CropOverlay.tsx`,
    // `operations.ts`) index into without their own bounds check.
    if (activeDocId.value === docId) {
      let newIndex = -1;
      mutateDoc(docId, d => {
        newIndex = d.pages.findIndex(p => p.key === activeKey);
        return d;
      });
      if (newIndex !== -1) {
        activePageIndex.value = newIndex;
      } else {
        activePageIndex.value = Math.min(activePageIndex.value, Math.max(0, remainingCount - 1));
      }
    }
  });
}

export function deletePage(docId: string, pageKey: string): void {
  deletePages(docId, [pageKey]);
}

function rotateDocAnnotation(a: Annotation, delta: number): Annotation {
  const rotation = normalizeRotation(delta);
  if (rotation === 0) return a;
  let { x, y, width, height } = a;
  if (rotation === 90) {
    x = 1 - (a.y + a.height);
    y = a.x;
    width = a.height;
    height = a.width;
  } else if (rotation === 180) {
    x = 1 - (a.x + a.width);
    y = 1 - (a.y + a.height);
  } else if (rotation === 270) {
    x = a.y;
    y = 1 - (a.x + a.width);
    width = a.height;
    height = a.width;
  }
  return {
    ...a,
    x,
    y,
    width,
    height,
    rotation: normalizeRotation((a.rotation ?? 0) + rotation)
  };
}

function rotatePageAnnotation(a: PageAnnotation, delta: number): PageAnnotation {
  const rotation = normalizeRotation(delta);
  if (rotation === 0) return a;
  const out = { ...a };
  if (out.rect) {
    let { x, y, width, height } = out.rect;
    if (rotation === 90) {
      x = 1 - (out.rect.y + out.rect.height);
      y = out.rect.x;
      width = out.rect.height;
      height = out.rect.width;
    } else if (rotation === 180) {
      x = 1 - (out.rect.x + out.rect.width);
      y = 1 - (out.rect.y + out.rect.height);
    } else if (rotation === 270) {
      x = out.rect.y;
      y = 1 - (out.rect.x + out.rect.width);
      width = out.rect.height;
      height = out.rect.width;
    }
    out.rect = { x, y, width, height };
  }
  if (out.points) {
    out.points = out.points.map(p => {
      if (rotation === 90) return { x: 1 - p.y, y: p.x };
      if (rotation === 180) return { x: 1 - p.x, y: 1 - p.y };
      if (rotation === 270) return { x: p.y, y: 1 - p.x };
      return p;
    });
  }
  return out;
}

export function rotatePages(docId: string, pageKeys: Iterable<string>, delta: number): void {
  const keys = new Set(pageKeys);
  if (keys.size === 0) return;

  const newCropBoxes = { ...cropBoxes.value };
  let cropBoxesChanged = false;
  for (const key of keys) {
    const box = newCropBoxes[key];
    if (box) {
      const rotation = normalizeRotation(delta);
      if (rotation !== 0) {
        let { x, y, width, height } = box;
        if (rotation === 90) {
          x = 1 - (box.y + box.height);
          y = box.x;
          width = box.height;
          height = box.width;
        } else if (rotation === 180) {
          x = 1 - (box.x + box.width);
          y = 1 - (box.y + box.height);
        } else if (rotation === 270) {
          x = box.y;
          y = 1 - (box.x + box.width);
          width = box.height;
          height = box.width;
        }
        newCropBoxes[key] = { x, y, width, height };
        cropBoxesChanged = true;
      }
    }
  }

  const newPageAnnotations = { ...pageAnnotations.value };
  let pageAnnotationsChanged = false;
  for (const key of keys) {
    const annotations = newPageAnnotations[key];
    if (annotations && annotations.length > 0) {
      newPageAnnotations[key] = annotations.map(a => rotatePageAnnotation(a, delta));
      pageAnnotationsChanged = true;
    }
  }

  commit();
  batch(() => {
    mutateDoc(docId, doc => ({
      ...doc,
      pages: doc.pages.map(p =>
        // A plain `%` produced -90 when rotating anticlockwise from 0, which is not
        // a legal /Rotate value.
        keys.has(p.key) ? { ...p, rotation: normalizeRotation(p.rotation + delta) } : p
      ),
      annotations: doc.annotations.map(a =>
        keys.has(a.pageKey) ? rotateDocAnnotation(a, delta) : a
      )
    }));
    if (cropBoxesChanged) cropBoxes.value = newCropBoxes;
    if (pageAnnotationsChanged) pageAnnotations.value = newPageAnnotations;
  });
}

/**
 * Reverts this document's page list to its baseline — rotate/reorder/delete/
 * duplicate made since the last import or save are discarded. Routed through
 * `mutateDoc` like any other page mutation, so it pushes a normal undo entry;
 * the tool-level settings (crop/watermark/outline/redaction/annotations) a
 * "discard all changes" action also clears are not page-scoped and are reset
 * separately, by the caller.
 */
export function discardPageChanges(docId: string): void {
  commit();
  mutateDoc(docId, doc => ({ ...doc, pages: doc.baseline }));
}

export function rotatePage(docId: string, pageKey: string, delta: number): void {
  rotatePages(docId, [pageKey], delta);
}

export function duplicatePages(docId: string, pageKeys: Iterable<string>): void {
  const keys = new Set(pageKeys);
  if (keys.size === 0) return;
  commit();
  // Collected while walking `doc.pages` below and applied to `cropBoxes`/
  // `pageAnnotations` afterwards — those are separate signals keyed by page
  // key, not part of `PageRef` itself, so spreading `page` into the duplicate
  // (which is what already carries rotation forward, since that *is* a
  // `PageRef` field) does nothing for them on its own. Left uncopied, a
  // duplicate of a cropped or annotated page would silently start out
  // uncropped and unannotated — every other page property survives
  // duplication, so this one not surviving reads as data loss, not a
  // deliberate "duplicates start clean" design.
  const newCropBoxes: Record<string, CropBox> = {};
  const newAnnotations: Record<string, PageAnnotation[]> = {};
  batch(() => {
    mutateDoc(docId, doc => {
      const pages: PageRef[] = [];
      for (const page of doc.pages) {
        pages.push(page);
        // A duplicate is a new ref to the same source page, with its own key so
        // selection and thumbnails treat the two independently.
        if (keys.has(page.key)) {
          const newKey = crypto.randomUUID();
          pages.push({ ...page, key: newKey });
          const crop = cropBoxes.value[page.key];
          if (crop) newCropBoxes[newKey] = crop;
          const annotations = pageAnnotations.value[page.key];
          if (annotations?.length) {
            // Fresh ids too, not just a new map key — these are meant to be
            // independent marks on independent pages from here on, and a
            // shared id could confuse any lookup that expects ids to be unique
            // across the document.
            newAnnotations[newKey] = annotations.map(a => ({
              ...a,
              id: crypto.randomUUID(),
              pageKey: newKey
            }));
          }
        }
      }
      return { ...doc, pages };
    });
    if (Object.keys(newCropBoxes).length > 0) {
      cropBoxes.value = { ...cropBoxes.value, ...newCropBoxes };
    }
    if (Object.keys(newAnnotations).length > 0) {
      pageAnnotations.value = { ...pageAnnotations.value, ...newAnnotations };
    }
  });
}

/**
 * Moves `pageKeys` so they sit before the page currently at `toIndex`, preserving
 * their relative order. Handles multi-page moves, which the old single-index
 * splice could not.
 */
export function movePages(docId: string, pageKeys: Iterable<string>, toIndex: number): void {
  const keys = new Set(pageKeys);
  if (keys.size === 0) return;
  commit();
  batch(() => {
    let newIndex = activePageIndex.value;
    mutateDoc(docId, doc => {
      const activeKey = doc.pages[activePageIndex.value]?.key;
      const moving = doc.pages.filter(p => keys.has(p.key));
      const rest = doc.pages.filter(p => !keys.has(p.key));
      // Count how many of the moved pages were before the target, so the insertion
      // point still refers to the same visual gap after removal.
      const removedBefore = doc.pages.slice(0, toIndex).filter(p => keys.has(p.key)).length;
      const at = Math.max(0, Math.min(rest.length, toIndex - removedBefore));
      const newPages = [...rest.slice(0, at), ...moving, ...rest.slice(at)];

      if (activeKey) {
        const found = newPages.findIndex(p => p.key === activeKey);
        if (found !== -1) newIndex = found;
      }
      return { ...doc, pages: newPages };
    });
    if (activeDocId.value === docId) {
      activePageIndex.value = newIndex;
    }
  });
}

export function movePage(docId: string, fromIndex: number, toIndex: number): void {
  const doc = documents.value.find(d => d.id === docId);
  const page = doc?.pages[fromIndex];
  if (!page) return;
  movePages(docId, [page.key], toIndex);
}

/** Inserts pages from a registered source at `insertIndex`. */
export function insertPages(docId: string, pages: PageRef[], insertIndex: number): void {
  if (pages.length === 0) return;
  commit();
  mutateDoc(docId, doc => {
    const at = Math.max(0, Math.min(doc.pages.length, insertIndex));
    return { ...doc, pages: [...doc.pages.slice(0, at), ...pages, ...doc.pages.slice(at)] };
  });
}

export function appendPages(docId: string, pages: PageRef[]): void {
  const doc = documents.value.find(d => d.id === docId);
  insertPages(docId, pages, doc?.pages.length ?? 0);
}

/**
 * Carries a document's import-time permission flags onto a source built by
 * rewriting its bytes.
 *
 * Redaction and scan cleanup hand back a brand-new source whose bytes came out
 * of Stapler in the clear, so it carries no `/Encrypt` of its own. Without
 * this, redacting a print-restricted document would be the one way to strip
 * its restrictions: the source that knew about them is dropped in the same
 * call that registers the replacement.
 */
function carryRestrictions(docId: string, source: SourceDocument): SourceDocument {
  if (source.restrictions !== undefined) return source;
  const doc = documents.value.find(d => d.id === docId);
  const inherited = doc ? documentRestrictions(doc) : null;
  return inherited === null ? source : { ...source, restrictions: inherited };
}

/**
 * Replaces a document's pages with a single new source — used when an operation
 * rewrites the bytes (redaction, scan cleanup) rather than rearranging pages.
 */
export function replaceWithSource(docId: string, source: SourceDocument): void {
  commit();
  registerSource(carryRestrictions(docId, source));
  mutateDoc(docId, doc => {
    const pages = makePageRefs(source.id, source.pageCount);
    return {
      ...doc,
      pages,
      // Stamps were baked into the new bytes, so keeping them would draw them twice.
      annotations: [],
      // This document was just wholly rebuilt (redact/face-blur) with brand new
      // page keys — already confirmed by the caller's own "verified and applied"
      // notice. Re-anchoring here means the next export review diffs against
      // *this*, not against a baseline whose keys no longer exist anywhere,
      // which would otherwise show every page as removed-and-re-added.
      baseline: pages
    };
  });
  clearPageSelection();
}

/**
 * Repoints one page at a different source, keeping its position and its key.
 *
 * Used by scan cleanup, which rewrites a single page's pixels: the page must keep its
 * identity so selection, stamps, and undo continue to refer to the same thing.
 *
 * `sourceIndex` is which page of the new source this ref should point at. It used to
 * be hardcoded to 0, which is right only when the new source is a single-page
 * document: repointing page 5 at a rebuilt *whole* document made page 5 display, and
 * export, the rebuilt document's page 1.
 */
export function repointPage(
  docId: string,
  pageKey: string,
  sourceId: string,
  sourceIndex = 0
): void {
  commit();
  // Same reasoning as `replaceWithSource`: the rewritten page's new source was
  // written in the clear, and on a single-page document it is the *only*
  // source left once this repoint lands.
  const rewritten = sources.value[sourceId];
  if (rewritten) registerSource(carryRestrictions(docId, rewritten));
  mutateDoc(docId, doc => ({
    ...doc,
    pages: doc.pages.map(p =>
      p.key === pageKey ? { ...p, sourceDocId: sourceId, sourceIndex, rotation: 0 } : p
    )
  }));
}

/* ---------------- selection ---------------- */

export function setPageSelection(keys: Iterable<string>): void {
  selectedPageKeys.value = new Set(keys);
}

export function togglePageSelection(pageKey: string): void {
  const next = new Set(selectedPageKeys.value);
  if (next.has(pageKey)) next.delete(pageKey);
  else next.add(pageKey);
  selectedPageKeys.value = next;
}

export function clearPageSelection(): void {
  if (selectedPageKeys.value.size > 0) selectedPageKeys.value = new Set();
}

export function selectAllPages(docId: string): void {
  const doc = documents.value.find(d => d.id === docId);
  if (doc) setPageSelection(doc.pages.map(p => p.key));
}

/** Inclusive range select, for shift-click in the grid (DOC-04). */
export function selectPageRange(docId: string, fromKey: string, toKey: string): void {
  const doc = documents.value.find(d => d.id === docId);
  if (!doc) return;
  const a = doc.pages.findIndex(p => p.key === fromKey);
  const b = doc.pages.findIndex(p => p.key === toKey);
  if (a < 0 || b < 0) return;
  const [start, end] = a <= b ? [a, b] : [b, a];
  setPageSelection(doc.pages.slice(start, end + 1).map(p => p.key));
}

/* ---------------- annotations ---------------- */

export function addAnnotation(docId: string, annotation: Annotation): void {
  commit();
  mutateDoc(docId, doc => ({ ...doc, annotations: [...doc.annotations, annotation] }));
}

export function updateAnnotation(
  docId: string,
  annotationId: string,
  updates: Partial<Annotation>
): void {
  // A drag calls this on every pointer move; `commit` collapses them into the one
  // entry opened by the caller's transaction.
  commit();
  mutateDoc(docId, doc => ({
    ...doc,
    annotations: doc.annotations.map(a => (a.id === annotationId ? { ...a, ...updates } : a))
  }));
}

export function deleteAnnotation(docId: string, annotationId: string): void {
  commit();
  mutateDoc(docId, doc => ({
    ...doc,
    annotations: doc.annotations.filter(a => a.id !== annotationId)
  }));
}

export function duplicateAnnotationToAllPages(docId: string, annotationId: string): void {
  const doc = documents.value.find(d => d.id === docId);
  if (!doc) return;
  const sourceAnnotation = doc.annotations.find(a => a.id === annotationId);
  if (!sourceAnnotation) return;

  commit();
  mutateDoc(docId, doc => {
    const newAnnotations: Annotation[] = [];
    for (const page of doc.pages) {
      if (page.key === sourceAnnotation.pageKey) continue;
      newAnnotations.push({
        ...sourceAnnotation,
        id: crypto.randomUUID(),
        pageKey: page.key
      });
    }
    return { ...doc, annotations: [...doc.annotations, ...newAnnotations] };
  });
}

/** The currently focused page index in SinglePageView or PageGrid. */
export const activePageIndex = signal<number>(0);
