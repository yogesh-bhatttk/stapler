import { signal, effect } from '@preact/signals';
import { activeDocId } from '../../../core/store';
import type { RedactionOutcome } from '../../../core/operations';
import type { RedactionRegion } from '../../../core/workers/process.worker';
import type { PatternSuggestion } from '../../../core/workers/render.worker';

export const pendingRedactions = signal<RedactionRegion[]>([]);

/**
 * RED-07 — which shape the pointer draws: a dragged rectangle or a traced
 * freehand outline. Not cleared on document change: it is a tool preference, not
 * a mark, and resetting it under the user mid-document would be surprising.
 */
export const redactShapeMode = signal<'rect' | 'polygon'>('rect');

/**
 * RED-05's proposals. Deliberately a separate signal from `pendingRedactions`:
 * nothing in this list is marked for removal, and the only way into that list is
 * a click on Accept. Clearing it on document change follows the same reasoning as
 * the marks below — the page indices mean nothing against a different document.
 */
export const patternSuggestions = signal<PatternSuggestion[]>([]);

/** True once a scan has run, so "nothing found" can be told apart from "not scanned". */
export const patternScanRan = signal(false);

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
  patternSuggestions.value = [];
  patternScanRan.value = false;
});
