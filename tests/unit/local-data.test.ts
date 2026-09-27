/**
 * GAP-9 (storage persistence) and GAP-12 (what is stored locally, and "Clear
 * all local data"), driven through the real modules:
 *
 *  • `requestPersistenceOnce` asks the browser at most once, remembers the
 *    answer across sessions, never asks when storage is already persistent,
 *    treats a non-boolean answer as "unsupported", and warns only on a denial.
 *  • the first successful session save is what triggers the request.
 *  • `checkStorageHeadroom` warns once when usage nears the quota.
 *  • `gatherLocalDataReport` breaks OPFS down into documents / OCR models and
 *    ignores files Stapler did not write.
 *  • `clearAllLocalData` removes Stapler's OPFS files, database stores, cached
 *    OCR models and localStorage keys — and nothing that is not Stapler's.
 *  • the confirmed UI flow refuses while busy or with another tab open, says
 *    open documents will be closed, stops autosave, and reloads; the next
 *    startup then finds nothing to restore.
 *
 * `db.ts` and tesseract's cache are in-memory fakes (no IndexedDB in Node);
 * OPFS is a fake directory root, the pattern `runtime-data-safety.test.ts` uses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const settings = new Map<string, unknown>();
const storeRecords: Record<string, number> = {};
const clearedStores: string[][] = [];

vi.mock('../../src/core/db', () => ({
  STAPLER_STORES: ['handles', 'signatures', 'presets', 'settings', 'searchIndex', 'recipes'],
  readSetting: vi.fn(async (key: string) => settings.get(key)),
  readSettingResult: vi.fn(async (key: string) => ({ ok: true, value: settings.get(key) })),
  writeSetting: vi.fn(async (key: string, value: unknown) => {
    settings.set(key, value);
    return true;
  }),
  readStaplerDbStats: vi.fn(async () => ({
    signatures: {
      count: storeRecords.signatures ?? 0,
      bytes: (storeRecords.signatures ?? 0) * 100
    },
    recents: storeRecords.handles ?? 0,
    presets: storeRecords.presets ?? 0,
    recipes: storeRecords.recipes ?? 0,
    indexedFiles: storeRecords.searchIndex ?? 0,
    settings: settings.size
  })),
  clearStaplerStores: vi.fn(async (stores: string[]) => {
    clearedStores.push([...stores]);
    for (const name of stores) {
      storeRecords[name] = 0;
      if (name === 'settings') settings.clear();
    }
    return true;
  }),
  clearSearchIndexStore: vi.fn(async () => true),
  listSignatures: vi.fn(async () => []),
  putSignature: vi.fn(async () => true),
  getStoredSignature: vi.fn(async () => null),
  deleteStoredSignature: vi.fn(async () => {})
}));

const cachedModels = new Map<string, number>();
vi.mock('../../src/core/ocr/tesseractCache', () => ({
  listCachedModels: vi.fn(async () => [...cachedModels].map(([lang, bytes]) => ({ lang, bytes }))),
  clearCachedModels: vi.fn(async () => {
    const n = cachedModels.size;
    cachedModels.clear();
    return n;
  }),
  hasCachedModel: vi.fn(async (lang: string) => cachedModels.has(lang)),
  deleteCachedModel: vi.fn(async (lang: string) => {
    cachedModels.delete(lang);
  }),
  writeCachedModel: vi.fn(async () => {})
}));

const persistence = await import('../../src/core/storage-persistence');
const {
  requestPersistenceOnce,
  requestPersistenceNow,
  checkStorageHeadroom,
  PERSISTENCE_SETTING_KEY,
  HEADROOM_CHECK_INTERVAL_MS,
  __resetStoragePersistenceForTests
} = persistence;
const { gatherLocalDataReport, clearAllLocalData, isReportEmpty } =
  await import('../../src/core/local-data');
const opfs = await import('../../src/core/opfs');
const { __resetOpfsProbeForTests, __resetTabLockForTests, __memoryFallback } = opfs;
const { toasts, activeJob, confirmRequest } = await import('../../src/core/notify');
const store = await import('../../src/core/store');
const { documents, sources, activeDocId, addDocument, registerSource, makePageRefs } = store;
const recovery = await import('../../src/core/session-recovery');
const { resetHistory } = await import('../../src/core/history');
const { confirmAndClearAllLocalData, describeClearAll } =
  await import('../../src/ui/clearLocalData');

const nav = navigator as unknown as { storage?: unknown; locks?: unknown };
const originalStorage = nav.storage;
const originalLocks = nav.locks;
const g = globalThis as unknown as { localStorage?: unknown };
const originalLocalStorage = g.localStorage;

/** A fake OPFS root that is also a `navigator.storage` (persist/estimate optional). */
function fakeRoot(files: Record<string, number>) {
  const entries = new Map(Object.entries(files));
  return {
    entries,
    root: {
      async *entries() {
        for (const [name, size] of [...entries]) {
          yield [
            name,
            { kind: 'file', getFile: async () => ({ size }) } as unknown as FileSystemHandle
          ] as const;
        }
      },
      async removeEntry(name: string) {
        entries.delete(name);
      },
      async getFileHandle() {
        return { createWritable: async () => ({ close: async () => {} }) };
      }
    }
  };
}

function fakeLocalStorage(initial: Record<string, string>) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k)
  };
}

function resetAll() {
  settings.clear();
  for (const key of Object.keys(storeRecords)) delete storeRecords[key];
  clearedStores.length = 0;
  cachedModels.clear();
  __memoryFallback.clear();
  toasts.value = [];
  activeJob.value = null;
  resetHistory();
  documents.value = [];
  sources.value = {};
  activeDocId.value = null;
  __resetStoragePersistenceForTests();
  __resetOpfsProbeForTests();
  __resetTabLockForTests();
  recovery.__resetAutosaveSuspendedForTests();
  recovery.sessionRecoveryChecked.value = false;
  nav.storage = originalStorage;
  nav.locks = originalLocks;
  g.localStorage = originalLocalStorage;
}

beforeEach(resetAll);
afterEach(resetAll);

const settle = () => new Promise(resolve => setTimeout(resolve, 5));

describe('GAP-9 — requestPersistenceOnce', () => {
  it('is a no-op without the Storage API', async () => {
    nav.storage = undefined;
    expect(await requestPersistenceOnce('session-save')).toBe('unsupported');
    expect(settings.has(PERSISTENCE_SETTING_KEY)).toBe(false);
  });

  it('does not ask when storage is already persistent (typical extension page)', async () => {
    const persist = vi.fn(async () => true);
    nav.storage = { persist, persisted: async () => true };
    expect(await requestPersistenceOnce('ocr-model')).toBe('granted');
    expect(persist).not.toHaveBeenCalled();
    expect(settings.get(PERSISTENCE_SETTING_KEY)).toMatchObject({ outcome: 'granted' });
  });

  it('asks once, remembers a denial across sessions, and warns only then', async () => {
    const persist = vi.fn(async () => false);
    nav.storage = { persist, persisted: async () => false };
    const [a, b] = await Promise.all([
      requestPersistenceOnce('session-save'),
      requestPersistenceOnce('ocr-model')
    ]);
    expect([a, b]).toEqual(['denied', 'denied']);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(toasts.value.filter(t => t.tone === 'warning')).toHaveLength(1);
    expect(settings.get(PERSISTENCE_SETTING_KEY)).toMatchObject({
      outcome: 'denied',
      trigger: 'session-save'
    });

    // Same session: no second request.
    expect(await requestPersistenceOnce('session-save')).toBe('denied');
    // "Next session": the remembered outcome is reused — no prompt, no toast.
    __resetStoragePersistenceForTests();
    toasts.value = [];
    expect(await requestPersistenceOnce('session-save')).toBe('denied');
    expect(persist).toHaveBeenCalledTimes(1);
    expect(toasts.value).toHaveLength(0);
  });

  it('treats a non-boolean answer as unsupported, not as a denial', async () => {
    nav.storage = { persist: async () => undefined, persisted: async () => undefined };
    expect(await requestPersistenceOnce('session-save')).toBe('unsupported');
    expect(toasts.value).toHaveLength(0);
  });

  it('the trust panel button asks again even after a remembered denial', async () => {
    settings.set(PERSISTENCE_SETTING_KEY, { outcome: 'denied', trigger: 'session-save', at: 1 });
    const persist = vi.fn(async () => true);
    nav.storage = { persist, persisted: async () => false };
    expect(await requestPersistenceNow()).toBe('granted');
    expect(persist).toHaveBeenCalledTimes(1);
    expect(settings.get(PERSISTENCE_SETTING_KEY)).toMatchObject({
      outcome: 'granted',
      trigger: 'manual'
    });
  });

  it('is triggered by the first successful session save, not by an empty one', async () => {
    const persist = vi.fn(async () => true);
    nav.storage = { persist, persisted: async () => false };
    await recovery.saveSession(); // nothing open: clears, does not ask
    await settle();
    expect(persist).not.toHaveBeenCalled();

    registerSource({ id: 's1', name: 'a.pdf', pageCount: 1, pageSizes: [{ width: 1, height: 1 }] });
    addDocument({
      id: 'd1',
      name: 'a.pdf',
      pages: makePageRefs('s1', 1),
      annotations: [],
      dirty: false
    });
    await recovery.saveSession();
    await settle();
    expect(persist).toHaveBeenCalledTimes(1);
    await recovery.saveSession();
    await settle();
    expect(persist).toHaveBeenCalledTimes(1);
  });
});

describe('GAP-9 — checkStorageHeadroom', () => {
  it('warns once when usage reaches 80% of the quota, rate-limited', async () => {
    let usage = 50;
    const estimate = vi.fn(async () => ({ usage, quota: 100 }));
    nav.storage = { estimate };
    expect(await checkStorageHeadroom(0)).toBe(false);
    usage = 85;
    // Within the interval: not even consulted.
    expect(await checkStorageHeadroom(1000)).toBe(false);
    expect(estimate).toHaveBeenCalledTimes(1);
    expect(await checkStorageHeadroom(HEADROOM_CHECK_INTERVAL_MS + 1)).toBe(true);
    expect(toasts.value.at(-1)?.detail).toContain('85 B of 100 B');
    expect(await checkStorageHeadroom(10 * HEADROOM_CHECK_INTERVAL_MS)).toBe(false);
    expect(toasts.value).toHaveLength(1);
  });

  it('stays quiet when the browser gives no usable estimate', async () => {
    nav.storage = { estimate: async () => ({ usage: 5 }) };
    expect(await checkStorageHeadroom(0)).toBe(false);
  });
});

describe('GAP-12 — local data report and clear-all', () => {
  function installStorage(files: Record<string, number>) {
    const fake = fakeRoot(files);
    nav.storage = {
      getDirectory: async () => fake.root,
      estimate: async () => ({ usage: 4096, quota: 1024 * 1024 }),
      persisted: async () => false
    };
    return fake;
  }

  it('breaks storage down by category and ignores files Stapler did not write', async () => {
    installStorage({
      'a1b2.pdf': 1000,
      'c3d4.pdf': 500,
      'hin.traineddata.gz': 3000,
      '.stapler-opfs-probe-x': 0,
      'another-app.sqlite': 99_999
    });
    cachedModels.set('eng', 2000);
    storeRecords.signatures = 2;
    storeRecords.handles = 3;
    storeRecords.searchIndex = 4;
    settings.set('theme', 'dark');
    g.localStorage = fakeLocalStorage({ 'stapler.locale': 'de', unrelated: 'x' });

    const report = await gatherLocalDataReport();
    expect(report.estimate).toEqual({ usage: 4096, quota: 1024 * 1024 });
    expect(report.persisted).toBe(false);
    expect(report.documents).toEqual({ files: 2, bytes: 1500 });
    expect(report.ocrModels).toEqual({ langs: ['eng', 'hin'], bytes: 5000 });
    expect(report.db).toMatchObject({
      signatures: { count: 2, bytes: 200 },
      recents: 3,
      indexedFiles: 4,
      settings: 1
    });
    expect(report.localStorageKeys).toBe(1);
    expect(isReportEmpty(report)).toBe(false);

    const lines = describeClearAll(report, 0);
    expect(lines.join('\n')).toContain('2 stored document files');
    expect(lines.join('\n')).toContain('eng, hin');
    expect(lines.join('\n')).toContain('2 saved signatures and initials');
    expect(lines.join('\n')).not.toContain('open documents will be closed');
  });

  it('clears every Stapler store, file, cached model and key — and nothing else', async () => {
    const fake = installStorage({
      'a1b2.pdf': 1000,
      'hin.traineddata.gz': 3000,
      'faceblur-weights.bin': 10,
      'another-app.sqlite': 99_999
    });
    cachedModels.set('eng', 2000);
    storeRecords.signatures = 2;
    settings.set('session.recovery', { documents: [{}] });
    const ls = fakeLocalStorage({
      'stapler.locale': 'de',
      'stapler:batch:outputPattern': '{index}',
      custom_shortcuts: '{}',
      unrelated: 'keep me'
    });
    g.localStorage = ls;

    const result = await clearAllLocalData();
    expect(result).toMatchObject({ files: 3, ocrCacheEntries: 1, localStorageKeys: 3 });
    expect(result.databaseCleared).toBe(true);
    expect([...fake.entries.keys()]).toEqual(['another-app.sqlite']);
    expect(clearedStores).toEqual([
      ['handles', 'signatures', 'presets', 'settings', 'searchIndex', 'recipes']
    ]);
    expect(settings.size).toBe(0);
    expect(cachedModels.size).toBe(0);
    expect([...ls.map.keys()]).toEqual(['unrelated']);

    const after = await gatherLocalDataReport();
    expect(isReportEmpty(after)).toBe(true);
  });

  it('clears the in-memory fallback when OPFS is unavailable', async () => {
    nav.storage = undefined;
    __memoryFallback.set('doc1', new Uint8Array(10));
    __memoryFallback.set('model_eng', new Uint8Array(20));
    const report = await gatherLocalDataReport();
    expect(report.documents).toEqual({ files: 1, bytes: 10 });
    expect(report.ocrModels.langs).toEqual(['eng']);
    await clearAllLocalData();
    expect(__memoryFallback.size).toBe(0);
  });
});

describe('GAP-12 — the confirmed clear-all flow', () => {
  function fakeLocks(holders: number) {
    nav.locks = {
      request: (_name: string, _opts: unknown, cb: () => unknown) => {
        void cb();
        return Promise.resolve();
      },
      query: async () => ({
        held: Array.from({ length: holders }, () => ({ name: 'stapler.workspace' })),
        pending: []
      })
    };
  }

  async function answerConfirm(ok: boolean) {
    for (let i = 0; i < 50 && !confirmRequest.value; i++) await settle();
    const request = confirmRequest.value;
    expect(request).not.toBeNull();
    const snapshot = { ...request! };
    request!.resolve(ok);
    return snapshot;
  }

  it('refuses while a job runs', async () => {
    activeJob.value = { label: 'Compress', progress: 0, cancel: () => {} };
    const reload = vi.fn();
    expect(await confirmAndClearAllLocalData(reload)).toBe(false);
    expect(confirmRequest.value).toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });

  it('refuses while another Stapler tab is open', async () => {
    fakeLocks(2);
    const reload = vi.fn();
    expect(await confirmAndClearAllLocalData(reload)).toBe(false);
    expect(confirmRequest.value).toBeNull();
    expect(toasts.value.at(-1)?.title).toContain('other tabs');
  });

  it('does nothing when cancelled', async () => {
    fakeLocks(1);
    settings.set('theme', 'dark');
    const reload = vi.fn();
    const pending = confirmAndClearAllLocalData(reload);
    await answerConfirm(false);
    expect(await pending).toBe(false);
    expect(settings.get('theme')).toBe('dark');
    expect(reload).not.toHaveBeenCalled();
  });

  it('says open documents close, clears, stops autosave, reloads — and nothing is restored', async () => {
    fakeLocks(1);
    const fake = fakeRoot({});
    nav.storage = { getDirectory: async () => fake.root };
    g.localStorage = fakeLocalStorage({});
    // The document's bytes, as OPFS would hold them.
    fake.entries.set('s1.pdf', 3);
    registerSource({ id: 's1', name: 'a.pdf', pageCount: 1, pageSizes: [{ width: 1, height: 1 }] });
    addDocument({
      id: 'd1',
      name: 'a.pdf',
      pages: makePageRefs('s1', 1),
      annotations: [],
      dirty: true
    });
    await recovery.saveSession();
    storeRecords.signatures = 1;
    expect(settings.get('session.recovery')).toBeTruthy();

    const reload = vi.fn();
    const pending = confirmAndClearAllLocalData(reload);
    const shown = await answerConfirm(true);
    expect(await pending).toBe(true);
    expect(shown.tone).toBe('danger');
    expect(shown.details?.[0]).toContain('open document will be closed');
    expect(shown.details?.join('\n')).toContain('1 saved signature');
    expect(reload).toHaveBeenCalledTimes(1);
    expect(documents.value.every(d => !d.dirty)).toBe(true);
    expect(fake.entries.size).toBe(0);
    expect(settings.has('session.recovery')).toBe(false);

    // Autosave is off until the reload: an edit cannot write the record back.
    recovery.scheduleSessionSave();
    await recovery.saveSession();
    expect(settings.has('session.recovery')).toBe(false);

    // "After the reload": a fresh workspace runs startup recovery.
    recovery.__resetAutosaveSuspendedForTests();
    documents.value = [];
    sources.value = {};
    const confirm = vi.fn(async () => true);
    await recovery.runStartupRecovery(confirm);
    expect(confirm).not.toHaveBeenCalled();
    expect(documents.value).toEqual([]);
    expect(recovery.sessionRecoveryChecked.value).toBe(true);
  });
});
