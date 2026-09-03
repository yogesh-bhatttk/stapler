/**
 * CNV-08/10/12 — the panel state the three conversions *out of* the open PDF
 * share.
 *
 * All three hold the same five things (the options, the produced file, which
 * document it came from, the revision it was read at, and the gate that keeps
 * the action bar's Save disabled until a preview exists) and decide staleness by
 * the same rule. They were three near-verbatim copies of it; a fix to any one of
 * them was two more edits nobody was reminded to make. Each tool's module is now
 * one call to {@link createPdfSourceState} plus its own names, so a panel's
 * imports are unchanged.
 *
 * **Why the produced file is held here** rather than a "has previewed" flag:
 * that is what makes the preview honest. The bytes the action bar writes are the
 * exact bytes the preview was rendered from, so the two cannot describe
 * different documents.
 *
 * **Why staleness keys on `historyVersion` and not the document id alone.**
 * Deleting a page, rotating one, cropping or annotating leaves the id unchanged,
 * so a preview taken before the edit still matched its document afterwards and
 * the Save button stayed unlocked over pre-edit bytes — silently writing a file
 * describing a document that no longer exists. `history.ts` already increments
 * `historyVersion` on every `commit()` (which every store mutator calls before
 * mutating) and on undo, redo and a wholesale workspace replacement, and
 * `AppShell`/`HistoryPanel` already read it as *the* "something changed" signal
 * — so it is the signal to gate on rather than a new counter that could drift
 * from it.
 *
 * **Why the gate is an `effect` and not a line in `setPreview`.** It used to be
 * set only where a preview was installed, which left the recomputation to the
 * panel's own `useEffect`: edit the document from another tool, come back, and
 * the Save button rendered *enabled* over a stale preview until that effect ran.
 * The handler in `commit.ts` still refused — nothing was ever written — but a
 * button that offers an action it will refuse is the gate lying about its own
 * state. Reading the signals inside an `effect` here subscribes the gate itself
 * to `historyVersion` and to the active document, so it closes at the moment of
 * the edit whether or not the panel exists.
 */
import { effect, signal, untracked, type Signal } from '@preact/signals';
import { activeDocId } from '../../../core/store';
import { historyVersion } from '../../../core/history';
import type { ToolId } from '../../../core/tools';
import { setCommitGate } from '../commit-gate';

/** One tool's slice of state. Every field is re-exported under the tool's own name. */
export interface PdfSourceState<Options, Result> {
  options: Signal<Options>;
  /** The finished conversion, or null when nothing has been previewed yet. */
  preview: Signal<Result | null>;
  /** The document the preview belongs to, so another document's result is never saved. */
  previewDocId: Signal<string | null>;
  /**
   * The `historyVersion` the conversion's *input bytes* were read at.
   *
   * Recorded from *before* the bytes are read, not from when the result comes
   * back: an edit made while the conversion is still running has to invalidate
   * it too, and that edit's increment lands between the two.
   */
  previewRevision: Signal<number | null>;
  setPreview(result: Result | null, docId: string | null, revision?: number | null): void;
  /**
   * Drops the preview. Called when the options change and when the document
   * does: a file built with images is not what a user who has just switched
   * images off is looking at, and a preview of a different document is worse.
   */
  resetPreview(): void;
  /**
   * True when the held bytes no longer describe the document as it stands — a
   * different document, or the same one edited since. Read by the panel (to
   * close the gate) and by `commit.ts`'s handler, which refuses again
   * regardless, because a disabled button is a courtesy and the handler's check
   * is the guarantee.
   *
   * A missing revision counts as stale: the only way one is absent while a
   * preview is held is a caller that did not record it, and refusing to save is
   * the safe side of that mistake.
   */
  isStale(docId: string | null): boolean;
}

export function createPdfSourceState<Options, Result>(
  tool: ToolId,
  gate: string,
  defaultOptions: Options
): PdfSourceState<Options, Result> {
  const options = signal<Options>(defaultOptions);
  const preview = signal<Result | null>(null);
  const previewDocId = signal<string | null>(null);
  const previewRevision = signal<number | null>(null);

  const setPreview = (
    result: Result | null,
    docId: string | null,
    revision: number | null = null
  ): void => {
    preview.value = result;
    previewDocId.value = result ? docId : null;
    previewRevision.value = result ? revision : null;
  };

  const isStale = (docId: string | null): boolean => {
    if (preview.value === null) return true;
    if (previewDocId.value !== docId) return true;
    return previewRevision.value !== historyVersion.value;
  };

  // Reads `preview`, `previewDocId`, `previewRevision`, `historyVersion` and
  // `activeDocId`, and so re-runs when any of them changes — including an edit
  // made in another tool with this panel unmounted. `setCommitGate` ignores a
  // repeat of the value it already holds, so this settles immediately.
  effect(() => {
    const closed = isStale(activeDocId.value);
    // `untracked`, because `setCommitGate` *reads* the gate map to decide
    // whether anything changed. Subscribing to that read would make this effect
    // re-run on any other tool's gate change — and, worse, re-run on its own
    // write, so a deliberate `setCommitGate` from elsewhere could never stand.
    untracked(() => setCommitGate(tool, closed ? gate : null));
  });

  return {
    options,
    preview,
    previewDocId,
    previewRevision,
    setPreview,
    // Defined as a plain function, not a method: every tool module re-exports
    // these as bare functions, and a `this`-dependent one would break there.
    resetPreview: () => setPreview(null, null, null),
    isStale
  };
}
