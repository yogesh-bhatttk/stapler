import { signal, effect } from '@preact/signals';
import { activeDocId } from '../../../core/store';
import type { RedactionOutcome } from '../../../core/operations';
import type { RedactionRegion } from '../../../core/workers/process.worker';

export const pendingRedactions = signal<RedactionRegion[]>([]);

/** Verification result, held so RED-03's report survives closing the dialog. */
export const redactionReport = signal<RedactionOutcome | null>(null);

// `RedactionRegion.pageIndex` is a raw index into whichever document applyRedactions
// runs against — it means nothing once the active document changes. Left in place,
// marks drawn on document A's page 3 would silently target document B's page 3 on
// Verify & Apply after switching documents without applying or clearing them first.
effect(() => {
  void activeDocId.value;
  pendingRedactions.value = [];
  redactionReport.value = null;
});
