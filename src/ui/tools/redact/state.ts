import { signal } from '@preact/signals';
import type { RedactionOutcome } from '../../../core/operations';
import type { RedactionRegion } from '../../../core/workers/process.worker';

export const pendingRedactions = signal<RedactionRegion[]>([]);

/** Verification result, held so RED-03's report survives closing the dialog. */
export const redactionReport = signal<RedactionOutcome | null>(null);
