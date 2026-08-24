/**
 * Tool settings that outlive their panel.
 *
 * Signals rather than component state, because the action bar commits the operation
 * and the panel configures it — they are siblings. Previously some of these lived in
 * `core/ui.ts` and others were exported from the panel component itself, so
 * `ActionBar` imported from `CompressPanel` to read a DPI value.
 */
import { signal } from '@preact/signals';
import type { ImagesToPdfOptions } from '../../core/operations';

export type SplitMode = 'extract' | 'individual' | 'every_n' | 'custom' | 'bookmarks' | 'size';

export interface SplitSettings {
  mode: SplitMode;
  everyN: number;
  customBoundaries: string;
  outputFormat: 'zip' | 'directory';
  /** OPS-15 — target size per output file, in kilobytes. */
  targetSizeKb: number;
}

export const splitSettings = signal<SplitSettings>({
  mode: 'extract',
  everyN: 2,
  customBoundaries: '',
  outputFormat: 'zip',
  targetSizeKb: 5000
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
 * Sign starts off non-destructive so the form fields it just created stay
 * fillable unless the user explicitly chooses to flatten them. Annotate still
 * defaults to a finalized export because that tool is primarily about baking
 * in existing page marks.
 *
 * Deliberately read *only* by the sign and annotate commit handlers, the two
 * tools whose panels show the control. Reading a global settings signal from
 * every tool's export was OPS-09 — merge and crop silently inherited a setting
 * the user set somewhere else and never saw again.
 */
export const signFlattenOnExport = signal(false);
export const annotateFlattenOnExport = signal(true);

/**
 * CNV-06 — Markdown → PDF source text.
 *
 * Lives here rather than in the panel's own `useState` so the action bar's commit
 * button (the single primary CTA, DESIGN-ADAPTATION §4.2) can read it: the panel
 * configures, the action bar commits, same split as every other tool.
 */
export const markdownToPdfSource = signal('');

/**
 * CNV-01 — Images → PDF, as a standalone tool rather than only reachable by
 * dropping images at the start screen. The file list lives here (not `useState`
 * in the panel) for the same reason `markdownToPdfSource` does: the action bar
 * commits, the panel only configures.
 */
export interface ImagesToPdfSettings {
  files: File[];
  pageSize: ImagesToPdfOptions['pageSize'];
  orientation: ImagesToPdfOptions['orientation'];
  margin: number;
  quality: number;
}

export const imagesToPdfSettings = signal<ImagesToPdfSettings>({
  files: [],
  pageSize: 'original',
  orientation: 'auto',
  margin: 0,
  quality: 0.9
});

export interface ExtractImagesSettings {
  outputFormat: 'zip' | 'directory';
}

export const extractImagesSettings = signal<ExtractImagesSettings>({
  outputFormat: 'zip'
});
