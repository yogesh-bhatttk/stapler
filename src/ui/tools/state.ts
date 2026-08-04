/**
 * Tool settings that outlive their panel.
 *
 * Signals rather than component state, because the action bar commits the operation
 * and the panel configures it — they are siblings. Previously some of these lived in
 * `core/ui.ts` and others were exported from the panel component itself, so
 * `ActionBar` imported from `CompressPanel` to read a DPI value.
 */
import { signal } from '@preact/signals';

export type SplitMode = 'extract' | 'individual' | 'every_n' | 'custom';

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
