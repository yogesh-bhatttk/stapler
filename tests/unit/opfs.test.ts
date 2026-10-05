/**
 * §1.9 (AUDIT-EDGE-CASES-2026-09-15, EPIC-19 in docs/TICKETS.md) — `writeSourceBytes` used to let a
 * `QuotaExceededError` from OPFS's `write()` escape uncaught, surfacing as a
 * generic "Something went wrong" instead of the specific, actionable message
 * `core/db.ts`'s IndexedDB guard already gives for the identical failure.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

function quotaError(): DOMException {
  return new DOMException('Quota exceeded', 'QuotaExceededError');
}

function fakeOpfsRoot(opts: { failWrite?: boolean } = {}) {
  const written: Record<string, Uint8Array> = {};
  let aborted = false;
  return {
    written,
    get aborted() {
      return aborted;
    },
    getFileHandle: async (name: string) => ({
      createWritable: async () => ({
        write: async (bytes: Uint8Array) => {
          if (opts.failWrite) throw quotaError();
          written[name] = bytes;
        },
        close: async () => {},
        abort: async () => {
          aborted = true;
        }
      })
    })
  };
}

describe('writeSourceBytes / OPFS quota handling', () => {
  const originalStorage = (navigator as unknown as { storage?: unknown }).storage;

  beforeEach(async () => {
    (navigator as unknown as { storage?: unknown }).storage = undefined;
    // RT-20 — the storage mode is memoised; each test installs its own root.
    (await import('../../src/core/opfs')).__resetOpfsProbeForTests();
  });

  afterEach(() => {
    (navigator as unknown as { storage?: unknown }).storage = originalStorage;
  });

  it('turns a QuotaExceededError into a clear, actionable message', async () => {
    const root = fakeOpfsRoot({ failWrite: true });
    (navigator as unknown as { storage: { getDirectory: () => Promise<unknown> } }).storage = {
      getDirectory: async () => root
    };

    const { writeSourceBytes } = await import('../../src/core/opfs');

    await expect(writeSourceBytes('doc-1', new Uint8Array([1, 2, 3]))).rejects.toThrow(
      /local storage is full/i
    );
    // The writable stream is aborted rather than left dangling on failure.
    expect(root.aborted).toBe(true);
  });

  it('writes normally when there is room', async () => {
    const root = fakeOpfsRoot();
    (navigator as unknown as { storage: { getDirectory: () => Promise<unknown> } }).storage = {
      getDirectory: async () => root
    };

    const { writeSourceBytes } = await import('../../src/core/opfs');

    await writeSourceBytes('doc-2', new Uint8Array([9, 8, 7]));
    expect(root.written['doc-2.pdf']).toEqual(new Uint8Array([9, 8, 7]));
  });
});
