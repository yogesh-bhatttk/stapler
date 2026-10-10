/**
 * AUDIT-2026-10-10 M4 — Clear-all's partial-failure warning, carried across
 * the reload that follows it.
 *
 * Split from `clearLocalData.ts` so the shell can show a pending notice at
 * startup without pulling the clearing code (OCR model state, signatures) into
 * the first-paint bundle.
 */
import { notify } from '../core/notify';
import { translate } from '../core/i18n';

/**
 * M4 — the one-shot "some data was left behind" notice that survives the
 * reload after Clear-all. Only the count is stored, not the translated text:
 * the clear also removed the language choice, so the next page may speak
 * another language. Written after the clear (which removes `stapler.*` keys).
 */
export const CLEAR_NOTICE_KEY = 'stapler.clear-notice';

export function notifyPartialClear(filesFailed: number): void {
  notify('warning', translate('Some local data could not be cleared.'), {
    detail:
      filesFailed > 0
        ? translate(
            'Stored files that could not be deleted: {count}. Close every other Stapler tab and try again, or use your browser’s “Clear site data”.',
            { count: filesFailed }
          )
        : translate(
            'Browser storage did not respond. Use your browser’s “Clear site data” to remove the rest.'
          ),
    // Shown on a fresh page the user did not ask for: keep it until read.
    timeout: 0
  });
}

export function rememberPartialClear(filesFailed: number): void {
  try {
    globalThis.sessionStorage?.setItem(CLEAR_NOTICE_KEY, JSON.stringify({ filesFailed }));
  } catch {
    // No session storage: the toast raised before the reload is all there is.
  }
}

/**
 * Called once at startup: shows (and forgets) the partial-clear warning a
 * Clear-all left for the page that followed its reload. Returns whether one
 * was shown.
 */
export function showPendingClearNotice(): boolean {
  let raw: string | null;
  try {
    raw = globalThis.sessionStorage?.getItem(CLEAR_NOTICE_KEY) ?? null;
    if (raw !== null) globalThis.sessionStorage?.removeItem(CLEAR_NOTICE_KEY);
  } catch {
    return false;
  }
  if (raw === null) return false;
  let filesFailed = 0;
  try {
    const parsed: unknown = JSON.parse(raw);
    const n =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as { filesFailed?: unknown }).filesFailed
        : undefined;
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) filesFailed = Math.floor(n);
  } catch {
    // Malformed: still say something was left behind.
  }
  notifyPartialClear(filesFailed);
  return true;
}
