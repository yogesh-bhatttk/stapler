/**
 * CNV-12's own panel state, on CNV-08's and CNV-10's shape.
 *
 * The produced `.pptx` is held here, not just a "has previewed" flag. That is
 * what makes the preview honest: the bytes the action bar writes are the exact
 * bytes the preview was rendered from, so the two cannot describe different
 * decks.
 *
 * The staleness rule is `historyVersion`-based from the start, not as a
 * follow-up fix. CNV-08's audit found that keying on the active document's *id*
 * alone left a preview valid across an edit — deleting a page, rotating one,
 * cropping — because none of those change the id, and the save button then wrote
 * a file describing a document that no longer existed. `historyVersion` is the
 * counter every store mutator already bumps through `commit()`, and that
 * `AppShell` and `HistoryPanel` already read as *the* "something changed"
 * signal, so it is the signal to gate on rather than a new one that could drift
 * from it.
 *
 * The gate matters more for this tool than for any of its four siblings. Every
 * box on every slide is a *measurement* of the source page reinterpreted through
 * PowerPoint's own text metrics, so the deck is an approximation by construction
 * — which is exactly the case PLAN §5.5's mandatory preview exists for.
 */
import { signal } from '@preact/signals';
import type { PdfToPptxOptions, PdfToPptxResult } from '../../../core/operations';
import { historyVersion } from '../../../core/history';
import { setCommitGate } from '../commit-gate';

export const PDF_TO_PPT_GATE =
  'Preview the conversion first — this converter approximates the page layout, so check the ' +
  'slides before saving.';

export const pdfToPptOptions = signal<PdfToPptxOptions>({
  includeText: true,
  includeImages: true
});

/** The finished conversion, or null when nothing has been previewed yet. */
export const pdfToPptPreview = signal<PdfToPptxResult | null>(null);

/** The document the preview belongs to, so another document's result is never saved. */
export const pdfToPptPreviewDocId = signal<string | null>(null);

/**
 * The `historyVersion` the conversion's *input bytes* were read at.
 *
 * Recorded from *before* the input bytes are read, not from when the result
 * comes back: an edit made while the conversion is still running has to
 * invalidate it too, and that edit's increment lands between the two.
 */
export const pdfToPptPreviewRevision = signal<number | null>(null);

export function setPdfToPptPreview(
  result: PdfToPptxResult | null,
  docId: string | null,
  revision: number | null = null
): void {
  pdfToPptPreview.value = result;
  pdfToPptPreviewDocId.value = result ? docId : null;
  pdfToPptPreviewRevision.value = result ? revision : null;
  setCommitGate('pdf-to-ppt', result ? null : PDF_TO_PPT_GATE);
}

/**
 * Drops the preview. Called when the options change and when the document does:
 * a deck built with the page images placed is not the file a user who has just
 * switched images off is looking at, and a preview of a different document is
 * worse still.
 */
export function resetPdfToPptPreview(): void {
  setPdfToPptPreview(null, null, null);
}

/**
 * True when the held bytes no longer describe the document as it stands — a
 * different document, or the same one edited since. Read by the panel (to close
 * the gate) and by `commit.ts`'s handler (which refuses again regardless,
 * because a disabled button is a courtesy and the handler's check is the
 * guarantee).
 *
 * A missing revision counts as stale: the only way one is absent while a preview
 * is held is a caller that did not record it, and refusing to save is the safe
 * side of that mistake.
 */
export function pdfToPptPreviewIsStale(docId: string | null): boolean {
  if (pdfToPptPreview.value === null) return true;
  if (pdfToPptPreviewDocId.value !== docId) return true;
  return pdfToPptPreviewRevision.value !== historyVersion.value;
}

/** The gate starts closed, before the panel has ever mounted. */
setCommitGate('pdf-to-ppt', PDF_TO_PPT_GATE);
