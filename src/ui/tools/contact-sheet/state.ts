import { signal } from '@preact/signals';

/** Column counts the panel offers. */
export const CONTACT_SHEET_COL_OPTIONS = [2, 3, 4, 5, 6] as const;

/**
 * The contact sheet's column count.
 *
 * A signal rather than component state because DOC-09 has two ways to export —
 * the panel's own button and the action bar's primary CTA — and a local
 * `useState` in the panel meant the action bar could not see the user's choice,
 * so it always exported a 4-column sheet however the panel was set.
 */
export const contactSheetColumns = signal<number>(4);
