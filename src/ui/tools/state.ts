/**
 * Tool settings that outlive their panel.
 *
 * Signals rather than component state, because the action bar commits the operation
 * and the panel configures it — they are siblings. Previously some of these lived in
 * `core/ui.ts` and others were exported from the panel component itself, so
 * `ActionBar` imported from `CompressPanel` to read a DPI value.
 */
import { signal } from '@preact/signals';

export type SplitMode = 'extract' | 'individual' | 'every_n' | 'custom' | 'bookmarks';

export interface SplitSettings {
  mode: SplitMode;
  everyN: number;
  customBoundaries: string;
}

export const splitSettings = signal<SplitSettings>({
  mode: 'extract',
  everyN: 2,
  customBoundaries: ''
});

export interface PdfToImageSettings {
  format: 'png' | 'jpeg';
  dpi: number;
}

export const pdfToImageSettings = signal<PdfToImageSettings>({ format: 'jpeg', dpi: 150 });

/** OPS-05 sensitivity, 0 (strict) to 100 (forgiving). */
export const removeBlanksThreshold = signal(50);

/**
 * SGN-05 — whether Sign and Annotate finalize their export.
 *
 * On by default because that was already this path's behaviour: filling a form
 * always flattened it, with no way to ask for the opposite. The toggle makes it
 * a visible choice rather than a silent one, and turning it off now produces a
 * still-fillable form instead of a finalized page.
 *
 * Deliberately read *only* by the sign and annotate commit handlers, the two
 * tools whose panels show the control. Reading a global settings signal from
 * every tool's export was OPS-09 — merge and crop silently inherited a setting
 * the user set somewhere else and never saw again.
 */
export const flattenOnExport = signal(true);
