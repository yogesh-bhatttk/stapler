/**
 * AUDIT-2026-10-01 "Runtime and storage" — regression tests built from the
 * audit's probes (history.probe.ts, cap.probe.ts, opfs.probe.ts) plus the
 * findings fixed alongside them:
 *
 *  • RT-1 — undo past a save is dirty against the saved file; the live
 *    `sourceHandle` survives undo/redo.
 *  • RT-2 — "Open the repaired copy" refuses at the document ceiling without
 *    orphaning the source, and a double-click opens one copy.
 *  • RT-3 — `clearStaplerFiles` counts a locked file as a failure.
 *  • RT-5 — tesseract's cache open is bounded.
 *  • RT-6 — session restore trims to `MAX_OPEN_DOCUMENTS` and reports it.
 *  • RT-7 — restored redo stacks and the workspace-wide total are capped.
 *  • RT-8 / PLT-5 — the `stapler-meta` delete is bounded; the share inbox is
 *    deleted (and a missing `caches` is not an error).
 *  • UI-9 — the chosen repair file can be cleared.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activeDocId,
  addAnnotation,
  addDocument,
  documents,
  makePageRefs,
  refreshBaseline,
  registerSource,
  replaceWithSource,
  rotatePages,
  selectedPageKeys,
  sources,
  type SourceDocument,
  type StaplerDoc
} from '../../src/core/store';
import {
  MAX_DEPTH,
  MAX_TOTAL_SNAPSHOTS,
  redo,
  resetHistory,
  restoreHistoryFromRecord,
  serializeHistory,
  undo,
  type DocSnapshot
} from '../../src/core/history';
import { checkRecovery, restoreSession, type SessionRecord } from '../../src/core/session-recovery';
import { MAX_OPEN_DOCUMENTS } from '../../src/core/workspace-limits';
import { __memoryFallback, __resetOpfsProbeForTests, clearStaplerFiles } from '../../src/core/opfs';
import { deleteMetaDatabase, deleteShareInbox, isPartialClear } from '../../src/core/local-data';
import { SHARE_INBOX_CACHE } from '../../src/platform/pwa/share-inbox';
import { __openDbForTests } from '../../src/core/ocr/tesseractCache';
import {
  clearRepairCandidate,
  lastRepair,
  openingRepaired,
  openRepairedCopy,
  repairCandidate,
  type RepairRun
} from '../../src/ui/tools/repair/state';
import { cropBoxes } from '../../src/ui/tools/crop/state';
import { pageAnnotations } from '../../src/ui/tools/annotate/state';

const nav = navigator as unknown as { storage?: unknown };
const originalStorage = nav.storage;
const g = globalThis as unknown as { indexedDB?: unknown; caches?: unknown };
const originalIndexedDB = g.indexedDB;
const originalCaches = g.caches;

function resetWorkspace(): void {
  documents.value = [];
  sources.value = {};
  activeDocId.value = null;
  selectedPageKeys.value = new Set();
  cropBoxes.value = {};
  pageAnnotations.value = {};
  resetHistory();
  __memoryFallback.clear();
  __resetOpfsProbeForTests();
  openingRepaired.value = false;
  repairCandidate.value = null;
  lastRepair.value = null;
}

beforeEach(resetWorkspace);
afterEach(() => {
  resetWorkspace();
  nav.storage = originalStorage;
  g.indexedDB = originalIndexedDB;
  g.caches = originalCaches;
});

function source(id: string, pageCount = 2): SourceDocument {
  const src: SourceDocument = {
    id,
    name: `${id}.pdf`,
    pageCount,
    pageSizes: Array.from({ length: pageCount }, () => ({ width: 1, height: 1 }))
  };
  registerSource(src);
  return src;
}

function open(id: string, sourceId = 's', extra: Partial<StaplerDoc> = {}): StaplerDoc {
  expect(
    addDocument({
      id,
      name: `${id}.pdf`,
      pages: makePageRefs(sourceId, 2),
      annotations: [],
      dirty: false,
      ...extra
    })
  ).toBe(true);
  return documents.value.find(d => d.id === id)!;
}

const live = (id: string) => documents.value.find(d => d.id === id)!;

describe('RT-1 — undo past a save', () => {
  it('rotate → save over original → undo: dirty against the saved file', () => {
    source('s');
    open('A', 's', { sourceHandle: { fileId: 'f1', writable: true } });
    rotatePages('A', [live('A').pages[0].key], 90);
    const rotated = live('A').pages;
    expect(live('A').dirty).toBe(true);

    // What `save()` does on success: the bytes on disk are now `rotated`.
    refreshBaseline('A', rotated);
    expect(live('A').dirty).toBe(false);

    undo();
    const after = live('A');
    expect(after.pages[0].rotation).toBe(0);
    // The disk holds the rotated file, so the reverted state is unsaved.
    expect(after.dirty).toBe(true);
    expect(after.baseline).toBe(rotated);
    expect(after.baseline[0].rotation).toBe(90);
    expect(after.sourceHandle).toEqual({ fileId: 'f1', writable: true });

    // Redo lands back on exactly what was saved: clean again.
    redo();
    expect(live('A').pages[0].rotation).toBe(90);
    expect(live('A').dirty).toBe(false);
  });

  it('undo with no save in between is still clean', () => {
    source('s');
    open('A');
    rotatePages('A', [live('A').pages[0].key], 90);
    undo();
    expect(live('A').dirty).toBe(false);
  });

  it('an annotation saved, then undone, is unsaved', () => {
    source('s');
    open('A');
    addAnnotation('A', {
      id: 'n1',
      pageKey: live('A').pages[0].key,
      type: 'text',
      x: 0.1,
      y: 0.1,
      width: 0.2,
      height: 0.05,
      data: 'hello'
    });
    refreshBaseline('A', live('A').pages);
    expect(live('A').dirty).toBe(false);
    undo();
    expect(live('A').annotations).toEqual([]);
    expect(live('A').dirty).toBe(true);
    redo();
    expect(live('A').dirty).toBe(false);
  });

  it('an annotation added while a save was in flight stays unsaved', () => {
    source('s');
    open('A');
    // The save captured the document as it was: pages and no annotations.
    const written = live('A');
    addAnnotation('A', {
      id: 'late',
      pageKey: written.pages[0].key,
      type: 'text',
      x: 0.1,
      y: 0.1,
      width: 0.2,
      height: 0.05,
      data: 'added under the save dialog'
    });
    expect(live('A').pages).toBe(written.pages); // page list untouched
    refreshBaseline('A', written.pages, written.annotations);
    expect(live('A').dirty).toBe(true);
    expect(live('A').baselineAnnotations).toEqual([]);
  });

  it('keeps the live sourceHandle across undo and redo', () => {
    source('s');
    open('A');
    rotatePages('A', [live('A').pages[0].key], 90);
    // A handle acquired after the edit (not undoable state).
    documents.value = documents.value.map(d =>
      d.id === 'A' ? { ...d, sourceHandle: { fileId: 'f2', writable: true } } : d
    );
    undo();
    expect(live('A').sourceHandle).toEqual({ fileId: 'f2', writable: true });
    redo();
    expect(live('A').sourceHandle).toEqual({ fileId: 'f2', writable: true });
  });

  // AUDIT-2026-10-10 — `replaceWithSource` no longer moves the baseline (a
  // rewrite is an unsaved edit until a save re-anchors it), so the baseline
  // is the opened one throughout and undoing the rewrite lands clean.
  it('a replaceWithSource rewrite leaves the baseline alone; undoing it lands clean', () => {
    source('s');
    const opened = open('A');
    source('redacted', 2);
    replaceWithSource('A', {
      id: 'redacted',
      name: 'redacted.pdf',
      pageCount: 2,
      pageSizes: [
        { width: 1, height: 1 },
        { width: 1, height: 1 }
      ]
    });
    expect(live('A').baseline).toBe(opened.baseline);
    expect(live('A').dirty).toBe(true);
    undo();
    expect(live('A').baseline).toBe(opened.baseline);
    expect(live('A').dirty).toBe(false);
  });
});

function snapshot(docId: string, n: number): DocSnapshot {
  const pages = makePageRefs('s', 1);
  return {
    doc: {
      id: docId,
      name: `${docId}-${n}`,
      pages,
      baseline: pages,
      annotations: [],
      dirty: false
    },
    selection: [],
    cropBoxes: {},
    pageAnnotations: {}
  };
}

function stack(docId: string, length: number) {
  return {
    snapshots: Array.from({ length }, (_, i) => snapshot(docId, i)),
    log: Array.from({ length }, (_, i) => ({ label: 'Edit', timestamp: i }))
  };
}

describe('RT-7 — restored history is capped', () => {
  it('caps a restored redo stack at MAX_DEPTH, keeping the next steps to redo', () => {
    const redoSide = stack('A', MAX_DEPTH + 30);
    restoreHistoryFromRecord({
      version: 2,
      docs: {
        A: { undoStack: [], undoLog: [], redoStack: redoSide.snapshots, redoLog: redoSide.log }
      }
    });
    const restored = serializeHistory().docs.A;
    expect(restored.redoStack).toHaveLength(MAX_DEPTH);
    expect(restored.redoLog).toHaveLength(MAX_DEPTH);
    // The top of the redo stack (its last element) is the step redo applies next.
    expect(restored.redoStack.at(-1)).toBe(redoSide.snapshots.at(-1));
  });

  it('applies MAX_TOTAL_SNAPSHOTS across documents, sparing the active one', () => {
    const docs: Record<string, unknown> = {};
    const count = Math.ceil((MAX_TOTAL_SNAPSHOTS * 2) / (MAX_DEPTH * 2)) + 1;
    for (let i = 0; i < count; i++) {
      const id = `D${i}`;
      const u = stack(id, MAX_DEPTH);
      const r = stack(id, MAX_DEPTH);
      docs[id] = { undoStack: u.snapshots, undoLog: u.log, redoStack: r.snapshots, redoLog: r.log };
    }
    activeDocId.value = 'D0';
    restoreHistoryFromRecord({ version: 2, docs });
    const all = serializeHistory().docs;
    const total = Object.values(all).reduce(
      (sum, h) => sum + h.undoStack.length + h.redoStack.length,
      0
    );
    expect(total).toBeLessThanOrEqual(MAX_TOTAL_SNAPSHOTS);
    expect(all.D0.undoStack).toHaveLength(MAX_DEPTH);
    expect(all.D0.redoStack).toHaveLength(MAX_DEPTH);
    for (const h of Object.values(all)) {
      expect(h.undoStack.length).toBe(h.undoLog.length);
      expect(h.redoStack.length).toBe(h.redoLog.length);
    }
  });
});

function recordOf(count: number, activeIndex = 0): SessionRecord {
  const docs: StaplerDoc[] = Array.from({ length: count }, (_, i) => {
    const pages = makePageRefs(`s${i}`, 1);
    return {
      id: `r${i}`,
      name: `r${i}.pdf`,
      pages,
      baseline: pages,
      annotations: [],
      dirty: false
    };
  });
  const srcs: Record<string, SourceDocument> = {};
  for (let i = 0; i < count; i++) {
    srcs[`s${i}`] = {
      id: `s${i}`,
      name: `s${i}.pdf`,
      pageCount: 1,
      pageSizes: [{ width: 1, height: 1 }]
    };
  }
  return {
    documents: docs,
    sources: srcs,
    activeDocId: `r${activeIndex}`,
    selection: [],
    cropBoxes: {},
    pageAnnotations: {},
    history: null,
    savedAt: 0
  };
}

describe('RT-6 — session restore respects the document ceiling', () => {
  it('restoreSession never restores more than MAX_OPEN_DOCUMENTS', () => {
    restoreSession(recordOf(30));
    expect(documents.value).toHaveLength(MAX_OPEN_DOCUMENTS);
  });

  it('checkRecovery trims, keeps the active document, and reports the excess', async () => {
    nav.storage = undefined; // in-memory fallback stands in for OPFS
    for (let i = 0; i < 30; i++) __memoryFallback.set(`s${i}`, new Uint8Array([1]));
    const checked = await checkRecovery(recordOf(30, 25));
    expect(checked).not.toBeNull();
    expect(checked!.record.documents).toHaveLength(MAX_OPEN_DOCUMENTS);
    expect(checked!.droppedDocuments).toBe(10);
    expect(checked!.droppedOverLimit).toBe(10);
    expect(checked!.record.documents.some(d => d.id === 'r25')).toBe(true);
    expect(checked!.record.activeDocId).toBe('r25');
    // Sources only the dropped documents used are not registered on restore.
    expect(Object.keys(checked!.record.sources)).toHaveLength(MAX_OPEN_DOCUMENTS);
    expect('s25' in checked!.record.sources).toBe(true);
  });

  it('a record within the ceiling drops nothing', async () => {
    nav.storage = undefined;
    for (let i = 0; i < 3; i++) __memoryFallback.set(`s${i}`, new Uint8Array([1]));
    const checked = await checkRecovery(recordOf(3));
    expect(checked!.droppedDocuments).toBe(0);
    expect(checked!.droppedOverLimit).toBe(0);
  });
});

describe('RT-3 — clearStaplerFiles reports what it could not delete', () => {
  it('counts a locked original as a failure, not as removed', async () => {
    const files = new Map<string, number>([
      ['orig.pdf', 10],
      ['other.pdf', 10],
      ['not-ours.sqlite', 10]
    ]);
    const root = {
      async getFileHandle() {
        return { kind: 'file', createWritable: async () => ({ close: async () => {} }) };
      },
      async removeEntry(name: string) {
        if (name === 'orig.pdf') throw new DOMException('locked', 'NoModificationAllowedError');
        files.delete(name);
      },
      async *entries() {
        for (const [name] of [...files]) {
          yield [name, { kind: 'file', getFile: async () => ({ size: 10 }) }] as const;
        }
      }
    };
    nav.storage = { getDirectory: async () => root };
    const result = await clearStaplerFiles();
    expect(result).toEqual({ removed: 1, failed: 1 });
    expect([...files.keys()].sort()).toEqual(['not-ours.sqlite', 'orig.pdf']);
  });

  it('isPartialClear flags a failed file even when every database cleared', () => {
    const ok = {
      files: 3,
      filesFailed: 0,
      ocrCacheEntries: 0,
      ocrCacheCleared: true,
      localStorageKeys: 0,
      databaseCleared: true,
      metaCleared: true,
      shareInboxCleared: true
    };
    expect(isPartialClear(ok)).toBe(false);
    expect(isPartialClear({ ...ok, filesFailed: 1 })).toBe(true);
    expect(isPartialClear({ ...ok, metaCleared: false })).toBe(true);
    expect(isPartialClear({ ...ok, shareInboxCleared: false })).toBe(true);
  });
});

/** A fake `indexedDB` whose requests are driven by `behave`. */
function fakeIndexedDB(behave: (request: Record<string, unknown>) => void) {
  const make = () => {
    const request: Record<string, unknown> = {};
    queueMicrotask(() => behave(request));
    return request;
  };
  return { open: vi.fn(make), deleteDatabase: vi.fn(make) };
}

describe('RT-5 — tesseract cache open is bounded', () => {
  it('rejects after the timeout when the open is blocked and never answers', async () => {
    g.indexedDB = fakeIndexedDB(request => (request.onblocked as () => void)());
    await expect(__openDbForTests(20)).rejects.toThrow(/Timed out/);
  });

  it('closes a connection that arrives after the timeout', async () => {
    const close = vi.fn();
    g.indexedDB = fakeIndexedDB(request => {
      setTimeout(() => {
        request.result = { close };
        (request.onsuccess as () => void)();
      }, 40);
    });
    await expect(__openDbForTests(10)).rejects.toThrow(/Timed out/);
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('RT-8 — stapler-meta is deleted, boundedly', () => {
  it('resolves true when the delete succeeds', async () => {
    const idb = fakeIndexedDB(request => (request.onsuccess as () => void)());
    g.indexedDB = idb;
    expect(await deleteMetaDatabase(50)).toBe(true);
    expect(idb.deleteDatabase).toHaveBeenCalledWith('stapler-meta');
  });

  it('resolves false, not never, when the delete stays blocked', async () => {
    g.indexedDB = fakeIndexedDB(request => (request.onblocked as () => void)());
    expect(await deleteMetaDatabase(20)).toBe(false);
  });
});

describe('PLT-5 — the share inbox is deleted', () => {
  it('deletes the share-inbox cache by its exported name', async () => {
    const del = vi.fn(async () => true);
    g.caches = { delete: del };
    expect(await deleteShareInbox()).toBe(true);
    expect(del).toHaveBeenCalledWith(SHARE_INBOX_CACHE);
  });

  it('treats a missing Cache Storage as nothing to delete', async () => {
    g.caches = undefined;
    expect(await deleteShareInbox()).toBe(true);
  });

  it('reports a rejected delete', async () => {
    g.caches = { delete: async () => Promise.reject(new Error('nope')) };
    expect(await deleteShareInbox()).toBe(false);
  });
});

function repairRun(): RepairRun {
  return {
    name: 'broken-repaired.pdf',
    result: { bytes: new Uint8Array([1, 2, 3]) } as unknown as RepairRun['result']
  };
}

describe('RT-2 — opening the repaired copy', () => {
  it('refuses at the ceiling before registering anything', async () => {
    source('s');
    for (let i = 0; i < MAX_OPEN_DOCUMENTS; i++) open(`d${i}`);
    const register = vi.fn();
    expect(await openRepairedCopy(repairRun(), register)).toBe('full');
    expect(register).not.toHaveBeenCalled();
    expect(documents.value).toHaveLength(MAX_OPEN_DOCUMENTS);
  });

  it('releases the source when the last slot is taken while it registers', async () => {
    source('s');
    for (let i = 0; i < MAX_OPEN_DOCUMENTS - 1; i++) open(`d${i}`);
    const register = vi.fn(async () => {
      open('late'); // another open lands meanwhile
      return source('repaired', 1);
    });
    expect(await openRepairedCopy(repairRun(), register)).toBe('full');
    expect('repaired' in sources.value).toBe(false);
    expect(documents.value.some(d => d.name === 'broken-repaired.pdf')).toBe(false);
  });

  it('a double-click opens one copy', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    const register = vi.fn(async () => {
      await gate;
      return source('repaired', 1);
    });
    const first = openRepairedCopy(repairRun(), register);
    expect(openingRepaired.value).toBe(true);
    expect(await openRepairedCopy(repairRun(), register)).toBe('busy');
    release();
    expect(await first).toBe('opened');
    expect(openingRepaired.value).toBe(false);
    expect(register).toHaveBeenCalledTimes(1);
    expect(documents.value.filter(d => d.name === 'broken-repaired.pdf')).toHaveLength(1);
  });
});

describe('UI-9 — the chosen repair file can be cleared', () => {
  it('clearRepairCandidate forgets the file and its report', () => {
    repairCandidate.value = new File([new Uint8Array([1])], 'stale.pdf');
    lastRepair.value = repairRun();
    clearRepairCandidate();
    expect(repairCandidate.value).toBeNull();
    expect(lastRepair.value).toBeNull();
  });
});
