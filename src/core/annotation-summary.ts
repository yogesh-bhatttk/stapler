import { PDFDocument, StandardFonts, rgb, PDFFont } from 'pdf-lib';
import type { StaplerDoc } from './store';
import { sanitizeWinAnsiText } from './markdown-to-pdf';
import {
  SUMMARY_TITLE_RGB,
  SUMMARY_MUTED_RGB,
  SUMMARY_LINE_RGB,
  SUMMARY_CARD_BG_RGB,
  SUMMARY_CARD_BORDER_RGB,
  SUMMARY_ACCENT_RGB,
  SUMMARY_HEADER_RGB,
  SUMMARY_TEXT_RGB
} from './doc-colors';

export interface SummaryAnnotation {
  id?: string;
  type?: string;
  color?: string;
  strokeWidth?: number;
  points?: { x: number; y: number }[];
  rect?: { x: number; y: number; width: number; height: number };
  x?: number;
  y?: number;
  text?: string;
  data?: string;
  author?: string;
  date?: string;
  pageKey?: string;
  pageIndex?: number;
}

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

function getTypeLabel(type?: string): string {
  switch (type) {
    case 'sticky':
      return 'Sticky Note';
    case 'text':
      return 'Text Comment';
    case 'highlight':
      return 'Highlight';
    case 'rectangle':
      return 'Rectangle';
    case 'freehand':
      return 'Freehand Ink';
    case 'whiteout':
      return 'Whiteout';
    case 'signature':
      return 'Signature Stamp';
    case 'date':
      return 'Date Stamp';
    case 'check':
      return 'Checkmark';
    default:
      return type ? type.charAt(0).toUpperCase() + type.slice(1) : 'Note';
  }
}

function getPageNumber(ann: SummaryAnnotation, docPages?: { key: string }[]): number {
  if (ann.pageIndex !== undefined) {
    return ann.pageIndex + 1;
  }
  if (ann.pageKey && docPages) {
    const idx = docPages.findIndex(p => p.key === ann.pageKey);
    if (idx >= 0) return idx + 1;
  }
  return 1;
}

function getPositionString(ann: SummaryAnnotation): string {
  if (ann.rect) {
    const xPct = Math.round(ann.rect.x * 100);
    const yPct = Math.round(ann.rect.y * 100);
    return `X: ${xPct}%, Y: ${yPct}%`;
  }
  if (ann.x !== undefined && ann.y !== undefined) {
    const xPct = Math.round(ann.x * 100);
    const yPct = Math.round(ann.y * 100);
    return `X: ${xPct}%, Y: ${yPct}%`;
  }
  if (ann.points && ann.points.length > 0) {
    const xPct = Math.round(ann.points[0].x * 100);
    const yPct = Math.round(ann.points[0].y * 100);
    return `X: ${xPct}%, Y: ${yPct}%`;
  }
  return 'N/A';
}

/**
 * Generates a clean plain-text summary of all annotations in `doc`.
 */
export function exportAnnotationSummaryText(
  doc: { name?: string; pages?: { key: string }[] } | StaplerDoc,
  annotations: SummaryAnnotation[]
): string {
  const docName = doc.name || 'Document';
  const pages = doc.pages || [];
  const lines: string[] = [
    `========================================`,
    `ANNOTATION SUMMARY: ${docName}`,
    `Total Annotations: ${annotations.length}`,
    `========================================`,
    ''
  ];

  const sorted = [...annotations].sort((a, b) => {
    const pA = getPageNumber(a, pages);
    const pB = getPageNumber(b, pages);
    if (pA !== pB) return pA - pB;
    const yA = a.rect?.y ?? a.y ?? a.points?.[0]?.y ?? 0;
    const yB = b.rect?.y ?? b.y ?? b.points?.[0]?.y ?? 0;
    return yA - yB;
  });

  sorted.forEach((ann, i) => {
    const pageNum = getPageNumber(ann, pages);
    const typeLabel = getTypeLabel(ann.type);
    const posStr = getPositionString(ann);
    const author = ann.author || 'Anonymous';
    const date = ann.date || 'N/A';
    const textContent = ann.text || ann.data || '(No text content)';

    lines.push(`[Note #${i + 1}] ${typeLabel}`);
    lines.push(`Page: ${pageNum}`);
    lines.push(`Author: ${author}`);
    lines.push(`Date: ${date}`);
    lines.push(`Position: ${posStr}`);
    lines.push(`Text: ${textContent}`);
    lines.push(`----------------------------------------`);
  });

  return lines.join('\n');
}

/**
 * ANN-04: Export annotation summary.
 * Construct a clean printable PDF summary listing each note's page, position, author/date, and text content.
 */
export async function exportAnnotationSummary(
  doc: { name?: string; pages?: { key: string }[] } | StaplerDoc,
  annotations: SummaryAnnotation[]
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const fontNormal = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontOblique = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

  const PAGE_WIDTH = 595.28; // A4 width
  const PAGE_HEIGHT = 841.89; // A4 height
  const MARGIN = 50;
  const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

  const docName = doc.name || 'Document';
  const pages = doc.pages || [];

  const sorted = [...annotations].sort((a, b) => {
    const pA = getPageNumber(a, pages);
    const pB = getPageNumber(b, pages);
    if (pA !== pB) return pA - pB;
    const yA = a.rect?.y ?? a.y ?? a.points?.[0]?.y ?? 0;
    const yB = b.rect?.y ?? b.y ?? b.points?.[0]?.y ?? 0;
    return yA - yB;
  });

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
    for (let i = 0; i < sorted.length; i++) {
      const ann = sorted[i];
      const pageNum = getPageNumber(ann, pages);
      const typeLabel = getTypeLabel(ann.type);
      const posStr = getPositionString(ann);
      const author = ann.author || 'Anonymous';
      const date = ann.date || 'N/A';
      const rawText = ann.text || ann.data || '(No text content)';
      const textClean = sanitizeWinAnsiText(rawText);

      const textLines = wordWrap(textClean, fontNormal, 10, CONTENT_WIDTH - 20);

      // Card height calculation: header (16) + meta (14) + textLines * 13 + padding (20)
      const cardHeight = 30 + textLines.length * 13 + 16;

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

  return await pdfDoc.save();
}
