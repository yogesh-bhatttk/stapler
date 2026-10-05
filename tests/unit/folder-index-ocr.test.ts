import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * OCR-02 — "OCR scans on demand" in folder search.
 *
 * The scanned fixture (`scanned_skewed.pdf`: one page that is only an image) is
 * read by the *real* pdf.js text extraction, so "this page has no text layer"
 * is a fact about the fixture's bytes, not a stub. Rasterising, clean-up and
 * tesseract are mocked at the worker-pool seam, the way `ocr.test.ts` does:
 * pdf.js cannot render and tesseract cannot run in Node. The model's presence
 * is driven through an in-memory stand-in for tesseract's own cache, and the
 * one download path (`fetchVerifiedModel`) is a spy that must stay untouched
 * unless the consent dialog said yes.
 */

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

const tesseractCacheStore = new Map<string, Uint8Array>();
vi.mock('../../src/core/ocr/tesseractCache', () => ({
  hasCachedModel: vi.fn(async (lang: string) => tesseractCacheStore.has(lang)),
  writeCachedModel: vi.fn(async (lang: string, bytes: Uint8Array) => {
    tesseractCacheStore.set(lang, bytes);
  }),
  deleteCachedModel: vi.fn(async (lang: string) => {
    tesseractCacheStore.delete(lang);
  })
}));

const fetchVerifiedModel = vi.fn();
vi.mock('../../src/core/ocr/download', () => ({
  fetchVerifiedModel: (...args: unknown[]) => fetchVerifiedModel(...args)
}));

const requestOcrConsent = vi.fn();
vi.mock('../../src/core/notify', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/core/notify')>('../../src/core/notify');
  return {
    ...actual,
    requestOcrConsent: (...args: unknown[]) => requestOcrConsent(...args)
  };
});

/** What the mocked OCR engine "reads" on its next call; set per test. */
let recognizeImpl: (call: number) => Promise<{ words: never[]; text: string }>;
const recognizePage = vi.fn();
const validateModel = vi.fn(async (lang: string) => void lang);
const renderPage = vi.fn(async () => ({ width: 100, height: 100, close() {} }));

vi.mock('../../src/core/workers', async () => {
  const { renderWorkerImpl } = await import('../../src/core/workers/render.worker');
  const renderApi = {
    loadDocument: (bytes: Uint8Array) => renderWorkerImpl.loadDocument(bytes),
    documentText: (handle: string) => renderWorkerImpl.documentText(handle),
    closeDocument: (handle: string) => renderWorkerImpl.closeDocument(handle),
    renderPage: (...args: unknown[]) => renderPage(...(args as []))
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
    cvWorker: { lease: leaseOn({ cleanupForOcr: async (bitmap: unknown) => bitmap }) },
    ocrWorker: {
      lease: leaseOn({
        validateModel: (lang: string) => validateModel(lang),
        recognizePage: (...args: unknown[]) => recognizePage(...args)
      })
    },
    processWorker: { lease: leaseOn({}) }
  };
});

const { clearFolderIndex, indexDirectory, pagesWithoutText, searchFolderIndex } =
  await import('../../src/core/ocr/folder-index');
const { prepareOcrModel } = await import('../../src/core/ocr/runOcr');
const { __memoryFallback } = await import('../../src/core/opfs');

const SCANNED = new Uint8Array(
  readFileSync(path.resolve(__dirname, '../fixtures/scanned_skewed.pdf'))
);

function scanned(name: string, lastModified = 1000): File {
  return new File([SCANNED], name, { type: 'application/pdf', lastModified });
}

const OCR = { lang: 'eng' };

describe('ocr/folder-index — OCR scans on demand (OCR-02)', () => {
  beforeEach(async () => {
    await clearFolderIndex();
    tesseractCacheStore.clear();
    __memoryFallback.clear();
    fetchVerifiedModel.mockReset();
    requestOcrConsent.mockReset();
    validateModel.mockClear();
    renderPage.mockClear();
    recognizePage.mockReset();
    recognizeImpl = async () => ({ words: [], text: 'Scannedinvoicetoken total due 2026' });
    let calls = 0;
    recognizePage.mockImplementation(async () => recognizeImpl(++calls));
  });

  it('the scanned fixture really has no text layer', async () => {
    const { readPdfTextPages } = await import('../../src/core/ocr/folder-index');
    const { pages, skipReason } = await readPdfTextPages(scanned('scan.pdf'));
    expect(skipReason).toBeUndefined();
    expect(pages.length).toBe(1);
    expect(pagesWithoutText(pages)).toEqual([0]);
  });

  it('with the option off, a scan stays unsearchable and is counted as skipped', async () => {
    tesseractCacheStore.set('eng', new Uint8Array([1])); // even with a model stored
    const stats = await indexDirectory({ files: [scanned('scan.pdf')] } as never);

    expect(stats.filesIndexed).toBe(1);
    expect(stats.scannedPagesSkipped).toBe(1);
    expect(stats.ocrPagesRecognized).toBe(0);
    expect(recognizePage).not.toHaveBeenCalled();
    expect(renderPage).not.toHaveBeenCalled();
    expect(await searchFolderIndex('scannedinvoicetoken')).toEqual([]);

    // An unchanged file is not re-read, but the folder's skipped count still says so.
    const again = await indexDirectory({ files: [scanned('scan.pdf')] } as never);
    expect(again.filesIndexed).toBe(0);
    expect(again.scannedPagesSkipped).toBe(1);
  });

  it('with the option on, the scan becomes searchable and the hit is marked as OCR', async () => {
    tesseractCacheStore.set('eng', new Uint8Array([1]));
    const progress: number[] = [];
    const stats = await indexDirectory({ files: [scanned('scan.pdf')] } as never, {
      ocr: OCR,
      onProgress: p => progress.push(p)
    });

    expect(stats.ocrPagesRecognized).toBe(1);
    expect(stats.scannedPagesSkipped).toBe(0);
    expect(recognizePage).toHaveBeenCalledTimes(1);
    // The worker is asked for the plain language only — no bytes, no URL.
    expect(recognizePage.mock.calls[0][1]).toEqual({ lang: 'eng' });

    const hits = await searchFolderIndex('scannedinvoicetoken');
    expect(hits.map(h => [h.fileName, h.pageNumber, h.fromOcr])).toEqual([['scan.pdf', 1, true]]);
    expect(hits[0].textSnippet.toLowerCase()).toContain('scannedinvoicetoken');

    // Determinate and monotonic, ending at 1.
    expect(progress.at(-1)).toBe(1);
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i]).toBeGreaterThanOrEqual(progress[i - 1] - 1e-9);
    }

    // No consent dialog and no download: the model was already stored.
    expect(requestOcrConsent).not.toHaveBeenCalled();
    expect(fetchVerifiedModel).not.toHaveBeenCalled();
  });

  it('the cache keeps OCR results: an unchanged file is not OCR’d again, a changed one is', async () => {
    tesseractCacheStore.set('eng', new Uint8Array([1]));
    await indexDirectory({ files: [scanned('scan.pdf', 1)] } as never, { ocr: OCR });
    expect(recognizePage).toHaveBeenCalledTimes(1);

    const unchanged = await indexDirectory({ files: [scanned('scan.pdf', 1)] } as never, {
      ocr: OCR
    });
    expect(unchanged.filesIndexed).toBe(0);
    expect(recognizePage).toHaveBeenCalledTimes(1);
    expect((await searchFolderIndex('scannedinvoicetoken')).length).toBe(1);

    recognizeImpl = async () => ({ words: [], text: 'Rewrittenscantoken' });
    await indexDirectory({ files: [scanned('scan.pdf', 2)] } as never, { ocr: OCR });
    expect(recognizePage).toHaveBeenCalledTimes(2);
    expect(await searchFolderIndex('scannedinvoicetoken')).toEqual([]);
    expect((await searchFolderIndex('rewrittenscantoken'))[0]?.fromOcr).toBe(true);
  });

  it('turning the option on later OCRs files indexed while it was off, without a file change', async () => {
    tesseractCacheStore.set('eng', new Uint8Array([1]));
    await indexDirectory({ files: [scanned('scan.pdf')] } as never);
    expect(await searchFolderIndex('scannedinvoicetoken')).toEqual([]);

    const stats = await indexDirectory({ files: [scanned('scan.pdf')] } as never, { ocr: OCR });
    expect(stats.ocrPagesRecognized).toBe(1);
    expect((await searchFolderIndex('scannedinvoicetoken')).length).toBe(1);
  });

  it('switching the OCR language re-OCRs an unchanged file’s text-less pages', async () => {
    tesseractCacheStore.set('eng', new Uint8Array([1]));
    tesseractCacheStore.set('hin', new Uint8Array([1]));
    await indexDirectory({ files: [scanned('scan.pdf', 1)] } as never, { ocr: OCR });
    expect(recognizePage).toHaveBeenCalledTimes(1);

    // Same language, same file: still skipped.
    await indexDirectory({ files: [scanned('scan.pdf', 1)] } as never, { ocr: OCR });
    expect(recognizePage).toHaveBeenCalledTimes(1);

    // Another language, same file: before the fix `ocrLang` was stored but
    // never compared, so this was skipped and the English text stayed.
    recognizeImpl = async () => ({ words: [], text: 'Hindiscantoken' });
    const stats = await indexDirectory({ files: [scanned('scan.pdf', 1)] } as never, {
      ocr: { lang: 'hin' }
    });
    expect(stats.filesIndexed).toBe(1);
    expect(stats.ocrPagesRecognized).toBe(1);
    expect(recognizePage).toHaveBeenCalledTimes(2);
    expect(await searchFolderIndex('scannedinvoicetoken')).toEqual([]);
    expect((await searchFolderIndex('hindiscantoken'))[0]?.fromOcr).toBe(true);

    // And that language is now the stored one: a repeat run skips again.
    await indexDirectory({ files: [scanned('scan.pdf', 1)] } as never, { ocr: { lang: 'hin' } });
    expect(recognizePage).toHaveBeenCalledTimes(2);
  });

  it('a page OCR failed on waits for a file change — or a language change', async () => {
    tesseractCacheStore.set('eng', new Uint8Array([1]));
    tesseractCacheStore.set('hin', new Uint8Array([1]));
    recognizeImpl = async () => {
      throw new Error('canvas too large');
    };
    const first = await indexDirectory({ files: [scanned('scan.pdf', 1)] } as never, {
      ocr: OCR
    });
    expect(first.ocrPagesFailed).toBe(1);
    expect(recognizePage).toHaveBeenCalledTimes(1);

    // Same language: the failure is not retried on every run.
    await indexDirectory({ files: [scanned('scan.pdf', 1)] } as never, { ocr: OCR });
    expect(recognizePage).toHaveBeenCalledTimes(1);

    // New language: retried, even though OCR found no text the first time.
    recognizeImpl = async () => ({ words: [], text: 'Retriedscantoken' });
    const retried = await indexDirectory({ files: [scanned('scan.pdf', 1)] } as never, {
      ocr: { lang: 'hin' }
    });
    expect(recognizePage).toHaveBeenCalledTimes(2);
    expect(retried.ocrPagesRecognized).toBe(1);
    expect((await searchFolderIndex('retriedscantoken')).length).toBe(1);
  });

  it('a language change does not re-index a file OCR never ran on', async () => {
    tesseractCacheStore.set('hin', new Uint8Array([1]));
    // A file with a text layer has no text-less pages, so OCR never ran on it.
    const textFile = new File(
      [readFileSync(path.resolve(__dirname, '../fixtures/contract-v1.pdf'))],
      'text.pdf',
      { type: 'application/pdf', lastModified: 1 }
    );
    const first = await indexDirectory({ files: [textFile] } as never, { ocr: OCR });
    expect(first.filesIndexed).toBe(1);
    const second = await indexDirectory({ files: [textFile] } as never, { ocr: { lang: 'hin' } });
    expect(second.filesIndexed).toBe(0);
    expect(recognizePage).not.toHaveBeenCalled();
  });

  it('cancel stops mid-folder and keeps the files finished before it', async () => {
    tesseractCacheStore.set('eng', new Uint8Array([1]));
    const controller = new AbortController();
    const texts = ['Alphascantoken', 'Betascantoken', 'Gammascantoken'];
    recognizeImpl = async call => {
      if (call === 2) controller.abort(); // the user cancels while file 2 is being read
      return { words: [], text: texts[call - 1] };
    };
    const files = [scanned('a.pdf'), scanned('b.pdf'), scanned('c.pdf')];

    await expect(
      indexDirectory({ files } as never, { ocr: OCR, signal: controller.signal })
    ).rejects.toMatchObject({ kind: 'UserCancelled' });

    // File 3 was never reached.
    expect(recognizePage).toHaveBeenCalledTimes(2);
    // File 1 finished before the cancel and was kept; file 2 was not.
    expect((await searchFolderIndex('alphascantoken')).map(h => h.fileName)).toEqual(['a.pdf']);
    expect(await searchFolderIndex('betascantoken')).toEqual([]);

    // A re-run picks up exactly where it stopped: a.pdf is not OCR'd again.
    recognizeImpl = async call => ({ words: [], text: texts[call - 1] });
    recognizePage.mockReset();
    let calls = 1;
    recognizePage.mockImplementation(async () => recognizeImpl(++calls));
    const stats = await indexDirectory({ files } as never, { ocr: OCR });
    expect(recognizePage).toHaveBeenCalledTimes(2);
    expect(stats.ocrPagesRecognized).toBe(2);
    expect((await searchFolderIndex('gammascantoken')).map(h => h.fileName)).toEqual(['c.pdf']);
  });

  it('with no stored model, indexing never asks, never downloads, and says why', async () => {
    const stats = await indexDirectory({ files: [scanned('scan.pdf')] } as never, { ocr: OCR });

    expect(requestOcrConsent).not.toHaveBeenCalled();
    expect(fetchVerifiedModel).not.toHaveBeenCalled();
    expect(recognizePage).not.toHaveBeenCalled();
    expect(stats.ocrUnavailableReason).toMatch(/not stored/i);
    expect(stats.scannedPagesSkipped).toBe(1);
    expect(await searchFolderIndex('scannedinvoicetoken')).toEqual([]);
  });

  it('turning the option on with no model shows the consent dialog; declining fetches nothing', async () => {
    requestOcrConsent.mockResolvedValue('cancel');

    expect(await prepareOcrModel('eng')).toBe('declined');

    expect(requestOcrConsent).toHaveBeenCalledTimes(1);
    expect(requestOcrConsent).toHaveBeenCalledWith(['eng'], expect.any(String), expect.any(String));
    expect(fetchVerifiedModel).not.toHaveBeenCalled();
    expect(validateModel).not.toHaveBeenCalled();
    expect(tesseractCacheStore.has('eng')).toBe(false);
  });

  it('accepting the dialog downloads once, trial-loads the model, then indexing uses it', async () => {
    requestOcrConsent.mockResolvedValue('download');
    fetchVerifiedModel.mockImplementation(async () => new Uint8Array([4, 2]));

    expect(await prepareOcrModel('eng')).toBe('acquired');
    expect(fetchVerifiedModel).toHaveBeenCalledTimes(1);
    expect(validateModel).toHaveBeenCalledWith('eng');
    expect(tesseractCacheStore.has('eng')).toBe(true);

    // Already stored: no second dialog, no second download.
    expect(await prepareOcrModel('eng')).toBe('ready');
    expect(requestOcrConsent).toHaveBeenCalledTimes(1);

    await indexDirectory({ files: [scanned('scan.pdf')] } as never, { ocr: OCR });
    expect(fetchVerifiedModel).toHaveBeenCalledTimes(1);
    expect((await searchFolderIndex('scannedinvoicetoken')).length).toBe(1);
  });

  it('a page OCR cannot read is reported, and the rest of the folder still indexes', async () => {
    tesseractCacheStore.set('eng', new Uint8Array([1]));
    recognizeImpl = async call => {
      if (call === 1) throw new Error('canvas too large');
      return { words: [], text: 'Secondfiletoken' };
    };
    const stats = await indexDirectory(
      { files: [scanned('huge.pdf'), scanned('fine.pdf')] } as never,
      { ocr: OCR }
    );
    expect(stats.ocrPagesFailed).toBe(1);
    expect(stats.ocrPagesRecognized).toBe(1);
    expect((await searchFolderIndex('secondfiletoken')).map(h => h.fileName)).toEqual(['fine.pdf']);
  });
});
