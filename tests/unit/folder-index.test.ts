import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StaplerError } from '../../src/core/errors';

/**
 * The render worker is stubbed: pdf.js needs a browser. By default `loadDocument`
 * fails the way a *missing worker* fails (a plain Error → `InternalError`), which is
 * what puts the indexer into its degraded latin1 mode — the mode the fixtures in
 * this file are written for. Tests that care about a document pdf.js has *refused*
 * swap in the error pdf.js would actually throw.
 */
let loadDocument: (bytes: Uint8Array) => Promise<{ handle: string }> = async () => {
  throw new Error('render worker unavailable in this environment');
};
let documentTextFn: (handle: string) => Promise<string[]> = async () => ['stub page text'];
let closeDocumentFn: (handle: string) => Promise<void> = async () => {};

// Only needed so `../../src/core/workers/render.worker` (imported below to get
// at the real `documentText` for one test) can load in Node: it imports
// pdfjs-dist's browser build directly, which needs DOM APIs (`DOMMatrix`) this
// environment doesn't have, and calls `Comlink.expose` at import time.
// `redaction-verify.test.ts` sets up the same pair of mocks for the same reason.
vi.mock('comlink', () => ({
  expose: vi.fn(),
  transfer: vi.fn(value => value),
  proxy: vi.fn(value => value)
}));
vi.mock('../../src/core/workers/pdfjs-setup', async () => {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return {
    pdfjsLib,
    openDocument: ({ data, password }: { data: Uint8Array; password?: string }) =>
      pdfjsLib.getDocument({ data, password, disableFontFace: true })
  };
});

vi.mock('../../src/core/workers', () => {
  const renderApi = {
    loadDocument: (bytes: Uint8Array) => loadDocument(bytes),
    documentText: (handle: string) => documentTextFn(handle),
    closeDocument: (handle: string) => closeDocumentFn(handle)
  };
  const leaseOn =
    <T>(target: T) =>
    (fn: (api: T) => Promise<unknown>) =>
      fn(target);
  return {
    renderWorker: {
      lease: leaseOn(renderApi),
      pin: () => ({ lease: leaseOn(renderApi), release: () => {} })
    },
    processWorker: { lease: leaseOn({}) },
    cvWorker: { lease: leaseOn({}) }
  };
});

const {
  clearFolderIndex,
  collectPdfFilesFromDir,
  extractPdfTextPages,
  extractSnippet,
  indexDirectory,
  searchFolderIndex,
  tokenizeText
} = await import('../../src/core/ocr/folder-index');
const { toasts } = await import('../../src/core/notify');
const { renderWorkerImpl } = await import('../../src/core/workers/render.worker');
const { PDFDocument, StandardFonts } = await import('pdf-lib');

describe('ocr/folder-index', () => {
  beforeEach(async () => {
    await clearFolderIndex();
    toasts.value = [];
    loadDocument = async () => {
      throw new Error('render worker unavailable in this environment');
    };
    documentTextFn = async () => ['stub page text'];
    closeDocumentFn = async () => {};
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

    /**
     * OCR-02's own audit finding: every other test here only ever exercises
     * `fallbackExtractText`'s crude latin1 scrape (the `%PDF-1.4 ...` fixtures
     * above aren't real PDFs pdf.js can open), so a break in the *real*
     * `documentText` pdf.js path — the one an actual folder of PDFs uses —
     * would pass every test in this file undetected. This wires the mocked
     * render-worker client through to `renderWorkerImpl`, the real pdf.js
     * implementation `redaction-verify.test.ts` also exercises directly, so
     * `extractPdfTextPages` runs the genuine multi-page extraction.
     */
    it('extracts real per-page text through pdf.js, not the degraded fallback', async () => {
      const doc = await PDFDocument.create();
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const page1 = doc.addPage([300, 300]);
      page1.drawText('Alpha page one content', { x: 20, y: 250, size: 14, font });
      const page2 = doc.addPage([300, 300]);
      page2.drawText('Beta page two content', { x: 20, y: 250, size: 14, font });
      const bytes = await doc.save();

      loadDocument = bytes => renderWorkerImpl.loadDocument(bytes);
      documentTextFn = handle => renderWorkerImpl.documentText(handle);
      closeDocumentFn = handle => renderWorkerImpl.closeDocument(handle);

      const file = new File([bytes], 'real.pdf', { type: 'application/pdf' });
      const pages = await extractPdfTextPages(file);

      expect(pages).toHaveLength(2);
      expect(pages[0]).toContain('Alpha page one content');
      expect(pages[1]).toContain('Beta page two content');
      // The stub every other test in this file gets would fail this: it
      // always returns the single-page `['stub page text']` array.
      expect(pages).not.toContain('stub page text');
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

  describe('unreadable files and incremental re-index', () => {
    it('skips an encrypted file with a surfaced reason instead of indexing its bytes', async () => {
      // What pdf.js actually throws through the render worker for a password file.
      loadDocument = async () => {
        throw new StaplerError('Encrypted', 'The document requires a password to open.');
      };

      // Real-looking latin1 content: the old fallback scrape would have turned the
      // parenthesised runs into "tokens" and filed them under the search index.
      const locked = new File(
        ['%PDF-1.4 (ciphertextgibberish confidentialpayroll) Tj'],
        'locked.pdf',
        { type: 'application/pdf', lastModified: 100 }
      );

      const stats = await indexDirectory({ files: [locked] } as any);

      expect(stats.filesIndexed).toBe(0);
      expect(stats.skipped).toEqual([
        {
          fileId: 'locked.pdf',
          fileName: 'locked.pdf',
          reason: 'The document requires a password to open.'
        }
      ]);
      // Nothing from inside the file made it into the index.
      expect(await searchFolderIndex('confidentialpayroll')).toEqual([]);
      expect(await searchFolderIndex('ciphertextgibberish')).toEqual([]);
      // And the user was told, rather than silently getting no hits forever.
      const toast = toasts.value.at(-1);
      expect(toast?.tone).toBe('warning');
      expect(toast?.detail).toContain('locked.pdf');
      expect(toast?.detail).toContain('password');
    });

    it("re-indexing one changed file leaves every other file's occurrences intact", async () => {
      const alpha = new File(['%PDF-1.4 (alphauniquetoken shared) Tj'], 'alpha.pdf', {
        type: 'application/pdf',
        lastModified: 1
      });
      const beta = new File(['%PDF-1.4 (betauniquetoken shared) Tj'], 'beta.pdf', {
        type: 'application/pdf',
        lastModified: 2
      });

      await indexDirectory({ files: [alpha, beta] } as any);
      expect((await searchFolderIndex('alphauniquetoken')).length).toBe(1);
      expect((await searchFolderIndex('shared')).length).toBe(2);

      // beta.pdf changes on disk; alpha.pdf does not.
      const betaEdited = new File(['%PDF-1.4 (betarewrittentoken shared) Tj'], 'beta.pdf', {
        type: 'application/pdf',
        lastModified: 999
      });
      const stats = await indexDirectory({ files: [alpha, betaEdited] } as any);
      expect(stats.filesIndexed).toBe(1);

      // The whole point: alpha.pdf's entries survived a run that never touched it.
      const alphaHits = await searchFolderIndex('alphauniquetoken');
      expect(alphaHits.map(h => h.fileName)).toEqual(['alpha.pdf']);
      const sharedHits = await searchFolderIndex('shared');
      expect(sharedHits.map(h => h.fileName).sort()).toEqual(['alpha.pdf', 'beta.pdf']);

      // And beta.pdf's stale token is gone, replaced by its new one.
      expect(await searchFolderIndex('betauniquetoken')).toEqual([]);
      expect((await searchFolderIndex('betarewrittentoken')).map(h => h.fileName)).toEqual([
        'beta.pdf'
      ]);
    });

    it('a file that becomes unreadable stops answering searches', async () => {
      const doc = new File(['%PDF-1.4 (formerlyindexedtoken) Tj'], 'doc.pdf', {
        type: 'application/pdf',
        lastModified: 10
      });
      await indexDirectory({ files: [doc] } as any);
      expect((await searchFolderIndex('formerlyindexedtoken')).length).toBe(1);

      loadDocument = async () => {
        throw new StaplerError('CorruptDocument', 'The file is not a readable PDF.');
      };
      const changed = new File(['%PDF-1.4 (formerlyindexedtoken) Tj'], 'doc.pdf', {
        type: 'application/pdf',
        lastModified: 20
      });
      const stats = await indexDirectory({ files: [changed] } as any);

      expect(stats.skipped.map(s => s.fileName)).toEqual(['doc.pdf']);
      // Stale hits are cleared rather than left pointing at a file we can no
      // longer read.
      expect(await searchFolderIndex('formerlyindexedtoken')).toEqual([]);
    });
  });
});
