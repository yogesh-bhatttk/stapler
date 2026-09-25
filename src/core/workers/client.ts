import { currentLocale, translate, type Locale } from '../i18n';
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
import { notify } from '../notify';
import { internal } from '../errors';

export interface WorkerClient<T> {
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
  /**
   * Runs `fn` against the pinned instance. Rejects with an internal "worker
   * crashed" error — immediately, without calling `fn` — once that instance
   * has died, because a pin cannot move to a different instance: whatever it
   * was holding open (a pdf.js handle, say) died with the old one.
   */
  lease<R>(fn: (api: Comlink.Remote<T>) => Promise<R>): Promise<R>;
  /**
   * True once the pinned instance has crashed or failed to boot. A cache that
   * holds pinned clients (`render-cache.ts`) checks this to drop entries that
   * can never answer again instead of handing them out forever.
   */
  readonly dead: boolean;
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
  /**
   * AUDIT UI-8: the worker API implements {@link LocaleAware}, and every
   * instance is told the app locale when it spawns and whenever it changes, so
   * text the worker generates (converter notes, error details, progress
   * labels) comes out in the user's language. A lease never reaches a freshly
   * spawned instance before its dictionary has loaded.
   */
  syncLocale?: boolean;
}

/** What a worker API exposes to take part in {@link WorkerClientOptions.syncLocale}. */
export interface LocaleAware {
  /** Loads `locale`'s dictionary in the worker realm and makes it current. */
  setLocale(locale: Locale): Promise<boolean>;
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
  /** Set by the `error` handler; never cleared — a dead instance stays dead. */
  dead: boolean;
  /**
   * Rejects when the instance dies. Every call runs raced against this.
   *
   * RT-1: Comlink's pending-call promises have no reject path at all — they
   * are `new Promise(resolve)` waiting for a reply message — so terminating
   * the worker left every in-flight `lease()` pending forever. `useJob`'s
   * `finally` then never ran, `activeJob` stayed set, and the whole UI
   * (undo, tab switch, every later job) stayed locked until a reload.
   */
  death: Promise<never>;
  kill: (err: Error) => void;
  /**
   * With `syncLocale`, settles once the worker has applied the most recently
   * sent locale (never rejects: a dictionary that fails to load leaves the
   * worker on its previous locale, which beats refusing the job). Every call
   * waits on it, so the first call after a spawn already speaks the user's
   * language. Null without `syncLocale`.
   */
  ready: Promise<void> | null;
}

/** The error every call on a dead instance rejects with. */
function workerCrashed(name: string): Error {
  return internal('The background worker crashed before it could finish.', {
    worker: name,
    reason: 'worker crashed'
  });
}

/**
 * Runs `fn` on `inst`, but settles as soon as the instance dies rather than
 * waiting on a reply that a terminated worker can never send.
 */
function raceDeath<T, R>(
  inst: Instance<T>,
  name: string,
  fn: (api: Comlink.Remote<T>) => Promise<R>
): Promise<R> {
  if (inst.dead) return Promise.reject(workerCrashed(name));
  const call = inst.ready ? inst.ready.then(() => fn(inst.proxy)) : fn(inst.proxy);
  return Promise.race([call, inst.death]);
}

/**
 * Queues `locale` for `inst`: sent after any earlier locale message has been
 * applied, so a quick de → fr → de sequence cannot finish out of order.
 */
function sendLocale<T>(inst: Instance<T>, locale: Locale): void {
  const proxy = inst.proxy as unknown as Comlink.Remote<LocaleAware>;
  const previous = inst.ready ?? Promise.resolve();
  inst.ready = previous
    .then(() => Promise.race([proxy.setLocale(locale), inst.death]))
    .then(
      () => undefined,
      () => undefined
    );
}

export function createWorkerClient<T>(
  spawn: () => Worker,
  { idleMs = 30_000, name = 'worker', maxSize, syncLocale = false }: WorkerClientOptions = {}
): WorkerClient<T> {
  const poolMax = Math.max(1, maxSize ?? defaultPoolSize());
  const pool: Instance<T>[] = [];

  if (syncLocale) {
    // `subscribe` fires once immediately (the pool is still empty then) and
    // again on every change; each live instance gets the new locale queued.
    currentLocale.subscribe(locale => {
      for (const inst of pool) if (!inst.dead) sendLocale(inst, locale);
    });
  }

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
    // Anything still in flight (only possible via `terminate()`) rejects
    // instead of hanging on a reply that will never come.
    inst.dead = true;
    inst.kill(workerCrashed(name));
    inst.proxy[Comlink.releaseProxy]();
    inst.worker.terminate();
  };

  const scheduleIdle = (inst: Instance<T>) => {
    if (inst.leases > 0 || idleMs <= 0 || !pool.includes(inst)) return;
    clearIdle(inst);
    inst.idleTimer = setTimeout(() => terminateInstance(inst), idleMs);
  };

  const spawnInstance = (): Instance<T> => {
    const worker = spawn();
    let kill: (err: Error) => void = () => {};
    const death = new Promise<never>((_, reject) => {
      kill = reject;
    });
    // Nobody may be racing against it when it rejects (an idle instance that
    // crashes), which must not surface as an unhandled rejection.
    death.catch(() => {});
    const inst: Instance<T> = {
      worker,
      // Placeholder until Comlink.wrap runs; assigned immediately below, but the
      // error handler needs `inst` to exist first to be able to drop it.
      proxy: null as unknown as Comlink.Remote<T>,
      leases: 0,
      idleTimer: null,
      dead: false,
      death,
      kill,
      ready: null
    };
    worker.addEventListener('error', event => {
      if (inst.dead) return;
      inst.dead = true;
      // An instance that failed to boot must not be reused, or every later call
      // leased to it hangs on a dead port.
      //
      // This used to be a bare `console.error`: the worker died, the pool
      // quietly shrank, and the user saw a button that did nothing with no
      // explanation anywhere they could see. A dead worker is not a debug
      // detail — it is the reason their document will not process.
      drop(inst);
      // Reject every call still in flight on this instance (RT-1) before
      // tearing it down; each lease's own `finally` then runs normally.
      inst.kill(workerCrashed(name));
      try {
        inst.proxy?.[Comlink.releaseProxy]();
      } catch {
        // Releasing a proxy on a dead endpoint can throw; it is being discarded anyway.
      }
      worker.terminate();
      notify('danger', translate('A background worker stopped unexpectedly.'), {
        detail:
          'Retry the operation. If it fails again, reload the page — your open ' +
          'documents are held in this tab and nothing has been written to disk.',
        diagnostic: `[${name}] worker error: ${event.message ?? 'unknown'}`
      });
    });
    inst.proxy = Comlink.wrap<T>(worker);
    if (syncLocale) sendLocale(inst, currentLocale.value);
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

  const registry =
    typeof FinalizationRegistry !== 'undefined'
      ? new FinalizationRegistry<Instance<T>>(inst => {
          inst.leases -= 1;
          scheduleIdle(inst);
        })
      : null;

  return {
    async lease(fn) {
      const inst = acquire();
      inst.leases += 1;
      try {
        return await raceDeath(inst, name, fn);
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
      let released = false;
      const pinned: PinnedClient<T> = {
        async lease(fn) {
          if (released) {
            throw new Error('Cannot lease from a released pinned client');
          }
          if (inst.dead) throw workerCrashed(name);
          inst.leases += 1;
          try {
            return await raceDeath(inst, name, fn);
          } finally {
            inst.leases -= 1;
            scheduleIdle(inst);
          }
        },
        release() {
          // Guard against callers invoking release() more than once (e.g. in a
          // finally block that also catches an earlier error path that already
          // called release). A second call would decrement leases below zero,
          // making scheduleIdle() think the instance is idle and terminate it
          // while another lease is still active.
          if (released) return;
          released = true;
          inst.leases -= 1;
          scheduleIdle(inst);
          registry?.unregister(pinned);
        },
        get dead() {
          return inst.dead;
        }
      };
      registry?.register(pinned, inst, pinned);
      return pinned;
    }
  };
}
