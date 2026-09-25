/**
 * Tool state that describes one document must not outlive it.
 *
 * Tool results live in module-level signals so the panel and the action bar can
 * both reach them — which also means they survive a tab switch or an edit and
 * get applied to the wrong document: doc A's extracted table exported under
 * doc B's name, doc A's compression projection shown for doc B, "Sign here"
 * buttons at doc A's coordinates on doc B (AUDIT-2026-09-25 M3: UI-3, UI-11,
 * UI-12). `redact/state.ts` and `metadata/state.ts` already reset on change;
 * this is the same rule as one helper, so a new tool state module can't forget.
 */
import { effect, untracked } from '@preact/signals';
import { activeDoc } from '../../core/store';

/**
 * Runs `reset` whenever the active document changes, and — with
 * `{ onPageEdits: true }`, for state keyed by page index or computed from page
 * content — whenever its page list changes too (reorder, rotate, delete,
 * insert). Returns the effect's disposer.
 */
export function resetOnDocumentChange(
  reset: () => void,
  { onPageEdits = false }: { onPageEdits?: boolean } = {}
): () => void {
  // `activeDoc` is a new object on *every* edit — the dirty flag, an
  // annotation, a rename — so the effect re-runs far more often than the
  // document or its pages change. Compare, or state set right after an export
  // (Compress's target outcome) would be wiped by the save's own dirty-flag write.
  let first = true;
  let lastId: string | undefined;
  let lastPages: unknown;
  return effect(() => {
    const id = activeDoc.value?.id;
    const pages = onPageEdits ? activeDoc.value?.pages : undefined;
    if (!first && id === lastId && pages === lastPages) return;
    first = false;
    lastId = id;
    lastPages = pages;
    untracked(reset);
  });
}
