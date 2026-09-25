/**
 * RT-11 / RT-21 — `db.ts`'s connection handling.
 *
 * `idb`'s `openDB` is mocked so a test controls exactly when (or whether) the
 * connection opens, and can fire the `blocking` callback a newer tab's upgrade
 * would trigger. There is no IndexedDB in Node, so a stub `indexedDB` global
 * only has to exist for `open()`'s availability check. Each test loads a fresh
 * copy of `db.ts`, since the cached connection is module state.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface OpenCall {
  options: { blocking?: () => void; terminated?: () => void };
  resolve: (db: unknown) => void;
}
const openCalls: OpenCall[] = [];

vi.mock('idb', () => ({
  openDB: vi.fn(
    (_name: string, _version: number, options: OpenCall['options']) =>
      new Promise(resolve => openCalls.push({ options, resolve }))
  )
}));

const g = globalThis as unknown as { indexedDB?: unknown };
const hadIndexedDb = 'indexedDB' in g;
g.indexedDB = {};

function fakeDb(put: () => Promise<unknown> = async () => undefined) {
  return { close: vi.fn(), get: vi.fn(async () => 'value'), put: vi.fn(put) };
}

async function load() {
  vi.resetModules();
  const db = await import('../../src/core/db');
  const { toasts } = await import('../../src/core/notify');
  toasts.value = [];
  return { db, toasts };
}

beforeEach(() => {
  openCalls.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  if (!hadIndexedDb) delete g.indexedDB;
});

describe('RT-11 — a blocked open does not hang storage forever', () => {
  it('times out onto the degraded path, then uses the connection once it opens', async () => {
    const { db } = await load();
    vi.useFakeTimers();
    const first = db.readSetting('k');
    await vi.advanceTimersByTimeAsync(db.DB_OPEN_TIMEOUT_MS + 1);
    // Degraded: undefined rather than a promise that never settles.
    await expect(first).resolves.toBeUndefined();
    expect(openCalls).toHaveLength(1);

    // Whatever blocked it goes away: the same pending open resolves and is
    // reused, not restarted per call.
    openCalls[0].resolve(fakeDb());
    await expect(db.readSetting('k')).resolves.toBe('value');
    expect(openCalls).toHaveLength(1);
  });

  it('closes and forgets its connection when another tab needs to upgrade', async () => {
    const { db } = await load();
    const conn = fakeDb();
    const reading = db.readSetting('k');
    openCalls[0].resolve(conn);
    await expect(reading).resolves.toBe('value');

    openCalls[0].options.blocking?.();
    await vi.waitFor(() => expect(conn.close).toHaveBeenCalledTimes(1));

    // The next call opens a new connection instead of using the closed one.
    const next = db.readSetting('k');
    await vi.waitFor(() => expect(openCalls).toHaveLength(2));
    openCalls[1].resolve(fakeDb());
    await expect(next).resolves.toBe('value');
  });
});

describe('RT-21 — the quota toast is rate-limited', () => {
  it('shows one warning for a burst of quota failures', async () => {
    const { db, toasts } = await load();
    const conn = fakeDb(async () => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    const writing = db.writeSetting('session.recovery', {});
    openCalls[0].resolve(conn);
    await writing;
    for (let i = 0; i < 5; i++) await db.writeSetting('session.recovery', { i });
    expect(conn.put).toHaveBeenCalledTimes(6);
    const warnings = toasts.value.filter(t => /local storage is full/i.test(t.title));
    expect(warnings).toHaveLength(1);
  });
});
