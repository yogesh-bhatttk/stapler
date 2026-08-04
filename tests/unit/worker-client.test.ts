import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F-05 — the worker pool.
 *
 * Comlink.wrap needs a real postMessage endpoint, which Node does not have, so
 * the module is mocked: `wrap` returns a stub carrying the `Worker` it was given,
 * which is enough to tell two pool instances apart without booting a real worker.
 */
vi.mock('comlink', () => {
  const releaseProxy = Symbol('releaseProxy');
  return {
    wrap: vi.fn((worker: unknown) => ({ __worker: worker, [releaseProxy]: vi.fn() })),
    releaseProxy,
    proxy: vi.fn(x => x),
    transfer: vi.fn(x => x)
  };
});

import { createWorkerClient } from '../../src/core/workers/client';

function fakeWorker() {
  return {
    addEventListener: vi.fn(),
    terminate: vi.fn()
  } as unknown as Worker;
}

/** A promise plus its own resolver, so a test controls exactly when a lease finishes. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createWorkerClient pool', () => {
  it('spawns a new instance per concurrent lease, up to the pool cap', async () => {
    const spawn = vi.fn(fakeWorker);
    const client = createWorkerClient(spawn, { maxSize: 4 });

    const gates = [deferred(), deferred(), deferred()];
    const leases = gates.map((gate, i) =>
      client.lease(async () => {
        await gate.promise;
        return i;
      })
    );

    // The synchronous prefix of every lease() call — acquire a worker, mark it
    // busy — has already run by the time this line executes, since nothing
    // awaits between the three lease() calls above.
    expect(spawn).toHaveBeenCalledTimes(3);

    gates.forEach(g => g.resolve());
    expect(await Promise.all(leases)).toEqual([0, 1, 2]);
  });

  it('shares the least-busy instance once the pool is at capacity', async () => {
    const spawn = vi.fn(fakeWorker);
    const client = createWorkerClient(spawn, { maxSize: 2 });

    const gates = [deferred(), deferred(), deferred()];
    const leases = gates.map(gate => client.lease(() => gate.promise));

    // Two instances for three concurrent leases: the third shares rather than
    // growing past the cap.
    expect(spawn).toHaveBeenCalledTimes(2);

    gates.forEach(g => g.resolve());
    await Promise.all(leases);
  });

  it('reuses an idle instance instead of spawning another', async () => {
    const spawn = vi.fn(fakeWorker);
    const client = createWorkerClient(spawn, { maxSize: 4 });

    await client.lease(async () => {});
    await client.lease(async () => {});

    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('terminates an idle instance after idleMs, and not before', async () => {
    const spawn = vi.fn(fakeWorker);
    const client = createWorkerClient(spawn, { maxSize: 4, idleMs: 1000 });

    await client.lease(async () => {});
    const worker = spawn.mock.results[0].value as { terminate: () => void };

    await vi.advanceTimersByTimeAsync(999);
    expect(worker.terminate).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('cancels the idle timer if a new lease arrives first', async () => {
    const spawn = vi.fn(fakeWorker);
    const client = createWorkerClient(spawn, { maxSize: 4, idleMs: 1000 });

    await client.lease(async () => {});
    const worker = spawn.mock.results[0].value as { terminate: () => void };

    await vi.advanceTimersByTimeAsync(500);
    await client.lease(async () => {});
    await vi.advanceTimersByTimeAsync(500);

    // 1000ms has now elapsed in total, but the second lease reset the clock at
    // the 500ms mark, so the instance should still be alive.
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('never grows the pool past maxSize even across sequential batches', async () => {
    const spawn = vi.fn(fakeWorker);
    const client = createWorkerClient(spawn, { maxSize: 2, idleMs: 0 });

    // idleMs: 0 means instances never idle-terminate, so repeated sequential
    // (non-concurrent) leases must keep reusing the same one or two instances.
    for (let i = 0; i < 5; i++) {
      await client.lease(async () => {});
    }

    expect(spawn.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('terminate() tears down every instance immediately', async () => {
    const spawn = vi.fn(fakeWorker);
    const client = createWorkerClient(spawn, { maxSize: 4 });

    const gates = [deferred(), deferred()];
    const leases = gates.map(gate => client.lease(() => gate.promise));
    expect(spawn).toHaveBeenCalledTimes(2);

    client.terminate();

    const workers = spawn.mock.results.map(r => r.value as { terminate: () => void });
    for (const worker of workers) {
      expect(worker.terminate).toHaveBeenCalledTimes(1);
    }

    gates.forEach(g => g.resolve());
    await Promise.all(leases);
  });

  it('drops an instance that errors, so a later lease spawns a fresh one', async () => {
    const workers: {
      addEventListener: ReturnType<typeof vi.fn>;
      terminate: ReturnType<typeof vi.fn>;
    }[] = [];
    const spawn = vi.fn(() => {
      const w = { addEventListener: vi.fn(), terminate: vi.fn() };
      workers.push(w);
      return w as unknown as Worker;
    });
    const client = createWorkerClient(spawn, { maxSize: 4 });

    const gate = deferred();
    const lease = client.lease(() => gate.promise);
    expect(spawn).toHaveBeenCalledTimes(1);

    // Simulate the worker failing to boot.
    const errorHandler = workers[0].addEventListener.mock.calls[0][1] as (e: {
      message: string;
    }) => void;
    errorHandler({ message: 'boom' });
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);

    gate.resolve();
    await lease;

    await client.lease(async () => {});
    expect(spawn).toHaveBeenCalledTimes(2);
  });
});
