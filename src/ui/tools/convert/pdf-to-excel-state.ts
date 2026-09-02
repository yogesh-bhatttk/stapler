/**
 * CNV-10's own panel state, on CNV-08's shape.
 *
 * The produced `.xlsx` is held here, not just a "has previewed" flag. That is what
 * makes the preview honest: the bytes the action bar writes are the exact bytes
 * the preview was rendered from, so the two cannot describe different workbooks.
 *
 * The staleness rule is CNV-08's, adopted from the start rather than as a
 * follow-up fix. Its audit found that keying on the active document's *id* alone
 * left a preview valid across an edit — deleting a page, rotating one, cropping —
 * because none of those change the id. `historyVersion` is the counter every
 * store mutator already bumps through `commit()`, and that `AppShell` and
 * `HistoryPanel` already read as *the* "something changed" signal, so it is the
 * signal to gate on rather than a new one that could drift from it.
 */
import { signal } from '@preact/signals';
import type { PdfToXlsxOptions, PdfToXlsxResult } from '../../../core/operations';
import { historyVersion } from '../../../core/history';
import { setCommitGate } from '../commit-gate';

export const PDF_TO_EXCEL_GATE =
  'Preview the conversion first — table detection is a guess, so check the sheets before saving.';

export const pdfToExcelOptions = signal<PdfToXlsxOptions>({ includePageText: true });

/** The finished conversion, or null when nothing has been previewed yet. */
export const pdfToExcelPreview = signal<PdfToXlsxResult | null>(null);

/** The document the preview belongs to, so another document's result is never saved. */
export const pdfToExcelPreviewDocId = signal<string | null>(null);

/**
 * The `historyVersion` the conversion's *input bytes* were read at.
 *
 * Recorded from *before* the input bytes are read, not from when the result comes
 * back: an edit made while the conversion is still running has to invalidate it
 * too, and that edit's increment lands between the two.
 */
export const pdfToExcelPreviewRevision = signal<number | null>(null);

export function setPdfToExcelPreview(
  result: PdfToXlsxResult | null,
  docId: string | null,
  revision: number | null = null
): void {
  pdfToExcelPreview.value = result;
  pdfToExcelPreviewDocId.value = result ? docId : null;
  pdfToExcelPreviewRevision.value = result ? revision : null;
  setCommitGate('pdf-to-excel', result ? null : PDF_TO_EXCEL_GATE);
}

/**
 * Drops the preview. Called when the options change and when the document does:
 * a workbook built with page-text sheets is not the file a user who has just
 * switched them off is looking at, and a preview of a different document is worse
 * still.
 */
export function resetPdfToExcelPreview(): void {
  setPdfToExcelPreview(null, null, null);
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
export function pdfToExcelPreviewIsStale(docId: string | null): boolean {
  if (pdfToExcelPreview.value === null) return true;
  if (pdfToExcelPreviewDocId.value !== docId) return true;
  return pdfToExcelPreviewRevision.value !== historyVersion.value;
}

/** The gate starts closed, before the panel has ever mounted. */
setCommitGate('pdf-to-excel', PDF_TO_EXCEL_GATE);
