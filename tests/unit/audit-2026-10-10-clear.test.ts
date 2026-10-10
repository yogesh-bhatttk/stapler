/**
 * AUDIT-2026-10-10 — Clear-all and the batch recipe export.
 *
 *  • M4 — a partial Clear-all's warning used to be raised as a toast and then
 *    wiped by the reload that follows. It is now carried across the reload in
 *    sessionStorage and shown once by the next page.
 *  • L8 — Clear-all also removes Stapler's sessionStorage keys (the
 *    "persistence asked" flag), and the recipe export no longer revokes its
 *    object URL in the same tick as the click.
 *
 * `db.ts` and tesseract's cache are in-memory fakes, OPFS a fake root —
 * the pattern `local-data.test.ts` uses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/db', () => ({
  DB_OPEN_TIMEOUT_MS: 4000,
  STAPLER_STORES: ['handles', 'signatures', 'presets', 'settings', 'searchIndex', 'recipes'],
  readSetting: vi.fn(async () => undefined),
  readSettingResult: vi.fn(async () => ({ ok: true, value: undefined })),
  writeSetting: vi.fn(async () => true),
  readStaplerDbStats: vi.fn(async () => ({
    signatures: { count: 0, bytes: 0 },
    recents: 0,
    presets: 0,
    recipes: 0,
    indexedFiles: 0,
    settings: 0
  })),
  clearStaplerStores: vi.fn(async () => true),
  clearSearchIndexStore: vi.fn(async () => true),
  listSignatures: vi.fn(async () => []),
  putSignature: vi.fn(async () => true),
  getStoredSignature: vi.fn(async () => null),
  deleteStoredSignature: vi.fn(async () => {})
}));

vi.mock('../../src/core/ocr/tesseractCache', () => ({
  listCachedModels: vi.fn(async () => []),
  clearCachedModels: vi.fn(async () => 0),
  hasCachedModel: vi.fn(async () => false),
  deleteCachedModel: vi.fn(async () => {}),
  writeCachedModel: vi.fn(async () => {})
}));

const { clearAllLocalData } = await import('../../src/core/local-data');
const opfs = await import('../../src/core/opfs');
const { toasts, activeJob, confirmRequest } = await import('../../src/core/notify');
const { confirmAndClearAllLocalData } = await import('../../src/ui/clearLocalData');
const { showPendingClearNotice, CLEAR_NOTICE_KEY } = await import('../../src/ui/clearNotice');
const { __resetStoragePersistenceForTests } = await import('../../src/core/storage-persistence');
const recovery = await import('../../src/core/session-recovery');

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear()
  };
}

const nav = navigator as unknown as { storage?: unknown; locks?: unknown };
const g = globalThis as unknown as { localStorage?: unknown; sessionStorage?: unknown };
const original = {
  storage: nav.storage,
  locks: nav.locks,
  local: g.localStorage,
  session: g.sessionStorage
};

function soleTabLocks() {
  nav.locks = {
    request: (_n: string, _o: unknown, cb: () => unknown) => {
      void cb();
      return Promise.resolve();
    },
    query: async () => ({ held: [{ name: 'stapler.workspace' }], pending: [] })
  };
}

/** An OPFS root holding `files`; `locked` names refuse deletion. */
function fakeRoot(files: string[], locked: string[] = []) {
  const entries = new Set(files);
  return {
    entries,
    root: {
      async *entries() {
        for (const name of [...entries]) {
          yield [
            name,
            { kind: 'file', getFile: async () => ({ size: 3 }) } as unknown as FileSystemHandle
          ] as const;
        }
      },
      async removeEntry(name: string) {
        if (locked.includes(name)) throw new DOMException('locked', 'NoModificationAllowedError');
        entries.delete(name);
      },
      async getFileHandle() {
        return { createWritable: async () => ({ close: async () => {} }) };
      }
    }
  };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 5));

async function answerConfirm(ok: boolean) {
  for (let i = 0; i < 50 && !confirmRequest.value; i++) await settle();
  expect(confirmRequest.value).not.toBeNull();
  confirmRequest.value!.resolve(ok);
}

function reset() {
  toasts.value = [];
  activeJob.value = null;
  confirmRequest.value = null;
  __resetStoragePersistenceForTests();
  opfs.__resetOpfsProbeForTests();
  opfs.__resetTabLockForTests();
  recovery.__resetAutosaveSuspendedForTests();
  nav.storage = original.storage;
  nav.locks = original.locks;
  g.localStorage = original.local;
  g.sessionStorage = original.session;
}

beforeEach(reset);
afterEach(reset);

describe('M4 — the partial-clear warning survives the reload', () => {
  it('a locked file: the notice is stored, then shown once by the next page', async () => {
    soleTabLocks();
    const fake = fakeRoot(['locked.pdf', 'free.pdf'], ['locked.pdf']);
    nav.storage = { getDirectory: async () => fake.root };
    g.localStorage = fakeStorage({ 'stapler.locale': 'de' });
    const session = fakeStorage({ 'stapler.persistence.asked': 'granted' });
    g.sessionStorage = session;

    const reload = vi.fn();
    const pending = confirmAndClearAllLocalData(reload);
    await answerConfirm(true);
    expect(await pending).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect([...fake.entries]).toEqual(['locked.pdf']);

    // What the reload keeps: sessionStorage. Everything in memory is gone.
    expect(JSON.parse(session.map.get(CLEAR_NOTICE_KEY)!)).toEqual({ filesFailed: 1 });
    toasts.value = [];

    expect(showPendingClearNotice()).toBe(true);
    const warning = toasts.value.find(t => t.tone === 'warning');
    expect(warning?.title).toBe('Some local data could not be cleared.');
    expect(warning?.detail).toContain('could not be deleted: 1.');
    expect(warning?.timeout).toBe(0);

    // One-shot: a second reload shows nothing.
    expect(session.map.has(CLEAR_NOTICE_KEY)).toBe(false);
    toasts.value = [];
    expect(showPendingClearNotice()).toBe(false);
    expect(toasts.value).toEqual([]);
  });

  it('a complete clear leaves no notice behind', async () => {
    soleTabLocks();
    const fake = fakeRoot(['a.pdf']);
    nav.storage = { getDirectory: async () => fake.root };
    g.localStorage = fakeStorage();
    const session = fakeStorage();
    g.sessionStorage = session;
    const pending = confirmAndClearAllLocalData(vi.fn());
    await answerConfirm(true);
    expect(await pending).toBe(true);
    expect(session.map.has(CLEAR_NOTICE_KEY)).toBe(false);
    expect(showPendingClearNotice()).toBe(false);
  });

  it('a malformed stored notice still warns, generically', () => {
    g.sessionStorage = fakeStorage({ [CLEAR_NOTICE_KEY]: '{not json' });
    expect(showPendingClearNotice()).toBe(true);
    expect(toasts.value.at(-1)?.detail).toContain('Browser storage did not respond.');
  });
});

describe('L8 — Clear-all removes Stapler’s sessionStorage keys too', () => {
  it('removes stapler.* session keys and leaves other pages’ keys alone', async () => {
    const fake = fakeRoot([]);
    nav.storage = { getDirectory: async () => fake.root };
    g.localStorage = fakeStorage({ 'stapler.locale': 'fr', custom_shortcuts: '{}', other: '1' });
    const session = fakeStorage({
      'stapler.persistence.asked': 'denied',
      'someone-else': 'keep'
    });
    g.sessionStorage = session;
    await clearAllLocalData();
    expect([...session.map.keys()]).toEqual(['someone-else']);
  });
});

describe('L8 — the recipe export revokes its URL later, not in the click’s tick', () => {
  it('keeps the object URL alive after click()', async () => {
    vi.useFakeTimers();
    try {
      const revoke = vi.fn();
      const create = vi.fn(() => 'blob:recipes');
      const clicks: string[] = [];
      const anchor = {
        href: '',
        download: '',
        rel: '',
        click: () => clicks.push(anchor.href),
        remove: vi.fn()
      };
      const g2 = globalThis as unknown as { document?: unknown };
      const originalDocument = g2.document;
      const originalCreate = URL.createObjectURL;
      const originalRevoke = URL.revokeObjectURL;
      g2.document = { createElement: () => anchor, body: { append: vi.fn() } };
      URL.createObjectURL = create;
      URL.revokeObjectURL = revoke;
      try {
        const { downloadRecipesJson, RECIPE_EXPORT_REVOKE_MS } =
          await import('../../src/ui/tools/batch/recipe-export');
        downloadRecipesJson([{ id: 'r1', name: 'Mine' }]);
        expect(clicks).toEqual(['blob:recipes']);
        expect(anchor.download).toBe('stapler-recipes.json');
        expect(revoke).not.toHaveBeenCalled();
        vi.advanceTimersByTime(RECIPE_EXPORT_REVOKE_MS - 1);
        expect(revoke).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(revoke).toHaveBeenCalledWith('blob:recipes');
      } finally {
        g2.document = originalDocument;
        URL.createObjectURL = originalCreate;
        URL.revokeObjectURL = originalRevoke;
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
