/**
 * HRD-60 (AUDIT-2026-10-01 pattern 8) — an async function as a plain event
 * handler. DOM and Preact event props ignore a returned promise, so a rejection
 * from an `async` handler used to surface only through the global
 * `unhandledrejection` backstop (`errorHooks.ts`), with no scope to say which
 * control failed. This catches it where it happens and reports it through the
 * app's one error funnel, `notifyError` — a typed toast, silent for a
 * cancellation.
 *
 * Use it for handlers that can reject (file pickers, saves, storage). A handler
 * whose errors are already handled inside — `useJob().run()` never rejects —
 * is called as `() => void handler()` instead.
 */
import { notifyError } from '../core/notify';

export function withErrorToast<A extends unknown[]>(
  scope: string,
  handler: (...args: A) => Promise<unknown>
): (...args: A) => void {
  return (...args) => {
    try {
      handler(...args).catch((err: unknown) => {
        notifyError(scope, err);
      });
    } catch (err) {
      // A handler that throws before its first `await` throws synchronously.
      notifyError(scope, err);
    }
  };
}
