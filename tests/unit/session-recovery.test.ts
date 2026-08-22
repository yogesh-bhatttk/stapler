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
  restoreSession
} from '../../src/core/session-recovery';

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
