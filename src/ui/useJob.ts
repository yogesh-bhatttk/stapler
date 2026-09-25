/**
 * Runs one cancellable, progress-reporting job at a time.
 *
 * Every long operation in the app previously looked like `setExporting(true)` … `await`
 * … `alert('Failed to export PDF')`, with a Cancel button next to it that had no
 * handler at all. This hook is the single place the lifecycle lives, so "cancellable
 * and reports determinate progress" (TICKETS definition of done) holds by
 * construction rather than per call site.
 */
import { useCallback, useEffect, useRef } from 'preact/hooks';
import { activeJob } from '../core/notify';
import { notify, notifyError } from '../core/notify';
import { translate } from '../core/i18n';
import { isCancellation } from '../core/errors';
import type { JobOptions } from '../core/workers/protocol';

export interface RunOptions {
  /** Shown next to the progress bar until the first report replaces it. */
  label: string;
  /** Scope name for the diagnostic log. */
  scope: string;
}

export function useJob() {
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      // Leaving the view must not leave a worker grinding on output nobody wants —
      // but only if THIS instance is the one that owns the running job. `activeJob`
      // is a single shared signal read by every panel's own `useJob()`; clearing it
      // unconditionally here would wipe out a job owned by a different instance
      // (e.g. the action bar's commit) merely because some unrelated panel happened
      // to unmount, such as when the user switches tools while an export is running.
      if (controllerRef.current) {
        controllerRef.current.abort();
        // Null it out (not just abort) so `run`'s own `finally` — which fires
        // later, once the aborted task actually unwinds — sees its guard
        // `controllerRef.current === controller` fail and leaves `activeJob`
        // alone. Left set, that stale ref would still match `controller`
        // when the finally runs, and null out `activeJob` a second time —
        // wiping out a *new* job a different `useJob()` instance had since
        // started, because `activeJob` is one signal shared by all of them.
        controllerRef.current = null;
        activeJob.value = null;
      }
    },
    []
  );

  const run = useCallback(
    async <T>(
      options: RunOptions,
      task: (jobOptions: JobOptions) => Promise<T>
    ): Promise<T | undefined> => {
      // A second commit while one is running would interleave worker calls on the
      // same document. `activeJob` is shared across every `useJob()` instance, so
      // the guard has to check it, not just this instance's own controller — the
      // action bar disables its button as the primary defence, and this is the
      // backstop for every other panel's secondary actions (Analyse, Scan, Detect
      // headings, …) that don't have their own busy-check against another job.
      if (controllerRef.current || activeJob.value !== null) {
        // Refused out loud. A silent `undefined` meant a click (or, for Merge,
        // a whole file pick) vanished with no explanation (AUDIT-2026-09-25 UI-20).
        notify('info', translate('Finish or cancel the current operation first.'), {
          detail: activeJob.value
            ? translate('"{label}" is still running.', { label: activeJob.value.label })
            : undefined
        });
        return undefined;
      }

      const controller = new AbortController();
      controllerRef.current = controller;
      activeJob.value = {
        label: options.label,
        progress: null,
        cancel: () => controller.abort()
      };

      const jobOptions: JobOptions = {
        signal: controller.signal,
        onProgress: (fraction, label) => {
          // Only update while this job owns the slot, so a late report from an
          // aborted job cannot resurrect the progress bar.
          if (controllerRef.current !== controller) return;
          activeJob.value = {
            label: label || options.label,
            progress: fraction,
            cancel: () => controller.abort()
          };
        }
      };

      try {
        return await task(jobOptions);
      } catch (err) {
        // A cancellation is the user getting what they asked for, not a failure.
        if (!isCancellation(err)) notifyError(options.scope, err);
        return undefined;
      } finally {
        if (controllerRef.current === controller) {
          controllerRef.current = null;
          activeJob.value = null;
        }
      }
    },
    []
  );

  return { run, isRunning: () => controllerRef.current !== null };
}
