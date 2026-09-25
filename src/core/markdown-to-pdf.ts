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
import { unsupported } from './errors';
import { tKey, tPlural, translate } from './i18n';
import { checkpoint, type JobHandle } from './workers/protocol';

const LINK_COLOR = rgb(...SUMMARY_ACCENT_RGB);

/**
 * Largest Markdown source converted (CONV-12). Far past any hand-written
 * document; it bounds the time the synchronous lexer can hold the shared
 * process worker for.
 */
export const MAX_MARKDOWN_CHARS = 1_000_000;

export const MARKDOWN_TOO_LARGE_MESSAGE = tKey(
  'This Markdown is too long to convert in one go (the limit is 1,000,000 characters). ' +
    'Split it into smaller documents.'
);

export const MARKDOWN_TOO_NESTED_MESSAGE = tKey(
  'This Markdown is nested too deeply to convert (for example thousands of ">" quote levels ' +
    'or list levels). Flatten the nesting and try again.'
);

/**
 * Most emphasis delimiters (`*`, `_`, `~`) one paragraph, heading or cell may
 * hand to marked's inline lexer (CONV-12). Its delimiter matching is quadratic
 * in the number of *unmatched* delimiters in one inline run: `'*a '` × 10,000
 * (30 KB) took 11.6 s, × 20,000 took 47 s, and a synchronous lexer call can
 * neither be cancelled nor yield. 500 is ~30 ms in the worst case and far more
 * emphasis than any real paragraph carries; past it, that one block's
 * delimiters are escaped and drawn as the literal characters they are.
 */
export const MAX_INLINE_EMPHASIS_DELIMITERS = 500;

export function literalEmphasisNote(count: number): string {
  return tPlural(
    '{count} paragraphs had more than ' +
      '{max} emphasis markers (*, _ or ~), so ' +
      'their emphasis was shown as plain characters instead of being ' +
      'interpreted.',
    count,
    { max: MAX_INLINE_EMPHASIS_DELIMITERS }
  );
}

function countEmphasisDelimiters(src: string): number {
  let n = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src.charCodeAt(i);
    if (c === 42 /* * */ || c === 95 /* _ */ || c === 126 /* ~ */) n++;
  }
  return n;
}

/** How often (ms) a long conversion checks for cancel and reports progress. */
const CHECKPOINT_INTERVAL_MS = 100;

/**
 * `marked.lexer`, split into its two phases so the slow one is interruptible:
 * the block pass runs once, then each queued inline run is lexed separately,
 * with a cancellation/progress checkpoint between runs and the pathological
 * emphasis guard above applied per run. Same order and same result as
 * `Lexer.lex` otherwise (marked 18: `blockTokens`, then the inline queue).
 */
async function lexMarkdown(
  markdown: string,
  job: JobHandle | undefined,
  counts: { literalEmphasis: number }
): Promise<ReturnType<typeof marked.lexer>> {
  const lexer = new marked.Lexer();
  const src = markdown.replace(/\r\n|\r/g, '\n');
  lexer.blockTokens(src, lexer.tokens);
  const queue = lexer.inlineQueue;
  let last = Date.now();
  for (let i = 0; i < queue.length; i++) {
    if (Date.now() - last >= CHECKPOINT_INTERVAL_MS) {
      await checkpoint(job, 0.1 + 0.4 * (i / queue.length), translate('Reading the Markdown'));
      last = Date.now();
    }
    let inline = queue[i].src;
    if (countEmphasisDelimiters(inline) > MAX_INLINE_EMPHASIS_DELIMITERS) {
      inline = inline.replace(/[*_~]/g, '\\$&');
      counts.literalEmphasis += 1;
    }
    lexer.inlineTokens(inline, queue[i].tokens);
  }
  lexer.inlineQueue = [];
  return lexer.tokens;
}

/** URI schemes a link annotation may carry (CONV-11). */
const SAFE_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/**
 * A link target as it can safely go into a PDF `/URI`, or `null` to drop it.
 *
 * `PDFString.of` writes each UTF-16 code unit as a byte, so a non-ASCII URL
 * came out as mojibake (`https://例え.jp/パス` → `https://H.jp/Ñ¹`). `URL`'s
 * serialisation is pure ASCII — punycoded host, percent-encoded path — which is
 * exactly what the PDF spec asks a `/URI` to be. Only http(s) and mailto are
 * kept: `javascript:` and `file:` were written verbatim before, and a relative
 * link has nothing to resolve against in a standalone PDF.
 */
export function safeLinkUri(href: string | undefined): string | null {
  if (!href) return null;
  let url: URL;
  try {
    url = new URL(href.trim());
  } catch {
    return null;
  }
  if (!SAFE_LINK_PROTOCOLS.has(url.protocol)) return null;
  return url.href;
}

/** The note for links {@link safeLinkUri} refused, or null when there were none. */
export function droppedLinksNote(count: number): string | null {
  if (count === 0) return null;
  return tPlural(
    '{count} links were kept as plain text only, because only ' +
      'web (http/https) and email (mailto) links are made clickable in the PDF.',
    count
  );
}

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
function flattenInlineTokens(
  tokens: InlineToken[] | undefined,
  fallbackText: string,
  counts?: { omittedImages: number }
): InlineRun[] {
  if (!tokens || tokens.length === 0) return fallbackText ? [{ text: fallbackText }] : [];
  const runs: InlineRun[] = [];
  for (const tok of tokens) {
    if (tok.type === 'link') {
      const linkText = flattenInlineTokens(tok.tokens, tok.text ?? '', counts)
        .map(r => r.text)
        .join('');
      if (linkText) runs.push({ text: linkText, href: tok.href });
    } else if (tok.type === 'image') {
      // No raster support here; keep the alt text so the reference isn't lost,
      // and count it so the omission is reported rather than silent.
      if (counts) counts.omittedImages += 1;
      if (tok.text) runs.push({ text: tok.text });
    } else if (tok.tokens) {
      // strong/em/del/... — recurse and drop the formatting itself.
      runs.push(...flattenInlineTokens(tok.tokens, tok.text ?? '', counts));
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
 * document. The optional {@link SubstitutionTally} records that it happened, so
 * the caller can surface a clear, honest warning instead of pretending the text
 * made it through.
 *
 * **The tally is deliberately a parameter, not a module-level flag.** It used to
 * be one, shared by `markdownToPdfBytes` here (CNV-05) and `pdf-block-layout.ts`'s
 * `layoutBlocksToPdf` (CNV-09) — both of which run inside the *pooled* `process`
 * worker, which shares one instance once the pool is at capacity (capacity is 1
 * on a two-core machine). Each call reset the flag on entry and read it at exit,
 * so a second conversion starting during the first one's `await` reset the flag
 * out from under it and the first document was reported as clean however much
 * text it had substituted. A tally created inside the call cannot be reached by
 * another job, whatever interleaves.
 */
export interface SubstitutionTally {
  /** True once any codepoint has been replaced by `?` for this call. */
  substituted: boolean;
}

/** A fresh, call-local tally. */
export function newSubstitutionTally(): SubstitutionTally {
  return { substituted: false };
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

export function sanitizeWinAnsiText(text: string, tally?: SubstitutionTally): string {
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
      if (tally) tally.substituted = true;
      out += '?';
    } else {
      out += char;
    }
  }
  return out;
}

/** Splits sanitized runs into words, dropping empty tokens from whitespace collapse. */
function runsToWords(runs: InlineRun[], tally: SubstitutionTally): Word[] {
  const words: Word[] = [];
  for (const run of runs) {
    const clean = sanitizeWinAnsiText(run.text.replace(/\r/g, '').replace(/\n/g, ' '), tally);
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
): boolean {
  // Every link goes through the scheme allow-list and ASCII normalisation
  // here, so neither caller can forget it (CONV-11). `false` = not added.
  const uri = safeLinkUri(url);
  if (uri === null) return false;
  const context = page.doc.context;
  const annot = context.obj({
    Type: 'Annot',
    Subtype: 'Link',
    Rect: rect,
    Border: [0, 0, 0],
    A: {
      Type: 'Action',
      S: 'URI',
      URI: PDFString.of(uri)
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
  return true;
}

/** A rendered markdown document, plus whether anything had to be substituted. */
export interface MarkdownPdfResult {
  bytes: Uint8Array;
  /**
   * True when at least one codepoint was replaced by `?`. Returned rather than
   * read back off a module-level flag so two conversions sharing one pooled
   * worker cannot report each other's substitutions — see {@link SubstitutionTally}.
   */
  hadUnsupportedCharacters: boolean;
  /**
   * Things the user should know that did not stop the export: links drawn as
   * plain text (CONV-11), images reduced to their alt text (CONV-12).
   */
  notes: string[];
}

/**
 * Markdown → PDF bytes. `job` (optional) gets determinate progress and is
 * checked for cancellation between inline runs while lexing and between
 * blocks while drawing (CONV-12).
 */
export async function markdownToPdfBytes(
  markdown: string,
  job?: JobHandle
): Promise<MarkdownPdfResult> {
  if (markdown.length > MAX_MARKDOWN_CHARS)
    throw unsupported(translate(MARKDOWN_TOO_LARGE_MESSAGE));
  try {
    return await renderMarkdown(markdown, job);
  } catch (err) {
    // marked's lexer and the inline flattener both recurse per nesting level,
    // so 5,000 `>` overflow the stack. That surfaced as a raw "Maximum call
    // stack size exceeded"; it is a property of the input, so say so (CONV-12).
    if (err instanceof RangeError && /call stack/i.test(err.message)) {
      throw unsupported(translate(MARKDOWN_TOO_NESTED_MESSAGE));
    }
    throw err;
  }
}

async function renderMarkdown(
  markdown: string,
  job: JobHandle | undefined
): Promise<MarkdownPdfResult> {
  await checkpoint(job, 0, translate('Reading the Markdown'));
  const tally = newSubstitutionTally();
  const counts = { droppedLinks: 0, omittedImages: 0, literalEmphasis: 0 };
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
      if (href && !addLinkAnnotation(page, [groupStartX, y - 2, cursorX, y + size], href)) {
        counts.droppedLinks += 1;
      }
      if (i < words.length) cursorX += spaceWidth;
    }
  };

  const drawInlineWrapped = (runs: InlineRun[], font: PDFFont, size: number, indent = 0) => {
    const words = runsToWords(runs, tally);
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
    const clean = sanitizeWinAnsiText(text, tally);
    if (!clean) return [''];
    return wordWrapPlain(clean, font, size, maxWidth);
  };

  const tokens = (await lexMarkdown(markdown, job, counts)) as unknown as (InlineToken & {
    type: string;
    depth?: number;
    ordered?: boolean;
    items?: { tokens?: InlineToken[]; text: string }[];
    header?: { tokens?: InlineToken[]; text: string }[];
    rows?: { tokens?: InlineToken[]; text: string }[][];
  })[];

  await checkpoint(job, 0.5, translate('Laying out the PDF'));
  let lastCheck = Date.now();
  for (let t = 0; t < tokens.length; t++) {
    const token = tokens[t];
    if (Date.now() - lastCheck >= CHECKPOINT_INTERVAL_MS) {
      await checkpoint(job, 0.5 + 0.4 * (t / tokens.length), translate('Laying out the PDF'));
      lastCheck = Date.now();
    }
    if (token.type === 'heading') {
      advanceY(10);
      const size = token.depth === 1 ? 24 : token.depth === 2 ? 18 : 14;
      drawInlineWrapped(
        flattenInlineTokens(token.tokens, token.text ?? '', counts),
        state.fontBold,
        size
      );
      advanceY(5);
    } else if (token.type === 'paragraph') {
      drawInlineWrapped(
        flattenInlineTokens(token.tokens, token.text ?? '', counts),
        state.fontNormal,
        12
      );
      advanceY(8);
    } else if (token.type === 'space') {
      // Ignored
    } else if (token.type === 'list') {
      const isOrdered = token.ordered;
      (token.items ?? []).forEach((item, index) => {
        const bullet = isOrdered ? `${index + 1}. ` : '- ';
        const runs = flattenInlineTokens(item.tokens, item.text ?? '', counts);
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
      // `?? 1` only catches null/undefined — an empty header row (`[]`, length
      // 0) is neither, and would otherwise divide by zero and draw every cell
      // at `x: Infinity`.
      const colWidth = (PAGE_WIDTH - MARGIN * 2) / Math.max(token.header?.length ?? 1, 1);
      const cellPadding = 4;
      const lineHeight = 12;

      const drawRow = (row: { tokens?: InlineToken[]; text: string }[], isHeader: boolean) => {
        const font = isHeader ? state.fontBold : state.fontNormal;
        const cellLines = row.map(cell => {
          const plain = flattenInlineTokens(cell.tokens, cell.text ?? '', counts)
            .map(r => r.text)
            .join('');
          return wrapCellLines(plain, font, 10, colWidth - cellPadding * 2);
        });
        const rowLines = Math.max(1, ...cellLines.map(lines => lines.length));
        const rowHeight = (rowLines - 1) * lineHeight;
        const usableHeight = PAGE_HEIGHT - MARGIN * 2;

        advanceY(lineHeight); // top of the row, before any page-break check below

        if (rowHeight > usableHeight - lineHeight) {
          // A row with more wrapped lines than a whole page can hold — no
          // single page-break avoids splitting it, so draw it line by line,
          // starting a fresh page whenever the next line would cross the
          // bottom margin, instead of drawing every remaining line past it.
          let sincePageTop = 0;
          for (let lineIndex = 0; lineIndex < rowLines; lineIndex++) {
            if (state.y - sincePageTop * lineHeight < MARGIN) {
              page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
              state.y = PAGE_HEIGHT - MARGIN - lineHeight;
              sincePageTop = 0;
            }
            const y = state.y - sincePageTop * lineHeight;
            cellLines.forEach((lines, i) => {
              const line = lines[lineIndex];
              if (line !== undefined) {
                page.drawText(line, { x: state.x + i * colWidth, y, size: 10, font });
              }
            });
            sincePageTop++;
          }
          state.y -= (sincePageTop - 1) * lineHeight;
          return;
        }

        // A multi-line row must not have its later lines pushed onto a new
        // page while its first line stays on the old one.
        if (state.y - rowHeight < MARGIN) {
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
        state.y -= rowHeight;
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

  const notes: string[] = [];
  const linkNote = droppedLinksNote(counts.droppedLinks);
  if (linkNote) notes.push(linkNote);
  if (counts.omittedImages > 0) {
    notes.push(
      tPlural(
        '{count} images were left out ' +
          '(Markdown images are not embedded); the alt text is shown in their place.',
        counts.omittedImages
      )
    );
  }
  if (counts.literalEmphasis > 0) notes.push(literalEmphasisNote(counts.literalEmphasis));
  await checkpoint(job, 0.9, translate('Saving the PDF'));
  const bytes = await doc.save();
  await checkpoint(job, 1, translate('Done'));
  return { bytes, hadUnsupportedCharacters: tally.substituted, notes };
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
