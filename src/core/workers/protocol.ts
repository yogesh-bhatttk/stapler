/**
 * F-05 — the shared worker job protocol.
 *
 * Every long operation in Stapler must report determinate progress and be
 * cancellable (TICKETS "definition of done"). `AbortSignal` cannot be
 * structured-cloned, and a Comlink call is a single await that cannot be
 * interrupted, so the protocol is:
 *
 *   main thread                       worker
 *   -----------                       ------
 *   passes a JobHandle:               receives it as a `JobPort`
 *     • onProgress  (Comlink.proxy)     calls port.progress(0..1, label)
 *     • isCancelled (Comlink.proxy)     awaits port.cancelled() at each
 *                                       cancellation point and throws
 *
 * Cancellation is therefore cooperative and bounded by the granularity of the
 * checks — one page, never a whole document — which is what lets us honour the
 * "cancels within 200ms" acceptance criterion without terminating the worker and
 * losing its warm pdf.js instance.
 */
import * as Comlink from 'comlink';
import { cancelled as cancelledError } from '../errors';

export interface JobPort {
  /**
   * `fraction` is 0..1, or null when the total is genuinely unknown.
   *
   * A `Promise` return is allowed so a wrapper (see {@link subJob}) can forward
   * the Comlink round-trip rather than swallowing it — `checkpoint` awaits this.
   */
  progress(fraction: number | null, label: string): void | Promise<void>;
  /** Resolves true once the caller has aborted. */
  cancelled(): boolean | Promise<boolean>;
  /**
   * A fact about a result that otherwise succeeded, which the caller must pass
   * on to the user — a form field renamed so two files' values stay apart, a
   * document-level item a rebuild could not carry. Optional: a port without it
   * simply hears nothing (see {@link reportNotice}).
   */
  notice?(message: string): void | Promise<void>;
}

/** What the worker receives: the port, proxied across the boundary. */
export type JobHandle = Comlink.Remote<JobPort> | JobPort;

export interface JobOptions {
  signal?: AbortSignal;
  onProgress?: (fraction: number | null, label: string) => void;
  /** Receives every {@link JobPort.notice} the worker reports, already translated. */
  onNotice?: (message: string) => void;
}

/**
 * Wraps `AbortSignal` + a progress callback into something Comlink can transfer.
 * Call inside the main thread, pass the result as the last argument of a worker
 * method typed to accept a `JobHandle`.
 */
export function createJobHandle(options: JobOptions = {}): JobHandle {
  const port: JobPort = {
    progress(fraction, label) {
      options.onProgress?.(fraction, label);
    },
    cancelled() {
      return options.signal?.aborted ?? false;
    },
    notice(message) {
      options.onNotice?.(message);
    }
  };
  return Comlink.proxy(port);
}

/**
 * Wraps a Comlink-exposed worker API so that every call releases any
 * `JobHandle` argument once it settles (W-07).
 *
 * Each time a `Comlink.proxy()`-marked object crosses the postMessage
 * boundary as an argument, Comlink opens a fresh `MessageChannel` and
 * `expose()`s the object on it — a listener that lives until something
 * sends it a release message. Only the *receiving* side (here, the worker,
 * which gets the argument back as a `Remote<JobPort>`) can send that
 * message; the main thread's original marked object never gains a
 * `releaseProxy` method, so it has no way to close a channel it never held
 * a handle to. Wrapping the exposed API at this single boundary releases
 * every job argument the worker receives, without every one of its ~30
 * methods needing its own `finally` block.
 */
export function releaseJobHandlesAfterCall<T extends object>(api: T): T {
  return new Proxy(api, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return function (this: unknown, ...args: unknown[]) {
        return Promise.resolve(value.apply(target, args)).finally(() => {
          for (const arg of args) {
            const release = (arg as { [Comlink.releaseProxy]?: unknown } | null)?.[
              Comlink.releaseProxy
            ];
            if (typeof release === 'function') release.call(arg);
          }
        });
      };
    }
  });
}

/** A no-op port, for callers that genuinely have nothing to report. */
export const silentJob: JobPort = {
  progress() {},
  cancelled() {
    return false;
  }
};

/**
 * Re-scales a job handle's progress into the sub-range `[from, to]`.
 *
 * Lets a helper deep in `core/` (e.g. `encryptPdf`) report its own 0..1 progress
 * without knowing where its work sits in the caller's overall bar, and without
 * the caller's band leaking into a module that has no business knowing it.
 * Cancellation passes straight through, unchanged.
 */
export function subJob(job: JobHandle | undefined, from: number, to: number): JobPort | undefined {
  if (!job) return undefined;
  return {
    progress(fraction, label) {
      const scaled =
        fraction === null ? null : from + (to - from) * Math.min(1, Math.max(0, fraction));
      return job.progress(scaled, label) as void | Promise<void>;
    },
    cancelled() {
      return job.cancelled();
    },
    notice(message) {
      return reportNotice(job, message);
    }
  };
}

/**
 * Worker-side: passes a user-facing notice to the caller, if it listens.
 *
 * Never throws. Across Comlink every property of a remote port looks present,
 * so a port built without `notice` only reveals that by rejecting the call —
 * which must not fail an operation whose result is otherwise good.
 */
export async function reportNotice(job: JobHandle | undefined, message: string): Promise<void> {
  // Called as a method, never through `.call`: on a Comlink remote `.call` is
  // just another remote property path, not Function.prototype.call.
  const port = job as JobPort | undefined;
  if (typeof port?.notice !== 'function') return;
  try {
    await port.notice(message);
  } catch {
    // The caller has no notice channel; the result itself is unaffected.
  }
}

/**
 * Worker-side cancellation point. Throws `UserCancelled` if the caller aborted.
 * Call once per unit of work (per page, per file), never inside a pixel loop.
 */
export async function checkpoint(
  job: JobHandle | undefined,
  fraction: number | null,
  label: string
) {
  if (!job) return;
  if (await job.cancelled()) throw cancelledError();
  await job.progress(fraction, label);
}
