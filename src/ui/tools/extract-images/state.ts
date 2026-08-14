/**
 * CNV-06 — the report of the last extraction run.
 *
 * A signal rather than panel state for the same reason every other tool's
 * settings are: the action bar runs the operation and the panel explains the
 * result, and they are siblings.
 */
import { signal } from '@preact/signals';
import type { ExtractedImageEntry } from '../../../core/workers/process.worker';

export interface ExtractImagesReport {
  /** Store document id, so another document's report is never shown. */
  docId: string;
  entries: ExtractedImageEntry[];
}

export const extractImagesReport = signal<ExtractImagesReport | null>(null);

/** Files written, images left untouched, and the reasons for the latter. */
export function summarize(entries: ExtractedImageEntry[]) {
  const extracted = entries.filter(entry => entry.status === 'extracted');
  const duplicates = entries.filter(entry => entry.status === 'duplicate');
  const skipped = entries.filter(entry => entry.status === 'skipped');
  const masks = extracted.filter(entry => entry.maskFileName).length;
  const reasons = [...new Set(skipped.map(entry => entry.note ?? 'Left untouched.'))];
  return {
    fileCount: extracted.length + masks,
    imageCount: extracted.length,
    duplicateCount: duplicates.length,
    maskCount: masks,
    skippedCount: skipped.length,
    reasons
  };
}
