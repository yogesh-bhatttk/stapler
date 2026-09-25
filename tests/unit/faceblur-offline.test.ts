import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * RED-08 after audit 2026-09-25 CNV-6 / PLT-8: the face-detector weights are
 * bundled, so face blur makes no request and asks for no consent — it is an
 * ordinary offline tool.
 *
 * This file mocks the worker pool and makes `fetch` *throw*, so the only way a
 * test passes is if nothing on the path tries to reach the network at all. A
 * stub that resolved would also pass a call count, but would let a regression
 * through in any code path that ignored the result.
 */

const MODEL_DIR = path.resolve(__dirname, '../../node_modules/@vladmandic/face-api/model');
const MANIFEST_FILE = 'tiny_face_detector_model-weights_manifest.json';

const confirmAction = vi.fn();
vi.mock('../../src/core/notify', () => ({
  confirmAction: (...args: unknown[]) => confirmAction(...args),
  notify: vi.fn()
}));

const renderPin = { lease: vi.fn(), release: vi.fn() };
const processLease = vi.fn();

vi.mock('../../src/core/workers', () => ({
  renderWorker: { pin: () => renderPin },
  processWorker: { lease: (...args: unknown[]) => processLease(...args) }
}));

const fetchSpy = vi.fn(() => {
  throw new Error('face blur must never reach the network');
});

/** Enough of the worker API for a run that finds one image and blurs nothing. */
function setUpWorkers(loadFaceDetector = vi.fn(async () => {})) {
  processLease.mockImplementation(async (fn: (api: unknown) => unknown) =>
    fn({
      planPageImages: async () => ({
        images: [{ pageIndex: 0, name: 'Im0', objectNumber: 7 }],
        unaddressablePages: [],
        formImagePages: []
      }),
      planImageRedactions: async () => [],
      replacePageImages: async () => new Uint8Array([9, 9, 9])
    })
  );
  renderPin.lease.mockImplementation(async (fn: (api: unknown) => unknown) =>
    fn({
      loadDocument: async () => ({ handle: 'h', pageCount: 1, pageSizes: [] }),
      closeDocument: async () => {},
      loadFaceDetector,
      blurPageImages: async () => [{ objectNumber: 7, regions: [] }],
      extractImageRegion: async () => null
    })
  );
  return loadFaceDetector;
}

beforeEach(() => {
  confirmAction.mockReset();
  renderPin.lease.mockReset();
  renderPin.release.mockReset();
  processLease.mockReset();
  fetchSpy.mockClear();
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('faceblur/model — bundled weights', () => {
  it('decodes to exactly the files shipped in the installed face-api package', async () => {
    const { loadBundledFaceModelWeights } = await import('../../src/core/faceblur/model');
    const weights = await loadBundledFaceModelWeights();

    const manifestOnDisk = JSON.parse(readFileSync(path.join(MODEL_DIR, MANIFEST_FILE), 'utf8'));
    const shardOnDisk = new Uint8Array(
      readFileSync(path.join(MODEL_DIR, manifestOnDisk[0].paths[0] as string))
    );
    expect(weights.manifest).toEqual(manifestOnDisk);
    expect(weights.shard.byteLength).toBe(shardOnDisk.byteLength);
    expect(Buffer.from(weights.shard).equals(Buffer.from(shardOnDisk))).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('checks the shard length against the tensor shapes its manifest declares', async () => {
    const { loadBundledFaceModelWeights, expectedShardBytes } =
      await import('../../src/core/faceblur/model');
    const weights = await loadBundledFaceModelWeights();
    expect(expectedShardBytes(weights.manifest)).toBe(weights.shard.byteLength);
  });

  it('names the same face-api version the bundled engine is', async () => {
    const { MODEL_PACKAGE_VERSION } = await import('../../src/core/faceblur/model');
    const installed = JSON.parse(
      readFileSync(
        path.resolve(__dirname, '../../node_modules/@vladmandic/face-api/package.json'),
        'utf8'
      )
    ) as { version: string };
    expect(MODEL_PACKAGE_VERSION).toBe(installed.version);
  });

  it('has no network allowance left: model.ts names no host and no URL', () => {
    const source = readFileSync(
      path.resolve(__dirname, '../../src/core/faceblur/model.ts'),
      'utf8'
    );
    expect(source).not.toMatch(/https?:\/\//);
    expect(source).not.toMatch(/\bfetch\s*\(/);
  });
});

describe('faceblur/runFaceBlur — offline by construction', () => {
  it('asks nothing, fetches nothing, and loads the bundled detector for a face run', async () => {
    const loadFaceDetector = setUpWorkers();
    const { runFaceBlur } = await import('../../src/core/faceblur/runFaceBlur');

    const result = await runFaceBlur(new Uint8Array([1]), 1);

    expect(confirmAction).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(loadFaceDetector).toHaveBeenCalledTimes(1);
    // No weights travel from the main thread: the worker decodes its own copy.
    expect(loadFaceDetector).toHaveBeenCalledWith();
    expect(result.imagesInspected).toBe(1);
  });

  it('does not load the detector at all in logo-only mode', async () => {
    processLease.mockImplementation(async (fn: (api: unknown) => unknown) =>
      fn({
        planPageImages: async () => ({
          images: [{ pageIndex: 0, name: 'Im0', objectNumber: 7 }],
          unaddressablePages: [],
          formImagePages: []
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
    expect(result.imagesInspected).toBe(1);
  });

  it('returns the original bytes untouched when nothing was found', async () => {
    setUpWorkers();
    const replace = vi.fn();
    processLease.mockImplementation(async (fn: (api: unknown) => unknown) =>
      fn({
        planPageImages: async () => ({
          images: [{ pageIndex: 0, name: 'Im0', objectNumber: 7 }],
          unaddressablePages: [],
          formImagePages: []
        }),
        planImageRedactions: async () => [],
        replacePageImages: replace
      })
    );

    const { runFaceBlur } = await import('../../src/core/faceblur/runFaceBlur');
    const original = new Uint8Array([1, 2, 3, 4]);
    const result = await runFaceBlur(original, 1);

    // A save that changes nothing still changes the file. "No faces found"
    // must not silently mean "we rewrote your document anyway".
    expect(result.bytes).toBe(original);
    expect(replace).not.toHaveBeenCalled();
  });

  it('reports images inside a form as not checked, never as a clean result (PDF-14)', async () => {
    processLease.mockImplementation(async (fn: (api: unknown) => unknown) =>
      fn({
        planPageImages: async () => ({ images: [], unaddressablePages: [], formImagePages: [0] })
      })
    );
    const { runFaceBlur } = await import('../../src/core/faceblur/runFaceBlur');
    const result = await runFaceBlur(new Uint8Array([1]), 1);
    expect(result.imagesInspected).toBe(0);
    expect(result.skipped).toEqual([
      { pageIndex: 0, reason: expect.stringMatching(/inside a form.*not checked/) }
    ]);
  });

  it('returns a report even when the document has no images at all', async () => {
    processLease.mockImplementation(async (fn: (api: unknown) => unknown) =>
      fn({
        planPageImages: async () => ({ images: [], unaddressablePages: [], formImagePages: [] })
      })
    );
    const { runFaceBlur } = await import('../../src/core/faceblur/runFaceBlur');
    const original = new Uint8Array([1]);
    const result = await runFaceBlur(original, 1);
    expect(result.imagesInspected).toBe(0);
    expect(result.bytes).toBe(original);
    expect(renderPin.lease).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
