/**
 * Page edits wait for the running job (AUDIT-2026-09-25 M5: RT-8, UI-10).
 *
 * Only undo/redo, tab switching and the primary CTA checked `activeJob`.
 * Rotating, deleting, reordering, pasting or stamping mid-job was allowed — and
 * then lost: redaction, face blur and cleanup replace the page list wholesale
 * from their start-of-job snapshot, and an export stamps a baseline from the
 * page list it captured. A page deleted during a redaction came back.
 *
 * Guarded at the user-facing call sites rather than in the store, because some
 * jobs legitimately mutate pages from inside themselves (detect-blank deletes
 * the pages it found).
 */
import { activeJob, notify } from '../core/notify';
import { translate } from '../core/i18n';

/** True (and tells the user why) when a job is running and a page edit must wait. */
export function refuseEditWhileBusy(): boolean {
  const job = activeJob.value;
  if (job === null) return false;
  notify('info', translate('Wait for the current operation to finish before editing pages.'), {
    detail: translate(
      '"{label}" is still running. Edits made now would be overwritten when it finishes.',
      { label: job.label }
    )
  });
  return true;
}
