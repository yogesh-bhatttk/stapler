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
  /** `fraction` is 0..1, or null when the total is genuinely unknown. */
  progress(fraction: number | null, label: string): void;
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
