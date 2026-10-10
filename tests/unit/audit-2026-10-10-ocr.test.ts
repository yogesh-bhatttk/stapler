/**
 * Audit 2026-10-10 — OCR fixes, graded on real output where there is output.
 *
 * CV6: the invisible text layer used the raw /CropBox; a CropBox reaching past
 *      the MediaBox shifted every word (by 100 pt here). Now pdf.js's view box.
 * CV9: OCR re-read pages that already had real text, duplicating it.
 * CV11: the consent dialog said ~12 MB for a 2.95 MB file.
 * S6b: a cached model was trusted by presence alone, in idb-keyval's default
 *      database; it is now re-hashed before every use, kept in Stapler's own.
 * S-info: the model request carries no credentials/referrer, follows no
 *      redirect and bypasses the HTTP cache.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument, PDFName, StandardFonts, PDFOperator, PDFOperatorNames } from 'pdf-lib';

vi.setConfig({ testTimeout: 60_000 });
vi.mock('comlink', () => ({
  expose: vi.fn(),
  transfer: vi.fn(value => value),
  proxy: vi.fn(value => value),
  releaseProxy: Symbol('releaseProxy')
}));

const workerMocks = {
  pin: vi.fn(),
  process: vi.fn(),
  ocr: vi.fn(),
  cv: vi.fn()
};
vi.mock('../../src/core/workers', () => ({
  renderWorker: { pin: () => workerMocks.pin() },
  processWorker: { lease: (fn: (api: unknown) => unknown) => workerMocks.process(fn) },
  ocrWorker: { lease: (fn: (api: unknown) => unknown) => workerMocks.ocr(fn) },
  cvWorker: { lease: (fn: (api: unknown) => unknown) => workerMocks.cv(fn) }
}));

const { addOcrTextLayerToDocument, pagesWithVisibleText } =
  await import('../../src/core/ocr/textLayer');
const { processWorkerImpl } = await import('../../src/core/workers/process.worker');

/** Where pdf.js finds `word` on page 1, in its viewport (top-left origin). */
async function wordPosition(bytes: Uint8Array, word: string) {
  const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await lib.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const item = (content.items as { str: string; transform: number[] }[]).find(i =>
    i.str.includes(word)
  );
  if (!item) throw new Error(`${word} not found`);
  const [x, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
  return { x, y, viewport: { width: viewport.width, height: viewport.height } };
}

describe('CV6 — the OCR text layer sits where the bitmap was read', () => {
  for (const crop of [
    [0, 0, 612, 792],
    [-100, -100, 712, 892],
    [612, 792, 0, 0]
  ]) {
    it(`puts a word at the same place with /CropBox [${crop.join(' ')}]`, async () => {
      const doc = await PDFDocument.create();
      const page = doc.addPage([612, 792]);
      page.node.set(PDFName.of('CropBox'), doc.context.obj(crop));
      // The OCR bitmap is pdf.js's view of the page: 612×792 at 72 DPI here.
      // A word whose box starts 10 px from the bitmap's left, baseline at 30 px.
      await addOcrTextLayerToDocument(doc, [
        {
          pageIndex: 0,
          bitmapWidth: 612,
          bitmapHeight: 792,
          dpi: 72,
          words: [{ text: 'Hello', bbox: { x0: 10, y0: 10, x1: 110, y1: 30 }, confidence: 90 }]
        }
      ]);
      const at = await wordPosition(await doc.save(), 'Hello');
      expect(at.viewport).toEqual({ width: 612, height: 792 });
      expect(at.x).toBeCloseTo(10, 0);
      expect(Math.abs(at.y - 30)).toBeLessThan(6);
    });
  }
});

describe('CV9 — pages that already have text are not OCR’d again', () => {
  async function fixture() {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    // 0: born-digital text. 1: blank (a scan's image would be here). 2: an old
    // invisible OCR layer only. 3: text inside a form XObject.
    doc.addPage([200, 200]).drawText('Real text', { x: 20, y: 100, size: 12, font });
    doc.addPage([200, 200]);
    const ocrd = doc.addPage([200, 200]);
    ocrd.pushOperators(PDFOperator.of(PDFOperatorNames.SetTextRenderingMode, [doc.context.obj(3)]));
    ocrd.drawText('hidden', { x: 20, y: 100, size: 12, font });
    const formPage = doc.addPage([200, 200]);
    const embedded = await doc.embedPage(doc.getPage(0));
    formPage.drawPage(embedded);
    return doc.save();
  }

  it('finds the pages with visible text, including text inside a form XObject', async () => {
    const bytes = await fixture();
    const doc = await PDFDocument.load(bytes);
    expect(pagesWithVisibleText(doc, [0, 1, 2, 3])).toEqual([0, 3]);
    expect(await processWorkerImpl.ocrPagesWithText(bytes, [1, 2, 3])).toEqual([3]);
  });
});

describe('CV9 — runOcr skips them unless told otherwise', () => {
  afterEach(async () => {
    const cache = await import('../../src/core/ocr/tesseractCache');
    const model = await import('../../src/core/ocr/model');
    cache.__setModelStoresForTests(null);
    model.setModelHashOverride(null);
    for (const m of Object.values(workerMocks)) m.mockReset();
  });

  async function modelInCache() {
    const cache = await import('../../src/core/ocr/tesseractCache');
    const model = await import('../../src/core/ocr/model');
    const map = new Map<string, unknown>();
    const store = {
      get: async (k: string) => map.get(k),
      put: async (k: string, v: unknown) => void map.set(k, v),
      delete: async (k: string) => void map.delete(k),
      entries: async () => [...map] as [IDBValidKey, unknown][],
      deleteWhere: async () => 0
    };
    const bytes = new Uint8Array([4, 2]);
    cache.__setModelStoresForTests({ tesseract: store, models: { ...store } });
    model.setModelHashOverride({ eng: await cache.sha256Hex(bytes) });
    await cache.writeCachedModel('eng', bytes);
  }

  it('recognises nothing, asks nothing and writes nothing when every page has text', async () => {
    await modelInCache();
    const addOcrTextLayer = vi.fn();
    workerMocks.process.mockImplementation(fn =>
      fn({ ocrPagesWithText: async () => [0, 1], addOcrTextLayer })
    );
    const { runOcr } = await import('../../src/core/ocr/runOcr');
    const input = new Uint8Array([1, 2, 3]);
    const result = await runOcr(input, 2);
    expect(result).not.toBeNull();
    expect(result!.pagesWithText).toEqual([0, 1]);
    expect(result!.wordsAdded).toBe(0);
    expect(result!.bytes).toBe(input);
    expect(workerMocks.pin).not.toHaveBeenCalled();
    expect(workerMocks.ocr).not.toHaveBeenCalled();
    expect(addOcrTextLayer).not.toHaveBeenCalled();
  });

  it('OCRs only the pages without text, and every page when includePagesWithText is set', async () => {
    await modelInCache();
    const rendered: number[] = [];
    workerMocks.pin.mockReturnValue({
      lease: (fn: (api: unknown) => unknown) =>
        fn({
          loadDocument: async () => ({ handle: 'h', pageSizes: [] }),
          renderPage: async (_h: string, index: number) => {
            rendered.push(index);
            return { width: 10, height: 10, close() {} };
          },
          closeDocument: async () => {}
        }),
      release: () => {}
    });
    workerMocks.cv.mockImplementation(fn => fn({ cleanupForOcr: async (b: unknown) => b }));
    workerMocks.ocr.mockImplementation(fn =>
      fn({ recognizePage: async () => ({ words: [], text: '' }) })
    );
    const ocrPagesWithText = vi.fn(async () => [1]);
    workerMocks.process.mockImplementation(fn =>
      fn({
        ocrPagesWithText,
        addOcrTextLayer: async (bytes: Uint8Array) => ({
          bytes,
          wordsAdded: 0,
          wordsSkipped: 0,
          pagesTouched: 0,
          pagesReplaced: 0
        })
      })
    );
    const { runOcr } = await import('../../src/core/ocr/runOcr');
    const skipped = await runOcr(new Uint8Array([1]), 3);
    expect(rendered).toEqual([0, 2]);
    expect(skipped!.pagesWithText).toEqual([1]);

    rendered.length = 0;
    ocrPagesWithText.mockClear();
    const forced = await runOcr(new Uint8Array([1]), 3, { includePagesWithText: true });
    expect(ocrPagesWithText).not.toHaveBeenCalled();
    expect(rendered).toEqual([0, 1, 2]);
    expect(forced!.pagesWithText).toEqual([]);
  });
});

describe('CV11 — the consent dialog states the real download size', () => {
  it('derives the size from MODEL_BYTES, formatted by formatBytes', async () => {
    const { MODEL_BYTES, modelDownloadBytes } = await import('../../src/core/ocr/model');
    const { formatBytes } = await import('../../src/core/bytes');
    const { modelConsentCopy } = await import('../../src/core/ocr/runOcr');
    expect(modelDownloadBytes('eng')).toBe(MODEL_BYTES.eng);
    expect(modelDownloadBytes('eng+hin')).toBe(MODEL_BYTES.eng + MODEL_BYTES.hin);
    const eng = modelConsentCopy(['eng']).body;
    expect(eng).toContain(formatBytes(MODEL_BYTES.eng));
    expect(eng).toContain('2.95 MB');
    expect(eng).not.toMatch(/\b12 MB/);
    expect(modelConsentCopy(['eng', 'hin']).body).toContain('4.34 MB');
  });
});

describe('S6b — a cached model is re-hashed before every use', () => {
  type Store = import('../../src/core/ocr/tesseractCache').ModelKeyValueStore;
  const memory = (): Store & { map: Map<string, unknown> } => {
    const map = new Map<string, unknown>();
    return {
      map,
      get: async k => map.get(k),
      put: async (k, v) => void map.set(k, v),
      delete: async k => void map.delete(k),
      entries: async () => [...map],
      deleteWhere: async match => {
        let n = 0;
        for (const k of [...map.keys()]) {
          if (!match(k)) continue;
          map.delete(k);
          n++;
        }
        return n;
      }
    };
  };

  afterEach(async () => {
    const cache = await import('../../src/core/ocr/tesseractCache');
    const model = await import('../../src/core/ocr/model');
    cache.__setModelStoresForTests(null);
    model.setModelHashOverride(null);
  });

  async function setup(pinned: Uint8Array) {
    const cache = await import('../../src/core/ocr/tesseractCache');
    const model = await import('../../src/core/ocr/model');
    const stores = { tesseract: memory(), models: memory() };
    cache.__setModelStoresForTests(stores);
    model.setModelHashOverride({ eng: await cache.sha256Hex(pinned) });
    return { cache, stores };
  }

  it('uses its own database name, distinct from idb-keyval’s default', async () => {
    const { MODEL_DB_NAME } = await import('../../src/core/ocr/tesseractCache');
    expect(MODEL_DB_NAME).toBe('stapler-ocr-models');
  });

  it('accepts a verified model and re-seeds tesseract’s store with those bytes', async () => {
    const good = new Uint8Array([1, 2, 3, 4]);
    const { cache, stores } = await setup(good);
    await cache.writeCachedModel('eng', good);
    // Someone rewrites tesseract's (shared, default-named) store…
    stores.tesseract.map.set('./eng.traineddata', new Uint8Array([6, 6, 6]));
    expect(await cache.hasCachedModel('eng')).toBe(true);
    // …and the verified bytes are put back before the engine reads them.
    expect([...(stores.tesseract.map.get('./eng.traineddata') as Uint8Array)]).toEqual([
      1, 2, 3, 4
    ]);
  });

  it('discards a stored model whose bytes no longer match, so consent is asked again', async () => {
    const good = new Uint8Array([1, 2, 3, 4]);
    const { cache, stores } = await setup(good);
    await cache.writeCachedModel('eng', good);
    const record = stores.models.map.get('eng') as { bytes: Uint8Array };
    record.bytes[0] = 9; // bit rot or tampering, same bytes object
    expect(await cache.hasCachedModel('eng')).toBe(false);
    expect(stores.models.map.has('eng')).toBe(false);
    expect(stores.tesseract.map.has('./eng.traineddata')).toBe(false);
  });

  it('does not trust a stored "upload" record whose hash field was simply rewritten', async () => {
    const good = new Uint8Array([1, 2, 3, 4]);
    const { cache, stores } = await setup(good);
    const evil = new Uint8Array([7, 7]);
    // A forged record: its own hash, labelled an upload — but no OPFS upload exists.
    stores.models.map.set('eng', {
      bytes: evil,
      sha256: await cache.sha256Hex(evil),
      source: 'upload'
    });
    expect(await cache.hasCachedModel('eng')).toBe(false);
    expect(stores.models.map.has('eng')).toBe(false);
  });

  it('migrates a pre-S6b cache entry only when it hashes to the pinned value', async () => {
    const good = new Uint8Array([5, 5, 5]);
    const { cache, stores } = await setup(good);
    stores.tesseract.map.set('./eng.traineddata', good);
    expect(await cache.hasCachedModel('eng')).toBe(true);
    expect((stores.models.map.get('eng') as { source: string }).source).toBe('pinned');

    stores.models.map.clear();
    stores.tesseract.map.set('./eng.traineddata', new Uint8Array([0]));
    expect(await cache.hasCachedModel('eng')).toBe(false);
    expect(stores.tesseract.map.has('./eng.traineddata')).toBe(false);
  });

  it('clearCachedModels empties both stores, leaving other keys in tesseract’s alone', async () => {
    const good = new Uint8Array([1]);
    const { cache, stores } = await setup(good);
    await cache.writeCachedModel('eng', good);
    stores.tesseract.map.set('someone-elses-key', 1);
    expect(await cache.clearCachedModels()).toBe(2);
    expect(stores.models.map.size).toBe(0);
    expect([...stores.tesseract.map.keys()]).toEqual(['someone-elses-key']);
  });

  it('Clear all local data clears the new database too', async () => {
    const good = new Uint8Array([1]);
    const { cache, stores } = await setup(good);
    await cache.writeCachedModel('eng', good);
    const { clearAllLocalData } = await import('../../src/core/local-data');
    const result = await clearAllLocalData();
    expect(result.ocrCacheCleared).toBe(true);
    expect(stores.models.map.size).toBe(0);
    expect(stores.tesseract.map.size).toBe(0);
  });
});

describe('S-info — the one model request is as anonymous as fetch allows', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('omits credentials and referrer, refuses redirects, bypasses the HTTP cache', async () => {
    const model = await import('../../src/core/ocr/model');
    const { sha256Hex } = await import('../../src/core/ocr/tesseractCache');
    const body = new Uint8Array([1, 2, 3]);
    model.setModelHashOverride({ eng: await sha256Hex(body) });
    model.setModelBaseOverride('http://127.0.0.1:9/models/eng');
    const fetch = vi.fn(async () => new Response(body, { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    try {
      const { fetchVerifiedModel } = await import('../../src/core/ocr/download');
      expect([...(await fetchVerifiedModel('eng'))]).toEqual([1, 2, 3]);
      expect(fetch).toHaveBeenCalledTimes(1);
      const init = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1];
      expect(init).toMatchObject({
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        redirect: 'error',
        cache: 'no-store'
      });
    } finally {
      model.setModelHashOverride(null);
      model.setModelBaseOverride(null);
    }
  });
});
