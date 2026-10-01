import { describe, expect, it } from 'vitest';
import {
  SHARE_INBOX_CACHE,
  SHARE_INBOX_MAX_AGE_MS,
  storeSharedFiles,
  sweepStaleSharedFiles,
  takeSharedFiles,
  type CacheLike,
  type CacheStorageLike
} from '../../src/platform/pwa/share-inbox';
import { sweepShareInboxOnStart } from '../../src/ui/pwa';

/**
 * Audit 2026-10-01 PLT-5 — shared files a failed hand-off left in the
 * `stapler-share-inbox` cache expire on their own.
 */

const SCOPE = 'https://stapler.app/';
const T0 = 1_800_000_000_000;
const MINUTE = 60_000;

function fakeCacheStorage() {
  const stores = new Map<string, Map<string, Response>>();
  const open = async (name: string): Promise<CacheLike> => {
    let store = stores.get(name);
    if (!store) stores.set(name, (store = new Map()));
    const entries = store;
    return {
      put: async (request, response) => void entries.set(request.url, response),
      match: async request => entries.get(request.url)?.clone(),
      keys: async () => [...entries.keys()].map(url => new Request(url)),
      delete: async request => entries.delete(request.url)
    };
  };
  const storage: CacheStorageLike = {
    open,
    has: async name => stores.has(name),
    delete: async name => stores.delete(name)
  };
  const urls = () => [...(stores.get(SHARE_INBOX_CACHE)?.keys() ?? [])];
  return { storage, stores, urls };
}

const pdf = (name: string) => new File(['%PDF-1.7'], name, { type: 'application/pdf' });

describe('share inbox expiry (PLT-5)', () => {
  it('uses a 10-minute limit', () => {
    expect(SHARE_INBOX_MAX_AGE_MS).toBe(10 * MINUTE);
  });

  it('records when each entry was stored', async () => {
    const { storage } = fakeCacheStorage();
    await storeSharedFiles(storage, SCOPE, [pdf('a.pdf')], 7, T0);
    const cache = await storage.open(SHARE_INBOX_CACHE);
    const [key] = await cache.keys();
    expect((await cache.match(key))?.headers.get('x-stapler-stored')).toBe(String(T0));
  });

  it('deletes batches older than the limit and keeps fresh ones', async () => {
    const { storage, urls } = fakeCacheStorage();
    await storeSharedFiles(storage, SCOPE, [pdf('old-1.pdf'), pdf('old-2.pdf')], 1, T0);
    await storeSharedFiles(storage, SCOPE, [pdf('new.pdf')], 2, T0 + 5 * MINUTE);

    expect(await sweepStaleSharedFiles(storage, T0 + 12 * MINUTE)).toBe(2);
    expect(urls()).toEqual([`${SCOPE}__share-inbox/2-0000`]);
    expect((await takeSharedFiles(storage)).map(f => f.name)).toEqual(['new.pdf']);
  });

  it('keeps a batch exactly at the limit, and deletes the bucket once empty', async () => {
    const { storage, stores } = fakeCacheStorage();
    await storeSharedFiles(storage, SCOPE, [pdf('a.pdf')], 1, T0);
    expect(await sweepStaleSharedFiles(storage, T0 + SHARE_INBOX_MAX_AGE_MS)).toBe(0);
    expect(stores.has(SHARE_INBOX_CACHE)).toBe(true);
    expect(await sweepStaleSharedFiles(storage, T0 + SHARE_INBOX_MAX_AGE_MS + 1)).toBe(1);
    expect(stores.has(SHARE_INBOX_CACHE)).toBe(false);
  });

  it('deletes entries stored far in the future (a clock moved back)', async () => {
    const { storage, stores } = fakeCacheStorage();
    await storeSharedFiles(storage, SCOPE, [pdf('a.pdf')], 1, T0 + 60 * MINUTE);
    expect(await sweepStaleSharedFiles(storage, T0)).toBe(1);
    expect(stores.has(SHARE_INBOX_CACHE)).toBe(false);
  });

  it('deletes malformed entries: unknown keys, bad stored times', async () => {
    const { storage, urls } = fakeCacheStorage();
    await storeSharedFiles(storage, SCOPE, [pdf('ok.pdf')], 3, T0);
    const cache = await storage.open(SHARE_INBOX_CACHE);
    await cache.put(new Request(`${SCOPE}something-else`), new Response('x'));
    await cache.put(
      new Request(`${SCOPE}__share-inbox/4-0000`),
      new Response('x', { headers: { 'x-stapler-stored': 'not-a-number' } })
    );
    expect(await sweepStaleSharedFiles(storage, T0 + MINUTE)).toBe(2);
    expect(urls()).toEqual([`${SCOPE}__share-inbox/3-0000`]);
  });

  it('dates an entry written before the stored header existed by its batch key', async () => {
    const { storage, urls } = fakeCacheStorage();
    const cache = await storage.open(SHARE_INBOX_CACHE);
    await cache.put(new Request(`${SCOPE}__share-inbox/${T0}-0000`), new Response('old'));
    await cache.put(
      new Request(`${SCOPE}__share-inbox/${T0 + 20 * MINUTE}-0000`),
      new Response('recent')
    );
    expect(await sweepStaleSharedFiles(storage, T0 + 21 * MINUTE)).toBe(1);
    expect(urls()).toEqual([`${SCOPE}__share-inbox/${T0 + 20 * MINUTE}-0000`]);
  });

  it('is a no-op when there is no inbox', async () => {
    const { storage, stores } = fakeCacheStorage();
    expect(await sweepStaleSharedFiles(storage, T0)).toBe(0);
    expect(stores.size).toBe(0);
  });

  it('sweeps stale batches before storing a new share, so they are not opened with it', async () => {
    const { storage } = fakeCacheStorage();
    await storeSharedFiles(storage, SCOPE, [pdf('abandoned.pdf')], 1, T0);
    await storeSharedFiles(storage, SCOPE, [pdf('wanted.pdf')], 2, T0 + 30 * MINUTE);
    expect((await takeSharedFiles(storage)).map(f => f.name)).toEqual(['wanted.pdf']);
  });
});

describe('sweepShareInboxOnStart (PLT-5)', () => {
  it('sweeps on a normal start', async () => {
    const { storage, stores } = fakeCacheStorage();
    await storeSharedFiles(storage, SCOPE, [pdf('a.pdf')], 1, T0);
    expect(await sweepShareInboxOnStart(SCOPE, storage, T0 + 11 * MINUTE)).toBe(true);
    expect(stores.has(SHARE_INBOX_CACHE)).toBe(false);
  });

  it('never sweeps on a share-target launch, however old the batch looks', async () => {
    const { storage, urls } = fakeCacheStorage();
    await storeSharedFiles(storage, SCOPE, [pdf('a.pdf')], 1, T0);
    const href = `${SCOPE}?share-target=1`;
    expect(await sweepShareInboxOnStart(href, storage, T0 + 60 * MINUTE)).toBe(false);
    expect(urls()).toHaveLength(1);
    expect((await takeSharedFiles(storage)).map(f => f.name)).toEqual(['a.pdf']);
  });

  it('does nothing without Cache Storage', async () => {
    expect(await sweepShareInboxOnStart(SCOPE, undefined, T0)).toBe(false);
  });

  it('swallows a failing Cache Storage', async () => {
    const failing: CacheStorageLike = {
      open: () => Promise.reject(new Error('blocked')),
      has: () => Promise.reject(new Error('blocked')),
      delete: () => Promise.reject(new Error('blocked'))
    };
    await expect(sweepShareInboxOnStart(SCOPE, failing, T0)).resolves.toBe(true);
  });
});
