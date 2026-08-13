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
import { activeDocId, documents, selectedPageKeys, type StaplerDoc } from './store';
import { cropBoxes, type CropBox } from '../ui/tools/crop/state';
import { pageAnnotations, type Annotation } from '../ui/tools/annotate/state';

const MAX_DEPTH = 50;

interface Snapshot {
  docs: StaplerDoc[];
  activeId: string | null;
  selection: Set<string>;
  cropBoxes: Record<string, CropBox>;
  pageAnnotations: Record<string, Annotation[]>;
}

let undoStack: Snapshot[] = [];
let redoStack: Snapshot[] = [];

/** Non-null while a coalescing transaction is open. */
let openTransaction: string | null = null;

function snapshot(): Snapshot {
  return {
    docs: documents.value,
    activeId: activeDocId.value,
    selection: new Set(selectedPageKeys.value),
    cropBoxes: cropBoxes.value,
    pageAnnotations: pageAnnotations.value
  };
}

function push() {
  undoStack.push(snapshot());
  if (undoStack.length > MAX_DEPTH) undoStack.shift();
  redoStack = [];
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
  if (!previous) return;
  redoStack.push(snapshot());
  restore(previous);
}

export function redo(): void {
  const next = redoStack.pop();
  if (!next) return;
  undoStack.push(snapshot());
  restore(next);
}

export const canUndo = (): boolean => undoStack.length > 0;
export const canRedo = (): boolean => redoStack.length > 0;

/** Called when the workspace is replaced wholesale, e.g. on session load. */
export function resetHistory(): void {
  undoStack = [];
  redoStack = [];
  openTransaction = null;
}
