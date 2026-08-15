import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearFolderIndex,
  collectPdfFilesFromDir,
  extractSnippet,
  indexDirectory,
  searchFolderIndex,
  tokenizeText
} from '../../src/core/ocr/folder-index';

describe('ocr/folder-index', () => {
  beforeEach(async () => {
    await clearFolderIndex();
  });

  describe('tokenizeText & extractSnippet', () => {
    it('tokenizes text into unique lowercase tokens', () => {
      const text = 'The Quick brown FOX jumps over the lazy dog 123!';
      const tokens = tokenizeText(text);
      expect(tokens).toContain('the');
      expect(tokens).toContain('quick');
      expect(tokens).toContain('brown');
      expect(tokens).toContain('fox');
      expect(tokens).toContain('123');
      expect(new Set(tokens).size).toBe(tokens.length);
    });

    it('handles empty or whitespace text', () => {
      expect(tokenizeText('')).toEqual([]);
      expect(tokenizeText('    ')).toEqual([]);
    });

    it('extracts text snippets around a token with ellipses', () => {
      const text =
        'This is a sample document content containing confidential invoice financial records from 2026.';
      const snippet = extractSnippet(text, 'invoice', 40);
      expect(snippet.toLowerCase()).toContain('invoice');
      expect(snippet.length).toBeLessThanOrEqual(60);
    });
  });

  describe('directory walking & indexing', () => {
    it('collects PDF files from directory handles', async () => {
      const dummyFile1 = new File(['%PDF-1.4 header text invoice sample'], 'invoice1.pdf', {
        type: 'application/pdf',
        lastModified: 1000
      });
      const dummyFile2 = new File(['%PDF-1.4 header text report audit data'], 'report2.pdf', {
        type: 'application/pdf',
        lastModified: 2000
      });

      const mockDirHandle = {
        kind: 'directory' as const,
        name: 'test_folder',
        files: [dummyFile1, dummyFile2]
      };

      const pdfs = await collectPdfFilesFromDir(mockDirHandle as any);
      expect(pdfs.length).toBe(2);
      expect(pdfs[0].fileName).toBe('invoice1.pdf');
      expect(pdfs[1].fileName).toBe('report2.pdf');
    });

    it('indexes multiple PDFs and stores inverted index entries', async () => {
      const file1 = new File(
        ['%PDF-1.4 (invoice confidential payment 2026) Tj'],
        'invoice_2026.pdf',
        {
          type: 'application/pdf',
          lastModified: 1000
        }
      );
      const file2 = new File(
        ['%PDF-1.4 (annual financial audit report summary) Tj'],
        'audit_summary.pdf',
        {
          type: 'application/pdf',
          lastModified: 2000
        }
      );

      const mockDir = {
        kind: 'directory' as const,
        name: 'finance',
        files: [file1, file2]
      };

      const progressLogs: string[] = [];
      const stats = await indexDirectory(mockDir as any, {
        onProgress: (_, label) => progressLogs.push(label)
      });

      expect(stats.filesIndexed).toBe(2);
      expect(stats.pagesIndexed).toBeGreaterThanOrEqual(2);
      expect(stats.totalTokens).toBeGreaterThan(0);
      expect(stats.durationMs).toBeGreaterThanOrEqual(0);
      expect(progressLogs.length).toBeGreaterThan(0);
    });

    it('supports incremental re-indexing when files are unchanged', async () => {
      const file1 = new File(['%PDF-1.4 (invoice data) Tj'], 'invoice.pdf', {
        type: 'application/pdf',
        lastModified: 5000
      });

      const mockDir = {
        kind: 'directory' as const,
        name: 'docs',
        files: [file1]
      };

      const stats1 = await indexDirectory(mockDir as any);
      expect(stats1.filesIndexed).toBe(1);

      // Re-indexing without forceReindex skips unchanged file
      const stats2 = await indexDirectory(mockDir as any);
      expect(stats2.filesIndexed).toBe(0);
    });
  });

  describe('searchFolderIndex', () => {
    it('returns matching SearchResultItems in <500ms with correct page attribution', async () => {
      const file1 = new File(
        ['%PDF-1.4 (confidential quarterly revenue report) Tj'],
        'q1_report.pdf',
        {
          type: 'application/pdf',
          lastModified: 3000
        }
      );
      const file2 = new File(['%PDF-1.4 (client contract agreement terms) Tj'], 'contract.pdf', {
        type: 'application/pdf',
        lastModified: 4000
      });

      const mockDir = {
        kind: 'directory' as const,
        name: 'workspace',
        files: [file1, file2]
      };

      await indexDirectory(mockDir as any);

      const start = performance.now();
      const results = await searchFolderIndex('quarterly');
      const duration = performance.now() - start;

      expect(duration).toBeLessThan(500);
      expect(results.length).toBeGreaterThan(0);

      const match = results[0];
      expect(match.fileName).toBe('q1_report.pdf');
      expect(match.pageIndex).toBe(0);
      expect(match.pageNumber).toBe(1);
      expect(match.textSnippet.toLowerCase()).toContain('quarterly');
    });

    it('returns empty array for non-matching or empty queries', async () => {
      const results1 = await searchFolderIndex('');
      expect(results1).toEqual([]);

      const results2 = await searchFolderIndex('nonexistentword123456');
      expect(results2).toEqual([]);
    });

    it('clears folder index on clearFolderIndex()', async () => {
      const file = new File(['%PDF-1.4 (stamped document text) Tj'], 'doc.pdf', {
        type: 'application/pdf',
        lastModified: 6000
      });

      await indexDirectory({ files: [file] } as any);
      let results = await searchFolderIndex('stamped');
      expect(results.length).toBeGreaterThan(0);

      await clearFolderIndex();
      results = await searchFolderIndex('stamped');
      expect(results).toEqual([]);
    });
  });
});
