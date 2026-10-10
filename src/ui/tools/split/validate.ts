/**
 * Split's two number fields, stored exactly as typed (AUDIT-2026-10-10 UI6, the
 * IMG-2 pattern): an empty, fractional or out-of-range value is shown with an
 * inline error and refused by the split, never silently replaced — clamping on
 * every keystroke made the field impossible to clear and retype, and turned
 * "2.5 pages per file" into 2 without a word.
 */
import { translate } from '../../../core/i18n';
import type { SplitSettings } from '../state';

/**
 * Why "Pages per file" can't be used, or null: a whole number, 1 or more. More
 * than the page count is allowed — it simply yields one file, and the panel's
 * "Produces N files" line says so — because the default (2) must not show an
 * error on a one-page document.
 */
export function everyNError(everyN: number): string | null {
  if (!Number.isInteger(everyN) || everyN < 1) {
    return translate('Enter a whole number of pages, 1 or more.');
  }
  return null;
}

/** Why "Target size per file (KB)" can't be used, or null. */
export function targetSizeKbError(targetSizeKb: number): string | null {
  if (!Number.isFinite(targetSizeKb) || targetSizeKb < 1) {
    return translate('Enter a size of at least 1 KB.');
  }
  return null;
}

/** The error for the active mode's number field, or null when the split can run. */
export function splitSettingsError(settings: SplitSettings): string | null {
  if (settings.mode === 'every_n') return everyNError(settings.everyN);
  if (settings.mode === 'size') return targetSizeKbError(settings.targetSizeKb);
  return null;
}

/** An `<input type=number>`'s value as typed: '' is NaN, never a silent fallback. */
export function parseTypedNumber(raw: string): number {
  return raw.trim() === '' ? NaN : Number(raw);
}
