import { PDFDocument, StandardFonts, rgb, type PDFPage, type PDFFont } from 'pdf-lib';
import { diffText, type DiffChunk } from './diff';
import { internal } from './errors';
import { renderWorker } from './workers';
import { sources, type StaplerDoc } from './store';
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

function drawWrappedDiff(
  page: PDFPage,
  chunks: DiffChunk[],
  font: PDFFont,
  boldFont: PDFFont,
  title: string,
  compareLabel: string
): void {
  const lineYStart = PAGE_HEIGHT - PAGE_MARGIN - HEADER_SIZE - 22;
  const diffLines = wrapTokens(chunks, font);

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
  for (const line of diffLines) {
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

      page.drawText(token.text, {
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
}

export async function exportTextDiff(docA: StaplerDoc, docB: StaplerDoc): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const pageCountA = docA.pages.length;
  const pageCountB = docB.pages.length;
  const totalPages = Math.max(pageCountA, pageCountB);

  if (totalPages === 0) {
    throw internal('There are no pages to export.');
  }

  const sourceA = docA.pages[0] ? sources.value[docA.pages[0].sourceDocId] : undefined;
  const sourceB = docB.pages[0] ? sources.value[docB.pages[0].sourceDocId] : undefined;
  if (!sourceA || !sourceB) {
    throw internal('Cannot export text diff without both compare sources loaded.');
  }

  await renderWorker.lease(async api => {
    let handleA: string | undefined;
    let handleB: string | undefined;
    try {
      handleA = (await api.loadDocument(sourceA.bytes)).handle;
      handleB = (await api.loadDocument(sourceB.bytes)).handle;
      for (let i = 0; i < totalPages; i++) {
        const pageA = docA.pages[i];
        const pageB = docB.pages[i];
        const baseText =
          i < pageCountA ? await api.extractText(handleA, pageA!.sourceIndex, 'text') : '';
        const compareText =
          i < pageCountB ? await api.extractText(handleB, pageB!.sourceIndex, 'text') : '';

        const page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
        const chunks = diffText(baseText, compareText);
        drawWrappedDiff(
          page,
          chunks,
          font,
          boldFont,
          `Text Diff - Page ${i + 1}`,
          `${docA.name} vs ${docB.name}`
        );
      }
    } finally {
      if (handleA) await api.closeDocument(handleA).catch(() => {});
      if (handleB) await api.closeDocument(handleB).catch(() => {});
    }
  });

  return pdfDoc.save();
}
