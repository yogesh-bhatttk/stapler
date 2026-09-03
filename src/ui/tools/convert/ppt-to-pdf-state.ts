/**
 * CNV-13's own panel state.
 *
 * Named for its tool rather than sitting in a shared `convert/state.ts`, the same
 * way its five siblings in this directory are: a file called `state.ts` in a
 * directory holding six tools would not say whose state it holds.
 *
 * The produced PDF is held here, not just a "has previewed" flag — the same
 * guarantee CNV-08 makes. The bytes the action bar writes are the exact bytes the
 * preview was rendered from, so the two cannot describe different documents.
 *
 * **Which staleness rule this uses, and why.** CNV-08, CNV-10 and CNV-12 convert
 * the *open document*, so their checks key on the document id plus `history.ts`'s
 * `historyVersion`, because editing a page leaves the id unchanged. This tool's
 * input is a `.pptx` picked from disk — the workspace document is not its input
 * at all, so `historyVersion` says nothing about whether the preview is still
 * valid and gating on it would re-close the gate on an unrelated edit. The
 * equivalent here is CNV-09's and CNV-11's *input revision*: a counter every
 * change to the chosen file or to an option bumps, checked alongside the `File`
 * object's own identity rather than instead of it, because re-picking a
 * different file that happens to have the same name would otherwise look
 * unchanged.
 */
import { signal } from '@preact/signals';
import type { PptxToPdfOptions, PptxToPdfResult } from '../../../core/operations';
import { setCommitGate } from '../commit-gate';

export const PPT_TO_PDF_GATE =
  'Preview the conversion first — this is a beta converter, so check the result before saving.';

export const PPT_TO_PDF_NO_FILE_GATE = 'Choose a .pptx file to convert first.';

export const pptToPdfOptions = signal<PptxToPdfOptions>({ pageSize: 'slide' });

/** The chosen `.pptx`, held as the `File` so the bytes are read at convert time. */
export const pptToPdfSource = signal<File | null>(null);

/**
 * Bumped by every change to the input: a different file, or a different option.
 *
 * Captured *before* the file's bytes are read, not when the result comes back, so
 * a change made while the conversion is still running invalidates it too — the
 * same ordering CNV-08's second audit pass established for `historyVersion`.
 */
export const pptToPdfInputRevision = signal(0);

/** The finished conversion, or null when nothing has been previewed yet. */
export const pptToPdfPreview = signal<PptxToPdfResult | null>(null);

/** The exact `File` the held bytes were converted from. */
export const pptToPdfPreviewSource = signal<File | null>(null);

/** The input revision the conversion's *input bytes* were read at. */
export const pptToPdfPreviewRevision = signal<number | null>(null);

function refreshGate(): void {
  if (pptToPdfPreview.value !== null && !pptToPdfPreviewIsStale()) {
    setCommitGate('ppt-to-pdf', null);
    return;
  }
  setCommitGate('ppt-to-pdf', pptToPdfSource.value ? PPT_TO_PDF_GATE : PPT_TO_PDF_NO_FILE_GATE);
}

/** Chooses (or clears) the source file. Always throws any preview away. */
export function setPptToPdfSource(file: File | null): void {
  pptToPdfSource.value = file;
  pptToPdfInputRevision.value += 1;
  pptToPdfPreview.value = null;
  pptToPdfPreviewSource.value = null;
  pptToPdfPreviewRevision.value = null;
  refreshGate();
}

/**
 * Changes an option. The previewed PDF was laid out onto a different page, so it
 * is no longer what this panel is describing.
 */
export function setPptToPdfOptions(options: PptxToPdfOptions): void {
  pptToPdfOptions.value = options;
  pptToPdfInputRevision.value += 1;
  pptToPdfPreview.value = null;
  pptToPdfPreviewSource.value = null;
  pptToPdfPreviewRevision.value = null;
  refreshGate();
}

export function setPptToPdfPreview(
  result: PptxToPdfResult | null,
  file: File | null,
  revision: number | null = null
): void {
  pptToPdfPreview.value = result;
  pptToPdfPreviewSource.value = result ? file : null;
  pptToPdfPreviewRevision.value = result ? revision : null;
  refreshGate();
}

/** Drops the preview without touching the chosen file. */
export function resetPptToPdfPreview(): void {
  setPptToPdfPreview(null, null, null);
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
export function pptToPdfPreviewIsStale(): boolean {
  if (pptToPdfPreview.value === null) return true;
  if (pptToPdfSource.value === null) return true;
  if (pptToPdfPreviewSource.value !== pptToPdfSource.value) return true;
  return pptToPdfPreviewRevision.value !== pptToPdfInputRevision.value;
}

/** The gate starts closed, before the panel has ever mounted. */
setCommitGate('ppt-to-pdf', PPT_TO_PDF_NO_FILE_GATE);
