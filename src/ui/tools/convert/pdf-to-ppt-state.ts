/**
 * CNV-12's own panel state, on CNV-08's and CNV-10's shape.
 *
 * The shape, the staleness rule and the gate are `pdf-source-state.ts`'s, shared
 * verbatim with its two siblings — including why the produced `.pptx` is held
 * here rather than a "has previewed" flag, and why staleness keys on
 * `historyVersion` and not on the document id alone.
 *
 * The gate matters more for this tool than for either of them. Every box on
 * every slide is a *measurement* of the source page reinterpreted through
 * PowerPoint's own text metrics, so the deck is an approximation by construction
 * — which is exactly the case PLAN §5.5's mandatory preview exists for, and what
 * this tool's own gate sentence says.
 */
import type { PdfToPptxOptions, PdfToPptxResult } from '../../../core/operations';
import { createPdfSourceState } from './pdf-source-state';

export const PDF_TO_PPT_GATE =
  'Preview the conversion first — this converter approximates the page layout, so check the ' +
  'slides before saving.';

const state = createPdfSourceState<PdfToPptxOptions, PdfToPptxResult>(
  'pdf-to-ppt',
  PDF_TO_PPT_GATE,
  { includeText: true, includeImages: true }
);

export const pdfToPptOptions = state.options;
export const pdfToPptPreview = state.preview;
export const pdfToPptPreviewDocId = state.previewDocId;
export const pdfToPptPreviewRevision = state.previewRevision;
export const setPdfToPptPreview = state.setPreview;
export const resetPdfToPptPreview = state.resetPreview;
export const pdfToPptPreviewIsStale = state.isStale;
