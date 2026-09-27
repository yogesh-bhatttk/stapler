import { signal } from '@preact/signals';
import { resetOnDocumentChange } from '../docScoped';
import type { MetadataFindings } from '../../../core/workers/process.worker';

// Which metadata fields to strip
export type MetadataStripSettings = Partial<Record<keyof MetadataFindings, boolean>>;

// We also might need a special flag for custom info dict keys, let's call it `customInfo`
export type ExtendedScrubSettings = MetadataStripSettings & { customInfo?: boolean };

/**
 * The per-item selection, or `null` when the current document has not been
 * inspected. `null` is sent to the worker as "no settings", which strips
 * everything — the safe default for a privacy tool.
 *
 * This used to start as `{}`. An empty object is truthy, so the worker's
 * strip-everything fallback never applied and "Strip & export" without a prior
 * "Inspect" removed nothing at all (AUDIT-2026-09-25 UI-1).
 */
export const scrubSettings = signal<ExtendedScrubSettings | null>(null);

/** The last inspection's result, for the document and pages it was taken from. */
export const metadataFindings = signal<MetadataFindings | null>(null);

// An inspection describes one document at one revision. Carried across a tab
// switch, doc A's findings would be shown under doc B and doc A's key set used
// to scrub B — keeping any field B has that A lacked. Reset on any change to
// which document is active or to its page list.
resetOnDocumentChange(
  () => {
    scrubSettings.value = null;
    metadataFindings.value = null;
  },
  { onPageEdits: true }
);
