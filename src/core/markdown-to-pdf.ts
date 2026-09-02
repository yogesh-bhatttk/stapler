import {
  PDFDocument,
  StandardFonts,
  PDFFont,
  PDFPage,
  PDFName,
  PDFRef,
  PDFString,
  rgb
} from 'pdf-lib';
import { marked } from 'marked';
import { SUMMARY_ACCENT_RGB } from './doc-colors';

const LINK_COLOR = rgb(...SUMMARY_ACCENT_RGB);

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

/** A run of plain text, optionally the visible text of a markdown link. */
interface InlineRun {
  text: string;
  href?: string;
}

/** A single word within a wrapped line, carrying its run's link (if any). */
interface Word {
  text: string;
  href?: string;
}

/**
 * `marked`'s inline token tree for a paragraph/heading/list-item text.
 * Minimal shape — only the fields this module reads.
 */
interface InlineToken {
  type: string;
  text?: string;
  raw?: string;
  href?: string;
  tokens?: InlineToken[];
}

/**
 * Flattens marked's inline token tree (text/strong/em/codespan/link/...) into
 * plain-text runs, keeping a link's `href` attached to its visible text and
 * discarding markdown syntax for everything else (bold/italic render as plain
 * text — CNV-05 never asked for styled inline runs, only for links to survive
 * as real links instead of literal `[text](url)` syntax).
 */
function flattenInlineTokens(tokens: InlineToken[] | undefined, fallbackText: string): InlineRun[] {
  if (!tokens || tokens.length === 0) return fallbackText ? [{ text: fallbackText }] : [];
  const runs: InlineRun[] = [];
  for (const tok of tokens) {
    if (tok.type === 'link') {
      const linkText = flattenInlineTokens(tok.tokens, tok.text ?? '')
        .map(r => r.text)
        .join('');
      if (linkText) runs.push({ text: linkText, href: tok.href });
    } else if (tok.type === 'image') {
      // No raster support here; keep the alt text so the reference isn't lost.
      if (tok.text) runs.push({ text: tok.text });
    } else if (tok.tokens) {
      // strong/em/del/... — recurse and drop the formatting itself.
      runs.push(...flattenInlineTokens(tok.tokens, tok.text ?? ''));
    } else if (tok.type === 'br') {
      runs.push({ text: ' ' });
    } else if (tok.text || tok.raw) {
      runs.push({ text: tok.text ?? tok.raw ?? '' });
    }
  }
  return runs;
}

/**
 * `page.drawText` with a StandardFonts font throws on any codepoint WinAnsi
 * can't represent (CJK, Cyrillic, most of Arabic/Hebrew, ...) — a total export
 * failure, not a degradation. Until this exports through an embedded Unicode
 * font, the least-bad option is what a WinAnsi-only fallback has always had
 * to do: substitute and say so, never crash and never silently drop the whole
 * document. `sawUnsupportedCharacter` is set whenever a substitution happens,
 * so the caller can surface a clear, honest warning instead of pretending the
 * text made it through.
 *
 * **Two callers now share this flag** — `markdownToPdfBytes` here (CNV-05) and
 * `pdf-block-layout.ts`'s `layoutBlocksToPdf` (CNV-09), which both live in the
 * pooled `process` worker. It is module-global, so it is only correct while a
 * single worker instance never interleaves two conversions that read it: each
 * resets the flag at entry and reads it at exit, and an `await` from a second
 * job in between would let one conversion's substitution be reported against the
 * other's document. Do not add a third caller — or make either of these two
 * concurrently re-entrant — without moving this into the call's own scope.
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
 * The rest of Windows-1252's 0x80–0x9F block that WinAnsiEncoding actually
 * supports beyond plain Latin-1 (the smart quotes/dashes/etc. above are
 * already normalized to ASCII by the replacements before this runs, so they
 * never reach this set). Without it, a codepoint like € would fail the plain
 * `> 0xFF` check and get replaced even though the font can render it fine.
 */
const WIN_ANSI_EXTRA_CODE_POINTS = new Set(
  ['€', 'ƒ', '„', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', 'Ž', '˜', 'š', '›', 'œ', 'ž', 'Ÿ'].map(c =>
    c.codePointAt(0)
  )
);

export function sanitizeWinAnsiText(text: string): string {
  if (!text) return '';
  const mapped = text
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/•/g, '-')
    .replace(/…/g, '...')
    .replace(/\u00A0/g, ' ')
    .replace(/™/g, '(TM)')
    .replace(/©/g, '(C)')
    .replace(/®/g, '(R)');

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

/** Splits sanitized runs into words, dropping empty tokens from whitespace collapse. */
function runsToWords(runs: InlineRun[]): Word[] {
  const words: Word[] = [];
  for (const run of runs) {
    const clean = sanitizeWinAnsiText(run.text.replace(/\r/g, '').replace(/\n/g, ' '));
    for (const part of clean.split(/\s+/)) {
      if (part.length > 0) words.push({ text: part, href: run.href });
    }
  }
  return words;
}

/** Greedy word-wrap over `Word`s (link-aware), same line-breaking rule as before. */
function wrapWords(words: Word[], font: PDFFont, size: number, maxWidth: number): Word[][] {
  const lines: Word[][] = [];
  let currentLine: Word[] = [];
  let currentWidth = 0;
  const spaceWidth = font.widthOfTextAtSize(' ', size);

  for (const word of words) {
    const wordWidth = font.widthOfTextAtSize(word.text, size);
    const addedWidth = currentLine.length > 0 ? spaceWidth + wordWidth : wordWidth;
    if (currentWidth + addedWidth > maxWidth && currentLine.length > 0) {
      lines.push(currentLine);
      currentLine = [word];
      currentWidth = wordWidth;
    } else {
      currentLine.push(word);
      currentWidth += addedWidth;
    }
  }
  if (currentLine.length > 0) lines.push(currentLine);
  return lines;
}

/**
 * Adds a `/Link` annotation with a URI action — pdf-lib has no high-level API
 * for this, so it's built from the same low-level `context.obj` primitives
 * `src/core/pdf/accessibility.ts` and `encrypt.ts` already use elsewhere in
 * this codebase. `Border: [0, 0, 0]` suppresses the default blue-box outline
 * most viewers would otherwise draw; the link text itself is colored instead.
 *
 * Exported for CNV-09's `convert/pdf-block-layout.ts`, which draws hyperlinks
 * out of a Word document the same way: a second copy of this would be a second
 * place for the `/Annots` merge below to be got subtly wrong.
 */
export function addLinkAnnotation(
  page: PDFPage,
  rect: [number, number, number, number],
  url: string
): void {
  const context = page.doc.context;
  const annot = context.obj({
    Type: 'Annot',
    Subtype: 'Link',
    Rect: rect,
    Border: [0, 0, 0],
    A: {
      Type: 'Action',
      S: 'URI',
      URI: PDFString.of(url)
    }
  });
  const ref = context.register(annot) as PDFRef;
  page.node.set(
    PDFName.of('Annots'),
    (() => {
      const existing = page.node.Annots();
      if (existing) {
        existing.push(ref);
        return existing;
      }
      return context.obj([ref]);
    })()
  );
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

  /** Draws one wrapped line of words at the current cursor, adding a link
   * annotation for each contiguous run of words that share an `href`. */
  const drawWordsLine = (words: Word[], x: number, y: number, font: PDFFont, size: number) => {
    let cursorX = x;
    const spaceWidth = font.widthOfTextAtSize(' ', size);
    let i = 0;
    while (i < words.length) {
      const href = words[i].href;
      const groupStartX = cursorX;
      while (i < words.length && words[i].href === href) {
        const word = words[i];
        page.drawText(word.text, {
          x: cursorX,
          y,
          size,
          font,
          color: href ? LINK_COLOR : undefined
        });
        cursorX += font.widthOfTextAtSize(word.text, size);
        i++;
        if (i < words.length && words[i].href === href) cursorX += spaceWidth;
      }
      if (href) {
        addLinkAnnotation(page, [groupStartX, y - 2, cursorX, y + size], href);
      }
      if (i < words.length) cursorX += spaceWidth;
    }
  };

  const drawInlineWrapped = (runs: InlineRun[], font: PDFFont, size: number, indent = 0) => {
    const words = runsToWords(runs);
    const lines = wrapWords(words, font, size, PAGE_WIDTH - MARGIN * 2 - indent);
    for (const line of lines) {
      advanceY(size * 1.5);
      drawWordsLine(line, state.x + indent, state.y, font, size);
    }
  };

  const drawTextWrapped = (text: string, font: PDFFont, size: number, indent = 0) => {
    drawInlineWrapped([{ text }], font, size, indent);
  };

  /** Word-wraps a table cell into as many lines as it needs, instead of truncating it. */
  const wrapCellLines = (text: string, font: PDFFont, size: number, maxWidth: number): string[] => {
    const clean = sanitizeWinAnsiText(text);
    if (!clean) return [''];
    return wordWrapPlain(clean, font, size, maxWidth);
  };

  const tokens = marked.lexer(markdown) as unknown as (InlineToken & {
    type: string;
    depth?: number;
    ordered?: boolean;
    items?: { tokens?: InlineToken[]; text: string }[];
    header?: { tokens?: InlineToken[]; text: string }[];
    rows?: { tokens?: InlineToken[]; text: string }[][];
  })[];

  for (const token of tokens) {
    if (token.type === 'heading') {
      advanceY(10);
      const size = token.depth === 1 ? 24 : token.depth === 2 ? 18 : 14;
      drawInlineWrapped(flattenInlineTokens(token.tokens, token.text ?? ''), state.fontBold, size);
      advanceY(5);
    } else if (token.type === 'paragraph') {
      drawInlineWrapped(flattenInlineTokens(token.tokens, token.text ?? ''), state.fontNormal, 12);
      advanceY(8);
    } else if (token.type === 'space') {
      // Ignored
    } else if (token.type === 'list') {
      const isOrdered = token.ordered;
      (token.items ?? []).forEach((item, index) => {
        const bullet = isOrdered ? `${index + 1}. ` : '- ';
        const runs = flattenInlineTokens(item.tokens, item.text ?? '');
        if (runs.length > 0) runs[0] = { ...runs[0], text: bullet + runs[0].text };
        else runs.push({ text: bullet });
        drawInlineWrapped(runs, state.fontNormal, 12, 15);
      });
      advanceY(8);
    } else if (token.type === 'code') {
      advanceY(5);
      const lines = (token.text ?? '').split('\n');
      for (const line of lines) {
        drawTextWrapped(line, state.fontMono, 10, 15);
      }
      advanceY(10);
    } else if (token.type === 'table') {
      // Simplistic table rendering: each cell wraps to fit its column rather
      // than truncating (CNV-05) — a row's height is the tallest cell in it.
      advanceY(5);
      const colWidth = (PAGE_WIDTH - MARGIN * 2) / (token.header?.length ?? 1);
      const cellPadding = 4;
      const lineHeight = 12;

      const drawRow = (row: { tokens?: InlineToken[]; text: string }[], isHeader: boolean) => {
        const font = isHeader ? state.fontBold : state.fontNormal;
        const cellLines = row.map(cell => {
          const plain = flattenInlineTokens(cell.tokens, cell.text ?? '')
            .map(r => r.text)
            .join('');
          return wrapCellLines(plain, font, 10, colWidth - cellPadding * 2);
        });
        const rowLines = Math.max(1, ...cellLines.map(lines => lines.length));

        advanceY(lineHeight); // top of the row, before any page-break check below
        // A multi-line row must not have its later lines pushed onto a new
        // page while its first line stays on the old one.
        if (state.y - (rowLines - 1) * lineHeight < MARGIN) {
          page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
          state.y = PAGE_HEIGHT - MARGIN - lineHeight;
        }

        cellLines.forEach((lines, i) => {
          lines.forEach((line, lineIndex) => {
            page.drawText(line, {
              x: state.x + i * colWidth,
              y: state.y - lineIndex * lineHeight,
              size: 10,
              font
            });
          });
        });
        state.y -= (rowLines - 1) * lineHeight;
      };

      drawRow(token.header ?? [], true);
      (token.rows ?? []).forEach(row => drawRow(row, false));
      advanceY(10);
    } else {
      // Fallback for generic elements (e.g. blockquote, html)
      drawTextWrapped(token.raw ?? '', state.fontNormal, 12);
      advanceY(8);
    }
  }

  return await doc.save();
}

/** The original flat-string word-wrap, kept for table cells and code lines. */
function wordWrapPlain(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
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
