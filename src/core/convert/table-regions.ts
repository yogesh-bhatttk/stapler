/**
 * "Which lines on this page belong to a table at all?" — shared by CNV-08's
 * `blocks.ts` and CNV-10's `sheets.ts`.
 *
 * OCR-03's `extractTableFromPage` answers a different question. Its user
 * hand-picks a page (and a region on it) and gets the whole selection back as one
 * grid, so it never has to decide where a table *starts*. CNV-08 needed that
 * decision and wrote it inline inside `pageBlocks`; CNV-10 needs the identical
 * decision over the identical input, so it lives here rather than being written a
 * second time. The clustering that turns a run of lines into a grid is still
 * OCR-03's — nothing about the algorithm is duplicated, only the question that
 * precedes it.
 *
 * The extraction is deliberately behaviour-preserving: the thresholds, the
 * heading exclusion and the `rejectedTableEnd` guard below are CNV-08's own, moved
 * verbatim. `blocks.ts`'s table tests are the regression cover for that move.
 */

import { extractTableFromPage, type TableTextItem } from '../ocr/table-extract';
import type { LaidOutLine, TextRun } from '../text-layout';

/**
 * A cell boundary is a horizontal gap this many times the body type size.
 *
 * `layoutText` treats a gap of 0.25× the type size as "the producer split a run
 * where a space belongs" — three points at 12pt. A table column gap is an order
 * of magnitude larger than that, and the threshold has to stay far above the
 * widest *word* space a justified paragraph can stretch to (roughly 1× the type
 * size in practice) or every justified line would be read as a two-column table.
 */
const CELL_GAP_RATIO = 2.5;

/** A table needs at least this many consecutive tabular lines to be one. */
const MIN_TABLE_ROWS = 2;

/** …and at least this many columns, or it is just an indented line. */
const MIN_TABLE_COLUMNS = 2;

/** One accepted table: the lines it covers and the grid they clustered into. */
export interface TableRegion {
  /** Index of the region's first line in the page's `LaidOutLine[]`. */
  startLine: number;
  /** Index of its last line, inclusive. */
  endLine: number;
  /** OCR-03's grid, header row first. */
  rows: string[][];
  columnCount: number;
}

/**
 * Splits one line into cell-sized groups on wide horizontal gaps.
 *
 * Returns the runs per group rather than strings, so the caller can hand the
 * original positioned items to OCR-03's clustering (which needs x/width) and
 * still know how many columns it saw.
 */
function splitLineCells(line: LaidOutLine, bodySize: number): TextRun[][] {
  const minGap = Math.max(1, bodySize) * CELL_GAP_RATIO;
  const groups: TextRun[][] = [];
  let previous: TextRun | null = null;

  for (const run of line.runs) {
    // pdf.js emits a standalone whitespace item where it broke a chunk on a wide
    // gap. It carries the gap's own width, so counting it as content would make
    // the gap look like a filled cell.
    if (run.str.trim().length === 0) continue;
    const gap = previous ? run.transform[4] - (previous.transform[4] + previous.width) : 0;
    if (!previous || gap > minGap) groups.push([run]);
    else groups[groups.length - 1].push(run);
    previous = run;
  }

  return groups;
}

/** pdf.js run → the y-down shape OCR-03's clustering expects. */
function toTableItem(run: TextRun, pageHeight: number): TableTextItem {
  const height = Math.abs(run.transform[3]) || run.height || 10;
  return {
    text: run.str,
    x: run.transform[4],
    y: Math.max(0, pageHeight - run.transform[5]),
    width: run.width,
    height
  };
}

/**
 * A line is tabular when wide gaps split it into two or more cells *and* it is
 * not a heading. A heading is excluded on purpose: a two-word centred title with
 * a wide letter-space would otherwise start a table and swallow the paragraphs
 * under it.
 */
function tabularColumns(line: LaidOutLine, bodySize: number): number {
  if (line.isHeading) return 0;
  return splitLineCells(line, bodySize).length;
}

/**
 * Every table on one page, in reading order, as line ranges plus their grids.
 *
 * `pageHeight` is the page's own height in points, needed only to flip pdf.js's
 * y-up baselines into the y-down space OCR-03's clustering works in.
 *
 * A candidate range that the clustering does *not* agree is a table is simply not
 * returned — the caller keeps those lines as ordinary text. Falling through is
 * always the safe answer here: the text stays in the output either way, it just
 * is not in a grid.
 */
export function findTableRegions(
  lines: readonly LaidOutLine[],
  bodySize: number,
  pageHeight: number
): TableRegion[] {
  const columns = lines.map(line => tabularColumns(line, bodySize));
  const regions: TableRegion[] = [];

  // Once a run [i, end] has been scanned and rejected as a table, later indices
  // inside that same range must not re-trigger the scan: each of them still
  // looks tabular by the cheap column-count check alone, so without this guard
  // a long run that never clusters into a real grid gets re-scanned once per
  // line, one line shorter each time — quadratic work on an adversarial page
  // (e.g. an inconsistently-aligned two-column layout).
  let rejectedTableEnd = -1;

  for (let i = 0; i < lines.length; i++) {
    if (columns[i] < MIN_TABLE_COLUMNS || i <= rejectedTableEnd) continue;

    // A run of consecutive lines that each split into enough cells is a table.
    // `startsParagraph` deliberately does not break the run: a table with extra
    // leading between its rows is still one table.
    let end = i;
    while (end + 1 < lines.length && columns[end + 1] >= MIN_TABLE_COLUMNS) end += 1;

    if (end - i + 1 >= MIN_TABLE_ROWS) {
      const items: TableTextItem[] = [];
      for (let r = i; r <= end; r++) {
        for (const run of lines[r].runs) {
          if (run.str.trim().length === 0) continue;
          items.push(toTableItem(run, pageHeight));
        }
      }
      const grid = extractTableFromPage(items);
      if (grid.rowCount > 0 && grid.columnCount >= MIN_TABLE_COLUMNS) {
        regions.push({
          startLine: i,
          endLine: end,
          rows: grid.rows,
          columnCount: grid.columnCount
        });
        i = end;
        continue;
      }
    }

    rejectedTableEnd = end;
  }

  return regions;
}
