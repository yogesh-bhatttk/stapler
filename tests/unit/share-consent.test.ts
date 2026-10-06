import { describe, expect, it, vi } from 'vitest';
import {
  SHARE_INBOX_CACHE,
  storeSharedFiles,
  takeSharedBatch,
  type CacheLike,
  type CacheStorageLike
} from '../../src/platform/pwa/share-inbox';
import { shouldOpenSharedBatch } from '../../src/ui/pwa';
import type { confirmAction } from '../../src/core/notify';

type ConfirmOptions = Parameters<typeof confirmAction>[0];
const confirmer = (answer: boolean) =>
  vi.fn(async (options: ConfirmOptions) => answer && !!options);

/**
 * Audit 2026-10-01 PLT-3 — a share the worker could not trace to this origin
 * (the OS share sheet, or a foreign page posting from a new no-referrer
 * window) is stored marked unverified, and the app asks before opening it.
 */

const SCOPE = 'https://stapler.app/';
const T0 = 1_800_000_000_000;

function fakeCacheStorage(): CacheStorageLike & { stores: Map<string, Map<string, Response>> } {
  const stores = new Map<string, Map<string, Response>>();
  return {
    stores,
    open: async (name: string): Promise<CacheLike> => {
      let store = stores.get(name);
      if (!store) stores.set(name, (store = new Map()));
      const entries = store;
      return {
        put: async (request, response) => void entries.set(request.url, response),
        match: async request => entries.get(request.url)?.clone(),
        keys: async () => [...entries.keys()].map(url => new Request(url)),
        delete: async request => entries.delete(request.url)
      };
    },
    has: async name => stores.has(name),
    delete: async name => stores.delete(name)
  };
}

const pdf = (name: string) => new File(['%PDF-1.7'], name, { type: 'application/pdf' });

describe('share inbox verification flag', () => {
  it('a verified share comes back verified, and empties the inbox', async () => {
    const storage = fakeCacheStorage();
    await storeSharedFiles(storage, SCOPE, [pdf('a.pdf'), pdf('b.pdf')], 1, T0, true);
    const batch = await takeSharedBatch(storage);
    expect(batch.verified).toBe(true);
    expect(batch.files.map(f => f.name)).toEqual(['a.pdf', 'b.pdf']);
    expect(await storage.has(SHARE_INBOX_CACHE)).toBe(false);
  });

  it('an unverified share — the default — comes back unverified', async () => {
    const storage = fakeCacheStorage();
    await storeSharedFiles(storage, SCOPE, [pdf('a.pdf')], 1, T0);
    expect((await takeSharedBatch(storage)).verified).toBe(false);
  });

  it('one unverified file makes the whole batch unverified', async () => {
    const storage = fakeCacheStorage();
    await storeSharedFiles(storage, SCOPE, [pdf('mine.pdf')], 1, T0, true);
    await storeSharedFiles(storage, SCOPE, [pdf('lure.pdf')], 2, T0, false);
    const batch = await takeSharedBatch(storage);
    expect(batch.verified).toBe(false);
    expect(batch.files.map(f => f.name)).toEqual(['mine.pdf', 'lure.pdf']);
  });

  it('a file stored without the flag (an older worker) counts as unverified', async () => {
    const storage = fakeCacheStorage();
    const cache = await storage.open(SHARE_INBOX_CACHE);
    await cache.put(
      new Request(`${SCOPE}__share-inbox/${T0}-0000`),
      new Response(pdf('legacy.pdf'), { headers: { 'x-stapler-name': 'legacy.pdf' } })
    );
    expect((await takeSharedBatch(storage)).verified).toBe(false);
  });

  it('the flag is never taken from the redirect URL — only from storage', async () => {
    // Nothing in the inbox: whatever `?share-target=` says, there is nothing to open.
    const batch = await takeSharedBatch(fakeCacheStorage());
    expect(batch.files).toEqual([]);
  });
});

describe('shouldOpenSharedBatch', () => {
  it('opens a verified batch without asking', async () => {
    const confirm = confirmer(true);
    expect(await shouldOpenSharedBatch({ files: [pdf('a.pdf')], verified: true }, confirm)).toBe(
      true
    );
    expect(confirm).not.toHaveBeenCalled();
  });

  it('asks about an unverified batch, naming the files, with Open and Discard', async () => {
    const confirm = confirmer(true);
    const files = [pdf('invoice.pdf'), pdf('notes.pdf')];
    expect(await shouldOpenSharedBatch({ files, verified: false }, confirm)).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
    const options = confirm.mock.calls[0]![0];
    expect(options.title).toBe('Open 2 shared files?');
    expect(options.details).toEqual(['invoice.pdf', 'notes.pdf']);
    expect(options.confirmLabel).toBe('Open');
    expect(options.cancelLabel).toBe('Discard');
  });

  it('opens nothing when the user discards (or presses Escape)', async () => {
    const confirm = confirmer(false);
    expect(
      await shouldOpenSharedBatch({ files: [pdf('lure.pdf')], verified: false }, confirm)
    ).toBe(false);
  });

  it('lists at most ten names, then how many more', async () => {
    const confirm = confirmer(false);
    const files = Array.from({ length: 13 }, (_, i) => pdf(`f${i}.pdf`));
    await shouldOpenSharedBatch({ files, verified: false }, confirm);
    const details = confirm.mock.calls[0]![0].details!;
    expect(details).toHaveLength(11);
    expect(details[10]).toBe('…and 3 more');
  });

  it('never asks about an empty batch', async () => {
    const confirm = confirmer(true);
    expect(await shouldOpenSharedBatch({ files: [], verified: false }, confirm)).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
  });
});
