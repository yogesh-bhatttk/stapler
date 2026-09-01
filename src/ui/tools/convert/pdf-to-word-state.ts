/**
 * CNV-08's own panel state.
 *
 * Named for its tool rather than sitting in a shared `convert/state.ts`, the same
 * way OCR-03's `ocr/table-extract-state.ts` is: three tools already share the
 * `convert/` directory, and a file called `state.ts` in it would not say whose
 * state it holds.
 *
 * The produced `.docx` is held here, not just a "has previewed" flag. That is what
 * makes the preview honest: the bytes the action bar writes are the exact bytes
 * the preview was rendered from, so the two cannot describe different documents.
 */
import { signal } from '@preact/signals';
import type { PdfToDocxOptions, PdfToDocxResult } from '../../../core/operations';
import { historyVersion } from '../../../core/history';
import { setCommitGate } from '../commit-gate';

export const PDF_TO_WORD_GATE =
  'Preview the conversion first — this is a beta converter, so check the result before saving.';

export const pdfToWordOptions = signal<PdfToDocxOptions>({ includeImages: true });

/** The finished conversion, or null when nothing has been previewed yet. */
export const pdfToWordPreview = signal<PdfToDocxResult | null>(null);

/** The document the preview belongs to, so another document's result is never saved. */
export const pdfToWordPreviewDocId = signal<string | null>(null);

/**
 * The `historyVersion` the conversion's *input bytes* were read at.
 *
 * The document id alone is not enough. Deleting a page, rotating one, cropping,
 * or annotating leaves the id unchanged, so a preview taken before the edit still
 * matched its document afterwards and the save button stayed unlocked over
 * pre-edit bytes — silently writing a `.docx` of a document that no longer
 * exists. `history.ts` already increments `historyVersion` on every `commit()`
 * (which every store mutator calls before mutating) and on undo, redo and a
 * wholesale workspace replacement, and `AppShell`/`HistoryPanel` already read it
 * as *the* "something changed" signal — so it is the signal to gate on rather
 * than a new counter that could drift from it.
 *
 * Recorded from *before* the input bytes are read, not from when the result comes
 * back: an edit made while the conversion is still running has to invalidate it
 * too, and that edit's increment lands between the two.
 */
export const pdfToWordPreviewRevision = signal<number | null>(null);

export function setPdfToWordPreview(
  result: PdfToDocxResult | null,
  docId: string | null,
  revision: number | null = null
): void {
  pdfToWordPreview.value = result;
  pdfToWordPreviewDocId.value = result ? docId : null;
  pdfToWordPreviewRevision.value = result ? revision : null;
  setCommitGate('pdf-to-word', result ? null : PDF_TO_WORD_GATE);
}

/**
 * Drops the preview. Called when the options change and when the document does:
 * a `.docx` built with images is not the file a user who has just switched images
 * off is looking at, and a preview of a different document is worse still.
 */
export function resetPdfToWordPreview(): void {
  setPdfToWordPreview(null, null, null);
}

/**
 * True when the held bytes no longer describe the document as it stands — a
 * different document, or the same one edited since. Read by the panel (to close
 * the gate) and by `commit.ts`'s handler (which refuses again regardless, because
 * a disabled button is a courtesy and the handler's check is the guarantee).
 *
 * A missing revision counts as stale: the only way one is absent while a preview
 * is held is a caller that did not record it, and refusing to save is the safe
 * side of that mistake.
 */
export function pdfToWordPreviewIsStale(docId: string | null): boolean {
  if (pdfToWordPreview.value === null) return true;
  if (pdfToWordPreviewDocId.value !== docId) return true;
  return pdfToWordPreviewRevision.value !== historyVersion.value;
}

/** The gate starts closed, before the panel has ever mounted. */
setCommitGate('pdf-to-word', PDF_TO_WORD_GATE);
