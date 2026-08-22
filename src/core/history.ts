/**
 * DOC-06 — undo/redo over document-model mutations.
 *
 * Snapshot-based rather than command-based, which is affordable because every
 * snapshot shares its `bytes` reference with the others: the only thing copied is
 * the page and annotation arrays.
 *
 * Two things the previous version got wrong:
 *
 *  • Every `updateAnnotation` call pushed a snapshot, so one drag of a signature
 *    filled all 50 slots with sub-pixel steps and undo could not reach the state
 *    from before the drag. Mutations now join a *transaction* and collapse into a
 *    single entry — see {@link beginTransaction}.
 *  • Selection was not part of the snapshot, so undoing a delete restored the
 *    pages but not the selection that produced it.
 *
 * Committed exports are not undoable and nothing in the export path calls
 * {@link commit}.
 */
import { signal } from '@preact/signals';
import { activeDocId, documents, selectedPageKeys, type StaplerDoc } from './store';
import { cropBoxes, type CropBox } from '../ui/tools/crop/state';
import { pageAnnotations, type Annotation } from '../ui/tools/annotate/state';
import { activeToolId, findTool } from './tools';

const MAX_DEPTH = 50;

interface Snapshot {
  docs: StaplerDoc[];
  activeId: string | null;
  selection: Set<string>;
  cropBoxes: Record<string, CropBox>;
  pageAnnotations: Record<string, Annotation[]>;
}

/** DOC-11 — {@link Snapshot} with its one non-JSON-safe field, `selection`, as an array. */
export interface SerializedSnapshot extends Omit<Snapshot, 'selection'> {
  selection: string[];
}

export interface SerializedHistory {
  undoStack: SerializedSnapshot[];
  redoStack: SerializedSnapshot[];
  undoLog: OperationLogEntry[];
  redoLog: OperationLogEntry[];
}

/** DOC-10 — one operation-log entry, one per `push()`, kept in lockstep with it. */
export interface OperationLogEntry {
  label: string;
  timestamp: number;
}

let undoStack: Snapshot[] = [];
let redoStack: Snapshot[] = [];

// Kept in exact lockstep with undoStack/redoStack — same push, same pop, same
// clear — rather than folding `label`/`timestamp` into `Snapshot` itself, so
// `historySourceRefCount`'s existing walk over raw snapshots is untouched.
let undoLog: OperationLogEntry[] = [];
let redoLog: OperationLogEntry[] = [];

/** Non-null while a coalescing transaction is open. */
let openTransaction: string | null = null;

/**
 * DOC-10 — `undoLog`/`redoLog` are plain arrays, not signals (matching
 * `canUndo`/`canRedo`, which were always read imperatively, never rendered
 * reactively, before this ticket). `HistoryPanel` needs to re-render as entries
 * are added, so this increments on every change the log can make; reading its
 * `.value` is what subscribes the component.
 */
export const historyVersion = signal(0);

function snapshot(): Snapshot {
  return {
    docs: documents.value,
    activeId: activeDocId.value,
    selection: new Set(selectedPageKeys.value),
    cropBoxes: cropBoxes.value,
    pageAnnotations: pageAnnotations.value
  };
}

/**
 * The active tool's title, not `beginTransaction`'s own coalescing key (things
 * like `crop-${page.key}`, which exist only to detect "is this the same open
 * transaction" and are not fit for a user-facing log).
 */
function currentOperationLabel(): string {
  return findTool(activeToolId.value ?? undefined)?.title ?? 'Edit';
}

function push() {
  undoStack.push(snapshot());
  undoLog.push({ label: currentOperationLabel(), timestamp: Date.now() });
  if (undoStack.length > MAX_DEPTH) {
    undoStack.shift();
    undoLog.shift();
  }
  redoStack = [];
  redoLog = [];
  historyVersion.value++;
}

function restore(state: Snapshot) {
  documents.value = state.docs;
  activeDocId.value = state.activeId;
  selectedPageKeys.value = new Set(state.selection);
  cropBoxes.value = state.cropBoxes;
  pageAnnotations.value = state.pageAnnotations;
}

/**
 * Records the state *before* a mutation. Call at the top of every store mutator.
 * Inside an open transaction only the first call records, so a drag is one entry.
 */
export function commit(): void {
  if (openTransaction !== null) return;
  push();
}

/**
 * Groups every mutation until `end()` into one undo entry:
 *
 *     const tx = beginTransaction('move-annotation');
 *     // …many updateAnnotation calls…
 *     tx.end();
 *
 * A nested call returns a no-op handle, so a pointer-move handler can call it
 * defensively without splitting the group.
 */
export function beginTransaction(label: string): { end: () => void } {
  if (openTransaction !== null) return { end: () => {} };
  push();
  openTransaction = label;
  return {
    end: () => {
      if (openTransaction === label) openTransaction = null;
    }
  };
}

export function undo(): void {
  const previous = undoStack.pop();
  const undoneEntry = undoLog.pop();
  if (!previous || !undoneEntry) return;
  redoStack.push(snapshot());
  // The operation being undone keeps its own label and timestamp, now sitting
  // on the redo side — it reappears in the log, unchanged, if redone.
  redoLog.push(undoneEntry);
  restore(previous);
  historyVersion.value++;
}

export function redo(): void {
  const next = redoStack.pop();
  const redoneEntry = redoLog.pop();
  if (!next || !redoneEntry) return;
  undoStack.push(snapshot());
  undoLog.push(redoneEntry);
  restore(next);
  historyVersion.value++;
}

/**
 * DOC-10 — every operation still applied, oldest first: exactly `undoLog`,
 * which is kept in lockstep with `undoStack` by `push`/`undo`/`redo` above, so
 * an operation undone before export is excluded by construction rather than by
 * a separate filter that could drift from what the undo stack actually holds.
 */
export function operationLog(): OperationLogEntry[] {
  return [...undoLog];
}

/**
 * How many undo/redo snapshots still reference `sourceId`.
 *
 * The undo stack is the invisible second owner of every source's bytes. `commit()`
 * pushes the *current* `documents` array before each mutation, so after any edit
 * the pages that reference a source exist both in the live state and in at least
 * one snapshot. `sources` is only pruned in `closeDocument`, precisely so undoing
 * back into a snapshot finds its bytes still readable.
 *
 * `store.canTransferSourceBytes` consults this: bytes an undo can reach must not
 * be detached, or Ctrl-Z restores a blank document.
 */
export function historySourceRefCount(sourceId: string): number {
  let count = 0;
  for (const stack of [undoStack, redoStack]) {
    for (const state of stack) {
      for (const doc of state.docs) {
        if (doc.pages.some(page => page.sourceDocId === sourceId)) count += 1;
      }
    }
  }
  return count;
}

export const canUndo = (): boolean => undoStack.length > 0;
export const canRedo = (): boolean => redoStack.length > 0;

/** Called when the workspace is replaced wholesale, e.g. on session load. */
export function resetHistory(): void {
  undoStack = [];
  redoStack = [];
  undoLog = [];
  redoLog = [];
  openTransaction = null;
  historyVersion.value++;
}

/**
 * DOC-11 — the undo/redo stacks in a form `session-recovery.ts` can hand to
 * `structuredClone`/IndexedDB, which cannot store a `Set`. Every snapshot here
 * already excludes document *bytes* (see the file header), so serialising the
 * whole stack is exactly as cheap as serialising one snapshot's `docs` array —
 * unlike the removed feature `store.ts`'s own comment warns about, which
 * persisted raw bytes on every mutation.
 */
export function serializeHistory(): SerializedHistory {
  const toSerialized = (s: Snapshot): SerializedSnapshot => ({ ...s, selection: [...s.selection] });
  return {
    undoStack: undoStack.map(toSerialized),
    redoStack: redoStack.map(toSerialized),
    undoLog: [...undoLog],
    redoLog: [...redoLog]
  };
}

/** The inverse of {@link serializeHistory} — replaces the stacks wholesale. */
export function restoreHistoryFromRecord(data: SerializedHistory): void {
  const toSnapshot = (s: SerializedSnapshot): Snapshot => ({
    ...s,
    selection: new Set(s.selection)
  });
  undoStack = data.undoStack.map(toSnapshot);
  redoStack = data.redoStack.map(toSnapshot);
  undoLog = [...data.undoLog];
  redoLog = [...data.redoLog];
  openTransaction = null;
  historyVersion.value++;
}
