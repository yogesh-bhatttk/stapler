/**
 * CNV-10 — a PDF's pages → a workbook plan.
 *
 * OCR-03 asks its user to pick one page and one region and hands the selection to
 * `extractTableFromPage`. CNV-10 asks nothing: it walks the whole document,
 * decides for itself which lines are tabular, and writes one sheet per table it
 * accepted. Both halves of that are borrowed rather than rewritten —
 * `text-layout.ts`'s `layoutLines` groups runs into lines (the same grouping
 * CNV-04's text export and CNV-08's DOCX export read), and `table-regions.ts`
 * decides which of those lines form a table (the decision CNV-08 wrote and this
 * ticket moved out so both callers share it).
 *
 * Two things are new here, and both exist because a spreadsheet is not a
 * document:
 *
 *  • **Non-table text still has to go somewhere.** The ticket is explicit that a
 *    PDF with no detectable table must produce a usable sheet rather than an
 *    empty or failed export, so every line that is not inside an accepted table
 *    becomes a one-cell row on the page's text sheet. Nothing on a page with a
 *    text layer is dropped without being counted in `skipped`.
 *  • **Cells are strings, always.** See `xlsx-writer.ts`: a PDF's text layer
 *    carries glyphs, not types, and deciding "1,204" is a number is a decision
 *    that silently changes a value.
 */

import { layoutLines, type TextRun } from '../text-layout';
import { findTableRegions } from './table-regions';
import { MAX_CELL_CHARS, uniqueSheetNames, type XlsxSheet } from './xlsx-writer';

/** One page, reduced to what a workbook can hold. */
export interface PageSheetData {
  pageIndex: number;
  /** Each accepted table's grid, in reading order. Header row first. */
  tables: string[][][];
  /** Every line *not* inside an accepted table, in reading order. */
  textLines: string[];
}

/** One row of the preview the user must see before the save button unlocks. */
export interface XlsxPreviewItem {
  pageIndex: number;
  kind: 'table' | 'text';
  /** The sheet's final name, after sanitizing and de-duplication. */
  sheetName: string;
  rowCount: number;
  columnCount: number;
  /**
   * A table's header row, or the text sheet's first line. A mis-clustered table
   * is almost always visibly wrong in its header, which is the whole reason the
   * preview is mandatory.
   */
  text: string;
}

/** What `planWorkbook` decided to write, before any bytes exist. */
export interface WorkbookPlan {
  sheets: XlsxSheet[];
  outline: XlsxPreviewItem[];
  /** How many sheets came from a detected table rather than from page text. */
  tableCount: number;
  /** Everything recognised and deliberately not written, each with its reason. */
  skipped: string[];
}

/**
 * Why a document with no selectable text is refused rather than converted into
 * an empty workbook.
 *
 * This is the scanned-PDF case, and it is the single most likely way someone
 * arrives at this tool with a file it cannot help with. Saying "0 sheets" and
 * writing a file would be the silent failure; naming OCR is the useful answer.
 */
export const NO_TEXT_LAYER_MESSAGE =
  'This PDF has no selectable text, so there is nothing to put in a spreadsheet. It is most ' +
  'likely a scan — run the OCR tool on it first, then convert the result.';

/** Why a workbook with every sheet excluded by the caller's option is refused. */
export const EMPTY_WORKBOOK_MESSAGE =
  'No table was detected in this PDF, and page text is switched off — so there would be nothing ' +
  'in the spreadsheet. Turn "Include page text" back on to export the text instead.';

/** How much of a row the preview shows before eliding it. */
const PREVIEW_TEXT_LIMIT = 160;

function elide(text: string): string {
  return text.length <= PREVIEW_TEXT_LIMIT
    ? text
    : `${text.slice(0, PREVIEW_TEXT_LIMIT - 1).trimEnd()}…`;
}

/**
 * Turns one page's text runs into the tables on it and the lines that are not in
 * one.
 *
 * `pageHeight` is the page's own height in points, needed only to flip pdf.js's
 * y-up baselines into the y-down space OCR-03's clustering works in.
 *
 * Unlike CNV-08's `pageBlocks` this keeps **lines**, not paragraphs: wrapped
 * lines are not merged, because a spreadsheet row is a line and the ticket's
 * acceptance criterion is stated in lines.
 */
export function pageSheet(runs: TextRun[], pageHeight: number, pageIndex: number): PageSheetData {
  const { lines, bodySize } = layoutLines(runs);
  if (lines.length === 0) return { pageIndex, tables: [], textLines: [] };

  const regions = findTableRegions(lines, bodySize, pageHeight);
  const tableAt = new Map(regions.map(region => [region.startLine, region]));

  const tables: string[][][] = [];
  const textLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const region = tableAt.get(i);
    if (region) {
      tables.push(region.rows);
      i = region.endLine;
      continue;
    }
    const text = lines[i].text;
    if (text.length > 0) textLines.push(text);
  }

  return { pageIndex, tables, textLines };
}

/**
 * Decides the sheets, their names and the preview, from the per-page data.
 *
 * Sheet order is document order: for each page, its tables first (a table is what
 * someone converting a PDF to a spreadsheet came for), then that page's
 * remaining text as one sheet. Names are `Page 3 Table 2` / `Page 3 Text`, which
 * fit Excel's 31-character limit for any page count this product can open;
 * `buildXlsx` sanitizes and de-duplicates them anyway.
 *
 * With `includePageText` off, non-table lines are counted into `skipped` rather
 * than vanishing — the count is what the panel shows.
 */
export function planWorkbook(
  pages: readonly PageSheetData[],
  includePageText: boolean
): WorkbookPlan {
  const drafts: { name: string; rows: string[][]; item: Omit<XlsxPreviewItem, 'sheetName'> }[] = [];
  const skipped: string[] = [];
  let tableCount = 0;
  let truncatedCells = 0;

  const capped = (cell: string): string => {
    if (cell.length <= MAX_CELL_CHARS) return cell;
    truncatedCells += 1;
    return cell.slice(0, MAX_CELL_CHARS);
  };

  for (const page of pages) {
    const human = page.pageIndex + 1;

    page.tables.forEach((rows, index) => {
      const name =
        page.tables.length === 1 ? `Page ${human} Table` : `Page ${human} Table ${index + 1}`;
      const grid = rows.map(row => row.map(capped));
      tableCount += 1;
      drafts.push({
        name,
        rows: grid,
        item: {
          pageIndex: page.pageIndex,
          kind: 'table',
          rowCount: grid.length,
          columnCount: grid.reduce((max, row) => Math.max(max, row.length), 0),
          text: elide((grid[0] ?? []).join(' | '))
        }
      });
    });

    if (page.textLines.length === 0) continue;

    if (!includePageText) {
      skipped.push(
        `Page ${human}: ${page.textLines.length} line(s) of text outside a table were left out ` +
          'because "Include page text" is off.'
      );
      continue;
    }

    const rows = page.textLines.map(line => [capped(line)]);
    drafts.push({
      name: `Page ${human} Text`,
      rows,
      item: {
        pageIndex: page.pageIndex,
        kind: 'text',
        rowCount: rows.length,
        columnCount: 1,
        text: elide(page.textLines[0])
      }
    });
  }

  if (truncatedCells > 0) {
    // Excel's own cap, not ours. Saying nothing would be a silent edit of the
    // user's content, which is the one thing this codebase never does.
    skipped.push(
      `${truncatedCells} cell(s) were longer than Excel's ${MAX_CELL_CHARS}-character limit and ` +
        'were truncated to fit.'
    );
  }

  // Resolve the names *here*, from the same function `buildXlsx` uses, so the
  // preview cannot name a sheet the file does not carry. Running it twice is
  // harmless: it is idempotent over a list it has already resolved.
  const names = uniqueSheetNames(drafts.map(draft => draft.name));
  const sheets: XlsxSheet[] = drafts.map((draft, i) => ({ name: names[i], rows: draft.rows }));
  const outline: XlsxPreviewItem[] = drafts.map((draft, i) => ({
    ...draft.item,
    sheetName: names[i]
  }));

  return { sheets, outline, tableCount, skipped };
}

/** True when the document had no text layer at all — a scan, most likely. */
export function hasNoText(pages: readonly PageSheetData[]): boolean {
  return pages.every(page => page.tables.length === 0 && page.textLines.length === 0);
}
