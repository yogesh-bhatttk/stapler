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
import { batch, computed, effect, signal } from '@preact/signals';
import {
  commit,
  forgetDocumentInHistory,
  historySourceIds,
  historySourceRefCount,
  rebaseHistory
} from './history';
import { normalizeRotation } from './rotation';
import { checkOpenCapacity, knownSourceBytes, type OpenCapacity } from './workspace-limits';
import { pruneRenderHandles } from './render-cache';
import { setSourceLivenessCheck } from './source-liveness';
import { deleteSourceBytes, readSourceBytes } from './opfs';
import { logEvent } from './errors';
import { notify } from './notify';
import { translate } from './i18n';
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
  /**
   * AUDIT-2026-10-01 RT-1 — `annotations` as of the last successful save, so
   * undo/redo can tell whether the state it lands on differs from the file on
   * disk. Absent until the first save: every open path starts a document with
   * no annotations, so absent means `[]`.
   */
  baselineAnnotations?: Annotation[];
  /**
   * AUDIT-2026-10-10 H2 — the Crop and Annotate tools' per-page state
   * (`cropBoxes`, `pageAnnotations`) for this document's pages as of the last
   * successful save. Those two maps live outside `StaplerDoc`, so without an
   * anchor of their own neither a crop nor an Annotate mark ever made the
   * document dirty, and closing its tab lost them without a prompt. Absent
   * until the first save: every open path starts with neither, so absent
   * means "none".
   */
  baselinePageState?: PageState;
}

/** H2 — the per-page tool state an export bakes in, restricted to some page keys. */
export interface PageState {
  cropBoxes: Record<string, CropBox>;
  pageAnnotations: Record<string, PageAnnotation[]>;
}

/** Workspace documents — what the file tabs show. */
export const documents = signal<StaplerDoc[]>([]);

/** H2 — `cropBoxes`/`pageAnnotations` entries for `keys` only. */
export function pageStateFor(
  keys: Iterable<string>,
  crops: Record<string, CropBox> = cropBoxes.value,
  notes: Record<string, PageAnnotation[]> = pageAnnotations.value
): PageState {
  const state: PageState = { cropBoxes: {}, pageAnnotations: {} };
  for (const key of keys) {
    if (crops[key]) state.cropBoxes[key] = crops[key];
    if (notes[key]?.length) state.pageAnnotations[key] = notes[key];
  }
  return state;
}

/**
 * H2 — true when `pages`' crop boxes and Annotate marks in `crops`/`notes`
 * are exactly the ones `saved` recorded (absent: none at all). An empty mark
 * list and no entry are the same thing — deleting the last mark on a page
 * leaves `[]` behind, which is not an edit.
 */
export function pageStateMatches(
  pages: readonly PageRef[],
  crops: Record<string, CropBox>,
  notes: Record<string, PageAnnotation[]>,
  saved: PageState | undefined
): boolean {
  for (const { key } of pages) {
    const crop = crops[key];
    const savedCrop = saved?.cropBoxes[key];
    if (crop !== savedCrop && JSON.stringify(crop) !== JSON.stringify(savedCrop)) return false;
    const marks = notes[key]?.length ? notes[key] : undefined;
    const savedMarks = saved?.pageAnnotations[key]?.length ? saved.pageAnnotations[key] : undefined;
    if (marks !== savedMarks && JSON.stringify(marks) !== JSON.stringify(savedMarks)) return false;
  }
  return true;
}

/** Keys whose entry differs (by reference) between two keyed maps. */
function changedKeys<T>(before: Record<string, T>, after: Record<string, T>, into: Set<string>) {
  if (before === after) return;
  for (const key of Object.keys(before)) if (before[key] !== after[key]) into.add(key);
  for (const key of Object.keys(after)) if (!(key in before)) into.add(key);
}

/**
 * H2 — a crop box or Annotate mark changed on a document's page: that
 * document now has unsaved changes. Done here, once, rather than at each of
 * the many places those two maps are written (the overlays, the panels, the
 * text-search highlighter, auto-trim…), so a new writer cannot forget it.
 *
 * Only ever *sets* `dirty`. Clearing it is a save's job (`refreshBaseline`)
 * or undo/redo's (`history.ts`'s `restoredDoc`, which compares against the
 * same `baselinePageState`), and both have already written the document by
 * the time this runs — an undo that lands back on the saved crop finds the
 * state matching its baseline here and leaves the clean flag alone.
 */
let seenCropBoxes = cropBoxes.peek();
let seenPageAnnotations = pageAnnotations.peek();
effect(() => {
  const crops = cropBoxes.value;
  const notes = pageAnnotations.value;
  const changed = new Set<string>();
  changedKeys(seenCropBoxes, crops, changed);
  changedKeys(seenPageAnnotations, notes, changed);
  seenCropBoxes = crops;
  seenPageAnnotations = notes;
  if (changed.size === 0) return;
  const docs = documents.peek();
  let touched = false;
  const next = docs.map(doc => {
    if (doc.dirty || !doc.pages.some(page => changed.has(page.key))) return doc;
    if (pageStateMatches(doc.pages, crops, notes, doc.baselinePageState)) return doc;
    touched = true;
    return { ...doc, dirty: true };
  });
  if (touched) documents.value = next;
});

/**
 * Drops `cropBoxes`/`pageAnnotations` entries for page keys that are no
 * longer reachable from any open document's `pages` *or* `baseline` (a
 * discard/export-review diff can still reach a baseline-only page). Called
 * from `deletePages` and `closeDocument` — the two mutators that can make a
 * page key unreachable — with the keys each is about to orphan; undo/redo
 * needs no equivalent, since every snapshot already carries its own copy of
 * both maps' entries for that document's page keys (`history.ts`),
 * independent of what the live signal holds.
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

// AUDIT-2026-10-10 L9 — a render handle opened for a source that was closed
// meanwhile is released instead of cached forever.
setSourceLivenessCheck(sourceId => sourceId in sources.value);

export function registerSource(source: SourceDocument, originalFiles?: File[]): void {
  sources.value = { ...sources.value, [source.id]: source };
  if (originalFiles && originalFiles.length > 0) {
    sourceOriginalFiles.set(source.id, originalFiles);
  }
}

/**
 * RT-5 — sources whose bytes are written and whose registry entry exists, but
 * that no document references *yet*: an import registers each file as it
 * finishes, while the caller only adds documents (or pages, or sets the
 * comparison source) once every file in the batch is done. Without this, a
 * tab closed mid-import saw those sources as unreferenced and deleted their
 * bytes, and the documents were then added pointing at nothing.
 *
 * Plain data rather than a signal: nothing renders from it, and the only
 * reader is the GC below. `import.ts` marks and releases entries.
 */
const pendingSources = new Set<string>();

export function markSourcePending(sourceId: string): void {
  pendingSources.add(sourceId);
}

export function releasePendingSources(sourceIds: Iterable<string>): void {
  for (const id of sourceIds) pendingSources.delete(id);
}

export function isSourcePending(sourceId: string): boolean {
  return pendingSources.has(sourceId);
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
    compareSettings.value.compareSourceId === sourceId ||
    pendingSources.has(sourceId) ||
    historySourceRefCount(sourceId) > 0
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

/**
 * GAP-11b — the open-document ceiling for the workspace as it stands, given
 * `incomingDocuments` more of `incomingBytes` in total. See
 * `workspace-limits.ts`; every open path asks this before importing.
 */
export function workspaceOpenCapacity(incomingDocuments: number, incomingBytes = 0): OpenCapacity {
  return checkOpenCapacity(
    documents.value.length,
    incomingDocuments,
    knownSourceBytes(Object.keys(sources.value)),
    incomingBytes
  );
}

/**
 * Adds a document to the workspace and makes it active.
 *
 * Opening is a workspace action, not an undo step (GAP-11a, resolving
 * R-RT-6/7): the new document starts with an empty undo history of its own,
 * and no other document's history is touched. It used to be recorded as an
 * "Open document" step in the single global stack, so enough Ctrl+Z emptied
 * the workspace; closing the tab (which confirms unsaved changes) is how a
 * document is removed.
 *
 * Refused — returning false, adding nothing — when the workspace is already
 * at `MAX_OPEN_DOCUMENTS`. Callers check `workspaceOpenCapacity` first and
 * explain; this is the backstop.
 */
export function addDocument(doc: Omit<StaplerDoc, 'baseline'>): boolean {
  if (!workspaceOpenCapacity(1).ok) return false;
  batch(() => {
    documents.value = [...documents.value, { ...doc, baseline: doc.pages }];
    activeDocId.value = doc.id;
    if (selectedPageKeys.value.size > 0) selectedPageKeys.value = new Set();
    activePageIndex.value = 0;
  });
  return true;
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
export function refreshBaseline(
  docId: string,
  pages: PageRef[],
  /** The annotations that were written with `pages` — what is now on disk. */
  annotations?: Annotation[],
  /**
   * H2 — the crop boxes and Annotate marks that were written with `pages`.
   * Defaults to the live ones for those pages.
   */
  pageState?: PageState
): void {
  const doc = documents.value.find(d => d.id === docId);
  if (!doc) return;
  // The written annotations become the anchor. A caller that does not say
  // which were written gets the live ones only when the page list is still
  // the one written; otherwise the previous anchor stays.
  const baselineAnnotations =
    annotations ?? (doc.pages === pages ? doc.annotations : doc.baselineAnnotations);
  const baselinePageState = pageState ?? pageStateFor(pages.map(page => page.key));
  // A crop or mark changed while the save was in flight is still unsaved.
  const pageStateCurrent = pageStateMatches(
    pages,
    cropBoxes.value,
    pageAnnotations.value,
    baselinePageState
  );
  // RT-1 (AUDIT-2026-10-01) — undo past this save must land dirty against
  // what is now on disk, so the whole history is re-anchored here too.
  rebaseHistory(docId, pages, baselineAnnotations);
  documents.value = documents.value.map(d =>
    d.id === docId
      ? {
          ...d,
          baseline: pages,
          baselineAnnotations,
          baselinePageState,
          // RT-17 — what was just written is the document as it stands, so it
          // no longer has unsaved changes. Before, `dirty` was never cleared:
          // the dot stayed after a save and closing the tab still asked to
          // discard, which trains users to click through that prompt. Only
          // when the written pages *and* annotations are the current ones,
          // though — an edit made while the save was in flight (an annotation
          // added under the save dialog, say) is still unsaved.
          dirty:
            d.pages === pages &&
            (annotations === undefined || d.annotations === annotations) &&
            pageStateCurrent
              ? false
              : d.dirty
        }
      : d
  );
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
  // GAP-11a — the closed document's own undo/redo history goes with it (no
  // other document's history is affected). Done *before* the GC, so that
  // history's snapshots do not keep the closed document's bytes alive.
  forgetDocumentInHistory(id);
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
  // RT-2 — every source an undo or redo can land back on is live too, or
  // Ctrl+Z restores a document whose bytes this loop just deleted.
  for (const sourceId of historySourceIds()) stillUsed.add(sourceId);
  // RT-5 — registered by an import still in progress, not yet in any document.
  for (const sourceId of pendingSources) stillUsed.add(sourceId);
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
}

/** Applies `mutate` to one document and marks it dirty. */
function mutateDoc(docId: string, mutate: (doc: StaplerDoc) => StaplerDoc): void {
  documents.value = documents.value.map(doc =>
    doc.id === docId ? { ...mutate(doc), dirty: true } : doc
  );
}

export function renameDocument(docId: string, name: string): void {
  commit(docId);
  mutateDoc(docId, doc => ({ ...doc, name }));
}

export function deletePages(docId: string, pageKeys: Iterable<string>): void {
  const keys = new Set(pageKeys);
  if (keys.size === 0) return;
  const doc = documents.value.find(d => d.id === docId);
  const activeKey =
    doc && activeDocId.value === docId ? doc.pages[activePageIndex.value]?.key : undefined;

  // A PDF must have at least one page, so deleting every last one is refused
  // (RT-3). It used to close the document instead — directly, bypassing the
  // unsaved-changes confirmation closing a tab asks for, with no undo entry,
  // its history forgotten and its bytes deleted: Ctrl+A, Delete destroyed a
  // document and every edit to it in one keypress, even mid-export. Refusing
  // is the smallest safe behaviour — nothing is lost, and closing the tab
  // (which does confirm, and is blocked while a job runs) remains the way to
  // remove a whole document.
  if (doc && keys.size >= doc.pages.length && doc.pages.every(p => keys.has(p.key))) {
    notify('warning', translate('A document needs at least one page.'), {
      detail: translate('To remove the whole document, close its tab instead.')
    });
    return;
  }

  commit(docId);
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

  commit(docId);
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
  commit(docId);
  // Signature, text/date stamps and form fields live on the document itself
  // (`annotations`), so they revert here with the page list — and, like it,
  // undoably. The discard dialog always promised annotations were cleared;
  // these were silently kept (AUDIT-2026-09-25 UI-14).
  mutateDoc(docId, doc => ({ ...doc, pages: doc.baseline, annotations: [] }));
}

export function rotatePage(docId: string, pageKey: string, delta: number): void {
  rotatePages(docId, [pageKey], delta);
}

export function duplicatePages(docId: string, pageKeys: Iterable<string>): void {
  const keys = new Set(pageKeys);
  if (keys.size === 0) return;
  commit(docId);
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
  commit(docId);
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

/**
 * GAP-6 — replaces a document's page order with `orderedKeys`, a permutation
 * of its current page keys (duplex interleave). One undo step. Refused — a
 * no-op returning false — unless it is exactly a permutation: a reorder must
 * never drop or duplicate a page by accident.
 */
export function reorderPages(docId: string, orderedKeys: readonly string[]): boolean {
  const doc = documents.value.find(d => d.id === docId);
  if (!doc || orderedKeys.length !== doc.pages.length) return false;
  const byKey = new Map(doc.pages.map(page => [page.key, page]));
  if (new Set(orderedKeys).size !== orderedKeys.length) return false;
  const pages: PageRef[] = [];
  for (const key of orderedKeys) {
    const page = byKey.get(key);
    if (!page) return false;
    pages.push(page);
  }
  commit();
  batch(() => {
    const activeKey = doc.pages[activePageIndex.value]?.key;
    mutateDoc(docId, d => ({ ...d, pages }));
    if (activeDocId.value === docId && activeKey) {
      activePageIndex.value = Math.max(
        0,
        pages.findIndex(p => p.key === activeKey)
      );
    }
  });
  return true;
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
  commit(docId);
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
export function replaceWithSource(
  docId: string,
  source: SourceDocument,
  options: {
    /**
     * True when the new bytes were built *without* the document's stamps
     * (`doc.annotations`) — scan cleanup works on the source pages — so they
     * must be kept rather than dropped. Default false: redaction and face
     * blur bake them in, and keeping them would draw them twice.
     */
    keepStamps?: boolean;
    /**
     * True when page `i` of `source` is a rewrite of the document's page `i`
     * — redaction, face blur and per-page scan cleanup build their bytes from
     * `doc.pages` in order. The pages then keep their keys (see below).
     * False (default) for anything else — a whole-source rewrite in source
     * order, say — which gets fresh keys, since a kept key would land on a
     * different page.
     */
    pageForPage?: boolean;
    /**
     * True when `source` is a page-preserving rewrite of the *one* source all
     * of the document's pages come from — page `n` of it is that source's
     * page `n`, unrotated (scan cleanup's whole-document flatten). Each page
     * then keeps its key, its `sourceIndex` and its rotation; only the bytes
     * it points at change.
     */
    sameSourceLayout?: boolean;
  } = {}
): void {
  const before = documents.value.find(d => d.id === docId);
  const onlySource = before?.pages[0]?.sourceDocId;
  const layoutKept =
    options.sameSourceLayout === true &&
    onlySource !== undefined &&
    before !== undefined &&
    before.pages.every(page => page.sourceDocId === onlySource) &&
    sources.value[onlySource]?.pageCount === source.pageCount;
  commit(docId);
  registerSource(carryRestrictions(docId, source));
  mutateDoc(docId, doc => {
    // AUDIT-2026-10-10 M2 — a page-for-page rewrite keeps the pages' keys,
    // exactly as `repointPage` does. Everything else keyed by
    // page — crop boxes, Annotate marks, the edited outline, the selection's
    // meaning, alt text — then still refers to the same page. Minting fresh
    // keys orphaned all of it: the Annotate marks a user had drawn vanished
    // the moment a redaction was applied. The rebuilt page carries the old
    // ref's rotation in its own `/Rotate` (it was composed with it), so the
    // ref's rotation goes back to 0 and the page looks — and is keyed —
    // exactly as before.
    const pages = layoutKept
      ? doc.pages.map(page => ({ ...page, sourceDocId: source.id }))
      : options.pageForPage && source.pageCount === doc.pages.length
        ? doc.pages.map((page, index) => ({
            key: page.key,
            sourceDocId: source.id,
            sourceIndex: index,
            rotation: 0
          }))
        : makePageRefs(source.id, source.pageCount);
    return {
      ...doc,
      pages,
      // Stamps were baked into the new bytes, so keeping them would draw them twice.
      annotations: options.keepStamps ? doc.annotations : []
      // AUDIT-2026-10-10 — `baseline` is deliberately *not* moved. It used to
      // be set to the new pages here, which told every later dirty check
      // (undo/redo's `restoredDoc`) that the rewrite was what is on disk:
      // redact, then rotate, then undo the rotate, and the document read as
      // clean — closing the tab dropped an unsaved redaction without a
      // prompt. A rewrite is an edit like any other: the document is dirty
      // (`mutateDoc`) until a save re-anchors the baseline. The pages keep
      // their keys (above), so the export review's alignment still pairs
      // each page with its pre-rewrite self and shows the rewrite as the
      // change it is.
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
  commit(docId);
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
  commit(docId);
  mutateDoc(docId, doc => ({ ...doc, annotations: [...doc.annotations, annotation] }));
}

export function updateAnnotation(
  docId: string,
  annotationId: string,
  updates: Partial<Annotation>
): void {
  // A drag calls this on every pointer move; `commit` collapses them into the one
  // entry opened by the caller's transaction.
  commit(docId);
  mutateDoc(docId, doc => ({
    ...doc,
    annotations: doc.annotations.map(a => (a.id === annotationId ? { ...a, ...updates } : a))
  }));
}

export function deleteAnnotation(docId: string, annotationId: string): void {
  commit(docId);
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

  commit(docId);
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
