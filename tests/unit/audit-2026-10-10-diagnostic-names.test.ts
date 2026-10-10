/**
 * Audit 2026-10-10 S5 — the diagnostic a user pastes into an issue promises
 * "no file names" (errors.ts), but folder search logged `basePath/file.name`.
 * The log now names a file by its position in the run, and `buildDiagnostic`
 * scrubs anything path- or file-name-shaped as defence in depth.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  StaplerError,
  buildDiagnostic,
  clearLog,
  getLog,
  logEvent,
  scrubPaths
} from '../../src/core/errors';

vi.mock('comlink', () => ({ expose: vi.fn(), transfer: vi.fn(v => v), proxy: vi.fn(v => v) }));

vi.mock('../../src/core/workers', () => {
  const renderApi = {
    loadDocument: async () => {
      throw new StaplerError('Encrypted', 'The document requires a password to open.');
    },
    documentText: async () => [],
    closeDocument: async () => {}
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

const { clearFolderIndex, indexDirectory } = await import('../../src/core/ocr/folder-index');

beforeEach(async () => {
  clearLog();
  await clearFolderIndex();
});

describe('S5 — no file names in the diagnostic log', () => {
  it('logs a skipped file by its position, not its name or folder path', async () => {
    const file = new File(['%PDF-1.4 x'], 'Payroll 2026 secret.pdf', {
      type: 'application/pdf',
      lastModified: 1
    });
    const dir = { name: 'HR-Confidential', files: [file], dirs: [] };
    const stats = await indexDirectory(dir as never);
    expect(stats.skipped).toHaveLength(1);
    const lines = getLog()
      .filter(e => e.scope === 'folder-index')
      .map(e => e.message);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).toMatch(/file 1 of 1: The document requires a password/);
    const diagnostic = buildDiagnostic();
    expect(diagnostic).not.toMatch(/Payroll|secret|HR-Confidential/);
  });

  it('buildDiagnostic scrubs paths and file names that reached a message anyway', () => {
    logEvent('warn', 'x', 'Taxes/2024/W2 scan.pdf page 3: failed');
    logEvent('warn', 'x', 'opening C:\\Users\\ana\\Desktop\\contract.docx failed');
    logEvent('warn', 'x', 'read /home/ana/private/notes.md');
    logEvent('warn', 'x', 'invoice-0042.PDF is a damaged TIFF');
    const err = new StaplerError('CorruptDocument', 'my-scan.tiff could not be read', {
      path: '/Users/ana/x.pdf'
    });
    const diagnostic = buildDiagnostic(err);
    for (const leaked of ['Taxes', 'W2', 'ana', 'contract', 'notes', 'invoice-0042', 'my-scan']) {
      expect(diagnostic).not.toContain(leaked);
    }
    expect(diagnostic).toContain('[path] page 3: failed');
    expect(diagnostic).toContain('[file] is a damaged TIFF');
  });

  it('leaves ordinary diagnostic text and the model URL alone', () => {
    for (const text of [
      'file 2 of 9: OCR unavailable: engine failed',
      'pdf.js failed in worker.min.js',
      'ratio 1/2 at page 3/4',
      'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int/eng.traineddata.gz'
    ]) {
      expect(scrubPaths(text)).toBe(text);
    }
  });
});
