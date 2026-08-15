import { describe, expect, it } from 'vitest';
import {
  extractTableFromPage,
  exportTableToCsv,
  exportTableToTsv,
  exportTableToXlsx,
  TableTextItem,
  TableGridData
} from '../../src/core/ocr/table-extract';

describe('ocr/table-extract', () => {
  describe('extractTableFromPage', () => {
    it('returns empty grid data when given empty or whitespace text items', () => {
      const result1 = extractTableFromPage([]);
      expect(result1.rowCount).toBe(0);
      expect(result1.columnCount).toBe(0);
      expect(result1.rows).toEqual([]);

      const result2 = extractTableFromPage([
        { text: '  ', x: 10, y: 10, width: 20, height: 10 },
        { text: '\n', x: 30, y: 10, width: 20, height: 10 }
      ]);
      expect(result2.rowCount).toBe(0);
      expect(result2.columnCount).toBe(0);
    });

    it('extracts bank-statement fixture with correct row and column alignment', () => {
      // Simulated bank statement text layer items
      const items: TableTextItem[] = [
        // Header Row (y = 50)
        { text: 'Date', x: 40, y: 50, width: 30, height: 12 },
        { text: 'Description', x: 140, y: 50, width: 70, height: 12 },
        { text: 'Amount', x: 320, y: 50, width: 45, height: 12 },
        { text: 'Balance', x: 450, y: 50, width: 45, height: 12 },

        // Row 1 (y = 80)
        { text: '2026-08-01', x: 40, y: 80, width: 60, height: 12 },
        { text: 'Payroll', x: 140, y: 80, width: 40, height: 12 },
        { text: 'Direct', x: 185, y: 80, width: 35, height: 12 }, // adjacent run to merge into 'Payroll Direct'
        { text: '+$2,500.00', x: 320, y: 80, width: 65, height: 12 },
        { text: '$2,500.00', x: 450, y: 80, width: 60, height: 12 },

        // Row 2 (y = 110)
        { text: '2026-08-02', x: 40, y: 110, width: 60, height: 12 },
        { text: 'Coffee', x: 140, y: 110, width: 35, height: 12 },
        { text: 'Shop', x: 180, y: 110, width: 25, height: 12 },
        { text: '-$4.50', x: 320, y: 110, width: 35, height: 12 },
        { text: '$2,495.50', x: 450, y: 110, width: 60, height: 12 },

        // Row 3 (y = 140)
        { text: '2026-08-03', x: 40, y: 140, width: 60, height: 12 },
        { text: 'Grocery Store', x: 140, y: 140, width: 75, height: 12 },
        { text: '-$62.30', x: 320, y: 140, width: 40, height: 12 },
        { text: '$2,433.20', x: 450, y: 140, width: 60, height: 12 }
      ];

      const grid = extractTableFromPage(items);

      expect(grid.rowCount).toBe(4);
      expect(grid.columnCount).toBe(4);

      // Verify Headers
      expect(grid.rows[0]).toEqual(['Date', 'Description', 'Amount', 'Balance']);

      // Verify Data Rows
      expect(grid.rows[1]).toEqual(['2026-08-01', 'Payroll Direct', '+$2,500.00', '$2,500.00']);
      expect(grid.rows[2]).toEqual(['2026-08-02', 'Coffee Shop', '-$4.50', '$2,495.50']);
      expect(grid.rows[3]).toEqual(['2026-08-03', 'Grocery Store', '-$62.30', '$2,433.20']);
    });

    it('handles sparse cells where some rows miss optional column values', () => {
      const items: TableTextItem[] = [
        // Row 0
        { text: 'ID', x: 20, y: 20, width: 15, height: 10 },
        { text: 'Name', x: 100, y: 20, width: 30, height: 10 },
        { text: 'Status', x: 200, y: 20, width: 40, height: 10 },

        // Row 1 (all columns)
        { text: '1', x: 20, y: 40, width: 10, height: 10 },
        { text: 'Alice', x: 100, y: 40, width: 30, height: 10 },
        { text: 'Active', x: 200, y: 40, width: 35, height: 10 },

        // Row 2 (missing Status)
        { text: '2', x: 20, y: 60, width: 10, height: 10 },
        { text: 'Bob', x: 100, y: 60, width: 25, height: 10 }
      ];

      const grid = extractTableFromPage(items);
      expect(grid.rowCount).toBe(3);
      expect(grid.columnCount).toBe(3);
      expect(grid.rows[1]).toEqual(['1', 'Alice', 'Active']);
      expect(grid.rows[2]).toEqual(['2', 'Bob', '']);
    });
  });

  describe('exportTableToCsv', () => {
    it('formats plain table rows as comma-separated values', () => {
      const grid: TableGridData = {
        rows: [
          ['Name', 'Age', 'City'],
          ['Alice', '30', 'New York'],
          ['Bob', '25', 'London']
        ],
        headers: ['Name', 'Age', 'City'],
        rowCount: 3,
        columnCount: 3
      };

      const csv = exportTableToCsv(grid);
      expect(csv).toBe('Name,Age,City\nAlice,30,New York\nBob,25,London');
    });

    it('escapes cells containing commas, quotes, or newlines', () => {
      const grid: TableGridData = {
        rows: [
          ['Header 1', 'Header 2'],
          ['Smith, John', 'Quote: "Hello"'],
          ['Line 1\nLine 2', 'Simple']
        ],
        headers: ['Header 1', 'Header 2'],
        rowCount: 3,
        columnCount: 2
      };

      const csv = exportTableToCsv(grid);
      expect(csv).toBe(
        'Header 1,Header 2\n"Smith, John","Quote: ""Hello"""\n"Line 1\nLine 2",Simple'
      );
    });
  });

  describe('exportTableToTsv', () => {
    it('formats rows with tab delimiters and sanitises inner tabs/newlines', () => {
      const grid: TableGridData = {
        rows: [
          ['Col A', 'Col B'],
          ['Val\t1', 'Val 2\nLine 2']
        ],
        headers: ['Col A', 'Col B'],
        rowCount: 2,
        columnCount: 2
      };

      const tsv = exportTableToTsv(grid);
      expect(tsv).toBe('Col A\tCol B\nVal 1\tVal 2 Line 2');
    });
  });

  describe('exportTableToXlsx', () => {
    it('generates a valid binary XLSX zip file buffer', () => {
      const grid: TableGridData = {
        rows: [
          ['Date', 'Amount'],
          ['2026-01-01', '$100.00']
        ],
        headers: ['Date', 'Amount'],
        rowCount: 2,
        columnCount: 2
      };

      const bytes = exportTableToXlsx(grid);
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(bytes.length).toBeGreaterThan(100);

      // PK zip header magic bytes: 0x50, 0x4B, 0x03, 0x04 ('PK\x03\x04')
      expect(bytes[0]).toBe(0x50);
      expect(bytes[1]).toBe(0x4b);
      expect(bytes[2]).toBe(0x03);
      expect(bytes[3]).toBe(0x04);
    });
  });
});
