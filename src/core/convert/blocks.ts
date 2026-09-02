/**
 * CNV-08 — the generalized block model, and the pure PDF-page → blocks pass.
 *
 * A PDF has no paragraphs, no headings and no tables. It has positioned glyphs
 * and positioned images. Everything in this file is therefore a *heuristic* over
 * geometry, and the ticket says so out loud: structure and text are preserved,
 * exact fonts, columns and pagination are not. The tool ships labelled beta with
 * a mandatory preview (PLAN §5.5) precisely because this file is guessing.
 *
 * What is deliberately *not* re-invented here:
 *
 *  • Line grouping, paragraph breaks and the heading promotion all come from
 *    `text-layout.ts`'s `layoutLines` — the same function CNV-04's text/Markdown
 *    export reads. A second copy of "is this line a heading" would drift from
 *    CNV-05's on the first tuning change.
 *  • Table *grids* are built by OCR-03's `extractTableFromPage`, the clustering
 *    that already ships for the table→XLSX export. The question OCR-03 never
 *    asked — "which lines on this page are part of a table at all", since its
 *    user hand-picks a page and gets the whole page as one grid — was new here,
 *    and now lives in `table-regions.ts` because CNV-10 asks it too, of the same
 *    input. This file consumes that answer; it does not decide it.
 *  • Image bytes come from CNV-06's `extractImages`, which hands over the
 *    embedded XObject's own bytes and never re-encodes. This file only decides
 *    where an image block goes and how big to draw it.
 */

import { layoutLines, type TextRun } from '../text-layout';
import { findTableRegions } from './table-regions';
// Type-only: `process.worker.ts` calls `Comlink.expose` at import time, so this
// must never become a runtime import.
import type { ExtractedImageEntry } from '../workers/process.worker';

/** A run of text with the two attributes a DOCX run can actually carry. */
export interface DocxRun {
  text: string;
  bold: boolean;
  italic: boolean;
}

/**
 * A pdf.js text run plus what its font descriptor said about weight and slant.
 * `bold`/`italic` are `false` when the font could not be resolved — never
 * guessed from the glyphs.
 */
export interface FormattedRun extends TextRun {
  bold?: boolean;
  italic?: boolean;
}

/** The image formats a DOCX `ImageRun` can embed. Anything else is refused. */
export type DocxImageFormat = 'png' | 'jpg';

export type DocxBlock =
  | { kind: 'heading'; level: 1 | 2; runs: DocxRun[] }
  | { kind: 'paragraph'; runs: DocxRun[] }
  | { kind: 'table'; rows: string[][] }
  | {
      kind: 'image';
      data: Uint8Array;
      format: DocxImageFormat;
      /** Display size in pixels at 96 DPI, already fitted to the text column. */
      width: number;
      height: number;
      altText: string;
    };

export interface DocxPage {
  pageIndex: number;
  blocks: DocxBlock[];
}

export interface DocxModel {
  /** Document title, written into the DOCX core properties. */
  title: string;
  pages: DocxPage[];
  /**
   * Everything that was recognised but deliberately not converted, each with the
   * reason. Surfaced in the UI: a silently dropped image is the failure mode this
   * product's error philosophy exists to prevent.
   */
  skipped: string[];
}

/**
 * Word's default Letter page with 1" margins leaves 6.5" of text column, which
 * is 624px at the 96 DPI a DOCX `ImageRun` transformation is measured in. An
 * image wider than that is scaled down; a smaller one is left at its own size,
 * because upscaling a 64px logo to fill the column would be a worse guess than
 * leaving it alone.
 */
const DOCX_CONTENT_WIDTH_PX = 624;

/** Tallest image we place, so one oversized scan cannot become a 20-page block. */
const DOCX_MAX_IMAGE_HEIGHT_PX = 800;

/**
 * Fits an image's intrinsic pixel size into the text column, preserving aspect.
 * Never scales up.
 */
export function fitImage(width: number, height: number): { width: number; height: number } | null {
  if (!(width > 0) || !(height > 0)) return null;
  const scale = Math.min(1, DOCX_CONTENT_WIDTH_PX / width, DOCX_MAX_IMAGE_HEIGHT_PX / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  };
}

/**
 * Where a promoted heading becomes level 1 rather than level 2 — above CNV-05's
 * own 1.25 promotion threshold by design, so everything between the two reads as
 * a subheading. The Markdown export has one heading level and always writes
 * `##`; DOCX has real levels, so this is the one extra distinction worth drawing,
 * and it is drawn from the same measurement rather than a new one.
 */
const HEADING_LEVEL_1_RATIO = 1.6;

/** The runs of a line, joined into DOCX runs with adjacent same-format runs merged. */
export function lineRuns(runs: readonly FormattedRun[]): DocxRun[] {
  const out: DocxRun[] = [];
  let previous: FormattedRun | null = null;

  for (const run of runs) {
    const text = run.str;
    if (text.length === 0) continue;
    const bold = run.bold === true;
    const italic = run.italic === true;
    const last = out[out.length - 1];

    // Reinstate the space the producer implied by position rather than by a space
    // character — the same rule `layoutText` applies, so the DOCX and the plain
    // text export never disagree about word boundaries.
    let separator = '';
    if (previous) {
      const gap = run.transform[4] - (previous.transform[4] + previous.width);
      if (gap > Math.abs(run.transform[3]) * 0.25) separator = ' ';
    }

    if (last && last.bold === bold && last.italic === italic) {
      last.text += separator + text;
    } else {
      out.push({ text: separator + text, bold, italic });
    }
    previous = run;
  }

  // Collapse the runs of whitespace `layoutText` collapses, then drop anything
  // that turned out to be blank. Trimming only the outermost edges keeps the
  // single space between a bold run and the word after it.
  const collapsed = out
    .map(run => ({ ...run, text: run.text.replace(/\s+/g, ' ') }))
    .filter(run => run.text.length > 0);
  if (collapsed.length > 0) {
    collapsed[0].text = collapsed[0].text.replace(/^\s+/, '');
    const last = collapsed[collapsed.length - 1];
    last.text = last.text.replace(/\s+$/, '');
  }
  return collapsed.filter(run => run.text.length > 0);
}

/**
 * Turns one page's runs into blocks.
 *
 * `pageHeight` is the page's own height in points, needed only to flip pdf.js's
 * y-up baselines into the y-down space OCR-03's clustering works in.
 */
export function pageBlocks(runs: FormattedRun[], pageHeight: number): DocxBlock[] {
  const { lines, bodySize } = layoutLines(runs);
  if (lines.length === 0) return [];

  // Table detection is `table-regions.ts`'s, shared with CNV-10. A range the
  // clustering did not accept is simply not returned, and its lines fall through
  // to the paragraph path below — the safe answer, since the text is in the
  // output either way, just not in a grid.
  const tableAt = new Map(findTableRegions(lines, bodySize, pageHeight).map(r => [r.startLine, r]));
  const blocks: DocxBlock[] = [];

  for (let i = 0; i < lines.length; i++) {
    const table = tableAt.get(i);
    if (table) {
      blocks.push({ kind: 'table', rows: table.rows });
      i = table.endLine;
      continue;
    }

    const line = lines[i];
    const docxRuns = lineRuns(line.runs);
    if (docxRuns.length === 0) continue;

    if (line.isHeading) {
      blocks.push({
        kind: 'heading',
        level: line.maxSize >= bodySize * HEADING_LEVEL_1_RATIO ? 1 : 2,
        runs: docxRuns
      });
      continue;
    }

    // Wrapped lines of one paragraph become one paragraph, so Word can reflow
    // them. A paragraph break — or a heading, or a table — ends it.
    const previous = blocks[blocks.length - 1];
    if (!line.startsParagraph && previous?.kind === 'paragraph') {
      const tail = previous.runs[previous.runs.length - 1];
      const head = docxRuns[0];
      if (tail && head && tail.bold === head.bold && tail.italic === head.italic) {
        tail.text += ` ${head.text}`;
        previous.runs.push(...docxRuns.slice(1));
      } else {
        if (tail) tail.text += ' ';
        previous.runs.push(...docxRuns);
      }
      continue;
    }

    blocks.push({ kind: 'paragraph', runs: docxRuns });
  }

  return blocks;
}

/**
 * Places CNV-06's extracted images into the block model, one per page, after that
 * page's text. Returns how many were embedded.
 *
 * Position within the page is deliberately not reconstructed: CNV-06 reports an
 * image's *resource* order, not where the content stream draws it, and inventing
 * a y-position would put an image in a plausible-looking but wrong place. A
 * limitation the tool states is better than a guess it hides.
 *
 * Everything refused is appended to `skipped` with the reason CNV-06 gave, so a
 * JBIG2 or JPEG 2000 image the PDF still holds is reported rather than silently
 * absent from the Word file.
 *
 * @param entries CNV-06's per-image report.
 * @param files   The ZIP it produced, already unzipped: name → bytes.
 */
export function attachImageBlocks(
  pages: DocxPage[],
  entries: readonly ExtractedImageEntry[],
  files: Record<string, Uint8Array>,
  skipped: string[]
): number {
  const byPage = new Map(pages.map(page => [page.pageIndex, page]));
  let count = 0;

  for (const entry of entries) {
    const where = `Page ${entry.pageIndex + 1}`;

    if (entry.status === 'skipped' || !entry.fileName) {
      skipped.push(`${where}: ${entry.note ?? 'an image could not be read and was left out.'}`);
      continue;
    }

    const format = docxImageFormat(entry.fileName);
    if (!format) {
      // JPEG 2000 is the live case: CNV-06 hands over the `.jp2` codestream
      // untouched and Word cannot embed one. Re-encoding it here would mean
      // decoding a format pdf.js itself often cannot decode.
      const ext = entry.fileName.replace(/^.*\./, '');
      skipped.push(
        `${where}: an image in ${ext} format cannot be embedded in a Word document. It was ` +
          'left out; the PDF still has it.'
      );
      continue;
    }

    const data = files[entry.fileName];
    const size = fitImage(entry.width, entry.height);
    if (!data || data.length === 0 || !size) {
      skipped.push(`${where}: an image could not be read and was left out.`);
      continue;
    }

    const page = byPage.get(entry.pageIndex);
    // An image on a page the caller did not ask to convert is not an error.
    if (!page) continue;

    page.blocks.push({
      kind: 'image',
      data,
      format,
      width: size.width,
      height: size.height,
      altText: `Image from page ${entry.pageIndex + 1}`
    });
    count += 1;

    if (entry.maskFileName) {
      // The colour image is embedded; its transparency is a separate PDF object
      // that neither a JPEG nor this writer carries across.
      skipped.push(
        `${where}: an image's transparency mask was not carried into Word, so it appears ` +
          'fully opaque.'
      );
    }
  }

  return count;
}

/** The two formats a DOCX `ImageRun` accepts, from CNV-06's file extension. */
function docxImageFormat(fileName: string): DocxImageFormat | null {
  if (/\.png$/i.test(fileName)) return 'png';
  if (/\.jpe?g$/i.test(fileName)) return 'jpg';
  return null;
}

/* ------------------------------------------------------------------ *
 * The mandatory preview (PLAN §5.5)
 * ------------------------------------------------------------------ */

/**
 * One row of the preview the user must see before the save button unlocks.
 *
 * Deliberately *not* the block model itself: a preview that carried every
 * image's bytes into the UI would copy tens of megabytes across for something
 * that renders as one line of text. This is a description of what was produced,
 * derived from the very model the `.docx` was written from — so what the preview
 * claims and what the file contains cannot disagree.
 */
export interface DocxPreviewItem {
  pageIndex: number;
  kind: DocxBlock['kind'];
  /** Heading level, for a heading. */
  level?: 1 | 2;
  /** The block's text, or a size summary for a table or an image. */
  text: string;
}

/** How much of a paragraph the preview shows before eliding it. */
const PREVIEW_TEXT_LIMIT = 160;

function elide(text: string): string {
  return text.length <= PREVIEW_TEXT_LIMIT
    ? text
    : `${text.slice(0, PREVIEW_TEXT_LIMIT - 1).trimEnd()}…`;
}

/** Describes the model that was just written, block by block, in output order. */
export function previewOutline(pages: readonly DocxPage[]): DocxPreviewItem[] {
  const out: DocxPreviewItem[] = [];
  for (const page of pages) {
    for (const block of page.blocks) {
      switch (block.kind) {
        case 'heading':
          out.push({
            pageIndex: page.pageIndex,
            kind: 'heading',
            level: block.level,
            text: elide(block.runs.map(run => run.text).join(''))
          });
          break;
        case 'paragraph':
          out.push({
            pageIndex: page.pageIndex,
            kind: 'paragraph',
            text: elide(block.runs.map(run => run.text).join(''))
          });
          break;
        case 'table': {
          const columns = block.rows.reduce((max, row) => Math.max(max, row.length), 0);
          out.push({
            pageIndex: page.pageIndex,
            kind: 'table',
            // The first row is shown because a mis-clustered table is almost
            // always visibly wrong in its header, which is the whole point of
            // making the preview mandatory.
            text:
              `Table, ${block.rows.length} row${block.rows.length === 1 ? '' : 's'} × ` +
              `${columns} column${columns === 1 ? '' : 's'}` +
              (block.rows[0] ? `: ${elide(block.rows[0].join(' | '))}` : '')
          });
          break;
        }
        case 'image':
          out.push({
            pageIndex: page.pageIndex,
            kind: 'image',
            text: `Image, ${block.width} × ${block.height} px as placed`
          });
          break;
      }
    }
  }
  return out;
}
