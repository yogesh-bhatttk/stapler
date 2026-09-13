import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DOC-11's own AC: a saved session round-trips exactly, and a decline clears
 * the record rather than leaving it to be offered again next launch.
 *
 * `db.ts` is mocked with an in-memory map (no IndexedDB in Node), the same
 * pattern `faceblur-consent.test.ts` already established for exactly this
 * reason.
 */
const settings = new Map<string, unknown>();

vi.mock('../../src/core/db', () => ({
  readSetting: vi.fn(async (key: string) => settings.get(key)),
  writeSetting: vi.fn(async (key: string, value: unknown) => {
    settings.set(key, value);
  })
}));

import {
  documents,
  sources,
  activeDocId,
  selectedPageKeys,
  addDocument,
  registerSource,
  makePageRefs,
  rotatePage,
  type StaplerDoc
} from '../../src/core/store';
import { cropBoxes } from '../../src/ui/tools/crop/state';
import { pageAnnotations } from '../../src/ui/tools/annotate/state';
import { undo, canUndo, resetHistory } from '../../src/core/history';
import {
  saveSession,
  loadPendingRecovery,
  clearSession,
  restoreSession,
  checkRecovery
} from '../../src/core/session-recovery';
import { writeSourceBytes, deleteSourceBytes } from '../../src/core/opfs';

function resetWorkspace() {
  settings.clear();
  resetHistory();
  documents.value = [];
  sources.value = {};
  activeDocId.value = null;
  selectedPageKeys.value = new Set();
  cropBoxes.value = {};
  pageAnnotations.value = {};
}

beforeEach(resetWorkspace);
afterEach(resetWorkspace);

describe('session-recovery (DOC-11)', () => {
  it('returns null when nothing has been saved', async () => {
    expect(await loadPendingRecovery()).toBeNull();
  });

  it('saves and restores the exact document, source, and selection state', async () => {
    registerSource({
      id: 'src-1',
      name: 'a.pdf',
      pageCount: 2,
      pageSizes: [
        { width: 1, height: 1 },
        { width: 1, height: 1 }
      ]
    });
    const doc: StaplerDoc = {
      id: 'doc-1',
      name: 'a.pdf',
      pages: makePageRefs('src-1', 2),
      annotations: [],
      dirty: true
    };
    addDocument(doc);
    selectedPageKeys.value = new Set([doc.pages[0].key]);

    await saveSession();

    // Simulate a reload: the live signals go back to their fresh-boot state.
    documents.value = [];
    sources.value = {};
    activeDocId.value = null;
    selectedPageKeys.value = new Set();

    const record = await loadPendingRecovery();
    expect(record).not.toBeNull();
    restoreSession(record!);

    expect(documents.value).toHaveLength(1);
    expect(documents.value[0].id).toBe('doc-1');
    expect(documents.value[0].pages).toHaveLength(2);
    expect(sources.value['src-1']?.name).toBe('a.pdf');
    expect(activeDocId.value).toBe('doc-1');
    expect(selectedPageKeys.value).toEqual(new Set([doc.pages[0].key]));
  });

  it('restores the undo stack, not just the current state', async () => {
    registerSource({
      id: 'src-2',
      name: 'b.pdf',
      pageCount: 1,
      pageSizes: [{ width: 1, height: 1 }]
    });
    const doc: StaplerDoc = {
      id: 'doc-2',
      name: 'b.pdf',
      pages: makePageRefs('src-2', 1),
      annotations: [],
      dirty: false
    };
    addDocument(doc);
    const pageKey = doc.pages[0].key;

    // A real mutation, so there is a real undo entry to recover.
    rotatePage('doc-2', pageKey, 90);
    expect(documents.value[0].pages[0].rotation).toBe(90);

    await saveSession();

    documents.value = [];
    activeDocId.value = null;
    resetHistory();
    expect(canUndo()).toBe(false);

    const record = await loadPendingRecovery();
    restoreSession(record!);

    expect(documents.value[0].pages[0].rotation).toBe(90);
    expect(canUndo()).toBe(true);
    undo();
    expect(documents.value[0].pages[0].rotation).toBe(0);
  });

  it('restores crop boxes and page annotations, not just documents and selection', async () => {
    registerSource({
      id: 'src-5',
      name: 'e.pdf',
      pageCount: 1,
      pageSizes: [{ width: 100, height: 100 }]
    });
    const doc: StaplerDoc = {
      id: 'doc-5',
      name: 'e.pdf',
      pages: makePageRefs('src-5', 1),
      annotations: [],
      dirty: false
    };
    addDocument(doc);
    const pageKey = doc.pages[0].key;
    cropBoxes.value = { [pageKey]: { x: 1, y: 2, width: 3, height: 4 } };
    pageAnnotations.value = {
      [pageKey]: [
        {
          id: 'ann-1',
          pageKey,
          type: 'highlight',
          color: '#ffeb3b',
          strokeWidth: 2,
          rect: { x: 0, y: 0, width: 10, height: 10 }
        }
      ]
    };

    await saveSession();

    documents.value = [];
    cropBoxes.value = {};
    pageAnnotations.value = {};

    const record = await loadPendingRecovery();
    restoreSession(record!);

    expect(cropBoxes.value[pageKey]).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    expect(pageAnnotations.value[pageKey]).toHaveLength(1);
    expect(pageAnnotations.value[pageKey][0].type).toBe('highlight');
  });

  it('backfills a missing baseline from a record saved before that field existed', async () => {
    // `baseline` was added after this record format shipped — IndexedDB has no
    // schema to migrate the JSON payload against, so a record written by an
    // older build restores with no `baseline` on its documents at all. This
    // writes exactly that shape directly (bypassing `saveSession`, which only
    // ever captures *current*, already-baseline'd `documents.value`) to prove
    // `restoreSession` backfills it rather than handing back a document that
    // crashes the first time anything reads `doc.baseline`.
    const pages = makePageRefs('src-8', 1);
    const legacyDoc = { id: 'doc-8', name: 'h.pdf', pages, annotations: [], dirty: false };
    await writeSourceBytes('src-8', new Uint8Array([1, 2, 3]));
    registerSource({
      id: 'src-8',
      name: 'h.pdf',
      pageCount: 1,
      pageSizes: [{ width: 1, height: 1 }]
    });
    settings.set('session.recovery', {
      documents: [legacyDoc],
      sources: sources.value,
      activeDocId: 'doc-8',
      selection: [],
      cropBoxes: {},
      pageAnnotations: {},
      history: { undoStack: [], redoStack: [], undoLog: [], redoLog: [] },
      savedAt: Date.now()
    });

    const record = await loadPendingRecovery();
    restoreSession(record!);

    expect(documents.value[0].baseline).toEqual(pages);
  });

  it('clears the record once every document is closed, rather than saving an empty one', async () => {
    registerSource({
      id: 'src-3',
      name: 'c.pdf',
      pageCount: 1,
      pageSizes: [{ width: 1, height: 1 }]
    });
    addDocument({
      id: 'doc-3',
      name: 'c.pdf',
      pages: makePageRefs('src-3', 1),
      annotations: [],
      dirty: false
    });
    await saveSession();
    expect(await loadPendingRecovery()).not.toBeNull();

    documents.value = [];
    await saveSession();
    expect(await loadPendingRecovery()).toBeNull();
  });

  it('checkRecovery passes a record through unchanged when every source still has bytes', async () => {
    await writeSourceBytes('src-6', new Uint8Array([1, 2, 3]));
    registerSource({
      id: 'src-6',
      name: 'f.pdf',
      pageCount: 1,
      pageSizes: [{ width: 1, height: 1 }]
    });
    addDocument({
      id: 'doc-6',
      name: 'f.pdf',
      pages: makePageRefs('src-6', 1),
      annotations: [],
      dirty: false
    });
    await saveSession();
    const record = await loadPendingRecovery();

    const checked = await checkRecovery(record!);
    expect(checked?.droppedDocuments).toBe(0);
    expect(checked?.record.documents).toHaveLength(1);
  });

  it('checkRecovery drops a document whose source bytes are gone, instead of restoring a dangling reference', async () => {
    await writeSourceBytes('src-7', new Uint8Array([1, 2, 3]));
    registerSource({
      id: 'src-7',
      name: 'g.pdf',
      pageCount: 1,
      pageSizes: [{ width: 1, height: 1 }]
    });
    addDocument({
      id: 'doc-7',
      name: 'g.pdf',
      pages: makePageRefs('src-7', 1),
      annotations: [],
      dirty: false
    });
    await saveSession();
    const record = await loadPendingRecovery();

    // Simulate the race this guards against: the source's bytes are gone by
    // the time recovery is checked (a browser without OPFS support, or a
    // close-then-crash before the next autosave), while the pointer survived.
    await deleteSourceBytes('src-7');

    expect(await checkRecovery(record!)).toBeNull();
  });

  it('checkRecovery drops a document whose BASELINE (not current pages) points at gone bytes', async () => {
    // The dangling reference `closeDocument`'s own source GC already guards
    // against (`store.ts` unions `pages` and `baseline` before freeing a
    // source): current pages all resolve, but a since-deleted page is still
    // sitting in baseline pointing at a source whose bytes are gone. Built
    // directly rather than through `addDocument` (which always sets
    // `baseline: pages`) to get pages and baseline pointing at different
    // sources, the way an edited-then-partially-reverted document can.
    await writeSourceBytes('src-9-live', new Uint8Array([1, 2, 3]));
    await writeSourceBytes('src-9-gone', new Uint8Array([4, 5, 6]));
    registerSource({
      id: 'src-9-live',
      name: 'i.pdf',
      pageCount: 1,
      pageSizes: [{ width: 1, height: 1 }]
    });
    registerSource({
      id: 'src-9-gone',
      name: 'i-old.pdf',
      pageCount: 1,
      pageSizes: [{ width: 1, height: 1 }]
    });
    const currentPages = makePageRefs('src-9-live', 1);
    const baselinePages = makePageRefs('src-9-gone', 1);
    const doc = {
      id: 'doc-9',
      name: 'i.pdf',
      pages: currentPages,
      baseline: baselinePages,
      annotations: [],
      dirty: true
    };
    settings.set('session.recovery', {
      documents: [doc],
      sources: sources.value,
      activeDocId: 'doc-9',
      selection: [],
      cropBoxes: {},
      pageAnnotations: {},
      history: { undoStack: [], redoStack: [], undoLog: [], redoLog: [] },
      savedAt: Date.now()
    });
    const record = await loadPendingRecovery();

    // The race: baseline's source is gone by the time recovery is checked,
    // even though every *current* page still resolves fine.
    await deleteSourceBytes('src-9-gone');

    expect(await checkRecovery(record!)).toBeNull();
  });

  it('leaves no record after an explicit decline, so it is not offered again', async () => {
    registerSource({
      id: 'src-4',
      name: 'd.pdf',
      pageCount: 1,
      pageSizes: [{ width: 1, height: 1 }]
    });
    addDocument({
      id: 'doc-4',
      name: 'd.pdf',
      pages: makePageRefs('src-4', 1),
      annotations: [],
      dirty: false
    });
    await saveSession();
    expect(await loadPendingRecovery()).not.toBeNull();

    await clearSession();
    expect(await loadPendingRecovery()).toBeNull();
  });
});
