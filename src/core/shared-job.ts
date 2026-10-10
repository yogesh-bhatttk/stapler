/**
 * NFR-03 — one run of an expensive job, shared by every caller that asks for
 * the same thing while it is in flight.
 *
 * Opening the Compress tool used to start the same whole-document work two to
 * four times at once: the preview's own analysis, the panel's "Analyse"
 * button, and the preview's "before" and "after" halves each composing the
 * representative page. On a 100 MB document every one of those copied the
 * whole file into its own worker, and the copies were alive together — the
 * single largest contributor to the NFR-03 peak.
 *
 * Sharing has to keep each caller's cancellation its own: one caller aborting
 * (a slider moving, a panel unmounting) must not cancel the run another caller
 * is still waiting on, or that caller would see a cancellation it never asked
 * for and silently drop its result. So the shared run has its own
 * `AbortController`, aborted only once **every** caller has gone; a caller
 * that aborts is rejected with a cancellation at once and stops receiving
 * progress. Progress and notices fan out to every caller still attached.
 */
import { cancelled } from './errors';
import type { JobOptions } from './workers/protocol';

interface Entry<R> {
  /** Reused only by a caller passing the identical token (e.g. a page list). */
  token: unknown;
  controller: AbortController;
  callers: Set<JobOptions>;
  promise: Promise<R>;
}

export interface SharedJob<R> {
  /**
   * Joins the run in flight under `key` (when its `token` is identical), or
   * starts one with `start`. Resolves or rejects as that run does, except
   * that aborting `options.signal` rejects this caller with a cancellation
   * straight away.
   */
  run(
    key: string,
    token: unknown,
    options: JobOptions,
    start: (job: JobOptions) => Promise<R>
  ): Promise<R>;
  /** Runs currently in flight, for tests. */
  readonly size: number;
}

export function createSharedJob<R>(): SharedJob<R> {
  const inFlight = new Map<string, Entry<R>>();

  const begin = (key: string, token: unknown, start: (job: JobOptions) => Promise<R>) => {
    const controller = new AbortController();
    const callers = new Set<JobOptions>();
    const job: JobOptions = {
      signal: controller.signal,
      onProgress: (fraction, label) => {
        for (const caller of callers) caller.onProgress?.(fraction, label);
      },
      onNotice: message => {
        for (const caller of callers) caller.onNotice?.(message);
      }
    };
    const entry: Entry<R> = {
      token,
      controller,
      callers,
      promise: Promise.resolve().then(() => start(job))
    };
    inFlight.set(key, entry);
    const forget = () => {
      if (inFlight.get(key) === entry) inFlight.delete(key);
    };
    entry.promise.then(forget, forget);
    return entry;
  };

  return {
    run(key, token, options, start) {
      if (options.signal?.aborted) return Promise.reject(cancelled());
      let entry = inFlight.get(key);
      if (!entry || entry.token !== token || entry.controller.signal.aborted) {
        entry = begin(key, token, start);
      }
      const joined = entry;
      joined.callers.add(options);
      return new Promise<R>((resolve, reject) => {
        const leave = () => {
          joined.callers.delete(options);
          options.signal?.removeEventListener('abort', onAbort);
        };
        const onAbort = () => {
          leave();
          // The last one out stops the work; anyone still attached keeps it.
          if (joined.callers.size === 0) joined.controller.abort();
          reject(cancelled());
        };
        options.signal?.addEventListener('abort', onAbort, { once: true });
        joined.promise.then(
          value => {
            leave();
            resolve(value);
          },
          (err: unknown) => {
            leave();
            reject(err);
          }
        );
      });
    },
    get size() {
      return inFlight.size;
    }
  };
}
