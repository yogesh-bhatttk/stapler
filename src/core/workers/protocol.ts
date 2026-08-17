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
}

/** What the worker receives: the port, proxied across the boundary. */
export type JobHandle = Comlink.Remote<JobPort> | JobPort;

export interface JobOptions {
  signal?: AbortSignal;
  onProgress?: (fraction: number | null, label: string) => void;
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
    }
  };
  return Comlink.proxy(port);
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
    }
  };
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
