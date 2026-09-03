/**
 * CNV-11's own panel state.
 *
 * Named for its tool rather than sitting in a shared `convert/state.ts`, the same
 * way its five siblings in this directory are: a file called `state.ts` in a
 * directory holding six tools would not say whose state it holds.
 *
 * The shape, the input-revision staleness rule and the two gate states are
 * `office-source-state.ts`'s, shared verbatim with CNV-09 and CNV-13 — including
 * why the produced PDF is held here rather than a "has previewed" flag, and why
 * this family cannot gate on `historyVersion` the way the PDF-source family
 * does. What is this tool's own is its two gate sentences and its default page
 * size.
 */
import type { XlsxToPdfOptions, XlsxToPdfResult } from '../../../core/operations';
import { createOfficeSourceState } from './office-source-state';

export const EXCEL_TO_PDF_GATE =
  'Preview the conversion first — this is a beta converter, so check the result before saving.';

export const EXCEL_TO_PDF_NO_FILE_GATE = 'Choose an .xlsx file to convert first.';

const state = createOfficeSourceState<XlsxToPdfOptions, XlsxToPdfResult>(
  'excel-to-pdf',
  { preview: EXCEL_TO_PDF_GATE, noFile: EXCEL_TO_PDF_NO_FILE_GATE },
  { pageSize: 'a4' }
);

export const excelToPdfOptions = state.options;
export const excelToPdfSource = state.source;
export const excelToPdfInputRevision = state.inputRevision;
export const excelToPdfPreview = state.preview;
export const excelToPdfPreviewSource = state.previewSource;
export const excelToPdfPreviewRevision = state.previewRevision;
export const setExcelToPdfSource = state.setSource;
export const setExcelToPdfOptions = state.setOptions;
export const setExcelToPdfPreview = state.setPreview;
export const resetExcelToPdfPreview = state.resetPreview;
export const excelToPdfPreviewIsStale = state.isStale;
