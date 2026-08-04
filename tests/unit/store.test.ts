import { beforeEach, describe, expect, it } from 'vitest';
import {
  activeDocId,
  addDocument,
  bytesForPages,
  closeDocument,
  deletePages,
  documents,
  duplicatePages,
  makePageRefs,
  movePages,
  registerSource,
  repointPage,
  rotatePages,
  selectPageRange,
  selectedPageKeys,
  setPageSelection,
  sources,
  type StaplerDoc
} from '../../src/core/store';
import { resetHistory } from '../../src/core/history';

function seed(pageCount = 5, sourceId = 'src-a'): StaplerDoc {
  registerSource({
    id: sourceId,
    name: `${sourceId}.pdf`,
    bytes: new Uint8Array([1, 2, 3]),
    pageCount,
    pageSizes: Array.from({ length: pageCount }, () => ({ width: 595, height: 842 }))
  });
  const doc: StaplerDoc = {
    id: 'doc-1',
    name: 'doc.pdf',
    pages: makePageRefs(sourceId, pageCount),
    annotations: [],
    dirty: false
  };
  addDocument(doc);
  return doc;
}

const order = () => documents.value[0].pages.map(p => p.sourceIndex);

beforeEach(() => {
  documents.value = [];
  sources.value = {};
  activeDocId.value = null;
  selectedPageKeys.value = new Set();
  resetHistory();
});

describe('movePages', () => {
  it('moves one page forward', () => {
    const doc = seed();
    movePages(doc.id, [doc.pages[0].key], 3);
    expect(order()).toEqual([1, 2, 0, 3, 4]);
  });

  it('moves one page backward', () => {
    const doc = seed();
    movePages(doc.id, [doc.pages[4].key], 1);
    expect(order()).toEqual([0, 4, 1, 2, 3]);
  });

  // The old single-index splice could only move one page, so dragging a multi-page
  // selection silently moved just the one under the cursor.
  it('moves a multi-page selection and keeps its relative order', () => {
    const doc = seed();
    movePages(doc.id, [doc.pages[0].key, doc.pages[1].key], 4);
    expect(order()).toEqual([2, 3, 0, 1, 4]);
  });

  it('clamps a target beyond the end', () => {
    const doc = seed();
    movePages(doc.id, [doc.pages[0].key], 99);
    expect(order()).toEqual([1, 2, 3, 4, 0]);
  });

  it('never loses or duplicates a page', () => {
    const doc = seed(20);
    for (const to of [0, 5, 19, 20, -3]) {
      movePages(doc.id, [documents.value[0].pages[7].key], to);
      expect(new Set(order()).size).toBe(20);
    }
  });

  it('ignores an empty key set', () => {
    const doc = seed();
    movePages(doc.id, [], 2);
    expect(order()).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('rotatePages', () => {
  it('normalises anticlockwise rotation instead of going negative', () => {
    const doc = seed(1);
    rotatePages(doc.id, [doc.pages[0].key], -90);
    expect(documents.value[0].pages[0].rotation).toBe(270);
  });

  it('wraps a full turn back to zero', () => {
    const doc = seed(1);
    for (let i = 0; i < 4; i++) rotatePages(doc.id, [doc.pages[0].key], 90);
    expect(documents.value[0].pages[0].rotation).toBe(0);
  });

  it('rotates only the named pages', () => {
    const doc = seed(3);
    rotatePages(doc.id, [doc.pages[1].key], 90);
    expect(documents.value[0].pages.map(p => p.rotation)).toEqual([0, 90, 0]);
  });
});

describe('deletePages', () => {
  it('removes the pages and prunes them from the selection', () => {
    const doc = seed(4);
    setPageSelection([doc.pages[1].key, doc.pages[2].key]);
    deletePages(doc.id, [doc.pages[1].key]);
    expect(order()).toEqual([0, 2, 3]);
    expect([...selectedPageKeys.value]).toEqual([doc.pages[2].key]);
  });

  it('marks the document dirty', () => {
    const doc = seed(3);
    expect(documents.value[0].dirty).toBe(false);
    deletePages(doc.id, [doc.pages[0].key]);
    expect(documents.value[0].dirty).toBe(true);
  });
});

describe('duplicatePages', () => {
  it('inserts a copy after the original with a distinct key', () => {
    const doc = seed(2);
    duplicatePages(doc.id, [doc.pages[0].key]);
    const pages = documents.value[0].pages;
    expect(pages.map(p => p.sourceIndex)).toEqual([0, 0, 1]);
    expect(new Set(pages.map(p => p.key)).size).toBe(3);
  });
});

describe('selectPageRange', () => {
  it('selects inclusively in either direction', () => {
    const doc = seed(5);
    selectPageRange(doc.id, doc.pages[1].key, doc.pages[3].key);
    expect(selectedPageKeys.value.size).toBe(3);
    selectPageRange(doc.id, doc.pages[3].key, doc.pages[1].key);
    expect(selectedPageKeys.value.size).toBe(3);
  });
});

describe('bytesForPages', () => {
  // The old export path sent every open document's bytes to the worker on every
  // export, copying hundreds of megabytes for a one-page extract.
  it('returns only the sources the given pages refer to', () => {
    const doc = seed(3, 'src-a');
    registerSource({
      id: 'src-b',
      name: 'b.pdf',
      bytes: new Uint8Array([9]),
      pageCount: 1,
      pageSizes: [{ width: 10, height: 10 }]
    });
    expect(Object.keys(bytesForPages(doc.pages))).toEqual(['src-a']);
  });

  it('deduplicates a source referenced by many pages', () => {
    const doc = seed(50);
    expect(Object.keys(bytesForPages(doc.pages)).length).toBe(1);
  });
});

describe('closeDocument', () => {
  it('frees sources nothing references any more', () => {
    const doc = seed(2, 'src-a');
    expect(Object.keys(sources.value)).toEqual(['src-a']);
    closeDocument(doc.id);
    expect(Object.keys(sources.value)).toEqual([]);
    expect(activeDocId.value).toBeNull();
  });

  it('keeps a source another open document still uses', () => {
    const first = seed(2, 'shared');
    addDocument({
      id: 'doc-2',
      name: 'second.pdf',
      pages: makePageRefs('shared', 2),
      annotations: [],
      dirty: false
    });
    closeDocument(first.id);
    expect(Object.keys(sources.value)).toEqual(['shared']);
    expect(activeDocId.value).toBe('doc-2');
  });
});

describe('repointPage', () => {
  it('keeps the page key so selection and stamps still resolve', () => {
    const doc = seed(2);
    const key = doc.pages[1].key;
    registerSource({
      id: 'cleaned',
      name: 'cleaned.pdf',
      bytes: new Uint8Array([7]),
      pageCount: 1,
      pageSizes: [{ width: 595, height: 842 }]
    });
    repointPage(doc.id, key, 'cleaned');
    const page = documents.value[0].pages[1];
    expect(page.key).toBe(key);
    expect(page.sourceDocId).toBe('cleaned');
    expect(page.sourceIndex).toBe(0);
  });
});
