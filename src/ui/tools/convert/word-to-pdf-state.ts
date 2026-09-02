/**
 * CNV-09's own panel state.
 *
 * Named for its tool rather than sitting in a shared `convert/state.ts`, the same
 * way `pdf-to-word-state.ts` is: four tools now share the `convert/` directory,
 * and a file called `state.ts` in it would not say whose state it holds.
 *
 * The produced PDF is held here, not just a "has previewed" flag — the same
 * guarantee CNV-08 makes. The bytes the action bar writes are the exact bytes the
 * preview was rendered from, so the two cannot describe different documents.
 *
 * **Where this deliberately differs from CNV-08's gate.** That tool converts the
 * *open document*, so its staleness check keys on the document id plus
 * `history.ts`'s `historyVersion`, because editing a page leaves the id unchanged.
 * This tool's input is a `.docx` picked from disk; the workspace document is not
 * its input at all, so `historyVersion` says nothing about whether the preview is
 * still valid, and gating on it would re-close the gate on an unrelated edit. The
 * equivalent here is an *input revision*: a counter every change to the chosen
 * file or to an option bumps. It is the same shape of fix as CNV-08's — the
 * identity of the input is not enough on its own, because re-picking a different
 * file that happens to have the same name would otherwise look unchanged — and it
 * is checked alongside the `File` object's own identity rather than instead of it.
 */
import { signal } from '@preact/signals';
import type { DocxToPdfOptions, DocxToPdfResult } from '../../../core/operations';
import { setCommitGate } from '../commit-gate';

export const WORD_TO_PDF_GATE =
  'Preview the conversion first — this is a beta converter, so check the result before saving.';

export const WORD_TO_PDF_NO_FILE_GATE = 'Choose a .docx file to convert first.';

export const wordToPdfOptions = signal<DocxToPdfOptions>({ pageSize: 'a4' });

/** The chosen `.docx`, held as the `File` so the bytes are read at convert time. */
export const wordToPdfSource = signal<File | null>(null);

/**
 * Bumped by every change to the input: a different file, or a different option.
 *
 * Captured *before* the file's bytes are read, not when the result comes back, so
 * a change made while the conversion is still running invalidates it too — the
 * same ordering CNV-08's second audit pass established for `historyVersion`.
 */
export const wordToPdfInputRevision = signal(0);

/** The finished conversion, or null when nothing has been previewed yet. */
export const wordToPdfPreview = signal<DocxToPdfResult | null>(null);

/** The exact `File` the held bytes were converted from. */
export const wordToPdfPreviewSource = signal<File | null>(null);

/** The input revision the conversion's *input bytes* were read at. */
export const wordToPdfPreviewRevision = signal<number | null>(null);

function refreshGate(): void {
  if (wordToPdfPreview.value !== null && !wordToPdfPreviewIsStale()) {
    setCommitGate('word-to-pdf', null);
    return;
  }
  setCommitGate('word-to-pdf', wordToPdfSource.value ? WORD_TO_PDF_GATE : WORD_TO_PDF_NO_FILE_GATE);
}

/** Chooses (or clears) the source file. Always throws any preview away. */
export function setWordToPdfSource(file: File | null): void {
  wordToPdfSource.value = file;
  wordToPdfInputRevision.value += 1;
  wordToPdfPreview.value = null;
  wordToPdfPreviewSource.value = null;
  wordToPdfPreviewRevision.value = null;
  refreshGate();
}

/**
 * Changes an option. The previewed PDF was laid out the other way round, so it is
 * no longer what this panel is describing.
 */
export function setWordToPdfOptions(options: DocxToPdfOptions): void {
  wordToPdfOptions.value = options;
  wordToPdfInputRevision.value += 1;
  wordToPdfPreview.value = null;
  wordToPdfPreviewSource.value = null;
  wordToPdfPreviewRevision.value = null;
  refreshGate();
}

export function setWordToPdfPreview(
  result: DocxToPdfResult | null,
  file: File | null,
  revision: number | null = null
): void {
  wordToPdfPreview.value = result;
  wordToPdfPreviewSource.value = result ? file : null;
  wordToPdfPreviewRevision.value = result ? revision : null;
  refreshGate();
}

/** Drops the preview without touching the chosen file. */
export function resetWordToPdfPreview(): void {
  setWordToPdfPreview(null, null, null);
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
export function wordToPdfPreviewIsStale(): boolean {
  if (wordToPdfPreview.value === null) return true;
  if (wordToPdfSource.value === null) return true;
  if (wordToPdfPreviewSource.value !== wordToPdfSource.value) return true;
  return wordToPdfPreviewRevision.value !== wordToPdfInputRevision.value;
}

/** The gate starts closed, before the panel has ever mounted. */
setCommitGate('word-to-pdf', WORD_TO_PDF_NO_FILE_GATE);
