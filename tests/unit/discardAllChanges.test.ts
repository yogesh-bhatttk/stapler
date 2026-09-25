import { beforeEach, describe, expect, it } from 'vitest';
import {
  activeDocId,
  addAnnotation,
  addDocument,
  documents,
  makePageRefs,
  registerSource,
  rotatePages,
  sources,
  type StaplerDoc
} from '../../src/core/store';
import { confirmRequest } from '../../src/core/notify';
import { confirmAndDiscardAllChanges, hasAnythingToDiscard } from '../../src/ui/discardAllChanges';
import { resetHistory, undo } from '../../src/core/history';

function seed(): StaplerDoc {
  registerSource({
    id: 'src-1',
    name: 'a.pdf',
    pageCount: 2,
    pageSizes: [
      { width: 1, height: 1 },
      { width: 1, height: 1 }
    ]
  });
  const pages = makePageRefs('src-1', 2);
  const doc: StaplerDoc = {
    id: 'doc-1',
    name: 'a.pdf',
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
  confirmRequest.value = null;
  resetHistory();
});

describe('confirmAndDiscardAllChanges re-entrancy', () => {
  it('a second call while the first is still awaiting confirmation is a no-op, not an orphaned promise', async () => {
    const doc = seed();
    rotatePages(doc.id, [doc.pages[0].key], 90);
    const dirtyDoc = documents.value[0];

    const first = confirmAndDiscardAllChanges(dirtyDoc);
    // The dialog is now up, backed by the *first* call's request.
    const firstRequest = confirmRequest.value;
    expect(firstRequest).not.toBeNull();

    // A fast double-click, or a second caller, before that dialog had a
    // chance to swallow further clicks. Without a re-entrancy guard, this
    // would replace `confirmRequest` with a second request, and `first`
    // would then never resolve — nothing left holds a reference to
    // `firstRequest.resolve` from the caller's side once it's overwritten.
    const second = confirmAndDiscardAllChanges(dirtyDoc);
    await expect(second).resolves.toBe(false);
    // Still the *first* request — the second call never touched it.
    expect(confirmRequest.value).toBe(firstRequest);

    // Resolving the still-live first request lets the first call complete.
    confirmRequest.value?.resolve(true);
    await expect(first).resolves.toBe(true);
    expect(documents.value[0].pages[0].rotation).toBe(0);
  });

  it('a call after the first has fully resolved works normally', async () => {
    const doc = seed();
    rotatePages(doc.id, [doc.pages[0].key], 90);

    const first = confirmAndDiscardAllChanges(documents.value[0]);
    confirmRequest.value?.resolve(false); // Cancel.
    expect(await first).toBe(false);
    expect(documents.value[0].pages[0].rotation).toBe(90);

    rotatePages(doc.id, [doc.pages[1].key], 180);
    const second = confirmAndDiscardAllChanges(documents.value[0]);
    confirmRequest.value?.resolve(true);
    expect(await second).toBe(true);
    expect(documents.value[0].pages[1].rotation).toBe(0);
  });
});

describe('discard all changes covers Sign stamps and form fields (UI-14)', () => {
  it('offers the action for stamps alone, and clears them undoably', async () => {
    const doc = seed();
    addAnnotation(doc.id, {
      id: 'sig-1',
      pageKey: doc.pages[0].key,
      type: 'signature',
      x: 0.1,
      y: 0.1,
      width: 0.2,
      height: 0.1,
      data: 'sig'
    });
    expect(hasAnythingToDiscard(documents.value[0])).toBe(true);

    const done = confirmAndDiscardAllChanges(documents.value[0]);
    confirmRequest.value?.resolve(true);
    expect(await done).toBe(true);
    expect(documents.value[0].annotations).toEqual([]);

    undo();
    expect(documents.value[0].annotations.map(a => a.id)).toEqual(['sig-1']);
  });
});
