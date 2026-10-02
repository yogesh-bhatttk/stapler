/**
 * CNV-14 — the exact width × height option of PDF → Images.
 *
 *  - The worker (`pageToSizedImage`, the real render-worker implementation on
 *    pdf.js + Skia) gives exactly the pixels asked for, checked on the
 *    *decoded* PNG/JPEG, locked and unlocked, with a size target, and on
 *    pages turned by `/Rotate`.
 *  - The panel's state helpers: per-page sizes, "varies", the pixel cap, the
 *    archive name.
 *  - The real `commitTool('pdf-to-img')`: invalid input is refused before the
 *    document is composed, and a full export's ZIP holds images of exactly the
 *    requested size — including a page rotated in Stapler — under a name that
 *    says the size.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument, degrees, rgb } from 'pdf-lib';
import { decodeToRgba, installCanvasShims } from './helpers/node-canvas-shims';

const saved: { name: string; bytes: Uint8Array }[] = [];

vi.mock('comlink', () => ({
  expose: vi.fn(),
  transfer: vi.fn(value => value),
  proxy: vi.fn(value => value),
  releaseProxy: Symbol('releaseProxy')
}));
vi.mock('../../src/core/workers/pdfjs-setup', async () => {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return {
    pdfjsLib,
    openDocument: ({ data, password }: { data: Uint8Array; password?: string }) =>
      pdfjsLib.getDocument({ data, password, disableFontFace: true, verbosity: 0 })
  };
});
vi.mock('../../src/platform/current', () => ({
  platform: {
    kind: 'web',
    supportsFileSystemAccess: false,
    saveFileAs: async (bytes: Uint8Array, name: string) => {
      saved.push({ name, bytes });
      return true;
    },
    openFiles: async () => [],
    openDirectory: async () => null,
    saveOver: async () => false,
    persistHandle: async () => {},
    restoreHandles: async () => [],
    reopenHandle: async () => null,
    revokeHandle: async () => {},
    readClipboardImage: async () => null
  }
}));
vi.mock('../../src/core/workers', async () => {
  const { processWorkerImpl } = await import('../../src/core/workers/process.worker');
  const { renderWorkerImpl } = await import('../../src/core/workers/render.worker');
  // `any`: stands in for the pool's `Comlink.Remote<T>` wrapper.
  const client = (impl: any) => ({
    lease: (fn: (api: any) => unknown) => fn(impl),
    pin: () => ({ lease: (fn: (api: any) => unknown) => fn(impl), release: () => {} })
  });
  const unavailable = new Proxy(
    {},
    {
      get: () => () => {
        throw new Error('This test does not run that worker');
      }
    }
  );
  return {
    processWorker: client(processWorkerImpl),
    renderWorker: client(renderWorkerImpl),
    cvWorker: client(unavailable),
    ocrWorker: client(unavailable),
    convertWorker: client(unavailable),
    imageWorker: client(unavailable)
  };
});
vi.mock('../../src/core/notify', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/core/notify')>();
  return { ...actual, requestExportReview: async () => true, confirmAction: async () => true };
});
vi.mock('../../src/core/operations', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/core/operations')>();
  return {
    ...actual,
    currentDocumentBytes: vi.fn(actual.currentDocumentBytes),
    pagesToImageArchive: vi.fn(actual.pagesToImageArchive),
    pagesToSizedImageArchive: vi.fn(actual.pagesToSizedImageArchive)
  };
});

installCanvasShims();
const { renderWorkerImpl } = await import('../../src/core/workers/render.worker');
const { commitTool } = await import('../../src/ui/tools/commit');
const store = await import('../../src/core/store');
const { resetHistory } = await import('../../src/core/history');
const { __memoryFallback } = await import('../../src/core/opfs');
const { toasts } = await import('../../src/core/notify');
const ops = await import('../../src/core/operations');
const { pdfToImageSettings } = await import('../../src/ui/tools/state');
const { DEFAULT_EXACT_SIZE } = await import('../../src/ui/tools/image-size/state');
const state = await import('../../src/ui/tools/convert/pdf-to-img-state');
const { unzipSync } = await import('fflate');

/** Portrait A4, landscape A4, Letter, and an A4 stored portrait with /Rotate 90. */
const PAGES: { size: [number, number]; rotate?: number }[] = [
  { size: [595, 842] },
  { size: [842, 595] },
  { size: [612, 792] },
  { size: [595, 842], rotate: 90 }
];
/** As seen (rotated), in points. */
const SEEN = PAGES.map(({ size: [w, h], rotate }) =>
  rotate && rotate % 180 ? { width: h, height: w } : { width: w, height: h }
);

/** Each page filled edge to edge with black, so a stretch that misses an edge shows as white. */
async function fixturePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const { size, rotate } of PAGES) {
    const page = doc.addPage(size);
    page.drawRectangle({ x: 0, y: 0, width: size[0], height: size[1], color: rgb(0, 0, 0) });
    if (rotate) page.setRotation(degrees(rotate));
  }
  return doc.save();
}

/** True when every pixel along each edge (one in from it) is dark. */
function edgesInked(image: { width: number; height: number; data: Uint8ClampedArray }) {
  const at = (x: number, y: number) => image.data[(y * image.width + x) * 4];
  const { width: w, height: h } = image;
  for (let x = 1; x < w - 1; x++) if (at(x, 1) > 64 || at(x, h - 2) > 64) return false;
  for (let y = 1; y < h - 1; y++) if (at(1, y) > 64 || at(w - 2, y) > 64) return false;
  return true;
}

const proportional = (seen: { width: number; height: number }, width: number) =>
  Math.max(1, Math.round((seen.height * width) / seen.width));

describe('CNV-14 — pageToSizedImage at an exact size, on the decoded output', () => {
  async function withDoc<T>(run: (handle: string) => Promise<T>): Promise<T> {
    const { handle } = await renderWorkerImpl.loadDocument(await fixturePdf());
    try {
      return await run(handle);
    } finally {
      await renderWorkerImpl.closeDocument(handle);
    }
  }

  for (const format of ['png', 'jpeg'] as const) {
    it(`locked by width (${format}): the width is exact, the height each page's own, rotated`, async () => {
      await withDoc(async handle => {
        for (let i = 0; i < PAGES.length; i++) {
          const result = await renderWorkerImpl.pageToSizedImage(handle, i, format, 72, {
            targetBytes: null,
            maxDimension: 400,
            width: 1000,
            height: null
          });
          const decoded = await decodeToRgba(result.bytes);
          expect([decoded.width, decoded.height], `page ${i + 1}`).toEqual([
            1000,
            proportional(SEEN[i], 1000)
          ]);
          expect([result.width, result.height]).toEqual([decoded.width, decoded.height]);
        }
      });
    });

    it(`unlocked (${format}): every page is exactly W × H, drawn edge to edge`, async () => {
      await withDoc(async handle => {
        for (let i = 0; i < PAGES.length; i++) {
          const result = await renderWorkerImpl.pageToSizedImage(handle, i, format, 300, {
            targetBytes: null,
            maxDimension: null,
            width: 640,
            height: 480
          });
          const decoded = await decodeToRgba(result.bytes);
          expect([decoded.width, decoded.height], `page ${i + 1}`).toEqual([640, 480]);
          expect(edgesInked(decoded), `page ${i + 1} fills the image`).toBe(true);
        }
      });
    });
  }

  it('locked by height: the height is exact, the width follows', async () => {
    await withDoc(async handle => {
      for (let i = 0; i < PAGES.length; i++) {
        const result = await renderWorkerImpl.pageToSizedImage(handle, i, 'png', 150, {
          targetBytes: null,
          maxDimension: null,
          width: null,
          height: 777
        });
        const decoded = await decodeToRgba(result.bytes);
        expect(decoded.height).toBe(777);
        expect(decoded.width).toBe(Math.round((SEEN[i].width * 777) / SEEN[i].height));
      }
    });
  });

  it('with a size target, only quality moves: the pixels stay exact', async () => {
    await withDoc(async handle => {
      const result = await renderWorkerImpl.pageToSizedImage(handle, 0, 'jpeg', 72, {
        targetBytes: 8_000,
        maxDimension: null,
        width: 900,
        height: 900
      });
      const decoded = await decodeToRgba(result.bytes);
      expect([decoded.width, decoded.height]).toEqual([900, 900]);
      expect(result.reached).toBe(result.bytes.byteLength <= 8_000);
      expect(result.attempts).toBeGreaterThan(0);
    });
  });

  it('refuses an exact size past the render pixel cap, before allocating it', async () => {
    await withDoc(async handle => {
      await expect(
        renderWorkerImpl.pageToSizedImage(handle, 0, 'png', 72, {
          targetBytes: null,
          maxDimension: null,
          width: 16_000,
          height: 16_000
        })
      ).rejects.toThrow(/limit a browser can draw/);
    });
  });

  it('IMG-6 still holds without an exact size: longest side at most N', async () => {
    await withDoc(async handle => {
      const result = await renderWorkerImpl.pageToSizedImage(handle, 0, 'png', 300, {
        targetBytes: null,
        maxDimension: 400,
        width: null,
        height: null
      });
      const decoded = await decodeToRgba(result.bytes);
      expect(Math.max(decoded.width, decoded.height)).toBe(400);
    });
  });
});

describe('CNV-14 — PDF → Images state helpers', () => {
  const settings = (exact: Partial<typeof DEFAULT_EXACT_SIZE>, extra = {}) => ({
    ...pdfToImageSettings.value,
    sizeMode: 'resolution' as const,
    maxDimension: null,
    exact: { ...DEFAULT_EXACT_SIZE, on: true, ...exact },
    ...extra
  });

  it('exportedPageSizes uses each page as rendered: a Stapler quarter turn swaps sides', () => {
    const doc = {
      id: 'd',
      name: 'd.pdf',
      pages: [
        { key: 'a', sourceDocId: 's', sourceIndex: 0, rotation: 0 },
        { key: 'b', sourceDocId: 's', sourceIndex: 0, rotation: 90 },
        { key: 'c', sourceDocId: 's', sourceIndex: 1, rotation: 180 }
      ],
      baseline: [],
      annotations: [],
      dirty: false
    };
    const sources = {
      s: {
        id: 's',
        name: 's.pdf',
        pageCount: 2,
        pageSizes: [
          { width: 595, height: 842 },
          { width: 842, height: 595 }
        ]
      }
    };
    expect(state.exportedPageSizes(doc, sources, new Set())).toEqual([
      { pageIndex: 0, width: 595, height: 842 },
      { pageIndex: 1, width: 842, height: 595 },
      { pageIndex: 2, width: 842, height: 595 }
    ]);
    expect(state.exportedPageSizes(doc, sources, new Set(['b']))).toEqual([
      { pageIndex: 1, width: 842, height: 595 }
    ]);
  });

  it('locked: the other side is per page, and "varies" is said only when it does', () => {
    const pages = [
      { pageIndex: 0, width: 595, height: 842 },
      { pageIndex: 1, width: 842, height: 595 }
    ];
    const dims = state.pdfExactRequest(settings({ width: 1000, driver: 'width' }))!;
    const out = state.exactPageOutputs(pages, dims);
    expect(out).toEqual([
      { pageIndex: 0, width: 1000, height: 1415 },
      { pageIndex: 1, width: 1000, height: 707 }
    ]);
    expect(state.exactSizesVary(out)).toBe(true);
    expect(state.exactSizesVary(state.exactPageOutputs([pages[0], pages[0]], dims))).toBe(false);
    const unlocked = state.pdfExactRequest(
      settings({ width: 800, height: 600, lockAspect: false })
    )!;
    expect(state.exactSizesVary(state.exactPageOutputs(pages, unlocked))).toBe(false);
  });

  it('off, or nothing usable, sends no exact size', () => {
    expect(state.pdfExactRequest(settings({ on: false, width: 500 }))).toBeNull();
    expect(state.pdfExactRequest(settings({}))).toBeNull();
  });

  it('the pixel cap is checked on every page', () => {
    expect(state.exactSizeOverCap([{ pageIndex: 0, width: 8192, height: 8192 }])).toBeNull();
    expect(
      state.exactSizeOverCap([
        { pageIndex: 0, width: 100, height: 100 },
        { pageIndex: 3, width: 8193, height: 8192 }
      ])?.pageIndex
    ).toBe(3);
  });

  it('the archive name says the size', () => {
    expect(
      state.sizedArchiveSuffix(settings({ width: 1200, height: 800, lockAspect: false }))
    ).toBe('1200x800');
    expect(state.sizedArchiveSuffix(settings({ width: 1200, driver: 'width' }))).toBe(
      '1200px-wide'
    );
    expect(state.sizedArchiveSuffix(settings({ height: 900, driver: 'height' }))).toBe(
      '900px-high'
    );
    expect(
      state.sizedArchiveSuffix(
        settings(
          { width: 600, height: 600, lockAspect: false },
          { sizeMode: 'target', targetKb: 50 }
        )
      )
    ).toBe('600x600-50kb');
    expect(
      state.sizedArchiveSuffix(settings({ on: false }, { maxDimension: 1600, sizeMode: 'target' }))
    ).toBe(`max1600px-${pdfToImageSettings.value.targetKb}kb`);
  });
});

describe('CNV-14 — commitTool("pdf-to-img") with an exact size', () => {
  async function openFixture(id: string) {
    const bytes = await fixturePdf();
    __memoryFallback.set(id, bytes);
    store.registerSource({
      id,
      name: `${id}.pdf`,
      pageCount: PAGES.length,
      pageSizes: SEEN.map(size => ({ ...size }))
    });
    const pages = store.makePageRefs(id, PAGES.length);
    const doc = {
      id: `${id}-doc`,
      name: `${id}.pdf`,
      pages,
      baseline: pages,
      annotations: [],
      dirty: false
    };
    store.addDocument(doc);
    store.activeDocId.value = doc.id;
    return doc;
  }

  function setExact(exact: Partial<typeof DEFAULT_EXACT_SIZE>, extra = {}) {
    pdfToImageSettings.value = {
      format: 'png',
      dpi: 72,
      sizeMode: 'resolution',
      targetKb: 200,
      maxDimension: 400,
      exact: { ...DEFAULT_EXACT_SIZE, on: true, ...exact },
      ...extra
    };
  }

  async function savedImages() {
    expect(saved).toHaveLength(1);
    const files = unzipSync(saved[0].bytes);
    const out: Record<string, { width: number; height: number }> = {};
    for (const [name, bytes] of Object.entries(files)) {
      const { width, height } = await decodeToRgba(bytes);
      out[name] = { width, height };
    }
    return out;
  }

  beforeEach(() => {
    saved.length = 0;
    toasts.value = [];
    store.documents.value = [];
    store.sources.value = {};
    store.activeDocId.value = null;
    store.selectedPageKeys.value = new Set();
    resetHistory();
    vi.mocked(ops.currentDocumentBytes).mockClear();
    vi.mocked(ops.pagesToSizedImageArchive).mockClear();
    vi.mocked(ops.pagesToImageArchive).mockClear();
  });

  for (const [label, exact, title] of [
    ['no side', {}, 'Enter a width or a height.'],
    ['a zero width', { width: 0 }, 'Enter a whole number of pixels between 1 and 16384.'],
    [
      'a fractional height, unlocked',
      { width: 300, height: 20.5, lockAspect: false },
      'Enter a whole number of pixels between 1 and 16384.'
    ]
  ] as const) {
    it(`refuses ${label} before composing`, async () => {
      await openFixture(`r-${label}`);
      setExact(exact);
      await commitTool('pdf-to-img', {});
      expect(ops.currentDocumentBytes).not.toHaveBeenCalled();
      expect(ops.pagesToSizedImageArchive).not.toHaveBeenCalled();
      expect(saved).toEqual([]);
      expect(toasts.value.at(-1)?.title).toBe(title);
    });
  }

  it('refuses a size past the pixel cap before composing, naming the page', async () => {
    await openFixture('cap');
    setExact({ width: 9000, driver: 'width' });
    await commitTool('pdf-to-img', {});
    expect(ops.currentDocumentBytes).not.toHaveBeenCalled();
    expect(saved).toEqual([]);
    expect(toasts.value.at(-1)?.title).toMatch(/9000×12736 px is larger than the/);
    expect(toasts.value.at(-1)?.detail).toBe('Page 1');
  });

  it('unlocked: every image in the ZIP is exactly W × H, and the name says so', async () => {
    await openFixture('unlocked');
    setExact({ width: 320, height: 240, lockAspect: false });
    await commitTool('pdf-to-img', {});
    expect(vi.mocked(ops.pagesToSizedImageArchive).mock.calls[0][4]).toEqual({
      targetBytes: null,
      maxDimension: null,
      width: 320,
      height: 240
    });
    expect(saved[0].name).toBe('unlocked-320x240.zip');
    const images = await savedImages();
    expect(Object.keys(images)).toHaveLength(PAGES.length);
    for (const size of Object.values(images)) expect(size).toEqual({ width: 320, height: 240 });
  });

  it('locked, with a page turned in Stapler: each page is sized on the sides it is seen with', async () => {
    const doc = await openFixture('locked');
    store.rotatePages(doc.id, [doc.pages[0].key], 90);
    setExact({ width: 500, driver: 'width' }, { format: 'jpeg' });
    await commitTool('pdf-to-img', {});
    expect(saved[0].name).toBe('locked-500px-wide.zip');
    const images = await savedImages();
    // Page 1 was 595 × 842 and is now turned a quarter: 842 × 595 as seen.
    const seen = [{ width: 842, height: 595 }, ...SEEN.slice(1)];
    expect(Object.values(images)).toEqual(
      seen.map(size => ({ width: 500, height: proportional(size, 500) }))
    );
  });

  it('with a size target: JPEG at exactly the size, the target in the name', async () => {
    await openFixture('target');
    setExact({ width: 300, height: 300, lockAspect: false }, { sizeMode: 'target', targetKb: 30 });
    await commitTool('pdf-to-img', {});
    expect(saved[0].name).toBe('target-300x300-30kb.zip');
    const images = await savedImages();
    for (const [name, size] of Object.entries(images)) {
      expect(name).toMatch(/\.jpg$/);
      expect(size).toEqual({ width: 300, height: 300 });
    }
  });
});
