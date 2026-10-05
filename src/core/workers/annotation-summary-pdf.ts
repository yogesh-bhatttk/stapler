/**
 * ANN-04 / HRD-24 §12.11 — the annotation summary's PDF build, mixed into the
 * process worker (`process.worker.ts` spreads {@link annotationSummaryApi}).
 *
 * pdf-lib layout, three font embeds and `save()` are exactly the "heavy work"
 * CLAUDE.md keeps off the main thread; this used to run there, yielding every
 * 30 ms to stay responsive. It now runs here under the worker job protocol:
 * determinate progress (layout 0–0.85, writing 0.85–1) and cooperative
 * cancellation through the caller's `JobHandle`, checked at most once per
 * {@link SLICE_MS} of card layout so a long list does not pay a Comlink round
 * trip per card.
 */
import * as Comlink from 'comlink';
import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib';
import { sanitizeWinAnsiText } from '../markdown-to-pdf';
import {
  SUMMARY_TITLE_RGB,
  SUMMARY_MUTED_RGB,
  SUMMARY_LINE_RGB,
  SUMMARY_CARD_BG_RGB,
  SUMMARY_CARD_BORDER_RGB,
  SUMMARY_ACCENT_RGB,
  SUMMARY_HEADER_RGB,
  SUMMARY_TEXT_RGB
} from '../doc-colors';
import { translate } from '../i18n';
import {
  formatPageNumber,
  getPositionString,
  getTypeLabel,
  sortAnnotations,
  type SummaryAnnotation
} from '../annotation-summary-shared';
import { checkpoint, type JobHandle } from './protocol';

/** The document facts the summary needs — structured-clonable, unlike a `StaplerDoc`. */
export interface AnnotationSummaryInput {
  name: string;
  /** The document's page keys in order, to number notes that carry a `pageKey`. */
  pageKeys: string[];
}

export interface AnnotationSummaryJob {
  /** ANN-04 — the printable summary PDF. Throws `UserCancelled` on cancel. */
  buildAnnotationSummary(
    input: AnnotationSummaryInput,
    annotations: SummaryAnnotation[],
    job?: JobHandle
  ): Promise<Uint8Array>;
}

/** How long card layout runs between cancellation/progress checks. */
const SLICE_MS = 30;

function wordWrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    const width = font.widthOfTextAtSize(testLine, size);
    if (width > maxWidth && currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines.length > 0 ? lines : [''];
}

async function buildAnnotationSummaryPdf(
  input: AnnotationSummaryInput,
  annotations: SummaryAnnotation[],
  job?: JobHandle
): Promise<Uint8Array> {
  const check = (fraction: number, label: string) => checkpoint(job, fraction, label);
  await check(0, translate('Laying out the annotation summary'));
  const pdfDoc = await PDFDocument.create();
  const fontNormal = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontOblique = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

  const PAGE_WIDTH = 595.28; // A4 width
  const PAGE_HEIGHT = 841.89; // A4 height
  const MARGIN = 50;
  const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

  const docName = input.name || 'Document';
  const pages = input.pageKeys.map(key => ({ key }));

  const sorted = sortAnnotations(annotations, pages);

  let currentPage = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let currentY = PAGE_HEIGHT - MARGIN;

  // Header
  currentPage.drawText('Annotation Summary', {
    x: MARGIN,
    y: currentY,
    size: 20,
    font: fontBold,
    color: rgb(...SUMMARY_TITLE_RGB)
  });
  currentY -= 22;

  const docNameSanitized = sanitizeWinAnsiText(docName);
  currentPage.drawText(`Document: ${docNameSanitized}  |  Total Notes: ${sorted.length}`, {
    x: MARGIN,
    y: currentY,
    size: 11,
    font: fontNormal,
    color: rgb(...SUMMARY_MUTED_RGB)
  });
  currentY -= 15;

  currentPage.drawLine({
    start: { x: MARGIN, y: currentY },
    end: { x: PAGE_WIDTH - MARGIN, y: currentY },
    thickness: 1,
    color: rgb(...SUMMARY_LINE_RGB)
  });
  currentY -= 20;

  if (sorted.length === 0) {
    currentPage.drawText('No annotations found in this document.', {
      x: MARGIN,
      y: currentY,
      size: 12,
      font: fontOblique,
      color: rgb(...SUMMARY_MUTED_RGB)
    });
  } else {
    let sliceStart = performance.now();
    for (let i = 0; i < sorted.length; i++) {
      if (performance.now() - sliceStart >= SLICE_MS) {
        sliceStart = performance.now();
        await check(
          0.85 * (i / sorted.length),
          translate('Laying out note {n} of {total}', { n: i + 1, total: sorted.length })
        );
      }
      const ann = sorted[i];
      const pageNum = formatPageNumber(ann, pages);
      const typeLabel = getTypeLabel(ann.type);
      const posStr = getPositionString(ann);
      const author = ann.author || 'Anonymous';
      const date = ann.date || 'N/A';
      const rawText = ann.text || ann.data || '(No text content)';
      const textClean = sanitizeWinAnsiText(rawText);

      let textLines = wordWrap(textClean, fontNormal, 10, CONTENT_WIDTH - 20);

      // Card height calculation: header (16) + meta (14) + textLines * 13 + padding (20)
      let cardHeight = 30 + textLines.length * 13 + 16;

      // A single annotation's text long enough that its card is taller than
      // one whole fresh page can hold would otherwise draw past the bottom
      // margin no matter which page it starts on — a card's background is
      // one rectangle, so (unlike a table row) there is no reasonable way to
      // split it across pages. Truncate the text instead, with a visible
      // note, rather than silently overflow it off the page.
      const maxCardHeight = PAGE_HEIGHT - MARGIN * 2 - 20;
      if (cardHeight > maxCardHeight) {
        const maxLines = Math.max(1, Math.floor((maxCardHeight - 30 - 16) / 13) - 1);
        const omitted = textLines.length - maxLines;
        textLines = [
          ...textLines.slice(0, maxLines),
          sanitizeWinAnsiText(`… (${omitted} more line${omitted === 1 ? '' : 's'} not shown)`)
        ];
        cardHeight = 30 + textLines.length * 13 + 16;
      }

      if (currentY - cardHeight < MARGIN + 20) {
        currentPage = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
        currentY = PAGE_HEIGHT - MARGIN;
      }

      const cardY = currentY - cardHeight;

      // Draw background card
      currentPage.drawRectangle({
        x: MARGIN,
        y: cardY,
        width: CONTENT_WIDTH,
        height: cardHeight,
        color: rgb(...SUMMARY_CARD_BG_RGB),
        borderColor: rgb(...SUMMARY_CARD_BORDER_RGB),
        borderWidth: 1
      });

      // Left accent bar
      currentPage.drawRectangle({
        x: MARGIN,
        y: cardY,
        width: 4,
        height: cardHeight,
        color: rgb(...SUMMARY_ACCENT_RGB)
      });

      // Card Header
      const headerText = sanitizeWinAnsiText(`Note #${i + 1}  •  ${typeLabel}`);
      currentPage.drawText(headerText, {
        x: MARGIN + 14,
        y: currentY - 18,
        size: 11,
        font: fontBold,
        color: rgb(...SUMMARY_HEADER_RGB)
      });

      // Meta Line
      const metaText = sanitizeWinAnsiText(
        `Page: ${pageNum}   |   Author: ${author}   |   Date: ${date}   |   Position: ${posStr}`
      );
      currentPage.drawText(metaText, {
        x: MARGIN + 14,
        y: currentY - 32,
        size: 9,
        font: fontOblique,
        color: rgb(...SUMMARY_MUTED_RGB)
      });

      // Text Content
      let textY = currentY - 48;
      for (const line of textLines) {
        currentPage.drawText(line, {
          x: MARGIN + 14,
          y: textY,
          size: 10,
          font: fontNormal,
          color: rgb(...SUMMARY_TEXT_RGB)
        });
        textY -= 13;
      }

      currentY -= cardHeight + 12;
    }
  }

  // Page Numbers Footer
  const totalPages = pdfDoc.getPageCount();
  const pdfPages = pdfDoc.getPages();
  for (let idx = 0; idx < totalPages; idx++) {
    const p = pdfPages[idx];
    const footerStr = sanitizeWinAnsiText(`Page ${idx + 1} of ${totalPages}`);
    const textWidth = fontNormal.widthOfTextAtSize(footerStr, 9);
    p.drawText(footerStr, {
      x: (PAGE_WIDTH - textWidth) / 2,
      y: MARGIN / 2,
      size: 9,
      font: fontNormal,
      color: rgb(...SUMMARY_MUTED_RGB)
    });
  }

  await check(0.85, translate('Writing the summary PDF'));
  const bytes = await pdfDoc.save();
  await check(1, translate('Writing the summary PDF'));
  return bytes;
}

export const annotationSummaryApi: AnnotationSummaryJob = {
  async buildAnnotationSummary(input, annotations, job) {
    const bytes = await buildAnnotationSummaryPdf(input, annotations, job);
    return Comlink.transfer(bytes, [bytes.buffer as ArrayBuffer]);
  }
};
