import { beforeEach, describe, expect, it } from 'vitest';
import {
  addDocument,
  activeDocId,
  deletePages,
  documents,
  makePageRefs,
  registerSource,
  rotatePages,
  selectedPageKeys,
  setPageSelection,
  sources,
  updateAnnotation,
  addAnnotation,
  closeDocument,
  replaceWithSource,
  switchDocument,
  type StaplerDoc
} from '../../src/core/store';
import {
  beginTransaction,
  canRedo,
  canUndo,
  commit,
  historySourceIds,
  MAX_DEPTH,
  MAX_TOTAL_SNAPSHOTS,
  normalizeSerializedHistory,
  operationLog,
  redo,
  resetHistory,
  restoreHistoryFromRecord,
  serializeHistory,
  undo
} from '../../src/core/history';
import { activeToolId } from '../../src/core/tools';
import { cropBoxes } from '../../src/ui/tools/crop/state';
import {
  pageAnnotations,
  addAnnotation as addOverlayAnnotation,
  removeAnnotation as removeOverlayAnnotation,
  type Annotation as OverlayAnnotation
} from '../../src/ui/tools/annotate/state';

function seed(pageCount = 5): StaplerDoc {
  registerSource({
    id: 'src',
    name: 'src.pdf',
    pageCount,
    pageSizes: Array.from({ length: pageCount }, () => ({ width: 595, height: 842 }))
  });
  const pages = makePageRefs('src', pageCount);
  const doc: StaplerDoc = {
    id: 'doc-1',
    name: 'doc.pdf',
    pages,
    baseline: pages,
    annotations: [],
    dirty: false
  };
  addDocument(doc);
  return doc;
}

beforeEach(() => {
  documents.value = [];
  sources.value = {};
  activeDocId.value = null;
  selectedPageKeys.value = new Set();
  pageAnnotations.value = {};
  cropBoxes.value = {};
  activeToolId.value = null;
  resetHistory();
});

describe('undo and redo', () => {
  it('starts with nothing to undo or redo', () => {
    seed();
    expect(canUndo()).toBe(false);
    expect(canRedo()).toBe(false);
    undo();
    redo();
    expect(documents.value[0].pages.length).toBe(5);
  });

  it('restores the previous state', () => {
    const doc = seed(3);
    deletePages(doc.id, [doc.pages[0].key]);
    expect(documents.value[0].pages.length).toBe(2);
    undo();
    expect(documents.value[0].pages.length).toBe(3);
    redo();
    expect(documents.value[0].pages.length).toBe(2);
  });

  // DOC-06's acceptance criterion.
  it('round-trips 20 mixed operations back to an identical model', () => {
    const doc = seed(20);
    const before = JSON.stringify(documents.value);

    for (let i = 0; i < 10; i++) {
      rotatePages(doc.id, [documents.value[0].pages[i % 5].key], 90);
      deletePages(doc.id, [documents.value[0].pages[documents.value[0].pages.length - 1].key]);
    }
    expect(JSON.stringify(documents.value)).not.toBe(before);

    for (let i = 0; i < 20; i++) undo();
    expect(JSON.stringify(documents.value)).toBe(before);

    for (let i = 0; i < 20; i++) redo();
    // 20 pages, 10 deletions.
    expect(documents.value[0].pages.length).toBe(10);
    expect(canRedo()).toBe(false);
  });

  it('restores the selection along with the pages', () => {
    const doc = seed(4);
    setPageSelection([doc.pages[2].key]);
    deletePages(doc.id, [doc.pages[2].key]);
    expect(selectedPageKeys.value.size).toBe(0);
    undo();
    expect([...selectedPageKeys.value]).toEqual([doc.pages[2].key]);
  });

  it('drops the redo stack once a new change is made', () => {
    const doc = seed(3);
    deletePages(doc.id, [doc.pages[0].key]);
    undo();
    expect(canRedo()).toBe(true);
    rotatePages(doc.id, [documents.value[0].pages[0].key], 90);
    expect(canRedo()).toBe(false);
  });

  it('keeps at least 50 steps of depth', () => {
    const doc = seed(60);
    for (let i = 0; i < 50; i++) {
      rotatePages(doc.id, [documents.value[0].pages[0].key], 90);
    }
    for (let i = 0; i < 50; i++) {
      expect(canUndo()).toBe(true);
      undo();
    }
    expect(canUndo()).toBe(false);
  });
});

/**
 * §2.2 — `commit.ts`'s export handler captures `doc = activeDoc.value` once
 * and holds that reference across several `await`s (compose, a confirm
 * dialog, the save picker) before writing `doc.pages` back onto the
 * document's `baseline` by id. An undo/redo landing in that window swaps
 * `documents.value` for a snapshot with a different `pages` array for the
 * same id, so the eventual `refreshBaseline` call stamps stale, pre-undo
 * pages onto the document — corrupting the next export's diff. `activeJob`
 * is the same signal `FileTabs.tsx` already gates tab-switch/close on for
 * this exact class of problem.
 */
describe('undo/redo refuse to run while a job is active (§2.2)', () => {
  it('canUndo/canRedo report false while activeJob is set, true once it clears', async () => {
    const doc = seed(3);
    deletePages(doc.id, [doc.pages[0].key]);
    expect(canUndo()).toBe(true);

    const { activeJob } = await import('../../src/core/notify');
    activeJob.value = { label: 'Exporting…', progress: null, cancel: () => {} };
    try {
      expect(canUndo()).toBe(false);
    } finally {
      activeJob.value = null;
    }
    expect(canUndo()).toBe(true);
  });

  it('undo() is a no-op while a job is active, and works again once it clears', async () => {
    const doc = seed(3);
    deletePages(doc.id, [doc.pages[0].key]);
    expect(documents.value[0].pages.length).toBe(2);

    const { activeJob } = await import('../../src/core/notify');
    activeJob.value = { label: 'Exporting…', progress: null, cancel: () => {} };
    try {
      undo();
      // Nothing moved: the pending export still holds a `doc.pages` reference
      // this must not invalidate.
      expect(documents.value[0].pages.length).toBe(2);
    } finally {
      activeJob.value = null;
    }
    undo();
    expect(documents.value[0].pages.length).toBe(3);
  });

  it('redo() is a no-op while a job is active', async () => {
    const doc = seed(3);
    deletePages(doc.id, [doc.pages[0].key]);
    undo();
    expect(documents.value[0].pages.length).toBe(3);

    const { activeJob } = await import('../../src/core/notify');
    activeJob.value = { label: 'Exporting…', progress: null, cancel: () => {} };
    try {
      redo();
      expect(documents.value[0].pages.length).toBe(3);
    } finally {
      activeJob.value = null;
    }
    redo();
    expect(documents.value[0].pages.length).toBe(2);
  });
});

describe('transactions', () => {
  // The regression this exists for: dragging a stamp called updateAnnotation on every
  // pointer move, and each push filled a slot — so one drag consumed the whole stack
  // and undo could not reach the state from before the drag.
  it('collapses many mutations into one undo entry', () => {
    const doc = seed(1);
    addAnnotation(doc.id, {
      id: 'a1',
      pageKey: doc.pages[0].key,
      type: 'text',
      x: 0.1,
      y: 0.1,
      width: 0.2,
      height: 0.05,
      data: 'hello'
    });
    const beforeDrag = documents.value[0].annotations[0].x;

    const tx = beginTransaction('drag');
    for (let i = 1; i <= 60; i++) updateAnnotation(doc.id, 'a1', { x: 0.1 + i * 0.001 });
    tx.end();

    expect(documents.value[0].annotations[0].x).toBeCloseTo(0.16);
    undo();
    expect(documents.value[0].annotations[0].x).toBeCloseTo(beforeDrag);
    // And the annotation itself is still undoable behind that.
    undo();
    expect(documents.value[0].annotations.length).toBe(0);
  });

  it('treats a nested transaction as part of the outer one', () => {
    const doc = seed(1);
    const outer = beginTransaction('outer');
    rotatePages(doc.id, [doc.pages[0].key], 90);
    const inner = beginTransaction('inner');
    rotatePages(doc.id, [doc.pages[0].key], 90);
    inner.end();
    rotatePages(doc.id, [doc.pages[0].key], 90);
    outer.end();

    expect(documents.value[0].pages[0].rotation).toBe(270);
    undo();
    expect(documents.value[0].pages[0].rotation).toBe(0);
  });

  it('resumes recording after a transaction closes', () => {
    const doc = seed(1);
    const tx = beginTransaction('drag');
    rotatePages(doc.id, [doc.pages[0].key], 90);
    tx.end();
    rotatePages(doc.id, [doc.pages[0].key], 90);
    expect(documents.value[0].pages[0].rotation).toBe(180);
    undo();
    expect(documents.value[0].pages[0].rotation).toBe(90);
    undo();
    expect(documents.value[0].pages[0].rotation).toBe(0);
  });

  /**
   * ANN-01 — `pageAnnotations` (the freehand/highlight/rectangle/text/sticky/
   * whiteout overlay layer, distinct from the SGN-02 stamp `Annotation` type
   * above) previously wasn't in the undo snapshot at all: drawing a shape and
   * pressing ⌘Z did nothing. It now rides the same snapshot as `cropBoxes`.
   */
  it('reaches the ANN-01 overlay layer, not just SGN-02 stamps', () => {
    const doc = seed(1);
    const key = doc.pages[0].key;
    const ann: OverlayAnnotation = {
      id: 'a1',
      type: 'rectangle',
      color: '#ff0000',
      strokeWidth: 0.01,
      rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }
    };
    commitLikeOverlay(() => addOverlayAnnotation(key, ann));
    expect(pageAnnotations.value[key]).toHaveLength(1);

    undo();
    expect(pageAnnotations.value[key] ?? []).toHaveLength(0);
    redo();
    expect(pageAnnotations.value[key]).toHaveLength(1);

    commitLikeOverlay(() => removeOverlayAnnotation(key, 'a1'));
    expect(pageAnnotations.value[key]).toHaveLength(0);
    undo();
    expect(pageAnnotations.value[key]).toHaveLength(1);
  });
});

describe('DOC-10: operation log', () => {
  it('labels each entry with the tool active when the operation happened', () => {
    const doc = seed(3);
    activeToolId.value = 'organize';
    rotatePages(doc.id, [doc.pages[0].key], 90);
    activeToolId.value = 'split';
    deletePages(doc.id, [doc.pages[1].key]);

    expect(operationLog().map(e => e.label)).toEqual(['Organize', 'Split & extract']);
  });

  it('falls back to a generic label when no tool is active', () => {
    const doc = seed(2);
    activeToolId.value = null;
    rotatePages(doc.id, [doc.pages[0].key], 90);
    expect(operationLog().map(e => e.label)).toEqual(['Edit']);
  });

  it('excludes an operation that was undone, and restores it on redo unchanged', () => {
    const doc = seed(3);
    activeToolId.value = 'organize';
    rotatePages(doc.id, [doc.pages[0].key], 90);
    activeToolId.value = 'crop';
    deletePages(doc.id, [doc.pages[1].key]);
    expect(operationLog().map(e => e.label)).toEqual(['Organize', 'Crop']);

    undo();
    expect(operationLog().map(e => e.label)).toEqual(['Organize']);

    // Switching tools between the undo and the redo must not relabel the
    // operation being restored — it keeps the label it was recorded with.
    activeToolId.value = 'merge';
    redo();
    expect(operationLog().map(e => e.label)).toEqual(['Organize', 'Crop']);
  });

  it('drops the undone entry from the log once a new operation is made', () => {
    const doc = seed(3);
    activeToolId.value = 'organize';
    rotatePages(doc.id, [doc.pages[0].key], 90);
    undo();
    activeToolId.value = 'crop';
    rotatePages(doc.id, [doc.pages[0].key], 90);
    // The undone "Organize" entry is gone, not resurrected by the new push.
    expect(operationLog().map(e => e.label)).toEqual(['Crop']);
    expect(canRedo()).toBe(false);
  });

  it('is cleared by resetHistory', () => {
    const doc = seed(2);
    resetHistory();
    activeToolId.value = 'organize';
    rotatePages(doc.id, [doc.pages[0].key], 90);
    expect(operationLog().length).toBe(1);
    resetHistory();
    expect(operationLog()).toEqual([]);
  });

  it('records exactly one entry for a whole coalesced transaction', () => {
    const doc = seed(1);
    activeToolId.value = 'sign';
    addAnnotation(doc.id, {
      id: 'a1',
      pageKey: doc.pages[0].key,
      type: 'text',
      x: 0.1,
      y: 0.1,
      width: 0.2,
      height: 0.05,
      data: 'hello'
    });
    const tx = beginTransaction('drag');
    for (let i = 1; i <= 10; i++) updateAnnotation(doc.id, 'a1', { x: 0.1 + i * 0.001 });
    tx.end();

    // One entry for the add, one for the whole drag — not one per drag step.
    expect(operationLog().map(e => e.label)).toEqual(['Sign & fill', 'Sign & fill']);
  });

  it('every entry has a real timestamp, in non-decreasing order', () => {
    const doc = seed(3);
    rotatePages(doc.id, [doc.pages[0].key], 90);
    deletePages(doc.id, [doc.pages[1].key]);
    const timestamps = operationLog().map(e => e.timestamp);
    expect(timestamps.every(t => Number.isFinite(t) && t > 0)).toBe(true);
    expect(timestamps[1]).toBeGreaterThanOrEqual(timestamps[0]);
  });
});

/**
 * `AnnotateOverlay.tsx` calls `commit()` itself before each mutation (the
 * mutators in `ui/tools/annotate/state.ts` cannot import it back without a
 * cycle with `history.ts`). Mirrors that call order here.
 */
function commitLikeOverlay(mutate: () => void) {
  commit();
  mutate();
}

/* ---------------- GAP-11a — per-document undo/redo ---------------- */

function seedDoc(id: string, sourceId: string, pageCount = 3): StaplerDoc {
  registerSource({
    id: sourceId,
    name: `${sourceId}.pdf`,
    pageCount,
    pageSizes: Array.from({ length: pageCount }, () => ({ width: 595, height: 842 }))
  });
  const pages = makePageRefs(sourceId, pageCount);
  const doc: StaplerDoc = {
    id,
    name: `${id}.pdf`,
    pages,
    baseline: pages,
    annotations: [],
    dirty: false
  };
  addDocument(doc);
  return doc;
}

const docById = (id: string) => documents.value.find(d => d.id === id)!;

describe('GAP-11a — each document has its own undo/redo', () => {
  it('opening a document is not an undo step', () => {
    seedDoc('A', 'SA');
    expect(canUndo()).toBe(false);
    seedDoc('B', 'SB');
    expect(canUndo()).toBe(false);
    undo();
    expect(documents.value.map(d => d.id)).toEqual(['A', 'B']);
  });

  it('keeps independent stacks: undo in A leaves B untouched', () => {
    const a = seedDoc('A', 'SA');
    const b = seedDoc('B', 'SB');
    rotatePages('A', [a.pages[0].key], 90);
    rotatePages('B', [b.pages[0].key], 180);
    deletePages('B', [b.pages[1].key]);

    switchDocument('A');
    expect(operationLog().length).toBe(1);
    undo();
    expect(docById('A').pages[0].rotation).toBe(0);
    // B is exactly as it was: rotated, one page deleted, both still undoable.
    expect(docById('B').pages[0].rotation).toBe(180);
    expect(docById('B').pages).toHaveLength(2);
    expect(canUndo('B')).toBe(true);
    expect(operationLog('B')).toHaveLength(2);
    // A has nothing left; Ctrl+Z again does not fall through into B.
    undo();
    expect(docById('B').pages).toHaveLength(2);
  });

  it('redo after switching documents redoes the right document', () => {
    const a = seedDoc('A', 'SA');
    const b = seedDoc('B', 'SB');
    rotatePages('A', [a.pages[0].key], 90);
    switchDocument('A');
    undo();
    expect(canRedo()).toBe(true);

    switchDocument('B');
    expect(canRedo()).toBe(false);
    rotatePages('B', [b.pages[0].key], 90); // a new edit in B must not clear A's redo
    redo(); // nothing to redo in B
    expect(docById('A').pages[0].rotation).toBe(0);

    switchDocument('A');
    expect(canRedo()).toBe(true);
    redo();
    expect(docById('A').pages[0].rotation).toBe(90);
    expect(docById('B').pages[0].rotation).toBe(90);
  });

  it('scopes crop boxes and overlay annotations to the document being undone', () => {
    const a = seedDoc('A', 'SA');
    const b = seedDoc('B', 'SB');
    switchDocument('A');
    commit('A');
    cropBoxes.value = {
      ...cropBoxes.value,
      [a.pages[0].key]: { x: 0, y: 0, width: 0.5, height: 0.5 }
    };
    switchDocument('B');
    commit('B');
    cropBoxes.value = {
      ...cropBoxes.value,
      [b.pages[0].key]: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 }
    };

    switchDocument('A');
    undo();
    expect(cropBoxes.value[a.pages[0].key]).toBeUndefined();
    expect(cropBoxes.value[b.pages[0].key]).toEqual({ x: 0.1, y: 0.1, width: 0.5, height: 0.5 });
    redo();
    expect(cropBoxes.value[a.pages[0].key]).toEqual({ x: 0, y: 0, width: 0.5, height: 0.5 });
  });

  it('commit() defaults to the active document', () => {
    seedDoc('A', 'SA');
    seedDoc('B', 'SB'); // active
    commit();
    expect(canUndo('B')).toBe(true);
    expect(canUndo('A')).toBe(false);
  });

  it("a transaction on one document never absorbs another document's edits", () => {
    const a = seedDoc('A', 'SA');
    const b = seedDoc('B', 'SB');
    const tx = beginTransaction('drag', undefined, 'A');
    rotatePages('A', [a.pages[0].key], 90);
    rotatePages('B', [b.pages[0].key], 90); // recorded in B, not swallowed by A's drag
    rotatePages('A', [a.pages[0].key], 90);
    rotatePages('B', [b.pages[0].key], 90);
    tx.end();

    expect(operationLog('A')).toHaveLength(1);
    expect(operationLog('B')).toHaveLength(2);

    switchDocument('A');
    undo();
    expect(docById('A').pages[0].rotation).toBe(0);
    expect(docById('B').pages[0].rotation).toBe(180);
  });

  it("undo refuses while the active document's transaction is open, but not another's", () => {
    const a = seedDoc('A', 'SA');
    const b = seedDoc('B', 'SB');
    rotatePages('A', [a.pages[0].key], 90);
    rotatePages('B', [b.pages[0].key], 90);
    const tx = beginTransaction('drag', undefined, 'B');
    switchDocument('B');
    undo();
    expect(docById('B').pages[0].rotation).toBe(90);
    switchDocument('A');
    undo();
    expect(docById('A').pages[0].rotation).toBe(0);
    tx.end();
  });

  it("closing B drops B's history and frees only B's sources", async () => {
    const a = seedDoc('A', 'SA');
    const b = seedDoc('B', 'SB');
    // Redaction-style rewrites: each document's old source is now reachable
    // only from its own undo stack.
    replaceWithSource('A', {
      id: 'SA2',
      name: 'a.pdf',
      pageCount: 3,
      pageSizes: a.pages.map(() => ({ width: 1, height: 1 }))
    });
    replaceWithSource('B', {
      id: 'SB2',
      name: 'b.pdf',
      pageCount: 3,
      pageSizes: b.pages.map(() => ({ width: 1, height: 1 }))
    });
    expect(historySourceIds()).toEqual(new Set(['SA', 'SB']));

    closeDocument('B');
    expect(canUndo('B')).toBe(false);
    expect(operationLog('B')).toEqual([]);
    expect(Object.keys(sources.value).sort()).toEqual(['SA', 'SA2']);
    expect(historySourceIds()).toEqual(new Set(['SA']));

    // A's undo still reaches its original source.
    switchDocument('A');
    undo();
    expect(docById('A').pages.every(p => p.sourceDocId === 'SA')).toBe(true);
  });

  it('caps each document at MAX_DEPTH and the whole workspace at MAX_TOTAL_SNAPSHOTS', () => {
    const count = Math.ceil(MAX_TOTAL_SNAPSHOTS / MAX_DEPTH) + 1;
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const doc = seedDoc(`D${i}`, `S${i}`, 1);
      ids.push(doc.id);
      for (let step = 0; step < MAX_DEPTH + 5; step++) {
        rotatePages(doc.id, [doc.pages[0].key], 90);
      }
      expect(operationLog(doc.id).length).toBeLessThanOrEqual(MAX_DEPTH);
    }
    const total = ids.reduce((sum, id) => sum + operationLog(id).length, 0);
    expect(total).toBeLessThanOrEqual(MAX_TOTAL_SNAPSHOTS);
    // The most recent document keeps its full depth; the oldest paid for it.
    expect(operationLog(ids.at(-1)).length).toBe(MAX_DEPTH);
    expect(operationLog(ids[0]).length).toBeLessThan(MAX_DEPTH);
  });
});

describe('GAP-11a — session recovery of per-document history', () => {
  it("round-trips every document's stacks through serialize/restore", () => {
    const a = seedDoc('A', 'SA');
    const b = seedDoc('B', 'SB');
    activeToolId.value = 'organize';
    rotatePages('A', [a.pages[0].key], 90);
    rotatePages('B', [b.pages[1].key], 270);
    deletePages('B', [b.pages[2].key]);
    switchDocument('B');
    undo(); // leaves a redo entry in B

    const saved = JSON.parse(JSON.stringify(serializeHistory()));
    resetHistory();
    expect(canUndo('A')).toBe(false);

    restoreHistoryFromRecord(saved, ['A', 'B']);
    expect(operationLog('A').map(e => e.label)).toEqual(['Organize']);
    expect(canRedo('B')).toBe(true);
    redo();
    expect(docById('B').pages).toHaveLength(2);
    undo();
    undo();
    expect(docById('B').pages[1].rotation).toBe(0);
    expect(docById('A').pages[0].rotation).toBe(90);
  });

  it('drops histories of documents that were not restored', () => {
    const a = seedDoc('A', 'SA');
    rotatePages('A', [a.pages[0].key], 90);
    const saved = serializeHistory();
    restoreHistoryFromRecord(saved, ['OTHER']);
    expect(canUndo('A')).toBe(false);
  });

  it('migrates a pre-GAP-11 (global-stack) record by dropping it, not crashing', () => {
    const a = seedDoc('A', 'SA');
    const legacy = {
      undoStack: [{ docs: [a], activeId: 'A', selection: [], cropBoxes: {}, pageAnnotations: {} }],
      redoStack: [],
      undoLog: [{ label: 'Open document', timestamp: 1 }],
      redoLog: []
    };
    expect(normalizeSerializedHistory(legacy)).toEqual({ version: 2, docs: {} });
    expect(() => restoreHistoryFromRecord(legacy, ['A'])).not.toThrow();
    expect(canUndo('A')).toBe(false);
    // Documents are untouched and edits record normally afterwards.
    rotatePages('A', [a.pages[0].key], 90);
    expect(canUndo('A')).toBe(true);
  });

  it('drops a malformed per-document history on its own', () => {
    const a = seedDoc('A', 'SA');
    rotatePages('A', [a.pages[0].key], 90);
    const good = serializeHistory();
    const mixed = {
      version: 2,
      docs: {
        ...good.docs,
        B: { undoStack: [{ nope: true }], redoStack: [], undoLog: [], redoLog: [] }
      }
    };
    const normalized = normalizeSerializedHistory(mixed);
    expect(Object.keys(normalized.docs)).toEqual(['A']);
  });
});
