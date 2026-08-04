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
import { notifyError } from '../core/notify';
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
      // Leaving the view must not leave a worker grinding on output nobody wants.
      controllerRef.current?.abort();
      activeJob.value = null;
    },
    []
  );

  const run = useCallback(
    async <T>(
      options: RunOptions,
      task: (jobOptions: JobOptions) => Promise<T>
    ): Promise<T | undefined> => {
      // A second commit while one is running would interleave worker calls on the
      // same document; the action bar disables its button, and this is the backstop.
      if (controllerRef.current) return undefined;

      const controller = new AbortController();
      controllerRef.current = controller;
      activeJob.value = {
        label: options.label,
        progress: null,
        cancel: () => controller.abort()
      };

      try {
        return await task({
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
        });
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
