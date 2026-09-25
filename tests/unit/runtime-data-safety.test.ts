/**
 * Regression tests for the 2026-09-25 runtime audit's data-safety findings,
 * each driven through the real store/history/session-recovery/opfs/import
 * modules (the audit's own probes, turned into assertions):
 *
 *  • RT-2  — closing a tab must not delete bytes the undo/redo stacks reach,
 *            and recovery must validate every page reference, history included.
 *  • RT-3  — deleting a document's last page is refused, not a silent close.
 *  • RT-4  — the OPFS sweep removes orphaned sources and keeps model files.
 *  • RT-5  — a source registered mid-import survives an unrelated tab close.
 *  • RT-14 — imports wait for the recovery check and refuse during its prompt.
 *  • RT-17 — a successful save clears `dirty` without an undo entry.
 *
 * The workers are stubbed (pdf.js cannot run under node), and `db.ts` is an
 * in-memory map, the pattern `session-recovery.test.ts` already uses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const settings = new Map<string, unknown>();
vi.mock('../../src/core/db', () => ({
  readSetting: vi.fn(async (key: string) => settings.get(key)),
  writeSetting: vi.fn(async (key: string, value: unknown) => {
    settings.set(key, value);
  })
}));

/** Per-test hook: lets a test hold an import open between two files. */
let inspectGate: (() => Promise<void>) | null = null;

vi.mock('../../src/core/workers', () => {
  const renderApi = {
    loadDocument: async () => ({
      handle: 'h',
      pageCount: 1,
      isXfa: false,
      fingerprint: 'f',
      pageSizes: [{ width: 612, height: 792 }]
    }),
    closeDocument: async () => {}
  };
  const processApi = {
    inspect: async () => {
      if (inspectGate) await inspectGate();
      return { hasAcroForm: false, fieldCount: 0, permissionRestrictions: null };
    }
  };
  const leaseOn =
    <T>(target: T) =>
    (fn: (api: T) => Promise<unknown>) =>
      fn(target);
  return {
    renderWorker: {
      lease: leaseOn(renderApi),
      pin: () => ({ lease: leaseOn(renderApi), release: () => {}, dead: false })
    },
    processWorker: { lease: leaseOn(processApi) },
    cvWorker: { lease: leaseOn({}) }
  };
});

const store = await import('../../src/core/store');
const {
  addDocument,
  closeDocument,
  deletePages,
  documents,
  isSourcePending,
  makePageRefs,
  markSourcePending,
  refreshBaseline,
  registerSource,
  releasePendingSources,
  renameDocument,
  replaceWithSource,
  sources,
  activeDocId,
  selectedPageKeys
} = store;
const { undo, redo, canUndo, resetHistory, historySourceIds } =
  await import('../../src/core/history');
const {
  writeSourceBytes,
  sourceBytesExist,
  sweepOrphanedSourceBytes,
  __memoryFallback,
  __resetTabLockForTests,
  __resetOpfsProbeForTests
} = await import('../../src/core/opfs');
const recovery = await import('../../src/core/session-recovery');
const { checkRecovery, saveSession, loadPendingRecovery, sessionRecoveryChecked } = recovery;
const { sessionRecoveryPrompting, waitForImportReadiness } = recovery;
const { ensureImportsAllowed } = await import('../../src/core/open-document');
const { importFiles } = await import('../../src/core/import');
const { toasts } = await import('../../src/core/notify');
const { cropBoxes } = await import('../../src/ui/tools/crop/state');
const { pageAnnotations } = await import('../../src/ui/tools/annotate/state');

const size = { width: 1, height: 1 };

async function source(id: string, pageCount = 1) {
  await writeSourceBytes(id, new Uint8Array([1, 2, 3]));
  registerSource({ id, name: `${id}.pdf`, pageCount, pageSizes: Array(pageCount).fill(size) });
}

/** Lets `closeDocument`'s fire-and-forget `deleteSourceBytes` settle. */
const settle = () => new Promise(resolve => setTimeout(resolve, 5));

function reset() {
  settings.clear();
  resetHistory();
  documents.value = [];
  sources.value = {};
  activeDocId.value = null;
  selectedPageKeys.value = new Set();
  cropBoxes.value = {};
  pageAnnotations.value = {};
  __memoryFallback.clear();
  toasts.value = [];
  inspectGate = null;
  sessionRecoveryChecked.value = false;
  sessionRecoveryPrompting.value = false;
}

beforeEach(reset);
afterEach(reset);

describe('RT-2 — undo/redo keep their source bytes alive', () => {
  it('undo after closing an unrelated tab restores a document whose bytes still exist', async () => {
    await source('S1', 2);
    await source('SB');
    addDocument({
      id: 'A',
      name: 'a.pdf',
      pages: makePageRefs('S1', 2),
      annotations: [],
      dirty: false
    });
    addDocument({
      id: 'B',
      name: 'b.pdf',
      pages: makePageRefs('SB', 1),
      annotations: [],
      dirty: false
    });
    // Redaction-style rewrite: A (pages *and* baseline) now points at S2;
    // S1 is reachable only from the undo stack.
    replaceWithSource('A', { id: 'S2', name: 'a.pdf', pageCount: 2, pageSizes: [size, size] });
    await writeSourceBytes('S2', new Uint8Array([4]));
    expect(historySourceIds().has('S1')).toBe(true);

    closeDocument('B');
    await settle();
    undo();

    const a = documents.value.find(d => d.id === 'A')!;
    const ids = [...new Set(a.pages.map(p => p.sourceDocId))];
    expect(ids).toEqual(['S1']);
    expect('S1' in sources.value).toBe(true);
    expect(await sourceBytesExist('S1')).toBe(true);
    // The closed tab's own source was freed as before.
    expect('SB' in sources.value).toBe(false);
    expect(await sourceBytesExist('SB')).toBe(false);
  });

  it('redo after an undo and another close still finds the newer source', async () => {
    await source('S1');
    await source('SC');
    addDocument({
      id: 'A',
      name: 'a.pdf',
      pages: makePageRefs('S1', 1),
      annotations: [],
      dirty: false
    });
    addDocument({
      id: 'C',
      name: 'c.pdf',
      pages: makePageRefs('SC', 1),
      annotations: [],
      dirty: false
    });
    replaceWithSource('A', { id: 'S2', name: 'a.pdf', pageCount: 1, pageSizes: [size] });
    await writeSourceBytes('S2', new Uint8Array([4]));
    undo();
    closeDocument('C');
    await settle();
    expect(await sourceBytesExist('S2')).toBe(true);
    redo();
    const a = documents.value.find(d => d.id === 'A')!;
    expect(a.pages[0].sourceDocId).toBe('S2');
    expect('S2' in sources.value).toBe(true);
  });

  it("the closed document's own history does not keep its bytes alive", async () => {
    await source('SX');
    await source('SY');
    addDocument({
      id: 'X',
      name: 'x.pdf',
      pages: makePageRefs('SX', 1),
      annotations: [],
      dirty: false
    });
    addDocument({
      id: 'Y',
      name: 'y.pdf',
      pages: makePageRefs('SY', 1),
      annotations: [],
      dirty: false
    });
    renameDocument('X', 'renamed.pdf'); // puts X into an undo snapshot
    closeDocument('X');
    await settle();
    expect('SX' in sources.value).toBe(false);
    expect(await sourceBytesExist('SX')).toBe(false);
  });
});

describe('RT-2 — checkRecovery validates every page reference', () => {
  it('drops history that references a source the record no longer has bytes for', async () => {
    await source('LIVE');
    addDocument({
      id: 'A',
      name: 'a.pdf',
      pages: makePageRefs('LIVE', 1),
      annotations: [],
      dirty: false
    });
    await saveSession();
    const record = (await loadPendingRecovery())!;
    // A snapshot pointing at a source that is neither listed nor stored —
    // exactly what the old GC left behind. The old fast path only looked at
    // `record.sources`, found everything present, and restored it as-is.
    record.history.undoStack = [
      {
        docs: [{ ...record.documents[0], pages: makePageRefs('GONE', 1), baseline: [] }],
        activeId: 'A',
        selection: [],
        cropBoxes: {},
        pageAnnotations: {}
      }
    ];
    record.history.undoLog = [{ label: 'Edit', timestamp: 0 }];

    const checked = await checkRecovery(record);
    expect(checked).not.toBeNull();
    expect(checked!.droppedDocuments).toBe(0);
    expect(checked!.record.documents.map(d => d.id)).toEqual(['A']);
    expect(checked!.record.history.undoStack).toEqual([]);
  });

  it('drops a document whose pages point at a source missing from record.sources', async () => {
    await source('OK');
    await writeSourceBytes('UNLISTED', new Uint8Array([1]));
    addDocument({
      id: 'A',
      name: 'a.pdf',
      pages: makePageRefs('OK', 1),
      annotations: [],
      dirty: false
    });
    addDocument({
      id: 'B',
      name: 'b.pdf',
      pages: makePageRefs('UNLISTED', 1),
      annotations: [],
      dirty: false
    });
    await saveSession();
    const record = (await loadPendingRecovery())!;
    const checked = await checkRecovery(record);
    expect(checked!.droppedDocuments).toBe(1);
    expect(checked!.record.documents.map(d => d.id)).toEqual(['A']);
  });

  it('keeps the fast path when everything is present', async () => {
    await source('OK');
    addDocument({
      id: 'A',
      name: 'a.pdf',
      pages: makePageRefs('OK', 1),
      annotations: [],
      dirty: false
    });
    renameDocument('A', 'b.pdf');
    await saveSession();
    const record = (await loadPendingRecovery())!;
    const checked = await checkRecovery(record);
    expect(checked!.record).toBe(record);
    // The open (RT-6) and the rename.
    expect(checked!.record.history.undoStack).toHaveLength(2);
  });
});

describe('RT-3 — deleting every page', () => {
  it('is refused with a message, leaving the document, its undo and its bytes intact', async () => {
    await source('X');
    const pages = makePageRefs('X', 1);
    addDocument({ id: 'DX', name: 'x.pdf', pages, annotations: [], dirty: true });
    renameDocument('DX', 'y.pdf');
    deletePages('DX', [pages[0].key]);
    await settle();
    expect(documents.value.some(d => d.id === 'DX')).toBe(true);
    expect(documents.value[0].pages).toHaveLength(1);
    expect(canUndo()).toBe(true);
    expect(await sourceBytesExist('X')).toBe(true);
    expect(toasts.value.some(t => /at least one page/i.test(t.title))).toBe(true);
  });
});

describe('RT-5 — pending import sources', () => {
  it('a registered-but-not-yet-added source survives an unrelated close', async () => {
    await source('OLD');
    addDocument({
      id: 'D0',
      name: 'old.pdf',
      pages: makePageRefs('OLD', 1),
      annotations: [],
      dirty: false
    });
    markSourcePending('NEW');
    await source('NEW');
    closeDocument('D0');
    await settle();
    expect('NEW' in sources.value).toBe(true);
    expect(await sourceBytesExist('NEW')).toBe(true);

    // Once released (and still unreferenced) it is ordinary garbage again.
    releasePendingSources(['NEW']);
    await source('OTHER');
    addDocument({
      id: 'D1',
      name: 'o.pdf',
      pages: makePageRefs('OTHER', 1),
      annotations: [],
      dirty: false
    });
    closeDocument('D1');
    await settle();
    expect('NEW' in sources.value).toBe(false);
  });

  it('through importFiles: a file already imported survives a tab close mid-batch', async () => {
    sessionRecoveryChecked.value = true;
    await source('OLD');
    addDocument({
      id: 'D0',
      name: 'old.pdf',
      pages: makePageRefs('OLD', 1),
      annotations: [],
      dirty: false
    });

    let calls = 0;
    let releaseSecond!: () => void;
    const secondStarted = new Promise<void>(resolve => {
      inspectGate = async () => {
        calls += 1;
        if (calls === 2) {
          resolve();
          await new Promise<void>(r => (releaseSecond = r));
        }
      };
    });
    const pdf = (name: string) => new File([new TextEncoder().encode('%PDF-1.4\n%%EOF')], name);
    const importing = importFiles([pdf('one.pdf'), pdf('two.pdf')]);
    await secondStarted;

    const firstId = Object.keys(sources.value).find(id => id !== 'OLD')!;
    expect(firstId).toBeDefined();
    expect(isSourcePending(firstId)).toBe(true);
    closeDocument('D0'); // the user closes another tab mid-import
    await settle();
    expect(firstId in sources.value).toBe(true);
    expect(await sourceBytesExist(firstId)).toBe(true);

    releaseSecond();
    const outcome = await importing;
    expect(outcome.imported).toHaveLength(2);
    // The caller adds synchronously after the await; pending is still held…
    expect(outcome.imported.every(f => isSourcePending(f.source.id))).toBe(true);
    // …and released on the next macrotask.
    await settle();
    expect(outcome.imported.some(f => isSourcePending(f.source.id))).toBe(false);
  });
});

describe('RT-17 — refreshBaseline after a save', () => {
  it('clears dirty without pushing an undo entry', async () => {
    await source('S');
    addDocument({
      id: 'A',
      name: 'a.pdf',
      pages: makePageRefs('S', 1),
      annotations: [],
      dirty: false
    });
    renameDocument('A', 'b.pdf');
    expect(documents.value[0].dirty).toBe(true);
    const undoDepthBefore = canUndo();
    const doc = documents.value[0];
    refreshBaseline(doc.id, doc.pages);
    expect(documents.value[0].dirty).toBe(false);
    expect(documents.value[0].baseline).toBe(doc.pages);
    expect(canUndo()).toBe(undoDepthBefore);
    // Only the rename, then the open (RT-6), were undoable — the save itself
    // left no entry.
    undo();
    expect(documents.value[0].name).toBe('a.pdf');
    undo();
    expect(documents.value).toHaveLength(0);
    expect(canUndo()).toBe(false);
  });

  it('keeps dirty when the pages changed while the save was in flight', async () => {
    await source('S', 2);
    addDocument({
      id: 'A',
      name: 'a.pdf',
      pages: makePageRefs('S', 2),
      annotations: [],
      dirty: true
    });
    const saved = documents.value[0].pages;
    deletePages('A', [saved[0].key]);
    refreshBaseline('A', saved);
    expect(documents.value[0].dirty).toBe(true);
  });
});

describe('RT-4 — sweepOrphanedSourceBytes', () => {
  it('removes orphaned sources from the in-memory fallback and keeps model files', async () => {
    __memoryFallback.set('live', new Uint8Array([1]));
    __memoryFallback.set('orphan', new Uint8Array([1]));
    __memoryFallback.set('model_eng', new Uint8Array([1]));
    __memoryFallback.set('faceblur-weights.bin', new Uint8Array([1]));
    const removed = await sweepOrphanedSourceBytes(id => id === 'live');
    expect(removed).toBe(1);
    expect([...__memoryFallback.keys()].sort()).toEqual(
      ['faceblur-weights.bin', 'live', 'model_eng'].sort()
    );
  });

  describe('against an OPFS root', () => {
    const nav = navigator as unknown as { storage?: unknown };
    const original = nav.storage;
    // RT-20 — the storage mode is probed once and memoised; each test here
    // swaps the root, so each starts (and ends) with a fresh probe.
    beforeEach(() => __resetOpfsProbeForTests());
    afterEach(() => {
      nav.storage = original;
      __resetOpfsProbeForTests();
    });

    function fakeRoot(names: string[], opts: { failEntries?: boolean } = {}) {
      const files = new Set(names);
      const removed: string[] = [];
      return {
        files,
        removed,
        async *entries() {
          if (opts.failEntries) throw new DOMException('denied', 'SecurityError');
          for (const name of [...files]) yield [name, { kind: 'file' }] as const;
          yield ['subdir.pdf', { kind: 'directory' }] as const;
        },
        async removeEntry(name: string) {
          if (!files.has(name)) return;
          files.delete(name);
          removed.push(name);
        },
        // What the RT-20 startup probe needs: a handle with a working writable.
        async getFileHandle() {
          return { createWritable: async () => ({ close: async () => {} }) };
        }
      };
    }

    it('deletes only unreferenced *.pdf sources, asking isLive at removal time', async () => {
      const root = fakeRoot([
        'live.pdf',
        'orphan.pdf',
        'late.pdf',
        'eng.traineddata.gz',
        'faceblur-model.json',
        'faceblur-shard.pdf',
        'notes.txt'
      ]);
      nav.storage = { getDirectory: async () => root };
      const live = new Set(['live']);
      const removed = await sweepOrphanedSourceBytes(id => {
        // A source that becomes live after enumeration (an import landing)
        // must not be swept.
        if (id === 'orphan') live.add('late');
        return live.has(id);
      });
      expect(root.removed).toEqual(['orphan.pdf']);
      expect(removed).toBe(1);
      expect(root.files.has('eng.traineddata.gz')).toBe(true);
      expect(root.files.has('faceblur-model.json')).toBe(true);
      expect(root.files.has('faceblur-shard.pdf')).toBe(true);
    });

    it('never throws when OPFS enumeration fails or getDirectory rejects', async () => {
      nav.storage = { getDirectory: async () => fakeRoot(['a.pdf'], { failEntries: true }) };
      await expect(sweepOrphanedSourceBytes(() => false)).resolves.toBe(0);
      nav.storage = {
        getDirectory: async () => {
          throw new DOMException('denied', 'SecurityError');
        }
      };
      // Falls back to the (empty) memory map.
      __resetOpfsProbeForTests();
      await expect(sweepOrphanedSourceBytes(() => false)).resolves.toBe(0);
    });
  });
});

describe('RT-14 — imports wait for the recovery check', () => {
  it('waits while the check runs, then allows', async () => {
    let result: boolean | undefined;
    const pending = ensureImportsAllowed().then(r => (result = r));
    await settle();
    expect(result).toBeUndefined();
    sessionRecoveryChecked.value = true;
    await pending;
    expect(result).toBe(true);
  });

  it('refuses with a message while the restore prompt is showing', async () => {
    const pending = ensureImportsAllowed();
    sessionRecoveryPrompting.value = true;
    expect(await pending).toBe(false);
    expect(toasts.value.some(t => /restore prompt/i.test(t.title))).toBe(true);
  });

  it('resolves immediately once already checked', async () => {
    sessionRecoveryChecked.value = true;
    await expect(waitForImportReadiness()).resolves.toBe('ready');
  });
});

describe('RT-23 / RT-4 / RT-14 — runStartupRecovery', () => {
  const nav = navigator as unknown as { locks?: unknown };
  const originalLocks = nav.locks;

  /** A minimal Web Locks stand-in: exclusive-ifAvailable fails while any shared lock is held. */
  function fakeLocks(otherTabAlive: boolean) {
    let shared = otherTabAlive ? 1 : 0;
    return {
      request: async (
        _name: string,
        options: { mode?: string; ifAvailable?: boolean },
        callback: (lock: unknown) => unknown
      ) => {
        if (options.mode === 'shared') {
          shared += 1;
          void callback({});
          return undefined;
        }
        return callback(shared > 0 && options.ifAvailable ? null : {});
      }
    };
  }

  beforeEach(() => {
    __resetTabLockForTests();
  });
  afterEach(() => {
    nav.locks = originalLocks;
  });

  it('a malformed record still ends with the check done, and the record cleared', async () => {
    settings.set('session.recovery', { documents: [{ id: 'x', pages: [] }] }); // no sources/history
    const confirm = vi.fn(async () => true);
    await recovery.runStartupRecovery(confirm);
    expect(sessionRecoveryChecked.value).toBe(true);
    expect(settings.get('session.recovery')).toBeNull();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('flags the prompt while it is showing, and sweeps orphans after "Start fresh"', async () => {
    nav.locks = fakeLocks(false);
    await source('KEPT');
    addDocument({
      id: 'A',
      name: 'a.pdf',
      pages: makePageRefs('KEPT', 1),
      annotations: [],
      dirty: false
    });
    await saveSession();
    documents.value = [];
    sources.value = {};
    __memoryFallback.set('ORPHAN', new Uint8Array([1]));
    __memoryFallback.set('model_eng', new Uint8Array([1]));

    let promptingDuringConfirm = false;
    let importReadiness: Promise<'ready' | 'prompting'> | null = null;
    await recovery.runStartupRecovery(async () => {
      promptingDuringConfirm = sessionRecoveryPrompting.value;
      importReadiness = waitForImportReadiness();
      return false; // Start fresh
    });
    expect(promptingDuringConfirm).toBe(true);
    expect(await importReadiness).toBe('prompting');
    expect(sessionRecoveryPrompting.value).toBe(false);
    expect(sessionRecoveryChecked.value).toBe(true);
    // Declined: the record is gone and so are both sources' bytes; models stay.
    expect(settings.get('session.recovery')).toBeNull();
    expect(__memoryFallback.has('KEPT')).toBe(false);
    expect(__memoryFallback.has('ORPHAN')).toBe(false);
    expect(__memoryFallback.has('model_eng')).toBe(true);
  });

  it('keeps restored sources, and skips the sweep entirely while another tab is alive', async () => {
    await source('KEPT');
    addDocument({
      id: 'A',
      name: 'a.pdf',
      pages: makePageRefs('KEPT', 1),
      annotations: [],
      dirty: false
    });
    await saveSession();
    documents.value = [];
    sources.value = {};
    __memoryFallback.set('ORPHAN', new Uint8Array([1]));

    nav.locks = fakeLocks(true);
    await recovery.runStartupRecovery(async () => true);
    expect(documents.value.map(d => d.id)).toEqual(['A']);
    expect(__memoryFallback.has('ORPHAN')).toBe(true); // another tab may own it

    __resetTabLockForTests();
    nav.locks = fakeLocks(false);
    sessionRecoveryChecked.value = false;
    await recovery.runStartupRecovery(async () => true);
    expect(__memoryFallback.has('KEPT')).toBe(true);
    expect(__memoryFallback.has('ORPHAN')).toBe(false);
  });

  it('without the Web Locks API nothing is swept', async () => {
    nav.locks = undefined;
    __memoryFallback.set('ORPHAN', new Uint8Array([1]));
    await recovery.runStartupRecovery(async () => true);
    expect(sessionRecoveryChecked.value).toBe(true);
    expect(__memoryFallback.has('ORPHAN')).toBe(true);
  });
});
