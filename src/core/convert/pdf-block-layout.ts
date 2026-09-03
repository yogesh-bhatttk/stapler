/**
 * CNV-09 — the block model → laid-out PDF pages.
 *
 * The counterpart of `docx-writer.ts`: that one takes a block model and writes a
 * `.docx`, this one takes a block model and draws it onto PDF pages. It is
 * deliberately generalized over `html-to-pdf-blocks.ts`'s `LayoutBlock` rather
 * than over anything Word-shaped, because CNV-11 (Excel → PDF) and CNV-13
 * (PowerPoint → PDF) are planned to feed the same engine.
 *
 * It extends `markdown-to-pdf.ts`'s approach rather than inventing a second one,
 * as the ticket asks: the same greedy word-wrap, the same page-break-on-overflow
 * cursor, the same WinAnsi sanitiser (imported from that module, so the two
 * exports agree about which characters a standard font can represent), and the
 * same low-level `/Link` annotation. What is new is what Markdown never needed —
 * runs that carry their own bold/italic across a wrap, real raster images, and
 * tables whose cells are runs rather than strings.
 *
 * **What this is not.** It is not Word's layout engine. Word's own pagination,
 * fonts, columns, floats, headers/footers, footnotes and tab stops are not
 * reproduced, and `mammoth` does not report most of them in the first place. The
 * tool says so in its own copy and ships behind a mandatory preview (PLAN §5.5).
 */

import { PDFDocument, PDFFont, PDFImage, PDFPage, StandardFonts, rgb } from 'pdf-lib';
import { DOC_HAIRLINE_RGB, SUMMARY_ACCENT_RGB } from '../doc-colors';
import { corrupt } from '../errors';
import {
  addLinkAnnotation,
  hadUnsupportedCharacter,
  resetUnsupportedCharacterFlag,
  sanitizeWinAnsiText
} from '../markdown-to-pdf';
import { checkpoint, type JobHandle } from '../workers/protocol';
import {
  elide,
  runsToText,
  type LayoutBlock,
  type PdfImageFormat,
  type PdfPreviewItem,
  type StyledRun
} from './html-to-pdf-blocks';

export type PdfPageSize = 'a4' | 'letter';

const PAGE_SIZES: Record<PdfPageSize, readonly [number, number]> = {
  a4: [595.28, 841.89],
  letter: [612, 792]
};

/**
 * The page-box limits the PDF format itself imposes, in points.
 *
 * 1/8 inch to 200 inches is Acrobat's stated range and what every viewer
 * enforces; a page outside it is not opened rather than opened wrongly. Only
 * reachable through `pageBox`, since the named sizes are both inside it.
 */
const MIN_PAGE_POINTS = 9;
const MAX_PAGE_POINTS = 14400;

/**
 * 1 inch, which is Word's own default margin. `markdown-to-pdf.ts` uses 50pt
 * because it is laying out Markdown, which has no notion of a page; a document
 * that came *from* Word should start from Word's default rather than from this
 * codebase's other one.
 */
const MARGIN = 72;

/** Word's default body size. Everything else is derived from it. */
const BODY_SIZE = 11;
const LINE_RATIO = 1.35;

/** Heading sizes by level, in points. */
const HEADING_SIZES: Record<number, number> = { 1: 22, 2: 17, 3: 14, 4: 12.5, 5: 11.5, 6: 11 };

const SPACE_BEFORE_HEADING = 12;
const SPACE_AFTER_HEADING = 5;
const SPACE_AFTER_PARAGRAPH = 8;
const SPACE_AFTER_LIST = 3;
const SPACE_AROUND_TABLE = 8;
const SPACE_AROUND_IMAGE = 8;

/** Indent per nesting level of a list, and the gap between marker and text. */
const LIST_INDENT = 18;
const LIST_MARKER_GAP = 16;

const TABLE_FONT_SIZE = 10;
const CELL_PADDING_X = 5;
const CELL_PADDING_Y = 4;

/**
 * A raster's pixel size means nothing without a resolution. `mammoth` discards
 * the EMU extent Word stored, so the only honest default left is the one every
 * browser and word processor assumes for an image with no metadata: 96 DPI, i.e.
 * 0.75 point per pixel. Anything wider than the text column is then scaled down;
 * nothing is ever scaled *up*, for the same reason CNV-08's `fitImage` does not.
 */
const PX_TO_PT = 0.75;

const LINK_COLOR = rgb(...SUMMARY_ACCENT_RGB);
const RULE_COLOR = rgb(...DOC_HAIRLINE_RGB);
const RULE_WIDTH = 0.5;

export interface PdfLayoutOptions {
  pageSize: PdfPageSize;
  /**
   * CNV-13 — an exact page box in points, overriding `pageSize`.
   *
   * A `.docx` and an `.xlsx` state no page size worth honouring (Word's is a
   * print setting `mammoth` does not report; Excel's is a print setup this
   * codebase deliberately does not read), so those two tools ask for a named
   * paper size and always will. A slide deck *does* state its size, and a
   * 13.33 × 7.5 inch deck exported onto A4 is letterboxed on every page for no
   * reason. So the producer may state the box instead of choosing from a menu
   * of two. Out-of-range values are clamped to what the format allows and
   * reported in `notes`, never written as-is.
   */
  pageBox?: { width: number; height: number };
  /** Written into the PDF's `/Title`. */
  title?: string;
}

export interface PdfLayoutResult {
  bytes: Uint8Array;
  pageCount: number;
  /** How many images were actually drawn. */
  imageCount: number;
  /** Block-by-block description of what was drawn, for the mandatory preview. */
  outline: PdfPreviewItem[];
  /** Everything recognised and deliberately not drawn, each with the reason. */
  notes: string[];
  /**
   * True when at least one character could not be represented by the standard
   * fonts and was replaced. Never a silent substitution — the caller surfaces it.
   */
  hadUnsupportedCharacters: boolean;
}

/** A styled fragment of one wrapped line, ready to draw. */
interface Piece {
  text: string;
  bold: boolean;
  italic: boolean;
  href?: string;
  width: number;
}

interface FontSet {
  regular: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
  boldItalic: PDFFont;
}

function fontFor(fonts: FontSet, bold: boolean, italic: boolean): PDFFont {
  if (bold && italic) return fonts.boldItalic;
  if (bold) return fonts.bold;
  if (italic) return fonts.italic;
  return fonts.regular;
}

/** Splits a word too long for its own line, so it wraps instead of overflowing. */
function splitOversizedWord(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const parts: string[] = [];
  let current = '';
  for (const char of text) {
    const candidate = current + char;
    if (current.length > 0 && font.widthOfTextAtSize(candidate, size) > maxWidth) {
      parts.push(current);
      current = char;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

/**
 * Greedy word-wrap over styled runs.
 *
 * The wrap has to happen across runs, not inside one: "the **bold** word" is
 * three runs and one sentence, and wrapping each run separately would break the
 * line at every style change. `\n` (from `<br />`) forces a break.
 */
export function wrapRuns(
  runs: readonly StyledRun[],
  fonts: FontSet,
  size: number,
  maxWidth: number
): Piece[][] {
  const lines: Piece[][] = [];
  let line: Piece[] = [];
  let lineWidth = 0;
  let pendingSpace = false;
  let lastStyle: StyledRun | null = null;

  const flush = () => {
    lines.push(line);
    line = [];
    lineWidth = 0;
    pendingSpace = false;
  };

  const push = (text: string, run: StyledRun, width: number) => {
    line.push({
      text,
      bold: run.bold,
      italic: run.italic,
      ...(run.href ? { href: run.href } : {}),
      width
    });
    lineWidth += width;
  };

  for (const run of runs) {
    const font = fontFor(fonts, run.bold, run.italic);
    const spaceWidth = font.widthOfTextAtSize(' ', size);
    // Sanitise here rather than at parse time: the substitution is a *rendering*
    // limitation of the standard fonts, and a caller measuring the model's text
    // should see the document's own characters.
    const clean = sanitizeWinAnsiText(run.text);

    for (const token of clean.match(/\n|[^\S\n]+|\S+/g) ?? []) {
      if (token === '\n') {
        flush();
        lastStyle = run;
        continue;
      }
      if (/^[^\S\n]+$/.test(token)) {
        if (line.length > 0) pendingSpace = true;
        lastStyle = run;
        continue;
      }

      let words = [token];
      if (font.widthOfTextAtSize(token, size) > maxWidth) {
        words = splitOversizedWord(token, font, size, maxWidth);
      }

      for (const word of words) {
        const wordWidth = font.widthOfTextAtSize(word, size);
        const gap = pendingSpace && line.length > 0 ? spaceWidth : 0;
        if (line.length > 0 && lineWidth + gap + wordWidth > maxWidth) {
          flush();
        } else if (gap > 0) {
          push(' ', lastStyle ?? run, gap);
        }
        pendingSpace = false;
        push(word, run, wordWidth);
        lastStyle = run;
      }
    }
  }

  if (line.length > 0) lines.push(line);
  // Empty entries are kept: each one is a `<br />` the source document asked for.
  return lines;
}

/** Measures how tall a wrapped block of text will be. */
function textHeight(lineCount: number, size: number): number {
  return lineCount * size * LINE_RATIO;
}

/**
 * A producer-stated page box, brought inside what the PDF format allows.
 *
 * A box is *clamped and reported*, never refused and never written as given: a
 * `/MediaBox` of `[0 0 0 0]` produces a file no viewer opens, and a deck whose
 * slide size was recorded as zero is still a deck worth converting. A box that
 * is not a pair of finite positive numbers states nothing at all, so the named
 * paper size the caller also passed is used instead.
 */
export function clampPageBox(
  box: { width: number; height: number },
  fallback: readonly [number, number],
  notes: string[]
): [number, number] {
  const usable =
    Number.isFinite(box.width) && box.width > 0 && Number.isFinite(box.height) && box.height > 0;
  if (!usable) {
    notes.push(
      'The document did not state a usable page size, so the pages are ' +
        `${Math.round(fallback[0])} × ${Math.round(fallback[1])} pt.`
    );
    return [fallback[0], fallback[1]];
  }
  const width = Math.min(MAX_PAGE_POINTS, Math.max(MIN_PAGE_POINTS, box.width));
  const height = Math.min(MAX_PAGE_POINTS, Math.max(MIN_PAGE_POINTS, box.height));
  if (Math.abs(width - box.width) > 0.01 || Math.abs(height - box.height) > 0.01) {
    notes.push(
      `The document states a page of ${Math.round(box.width)} × ${Math.round(box.height)} pt, ` +
        `which is outside what a PDF page may be; it was clamped to ${Math.round(width)} × ` +
        `${Math.round(height)} pt and the content scaled to fit.`
    );
  }
  return [width, height];
}

/**
 * Draws the blocks onto pages and returns the finished PDF.
 *
 * Nothing here throws away content on a per-block failure: an image pdf-lib
 * refuses is reported in `notes` and the rest of the document is still produced.
 * The one hard failure is a model with nothing in it, which would otherwise hand
 * the user a blank file that looks like a successful conversion.
 */
export async function layoutBlocksToPdf(
  blocks: readonly LayoutBlock[],
  options: PdfLayoutOptions,
  job?: JobHandle
): Promise<PdfLayoutResult> {
  if (blocks.length === 0) {
    // `corrupt`, not `internal`: an input with nothing convertible in it is a
    // fact about the user's file, and "Something went wrong inside Stapler."
    // both blames the wrong party and hides the one thing worth saying. This is
    // the kind `docx-reader.ts` already raises for the neighbouring input
    // conditions — an empty file, and a `.docx` with no `word/document.xml`
    // ("there is nothing to convert") — so the two agree.
    throw corrupt(
      'This document produced no text or images to convert, so no PDF was written. It may be ' +
        'empty, or hold only content this converter cannot read (text boxes, shapes or SmartArt).'
    );
  }

  await checkpoint(job, 0, 'Laying out the PDF');
  resetUnsupportedCharacterFlag();

  const notes: string[] = [];
  const named = PAGE_SIZES[options.pageSize] ?? PAGE_SIZES.a4;
  const [pageWidth, pageHeight] = options.pageBox
    ? clampPageBox(options.pageBox, named, notes)
    : named;
  const contentWidth = pageWidth - MARGIN * 2;
  const usableHeight = pageHeight - MARGIN * 2;

  const doc = await PDFDocument.create();
  if (options.title) doc.setTitle(options.title);
  const fonts: FontSet = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
    boldItalic: await doc.embedFont(StandardFonts.HelveticaBoldOblique)
  };

  const outline: PdfPreviewItem[] = [];
  let imageCount = 0;
  /** How many positioned boxes hold more text than the producer sized them for. */
  let overflowingBoxes = 0;

  let page: PDFPage = doc.addPage([pageWidth, pageHeight]);
  let pageIndex = 0;
  /** Baseline cursor: the y of the *top* of the next thing to draw. */
  let y = pageHeight - MARGIN;
  /**
   * Whether anything has been drawn on the current page.
   *
   * The flow path infers this from the cursor, which is enough for it; a canvas
   * draws without moving the cursor, so "is this page free for a canvas?" needs
   * its own answer or two slides would land on one page.
   */
  let pageUsed = false;

  const newPage = () => {
    page = doc.addPage([pageWidth, pageHeight]);
    pageIndex += 1;
    y = pageHeight - MARGIN;
    pageUsed = false;
  };

  /** Starts a new page when `height` will not fit in what is left of this one. */
  const ensure = (height: number) => {
    if (y - height < MARGIN && y < pageHeight - MARGIN) newPage();
  };

  const drawLine = (pieces: readonly Piece[], x: number, baseline: number, size: number) => {
    if (pieces.length > 0) pageUsed = true;
    let cursor = x;
    let index = 0;
    while (index < pieces.length) {
      const href = pieces[index].href;
      const groupStart = cursor;
      while (index < pieces.length && pieces[index].href === href) {
        const piece = pieces[index];
        page.drawText(piece.text, {
          x: cursor,
          y: baseline,
          size,
          font: fontFor(fonts, piece.bold, piece.italic),
          ...(href ? { color: LINK_COLOR } : {})
        });
        cursor += piece.width;
        index += 1;
      }
      if (href) {
        addLinkAnnotation(page, [groupStart, baseline - 2, cursor, baseline + size], href);
      }
    }
  };

  /**
   * Draws wrapped text from the cursor down, breaking pages between lines.
   * Returns the page the *first* line landed on, which is what the preview
   * reports for the block.
   */
  const drawWrapped = (
    runs: readonly StyledRun[],
    size: number,
    x: number,
    width: number,
    markerText?: string,
    markerX?: number
  ): number => {
    const lines = wrapRuns(runs, fonts, size, width);
    const lineHeight = size * LINE_RATIO;
    let firstPage = pageIndex;
    let drawnAny = false;

    for (const pieces of lines) {
      ensure(lineHeight);
      if (!drawnAny) firstPage = pageIndex;
      y -= lineHeight;
      if (!drawnAny && markerText !== undefined && markerX !== undefined) {
        page.drawText(sanitizeWinAnsiText(markerText), {
          x: markerX,
          y,
          size,
          font: fonts.regular
        });
      }
      drawLine(pieces, x, y, size);
      drawnAny = true;
    }

    if (!drawnAny) firstPage = pageIndex;
    return firstPage;
  };

  /** Draws one table, breaking rows across pages. Returns its first page. */
  const drawTable = (
    rows: readonly StyledRun[][][],
    requestedWidths?: readonly number[]
  ): number => {
    const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0);
    if (columnCount === 0) return pageIndex;

    // CNV-11 — a producer that knows its column geometry (a spreadsheet) says
    // so; one that does not (`mammoth`'s HTML) gets the equal split it always
    // got. The requested widths are *relative*: they are normalised to the
    // content width here, so the same block lays out correctly on A4 and Letter.
    // A malformed list — wrong length, a non-finite or non-positive entry, or a
    // total of zero — falls back to the equal split rather than dividing by
    // zero and drawing the whole grid at x = NaN.
    const usable =
      requestedWidths !== undefined &&
      requestedWidths.length === columnCount &&
      requestedWidths.every(width => Number.isFinite(width) && width > 0)
        ? requestedWidths
        : null;
    const total = usable?.reduce((sum, width) => sum + width, 0) ?? 0;
    const columnWidths =
      usable && total > 0
        ? usable.map(width => (width / total) * contentWidth)
        : Array.from({ length: columnCount }, () => contentWidth / columnCount);
    /** x offset of each column, so a cell never has to re-sum the widths. */
    const columnOffsets: number[] = [];
    let offset = 0;
    for (const width of columnWidths) {
      columnOffsets.push(offset);
      offset += width;
    }
    const lineHeight = TABLE_FONT_SIZE * LINE_RATIO;

    y -= SPACE_AROUND_TABLE;
    let firstPage = pageIndex;
    let drawnAny = false;

    for (const row of rows) {
      const wrapped = row.map((cell, column) =>
        wrapRuns(
          cell,
          fonts,
          TABLE_FONT_SIZE,
          // A column narrower than its own padding would give a negative wrap
          // width, which `wrapRuns` would turn into one character per line.
          Math.max(1, (columnWidths[column] ?? columnWidths[0]) - CELL_PADDING_X * 2)
        )
      );
      const lineCount = Math.max(1, ...wrapped.map(lines => lines.length));
      const rowHeight = textHeight(lineCount, TABLE_FONT_SIZE) + CELL_PADDING_Y * 2;

      // A row taller than a whole page cannot be kept together; it is drawn from
      // the top of a fresh page and allowed to overflow rather than being
      // truncated, because losing a cell's text is the worse outcome. A table
      // continued onto a new page does not repeat its header row — stated as a
      // limitation rather than half-implemented.
      if (rowHeight <= usableHeight) ensure(rowHeight);
      if (!drawnAny) firstPage = pageIndex;

      const top = y;
      pageUsed = true;
      for (let column = 0; column < columnCount; column++) {
        const x = MARGIN + columnOffsets[column];
        page.drawRectangle({
          x,
          y: top - rowHeight,
          width: columnWidths[column],
          height: rowHeight,
          borderColor: RULE_COLOR,
          borderWidth: RULE_WIDTH
        });
        const lines = wrapped[column] ?? [];
        lines.forEach((pieces, lineIndex) => {
          drawLine(
            pieces,
            x + CELL_PADDING_X,
            top - CELL_PADDING_Y - (lineIndex + 1) * lineHeight,
            TABLE_FONT_SIZE
          );
        });
      }
      y = top - rowHeight;
      drawnAny = true;
    }

    y -= SPACE_AROUND_TABLE;
    return firstPage;
  };

  /**
   * Image id → the embedded XObject, so a picture used on several canvases is
   * decoded and written into the file **once**.
   *
   * This is the same rule CNV-06, CMP-03 and `pptx-writer.ts`'s media dedup all
   * apply: a 400 KB logo on a 60-slide deck is one object, not 60. Only ids the
   * producer supplied are cached — an image block with no id is embedded on its
   * own, because an id is an identity claim and inventing one from, say, the
   * byte length would eventually swap two different pictures.
   */
  const embeddedById = new Map<string, PDFImage>();

  const embedImage = async (
    data: Uint8Array,
    format: PdfImageFormat,
    id?: string
  ): Promise<PDFImage | null> => {
    const cached = id === undefined ? undefined : embeddedById.get(id);
    if (cached) return cached;
    try {
      const embedded = format === 'png' ? await doc.embedPng(data) : await doc.embedJpg(data);
      if (id !== undefined) embeddedById.set(id, embedded);
      return embedded;
    } catch (err) {
      notes.push(
        `An image could not be embedded and was left out (${
          err instanceof Error ? err.message : 'unreadable image data'
        }).`
      );
      return null;
    }
  };

  /** Embeds and places one image, or records why it could not be. */
  const drawImage = async (
    block: Extract<LayoutBlock, { kind: 'image' }>
  ): Promise<{ pageIndex: number; width: number; height: number } | null> => {
    const embedded = await embedImage(block.data, block.format);
    if (!embedded) return null;

    let width = embedded.width * PX_TO_PT;
    let height = embedded.height * PX_TO_PT;
    const scale = Math.min(1, contentWidth / width, usableHeight / height);
    width *= scale;
    height *= scale;

    y -= SPACE_AROUND_IMAGE;
    ensure(height);
    const at = pageIndex;
    y -= height;
    page.drawImage(embedded, { x: MARGIN, y, width, height });
    pageUsed = true;
    y -= SPACE_AROUND_IMAGE;
    return { pageIndex: at, width, height };
  };

  /* ---------------------------------------------------------------- *
   * CNV-13 — a producer-positioned page
   * ---------------------------------------------------------------- */

  /**
   * Draws one canvas onto a page of its own and returns what it placed.
   *
   * **The coordinate change happens here and only here.** A canvas is stated in
   * points from its *top-left* with y increasing downward; a PDF page is points
   * from its *bottom-left* with y increasing upward. Getting that backwards puts
   * a slide's title along the bottom edge and is invisible in any test that
   * compares the output against the same wrong assumption — so
   * `ppt-to-pdf.test.ts` re-extracts the produced page's text with pdf.js and
   * asserts the title's baseline is in the *upper* part of the page, which is a
   * fact about the file rather than about this function.
   *
   * The canvas is fitted to the page uniformly and centred, so a deck converted
   * onto A4 is a scaled copy of itself rather than a stretched one. When the
   * caller sized the page from the canvas (`pageBox`), the scale is 1 and both
   * offsets are 0, and every coordinate is the producer's own.
   */
  const drawCanvas = async (
    block: Extract<LayoutBlock, { kind: 'canvas' }>
  ): Promise<{ pageIndex: number; images: number; overflowing: number }> => {
    if (pageUsed) newPage();
    const at = pageIndex;
    let images = 0;
    let overflowing = 0;

    if (!(block.width > 0) || !(block.height > 0)) {
      notes.push(`${block.label} states no size, so it was drawn as an empty page.`);
      y = MARGIN;
      pageUsed = true;
      return { pageIndex: at, images, overflowing };
    }

    const scale = Math.min(pageWidth / block.width, pageHeight / block.height);
    const offsetX = (pageWidth - block.width * scale) / 2;
    const offsetY = (pageHeight - block.height * scale) / 2;
    /** Canvas x → page x. */
    const toX = (value: number) => offsetX + value * scale;
    /** Canvas y (down from the top) → page y (up from the bottom). */
    const toY = (value: number) => pageHeight - offsetY - value * scale;

    /** Draws wrapped runs inside a box whose top-left is already in page space. */
    const drawBoxText = (
      runs: readonly StyledRun[],
      left: number,
      top: number,
      width: number,
      height: number,
      size: number,
      align: 'left' | 'center' | 'right'
    ): boolean => {
      const lines = wrapRuns(runs, fonts, size, width);
      const lineHeight = size * LINE_RATIO;
      lines.forEach((pieces, index) => {
        if (pieces.length === 0) return;
        const lineWidth = pieces.reduce((sum, piece) => sum + piece.width, 0);
        const slack = Math.max(0, width - lineWidth);
        const x = left + (align === 'center' ? slack / 2 : align === 'right' ? slack : 0);
        drawLine(pieces, x, top - (index + 1) * lineHeight, size);
      });
      // Text taller than its own box is *drawn anyway*, overrunning downward,
      // and counted. Clipping it would delete words the deck contains; shrinking
      // it would be this converter inventing a layout PowerPoint did not state.
      return lines.length * lineHeight > height + 0.5;
    };

    for (const item of block.items) {
      if (item.kind === 'image') {
        const embedded = await embedImage(item.data, item.format, item.id);
        if (!embedded) continue;
        const width = item.width > 0 ? item.width * scale : embedded.width * PX_TO_PT * scale;
        const height = item.height > 0 ? item.height * scale : embedded.height * PX_TO_PT * scale;
        page.drawImage(embedded, { x: toX(item.x), y: toY(item.y) - height, width, height });
        pageUsed = true;
        images += 1;
        continue;
      }

      if (item.kind === 'text') {
        const size = Math.max(1, item.fontSize * scale);
        const width = Math.max(1, item.width * scale);
        if (
          drawBoxText(
            item.runs,
            toX(item.x),
            toY(item.y),
            width,
            Math.max(0, item.height * scale),
            size,
            item.align
          )
        ) {
          overflowing += 1;
        }
        continue;
      }

      // A grid. Column widths are *relative*, normalised to the frame's own
      // width the same way `drawTable` normalises a spreadsheet's — a producer
      // states proportions, and the frame states the total.
      const columnCount = item.rows.reduce((max, row) => Math.max(max, row.length), 0);
      if (columnCount === 0) continue;
      const stated = item.columnWidths.slice(0, columnCount);
      const total = stated.reduce((sum, width) => sum + (width > 0 ? width : 0), 0);
      const frameWidth = Math.max(1, item.width * scale);
      const widths =
        stated.length === columnCount && total > 0
          ? stated.map(width => (Math.max(0, width) / total) * frameWidth)
          : Array.from({ length: columnCount }, () => frameWidth / columnCount);

      const size = Math.max(1, item.fontSize * scale);
      const lineHeight = size * LINE_RATIO;
      let top = toY(item.y);
      const left = toX(item.x);

      for (let rowIndex = 0; rowIndex < item.rows.length; rowIndex++) {
        const row = item.rows[rowIndex];
        const wrapped = row.map((cell, column) =>
          wrapRuns(cell, fonts, size, Math.max(1, widths[column] - CELL_PADDING_X * 2))
        );
        const lineCount = Math.max(1, ...wrapped.map(lines => lines.length));
        // A row states a *minimum* height in OOXML; the drawn height is whatever
        // its own text needs, so no cell is cut off by an optimistic stored one.
        const rowHeight = Math.max(
          (item.rowHeights[rowIndex] ?? 0) * scale,
          textHeight(lineCount, size) + CELL_PADDING_Y * 2
        );
        let x = left;
        for (let column = 0; column < columnCount; column++) {
          page.drawRectangle({
            x,
            y: top - rowHeight,
            width: widths[column],
            height: rowHeight,
            borderColor: RULE_COLOR,
            borderWidth: RULE_WIDTH
          });
          (wrapped[column] ?? []).forEach((pieces, lineIndex) => {
            drawLine(
              pieces,
              x + CELL_PADDING_X,
              top - CELL_PADDING_Y - (lineIndex + 1) * lineHeight,
              size
            );
          });
          x += widths[column];
        }
        pageUsed = true;
        top -= rowHeight;
      }
      if (toY(item.y) - top > item.height * scale + 0.5) overflowing += 1;
    }

    // The page is spoken for either way: an empty canvas is still its own page,
    // and leaving the cursor at the top would let the next flowing block share
    // it. `MARGIN` is "full", which is what `ensure` reads.
    y = MARGIN;
    pageUsed = true;
    return { pageIndex: at, images, overflowing };
  };

  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    await checkpoint(
      job,
      (index / blocks.length) * 0.9,
      `Laying out block ${index + 1} of ${blocks.length}`
    );

    switch (block.kind) {
      case 'heading': {
        const size = HEADING_SIZES[block.level] ?? BODY_SIZE;
        y -= SPACE_BEFORE_HEADING;
        // A heading at the very bottom of a page, with its paragraph overleaf, is
        // the one pagination artefact worth preventing outright.
        ensure(size * LINE_RATIO * 2);
        const bolded = block.runs.map(run => ({ ...run, bold: true }));
        const at = drawWrapped(bolded, size, MARGIN, contentWidth);
        y -= SPACE_AFTER_HEADING;
        outline.push({
          pageIndex: at,
          kind: 'heading',
          level: block.level,
          text: elide(runsToText(block.runs))
        });
        break;
      }

      case 'paragraph': {
        const at = drawWrapped(block.runs, BODY_SIZE, MARGIN, contentWidth);
        y -= SPACE_AFTER_PARAGRAPH;
        outline.push({ pageIndex: at, kind: 'paragraph', text: elide(runsToText(block.runs)) });
        break;
      }

      case 'list-item': {
        const indent = MARGIN + block.depth * LIST_INDENT;
        const at = drawWrapped(
          block.runs,
          BODY_SIZE,
          indent + LIST_MARKER_GAP,
          contentWidth - (indent - MARGIN) - LIST_MARKER_GAP,
          block.marker,
          indent
        );
        y -= SPACE_AFTER_LIST;
        outline.push({
          pageIndex: at,
          kind: 'list-item',
          text: elide(`${block.marker} ${runsToText(block.runs)}`)
        });
        break;
      }

      case 'table': {
        const at = drawTable(block.rows, block.columnWidths);
        outline.push({
          pageIndex: at,
          kind: 'table',
          text:
            `Table, ${block.rows.length} row${block.rows.length === 1 ? '' : 's'} × ` +
            `${block.rows[0]?.length ?? 0} column${block.rows[0]?.length === 1 ? '' : 's'}` +
            (block.rows[0] ? `: ${elide(block.rows[0].map(runsToText).join(' | '))}` : '')
        });
        break;
      }

      case 'canvas': {
        const placed = await drawCanvas(block);
        imageCount += placed.images;
        overflowingBoxes += placed.overflowing;
        outline.push({
          pageIndex: placed.pageIndex,
          kind: 'canvas',
          // The label is the fallback rather than a prefix: a canvas that landed
          // on the wrong page — the failure a mandatory preview exists to catch
          // — is visible from its text, and `p3 · Slide` already names it.
          text: block.text.trim().length > 0 ? elide(block.text) : block.label
        });
        break;
      }

      case 'image': {
        const placed = await drawImage(block);
        if (placed) {
          imageCount += 1;
          outline.push({
            pageIndex: placed.pageIndex,
            kind: 'image',
            text: `Image, ${Math.round(placed.width)} × ${Math.round(placed.height)} pt as placed`
          });
        }
        break;
      }
    }
  }

  if (overflowingBoxes > 0) {
    // Counted rather than silently tolerated: the text *is* in the PDF, but a
    // box drawn taller than the producer sized it can run over what sits below
    // it, and the fonts here are not the fonts the deck asked for — which is
    // the usual reason a box that fitted in PowerPoint does not fit here.
    notes.push(
      `${overflowingBoxes} text box${overflowingBoxes === 1 ? '' : 'es'} hold more text than ` +
        'the original sized them for, because this converter draws with its own fonts. All of ' +
        'that text is in the PDF, but it overruns its box and may overlap what is below it.'
    );
  }

  await checkpoint(job, 0.95, 'Saving the PDF');
  const bytes = await doc.save();

  return {
    bytes,
    pageCount: doc.getPageCount(),
    imageCount,
    outline,
    notes,
    hadUnsupportedCharacters: hadUnsupportedCharacter()
  };
}
