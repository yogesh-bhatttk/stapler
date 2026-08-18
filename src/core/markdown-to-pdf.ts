import { PDFDocument, StandardFonts, PDFFont } from 'pdf-lib';
import { marked } from 'marked';

const MARGIN = 50;
const PAGE_WIDTH = 595.28; // A4
const PAGE_HEIGHT = 841.89;

interface DrawState {
  x: number;
  y: number;
  fontNormal: PDFFont;
  fontBold: PDFFont;
  fontMono: PDFFont;
}

function wordWrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(' ');
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
  return lines;
}

/**
 * `page.drawText` with a StandardFonts font throws on any codepoint WinAnsi
 * can't represent (CJK, Cyrillic, most of Arabic/Hebrew, ...) \u2014 a total export
 * failure, not a degradation. Until this exports through an embedded Unicode
 * font, the least-bad option is what a WinAnsi-only fallback has always had
 * to do: substitute and say so, never crash and never silently drop the whole
 * document. `sawUnsupportedCharacter` is set whenever a substitution happens,
 * so the caller can surface a clear, honest warning instead of pretending the
 * text made it through.
 */
let sawUnsupportedCharacter = false;

export function resetUnsupportedCharacterFlag(): void {
  sawUnsupportedCharacter = false;
}

export function hadUnsupportedCharacter(): boolean {
  return sawUnsupportedCharacter;
}

const WIN_ANSI_MAX_CODE_POINT = 0xff;

/**
 * The rest of Windows-1252's 0x80\u20130x9F block that WinAnsiEncoding actually
 * supports beyond plain Latin-1 (the smart quotes/dashes/etc. above are
 * already normalized to ASCII by the replacements before this runs, so they
 * never reach this set). Without it, a codepoint like \u20AC would fail the plain
 * `> 0xFF` check and get replaced even though the font can render it fine.
 */
const WIN_ANSI_EXTRA_CODE_POINTS = new Set(
  [
    '\u20AC',
    '\u0192',
    '\u201E',
    '\u2020',
    '\u2021',
    '\u02C6',
    '\u2030',
    '\u0160',
    '\u2039',
    '\u0152',
    '\u017D',
    '\u02DC',
    '\u0161',
    '\u203A',
    '\u0153',
    '\u017E',
    '\u0178'
  ].map(c => c.codePointAt(0))
);

export function sanitizeWinAnsiText(text: string): string {
  if (!text) return '';
  const mapped = text
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2022/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u00A0/g, ' ')
    .replace(/\u2122/g, '(TM)')
    .replace(/\u00A9/g, '(C)')
    .replace(/\u00AE/g, '(R)');

  let out = '';
  for (const char of mapped) {
    const codePoint = char.codePointAt(0)!;
    if (codePoint > WIN_ANSI_MAX_CODE_POINT && !WIN_ANSI_EXTRA_CODE_POINTS.has(codePoint)) {
      sawUnsupportedCharacter = true;
      out += '?';
    } else {
      out += char;
    }
  }
  return out;
}

export async function markdownToPdfBytes(markdown: string): Promise<Uint8Array> {
  resetUnsupportedCharacterFlag();
  const doc = await PDFDocument.create();
  const fontNormal = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const fontMono = await doc.embedFont(StandardFonts.Courier);

  let page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const state: DrawState = {
    x: MARGIN,
    y: PAGE_HEIGHT - MARGIN,
    fontNormal,
    fontBold,
    fontMono
  };

  const advanceY = (amount: number) => {
    state.y -= amount;
    if (state.y < MARGIN) {
      page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      state.y = PAGE_HEIGHT - MARGIN;
    }
  };

  const drawTextWrapped = (text: string, font: PDFFont, size: number, indent = 0) => {
    // Strip carriage returns, normalize Unicode, and handle basic text
    const clean = sanitizeWinAnsiText(text.replace(/\r/g, '').replace(/\n/g, ' '));
    const lines = wordWrap(clean, font, size, PAGE_WIDTH - MARGIN * 2 - indent);
    for (const line of lines) {
      advanceY(size * 1.5);
      page.drawText(line, { x: state.x + indent, y: state.y, size, font });
    }
  };

  const tokens = marked.lexer(markdown);

  for (const token of tokens) {
    if (token.type === 'heading') {
      advanceY(10);
      const size = token.depth === 1 ? 24 : token.depth === 2 ? 18 : 14;
      drawTextWrapped(token.text, state.fontBold, size);
      advanceY(5);
    } else if (token.type === 'paragraph') {
      drawTextWrapped(token.text, state.fontNormal, 12);
      advanceY(8);
    } else if (token.type === 'space') {
      // Ignored
    } else if (token.type === 'list') {
      const isOrdered = token.ordered;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      token.items.forEach((item: any, index: number) => {
        const bullet = isOrdered ? `${index + 1}. ` : '- ';
        drawTextWrapped(bullet + item.text, state.fontNormal, 12, 15);
      });
      advanceY(8);
    } else if (token.type === 'code') {
      advanceY(5);
      const lines = token.text.split('\n');
      for (const line of lines) {
        drawTextWrapped(line, state.fontMono, 10, 15);
      }
      advanceY(10);
    } else if (token.type === 'table') {
      // Simplistic table rendering
      advanceY(5);
      const colWidth = (PAGE_WIDTH - MARGIN * 2) / token.header.length;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const drawRow = (row: any[], isHeader: boolean) => {
        advanceY(16);
        const font = isHeader ? state.fontBold : state.fontNormal;
        row.forEach((cell, i) => {
          const text = sanitizeWinAnsiText(cell.text || '');
          const renderText = text.length > 30 ? text.substring(0, 29) + '…' : text;
          page.drawText(renderText, {
            x: state.x + i * colWidth,
            y: state.y,
            size: 10,
            font
          });
        });
      };

      drawRow(token.header, true);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      token.rows.forEach((row: any) => drawRow(row, false));
      advanceY(10);
    } else {
      // Fallback for generic elements (e.g. blockquote, html)
      drawTextWrapped(token.raw, state.fontNormal, 12);
      advanceY(8);
    }
  }

  return await doc.save();
}
