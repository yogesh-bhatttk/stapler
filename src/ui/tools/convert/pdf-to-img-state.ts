/**
 * GAP-5 — what the last sized PDF → images export actually produced, per page.
 *
 * Set by the commit path, measured on the bytes that went into the ZIP, and
 * shown by the panel so a page that missed its target is named rather than
 * hidden inside an archive. Describes one revision of one document, so it is
 * cleared when either changes.
 */
import { signal } from '@preact/signals';
import type { SizedPageImage } from '../../../core/operations';
import { resetOnDocumentChange } from '../docScoped';

export interface PdfToImageReport {
  docId: string;
  targetBytes: number | null;
  pages: SizedPageImage[];
}

export const pdfToImageReport = signal<PdfToImageReport | null>(null);

resetOnDocumentChange(
  () => {
    pdfToImageReport.value = null;
  },
  { onPageEdits: true }
);

/** Longest-side presets offered in the panels, in pixels. */
export const MAX_DIMENSION_PRESETS = [4000, 3000, 2000, 1600, 1200, 1024, 800, 600, 400] as const;

/** `0` stands for "no limit" in the select; the setting stores null. */
export function maxDimensionOptions(
  current: number | null,
  t: (key: string, params?: Record<string, string | number>) => string
): { value: number; label: string }[] {
  const values: number[] = [...MAX_DIMENSION_PRESETS];
  if (current !== null && !values.includes(current)) values.push(current);
  values.sort((a, b) => b - a);
  return [
    { value: 0, label: t('No limit') },
    ...values.map(value => ({ value, label: t('{size} px', { size: value }) }))
  ];
}
