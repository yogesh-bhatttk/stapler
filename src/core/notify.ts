/**
 * Application-level notification state.
 *
 * Replaces `alert()` / `confirm()`, which blocked the main thread, could not be
 * styled or themed, were unreachable for a screen reader in context, and made
 * every error read the same. Toasts and confirmations are plain signals so any
 * layer (core or UI) can raise one without importing a component.
 */
import { signal } from '@preact/signals';
import {
  buildDiagnostic,
  fromUnknown,
  isCancellation,
  logError,
  type StaplerError
} from './errors';

export type ToastTone = 'info' | 'success' | 'warning' | 'danger';

export interface Toast {
  id: string;
  tone: ToastTone;
  title: string;
  /** Optional second line. Keep it actionable. */
  detail?: string;
  /** Attaches a "Copy diagnostic" action (F-07). */
  diagnostic?: string;
  /** ms before auto-dismiss; 0 keeps it until dismissed. */
  timeout: number;
}

export const toasts = signal<Toast[]>([]);

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
  options: { detail?: string; diagnostic?: string; timeout?: number } = {}
): string {
  const id = crypto.randomUUID();
  const timeout = options.timeout ?? DEFAULT_TIMEOUTS[tone];
  toasts.value = [...toasts.value, { id, tone, title, ...options, timeout }];
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
  if (isCancellation(value)) return err;
  notify(
    err.kind === 'UnsupportedFeature' || err.kind === 'Encrypted' ? 'warning' : 'danger',
    err.copy.title,
    {
      detail: `${err.message} ${err.copy.recovery}`.trim(),
      diagnostic: buildDiagnostic(err)
    }
  );
  return err;
}

/** Non-throwing variant for places that only want the copy. */
export function errorCopy(value: unknown) {
  const err = fromUnknown(value);
  return { title: err.copy.title, detail: `${err.message} ${err.copy.recovery}`.trim() };
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
  resolve: (ok: boolean) => void;
}

export const confirmRequest = signal<ConfirmRequest | null>(null);

/**
 * Promise-based replacement for `window.confirm`. Renders through
 * `<ConfirmDialog>` in the app shell, so it is themed, focus-trapped, and
 * keyboard-operable.
 */
export function confirmAction(options: {
  title: string;
  body: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'default' | 'danger';
}): Promise<boolean> {
  return new Promise(resolve => {
    confirmRequest.value = {
      title: options.title,
      body: options.body,
      confirmLabel: options.confirmLabel ?? 'Continue',
      cancelLabel: options.cancelLabel ?? 'Cancel',
      tone: options.tone ?? 'default',
      resolve: ok => {
        confirmRequest.value = null;
        resolve(ok);
      }
    };
  });
}

/* ------------------------------------------------------------------ *
 * OCR Consent Modal
 * ------------------------------------------------------------------ */

export interface OcrConsentRequest {
  lang: string;
  title: string;
  body: string;
  resolve: (result: 'download' | 'upload' | 'cancel') => void;
}

export const ocrConsentRequest = signal<OcrConsentRequest | null>(null);

export function requestOcrConsent(lang: string, title: string, body: string): Promise<'download' | 'upload' | 'cancel'> {
  return new Promise(resolve => {
    ocrConsentRequest.value = {
      lang,
      title,
      body,
      resolve: result => {
        ocrConsentRequest.value = null;
        resolve(result);
      }
    };
  });
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
