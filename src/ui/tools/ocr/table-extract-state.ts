import { signal } from '@preact/signals';

export type TableExportFormat = 'csv' | 'tsv' | 'xlsx';

/**
 * OCR-03's table extraction has two ways out — the panel's per-format buttons and
 * the action bar's primary "Export Table" CTA. While the panel held the page
 * number, the extracted grid and the user's cell edits in component state, the
 * action bar could see none of it: its handler was an empty function, and the
 * obvious repair (re-extract page 0) would have exported a different table from
 * the one on screen. These signals are the shared state both routes read.
 */
export const tableExtractPageIndex = signal<number>(0);

/** The grid as currently shown and edited in the preview, or `null` if not previewed. */
export const tableExtractRows = signal<string[][] | null>(null);

/** Last format the user exported, so the primary CTA repeats their choice. */
export const tableExtractFormat = signal<TableExportFormat>('csv');

/** Clears the preview — called when the target page changes. */
export function resetTableExtract(): void {
  tableExtractRows.value = null;
}
