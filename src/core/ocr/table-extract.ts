import { strToU8, zipSync } from 'fflate';

/** Item extracted from page text layer with position coordinates. */
export interface TableTextItem {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Structured table representation extracted from a page. */
export interface TableGridData {
  rows: string[][];
  headers: string[];
  rowCount: number;
  columnCount: number;
}

/**
 * Infer columns and rows from page text x/y positions (OCR-03).
 * Clusters items into rows by y-coordinate tolerance and columns by x-coordinate alignment.
 */
export function extractTableFromPage(pageTextItems: TableTextItem[]): TableGridData {
  const validItems = pageTextItems
    .map(item => ({ ...item, text: item.text.trim() }))
    .filter(item => item.text.length > 0);

  if (validItems.length === 0) {
    return { rows: [], headers: [], rowCount: 0, columnCount: 0 };
  }

  const heights = validItems.map(i => Math.abs(i.height)).filter(h => h > 0);
  heights.sort((a, b) => a - b);
  const medianHeight = heights.length > 0 ? heights[Math.floor(heights.length / 2)] : 10;
  const yTolerance = Math.max(3, medianHeight * 0.5);

  const sortedItems = [...validItems].sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y));

  const rowGroups: { y: number; items: TableTextItem[] }[] = [];
  for (const item of sortedItems) {
    const existingRow = rowGroups.find(r => Math.abs(r.y - item.y) <= yTolerance);
    if (existingRow) {
      existingRow.items.push(item);
      existingRow.y =
        (existingRow.y * (existingRow.items.length - 1) + item.y) / existingRow.items.length;
    } else {
      rowGroups.push({ y: item.y, items: [item] });
    }
  }

  rowGroups.sort((a, b) => a.y - b.y);

  const maxWordGap = Math.max(8, medianHeight * 0.6);
  const processedRows: TableTextItem[][] = [];

  for (const rowGroup of rowGroups) {
    rowGroup.items.sort((a, b) => a.x - b.x);
    const merged: TableTextItem[] = [];

    for (const item of rowGroup.items) {
      if (merged.length === 0) {
        merged.push({ ...item });
      } else {
        const last = merged[merged.length - 1];
        const gap = item.x - (last.x + last.width);
        if (gap <= maxWordGap) {
          last.text += ' ' + item.text;
          last.width = Math.max(last.width, item.x + item.width - last.x);
          last.height = Math.max(last.height, item.height);
        } else {
          merged.push({ ...item });
        }
      }
    }
    processedRows.push(merged);
  }

  interface ColumnCluster {
    minX: number;
    maxX: number;
    avgLeft: number;
    avgRight: number;
    rows: Set<number>;
  }

  const columns: ColumnCluster[] = [];

  for (let rIdx = 0; rIdx < processedRows.length; rIdx++) {
    const row = processedRows[rIdx];
    for (const item of row) {
      const itemRight = item.x + item.width;

      let bestCluster: ColumnCluster | null = null;
      let bestScore = -Infinity;

      for (const col of columns) {
        if (col.rows.has(rIdx)) continue;

        const overlap = Math.max(0, Math.min(itemRight, col.maxX) - Math.max(item.x, col.minX));
        const leftDiff = Math.abs(item.x - col.avgLeft);
        const rightDiff = Math.abs(itemRight - col.avgRight);

        const alignTolerance = Math.max(20, medianHeight * 2);

        if (overlap > 0 || leftDiff <= alignTolerance || rightDiff <= alignTolerance) {
          const score = 1000 - Math.min(leftDiff, rightDiff) + overlap;
          if (score > bestScore) {
            bestScore = score;
            bestCluster = col;
          }
        }
      }

      if (bestCluster) {
        bestCluster.rows.add(rIdx);
        bestCluster.minX = Math.min(bestCluster.minX, item.x);
        bestCluster.maxX = Math.max(bestCluster.maxX, itemRight);
        const count = bestCluster.rows.size;
        bestCluster.avgLeft = (bestCluster.avgLeft * (count - 1) + item.x) / count;
        bestCluster.avgRight = (bestCluster.avgRight * (count - 1) + itemRight) / count;
      } else {
        columns.push({
          minX: item.x,
          maxX: itemRight,
          avgLeft: item.x,
          avgRight: itemRight,
          rows: new Set([rIdx])
        });
      }
    }
  }

  columns.sort((a, b) => a.avgLeft - b.avgLeft);

  const mergedColumns: ColumnCluster[] = [];
  for (const col of columns) {
    if (mergedColumns.length === 0) {
      mergedColumns.push(col);
    } else {
      const prev = mergedColumns[mergedColumns.length - 1];
      const gap = col.avgLeft - prev.avgRight;

      let hasRowConflict = false;
      for (const r of col.rows) {
        if (prev.rows.has(r)) {
          hasRowConflict = true;
          break;
        }
      }

      if (!hasRowConflict && gap <= 5) {
        for (const r of col.rows) prev.rows.add(r);
        prev.minX = Math.min(prev.minX, col.minX);
        prev.maxX = Math.max(prev.maxX, col.maxX);
        prev.avgLeft = (prev.avgLeft + col.avgLeft) / 2;
        prev.avgRight = (prev.avgRight + col.avgRight) / 2;
      } else {
        mergedColumns.push(col);
      }
    }
  }

  const numRows = processedRows.length;
  const numCols = Math.max(1, mergedColumns.length);

  const gridRows: string[][] = Array.from({ length: numRows }, () => Array(numCols).fill(''));

  for (let rIdx = 0; rIdx < processedRows.length; rIdx++) {
    const row = processedRows[rIdx];
    for (const item of row) {
      const itemRight = item.x + item.width;
      let bestColIdx = 0;
      let bestDist = Infinity;

      for (let cIdx = 0; cIdx < mergedColumns.length; cIdx++) {
        const col = mergedColumns[cIdx];
        const dist = Math.min(Math.abs(item.x - col.avgLeft), Math.abs(itemRight - col.avgRight));
        if (dist < bestDist) {
          bestDist = dist;
          bestColIdx = cIdx;
        }
      }

      if (gridRows[rIdx][bestColIdx]) {
        gridRows[rIdx][bestColIdx] += ' ' + item.text;
      } else {
        gridRows[rIdx][bestColIdx] = item.text;
      }
    }
  }

  const headers = gridRows.length > 0 ? gridRows[0] : [];

  return {
    rows: gridRows,
    headers,
    rowCount: gridRows.length,
    columnCount: numCols
  };
}

export function exportTableToCsv(grid: TableGridData): string {
  return grid.rows
    .map(row =>
      row
        .map(cell => {
          if (
            cell.includes(',') ||
            cell.includes('"') ||
            cell.includes('\n') ||
            cell.includes('\r')
          ) {
            return `"${cell.replace(/"/g, '""')}"`;
          }
          return cell;
        })
        .join(',')
    )
    .join('\n');
}

export function exportTableToTsv(grid: TableGridData): string {
  return grid.rows
    .map(row => row.map(cell => cell.replace(/\t/g, ' ').replace(/[\r\n]+/g, ' ')).join('\t'))
    .join('\n');
}

export function exportTableToXlsx(grid: TableGridData): Uint8Array {
  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`;

  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const workbookRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Sheet1" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`;

  const sheetRowsXml = grid.rows
    .map((row, rIdx) => {
      const rowNum = rIdx + 1;
      const cellsXml = row
        .map((cell, cIdx) => {
          if (!cell) return '';
          const ref = `${getColRef(cIdx)}${rowNum}`;
          return `<c r="${ref}" t="inlineStr"><is><t>${xmlEscape(cell)}</t></is></c>`;
        })
        .join('');
      return `<row r="${rowNum}">${cellsXml}</row>`;
    })
    .join('');

  const sheet1Xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>${sheetRowsXml}</sheetData>
</worksheet>`;

  return zipSync({
    '[Content_Types].xml': strToU8(contentTypesXml),
    '_rels/.rels': strToU8(relsXml),
    'xl/_rels/workbook.xml.rels': strToU8(workbookRelsXml),
    'xl/workbook.xml': strToU8(workbookXml),
    'xl/worksheets/sheet1.xml': strToU8(sheet1Xml)
  });
}

function xmlEscape(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function getColRef(colIndex: number): string {
  let temp = colIndex;
  let letter = '';
  while (temp >= 0) {
    letter = String.fromCharCode((temp % 26) + 65) + letter;
    temp = Math.floor(temp / 26) - 1;
  }
  return letter;
}
