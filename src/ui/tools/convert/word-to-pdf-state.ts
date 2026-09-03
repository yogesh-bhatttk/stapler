/**
 * CNV-09's own panel state.
 *
 * Named for its tool rather than sitting in a shared `convert/state.ts`, the same
 * way its five siblings in this directory are: a file called `state.ts` in a
 * directory holding six tools would not say whose state it holds.
 *
 * The shape, the input-revision staleness rule and the two gate states are
 * `office-source-state.ts`'s, shared verbatim with CNV-11 and CNV-13 — including
 * why the produced PDF is held here rather than a "has previewed" flag, and why
 * this family cannot gate on `historyVersion` the way the PDF-source family
 * does. What is this tool's own is its two gate sentences and its default page
 * size.
 */
import type { DocxToPdfOptions, DocxToPdfResult } from '../../../core/operations';
import { createOfficeSourceState } from './office-source-state';

export const WORD_TO_PDF_GATE =
  'Preview the conversion first — this is a beta converter, so check the result before saving.';

export const WORD_TO_PDF_NO_FILE_GATE = 'Choose a .docx file to convert first.';

const state = createOfficeSourceState<DocxToPdfOptions, DocxToPdfResult>(
  'word-to-pdf',
  { preview: WORD_TO_PDF_GATE, noFile: WORD_TO_PDF_NO_FILE_GATE },
  { pageSize: 'a4' }
);

export const wordToPdfOptions = state.options;
export const wordToPdfSource = state.source;
export const wordToPdfInputRevision = state.inputRevision;
export const wordToPdfPreview = state.preview;
export const wordToPdfPreviewSource = state.previewSource;
export const wordToPdfPreviewRevision = state.previewRevision;
export const setWordToPdfSource = state.setSource;
export const setWordToPdfOptions = state.setOptions;
export const setWordToPdfPreview = state.setPreview;
export const resetWordToPdfPreview = state.resetPreview;
export const wordToPdfPreviewIsStale = state.isStale;
