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
  type StaplerDoc
} from '../../src/core/store';
import {
  beginTransaction,
  canRedo,
  canUndo,
  redo,
  resetHistory,
  undo
} from '../../src/core/history';

function seed(pageCount = 5): StaplerDoc {
  registerSource({
    id: 'src',
    name: 'src.pdf',
    bytes: new Uint8Array([1]),
    pageCount,
    pageSizes: Array.from({ length: pageCount }, () => ({ width: 595, height: 842 }))
  });
  const doc: StaplerDoc = {
    id: 'doc-1',
    name: 'doc.pdf',
    pages: makePageRefs('src', pageCount),
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
});
