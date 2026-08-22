import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * RED-08's second acceptance criterion: declining the model download leaves the
 * tool disabled with a clear message, and never a silent no-op.
 *
 * This file lives apart from `faceblur.test.ts` because the two need opposite
 * worlds. That one runs the real detector against real weights; this one mocks
 * the worker pool and `fetch` outright, because the only way to prove "nothing
 * was requested" is to make a request impossible and show nothing tried.
 *
 * `fetch` is stubbed to *throw* rather than to resolve. A stub that returns
 * something would still pass a test that only counts calls, but it would also
 * quietly let a regression through in any code path that ignores the result.
 */

const MODEL_DIR = path.resolve(__dirname, '../../node_modules/@vladmandic/face-api/model');
const MANIFEST_FILE = 'tiny_face_detector_model-weights_manifest.json';

/** In-memory stand-in for the `settings` store, so no IndexedDB is needed. */
const settings = new Map<string, unknown>();

vi.mock('../../src/core/db', () => ({
  readSetting: vi.fn(async (key: string) => settings.get(key)),
  writeSetting: vi.fn(async (key: string, value: unknown) => {
    settings.set(key, value);
  })
}));

const confirmAction = vi.fn();
vi.mock('../../src/core/notify', () => ({
  confirmAction: (...args: unknown[]) => confirmAction(...args),
  notify: vi.fn()
}));

/**
 * The worker pool is the seam between `runFaceBlur` and anything that could
 * load a model or touch a pixel. If none of these is called, nothing happened.
 */
const renderPin = { lease: vi.fn(), release: vi.fn() };
const processLease = vi.fn();

vi.mock('../../src/core/workers', () => ({
  renderWorker: { pin: () => renderPin },
  processWorker: { lease: (...args: unknown[]) => processLease(...args) }
}));

const FLAG = 'faceblur.modelDownloaded.tiny_face_detector@1.7.15';

/** A `fetch` that serves the installed package's weights and records every URL. */
function localFetch(requested: string[]) {
  return vi.fn(async (url: string) => {
    requested.push(String(url));
    const name = String(url).split('/').pop() ?? '';
    const bytes = readFileSync(path.join(MODEL_DIR, name));
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      arrayBuffer: async () =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    } as unknown as Response;
  });
}

/** Enough of the worker API for a run that finds one image and blurs nothing. */
function setUpWorkers() {
  processLease.mockImplementation(async (fn: (api: unknown) => unknown) =>
    fn({
      planPageImages: async () => ({
        images: [{ pageIndex: 0, name: 'Im0', objectNumber: 7 }],
        unaddressablePages: []
      }),
      planImageRedactions: async () => [],
      replacePageImages: async () => new Uint8Array([9, 9, 9])
    })
  );
  renderPin.lease.mockImplementation(async (fn: (api: unknown) => unknown) =>
    fn({
      loadDocument: async () => ({ handle: 'h', pageCount: 1, pageSizes: [] }),
      closeDocument: async () => {},
      loadFaceDetector: async () => {},
      blurPageImages: async () => [{ objectNumber: 7, regions: [] }],
      extractImageRegion: async () => null
    })
  );
}

beforeEach(async () => {
  settings.clear();
  confirmAction.mockReset();
  renderPin.lease.mockReset();
  renderPin.release.mockReset();
  processLease.mockReset();
  const { __memoryFallback } = await import('../../src/core/opfs');
  __memoryFallback.clear();
  const { setModelBaseOverride } = await import('../../src/core/faceblur/model');
  setModelBaseOverride(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('faceblur/modelState', () => {
  it('starts opted out, and only records the model after an explicit opt-in', async () => {
    const { isFaceModelDownloaded, markFaceModelDownloaded, forgetFaceModel } =
      await import('../../src/core/faceblur/modelState');
    expect(await isFaceModelDownloaded('m')).toBe(false);
    await markFaceModelDownloaded('m');
    expect(await isFaceModelDownloaded('m')).toBe(true);
    await forgetFaceModel('m');
    expect(await isFaceModelDownloaded('m')).toBe(false);
  });
});

describe('faceblur/runFaceBlur — the confirmation gate', () => {
  it('touches no worker and makes no request at all when the user declines', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('fetch must not be reachable on the decline path');
    });
    vi.stubGlobal('fetch', fetchSpy);
    confirmAction.mockResolvedValue(false);

    const { runFaceBlur } = await import('../../src/core/faceblur/runFaceBlur');
    const result = await runFaceBlur(new Uint8Array([1, 2, 3]), 2);

    // `null` is the "user said no" signal — not an error, and not a document.
    expect(result).toBeNull();
    expect(confirmAction).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    // Nothing was opened, detected, or written, so nothing could have fetched
    // by another route either.
    expect(renderPin.lease).not.toHaveBeenCalled();
    expect(processLease).not.toHaveBeenCalled();
    // Declining must not be remembered as consent.
    expect(settings.get(FLAG)).toBeUndefined();
  });

  it('asks before it fetches, not after', async () => {
    const order: string[] = [];
    confirmAction.mockImplementation(async () => {
      order.push('asked');
      return false;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        order.push('fetched');
        throw new Error('unreachable');
      })
    );

    const { runFaceBlur } = await import('../../src/core/faceblur/runFaceBlur');
    await runFaceBlur(new Uint8Array([1]), 1);
    expect(order).toEqual(['asked']);
  });

  it('names the model, its size, the host, the one-time nature, and where it runs', async () => {
    const { faceModelConsentCopy } = await import('../../src/core/faceblur/runFaceBlur');
    const { body } = faceModelConsentCopy();
    expect(body).toContain('cdn.jsdelivr.net');
    expect(body).toMatch(/[\d.]+ MB/);
    expect(body).toMatch(/once/i);
    expect(body).toMatch(/no network/i);
    expect(body).toMatch(/never uploaded/i);
    expect(body).toMatch(/on your device/i);
  });

  it('downloads through the pinned URL only after consent, and records it after success', async () => {
    const requested: string[] = [];
    vi.stubGlobal('fetch', localFetch(requested));
    confirmAction.mockResolvedValue(true);
    setUpWorkers();

    const { setModelBaseOverride, resolveManifestUrl } =
      await import('../../src/core/faceblur/model');
    setModelBaseOverride(`file://${MODEL_DIR}`);
    const { runFaceBlur } = await import('../../src/core/faceblur/runFaceBlur');

    const result = await runFaceBlur(new Uint8Array([1]), 1);

    expect(confirmAction).toHaveBeenCalledTimes(1);
    expect(result).not.toBeNull();
    expect(result!.downloadedModel).toBe(true);
    // Exactly two files: the manifest, and the one shard it names.
    expect(requested).toEqual([
      resolveManifestUrl(),
      `file://${MODEL_DIR}/tiny_face_detector_model.bin`
    ]);
    expect(settings.get(FLAG)).toBe(true);
  });

  it('records consent even when the document turns out to have no images at all', async () => {
    const requested: string[] = [];
    vi.stubGlobal('fetch', localFetch(requested));
    confirmAction.mockResolvedValue(true);
    processLease.mockImplementation(async (fn: (api: unknown) => unknown) =>
      fn({ planPageImages: async () => ({ images: [], unaddressablePages: [] }) })
    );

    const { setModelBaseOverride } = await import('../../src/core/faceblur/model');
    setModelBaseOverride(`file://${MODEL_DIR}`);
    const { runFaceBlur } = await import('../../src/core/faceblur/runFaceBlur');

    const result = await runFaceBlur(new Uint8Array([1]), 1);

    // The user already agreed and the download already happened above — a
    // document with nothing to check must not throw that consent away and
    // make the next run ask again.
    expect(result!.downloadedModel).toBe(true);
    expect(settings.get(FLAG)).toBe(true);
  });

  it('asks exactly once: a second run with the flag set shows no dialog and fetches nothing', async () => {
    settings.set(FLAG, true);
    const requested: string[] = [];
    const fetchSpy = localFetch(requested);
    vi.stubGlobal('fetch', fetchSpy);
    setUpWorkers();

    const { setModelBaseOverride } = await import('../../src/core/faceblur/model');
    setModelBaseOverride(`file://${MODEL_DIR}`);
    const { ensureFaceModelWeights } = await import('../../src/core/faceblur/download');
    // Prime the cache the way a first run would have.
    await ensureFaceModelWeights();
    requested.length = 0;

    const { runFaceBlur } = await import('../../src/core/faceblur/runFaceBlur');
    const result = await runFaceBlur(new Uint8Array([1]), 1);

    expect(confirmAction).not.toHaveBeenCalled();
    expect(requested).toEqual([]);
    expect(result!.downloadedModel).toBe(false);
  });

  it('does not record consent when the run fails after the dialog', async () => {
    vi.stubGlobal('fetch', localFetch([]));
    confirmAction.mockResolvedValue(true);
    processLease.mockRejectedValue(new Error('broken document'));

    const { setModelBaseOverride } = await import('../../src/core/faceblur/model');
    setModelBaseOverride(`file://${MODEL_DIR}`);
    const { runFaceBlur } = await import('../../src/core/faceblur/runFaceBlur');

    await expect(runFaceBlur(new Uint8Array([1]), 1)).rejects.toThrow('broken document');
    // A failed run must leave the user opted *out*, so the next attempt asks
    // again rather than silently repeating a fetch they never agreed to repeat.
    expect(settings.get(FLAG)).toBeUndefined();
  });

  it('asks for nothing at all in logo-only mode, because that half needs no model', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('logo matching must never reach the network');
    });
    vi.stubGlobal('fetch', fetchSpy);
    processLease.mockImplementation(async (fn: (api: unknown) => unknown) =>
      fn({
        planPageImages: async () => ({
          images: [{ pageIndex: 0, name: 'Im0', objectNumber: 7 }],
          unaddressablePages: []
        }),
        planImageRedactions: async () => [
          {
            pageIndex: 0,
            name: 'Im0',
            objectNumber: 7,
            rects: [{ x: 0, y: 0, width: 1, height: 1 }]
          }
        ],
        replacePageImages: async () => new Uint8Array([9])
      })
    );
    renderPin.lease.mockImplementation(async (fn: (api: unknown) => unknown) =>
      fn({
        loadDocument: async () => ({ handle: 'h', pageCount: 1, pageSizes: [] }),
        closeDocument: async () => {},
        loadFaceDetector: async () => {
          throw new Error('no detector should be loaded for a logo-only run');
        },
        extractImageRegion: async () => ({
          rgba: new Uint8ClampedArray(16),
          width: 2,
          height: 2
        }),
        blurPageImages: async () => [{ objectNumber: 7, regions: [] }]
      })
    );

    const { runFaceBlur } = await import('../../src/core/faceblur/runFaceBlur');
    const result = await runFaceBlur(new Uint8Array([1]), 1, {
      detectFaces: false,
      logoRegion: { pageIndex: 0, x: 0.1, y: 0.1, width: 0.2, height: 0.2 }
    });

    expect(confirmAction).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).not.toBeNull();
    expect(result!.downloadedModel).toBe(false);
  });

  it('returns the original bytes untouched when nothing was found', async () => {
    settings.set(FLAG, true);
    vi.stubGlobal('fetch', localFetch([]));
    setUpWorkers();
    const replace = vi.fn();
    processLease.mockImplementation(async (fn: (api: unknown) => unknown) =>
      fn({
        planPageImages: async () => ({
          images: [{ pageIndex: 0, name: 'Im0', objectNumber: 7 }],
          unaddressablePages: []
        }),
        planImageRedactions: async () => [],
        replacePageImages: replace
      })
    );

    const { setModelBaseOverride } = await import('../../src/core/faceblur/model');
    setModelBaseOverride(`file://${MODEL_DIR}`);
    const { runFaceBlur } = await import('../../src/core/faceblur/runFaceBlur');

    const original = new Uint8Array([1, 2, 3, 4]);
    const result = await runFaceBlur(original, 1);

    // A save that changes nothing still changes the file. "No faces found"
    // must not silently mean "we rewrote your document anyway".
    expect(result!.bytes).toBe(original);
    expect(replace).not.toHaveBeenCalled();
  });
});

describe('faceblur/download — the cache that makes it happen once', () => {
  it('serves the second call from OPFS with no request', async () => {
    const requested: string[] = [];
    vi.stubGlobal('fetch', localFetch(requested));
    const { setModelBaseOverride } = await import('../../src/core/faceblur/model');
    setModelBaseOverride(`file://${MODEL_DIR}`);
    const { ensureFaceModelWeights, hasCachedFaceModel } =
      await import('../../src/core/faceblur/download');

    expect(await hasCachedFaceModel()).toBe(false);
    const first = await ensureFaceModelWeights();
    expect(requested.length).toBe(2);
    expect(first.shard.byteLength).toBeGreaterThan(100_000);

    requested.length = 0;
    const second = await ensureFaceModelWeights();
    expect(requested).toEqual([]);
    expect(second.shard.byteLength).toBe(first.shard.byteLength);
    expect(await hasCachedFaceModel()).toBe(true);
  });

  it('refuses a response that is not the pinned file rather than caching it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        // A captive-portal login page, or the wrong URL entirely.
        arrayBuffer: async () => new TextEncoder().encode('<html>Sign in</html>').buffer
      }))
    );
    const { setModelBaseOverride } = await import('../../src/core/faceblur/model');
    setModelBaseOverride('https://example.invalid/weights');
    const { ensureFaceModelWeights, hasCachedFaceModel } =
      await import('../../src/core/faceblur/download');
    await expect(ensureFaceModelWeights()).rejects.toThrow();
    expect(await hasCachedFaceModel()).toBe(false);
  });

  it('caches nothing when the shard fails after the manifest succeeded', async () => {
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        call += 1;
        if (call === 1) {
          const bytes = readFileSync(path.join(MODEL_DIR, MANIFEST_FILE));
          return {
            ok: true,
            status: 200,
            statusText: 'OK',
            arrayBuffer: async () =>
              bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
          } as unknown as Response;
        }
        expect(url).toContain('.bin');
        return { ok: false, status: 503, statusText: 'Service Unavailable' } as Response;
      })
    );
    const { setModelBaseOverride } = await import('../../src/core/faceblur/model');
    setModelBaseOverride('https://example.invalid/weights');
    const { ensureFaceModelWeights, hasCachedFaceModel } =
      await import('../../src/core/faceblur/download');

    await expect(ensureFaceModelWeights()).rejects.toThrow(/503/);
    // A half-finished download must not leave a cache that looks complete.
    expect(await hasCachedFaceModel()).toBe(false);
  });
});
