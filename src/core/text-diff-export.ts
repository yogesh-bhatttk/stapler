import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { DiffChunk } from './diff';
import { internal } from './errors';
import { cvWorker, renderWorker } from './workers';
import { type StaplerDoc } from './store';
import { composeDocument } from './operations';
import { newSubstitutionTally, sanitizeWinAnsiText } from './markdown-to-pdf';
import {
  DOC_PAGE_RGB,
  DOC_REDACT_RGB,
  SUMMARY_ACCENT_RGB,
  SUMMARY_CARD_BG_RGB,
  SUMMARY_TEXT_RGB
} from './doc-colors';

interface RenderToken {
  text: string;
  op: DiffChunk['op'];
  width: number;
}

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const PAGE_MARGIN = 40;
const HEADER_SIZE = 18;
const BODY_SIZE = 11;
const LINE_HEIGHT = 15;

const COLORS = {
  equal: rgb(...SUMMARY_TEXT_RGB),
  insert: rgb(...SUMMARY_ACCENT_RGB),
  delete: rgb(...DOC_REDACT_RGB)
} as const;

const BACKGROUNDS = {
  insert: rgb(...SUMMARY_CARD_BG_RGB),
  delete: rgb(...DOC_PAGE_RGB)
} as const;

function tokenize(
  chunks: DiffChunk[],
  font: { widthOfTextAtSize(text: string, size: number): number }
): RenderToken[] {
  const tokens: RenderToken[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const isLast = i === chunks.length - 1;
    const text = isLast ? chunk.text : `${chunk.text} `;
    tokens.push({ text, op: chunk.op, width: font.widthOfTextAtSize(text, BODY_SIZE) });
  }
  return tokens;
}

function splitLongToken(
  token: RenderToken,
  font: { widthOfTextAtSize(text: string, size: number): number },
  maxWidth: number
): RenderToken[] {
  if (token.width <= maxWidth) return [token];

  const parts: RenderToken[] = [];
  let current = '';
  for (const char of token.text) {
    const candidate = current + char;
    if (current && font.widthOfTextAtSize(candidate, BODY_SIZE) > maxWidth) {
      parts.push({
        text: current,
        op: token.op,
        width: font.widthOfTextAtSize(current, BODY_SIZE)
      });
      current = char;
      continue;
    }
    current = candidate;
  }
  if (current)
    parts.push({ text: current, op: token.op, width: font.widthOfTextAtSize(current, BODY_SIZE) });
  return parts;
}

function wrapTokens(
  chunks: DiffChunk[],
  font: { widthOfTextAtSize(text: string, size: number): number }
): RenderToken[][] {
  const maxWidth = PAGE_WIDTH - PAGE_MARGIN * 2;
  const tokens = tokenize(chunks, font).flatMap(token => splitLongToken(token, font, maxWidth));
  const lines: RenderToken[][] = [];
  let line: RenderToken[] = [];
  let width = 0;

  for (const token of tokens) {
    if (line.length > 0 && width + token.width > maxWidth) {
      lines.push(line);
      line = [];
      width = 0;
    }
    line.push(token);
    width += token.width;
  }

  if (line.length > 0) lines.push(line);
  return lines;
}

/** The warning raised when the report had to substitute characters (CONV-13). */
export const TEXT_DIFF_SUBSTITUTION_WARNING =
  'Some characters in these documents (for example CJK, Cyrillic, Arabic or Hebrew) cannot be ' +
  'drawn with the report\'s built-in Latin font and were replaced with "?". Check the affected ' +
  'passages against the documents themselves.';

export interface ExportTextDiffOptions {
  /**
   * Called once when the report substituted any character. pdf-lib's standard
   * fonts silently turn every non-WinAnsi code point into "?" and never throw,
   * so without this a diff of two Cyrillic PDFs was a page of "????" with
   * insert/delete highlights and nothing said (CONV-13).
   */
  onWarning?: (message: string) => void;
}

export async function exportTextDiff(
  docA: StaplerDoc,
  docB: StaplerDoc,
  options: ExportTextDiffOptions = {}
): Promise<Uint8Array> {
  const tally = newSubstitutionTally();
  const safe = (text: string) => sanitizeWinAnsiText(text, tally);
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const pageCountA = docA.pages.length;
  const pageCountB = docB.pages.length;
  const totalPages = Math.max(pageCountA, pageCountB);

  if (totalPages === 0) {
    throw internal('There are no pages to export.');
  }

  if (docA.pages.length === 0 || docB.pages.length === 0) {
    throw internal('Cannot export text diff without both documents having pages.');
  }

  const composedBytesA = await composeDocument({
    pages: docA.pages,
    annotations: docA.annotations ?? []
  });
  const composedBytesB = await composeDocument({
    pages: docB.pages,
    annotations: docB.annotations ?? []
  });

  await renderWorker.lease(async api => {
    let handleA: string | undefined;
    let handleB: string | undefined;
    try {
      handleA = (await api.loadDocument(composedBytesA)).handle;
      handleB = (await api.loadDocument(composedBytesB)).handle;

      let fullBaseText = '';
      let fullCompareText = '';

      for (let i = 0; i < pageCountA; i++) {
        fullBaseText += (await api.extractText(handleA, i, 'text')) + '\n\n';
      }
      for (let i = 0; i < pageCountB; i++) {
        fullCompareText += (await api.extractText(handleB, i, 'text')) + '\n\n';
      }

      // Sanitised before diffing and measuring, so the widths the wrap uses are
      // the widths of the glyphs actually drawn.
      // CONV-14: in the cv worker — a whole-document diff is the largest case.
      const chunks = await cvWorker.lease(worker =>
        worker.diffText(safe(fullBaseText), safe(fullCompareText))
      );
      const diffLines = wrapTokens(chunks, font);

      const lineYStart = PAGE_HEIGHT - PAGE_MARGIN - HEADER_SIZE - 22;
      const maxLinesPerPage = Math.floor((lineYStart - PAGE_MARGIN) / LINE_HEIGHT);

      let currentLineIdx = 0;
      let pageNum = 1;

      while (currentLineIdx < diffLines.length || pageNum === 1) {
        const page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
        const title = `Text Diff - Page ${pageNum}`;
        const compareLabel = safe(`${docA.name} vs ${docB.name}`);

        page.drawText(title, {
          x: PAGE_MARGIN,
          y: PAGE_HEIGHT - PAGE_MARGIN - HEADER_SIZE,
          size: HEADER_SIZE,
          font: boldFont,
          color: COLORS.equal
        });

        page.drawText(compareLabel, {
          x: PAGE_MARGIN,
          y: PAGE_HEIGHT - PAGE_MARGIN - HEADER_SIZE - 16,
          size: 9,
          font,
          color: COLORS.equal
        });

        let y = lineYStart;
        const endLineIdx = Math.min(currentLineIdx + maxLinesPerPage, diffLines.length);

        for (let i = currentLineIdx; i < endLineIdx; i++) {
          const line = diffLines[i];
          let x = PAGE_MARGIN;
          for (const token of line) {
            if (token.op !== 'equal') {
              page.drawRectangle({
                x,
                y: y - 2,
                width: token.width,
                height: BODY_SIZE + 5,
                color: token.op === 'insert' ? BACKGROUNDS.insert : BACKGROUNDS.delete,
                opacity: 1
              });
            }

            // Replace newlines with spaces for rendering text as drawText does not support newlines
            const renderText = token.text.replace(/\n/g, ' ');
            page.drawText(renderText, {
              x,
              y,
              size: BODY_SIZE,
              font,
              color: COLORS[token.op]
            });
            x += token.width;
          }
          y -= LINE_HEIGHT;
        }

        currentLineIdx = endLineIdx;
        pageNum++;
      }
    } finally {
      if (handleA) await api.closeDocument(handleA).catch(() => {});
      if (handleB) await api.closeDocument(handleB).catch(() => {});
    }
  });

  if (tally.substituted) options.onWarning?.(TEXT_DIFF_SUBSTITUTION_WARNING);
  return pdfDoc.save();
}
