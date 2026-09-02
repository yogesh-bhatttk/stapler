/**
 * CNV-11's own panel state.
 *
 * Named for its tool rather than sitting in a shared `convert/state.ts`, the same
 * way its four siblings in this directory are: a file called `state.ts` in a
 * directory holding five tools would not say whose state it holds.
 *
 * The produced PDF is held here, not just a "has previewed" flag — the same
 * guarantee CNV-08 makes. The bytes the action bar writes are the exact bytes the
 * preview was rendered from, so the two cannot describe different documents.
 *
 * **Which staleness rule this uses, and why.** CNV-08 and CNV-10 convert the
 * *open document*, so their checks key on the document id plus `history.ts`'s
 * `historyVersion`, because editing a page leaves the id unchanged. This tool's
 * input is an `.xlsx` picked from disk — the workspace document is not its input
 * at all, so `historyVersion` says nothing about whether the preview is still
 * valid and gating on it would re-close the gate on an unrelated edit. The
 * equivalent here is CNV-09's *input revision*: a counter every change to the
 * chosen file or to an option bumps, checked alongside the `File` object's own
 * identity rather than instead of it, because re-picking a different file that
 * happens to have the same name would otherwise look unchanged.
 */
import { signal } from '@preact/signals';
import type { XlsxToPdfOptions, XlsxToPdfResult } from '../../../core/operations';
import { setCommitGate } from '../commit-gate';

export const EXCEL_TO_PDF_GATE =
  'Preview the conversion first — this is a beta converter, so check the result before saving.';

export const EXCEL_TO_PDF_NO_FILE_GATE = 'Choose an .xlsx file to convert first.';

export const excelToPdfOptions = signal<XlsxToPdfOptions>({ pageSize: 'a4' });

/** The chosen `.xlsx`, held as the `File` so the bytes are read at convert time. */
export const excelToPdfSource = signal<File | null>(null);

/**
 * Bumped by every change to the input: a different file, or a different option.
 *
 * Captured *before* the file's bytes are read, not when the result comes back, so
 * a change made while the conversion is still running invalidates it too — the
 * same ordering CNV-08's second audit pass established for `historyVersion`.
 */
export const excelToPdfInputRevision = signal(0);

/** The finished conversion, or null when nothing has been previewed yet. */
export const excelToPdfPreview = signal<XlsxToPdfResult | null>(null);

/** The exact `File` the held bytes were converted from. */
export const excelToPdfPreviewSource = signal<File | null>(null);

/** The input revision the conversion's *input bytes* were read at. */
export const excelToPdfPreviewRevision = signal<number | null>(null);

function refreshGate(): void {
  if (excelToPdfPreview.value !== null && !excelToPdfPreviewIsStale()) {
    setCommitGate('excel-to-pdf', null);
    return;
  }
  setCommitGate(
    'excel-to-pdf',
    excelToPdfSource.value ? EXCEL_TO_PDF_GATE : EXCEL_TO_PDF_NO_FILE_GATE
  );
}

/** Chooses (or clears) the source file. Always throws any preview away. */
export function setExcelToPdfSource(file: File | null): void {
  excelToPdfSource.value = file;
  excelToPdfInputRevision.value += 1;
  excelToPdfPreview.value = null;
  excelToPdfPreviewSource.value = null;
  excelToPdfPreviewRevision.value = null;
  refreshGate();
}

/**
 * Changes an option. The previewed PDF was laid out the other way round, so it is
 * no longer what this panel is describing.
 */
export function setExcelToPdfOptions(options: XlsxToPdfOptions): void {
  excelToPdfOptions.value = options;
  excelToPdfInputRevision.value += 1;
  excelToPdfPreview.value = null;
  excelToPdfPreviewSource.value = null;
  excelToPdfPreviewRevision.value = null;
  refreshGate();
}

export function setExcelToPdfPreview(
  result: XlsxToPdfResult | null,
  file: File | null,
  revision: number | null = null
): void {
  excelToPdfPreview.value = result;
  excelToPdfPreviewSource.value = result ? file : null;
  excelToPdfPreviewRevision.value = result ? revision : null;
  refreshGate();
}

/** Drops the preview without touching the chosen file. */
export function resetExcelToPdfPreview(): void {
  setExcelToPdfPreview(null, null, null);
}

/**
 * True when the held bytes no longer describe the input as it stands — no file,
 * a different file, or the same file with an option changed since. Read by the
 * panel (to close the gate) and by `commit.ts`'s handler, which refuses again
 * regardless, because a disabled button is a courtesy and the handler's check is
 * the guarantee.
 *
 * A missing revision counts as stale: the only way one is absent while a preview
 * is held is a caller that did not record it, and refusing to save is the safe
 * side of that mistake.
 */
export function excelToPdfPreviewIsStale(): boolean {
  if (excelToPdfPreview.value === null) return true;
  if (excelToPdfSource.value === null) return true;
  if (excelToPdfPreviewSource.value !== excelToPdfSource.value) return true;
  return excelToPdfPreviewRevision.value !== excelToPdfInputRevision.value;
}

/** The gate starts closed, before the panel has ever mounted. */
setCommitGate('excel-to-pdf', EXCEL_TO_PDF_NO_FILE_GATE);
