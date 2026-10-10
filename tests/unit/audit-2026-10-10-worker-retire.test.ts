import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * NFR-03 — a pool instance that has moved a large payload is retired (its
 * realm terminated) as soon as its last lease ends, instead of idling with the
 * job's garbage for `idleMs`.
 *
 * On the ~100 MB NFR-03 run the idle render/process/zip realms held about
 * 1.2 GB of dead ArrayBuffers between them (measured with a forced GC over
 * CDP: 1,687 MB peak before, ~120 MB live after the GC), which is what pushed
 * the run past PLAN §5.1's 1.5 GB ceiling. V8 does not collect a worker that
 * has stopped allocating, so terminating the realm is the only deterministic
 * way to give that memory back.
 *
 * Comlink is mocked as in worker-client.test.ts: `wrap` returns a stub API
 * whose methods record what they were called with.
 */
vi.mock('comlink', () => {
  const releaseProxy = Symbol('releaseProxy');
  return {
    wrap: vi.fn((worker: unknown) => ({
      __worker: worker,
      [releaseProxy]: vi.fn(),
      // Echoes its argument's size.
      take: vi.fn(async (bytes: Uint8Array) => bytes.byteLength),
      // Returns a buffer of the requested size, like `compose` returning a PDF.
      make: vi.fn(async (size: number) => ({ bytes: new Uint8Array(size), pageCount: 1 })),
      // Hands back exactly the object it was given, to prove identity survives.
      same: vi.fn(async (value: unknown) => value)
    })),
    releaseProxy,
    proxy: vi.fn(x => x),
    transfer: vi.fn(x => x)
  };
});

import { createWorkerClient, payloadBytes } from '../../src/core/workers/client';

interface Api {
  take(bytes: Uint8Array): Promise<number>;
  make(size: number): Promise<{ bytes: Uint8Array; pageCount: number }>;
  same<T>(value: T): Promise<T>;
}

const THRESHOLD = 1024;

function pool(options: { idleMs?: number; maxSize?: number; retireAfterBytes?: number } = {}) {
  const workers: { terminate: ReturnType<typeof vi.fn> }[] = [];
  const spawn = vi.fn(() => {
    const worker = { addEventListener: vi.fn(), terminate: vi.fn() };
    workers.push(worker);
    return worker as unknown as Worker;
  });
  const client = createWorkerClient<Api>(spawn, {
    idleMs: 60_000,
    maxSize: 4,
    retireAfterBytes: THRESHOLD,
    ...options
  });
  return { client, spawn, workers };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('worker retirement after a large payload (NFR-03)', () => {
  it('terminates the instance the moment a large-argument lease ends, without waiting idleMs', async () => {
    const { client, spawn, workers } = pool();
    const size = await client.lease(api => api.take(new Uint8Array(THRESHOLD)));
    expect(size).toBe(THRESHOLD);
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);

    // The next job gets a fresh realm, not the one full of garbage.
    await client.lease(api => api.take(new Uint8Array(8)));
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('keeps a small-payload instance warm for idleMs, as before', async () => {
    const { client, spawn, workers } = pool();
    await client.lease(api => api.take(new Uint8Array(THRESHOLD - 1)));
    await client.lease(api => api.take(new Uint8Array(16)));
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(workers[0].terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_001);
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
  });

  it('counts a large *result* too', async () => {
    const { client, workers } = pool();
    const out = await client.lease(api => api.make(THRESHOLD * 2));
    // The caller still receives the result intact.
    expect(out.bytes.byteLength).toBe(THRESHOLD * 2);
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
  });

  it('counts buffers nested in arrays and plain objects (compose pages, split parts)', async () => {
    const { client, workers } = pool();
    const parts = {
      'a.pdf': new Uint8Array(THRESHOLD / 2),
      'b.pdf': new Uint8Array(THRESHOLD / 2)
    };
    await client.lease(api => api.same(parts));
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
  });

  it('passes arguments through by identity, so a Comlink.transfer list keyed on them still applies', async () => {
    const { client } = pool();
    const bytes = new Uint8Array(4);
    const echoed = await client.lease(api => api.same(bytes));
    expect(echoed).toBe(bytes);
  });

  it('never terminates an instance with a lease still open; retires it once the last one ends', async () => {
    const { client, workers } = pool({ maxSize: 1 });
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    const other = client.lease(async () => gate);
    // Shares the single instance with `other` and moves a large payload.
    await client.lease(api => api.take(new Uint8Array(THRESHOLD)));
    expect(workers[0].terminate).not.toHaveBeenCalled();
    release();
    await other;
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
  });

  it('keeps a pinned instance (an open render handle) alive until the pin is released', async () => {
    const { client, workers } = pool();
    const pinned = client.pin();
    await pinned.lease(api => api.take(new Uint8Array(THRESHOLD)));
    await pinned.lease(api => api.take(new Uint8Array(8)));
    expect(pinned.dead).toBe(false);
    expect(workers[0].terminate).not.toHaveBeenCalled();
    pinned.release();
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
  });

  it('is off unless a pool opts in', async () => {
    const { client, workers } = pool({ retireAfterBytes: 0 });
    await client.lease(api => api.take(new Uint8Array(THRESHOLD * 4)));
    expect(workers[0].terminate).not.toHaveBeenCalled();
  });
});

describe('payloadBytes', () => {
  it('sizes typed arrays, ArrayBuffers, and buffers nested in arrays/plain objects', () => {
    const view = new Uint8Array(10);
    expect(payloadBytes(view)).toBe(10);
    expect(payloadBytes(new ArrayBuffer(7))).toBe(7);
    expect(payloadBytes([view, { bytes: new Uint8Array(5) }])).toBe(15);
    // A view counts its own window, not the whole buffer behind it.
    expect(payloadBytes(new Uint8Array(new ArrayBuffer(100), 10, 20))).toBe(20);
  });

  it('ignores primitives, functions and class instances', () => {
    expect(payloadBytes(42)).toBe(0);
    expect(payloadBytes('x'.repeat(1000))).toBe(0);
    expect(payloadBytes(() => 0)).toBe(0);
    expect(payloadBytes(new Map([['a', new Uint8Array(10)]]))).toBe(0);
  });

  it('stops at its depth and entry budget instead of walking a huge structure', () => {
    const deep = { a: { b: { c: { d: new Uint8Array(10) } } } };
    expect(payloadBytes(deep)).toBe(0);
    const many = Array.from({ length: 10_000 }, () => new Uint8Array(1));
    expect(payloadBytes(many)).toBeLessThan(10_000);
  });
});
