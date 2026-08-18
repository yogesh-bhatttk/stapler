import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFArray, PDFDocument, PDFName, PDFStream, StandardFonts } from 'pdf-lib';

/**
 * OCR-01.
 *
 * Two things are actually being proved here, and both are proved against bytes:
 *
 *  1. The confirmation gate. No fetch, no worker, no engine load happens before
 *     the user says yes — asserted by mocking the worker pool and showing it is
 *     never touched on the decline path.
 *  2. The text layer. The page's original content stream survives byte-for-byte,
 *     and the words come back out of a *re-parsed* document through pdf.js's text
 *     extraction. "It looked right in a viewer" is not evidence.
 */

/* ------------------------------------------------------------------ *
 * model.ts — the one network destination, and its test seam
 * ------------------------------------------------------------------ */

describe('ocr/model', () => {
  it('pins an exact package version rather than a floating tag', async () => {
    const { resolveModelUrl, setModelBaseOverride } = await import('../../src/core/ocr/model');
    setModelBaseOverride(null);
    const url = resolveModelUrl('eng');
    // Same construction tesseract.js's own loadAndGunzipFile performs:
    // `${langPath}/${lang}.traineddata${gzip ? '.gz' : ''}`.
    expect(url).toMatch(/^https:\/\/cdn\.jsdelivr\.net\/npm\/@tesseract\.js-data\/eng\//);
    expect(url.endsWith('/eng.traineddata.gz')).toBe(true);
    expect(url).toContain('4.0.0_best_int');
    // A `@latest`, `@7`, or bare-package URL would let the file change under a
    // build that has already been shipped and audited.
    expect(url).not.toMatch(/@latest|\/npm\/@tesseract\.js-data\/eng\/?$/);
  });

  it('routes every URL through the override seam once it is set', async () => {
    const { resolveModelBase, resolveModelUrl, setModelBaseOverride } =
      await import('../../src/core/ocr/model');
    setModelBaseOverride('http://localhost:9999/models/eng/');
    expect(resolveModelBase('eng')).toBe('http://localhost:9999/models/eng');
    expect(resolveModelUrl('eng')).toBe('http://localhost:9999/models/eng/eng.traineddata.gz');
    setModelBaseOverride(null);
    expect(resolveModelUrl('eng')).toContain('cdn.jsdelivr.net');
  });

  it('discloses a size for every language it offers', async () => {
    const { OCR_LANGUAGES } = await import('../../src/core/ocr/model');
    expect(OCR_LANGUAGES.length).toBeGreaterThan(0);
    for (const language of OCR_LANGUAGES) {
      expect(language.approxSizeMb).toBeGreaterThan(0);
      expect(language.label.length).toBeGreaterThan(0);
    }
  });
});

/* ------------------------------------------------------------------ *
 * modelState.ts + runOcr.ts — the consent gate
 * ------------------------------------------------------------------ */

/** In-memory stand-in for the `settings` store, so no IndexedDB is needed. */
const settings = new Map<string, unknown>();

vi.mock('../../src/core/db', () => ({
  readSetting: vi.fn(async (key: string) => settings.get(key)),
  writeSetting: vi.fn(async (key: string, value: unknown) => {
    settings.set(key, value);
  })
}));

const confirmAction = vi.fn();
const requestOcrConsent = vi.fn();
vi.mock('../../src/core/notify', () => ({
  confirmAction: (...args: unknown[]) => confirmAction(...args),
  requestOcrConsent: (...args: unknown[]) => requestOcrConsent(...args),
  notify: vi.fn()
}));

/**
 * The worker pool is the seam between `runOcr` and anything that could touch the
 * network: the OCR worker is what spawns tesseract, which is what fetches the
 * model. If none of these is called, nothing was requested.
 */
const renderPin = { lease: vi.fn(), release: vi.fn() };
const ocrLease = vi.fn();
const processLease = vi.fn();

vi.mock('../../src/core/workers', () => ({
  renderWorker: { pin: () => renderPin },
  ocrWorker: { lease: (...args: unknown[]) => ocrLease(...args) },
  processWorker: { lease: (...args: unknown[]) => processLease(...args) }
}));

describe('ocr/modelState', () => {
  beforeEach(() => settings.clear());

  it('starts opted out, and only records a language after a successful run', async () => {
    const { isModelDownloaded, markModelDownloaded, forgetModel } =
      await import('../../src/core/ocr/modelState');
    expect(await isModelDownloaded('eng')).toBe(false);
    await markModelDownloaded('eng');
    expect(await isModelDownloaded('eng')).toBe(true);
    // Per-language, so adding a second language in OCR-02 re-asks rather than
    // inheriting consent given for English.
    expect(await isModelDownloaded('deu')).toBe(false);
    await forgetModel('eng');
    expect(await isModelDownloaded('eng')).toBe(false);
  });
});

describe('ocr/runOcr — the confirmation gate', () => {
  beforeEach(() => {
    settings.clear();
    requestOcrConsent.mockReset();
    renderPin.lease.mockReset();
    renderPin.release.mockReset();
    ocrLease.mockReset();
    processLease.mockReset();
  });

  it('touches no worker at all when the user declines', async () => {
    requestOcrConsent.mockResolvedValue('cancel');
    const { runOcr } = await import('../../src/core/ocr/runOcr');

    const result = await runOcr(new Uint8Array([1, 2, 3]), 2);

    expect(result).toBeNull();
    expect(requestOcrConsent).toHaveBeenCalledTimes(1);
    // Nothing was opened, recognised, or written — so nothing could have fetched.
    expect(renderPin.lease).not.toHaveBeenCalled();
    expect(ocrLease).not.toHaveBeenCalled();
    expect(processLease).not.toHaveBeenCalled();
    // Declining must not be remembered as consent.
    expect(settings.get('ocr.modelDownloaded.eng')).toBeUndefined();
  });

  it('asks exactly once: a second run with the flag set shows no dialog', async () => {
    settings.set('ocr.modelDownloaded.eng', true);
    const { runOcr } = await import('../../src/core/ocr/runOcr');

    renderPin.lease.mockImplementation(async (fn: (api: unknown) => unknown) =>
      fn({
        loadDocument: async () => ({ handle: 'h' }),
        renderPage: async () => ({ width: 100, height: 100, close() {} }),
        closeDocument: async () => {}
      })
    );
    ocrLease.mockResolvedValue({ words: [], text: '' });
    processLease.mockResolvedValue({
      bytes: new Uint8Array([9]),
      wordsAdded: 0,
      wordsSkipped: 0,
      pagesTouched: 0
    });

    const result = await runOcr(new Uint8Array([1]), 1);

    expect(requestOcrConsent).not.toHaveBeenCalled();
    expect(result?.downloadedModel).toBe(false);
    expect(ocrLease).toHaveBeenCalledTimes(1);
  });

  it('does not record consent when the run fails after the dialog', async () => {
    requestOcrConsent.mockResolvedValue('download');
    const { runOcr } = await import('../../src/core/ocr/runOcr');

    renderPin.lease.mockRejectedValue(new Error('broken document'));

    await expect(runOcr(new Uint8Array([1]), 1)).rejects.toThrow('broken document');
    // A failed download must leave the user opted *out*, so the next attempt asks
    // again rather than silently retrying a fetch they never agreed to repeat.
    expect(settings.get('ocr.modelDownloaded.eng')).toBeUndefined();
    expect(renderPin.release).toHaveBeenCalled();
  });

  it('names the model, its size, the host, and the one-time nature in the dialog', async () => {
    const { modelConsentCopy } = await import('../../src/core/ocr/runOcr');
    const { body } = modelConsentCopy('eng');
    expect(body).toContain('cdn.jsdelivr.net');
    expect(body).toMatch(/\d+ MB/);
    expect(body).toMatch(/once/i);
    expect(body).toMatch(/no network/i);
    expect(body).toMatch(/never uploaded/i);
  });
});

/* ------------------------------------------------------------------ *
 * textLayer.ts — geometry, and the bytes that come out
 * ------------------------------------------------------------------ */

describe('ocr/textLayer — bitmap → user space', () => {
  it('inverts pdf.js viewport rotation for all four angles', async () => {
    const { bitmapToUserSpace } = await import('../../src/core/ocr/textLayer');
    const box = { x0: 0, y0: 0, width: 200, height: 400 };
    const scale = 2;

    // Top-left of the bitmap, for each rotation, is a different corner of the page.
    expect(bitmapToUserSpace(0, 0, scale, 0, box)).toEqual({ x: 0, y: 400 });
    expect(bitmapToUserSpace(0, 0, scale, 90, box)).toEqual({ x: 0, y: 0 });
    expect(bitmapToUserSpace(0, 0, scale, 180, box)).toEqual({ x: 200, y: 0 });
    expect(bitmapToUserSpace(0, 0, scale, 270, box)).toEqual({ x: 200, y: 400 });

    // A point 100px right and 200px down at 2x is (50, 100) in view points.
    expect(bitmapToUserSpace(100, 200, scale, 0, box)).toEqual({ x: 50, y: 300 });
    expect(bitmapToUserSpace(100, 200, scale, 90, box)).toEqual({ x: 100, y: 50 });
  });

  it('offsets by the crop box, so a page whose origin is not (0,0) still maps', async () => {
    const { bitmapToUserSpace } = await import('../../src/core/ocr/textLayer');
    const box = { x0: 20, y0: 30, width: 200, height: 400 };
    expect(bitmapToUserSpace(0, 0, 1, 0, box)).toEqual({ x: 20, y: 430 });
    expect(bitmapToUserSpace(10, 10, 1, 0, box)).toEqual({ x: 30, y: 420 });
  });
});

/** Raw bytes of every content stream a page references, in order. */
function pageStreamBytes(doc: PDFDocument, pageIndex: number): Uint8Array[] {
  const page = doc.getPage(pageIndex);
  const contents = page.node.get(PDFName.of('Contents'));
  const resolved = page.node.context.lookup(contents);
  const streams =
    resolved instanceof PDFArray
      ? resolved.asArray().map(ref => page.node.context.lookup(ref))
      : [resolved];
  return streams
    .filter((stream): stream is PDFStream => stream instanceof PDFStream)
    .map(stream => stream.getContents());
}

/**
 * A one-page document with real drawn content, round-tripped through `save` and
 * `load` so it is the same shape as a file arriving from disk.
 *
 * The round trip is not decoration. A page pdf-lib *created* in this session
 * carries a content stream pdf-lib still owns, and `pushOperators` appends into
 * it; a page pdf-lib *loaded* has no such stream, so `pushOperators` adds a new
 * one and leaves the original alone. Only the second is the real path, and only
 * the second can prove the untouched-bytes claim.
 */
/** Content streams come back Flate-encoded from a loaded document. */
async function decoded(bytes: Uint8Array): Promise<string> {
  const { decodeStream } = await import('../../src/core/pdf/interpreter');
  return new TextDecoder('latin1').decode(await decodeStream(bytes)).trim();
}

async function fixtureWithVisibleText(): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([200, 400]);
  const font = await doc.embedStandardFont(StandardFonts.Helvetica);
  page.drawText('VISIBLE', { x: 10, y: 380, size: 12, font });
  page.drawRectangle({ x: 10, y: 10, width: 50, height: 50 });
  return PDFDocument.load(await doc.save());
}

describe('ocr/textLayer — writing into a document', () => {
  it('adds selectable text without altering a single byte the page already drew', async () => {
    const { addOcrTextLayerToDocument } = await import('../../src/core/ocr/textLayer');

    const doc = await fixtureWithVisibleText();
    const before = pageStreamBytes(doc, 0);
    expect(before.length).toBe(1);

    const report = await addOcrTextLayerToDocument(doc, [
      {
        pageIndex: 0,
        bitmapWidth: 200,
        bitmapHeight: 400,
        dpi: 72,
        words: [
          { text: 'Hello', bbox: { x0: 20, y0: 100, x1: 70, y1: 112 }, confidence: 95 },
          { text: 'world', bbox: { x0: 75, y0: 100, x1: 125, y1: 112 }, confidence: 91 }
        ]
      }
    ]);

    expect(report).toEqual({ wordsAdded: 2, wordsSkipped: 0, pagesTouched: 1 });

    const after = pageStreamBytes(doc, 0);
    // Four streams: pdf-lib brackets the page's existing content in its own
    // `q`/`Q` pair when it promotes `/Contents` to an array, then appends ours.
    // The original stream is *the same object bytes* it was before — still Flate
    // encoded, never re-encoded, never reserialised.
    expect(after.length).toBe(4);
    expect(Array.from(after[1])).toEqual(Array.from(before[0]));
    expect(await decoded(after[0])).toBe('q');
    expect(await decoded(after[2])).toBe('Q');

    const appended = await decoded(after[3]);
    expect(appended).toContain('3 Tr'); // text rendering mode 3 = invisible
    expect(appended.startsWith('q')).toBe(true);
    expect(appended.trimEnd().endsWith('Q')).toBe(true);
    // The words are laid out, not painted: no fill colour, no stroke, no path.
    expect(appended).toContain('BT');
    expect(appended).toContain('Tj');
  });

  it('skips a word the standard font cannot encode instead of mangling it', async () => {
    const { addOcrTextLayerToDocument } = await import('../../src/core/ocr/textLayer');
    const doc = await fixtureWithVisibleText();

    const report = await addOcrTextLayerToDocument(doc, [
      {
        pageIndex: 0,
        bitmapWidth: 200,
        bitmapHeight: 400,
        dpi: 72,
        words: [
          { text: 'ok', bbox: { x0: 10, y0: 10, x1: 30, y1: 22 }, confidence: 90 },
          // CJK is outside WinAnsi; Helvetica has no glyph and pdf-lib throws.
          { text: '文字', bbox: { x0: 40, y0: 10, x1: 60, y1: 22 }, confidence: 90 },
          // A degenerate box is nonsense geometry, not text.
          { text: 'zero', bbox: { x0: 10, y0: 30, x1: 10, y1: 30 }, confidence: 90 }
        ]
      }
    ]);

    expect(report.wordsAdded).toBe(2);
    expect(report.wordsSkipped).toBe(1);
  });

  /**
   * The acceptance criterion, checked the only way that counts: save the bytes,
   * hand them to pdf.js as if it were a viewer, and ask for the text.
   */
  it('re-extracts the recognised words, at the right place, from the saved bytes', async () => {
    const { addOcrTextLayerToDocument } = await import('../../src/core/ocr/textLayer');
    const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');

    const doc = await fixtureWithVisibleText();
    // 150 DPI raster of a 200x400pt page is 417x833 px (scale 150/72).
    const scale = 150 / 72;
    await addOcrTextLayerToDocument(doc, [
      {
        pageIndex: 0,
        bitmapWidth: Math.round(200 * scale),
        bitmapHeight: Math.round(400 * scale),
        dpi: 150,
        words: [
          {
            // 100pt from the top of a 400pt page → baseline at y = 300.
            text: 'Ottoline',
            bbox: { x0: 20 * scale, y0: 88 * scale, x1: 90 * scale, y1: 100 * scale },
            confidence: 96,
            baselineY: 100 * scale
          }
        ]
      }
    ]);
    const bytes = await doc.save();

    const pdf = await lib.getDocument({ data: bytes.slice(), useSystemFonts: false }).promise;
    expect(pdf.numPages).toBe(1);
    const page = await pdf.getPage(1);
    const content = await page.getTextContent();
    const items = content.items.filter(item => 'str' in item) as {
      str: string;
      transform: number[];
    }[];

    const text = items.map(item => item.str).join(' ');
    // Both the page's own text and the OCR word — the layer is additive.
    expect(text).toContain('VISIBLE');
    expect(text).toContain('Ottoline');

    const word = items.find(item => item.str.includes('Ottoline'));
    expect(word).toBeDefined();
    // transform[4]/[5] are the run's origin in pdf.js text space: x from the
    // left, y up from the bottom. The word was measured 100pt below the top of a
    // 400pt page, so its baseline belongs at y = 300 — which is what pdf.js reads
    // back out of the operators that were written.
    expect(word!.transform[4]).toBeCloseTo(20, 0);
    expect(word!.transform[5]).toBeCloseTo(300, 0);
  });

  it('leaves the document completely alone when nothing was recognised', async () => {
    const { addOcrTextLayerToDocument } = await import('../../src/core/ocr/textLayer');
    const doc = await fixtureWithVisibleText();
    const before = pageStreamBytes(doc, 0);

    const report = await addOcrTextLayerToDocument(doc, [
      { pageIndex: 0, bitmapWidth: 200, bitmapHeight: 400, dpi: 72, words: [] }
    ]);

    expect(report).toEqual({ wordsAdded: 0, wordsSkipped: 0, pagesTouched: 0 });
    expect(pageStreamBytes(doc, 0).length).toBe(before.length);
  });
});
