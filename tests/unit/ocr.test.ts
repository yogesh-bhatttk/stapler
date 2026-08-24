import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
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
    expect(url).toMatch(
      /^https:\/\/cdn\.jsdelivr\.net\/npm\/@tesseract\.js-data\/eng@\d+\.\d+\.\d+\/4\.0\.0_best_int\/eng\.traineddata\.gz$/
    );
    // OCR-01 Defect 1: `.../eng/4.0.0_best_int/...` with no `@<version>` at all
    // is the unpinned shape this replaces — jsdelivr resolves a bare
    // `/npm/@pkg/path` to the package's *latest* published version, so
    // `4.0.0_best_int` alone was never a real version pin, just a path segment
    // that happened to look like one.
    expect(url).not.toMatch(/\/eng\/4\.0\.0_best_int\//);
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

  it('registers a pinned SHA-256 for every single-component language, so download.ts never has to trust unverified bytes', async () => {
    const { OCR_LANGUAGES, expectedModelHash, setModelHashOverride, splitLangCodes } =
      await import('../../src/core/ocr/model');
    setModelHashOverride(null);
    const components = new Set(OCR_LANGUAGES.flatMap(l => splitLangCodes(l.code)));
    expect(components.size).toBeGreaterThan(0);
    for (const code of components) {
      expect(expectedModelHash(code)).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

/* ------------------------------------------------------------------ *
 * download.ts — the one fetch in the OCR feature, and its integrity check
 * ------------------------------------------------------------------ */

describe('ocr/download — the one verified fetch (OCR-01 Defect 1)', () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    const { setModelHashOverride, setModelBaseOverride } = await import('../../src/core/ocr/model');
    setModelHashOverride(null);
    setModelBaseOverride(null);
  });

  it('returns the bytes once they match the pinned hash', async () => {
    const { setModelHashOverride } = await import('../../src/core/ocr/model');
    const bytes = new TextEncoder().encode('a fixture standing in for real traineddata bytes');
    const hash = createHash('sha256').update(bytes).digest('hex');
    setModelHashOverride({ eng: hash });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, arrayBuffer: async () => bytes.buffer }) as unknown as Response)
    );

    // The top-level `vi.mock('../../src/core/ocr/download', ...)` below (used by
    // the runOcr tests) applies to every import in this file, so the *real*
    // implementation is fetched explicitly here via `importActual`.
    const { fetchVerifiedModel } =
      await vi.importActual<typeof import('../../src/core/ocr/download')>(
        '../../src/core/ocr/download'
      );
    const result = await fetchVerifiedModel('eng');
    expect(Array.from(result)).toEqual(Array.from(bytes));
  });

  it('refuses bytes that do not match the pinned hash, rather than using them anyway', async () => {
    const { setModelHashOverride } = await import('../../src/core/ocr/model');
    // A hash that cannot possibly match whatever the stub below returns.
    setModelHashOverride({ eng: '0'.repeat(64) });

    const tampered = new TextEncoder().encode('not what was pinned');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, arrayBuffer: async () => tampered.buffer }) as unknown as Response)
    );

    // The top-level `vi.mock('../../src/core/ocr/download', ...)` below (used by
    // the runOcr tests) applies to every import in this file, so the *real*
    // implementation is fetched explicitly here via `importActual`.
    const { fetchVerifiedModel } =
      await vi.importActual<typeof import('../../src/core/ocr/download')>(
        '../../src/core/ocr/download'
      );
    await expect(fetchVerifiedModel('eng')).rejects.toThrow(/integrity verification/i);
  });

  it('refuses a language with no pinned hash at all, rather than trusting it by default', async () => {
    const { setModelHashOverride } = await import('../../src/core/ocr/model');
    setModelHashOverride({}); // 'eng' deliberately absent

    const bytes = new TextEncoder().encode('anything');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, arrayBuffer: async () => bytes.buffer }) as unknown as Response)
    );

    // The top-level `vi.mock('../../src/core/ocr/download', ...)` below (used by
    // the runOcr tests) applies to every import in this file, so the *real*
    // implementation is fetched explicitly here via `importActual`.
    const { fetchVerifiedModel } =
      await vi.importActual<typeof import('../../src/core/ocr/download')>(
        '../../src/core/ocr/download'
      );
    await expect(fetchVerifiedModel('eng')).rejects.toThrow(/no pinned integrity hash/i);
  });

  it('surfaces a clear error on an HTTP failure rather than hashing an error page', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404, statusText: 'Not Found' }) as unknown as Response)
    );
    // The top-level `vi.mock('../../src/core/ocr/download', ...)` below (used by
    // the runOcr tests) applies to every import in this file, so the *real*
    // implementation is fetched explicitly here via `importActual`.
    const { fetchVerifiedModel } =
      await vi.importActual<typeof import('../../src/core/ocr/download')>(
        '../../src/core/ocr/download'
      );
    await expect(fetchVerifiedModel('eng')).rejects.toThrow(/could not be downloaded/i);
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
 * In-memory stand-in for tesseract's own IndexedDB cache (`tesseractCache.ts`),
 * so `runOcr`'s "is this language actually ready?" check (OCR-01 Defect 2) can
 * be driven from a test without a real IndexedDB. Presence in this map is what
 * "already downloaded" now means — a `settings` flag alone is deliberately not
 * enough, which is exactly the defect the tests below are written against.
 */
const tesseractCacheStore = new Map<string, Uint8Array>();
vi.mock('../../src/core/ocr/tesseractCache', () => ({
  hasCachedModel: vi.fn(async (lang: string) => tesseractCacheStore.has(lang)),
  writeCachedModel: vi.fn(async (lang: string, bytes: Uint8Array) => {
    tesseractCacheStore.set(lang, bytes);
  })
}));

/**
 * `fetchVerifiedModel` is `runOcr`'s only path to the network (OCR-01 Defects
 * 1 & 3) — mocked here so these orchestration tests never touch a real socket;
 * the fetch-and-verify logic itself is exercised directly in the
 * `ocr/download` describe block above.
 */
const fetchVerifiedModel = vi.fn();
vi.mock('../../src/core/ocr/download', () => ({
  fetchVerifiedModel: (...args: [string, AbortSignal?]) => fetchVerifiedModel(...args)
}));

/**
 * The worker pool is the seam between `runOcr` and anything that could touch the
 * network: the OCR worker is what spawns tesseract, which is what fetches the
 * model. If none of these is called, nothing was requested.
 */
const renderPin = { lease: vi.fn(), release: vi.fn() };
const cvLease = vi.fn();
const ocrLease = vi.fn();
const processLease = vi.fn();

vi.mock('../../src/core/workers', () => ({
  renderWorker: { pin: () => renderPin },
  cvWorker: { lease: (...args: unknown[]) => cvLease(...args) },
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
  beforeEach(async () => {
    settings.clear();
    tesseractCacheStore.clear();
    requestOcrConsent.mockReset();
    renderPin.lease.mockReset();
    renderPin.release.mockReset();
    cvLease.mockReset();
    ocrLease.mockReset();
    processLease.mockReset();
    fetchVerifiedModel.mockReset();
    fetchVerifiedModel.mockImplementation(async (lang: string) =>
      new TextEncoder().encode(`fake-model-bytes-${lang}`)
    );
    const { __memoryFallback } = await import('../../src/core/opfs');
    __memoryFallback.clear();
  });

  const mockWorkersForOneSuccessfulPage = () => {
    renderPin.lease.mockImplementation(async (fn: (api: unknown) => unknown) =>
      fn({
        loadDocument: async () => ({ handle: 'h' }),
        renderPage: async () => ({ width: 100, height: 100, close() {} }),
        closeDocument: async () => {}
      })
    );
    cvLease.mockImplementation(async (fn: (api: unknown) => unknown) =>
      fn({ cleanupForOcr: async (bitmap: unknown) => bitmap })
    );
    processLease.mockResolvedValue({
      bytes: new Uint8Array([9]),
      wordsAdded: 0,
      wordsSkipped: 0,
      pagesTouched: 0,
      pagesReplaced: 0
    });
  };

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
    expect(fetchVerifiedModel).not.toHaveBeenCalled();
    // Declining must not be remembered as consent.
    expect(settings.get('ocr.modelDownloaded.eng')).toBeUndefined();
  });

  it('asks exactly once: a second run with the model already cached shows no dialog', async () => {
    // Not the `ocr.modelDownloaded.eng` flag — the actual bytes, in the actual
    // cache tesseract reads from. See the Defect 2 test below for why that
    // distinction is the whole point of this fix.
    tesseractCacheStore.set('eng', new Uint8Array([1]));
    const { runOcr } = await import('../../src/core/ocr/runOcr');
    mockWorkersForOneSuccessfulPage();
    ocrLease.mockResolvedValue({ words: [], text: '' });

    const result = await runOcr(new Uint8Array([1]), 1);

    expect(requestOcrConsent).not.toHaveBeenCalled();
    expect(fetchVerifiedModel).not.toHaveBeenCalled();
    expect(result?.downloadedModel).toBe(false);
    expect(ocrLease).toHaveBeenCalledTimes(1);
  });

  /**
   * OCR-01 Defect 2, reproduced directly: a `markModelDownloaded` flag that
   * survives independently of the bytes it once described. Before the fix,
   * `runOcr` trusted this flag alone, so a run in this exact state would
   * silently proceed straight to the (mocked, but in reality network-fetching)
   * OCR worker with no dialog shown at all — precisely what "no fetch unless
   * the user opts in" forbids. After the fix, the flag is not even consulted
   * for this decision; only real presence is, so it is not touched here.
   */
  it('re-shows the consent dialog when the flag says downloaded but the bytes are gone (OCR-01 Defect 2)', async () => {
    settings.set('ocr.modelDownloaded.eng', true);
    // tesseractCacheStore and OPFS are both deliberately left empty here —
    // simulating the browser having evicted IndexedDB since the flag was set.
    requestOcrConsent.mockResolvedValue('cancel');
    const { runOcr } = await import('../../src/core/ocr/runOcr');

    const result = await runOcr(new Uint8Array([1]), 1);

    expect(result).toBeNull();
    expect(requestOcrConsent).toHaveBeenCalledWith(['eng'], expect.any(String), expect.any(String));
    expect(fetchVerifiedModel).not.toHaveBeenCalled(); // declined, so still nothing fetched
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

  it('does not record consent, and bricks nothing, when the download fails integrity verification', async () => {
    requestOcrConsent.mockResolvedValue('download');
    fetchVerifiedModel.mockRejectedValue(new Error('integrity verification failed'));
    const { runOcr } = await import('../../src/core/ocr/runOcr');

    await expect(runOcr(new Uint8Array([1]), 1)).rejects.toThrow(/integrity verification/);

    expect(settings.get('ocr.modelDownloaded.eng')).toBeUndefined();
    expect(tesseractCacheStore.has('eng')).toBe(false);
    expect(ocrLease).not.toHaveBeenCalled();

    // The language was never marked ready, so a retry asks again rather than
    // being permanently stuck — the failure mode OCR-01 Defect 3 warned about.
    requestOcrConsent.mockReset();
    requestOcrConsent.mockResolvedValue('cancel');
    const result = await runOcr(new Uint8Array([1]), 1);
    expect(result).toBeNull();
    expect(requestOcrConsent).toHaveBeenCalledWith(['eng'], expect.any(String), expect.any(String));
  });

  /**
   * OCR-01 Defect 3: the manually uploaded model has to actually get used, via
   * the exact shape `createWorker` accepts — a plain language string, with the
   * bytes already sitting in tesseract's own cache — never the `{ code, data }`
   * array shape that broke `initialize()`.
   */
  it('seeds tesseract\'s cache from a manual upload and calls the worker with a plain language string (OCR-01 Defect 3)', async () => {
    const uploadedBytes = new Uint8Array([7, 7, 7, 7]);
    // Simulates `OcrConsentDialog`'s upload handler: it writes the bytes to
    // OPFS *before* resolving the consent promise with 'upload'.
    requestOcrConsent.mockImplementation(async () => {
      const { writeModelBytes } = await import('../../src/core/opfs');
      await writeModelBytes('eng', uploadedBytes);
      return 'upload';
    });

    mockWorkersForOneSuccessfulPage();
    let capturedOptions: unknown;
    ocrLease.mockImplementation(async (fn: (api: unknown) => unknown) =>
      fn({
        recognizePage: async (_bitmap: unknown, options: unknown) => {
          capturedOptions = options;
          return { words: [], text: '' };
        }
      })
    );

    const { runOcr } = await import('../../src/core/ocr/runOcr');
    const result = await runOcr(new Uint8Array([1]), 1);

    expect(result?.downloadedModel).toBe(true);
    expect(fetchVerifiedModel).not.toHaveBeenCalled(); // upload never touches the network
    // The uploaded bytes landed in tesseract's own cache, under the plain
    // language code — the only place `createWorker` can find them given a
    // plain-string `lang` (see ocr.worker.ts).
    expect(Array.from(tesseractCacheStore.get('eng') ?? [])).toEqual(Array.from(uploadedBytes));
    // The worker call itself carries only the language — never bytes, never a
    // `{ code, data }` array, never a `modelBase`/`langPath`.
    expect(capturedOptions).toEqual({ lang: 'eng' });
  });

  it('names the model, its size, the host, and the one-time nature in the dialog', async () => {
    const { modelConsentCopy } = await import('../../src/core/ocr/runOcr');
    const { body } = modelConsentCopy(['eng']);
    expect(body).toContain('cdn.jsdelivr.net');
    expect(body).toMatch(/\d+ MB/);
    expect(body).toMatch(/once/i);
    expect(body).toMatch(/no network/i);
    expect(body).toMatch(/never uploaded/i);
  });

  it('discloses only the languages actually missing, combined into one size', async () => {
    const { modelConsentCopy } = await import('../../src/core/ocr/runOcr');
    const { title, body } = modelConsentCopy(['eng', 'hin']);
    expect(title).toContain('English + Hindi');
    // 12 MB (eng) + 2 MB (hin), from the OCR_LANGUAGES catalogue.
    expect(body).toMatch(/14 MB/);
  });
});

/*
 * A combined `eng+hin` run cannot lean on tesseract's own loader — each
 * component lives at a different base URL, and (post OCR-01 Defects 1 & 3)
 * tesseract's internal loader is never allowed to fetch on its own anyway. So
 * `runOcr` fetches, verifies, and caches each missing component itself, via
 * the mocked `fetchVerifiedModel`/`tesseractCacheStore` seams.
 */
describe('ocr/runOcr — combined-language download', () => {
  const setUpWorkers = () => {
    renderPin.lease.mockImplementation(async (fn: (api: unknown) => unknown) =>
      fn({
        loadDocument: async () => ({ handle: 'h' }),
        renderPage: async () => ({ width: 10, height: 10, close() {} }),
        closeDocument: async () => {}
      })
    );
    cvLease.mockImplementation(async (fn: (api: unknown) => unknown) =>
      fn({ cleanupForOcr: async (bitmap: unknown) => bitmap })
    );
    ocrLease.mockResolvedValue({ words: [], text: '' });
    processLease.mockResolvedValue({
      bytes: new Uint8Array([9]),
      wordsAdded: 0,
      wordsSkipped: 0,
      pagesTouched: 0,
      pagesReplaced: 0
    });
  };

  beforeEach(async () => {
    settings.clear();
    tesseractCacheStore.clear();
    requestOcrConsent.mockReset();
    renderPin.lease.mockReset();
    renderPin.release.mockReset();
    cvLease.mockReset();
    ocrLease.mockReset();
    processLease.mockReset();
    fetchVerifiedModel.mockReset();
    fetchVerifiedModel.mockImplementation(async (lang: string) =>
      new TextEncoder().encode(`fake-model-bytes-${lang}`)
    );
    // `__memoryFallback` is a module-level OPFS stand-in: without clearing it,
    // a language "downloaded" by an earlier test in this file stays available
    // to every test after it.
    const { __memoryFallback } = await import('../../src/core/opfs');
    __memoryFallback.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('discloses every missing component, fetches and caches each one, and proceeds once download is chosen', async () => {
    requestOcrConsent.mockResolvedValue('download');
    setUpWorkers();

    const { runOcr } = await import('../../src/core/ocr/runOcr');

    const result = await runOcr(new Uint8Array([1]), 1, { lang: 'eng+hin' });

    expect(requestOcrConsent).toHaveBeenCalledWith(
      ['eng', 'hin'],
      expect.any(String),
      expect.any(String)
    );
    // OCR-01 Defects 1 & 3: Stapler fetches (and, in the real module, verifies)
    // every missing component itself, rather than leaving tesseract's own
    // loader to do it — so both land in its cache before the worker ever runs.
    expect(fetchVerifiedModel).toHaveBeenCalledWith('eng', undefined);
    expect(fetchVerifiedModel).toHaveBeenCalledWith('hin', undefined);
    expect(tesseractCacheStore.has('eng')).toBe(true);
    expect(tesseractCacheStore.has('hin')).toBe(true);
    expect(result?.downloadedModel).toBe(true);
    expect(settings.get('ocr.modelDownloaded.eng')).toBe(true);
    expect(settings.get('ocr.modelDownloaded.hin')).toBe(true);
  });

  it('only discloses, fetches, and caches the component not already available', async () => {
    tesseractCacheStore.set('eng', new Uint8Array([1]));
    requestOcrConsent.mockResolvedValue('download');
    setUpWorkers();

    const { runOcr } = await import('../../src/core/ocr/runOcr');

    await runOcr(new Uint8Array([1]), 1, { lang: 'eng+hin' });

    expect(requestOcrConsent).toHaveBeenCalledWith(['hin'], expect.any(String), expect.any(String));
    expect(fetchVerifiedModel).toHaveBeenCalledWith('hin', undefined);
    expect(fetchVerifiedModel).not.toHaveBeenCalledWith('eng', undefined);
  });

  it('asks for nothing once every component is already cached', async () => {
    tesseractCacheStore.set('eng', new Uint8Array([1]));
    tesseractCacheStore.set('hin', new Uint8Array([2]));
    setUpWorkers();

    const { runOcr } = await import('../../src/core/ocr/runOcr');

    const result = await runOcr(new Uint8Array([1]), 1, { lang: 'eng+hin' });

    expect(requestOcrConsent).not.toHaveBeenCalled();
    expect(fetchVerifiedModel).not.toHaveBeenCalled();
    expect(result?.downloadedModel).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * devanagariFont.ts — the vendored font that makes Hindi words encodable
 * ------------------------------------------------------------------ */

describe('ocr/devanagariFont — the vendored subset font', () => {
  it('encodes real Devanagari text via fontkit, once registered on a document', async () => {
    const fontkitModule = await import('fontkit');
    const fs = await import('node:fs');
    const path = await import('node:path');

    const fontPath = path.resolve(__dirname, '../../src/core/ocr/assets/NotoSansDevanagari.ttf');
    const bytes = fs.readFileSync(fontPath);

    const doc = await PDFDocument.create();
    doc.registerFontkit((fontkitModule as { default?: unknown }).default ?? fontkitModule);
    const font = await doc.embedFont(bytes, { subset: true });

    // "Secretariat" — the word this feature exists for (see the Adobe Scan
    // fixture that prompted it), not an arbitrary test string.
    const text = 'सचिवालय';
    expect(() => font.encodeText(text)).not.toThrow();
    expect(font.widthOfTextAtSize(text, 12)).toBeGreaterThan(0);

    // The subset is Basic Latin + Devanagari only — this proves the range was
    // actually kept, not just that *some* glyph exists for U+0000.
    expect(() => font.encodeText('Ashwani Kumar Verma 2026')).not.toThrow();
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

    expect(report).toEqual({ wordsAdded: 2, wordsSkipped: 0, pagesTouched: 1, pagesReplaced: 0 });

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

  it('skips a word no available font can encode instead of mangling it', async () => {
    // No fallback font asset is reachable in this test environment (`fetch`
    // against the bundled font's `file://` URL is unsupported under Node — see
    // the mocked-fetch test below for the case where it is reachable), so this
    // exercises the "no fallback available" path: CJK is outside both WinAnsi
    // and the Devanagari fallback's range, so it is skipped either way.
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
          // CJK is outside WinAnsi, and no fallback is available here.
          { text: '文字', bbox: { x0: 40, y0: 10, x1: 60, y1: 22 }, confidence: 90 },
          // A degenerate box is nonsense geometry, not text.
          { text: 'zero', bbox: { x0: 10, y0: 30, x1: 10, y1: 30 }, confidence: 90 }
        ]
      }
    ]);

    expect(report.wordsAdded).toBe(1);
    expect(report.wordsSkipped).toBe(2);
  });

  /**
   * The bug this feature exists to fix: before the Devanagari fallback font,
   * every Hindi word here would have hit the same Helvetica-can't-encode-it
   * path as the CJK word above and been silently dropped from the text layer —
   * recognised by Tesseract, then discarded before ever reaching the export.
   */
  it('keeps a Devanagari word instead of skipping it, via the fallback font', async () => {
    // `embedDevanagariFont` fetches the bundled font by URL — real in a browser
    // (a same-origin asset), unsupported for a `file://` URL under Node. This
    // stubs `fetch` to read the actual vendored file straight off disk, so the
    // test still exercises the real bytes and the real fontkit/pdf-lib embed,
    // just without relying on Node's `fetch` supporting `file://`.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const fontPath = path.resolve(__dirname, '../../src/core/ocr/assets/NotoSansDevanagari.ttf');
    const fontBytes = fs.readFileSync(fontPath);
    vi.stubGlobal('fetch', async (url: string | URL) => {
      if (String(url).endsWith('NotoSansDevanagari.ttf')) {
        return { ok: true, arrayBuffer: async () => fontBytes.buffer } as Response;
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    });

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
          { text: 'सचिवालय', bbox: { x0: 40, y0: 10, x1: 90, y1: 22 }, confidence: 90 }
        ]
      }
    ]);

    expect(report.wordsAdded).toBe(2);
    expect(report.wordsSkipped).toBe(0);

    const bytes = await doc.save();
    const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const pdf = await lib.getDocument({ data: bytes.slice(), useSystemFonts: false }).promise;
    const content = await (await pdf.getPage(1)).getTextContent();
    const text = content.items.map(item => ('str' in item ? item.str : '')).join(' ');
    expect(text).toContain('सचिवालय');

    vi.unstubAllGlobals();
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

    expect(report).toEqual({ wordsAdded: 0, wordsSkipped: 0, pagesTouched: 0, pagesReplaced: 0 });
    expect(pageStreamBytes(doc, 0).length).toBe(before.length);
  });

  /**
   * The actual bug report this feature exists for: a scanning app's own OCR
   * pass left a broken, garbled invisible text layer over a scan. Re-running
   * Stapler's OCR on that page must *replace* it, not stack a second layer
   * that a text extractor then returns mixed in with the first.
   */
  it('replaces a pre-existing invisible text layer rather than stacking a second one', async () => {
    const { addOcrTextLayerToDocument } = await import('../../src/core/ocr/textLayer');

    // First pass: simulates the broken layer already in the file — same
    // shape a real scanning app's OCR would have produced.
    const doc = await fixtureWithVisibleText();
    const firstPass = await addOcrTextLayerToDocument(doc, [
      {
        pageIndex: 0,
        bitmapWidth: 200,
        bitmapHeight: 400,
        dpi: 72,
        words: [{ text: 'gArB1sh', bbox: { x0: 40, y0: 10, x1: 90, y1: 22 }, confidence: 40 }]
      }
    ]);
    expect(firstPass.wordsAdded).toBe(1);
    expect(firstPass.pagesReplaced).toBe(0); // Nothing to replace yet.
    const reloaded = await PDFDocument.load(await doc.save());

    // Second pass: Stapler's own re-OCR, with the corrected word.
    const secondPass = await addOcrTextLayerToDocument(reloaded, [
      {
        pageIndex: 0,
        bitmapWidth: 200,
        bitmapHeight: 400,
        dpi: 72,
        words: [{ text: 'Ottoline', bbox: { x0: 40, y0: 10, x1: 90, y1: 22 }, confidence: 96 }]
      }
    ]);
    expect(secondPass.wordsAdded).toBe(1);
    expect(secondPass.pagesReplaced).toBe(1);

    const bytes = await reloaded.save();
    const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const pdf = await lib.getDocument({ data: bytes.slice(), useSystemFonts: false }).promise;
    const content = await (await pdf.getPage(1)).getTextContent();
    const text = content.items.map(item => ('str' in item ? item.str : '')).join(' ');

    expect(text).not.toContain('gArB1sh');
    expect(text).toContain('Ottoline');
    // The page's own visible content is untouched by either pass.
    expect(text).toContain('VISIBLE');
  });
});
