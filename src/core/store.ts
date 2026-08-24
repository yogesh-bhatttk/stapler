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
import { computed, signal } from '@preact/signals';
import { commit, historySourceRefCount, resetHistory } from './history';
import { normalizeRotation } from './rotation';
import { pruneRenderHandles } from './render-cache';
import { deleteSourceBytes, readSourceBytes } from './opfs';
import { sideBySideSourceId } from '../ui/tools/side-by-side/state';
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
}

/** Workspace documents — what the file tabs show. */
export const documents = signal<StaplerDoc[]>([]);

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
 * it: no workspace document page, and it is no longer the side-by-side
 * comparison source either. Meant to be called with the *previous*
 * `sideBySideSourceId` right before it is replaced — `closeDocument` already
 * does the equivalent check for a closed tab, but switching the side-by-side
 * comparison file never went through `closeDocument` at all, so its old
 * source was simply orphaned (never released) every time the user picked a
 * different file to compare against.
 */
export function releaseSourceIfUnused(sourceId: string): void {
  if (sourceRefCount(sourceId) > 0 || sideBySideSourceId.value === sourceId) return;
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
  const out: Record<string, Uint8Array> = {};
  for (const page of pages) {
    const source = sources.value[page.sourceDocId];
    if (source && !out[page.sourceDocId]) {
      out[page.sourceDocId] = await readSourceBytes(page.sourceDocId);
    }
  }
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

export function addDocument(doc: StaplerDoc): void {
  documents.value = [...documents.value, doc];
  activeDocId.value = doc.id;
}

export function closeDocument(id: string): void {
  documents.value = documents.value.filter(d => d.id !== id);
  if (activeDocId.value === id) {
    activeDocId.value = documents.value[0]?.id ?? null;
  }
  // Drop sources nothing references any more, so closing a tab frees its bytes.
  // ANN-07's side-by-side comparison document is the one source that lives
  // outside every `StaplerDoc.pages` array — it is never a workspace tab — so
  // it has to be named explicitly here or closing any unrelated tab deletes
  // its OPFS bytes and closes its render handle out from under an open
  // side-by-side view.
  const stillUsed = new Set(documents.value.flatMap(d => d.pages.map(p => p.sourceDocId)));
  if (sideBySideSourceId.value) stillUsed.add(sideBySideSourceId.value);
  const kept: Record<string, SourceDocument> = {};
  for (const [key, value] of Object.entries(sources.value)) {
    if (stillUsed.has(key)) {
      kept[key] = value;
    } else {
      sourceOriginalFiles.delete(key);
      deleteSourceBytes(key).catch(() => {});
    }
  }
  sources.value = kept;
  pruneRenderHandles(stillUsed);
  clearPageSelection();
  // Reset undo/redo: the history stack is a single global list (not keyed by
  // document). Any snapshot that references the closed document's source bytes
  // is now invalid — undoing into it produces a document that cannot be exported
  // because its source bytes have been freed. A full reset is the safe choice
  // and matches what happens on import (importDocument also calls resetHistory).
  resetHistory();
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
  commit();
  mutateDoc(docId, doc => ({ ...doc, pages: doc.pages.filter(p => !keys.has(p.key)) }));
  selectedPageKeys.value = new Set([...selectedPageKeys.value].filter(key => !keys.has(key)));
}

export function deletePage(docId: string, pageKey: string): void {
  deletePages(docId, [pageKey]);
}

export function rotatePages(docId: string, pageKeys: Iterable<string>, delta: number): void {
  const keys = new Set(pageKeys);
  if (keys.size === 0) return;
  commit();
  mutateDoc(docId, doc => ({
    ...doc,
    pages: doc.pages.map(p =>
      // A plain `%` produced -90 when rotating anticlockwise from 0, which is not
      // a legal /Rotate value.
      keys.has(p.key) ? { ...p, rotation: normalizeRotation(p.rotation + delta) } : p
    )
  }));
}

export function rotatePage(docId: string, pageKey: string, delta: number): void {
  rotatePages(docId, [pageKey], delta);
}

export function duplicatePages(docId: string, pageKeys: Iterable<string>): void {
  const keys = new Set(pageKeys);
  if (keys.size === 0) return;
  commit();
  mutateDoc(docId, doc => {
    const pages: PageRef[] = [];
    for (const page of doc.pages) {
      pages.push(page);
      // A duplicate is a new ref to the same source page, with its own key so
      // selection and thumbnails treat the two independently.
      if (keys.has(page.key)) pages.push({ ...page, key: crypto.randomUUID() });
    }
    return { ...doc, pages };
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
  mutateDoc(docId, doc => {
    const moving = doc.pages.filter(p => keys.has(p.key));
    const rest = doc.pages.filter(p => !keys.has(p.key));
    // Count how many of the moved pages were before the target, so the insertion
    // point still refers to the same visual gap after removal.
    const removedBefore = doc.pages.slice(0, toIndex).filter(p => keys.has(p.key)).length;
    const at = Math.max(0, Math.min(rest.length, toIndex - removedBefore));
    return { ...doc, pages: [...rest.slice(0, at), ...moving, ...rest.slice(at)] };
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
 * Replaces a document's pages with a single new source — used when an operation
 * rewrites the bytes (redaction, scan cleanup) rather than rearranging pages.
 */
export function replaceWithSource(docId: string, source: SourceDocument): void {
  commit();
  registerSource(source);
  mutateDoc(docId, doc => ({
    ...doc,
    pages: makePageRefs(source.id, source.pageCount),
    // Stamps were baked into the new bytes, so keeping them would draw them twice.
    annotations: []
  }));
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
