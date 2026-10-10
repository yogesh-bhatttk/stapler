/**
 * Application-level notification state.
 *
 * Replaces `alert()` / `confirm()`, which blocked the main thread, could not be
 * styled or themed, were unreachable for a screen reader in context, and made
 * every error read the same. Toasts and confirmations are plain signals so any
 * layer (core or UI) can raise one without importing a component.
 */
import { signal } from '@preact/signals';
import type { PageAlignment } from './page-alignment';
import { translate } from './i18n';
import {
  buildDiagnostic,
  fromUnknown,
  isCancellation,
  logError,
  type StaplerError
} from './errors';

export type ToastTone = 'info' | 'success' | 'warning' | 'danger';

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: string;
  tone: ToastTone;
  title: string;
  /** Optional second line. Keep it actionable. */
  detail?: string;
  /** Attaches a "Copy diagnostic" action (F-07). */
  diagnostic?: string;
  /** One button that runs `run` and dismisses the toast (e.g. GAP-2's "Reload"). */
  action?: ToastAction;
  /** ms before auto-dismiss; 0 keeps it until dismissed. */
  timeout: number;
}

export const toasts = signal<Toast[]>([]);

/**
 * At most this many toasts on screen. Danger toasts never time out, so a run of
 * failures used to stack without limit over the action bar (AUDIT-2026-09-25
 * UI-17). The oldest go first — non-danger before danger, so an unread error
 * outlives the info notes around it.
 */
export const MAX_VISIBLE_TOASTS = 4;

const DEFAULT_TIMEOUTS: Record<ToastTone, number> = {
  info: 4000,
  success: 4000,
  warning: 8000,
  danger: 0
};

export function dismissToast(id: string): void {
  toasts.value = toasts.value.filter(t => t.id !== id);
}

export function notify(
  tone: ToastTone,
  title: string,
  options: { detail?: string; diagnostic?: string; action?: ToastAction; timeout?: number } = {}
): string {
  const id = crypto.randomUUID();
  const timeout = options.timeout ?? DEFAULT_TIMEOUTS[tone];
  const next = [...toasts.value, { id, tone, title, ...options, timeout }];
  while (next.length > MAX_VISIBLE_TOASTS) {
    // Oldest non-danger first — including, if every older toast is an error,
    // the one just added: an unread error must outlive an info note, and with
    // four errors up the new note used to push the oldest error out
    // (regression review R-UI-6). Only when all are errors does the oldest go.
    const victim = next.findIndex(t => t.tone !== 'danger');
    next.splice(victim === -1 ? 0 : victim, 1);
  }
  toasts.value = next;
  if (timeout > 0) setTimeout(() => dismissToast(id), timeout);
  return id;
}

/**
 * The single funnel for anything thrown. Cancellations are not errors and stay
 * silent; everything else becomes a typed toast carrying its recovery advice and
 * a copyable diagnostic.
 */
export function notifyError(scope: string, value: unknown): StaplerError {
  const err = logError(scope, value);
  if (isCancellation(err)) return err;
  notify(
    err.kind === 'UnsupportedFeature' || err.kind === 'Encrypted' ? 'warning' : 'danger',
    translate(err.copy.title),
    {
      detail: `${err.message} ${translate(err.copy.recovery)}`.trim(),
      diagnostic: buildDiagnostic(err)
    }
  );
  return err;
}

/** Non-throwing variant for places that only want the copy. */
export function errorCopy(value: unknown) {
  const err = fromUnknown(value);
  return {
    title: translate(err.copy.title),
    detail: `${err.message} ${translate(err.copy.recovery)}`.trim()
  };
}

/* ------------------------------------------------------------------ *
 * Modal request queues
 *
 * Each modal below (confirm / OCR consent / export review) is rendered from a
 * single "current request" signal — only one dialog of that kind can be on
 * screen at once. Two overlapping callers (a fast double-click before the
 * first modal has mounted, two panels independently asking for the same
 * consent) used to just overwrite that signal: the first request's `resolve`
 * was discarded along with it, so nothing ever settled its Promise and the
 * awaiting caller hung forever. `createModalQueue` instead queues a second
 * concurrent request behind the first and shows it only once the first
 * settles, so every caller's Promise resolves, in the order they asked.
 * ------------------------------------------------------------------ */

function createModalQueue<
  TResult,
  TRequest extends { resolve: (result: TResult) => void }
>(current: { value: TRequest | null }) {
  const queue: TRequest[] = [];

  function enqueue(build: (resolve: (result: TResult) => void) => Omit<TRequest, 'resolve'>) {
    return new Promise<TResult>(resolvePromise => {
      // RT-15 — a dialog can call `resolve` more than once (an Escape keydown
      // and the backdrop click in the same frame, a button's click plus the
      // modal's own onClose). Each extra call used to run `queue.shift()`
      // again, which removed the *next* caller's request before it was ever
      // shown — its Promise then never settled. Settle once per request, and
      // only take a request off the queue if it is still the one at its head.
      let settled = false;
      const request = {
        ...build(result => {
          if (settled) return;
          settled = true;
          resolvePromise(result);
          const index = queue.indexOf(request);
          if (index === -1) return;
          queue.splice(index, 1);
          if (index === 0) current.value = queue[0] ?? null;
        })
      } as TRequest;
      queue.push(request);
      if (queue.length === 1) current.value = request;
    });
  }

  return { enqueue };
}

/* ------------------------------------------------------------------ *
 * Confirmations
 * ------------------------------------------------------------------ */

export interface ConfirmRequest {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  tone: 'default' | 'danger';
  /** Optional bullet list under the body, e.g. exactly what will be deleted. */
  details?: string[];
  /**
   * False for a question where *both* answers act — the session-restore prompt's
   * "Start fresh" deletes the saved session — so Escape, the scrim and a close
   * button must not quietly pick one (AUDIT-2026-10-10 UI2). Defaults to true:
   * dismissing an ordinary confirmation is a harmless "no".
   */
  dismissible: boolean;
  /**
   * Which footer button takes focus when the dialog opens. Defaults to the cancel
   * button — the non-destructive answer — so a stray Enter never confirms; a
   * prompt whose cancel is the destructive answer passes 'confirm'.
   */
  initialFocus: 'cancel' | 'confirm';
  resolve: (ok: boolean) => void;
}

export const confirmRequest = signal<ConfirmRequest | null>(null);
const confirmQueue = createModalQueue<boolean, ConfirmRequest>(confirmRequest);

/**
 * Promise-based replacement for `window.confirm`. Renders through
 * `<ConfirmDialog>` in the app shell, so it is themed, focus-trapped, and
 * keyboard-operable. Concurrent calls queue rather than clobbering one
 * another (see `createModalQueue`).
 */
export function confirmAction(options: {
  title: string;
  body: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'default' | 'danger';
  details?: string[];
  dismissible?: boolean;
  initialFocus?: 'cancel' | 'confirm';
}): Promise<boolean> {
  return confirmQueue.enqueue(resolve => ({
    title: options.title,
    body: options.body,
    details: options.details,
    confirmLabel: options.confirmLabel ?? translate('Continue'),
    cancelLabel: options.cancelLabel ?? translate('Cancel'),
    tone: options.tone ?? 'default',
    dismissible: options.dismissible ?? true,
    initialFocus: options.initialFocus ?? 'cancel',
    resolve
  }));
}

/* ------------------------------------------------------------------ *
 * OCR Consent Modal
 * ------------------------------------------------------------------ */

export interface OcrConsentRequest {
  /**
   * The language codes not yet downloaded. Length 1 for a solo run, or for a
   * combined run where every other component is already cached; length 2+ only
   * for a combined run that needs more than one model. "Upload offline model"
   * is only offered at length 1 — one file cannot cover two languages.
   */
  langs: string[];
  title: string;
  body: string;
  resolve: (result: 'download' | 'upload' | 'cancel') => void;
}

export const ocrConsentRequest = signal<OcrConsentRequest | null>(null);
const ocrConsentQueue = createModalQueue<'download' | 'upload' | 'cancel', OcrConsentRequest>(
  ocrConsentRequest
);

export function requestOcrConsent(
  langs: string[],
  title: string,
  body: string
): Promise<'download' | 'upload' | 'cancel'> {
  return ocrConsentQueue.enqueue(resolve => ({ langs, title, body, resolve }));
}

/* ------------------------------------------------------------------ *
 * UX-02/03 — pre-export review
 * ------------------------------------------------------------------ */

export interface ExportReviewRequest {
  /** 'zip' unzips `resultBytes` into a file list; 'single' reviews it as one PDF. */
  kind: 'single' | 'zip';
  /**
   * The document as it stood before this operation, for a before/after diff.
   * `null` skips diffing outright — a non-PDF output (CNV conversions,
   * table-extract's CSV/XLSX) or a tool with no single "before" PDF to speak of
   * (images-to-pdf, md-to-pdf) has nothing meaningful to diff against.
   */
  originalBytes: Uint8Array | null;
  resultBytes: Uint8Array;
  fileName: string;
  /**
   * Which page in `originalBytes` corresponds to which page in `resultBytes`,
   * from `alignPages` (`core/page-alignment.ts`) — lets the modal show a
   * correct diff (and a rotated/moved badge) per page even after reordering,
   * and name pages removed since the baseline. Absent for tools with no page
   * list to align (a non-PDF output, or one built from scratch).
   */
  alignment?: PageAlignment;
  resolve: (proceed: boolean) => void;
}

export const exportReviewRequest = signal<ExportReviewRequest | null>(null);
const exportReviewQueue = createModalQueue<boolean, ExportReviewRequest>(exportReviewRequest);

/**
 * Promise-based "review this before it's written" gate, resolved by
 * `<ExportReviewModal>` in the app shell — same shape as `confirmAction` and
 * `requestOcrConsent`, but for a rich before/after preview instead of a
 * yes/no question.
 */
export function requestExportReview(input: {
  kind: 'single' | 'zip';
  originalBytes: Uint8Array | null;
  resultBytes: Uint8Array;
  fileName: string;
  alignment?: PageAlignment;
}): Promise<boolean> {
  return exportReviewQueue.enqueue(resolve => ({ ...input, resolve }));
}

/* ------------------------------------------------------------------ *
 * Long-running job status — one at a time, matching the single action bar.
 * ------------------------------------------------------------------ */

export interface JobStatus {
  label: string;
  /** 0..1, or null while the total is genuinely unknown. */
  progress: number | null;
  cancel: () => void;
}

export const activeJob = signal<JobStatus | null>(null);
