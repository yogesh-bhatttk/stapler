import { describe, expect, it, vi } from 'vitest';
import { createSharedJob } from '../../src/core/shared-job';
import { isCancellation } from '../../src/core/errors';
import type { JobOptions } from '../../src/core/workers/protocol';

/**
 * NFR-03 — the Compress tool asked for the same whole-document work two to
 * four times at once (preview analysis + "Analyse", and the preview's two
 * halves each composing the page). `createSharedJob` runs it once for every
 * caller in flight, while keeping each caller's cancellation its own.
 */

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createSharedJob (NFR-03)', () => {
  it('runs the work once for concurrent callers with the same key and token', async () => {
    const shared = createSharedJob<Uint8Array>();
    const gate = deferred<Uint8Array>();
    const start = vi.fn(() => gate.promise);
    const token = {};
    const a = shared.run('doc|150|0.75', token, {}, start);
    const b = shared.run('doc|150|0.75', token, {}, start);
    await Promise.resolve();
    const bytes = new Uint8Array([1, 2, 3]);
    gate.resolve(bytes);
    expect(await a).toBe(bytes);
    expect(await b).toBe(bytes);
    expect(start).toHaveBeenCalledTimes(1);
    expect(shared.size).toBe(0);
  });

  it('starts a fresh run for a different token (an edited document) or once the last finished', async () => {
    const shared = createSharedJob<number>();
    const start = vi.fn(async () => start.mock.calls.length);
    expect(await shared.run('k', 'rev1', {}, start)).toBe(1);
    expect(await shared.run('k', 'rev1', {}, start)).toBe(2);
    const gate = deferred<number>();
    const slow = vi.fn(() => gate.promise);
    const first = shared.run('k', 'rev1', {}, slow);
    const edited = shared.run('k', 'rev2', {}, async () => 99);
    expect(await edited).toBe(99);
    gate.resolve(7);
    expect(await first).toBe(7);
    expect(slow).toHaveBeenCalledTimes(1);
  });

  it('one caller aborting rejects only that caller; the other still gets the result', async () => {
    const shared = createSharedJob<string>();
    const gate = deferred<string>();
    let workSignal: AbortSignal | undefined;
    const start = (job: JobOptions) => {
      workSignal = job.signal;
      return gate.promise;
    };
    const leaving = new AbortController();
    const a = shared.run('k', 1, { signal: leaving.signal }, start);
    const b = shared.run('k', 1, {}, start);
    await Promise.resolve();
    leaving.abort();
    await expect(a).rejects.toSatisfy(isCancellation);
    // Someone is still waiting, so the shared work was not cancelled.
    expect(workSignal?.aborted).toBe(false);
    gate.resolve('report');
    expect(await b).toBe('report');
  });

  it('the last caller aborting cancels the shared work', async () => {
    const shared = createSharedJob<string>();
    const gate = deferred<string>();
    let workSignal: AbortSignal | undefined;
    const start = (job: JobOptions) => {
      workSignal = job.signal;
      return gate.promise;
    };
    const one = new AbortController();
    const two = new AbortController();
    const a = shared.run('k', 1, { signal: one.signal }, start);
    const b = shared.run('k', 1, { signal: two.signal }, start);
    await Promise.resolve();
    one.abort();
    expect(workSignal?.aborted).toBe(false);
    two.abort();
    expect(workSignal?.aborted).toBe(true);
    await expect(a).rejects.toSatisfy(isCancellation);
    await expect(b).rejects.toSatisfy(isCancellation);
    // A caller arriving after the abort does not join the cancelled run.
    const fresh = shared.run('k', 1, {}, async () => 'again');
    expect(await fresh).toBe('again');
    gate.reject(new Error('aborted'));
  });

  it('rejects an already-aborted caller without starting anything', async () => {
    const shared = createSharedJob<string>();
    const start = vi.fn(async () => 'x');
    const controller = new AbortController();
    controller.abort();
    await expect(shared.run('k', 1, { signal: controller.signal }, start)).rejects.toSatisfy(
      isCancellation
    );
    expect(start).not.toHaveBeenCalled();
  });

  it('fans progress and notices out to every caller still attached', async () => {
    const shared = createSharedJob<number>();
    const gate = deferred<number>();
    let job!: JobOptions;
    const start = (j: JobOptions) => {
      job = j;
      return gate.promise;
    };
    const progressA = vi.fn();
    const progressB = vi.fn();
    const noticeB = vi.fn();
    const leaving = new AbortController();
    const a = shared.run('k', 1, { onProgress: progressA, signal: leaving.signal }, start);
    const b = shared.run('k', 1, { onProgress: progressB, onNotice: noticeB }, start);
    await Promise.resolve();
    job.onProgress?.(0.5, 'half');
    leaving.abort();
    job.onProgress?.(0.9, 'nearly');
    job.onNotice?.('note');
    expect(progressA.mock.calls).toEqual([[0.5, 'half']]);
    expect(progressB.mock.calls).toEqual([
      [0.5, 'half'],
      [0.9, 'nearly']
    ]);
    expect(noticeB).toHaveBeenCalledWith('note');
    gate.resolve(1);
    await expect(a).rejects.toSatisfy(isCancellation);
    expect(await b).toBe(1);
  });

  it('a failure reaches every caller and is not cached', async () => {
    const shared = createSharedJob<number>();
    const gate = deferred<number>();
    const start = vi.fn(() => gate.promise);
    const a = shared.run('k', 1, {}, start);
    const b = shared.run('k', 1, {}, start);
    gate.reject(new Error('corrupt'));
    await expect(a).rejects.toThrow('corrupt');
    await expect(b).rejects.toThrow('corrupt');
    expect(await shared.run('k', 1, {}, async () => 3)).toBe(3);
  });
});
