/**
 * CNV-13's own panel state.
 *
 * Named for its tool rather than sitting in a shared `convert/state.ts`, the same
 * way its five siblings in this directory are: a file called `state.ts` in a
 * directory holding six tools would not say whose state it holds.
 *
 * The shape, the input-revision staleness rule and the two gate states are
 * `office-source-state.ts`'s, shared verbatim with CNV-09 and CNV-11 — including
 * why the produced PDF is held here rather than a "has previewed" flag, and why
 * this family cannot gate on `historyVersion` the way the PDF-source family
 * does. What is this tool's own is its two gate sentences and its default page
 * size.
 */
import type { PptxToPdfOptions, PptxToPdfResult } from '../../../core/operations';
import { createOfficeSourceState } from './office-source-state';

export const PPT_TO_PDF_GATE =
  'Preview the conversion first — this is a beta converter, so check the result before saving.';

export const PPT_TO_PDF_NO_FILE_GATE = 'Choose a .pptx file to convert first.';

const state = createOfficeSourceState<PptxToPdfOptions, PptxToPdfResult>(
  'ppt-to-pdf',
  { preview: PPT_TO_PDF_GATE, noFile: PPT_TO_PDF_NO_FILE_GATE },
  { pageSize: 'slide' }
);

export const pptToPdfOptions = state.options;
export const pptToPdfSource = state.source;
export const pptToPdfInputRevision = state.inputRevision;
export const pptToPdfPreview = state.preview;
export const pptToPdfPreviewSource = state.previewSource;
export const pptToPdfPreviewRevision = state.previewRevision;
export const setPptToPdfSource = state.setSource;
export const setPptToPdfOptions = state.setOptions;
export const setPptToPdfPreview = state.setPreview;
export const resetPptToPdfPreview = state.resetPreview;
export const pptToPdfPreviewIsStale = state.isStale;
