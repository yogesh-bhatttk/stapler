import { beforeEach, describe, expect, it } from 'vitest';
import {
  activeDocId,
  addDocument,
  appendPages,
  bytesForPages,
  closeDocument,
  deletePages,
  documents,
  duplicatePages,
  insertPages,
  makePageRefs,
  movePages,
  registerSource,
  repointPage,
  replaceWithSource,
  rotatePages,
  selectPageRange,
  selectedPageKeys,
  setPageSelection,
  sourceDocRefCount,
  sourceRefCount,
  sources,
  type StaplerDoc
} from '../../src/core/store';
import { historySourceRefCount, resetHistory } from '../../src/core/history';
import { __memoryFallback } from '../../src/core/opfs';

function seed(pageCount = 5, sourceId = 'src-a'): StaplerDoc {
  const id = sourceId ?? crypto.randomUUID();
  __memoryFallback.set(id, new Uint8Array([1, 2, 3]));
  registerSource({
    id: sourceId,
    name: `${sourceId}.pdf`,
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

describe('insertPages', () => {
  it('inserts at the given index, leaving everything else in place', () => {
    const doc = seed(3, 'src-a');
    const originalKeys = doc.pages.map(p => p.key);
    registerSource({
      id: 'src-b',
      name: 'src-b.pdf',
      bytes: new Uint8Array([9]),
      pageCount: 2,
      pageSizes: [
        { width: 595, height: 842 },
        { width: 595, height: 842 }
      ]
    });
    const inserted = makePageRefs('src-b', 2);

    insertPages(doc.id, inserted, 1);

    expect(documents.value[0].pages.map(p => p.key)).toEqual([
      originalKeys[0],
      inserted[0].key,
      inserted[1].key,
      originalKeys[1],
      originalKeys[2]
    ]);
  });

  it('clamps an out-of-range index to the end', () => {
    const doc = seed(2, 'src-a');
    const inserted = makePageRefs('src-a', 1);

    insertPages(doc.id, inserted, 99);

    const keys = documents.value[0].pages.map(p => p.key);
    expect(keys).toHaveLength(3);
    expect(keys[2]).toBe(inserted[0].key);
  });

  it('clamps a negative index to the start', () => {
    const doc = seed(2, 'src-a');
    const inserted = makePageRefs('src-a', 1);

    insertPages(doc.id, inserted, -5);

    expect(documents.value[0].pages[0].key).toBe(inserted[0].key);
  });

  it('does nothing for an empty page list', () => {
    const doc = seed(2);
    insertPages(doc.id, [], 1);
    expect(order()).toEqual([0, 1]);
  });

  it('leaves the source document that the inserted pages came from untouched', () => {
    const doc = seed(2, 'src-a');
    registerSource({
      id: 'src-b',
      name: 'src-b.pdf',
      bytes: new Uint8Array([1, 2, 3]),
      pageCount: 4,
      pageSizes: Array.from({ length: 4 }, () => ({ width: 595, height: 842 }))
    });
    const sourceBytesBefore = sources.value['src-b'].bytes;
    const inserted = makePageRefs('src-b', 4);

    insertPages(doc.id, inserted, 1);

    // Inserting only ever creates new PageRefs pointing at the existing source;
    // the source's own bytes are never read back out or mutated by this call.
    expect(sources.value['src-b'].bytes).toBe(sourceBytesBefore);
  });
});

describe('appendPages', () => {
  it('adds pages after the current last page', () => {
    const doc = seed(2, 'src-a');
    const inserted = makePageRefs('src-a', 1);

    appendPages(doc.id, inserted);

    const keys = documents.value[0].pages.map(p => p.key);
    expect(keys).toHaveLength(3);
    expect(keys[2]).toBe(inserted[0].key);
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
  it('returns only the sources the given pages refer to', async () => {
    const doc = seed(3, 'src-a');
    __memoryFallback.set('src-b', new Uint8Array([9]));
    registerSource({
      id: 'src-b',
      name: 'b.pdf',
      pageCount: 1,
      pageSizes: [{ width: 10, height: 10 }]
    });
    expect(Object.keys(await bytesForPages(doc.pages))).toEqual(['src-a']);
  });

  it('deduplicates a source referenced by many pages', async () => {
    const doc = seed(50);
    expect(Object.keys(await bytesForPages(doc.pages)).length).toBe(1);
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

  it('points at the page of the new source it is told to, not always page 1', () => {
    // Scan cleanup's flatten path hands back a rebuilt *whole* document. Repointing
    // page 5 at it with the old hardcoded index made page 5 render, and export, the
    // rebuilt document's page 1.
    const doc = seed(6);
    const key = doc.pages[4].key;
    registerSource({
      id: 'rebuilt',
      name: 'rebuilt.pdf',
      bytes: new Uint8Array([9]),
      pageCount: 6,
      pageSizes: Array.from({ length: 6 }, () => ({ width: 595, height: 842 }))
    });
    repointPage(doc.id, key, 'rebuilt', 4);
    const page = documents.value[0].pages[4];
    expect(page.key).toBe(key);
    expect(page.sourceDocId).toBe('rebuilt');
    expect(page.sourceIndex).toBe(4);
    // No other page moved.
    expect(documents.value[0].pages.map(p => p.sourceIndex)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

/**
 * AUDIT-FINDINGS §4 — source byte ownership.
 *
 * These counts exist so a `postMessage` transfer list can never detach a buffer
 * something else still reads. They are asserted here independently of any
 * transfer logic, because the counting is the part that has to be right: an
 * under-count is a blank document with no error message.
 */
describe('source reference counting', () => {
  it('counts two pages of one document sharing a source as 2 pages, 1 document', () => {
    const doc = seed(2, 'src-a');
    expect(sourceRefCount('src-a')).toBe(2);
    expect(sourceDocRefCount('src-a')).toBe(1);
    expect(doc.pages).toHaveLength(2);
  });

  it('counts two documents sharing a source as 2 documents', () => {
    seed(1, 'shared');
    addDocument({
      id: 'doc-2',
      name: 'second.pdf',
      pages: makePageRefs('shared', 1),
      annotations: [],
      dirty: false
    });
    expect(sourceRefCount('shared')).toBe(2);
    expect(sourceDocRefCount('shared')).toBe(2);
  });

  it('drops to one document when one of the two is closed', () => {
    const first = seed(1, 'shared');
    addDocument({
      id: 'doc-2',
      name: 'second.pdf',
      pages: makePageRefs('shared', 1),
      annotations: [],
      dirty: false
    });
    closeDocument(first.id);
    expect(sourceDocRefCount('shared')).toBe(1);
    expect(sourceRefCount('shared')).toBe(1);
    // Still registered, because a document still needs it.
    expect(sources.value['shared']).toBeDefined();
  });

  it('drops to zero when the last referencing page is deleted', () => {
    const doc = seed(2, 'src-a');
    deletePages(doc.id, [doc.pages[0].key]);
    expect(sourceRefCount('src-a')).toBe(1);
    deletePages(doc.id, [doc.pages[1].key]);
    expect(sourceRefCount('src-a')).toBe(0);
    expect(sourceDocRefCount('src-a')).toBe(0);
  });

  it('follows duplicate, insert, move and repoint without any bookkeeping of its own', () => {
    const doc = seed(2, 'src-a');
    duplicatePages(doc.id, [doc.pages[0].key]);
    expect(sourceRefCount('src-a')).toBe(3);

    registerSource({
      id: 'src-b',
      name: 'b.pdf',
      bytes: new Uint8Array([9]),
      pageCount: 2,
      pageSizes: [
        { width: 10, height: 10 },
        { width: 10, height: 10 }
      ]
    });
    insertPages(doc.id, makePageRefs('src-b', 2), 1);
    expect(sourceRefCount('src-b')).toBe(2);
    expect(sourceDocRefCount('src-b')).toBe(1);

    // A move changes order, never ownership.
    const keys = documents.value[0].pages.map(p => p.key);
    movePages(doc.id, [keys[0]], 4);
    expect(sourceRefCount('src-a')).toBe(3);

    // Repointing the last page off a source is the same as deleting it, as far
    // as that source's bytes are concerned.
    for (const page of documents.value[0].pages.filter(p => p.sourceDocId === 'src-a')) {
      repointPage(doc.id, page.key, 'src-b', 0);
    }
    expect(sourceRefCount('src-a')).toBe(0);
    expect(sourceRefCount('src-b')).toBe(5);
  });

  it('counts a replaced source as gone and the replacement as owned', () => {
    const doc = seed(3, 'src-a');
    replaceWithSource(doc.id, {
      id: 'redacted',
      name: 'redacted.pdf',
      bytes: new Uint8Array([4, 5, 6]),
      pageCount: 3,
      pageSizes: Array.from({ length: 3 }, () => ({ width: 595, height: 842 }))
    });
    expect(sourceRefCount('src-a')).toBe(0);
    expect(sourceRefCount('redacted')).toBe(3);
    expect(sourceDocRefCount('redacted')).toBe(1);
  });
});

