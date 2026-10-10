import { signal, effect } from '@preact/signals';
import { activeDoc, activeDocId, type PageRef } from '../../../core/store';
import { notify } from '../../../core/notify';
import { tPlural, translate } from '../../../core/i18n';
import type { RedactionOutcome } from '../../../core/operations';
import type { RedactionRegion } from '../../../core/workers/process.worker';
import type { PatternSuggestion } from '../../../core/workers/render.worker';

/**
 * AUDIT-2026-10-10 H1 — a mark remembers *which page* it was drawn on, not
 * just where that page sat at the time.
 *
 * `pageIndex` alone is a position, and Organize moves positions: delete page
 * 1 and a box drawn on page 3 used to black out what is now page 3 — a
 * different page — while the content the user meant to remove survived, and
 * the verifier (which checks the regions it was given) passed. `pageKey` is
 * the page's identity; `pageIndex` is kept current from it
 * ({@link resolveRedactionMarks}) so everything that reads it — the overlay,
 * the list, the worker — keeps working unchanged.
 *
 * `pageRotation` is the page's rotation when the mark was made. A mark's
 * coordinates are only meaningful in the frame the page was shown in then;
 * a mark whose page has since been rotated is withdrawn and the user told,
 * rather than converted by a guess at which frame it was in.
 */
export interface PendingRedaction extends RedactionRegion {
  pageKey: string;
  pageRotation: number;
}

/** A pattern suggestion, tied to its page the same way (H1). */
export interface PendingSuggestion extends PatternSuggestion {
  pageKey: string;
  pageRotation: number;
}

export const pendingRedactions = signal<PendingRedaction[]>([]);

/** H1 — `region`, tied to `page`. */
export function markOnPage(region: RedactionRegion, page: PageRef): PendingRedaction {
  return { ...region, pageKey: page.key, pageRotation: page.rotation };
}

/**
 * H1 — ties regions found in bytes composed from `pages` (a text search, a
 * pattern scan) to the pages they were found on. A region whose index is out
 * of range is dropped: there is no page it can honestly be said to belong to.
 */
export function marksForPages(
  regions: readonly RedactionRegion[],
  pages: readonly PageRef[]
): PendingRedaction[] {
  const out: PendingRedaction[] = [];
  for (const region of regions) {
    const page = pages[region.pageIndex];
    if (page) out.push(markOnPage(region, page));
  }
  return out;
}

/** What the worker gets: the region alone, at its current index. */
export function toWorkerRegion(mark: PendingRedaction): RedactionRegion {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { pageKey, pageRotation, ...region } = mark;
  return region;
}

/** Same rectangle, same outline, same text: one mark, however it was added. */
function sameMark(
  a: RedactionRegion & { pageKey: string },
  b: RedactionRegion & { pageKey: string }
) {
  return (
    a.pageKey === b.pageKey &&
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height &&
    (a.text ?? null) === (b.text ?? null) &&
    JSON.stringify(a.points ?? null) === JSON.stringify(b.points ?? null)
  );
}

/**
 * UI#29 — `incoming` added to the marks as they are *now*, minus any already
 * there. "Mark every occurrence" used to write `[...regionsWhenSearchStarted,
 * ...found]`, dropping every mark drawn while the search ran; running the same
 * search twice listed every occurrence twice.
 */
export function mergeMarks(
  current: readonly PendingRedaction[],
  incoming: readonly PendingRedaction[]
): { marks: PendingRedaction[]; added: number } {
  const marks = [...current];
  let added = 0;
  for (const mark of incoming) {
    if (marks.some(existing => sameMark(existing, mark))) continue;
    marks.push(mark);
    added += 1;
  }
  return { marks, added };
}

export interface ResolvedMarks<T> {
  /** Marks still on a page, with `pageIndex` set to where that page is now. */
  kept: T[];
  /** Marks whose page is no longer in the document. */
  deleted: number;
  /** Marks whose page has been rotated since they were made. */
  rotated: number;
  /** False when `kept` is `marks` unchanged (same objects, same order). */
  changed: boolean;
}

/**
 * H1 — resolves each mark's page key against `pages` as they are now. A mark
 * whose page moved gets its new index (a new object; an unchanged mark is
 * returned as is); a mark whose page was deleted, or rotated since, is dropped
 * and counted, so the caller can say so.
 */
export function resolveRedactionMarks<
  T extends { pageKey: string; pageRotation: number; pageIndex: number }
>(marks: readonly T[], pages: readonly PageRef[]): ResolvedMarks<T> {
  const indexByKey = new Map(pages.map((page, index) => [page.key, index]));
  const kept: T[] = [];
  let deleted = 0;
  let rotated = 0;
  let changed = false;
  for (const mark of marks) {
    const index = indexByKey.get(mark.pageKey);
    if (index === undefined) {
      deleted += 1;
      changed = true;
      continue;
    }
    if (pages[index].rotation !== mark.pageRotation) {
      rotated += 1;
      changed = true;
      continue;
    }
    if (index !== mark.pageIndex) {
      kept.push({ ...mark, pageIndex: index });
      changed = true;
    } else {
      kept.push(mark);
    }
  }
  return { kept, deleted, rotated, changed };
}

/** H1 — tells the user which marks were withdrawn, and why. Silent when none were. */
export function notifyWithdrawnMarks(deleted: number, rotated: number): void {
  if (deleted === 0 && rotated === 0) return;
  const reasons = [
    deleted > 0 ? tPlural('{count} marks were on pages that have been deleted.', deleted) : null,
    rotated > 0
      ? tPlural(
          '{count} marks were on pages that have been rotated since they were drawn.',
          rotated
        )
      : null
  ].filter((reason): reason is string => reason !== null);
  notify('warning', tPlural('{count} redaction marks were removed.', deleted + rotated), {
    detail: `${reasons.join(' ')} ${translate('Mark those areas again if they still need redacting.')}`,
    timeout: 0
  });
}

/**
 * RED-07 — which shape the pointer draws: a dragged rectangle or a traced
 * freehand outline. Not cleared on document change: it is a tool preference, not
 * a mark, and resetting it under the user mid-document would be surprising.
 */
export const redactShapeMode = signal<'rect' | 'polygon'>('rect');

/**
 * RED-05's proposals. Deliberately a separate signal from `pendingRedactions`:
 * nothing in this list is marked for removal, and the only way into that list is
 * a click on Accept. Tied to pages exactly as the marks are (H1).
 */
export const patternSuggestions = signal<PendingSuggestion[]>([]);

/** True once a scan has run, so "nothing found" can be told apart from "not scanned". */
export const patternScanRan = signal(false);

/**
 * Verification result, held so RED-03's report survives closing the dialog.
 * AUDIT-2026-10-10 L2 — without the redacted bytes: the report only needs the
 * verdicts, and holding `bytes` kept a whole extra copy of the document alive
 * for as long as the panel's last report was.
 */
export type RedactionReport = Omit<RedactionOutcome, 'bytes'>;
export const redactionReport = signal<RedactionReport | null>(null);

/** L2 — the outcome minus its bytes, for {@link redactionReport}. */
export function reportOf(outcome: RedactionOutcome): RedactionReport {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { bytes, ...report } = outcome;
  return report;
}

/** Clears every redaction-in-progress signal — shared by the doc-switch effect below and Organize's "discard all changes." */
export function resetRedactionState(): void {
  pendingRedactions.value = [];
  redactionReport.value = null;
  patternSuggestions.value = [];
  patternScanRan.value = false;
}

// Marks and suggestions belong to one document's pages. On a document switch
// they are cleared (their keys mean nothing in another document — and before
// H1, their raw indices would have targeted the other document's pages).
// Within one document, every page edit — delete, move, duplicate, reorder,
// undo, rotate — re-resolves them by page key, so a mark follows its page and
// one whose page is gone or rotated is withdrawn out loud.
let marksDocId: string | null | undefined;
effect(() => {
  const docId = activeDocId.value;
  const pages = activeDoc.value?.pages;
  if (docId !== marksDocId) {
    marksDocId = docId;
    resetRedactionState();
    return;
  }
  if (!pages) return;
  const marks = resolveRedactionMarks(pendingRedactions.peek(), pages);
  if (marks.changed) pendingRedactions.value = marks.kept;
  // A suggestion is only a proposal: one whose page went is simply dropped.
  const suggestions = resolveRedactionMarks(patternSuggestions.peek(), pages);
  if (suggestions.changed) {
    // Its regions carry an index too, and Accept turns them into marks.
    patternSuggestions.value = suggestions.kept.map(suggestion => ({
      ...suggestion,
      regions: suggestion.regions.map(region => ({ ...region, pageIndex: suggestion.pageIndex }))
    }));
  }
  notifyWithdrawnMarks(marks.deleted, marks.rotated);
});
