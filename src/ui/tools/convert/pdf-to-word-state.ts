/**
 * CNV-08's own panel state.
 *
 * Named for its tool rather than sitting in a shared `convert/state.ts`, the same
 * way OCR-03's `ocr/table-extract-state.ts` is: six tools now share the
 * `convert/` directory, and a file called `state.ts` in it would not say whose
 * state it holds.
 *
 * Everything below the gate text is `pdf-source-state.ts`'s — the shape and the
 * staleness rule this tool shares verbatim with CNV-10 and CNV-12, including why
 * the produced `.docx` is held here rather than a "has previewed" flag and why
 * the gate keys on `historyVersion` rather than the document id alone. What is
 * genuinely this tool's own is its gate sentence and its default options.
 */
import type { PdfToDocxOptions, PdfToDocxResult } from '../../../core/operations';
import { createPdfSourceState } from './pdf-source-state';

export const PDF_TO_WORD_GATE =
  'Preview the conversion first — this is a beta converter, so check the result before saving.';

const state = createPdfSourceState<PdfToDocxOptions, PdfToDocxResult>(
  'pdf-to-word',
  PDF_TO_WORD_GATE,
  { includeImages: true }
);

export const pdfToWordOptions = state.options;
export const pdfToWordPreview = state.preview;
export const pdfToWordPreviewDocId = state.previewDocId;
export const pdfToWordPreviewRevision = state.previewRevision;
export const setPdfToWordPreview = state.setPreview;
export const resetPdfToWordPreview = state.resetPreview;
export const pdfToWordPreviewIsStale = state.isStale;
