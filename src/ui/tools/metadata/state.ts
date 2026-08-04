import { signal } from '@preact/signals';
import type { MetadataFindings } from '../../../core/workers/process.worker';

// Which metadata fields to strip
export type MetadataStripSettings = Partial<Record<keyof MetadataFindings, boolean>>;

// We also might need a special flag for custom info dict keys, let's call it `customInfo`
export type ExtendedScrubSettings = MetadataStripSettings & { customInfo?: boolean };

export const scrubSettings = signal<ExtendedScrubSettings>({});
