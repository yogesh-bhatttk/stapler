/**
 * One typed Comlink client factory, replacing five near-identical modules
 * (`process.ts`, `render.ts`, `redact.ts`, `verify.ts`, `cv.ts`) that differed
 * only in the worker URL.
 *
 * Adds what F-05 asks for and none of them had: reference counting with
 * terminate-on-idle, so Chrome's task manager shows workers going away instead of
 * five of them living for the lifetime of the tab.
 */
import * as Comlink from 'comlink';

export interface WorkerClient<T> {
  /** The RPC proxy. Spawns the worker on first use. */
  api(): Comlink.Remote<T>;
  /**
   * Marks the worker busy for the duration of `fn`. When the last lease is
   * released the worker is retired after `idleMs`.
   */
  lease<R>(fn: (api: Comlink.Remote<T>) => Promise<R>): Promise<R>;
  /** Immediate teardown. Any in-flight call rejects. */
  terminate(): void;
}

export interface WorkerClientOptions {
  /** ms to keep an idle worker warm. pdf.js takes ~100ms to boot, so not zero. */
  idleMs?: number;
  /** Name shown in DevTools. */
  name?: string;
}

export function createWorkerClient<T>(
  spawn: () => Worker,
  { idleMs = 30_000, name = 'worker' }: WorkerClientOptions = {}
): WorkerClient<T> {
  let worker: Worker | null = null;
  let proxy: Comlink.Remote<T> | null = null;
  let leases = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const clearIdle = () => {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  const terminate = () => {
    clearIdle();
    if (proxy) proxy[Comlink.releaseProxy]();
    worker?.terminate();
    worker = null;
    proxy = null;
    leases = 0;
  };

  const api = () => {
    clearIdle();
    if (!worker || !proxy) {
      worker = spawn();
      worker.addEventListener('error', event => {
        // A worker that failed to boot must not be reused, or every later call
        // hangs on a dead port.
        console.error(`[${name}] worker error`, event.message);
        terminate();
      });
      proxy = Comlink.wrap<T>(worker);
    }
    return proxy;
  };

  const scheduleIdle = () => {
    if (leases > 0 || idleMs <= 0) return;
    clearIdle();
    idleTimer = setTimeout(terminate, idleMs);
  };

  return {
    api,
    async lease(fn) {
      const remote = api();
      leases += 1;
      try {
        return await fn(remote);
      } finally {
        leases -= 1;
        scheduleIdle();
      }
    },
    terminate
  };
}
