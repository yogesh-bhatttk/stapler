/**
 * One typed Comlink client factory, replacing five near-identical modules
 * (`process.ts`, `render.ts`, `redact.ts`, `verify.ts`, `cv.ts`) that differed
 * only in the worker URL.
 *
 * Adds what F-05 asks for and none of them had: a real pool. A single shared
 * instance per role meant two concurrent `lease()` calls — the common case once
 * BAT-01 processes a folder — serialised behind whichever call got there first,
 * no matter how many cores the machine had. Instances are spawned lazily, up to
 * `min(4, hardwareConcurrency - 1)`, and each terminates on its own idle timer
 * so Chrome's task manager shows them going away individually rather than five
 * of them living for the lifetime of the tab.
 */
import * as Comlink from 'comlink';

export interface WorkerClient<T> {
  /** The RPC proxy of whichever instance the next call would use. Spawns on first use. */
  api(): Comlink.Remote<T>;
  /**
   * Runs `fn` against one pool instance, marked busy for its duration. A lease
   * prefers an idle instance, then spawns a new one below the pool cap, and only
   * once at the cap does it share the least-busy instance with another lease.
   */
  lease<R>(fn: (api: Comlink.Remote<T>) => Promise<R>): Promise<R>;
  /** Immediate teardown of every instance. Any in-flight call rejects. */
  terminate(): void;
  /**
   * Acquires an instance and holds it open until `release()` is called.
   * `lease()` on the returned client routes to that specific instance.
   */
  pin(): PinnedClient<T>;
}

export interface PinnedClient<T> {
  /** Runs `fn` against the pinned instance. */
  lease<R>(fn: (api: Comlink.Remote<T>) => Promise<R>): Promise<R>;
  /** Releases the pin, allowing the instance to idle out if no other leases remain. */
  release(): void;
}

export interface WorkerClientOptions {
  /** ms to keep an idle instance warm. pdf.js takes ~100ms to boot, so not zero. */
  idleMs?: number;
  /** Name shown in DevTools. */
  name?: string;
  /** Defaults to `min(4, hardwareConcurrency - 1)`, per F-05. */
  maxSize?: number;
}

function defaultPoolSize(): number {
  const cores =
    typeof navigator !== 'undefined' && navigator.hardwareConcurrency
      ? navigator.hardwareConcurrency
      : 4;
  return Math.max(1, Math.min(4, cores - 1));
}

interface Instance<T> {
  worker: Worker;
  proxy: Comlink.Remote<T>;
  leases: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

export function createWorkerClient<T>(
  spawn: () => Worker,
  { idleMs = 30_000, name = 'worker', maxSize }: WorkerClientOptions = {}
): WorkerClient<T> {
  const poolMax = Math.max(1, maxSize ?? defaultPoolSize());
  const pool: Instance<T>[] = [];

  const clearIdle = (inst: Instance<T>) => {
    if (inst.idleTimer !== null) {
      clearTimeout(inst.idleTimer);
      inst.idleTimer = null;
    }
  };

  const drop = (inst: Instance<T>) => {
    clearIdle(inst);
    const at = pool.indexOf(inst);
    if (at >= 0) pool.splice(at, 1);
  };

  const terminateInstance = (inst: Instance<T>) => {
    drop(inst);
    inst.proxy[Comlink.releaseProxy]();
    inst.worker.terminate();
  };

  const scheduleIdle = (inst: Instance<T>) => {
    if (inst.leases > 0 || idleMs <= 0) return;
    clearIdle(inst);
    inst.idleTimer = setTimeout(() => terminateInstance(inst), idleMs);
  };

  const spawnInstance = (): Instance<T> => {
    const worker = spawn();
    const inst: Instance<T> = {
      worker,
      // Placeholder until Comlink.wrap runs; assigned immediately below, but the
      // error handler needs `inst` to exist first to be able to drop it.
      proxy: null as unknown as Comlink.Remote<T>,
      leases: 0,
      idleTimer: null
    };
    worker.addEventListener('error', event => {
      // An instance that failed to boot must not be reused, or every later call
      // leased to it hangs on a dead port.
      console.error(`[${name}] worker error`, event.message);
      drop(inst);
      worker.terminate();
    });
    inst.proxy = Comlink.wrap<T>(worker);
    pool.push(inst);
    return inst;
  };

  /** Prefers an idle instance, then grows the pool, then shares the least-busy one. */
  const acquire = (): Instance<T> => {
    const idle = pool.find(inst => inst.leases === 0);
    if (idle) {
      clearIdle(idle);
      return idle;
    }
    if (pool.length < poolMax) return spawnInstance();
    return pool.reduce((least, inst) => (inst.leases < least.leases ? inst : least));
  };

  return {
    api() {
      return acquire().proxy;
    },
    async lease(fn) {
      const inst = acquire();
      inst.leases += 1;
      try {
        return await fn(inst.proxy);
      } finally {
        inst.leases -= 1;
        scheduleIdle(inst);
      }
    },
    terminate() {
      for (const inst of [...pool]) terminateInstance(inst);
    },
    pin() {
      const inst = acquire();
      inst.leases += 1;
      return {
        async lease(fn) {
          inst.leases += 1;
          try {
            return await fn(inst.proxy);
          } finally {
            inst.leases -= 1;
            scheduleIdle(inst);
          }
        },
        release() {
          inst.leases -= 1;
          scheduleIdle(inst);
        }
      };
    }
  };
}
