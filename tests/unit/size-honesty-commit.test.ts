/**
 * Audit 2026-10-01 — the commit handlers' size honesty and Repair's input,
 * driven through the real `commitTool` with the platform's `saveFileAs`
 * replaced by a recorder:
 *
 *  - IMG-1: Image to size keeps an original that already fits rather than
 *    saving a bigger re-encode; a HEIC that must be converted is saved and the
 *    growth is said out loud.
 *  - IMG-2: an out-of-range target is refused, not replaced by another value.
 *  - IMG-5: Compress does not say "Reached" when Protect pushed the saved file
 *    over the target.
 *  - IMG-12: Compress refuses a target outside `PDF_TARGET_BOUNDS`.
 *  - OPS-19 / pattern 2: Grayscale never writes a larger file without asking.
 *  - UI-3: Repair of an edited document repairs the edits, not the raw file.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { PDFDocument, degrees } from 'pdf-lib';

const saved: { name: string; bytes: Uint8Array }[] = [];
let confirmAnswer = true;
const confirmations: { title: string; body: string }[] = [];

vi.mock('comlink', () => ({
  expose: vi.fn(),
  transfer: vi.fn(value => value),
  proxy: vi.fn(v => v)
}));
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
  // `any`: stands in for the pool's `Comlink.Remote<T>` wrapper (see
  // permission-restrictions.test.ts, which this mirrors).
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
    renderWorker: client(unavailable),
    cvWorker: client(unavailable),
    ocrWorker: client(unavailable),
    convertWorker: client(unavailable),
    imageWorker: client(unavailable)
  };
});
vi.mock('../../src/core/notify', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/core/notify')>();
  return {
    ...actual,
    requestExportReview: async () => true,
    confirmAction: async (options: { title: string; body: string }) => {
      confirmations.push({ title: options.title, body: options.body });
      return confirmAnswer;
    }
  };
});
vi.mock('../../src/core/operations', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/core/operations')>();
  return {
    ...actual,
    currentDocumentBytes: vi.fn(actual.currentDocumentBytes),
    composeDocument: vi.fn(actual.composeDocument),
    compressToTargetSize: vi.fn(actual.compressToTargetSize),
    protectDocument: vi.fn(actual.protectDocument),
    grayscaleDocument: vi.fn(actual.grayscaleDocument),
    pagesToSizedImageArchive: vi.fn(actual.pagesToSizedImageArchive),
    repairDocument: vi.fn()
  };
});
// AUDIT-2026-10-10 M3 — every PDF export now reads its input through the one
// canonical `exportDocumentBytes`, not `currentDocumentBytes`.
vi.mock('../../src/ui/tools/export-compose', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/ui/tools/export-compose')>();
  return { ...actual, exportDocumentBytes: vi.fn(actual.exportDocumentBytes) };
});
vi.mock('../../src/core/image', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/core/image')>();
  return { ...actual, resizeImageFile: vi.fn() };
});

const { commitTool } = await import('../../src/ui/tools/commit');
const store = await import('../../src/core/store');
const { resetHistory } = await import('../../src/core/history');
const { __memoryFallback } = await import('../../src/core/opfs');
const { toasts } = await import('../../src/core/notify');
const ops = await import('../../src/core/operations');
const { resizeImageFile } = await import('../../src/core/image');
const { imageSizeSettings, imageSizeResult } = await import('../../src/ui/tools/image-size/state');
const { compressMode, compressTarget } = await import('../../src/ui/tools/compress/state');
const { protection } = await import('../../src/ui/tools/protect/state');
const { grayscaleSettings } = await import('../../src/ui/tools/grayscale/state');
const { repairCandidate } = await import('../../src/ui/tools/repair/state');
const { pdfToImageSettings } = await import('../../src/ui/tools/state');
const { watermarkSettings } = await import('../../src/ui/tools/watermark/state');

const fixture = (name: string) => new Uint8Array(readFileSync(`tests/fixtures/${name}`));

async function openPdf(id: string, bytes: Uint8Array) {
  __memoryFallback.set(id, bytes);
  const pdf = await PDFDocument.load(bytes);
  const count = pdf.getPageCount();
  store.registerSource({
    id,
    name: `${id}.pdf`,
    pageCount: count,
    pageSizes: Array.from({ length: count }, () => ({ width: 612, height: 792 }))
  });
  const pages = store.makePageRefs(id, count);
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

function resized(bytes: Uint8Array, extra: Partial<Record<string, unknown>> = {}) {
  return {
    bytes,
    width: 100,
    height: 100,
    quality: 0.92,
    sourceWidth: 100,
    sourceHeight: 100,
    targetBytes: 5_000_000,
    reached: true,
    attempts: 1,
    sourcePages: 1,
    sourceFrames: 1,
    ...extra
  };
}

beforeEach(() => {
  saved.length = 0;
  confirmations.length = 0;
  confirmAnswer = true;
  toasts.value = [];
  store.documents.value = [];
  store.sources.value = {};
  store.activeDocId.value = null;
  store.selectedPageKeys.value = new Set();
  compressMode.value = 'quality';
  compressTarget.value = { amount: 2, unit: 'MB' };
  imageSizeResult.value = null;
  repairCandidate.value = null;
  resetHistory();
  vi.mocked(resizeImageFile).mockReset();
});

describe('IMG-1 — Image to size never saves a larger re-encode of an original that fits', () => {
  it('keeps a PNG that already fits when the JPEG came out bigger (the audit probe case)', async () => {
    const png = fixture('sample.png'); // 1,379 B; its JPEG was 2,077 B
    const { storedImageSize } = await import('../../src/core/raster-decode');
    const size = storedImageSize(png)!;
    const file = new File([png], 'sample.png', { type: 'image/png' });
    imageSizeSettings.value = {
      file,
      useTarget: true,
      target: { amount: 5, unit: 'MB' },
      maxDimension: null
    };
    vi.mocked(resizeImageFile).mockResolvedValueOnce(
      resized(new Uint8Array(2077), { sourceWidth: size.width, sourceHeight: size.height })
    );
    await commitTool('image-to-size', {});
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toBe('sample.png');
    expect(saved[0].bytes).toEqual(png);
    expect(imageSizeResult.value?.keptOriginal).toBe(true);
  });

  it('converts a HEIC even when the JPEG is bigger — and says so', async () => {
    const heic = fixture('sample.heic');
    const file = new File([heic], 'photo.heic', { type: 'image/heic' });
    imageSizeSettings.value = {
      file,
      useTarget: false,
      target: { amount: 50, unit: 'KB' },
      maxDimension: null
    };
    const jpeg = new Uint8Array(heic.byteLength + 1000);
    vi.mocked(resizeImageFile).mockResolvedValueOnce(resized(jpeg, { targetBytes: null }));
    await commitTool('image-to-size', {});
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toBe('photo-resizedpx.jpg');
    const toast = toasts.value.find(t => t.tone === 'success');
    expect(toast?.detail).toMatch(/larger than the original/);
  });

  it('IMG-2: refuses an out-of-range target instead of running another value', async () => {
    const file = new File([fixture('sample.png')], 'sample.png', { type: 'image/png' });
    imageSizeSettings.value = {
      file,
      useTarget: true,
      target: { amount: 4, unit: 'KB' },
      maxDimension: null
    };
    await commitTool('image-to-size', {});
    expect(resizeImageFile).not.toHaveBeenCalled();
    expect(saved).toEqual([]);
    expect(toasts.value.at(-1)?.title).toMatch(/Enter a size between 5 KB and 50 MB/);
  });

  it('IMG-3: "could not reach" never shows the miss as the target', async () => {
    const heic = fixture('sample.heic');
    const file = new File([heic], 'photo.heic', { type: 'image/heic' });
    imageSizeSettings.value = {
      file,
      useTarget: true,
      target: { amount: 200, unit: 'KB' },
      maxDimension: null
    };
    vi.mocked(resizeImageFile).mockResolvedValueOnce(
      resized(new Uint8Array(200_300), { targetBytes: 200_000, reached: false })
    );
    confirmAnswer = false;
    await commitTool('image-to-size', {});
    expect(confirmations[0].title).toBe('Could not reach 200 KB');
    expect(confirmations[0].body).toContain('201 KB');
    expect(saved).toEqual([]);
  });
});

describe('Compress — IMG-5 and IMG-12', () => {
  it('IMG-12: refuses a 50 B target', async () => {
    await openPdf('c1', fixture('text-2.pdf'));
    compressMode.value = 'target';
    compressTarget.value = { amount: 0.05, unit: 'KB' };
    await commitTool('compress', {});
    expect(ops.compressToTargetSize).not.toHaveBeenCalled();
    expect(saved).toEqual([]);
    expect(toasts.value.at(-1)?.title).toMatch(/Enter a size between 10 KB and 2 GB/);
  });

  it('IMG-5: no "Reached" when Protect pushed the saved file over the target', async () => {
    await openPdf('c2', fixture('text-2.pdf'));
    compressMode.value = 'target';
    compressTarget.value = { amount: 20, unit: 'KB' };
    protection.value = {
      ...protection.value,
      enabled: true,
      userPassword: 'pw',
      confirmPassword: 'pw'
    };
    const { exportDocumentBytes } = await import('../../src/ui/tools/export-compose');
    vi.mocked(exportDocumentBytes).mockResolvedValueOnce(new Uint8Array(50_000));
    const compressed = new Uint8Array(19_900);
    vi.mocked(ops.compressToTargetSize).mockResolvedValueOnce({
      bytes: compressed,
      achievedBytes: 19_900,
      originalBytes: 50_000,
      reachedTarget: true,
      keptOriginal: false,
      trials: [],
      settings: { dpi: 150, quality: 0.7 },
      plan: null,
      imageStats: undefined
    } as unknown as Awaited<ReturnType<typeof ops.compressToTargetSize>>);
    // AES adds a few hundred bytes; deterministic here.
    vi.mocked(ops.protectDocument).mockImplementationOnce(async bytes => {
      const out = new Uint8Array(bytes.byteLength + 400);
      out.set(bytes);
      return out;
    });
    await commitTool('compress', {});
    expect(saved).toHaveLength(1);
    expect(saved[0].bytes.byteLength).toBe(20_300);
    expect(toasts.value.some(t => t.tone === 'success' && /Reached/.test(t.title))).toBe(false);
    const warning = toasts.value.find(t => t.tone === 'warning');
    expect(warning?.title).toBe('Saved at 21 KB, over the 20 KB target.');
  });
});

describe('PDF to Images — the per-image target is never silently replaced', () => {
  for (const targetKb of [NaN, 4, 60_000]) {
    it(`refuses to run with ${targetKb} KB`, async () => {
      await openPdf(`p-${targetKb}`, fixture('text-2.pdf'));
      pdfToImageSettings.value = { ...pdfToImageSettings.value, sizeMode: 'target', targetKb };
      await commitTool('pdf-to-img', {});
      expect(ops.pagesToSizedImageArchive).not.toHaveBeenCalled();
      expect(saved).toEqual([]);
      expect(toasts.value.at(-1)?.title).toMatch(/Enter a size between 5 KB and 50 MB/);
    });
  }
});

describe('OPS-19 — Grayscale never writes a larger file silently', () => {
  async function runLarger(answer: boolean) {
    const source = fixture('text-2.pdf');
    await openPdf('g1', source);
    grayscaleSettings.value = { mode: 'bw', scope: 'all', rasterDpi: 150 };
    confirmAnswer = answer;
    vi.mocked(ops.grayscaleDocument).mockResolvedValueOnce({
      nothingToDo: false,
      pages: [],
      undecodable: [],
      colourLeft: [],
      originalBytes: source.byteLength,
      bytes: new Uint8Array(source.byteLength + 5_000)
    } as unknown as Awaited<ReturnType<typeof ops.grayscaleDocument>>);
    await commitTool('grayscale', {});
    return source;
  }

  it('says the file grew, with sizes that never read as equal, and leaves the choice to the export review', async () => {
    const source = await runLarger(true);
    expect(confirmations).toEqual([]);
    const warning = toasts.value.find(t => t.tone === 'warning');
    expect(warning?.title).toBe('The converted file is larger than the original.');
    expect(warning?.detail).toMatch(/→/);
    expect(saved).toHaveLength(1);
    expect(saved[0].bytes.byteLength).toBe(source.byteLength + 5_000);
  });

  it('warns when password protection alone pushes the saved file past the original', async () => {
    const source = fixture('text-2.pdf');
    await openPdf('g3', source);
    protection.value = {
      ...protection.value,
      enabled: true,
      userPassword: 'pw',
      confirmPassword: 'pw'
    };
    vi.mocked(ops.grayscaleDocument).mockResolvedValueOnce({
      nothingToDo: false,
      pages: [],
      undecodable: [],
      colourLeft: [],
      originalBytes: source.byteLength,
      bytes: new Uint8Array(source.byteLength - 100)
    } as unknown as Awaited<ReturnType<typeof ops.grayscaleDocument>>);
    vi.mocked(ops.protectDocument).mockImplementationOnce(async bytes => {
      const out = new Uint8Array(bytes.byteLength + 400);
      out.set(bytes);
      return out;
    });
    await commitTool('grayscale', {});
    expect(saved).toHaveLength(1);
    expect(saved[0].bytes.byteLength).toBe(source.byteLength + 300);
    const warning = toasts.value.find(t => t.tone === 'warning');
    expect(warning?.title).toBe('The converted file is larger than the original.');
    expect(warning?.detail).toMatch(/password protection/);
  });

  it('does not ask when the result is smaller', async () => {
    const source = fixture('text-2.pdf');
    await openPdf('g2', source);
    vi.mocked(ops.grayscaleDocument).mockResolvedValueOnce({
      nothingToDo: false,
      pages: [],
      undecodable: [],
      colourLeft: [],
      originalBytes: source.byteLength,
      bytes: new Uint8Array(source.byteLength - 100)
    } as unknown as Awaited<ReturnType<typeof ops.grayscaleDocument>>);
    await commitTool('grayscale', {});
    expect(confirmations).toEqual([]);
    expect(saved).toHaveLength(1);
  });
});

describe('UI-3 — Repair repairs the open document, edits included', () => {
  function captureRepairInput() {
    const inputs: Uint8Array[] = [];
    vi.mocked(ops.repairDocument).mockImplementation(async bytes => {
      inputs.push(bytes);
      return { changed: false, bytes, pageCount: 1 } as unknown as Awaited<
        ReturnType<typeof ops.repairDocument>
      >;
    });
    return inputs;
  }

  it('an unmodified document is repaired from its own file, byte for byte', async () => {
    const source = fixture('text-2.pdf');
    await openPdf('r1', source);
    const inputs = captureRepairInput();
    await commitTool('repair', {});
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toEqual(source);
  });

  it('an untouched document is repaired from its raw file even with Watermark panel text set', async () => {
    const source = fixture('text-2.pdf');
    await openPdf('r4', source);
    const before = watermarkSettings.value;
    watermarkSettings.value = { ...before, text: 'DRAFT' };
    try {
      const inputs = captureRepairInput();
      await commitTool('repair', {});
      expect(inputs).toHaveLength(1);
      expect(inputs[0]).toEqual(source);
      expect(ops.composeDocument).not.toHaveBeenCalled();
    } finally {
      watermarkSettings.value = before;
    }
  });

  it('an edited document is composed without the Watermark panel text', async () => {
    const source = fixture('text-2.pdf');
    const doc = await openPdf('r5', source);
    store.rotatePages(doc.id, [doc.pages[0].key], 90);
    const before = watermarkSettings.value;
    watermarkSettings.value = { ...before, text: 'DRAFT' };
    try {
      captureRepairInput();
      await commitTool('repair', {});
      const request = vi.mocked(ops.composeDocument).mock.calls.at(-1)?.[0];
      expect(request?.watermark).toBeUndefined();
      expect(request?.headerFooter).toBeUndefined();
      expect(request?.nup).toBeUndefined();
    } finally {
      watermarkSettings.value = before;
    }
  });

  it('a rotation and a deletion are in what gets repaired', async () => {
    const source = fixture('text-2.pdf');
    const doc = await openPdf('r2', source);
    store.rotatePages(doc.id, [doc.pages[0].key], 90);
    store.deletePages(doc.id, [doc.pages[1].key]);
    const inputs = captureRepairInput();
    await commitTool('repair', {});
    expect(inputs).toHaveLength(1);
    const repaired = await PDFDocument.load(inputs[0]);
    expect(repaired.getPageCount()).toBe(1);
    expect(repaired.getPage(0).getRotation()).toEqual(degrees(90));
  });

  it('falls back to the raw file only when the edits cannot be written, and says so', async () => {
    const source = fixture('text-2.pdf');
    const doc = await openPdf('r3', source);
    store.rotatePages(doc.id, [doc.pages[0].key], 90);
    vi.mocked(ops.composeDocument).mockRejectedValueOnce(new Error('damaged xref'));
    const inputs = captureRepairInput();
    await commitTool('repair', {});
    expect(inputs[0]).toEqual(source);
    expect(toasts.value.some(t => t.title === 'Your edits could not be included.')).toBe(true);
  });
});
