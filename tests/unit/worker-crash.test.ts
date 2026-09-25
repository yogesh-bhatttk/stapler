/**
 * RT-1 / RT-19 — a crashed worker must not hang anything.
 *
 * Unlike `worker-client.test.ts`, Comlink is real here: each fake worker is one
 * end of a `MessageChannel` with a real `Comlink.expose`d API on the other, so
 * the test exercises the actual failure — Comlink 4's pending-call promises have
 * no reject path, so after `terminate()` they would wait for a reply forever.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Comlink from 'comlink';

interface FakeWorker {
  crash(): void;
}

interface Api {
  slow(): Promise<string>;
  fast(): string;
  loadDocument(bytes: Uint8Array): Promise<{ handle: string }>;
  closeDocument(handle: string): void;
}

const spawned: FakeWorker[] = [];
/** Per-test override for what the worker-side `loadDocument` does. */
let loadImpl: (spawnIndex: number) => Promise<{ handle: string }> = async i => ({
  handle: `h${i}`
});

function fakeWorker(): Worker {
  const { port1, port2 } = new MessageChannel();
  const index = spawned.length;
  const api: Api = {
    slow: () => new Promise(resolve => setTimeout(() => resolve('done'), 50)),
    fast: () => 'ok',
    loadDocument: () => loadImpl(index),
    closeDocument: () => {}
  };
  Comlink.expose(api, port2);
  const errors = new EventTarget();
  const worker = {
    postMessage: (message: unknown, transfer?: Transferable[]) => {
      try {
        port1.postMessage(message, transfer ?? []);
      } catch {
        // Closed port: a dead worker swallows messages.
      }
    },
    addEventListener: (type: string, fn: EventListener) =>
      type === 'error' ? errors.addEventListener(type, fn) : port1.addEventListener(type, fn),
    removeEventListener: (type: string, fn: EventListener) => port1.removeEventListener(type, fn),
    terminate: () => {
      port1.close();
      port2.close();
    },
    crash: () => {
      const event = new Event('error') as Event & { message: string };
      event.message = 'boom';
      errors.dispatchEvent(event);
    }
  };
  port1.start();
  spawned.push(worker);
  return worker as unknown as Worker;
}

const { createWorkerClient } = await import('../../src/core/workers/client');

vi.mock('../../src/core/workers', async () => {
  const { createWorkerClient: create } = await import('../../src/core/workers/client');
  return { renderWorker: create<Api>(() => fakeWorker(), { maxSize: 1, idleMs: 0 }) };
});

const { renderHandleFor, closeRenderHandle } = await import('../../src/core/render-cache');
const { __memoryFallback } = await import('../../src/core/opfs');
const { toasts } = await import('../../src/core/notify');

/** Observes a promise's state without awaiting it. */
function track<T>(promise: Promise<T>) {
  const state = {
    status: 'pending' as 'pending' | 'resolved' | 'rejected',
    error: undefined as unknown
  };
  promise.then(
    () => (state.status = 'resolved'),
    err => {
      state.status = 'rejected';
      state.error = err;
    }
  );
  return state;
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

afterEach(() => {
  spawned.length = 0;
  toasts.value = [];
  loadImpl = async i => ({ handle: `h${i}` });
  __memoryFallback.clear();
});

describe('RT-1 — worker crash', () => {
  it('rejects an in-flight lease when the worker errors, instead of hanging', async () => {
    const client = createWorkerClient<Api>(() => fakeWorker(), { maxSize: 1 });
    const state = track(client.lease(api => api.slow()));
    await wait(5);
    spawned[0].crash();
    await wait(20);
    expect(state.status).toBe('rejected');
    expect(String(state.error)).toMatch(/worker crashed before it could finish/);
    // The user is told.
    expect(toasts.value.some(t => /background worker stopped/i.test(t.title))).toBe(true);
    // And the pool recovers: the next lease spawns a fresh instance and works.
    await expect(client.lease(api => api.slow())).resolves.toBe('done');
    expect(spawned).toHaveLength(2);
  });

  it('a pinned client whose instance died throws immediately and reports dead', async () => {
    const client = createWorkerClient<Api>(() => fakeWorker(), { maxSize: 1 });
    const pinned = client.pin();
    expect(await pinned.lease(async api => api.fast())).toBe('ok');
    expect(pinned.dead).toBe(false);
    spawned[0].crash();
    expect(pinned.dead).toBe(true);
    const state = track(pinned.lease(async api => api.fast()));
    await wait(20);
    expect(state.status).toBe('rejected');
    pinned.release();
  });
});

describe('RT-1 — render-cache drops handles pinned to a dead instance', () => {
  it('reopens on a fresh instance instead of handing out the dead handle', async () => {
    __memoryFallback.set('src', new Uint8Array([1]));
    const first = await renderHandleFor('src');
    expect(first.handle).toBe('h0');
    spawned[0].crash();

    const second = await renderHandleFor('src');
    expect(second.client).not.toBe(first.client);
    expect(second.handle).toBe('h1');
    // `render-cache` types its client as the real render API; the fake behind it
    // is this file's `Api`.
    expect(
      await second.client.lease(async api => (api as unknown as Comlink.Remote<Api>).fast())
    ).toBe('ok');
    closeRenderHandle('src');
  });
});

describe('RT-19 — a failed open deletes only its own entry', () => {
  it('a stale open that rejects after close+reopen leaves the new entry cached', async () => {
    __memoryFallback.set('race', new Uint8Array([1]));
    let rejectFirst!: (err: Error) => void;
    let call = 0;
    loadImpl = async i => {
      call += 1;
      if (call === 1) {
        return new Promise((_, reject) => {
          rejectFirst = reject;
        });
      }
      return { handle: `ok${i}` };
    };

    const stale = renderHandleFor('race');
    stale.catch(() => {});
    await wait(5);
    closeRenderHandle('race');
    const fresh = await renderHandleFor('race');
    expect(fresh.handle).toMatch(/^ok/);

    rejectFirst(new Error('open failed'));
    await expect(stale).rejects.toThrow('open failed');

    // Still cached: the same promise's value comes back, no third open.
    const again = await renderHandleFor('race');
    expect(again).toBe(fresh);
    expect(call).toBe(2);
    closeRenderHandle('race');
  });
});
