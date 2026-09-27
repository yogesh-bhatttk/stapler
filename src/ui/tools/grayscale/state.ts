/**
 * GAP-6 — Grayscale tool state: the panel's choices, and the last run's report.
 */
import { signal } from '@preact/signals';
import { resetOnDocumentChange } from '../docScoped';
import type { GrayPageOutcome } from '../../../core/pdf/grayscale';

export interface GrayscaleToolSettings {
  /** `gray` keeps shades; `bw` thresholds to pure black and white (scans). */
  mode: 'gray' | 'bw';
  /** Every page, or only the pages ticked in the grid. */
  scope: 'all' | 'selected';
  /** Resolution for pages that have to be rendered rather than rewritten. */
  rasterDpi: 150 | 200 | 300;
}

export const grayscaleSettings = signal<GrayscaleToolSettings>({
  mode: 'gray',
  scope: 'all',
  rasterDpi: 150
});

export interface GrayscaleReport {
  pages: GrayPageOutcome[];
  undecodable: { pageIndex: number; count: number }[];
  originalBytes: number;
  resultBytes: number;
  mode: 'gray' | 'bw';
}

/** The last conversion of the active document — describes its pages, so reset on edits. */
export const grayscaleReport = signal<GrayscaleReport | null>(null);

resetOnDocumentChange(
  () => {
    grayscaleReport.value = null;
  },
  { onPageEdits: true }
);
