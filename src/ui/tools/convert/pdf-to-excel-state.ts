/**
 * CNV-10's own panel state, on CNV-08's shape.
 *
 * The shape, the staleness rule and the gate are `pdf-source-state.ts`'s, shared
 * verbatim with CNV-08 and CNV-12 — including why the produced `.xlsx` is held
 * here rather than a "has previewed" flag, and why staleness keys on
 * `historyVersion` and not on the document id alone.
 *
 * What is this tool's own is its gate sentence, which says what the reviewer is
 * being asked to check: every sheet in the output is the result of a guess about
 * where a table was.
 */
import type { PdfToXlsxOptions, PdfToXlsxResult } from '../../../core/operations';
import { createPdfSourceState } from './pdf-source-state';

export const PDF_TO_EXCEL_GATE =
  'Preview the conversion first — table detection is a guess, so check the sheets before saving.';

const state = createPdfSourceState<PdfToXlsxOptions, PdfToXlsxResult>(
  'pdf-to-excel',
  PDF_TO_EXCEL_GATE,
  { includePageText: true }
);

export const pdfToExcelOptions = state.options;
export const pdfToExcelPreview = state.preview;
export const pdfToExcelPreviewDocId = state.previewDocId;
export const pdfToExcelPreviewRevision = state.previewRevision;
export const setPdfToExcelPreview = state.setPreview;
export const resetPdfToExcelPreview = state.resetPreview;
export const pdfToExcelPreviewIsStale = state.isStale;
