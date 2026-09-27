/**
 * DOC-06 — undo/redo over document-model mutations, one history per document
 * (AUDIT-2026-09-25 GAP-11a).
 *
 * Snapshot-based rather than command-based, which is affordable because a
 * snapshot holds no bytes: only one document's page/annotation arrays and the
 * slice of the per-page tool state (`cropBoxes`, `pageAnnotations`) keyed by
 * that document's own page keys.
 *
 * **Why per document.** The previous version kept one global stack of
 * whole-workspace snapshots, and nearly every runtime bug in this area came
 * from that: Ctrl+Z in document A could restore document B (RT-6), closing B
 * had to surgically strip B out of every snapshot (`forgetDocumentInHistory`),
 * and opening a file had to be an undo step so that the next Ctrl+Z did not
 * silently remove it — which in turn meant undo could empty the workspace
 * (R-RT-6/7). Now each `StaplerDoc` owns its own undo/redo stacks and undo and
 * redo act on the *active* document only.
 *
 * **Opening and closing documents are workspace actions, not undo steps.**
 *  • Opening creates an empty history for the new document. There is nothing
 *    to undo "before" a document existed; undoing an open used to delete the
 *    document the user had just asked for (R-RT-6/7). Closing its tab is how a
 *    document is removed.
 *  • Closing drops that document's history and, with it, every source only
 *    that history could reach. Closing is guarded by the unsaved-changes
 *    confirmation in `FileTabs`, so this is never a silent loss.
 *
 * Earlier fixes this keeps:
 *  • Transactions (`beginTransaction`) collapse a drag's many mutations into
 *    one entry — now per document, so a drag in A never swallows an edit to B.
 *  • The selection rides the snapshot, so undoing a delete restores the
 *    selection that produced it.
 *  • Undo/redo refuse to run while a job is active (§2.2).
 *  • RT-2 — every source any document's undo/redo snapshots can reach counts
 *    as live for `closeDocument`'s GC (`historySourceIds`).
 *
 * Committed exports are not undoable and nothing in the export path calls
 * {@link commit}.
 */
import { batch, signal } from '@preact/signals';
import {
  activeDocId,
  activePageIndex,
  documents,
  selectedPageKeys,
  type PageRef,
  type StaplerDoc
} from './store';
import { cropBoxes, type CropBox } from '../ui/tools/crop/state';
import { pageAnnotations, type Annotation } from '../ui/tools/annotate/state';
import { activeToolId, findTool } from './tools';
import { activeJob } from './notify';
import { tKey } from './i18n/key';
import { logEvent } from './errors';

/** Undo steps kept per document. */
export const MAX_DEPTH = 50;
/**
 * Snapshots (undo + redo) kept across every open document. With the
 * document ceiling (`workspace-limits.ts`) at 20 documents × 50 steps this
 * would otherwise be 1000 snapshots; past this, the oldest step of whichever
 * *other* document has the oldest one is dropped first.
 */
export const MAX_TOTAL_SNAPSHOTS = 400;

/**
 * One document's state before a mutation. Plain JSON-safe data (selection is
 * an array), so it is also its own serialised form for session recovery.
 */
export interface DocSnapshot {
  doc: StaplerDoc;
  /** The selection, restricted to this document's pages. */
  selection: string[];
  /** `cropBoxes` entries for this document's page keys (pages ∪ baseline). */
  cropBoxes: Record<string, CropBox>;
  /** `pageAnnotations` entries for this document's page keys (pages ∪ baseline). */
  pageAnnotations: Record<string, Annotation[]>;
}

/** DOC-10 — one operation-log entry, one per `push()`, kept in lockstep with it. */
export interface OperationLogEntry {
  label: string;
  timestamp: number;
}

export interface SerializedDocHistory {
  undoStack: DocSnapshot[];
  redoStack: DocSnapshot[];
  undoLog: OperationLogEntry[];
  redoLog: OperationLogEntry[];
}

/**
 * DOC-11 — the session-recovery form of every document's history. `version`
 * distinguishes it from the pre-GAP-11 global format (`{ undoStack, redoStack,
 * undoLog, redoLog }` of whole-workspace snapshots), which is dropped on
 * restore rather than migrated — see {@link restoreHistoryFromRecord}.
 */
export interface SerializedHistory {
  version: 2;
  docs: Record<string, SerializedDocHistory>;
}

interface DocHistory extends SerializedDocHistory {
  /** Non-null while a coalescing transaction is open on this document. */
  openTransaction: string | null;
}

const histories = new Map<string, DocHistory>();

/**
 * DOC-10 — the stacks are plain data, not signals. Anything that renders from
 * them (`HistoryPanel`, the undo/redo affordances) or that must notice any
 * document edit (the conversion panels' staleness gates) reads this, which
 * increments on every change any history makes.
 */
export const historyVersion = signal(0);

function historyFor(docId: string): DocHistory {
  let history = histories.get(docId);
  if (!history) {
    history = { undoStack: [], redoStack: [], undoLog: [], redoLog: [], openTransaction: null };
    histories.set(docId, history);
  }
  return history;
}

function pageKeysOf(doc: StaplerDoc): Set<string> {
  const keys = new Set<string>();
  for (const page of doc.pages) keys.add(page.key);
  for (const page of doc.baseline ?? []) keys.add(page.key);
  return keys;
}

function pick<T>(map: Record<string, T>, keys: Set<string>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of keys) {
    if (key in map) out[key] = map[key];
  }
  return out;
}

function snapshotOf(doc: StaplerDoc): DocSnapshot {
  const keys = pageKeysOf(doc);
  const pageSet = new Set(doc.pages.map(p => p.key));
  return {
    doc,
    selection: [...selectedPageKeys.value].filter(key => pageSet.has(key)),
    cropBoxes: pick(cropBoxes.value, keys),
    pageAnnotations: pick(pageAnnotations.value, keys)
  };
}

/**
 * Replaces the entries for `keys` in `live` with exactly those in `scoped`,
 * leaving every other document's entries untouched. Returns `live` itself
 * when nothing changes, so an undo that touched no crop box does not wake
 * every crop-box subscriber.
 */
function mergeScoped<T>(
  live: Record<string, T>,
  keys: Set<string>,
  scoped: Record<string, T>
): Record<string, T> {
  let changed = false;
  for (const key of keys) {
    if (live[key] !== scoped[key]) {
      changed = true;
      break;
    }
  }
  if (!changed) return live;
  const next = { ...live };
  for (const key of keys) {
    if (key in scoped) next[key] = scoped[key];
    else delete next[key];
  }
  return next;
}

/**
 * The active tool's title, not `beginTransaction`'s own coalescing key (things
 * like `crop-${page.key}`, which exist only to detect "is this the same open
 * transaction" and are not fit for a user-facing log).
 */
function currentOperationLabel(): string {
  return findTool(activeToolId.value ?? undefined)?.title ?? tKey('Edit');
}

function totalSnapshots(): number {
  let total = 0;
  for (const history of histories.values()) {
    total += history.undoStack.length + history.redoStack.length;
  }
  return total;
}

/** Drops the oldest undo step of another document until the total cap holds. */
function enforceTotalCap(exceptDocId: string): void {
  while (totalSnapshots() > MAX_TOTAL_SNAPSHOTS) {
    let oldest: DocHistory | null = null;
    for (const [id, history] of histories) {
      if (id === exceptDocId || history.undoLog.length === 0) continue;
      if (!oldest || history.undoLog[0].timestamp < oldest.undoLog[0].timestamp) oldest = history;
    }
    if (!oldest) return;
    oldest.undoStack.shift();
    oldest.undoLog.shift();
  }
}

function push(docId: string, label?: string): boolean {
  const doc = documents.value.find(d => d.id === docId);
  if (!doc) return false;
  const history = historyFor(docId);
  history.undoStack.push(snapshotOf(doc));
  history.undoLog.push({ label: label ?? currentOperationLabel(), timestamp: Date.now() });
  if (history.undoStack.length > MAX_DEPTH) {
    history.undoStack.shift();
    history.undoLog.shift();
  }
  history.redoStack = [];
  history.redoLog = [];
  enforceTotalCap(docId);
  historyVersion.value++;
  return true;
}

function restore(docId: string, state: DocSnapshot): void {
  const current = documents.value.find(d => d.id === docId);
  if (!current) return;
  const keys = pageKeysOf(current);
  for (const key of pageKeysOf(state.doc)) keys.add(key);
  batch(() => {
    documents.value = documents.value.map(d => (d.id === docId ? state.doc : d));
    cropBoxes.value = mergeScoped(cropBoxes.value, keys, state.cropBoxes);
    pageAnnotations.value = mergeScoped(pageAnnotations.value, keys, state.pageAnnotations);
    if (activeDocId.value === docId) {
      selectedPageKeys.value = new Set(state.selection);
      const last = Math.max(0, state.doc.pages.length - 1);
      if (activePageIndex.value > last) activePageIndex.value = last;
    }
  });
}

function resolveDocId(docId: string | null | undefined): string | null {
  return docId ?? activeDocId.value;
}

/**
 * Records the state of document `docId` (default: the active document)
 * *before* a mutation. Call at the top of every store mutator. Inside an open
 * transaction on that document only the first call records, so a drag is one
 * entry.
 *
 * `label` overrides the operation-log entry, which otherwise names the active
 * tool.
 */
export function commit(docId?: string | null, label?: string): void {
  const id = resolveDocId(docId);
  if (id === null) return;
  if (histories.get(id)?.openTransaction != null) return;
  push(id, label);
}

/**
 * Groups every mutation of one document until `end()` into one undo entry:
 *
 *     const tx = beginTransaction('move-annotation');
 *     // …many updateAnnotation calls…
 *     tx.end();
 *
 * `docId` defaults to the active document. A nested call on the same document
 * returns a no-op handle, so a pointer-move handler can call it defensively
 * without splitting the group. A transaction on one document never absorbs
 * another document's edits.
 */
export function beginTransaction(
  label: string,
  logLabel?: string,
  docId?: string | null
): { end: () => void } {
  const id = resolveDocId(docId);
  if (id === null) return { end: () => {} };
  const existing = histories.get(id);
  if (existing?.openTransaction != null) return { end: () => {} };
  if (!push(id, logLabel)) return { end: () => {} };
  const history = historyFor(id);
  history.openTransaction = label;
  return {
    end: () => {
      // Looked up again: the document may have been closed (its history
      // dropped) while the transaction was open.
      const live = histories.get(id);
      if (live?.openTransaction === label) live.openTransaction = null;
    }
  };
}

/**
 * §2.2 — `undo`/`redo` swap a document for a snapshot with a different
 * `pages`/`annotations` array under the same id. `commit.ts` captures
 * `doc = activeDoc.value` once at the start of an export and holds it across
 * several `await`s before calling `refreshBaseline(doc.id, doc.pages)` — an
 * undo landing in between would stamp that stale page list onto the
 * baseline. `activeJob` is the signal `FileTabs.tsx` already blocks tab
 * switch/close on for this reason, so undo/redo refuse while it is set.
 *
 * Acts on the active document only.
 */
export function undo(): void {
  if (activeJob.value !== null) return;
  const id = activeDocId.value;
  if (id === null) return;
  const history = histories.get(id);
  if (!history || history.openTransaction !== null) return;
  const doc = documents.value.find(d => d.id === id);
  const previous = history.undoStack.pop();
  const undoneEntry = history.undoLog.pop();
  if (!doc || !previous || !undoneEntry) {
    if (previous) history.undoStack.push(previous);
    if (undoneEntry) history.undoLog.push(undoneEntry);
    return;
  }
  history.redoStack.push(snapshotOf(doc));
  // The operation being undone keeps its own label and timestamp, now sitting
  // on the redo side — it reappears in the log, unchanged, if redone.
  history.redoLog.push(undoneEntry);
  restore(id, previous);
  historyVersion.value++;
}

export function redo(): void {
  if (activeJob.value !== null) return;
  const id = activeDocId.value;
  if (id === null) return;
  const history = histories.get(id);
  if (!history || history.openTransaction !== null) return;
  const doc = documents.value.find(d => d.id === id);
  const next = history.redoStack.pop();
  const redoneEntry = history.redoLog.pop();
  if (!doc || !next || !redoneEntry) {
    if (next) history.redoStack.push(next);
    if (redoneEntry) history.redoLog.push(redoneEntry);
    return;
  }
  history.undoStack.push(snapshotOf(doc));
  history.undoLog.push(redoneEntry);
  restore(id, next);
  historyVersion.value++;
}

/**
 * DOC-10 — every operation still applied to document `docId` (default: the
 * active one), oldest first: exactly its `undoLog`, kept in lockstep with its
 * undo stack, so an operation undone before export is excluded by
 * construction.
 */
export function operationLog(docId?: string | null): OperationLogEntry[] {
  const id = resolveDocId(docId);
  if (id === null) return [];
  return [...(histories.get(id)?.undoLog ?? [])];
}

function* allSnapshots(): Generator<DocSnapshot> {
  for (const history of histories.values()) {
    yield* history.undoStack;
    yield* history.redoStack;
  }
}

function referencesSource(pages: readonly PageRef[], sourceId: string): boolean {
  return pages.some(page => page.sourceDocId === sourceId);
}

/**
 * How many undo/redo snapshots, across every document's history, still
 * reference `sourceId` through a document's `pages`.
 *
 * The histories are the invisible second owner of every source's bytes:
 * `commit()` records a document's current pages before each mutation, so
 * after any edit its sources are reachable from both the live state and at
 * least one snapshot. `store.canTransferSourceBytes`/`releaseSourceIfUnused`
 * consult this: bytes an undo can reach must not be freed or detached.
 */
export function historySourceRefCount(sourceId: string): number {
  let count = 0;
  for (const state of allSnapshots()) {
    if (referencesSource(state.doc.pages, sourceId)) count += 1;
  }
  return count;
}

/**
 * RT-2 — every source id any document's undo/redo snapshots can still reach,
 * through a document's `pages` *or* its `baseline` (the export-review diff and
 * "Discard all changes" read the baseline of whatever state undo lands on).
 * `closeDocument`'s source GC unions this into its liveness set.
 */
export function historySourceIds(): Set<string> {
  const ids = new Set<string>();
  for (const state of allSnapshots()) {
    for (const page of state.doc.pages) ids.add(page.sourceDocId);
    for (const page of state.doc.baseline ?? []) ids.add(page.sourceDocId);
  }
  return ids;
}

// Also false while a job is in flight (§2.2), so both the keyboard shortcut
// and every UI affordance that gates on these — CommandPalette's entries
// included — disable themselves for the same reason FileTabs blocks a tab
// switch.
export const canUndo = (docId?: string | null): boolean => {
  const id = resolveDocId(docId);
  return id !== null && (histories.get(id)?.undoStack.length ?? 0) > 0 && activeJob.value === null;
};
export const canRedo = (docId?: string | null): boolean => {
  const id = resolveDocId(docId);
  return id !== null && (histories.get(id)?.redoStack.length ?? 0) > 0 && activeJob.value === null;
};

/**
 * Drops one document's whole history — called by `closeDocument` *before*
 * its source GC, so the closed document's snapshots no longer keep its bytes
 * alive. Every other document's history is untouched by construction.
 */
export function forgetDocumentInHistory(docId: string): void {
  if (histories.delete(docId)) historyVersion.value++;
}

/** Called when the workspace is replaced wholesale, e.g. on session load. */
export function resetHistory(): void {
  histories.clear();
  historyVersion.value++;
}

/**
 * DOC-11 — every document's history in a form `session-recovery.ts` can hand
 * to IndexedDB. Snapshots hold no bytes (see the file header).
 */
export function serializeHistory(): SerializedHistory {
  const docs: Record<string, SerializedDocHistory> = {};
  for (const [id, history] of histories) {
    if (history.undoStack.length === 0 && history.redoStack.length === 0) continue;
    docs[id] = {
      undoStack: [...history.undoStack],
      redoStack: [...history.redoStack],
      undoLog: [...history.undoLog],
      redoLog: [...history.redoLog]
    };
  }
  return { version: 2, docs };
}

export function emptySerializedHistory(): SerializedHistory {
  return { version: 2, docs: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSnapshot(value: unknown): value is DocSnapshot {
  if (!isRecord(value) || !isRecord(value.doc)) return false;
  const doc = value.doc;
  return (
    typeof doc.id === 'string' &&
    Array.isArray(doc.pages) &&
    Array.isArray(doc.annotations) &&
    Array.isArray(value.selection) &&
    isRecord(value.cropBoxes) &&
    isRecord(value.pageAnnotations)
  );
}

function isLogEntry(value: unknown): value is OperationLogEntry {
  return isRecord(value) && typeof value.label === 'string' && typeof value.timestamp === 'number';
}

function isDocHistory(value: unknown): value is SerializedDocHistory {
  return (
    isRecord(value) &&
    Array.isArray(value.undoStack) &&
    Array.isArray(value.redoStack) &&
    Array.isArray(value.undoLog) &&
    Array.isArray(value.redoLog) &&
    value.undoStack.length === value.undoLog.length &&
    value.redoStack.length === value.redoLog.length &&
    value.undoStack.every(isSnapshot) &&
    value.redoStack.every(isSnapshot) &&
    value.undoLog.every(isLogEntry) &&
    value.redoLog.every(isLogEntry)
  );
}

/**
 * Reads whatever a saved record holds as history into the current format.
 *
 * A record saved before GAP-11 holds one global stack of whole-workspace
 * snapshots. Splitting those into per-document stacks would invent history
 * that never existed (a global step that touched two documents has no
 * per-document equivalent), so it is dropped: the documents themselves are
 * restored, with empty undo. Any per-document history that does not have the
 * expected shape is dropped the same way, on its own — never a crash.
 */
export function normalizeSerializedHistory(data: unknown): SerializedHistory {
  if (!isRecord(data) || data.version !== 2 || !isRecord(data.docs)) {
    if (data !== undefined && data !== null) {
      logEvent('info', 'history', 'Dropped undo history saved in an older format.');
    }
    return emptySerializedHistory();
  }
  const docs: Record<string, SerializedDocHistory> = {};
  for (const [id, history] of Object.entries(data.docs)) {
    if (
      isDocHistory(history) &&
      history.undoStack.concat(history.redoStack).every(s => s.doc.id === id)
    ) {
      docs[id] = history;
    } else {
      logEvent('warn', 'history', 'Dropped a malformed saved undo history.');
    }
  }
  return { version: 2, docs };
}

/**
 * The inverse of {@link serializeHistory} — replaces every history wholesale.
 * Histories for documents not in `liveDocIds` (when given) are dropped.
 */
export function restoreHistoryFromRecord(data: unknown, liveDocIds?: Iterable<string>): void {
  const normalized = normalizeSerializedHistory(data);
  const live = liveDocIds ? new Set(liveDocIds) : null;
  histories.clear();
  for (const [id, history] of Object.entries(normalized.docs)) {
    if (live && !live.has(id)) continue;
    const undoStack = history.undoStack.slice(-MAX_DEPTH);
    const undoLog = history.undoLog.slice(-MAX_DEPTH);
    histories.set(id, {
      undoStack,
      undoLog,
      redoStack: [...history.redoStack],
      redoLog: [...history.redoLog],
      openTransaction: null
    });
  }
  historyVersion.value++;
}
