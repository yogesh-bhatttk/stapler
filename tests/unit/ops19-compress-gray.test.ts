/**
 * OPS-19 — grey / black and white as a compression lever, through the real
 * `commitTool('compress', …)` path.
 *
 * Planning, re-encoding and the grey conversion all run on the real process
 * and render worker implementations (pdf.js legacy build on a napi-rs canvas);
 * only the platform's save dialog and the confirm/review prompts are replaced
 * by recorders. Every assertion is on the bytes handed to `saveFileAs`.
 *
 *  - a colour scan with "Black and white" comes out smaller, 1-bit and grey;
 *  - a grey result that is not smaller than the original is discarded, the
 *    original kept, and the person told (AC: "a compress use never outputs a
 *    file larger than its input");
 *  - the option is off by default, and off means Compress is untouched.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDict, PDFDocument, PDFName, PDFRef, PDFStream } from 'pdf-lib';
import { canvasLib, decodeToRgba, installCanvasShims } from './helpers/node-canvas-shims';

const saved: { name: string; bytes: Uint8Array }[] = [];
const confirmations: { title: string; body: string }[] = [];

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
  // `any`: stands in for the pool's `Comlink.Remote<T>` wrapper (see
  // size-honesty-commit.test.ts, which this mirrors).
  // A real worker receives a structured-clone *copy* of each byte array, so the
  // caller's bytes survive pdf.js transferring (detaching) the buffer it was
  // given. Calling the impl in-process has to copy them the same way.
  const copying = (impl: any) =>
    new Proxy(impl, {
      get: (target, key) => {
        const value = target[key];
        return typeof value === 'function'
          ? (...args: unknown[]) =>
              value.apply(
                target,
                args.map(arg => (arg instanceof Uint8Array ? arg.slice() : arg))
              )
          : value;
      }
    });
  const client = (impl: any) => {
    const api = copying(impl);
    return {
      lease: (fn: (api: any) => unknown) => fn(api),
      pin: () => ({ lease: (fn: (api: any) => unknown) => fn(api), release: () => {} })
    };
  };
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
  return {
    ...actual,
    requestExportReview: async () => true,
    confirmAction: async (options: { title: string; body: string }) => {
      confirmations.push({ title: options.title, body: options.body });
      return true;
    }
  };
});
vi.mock('../../src/core/operations', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/core/operations')>();
  return {
    ...actual,
    compressDocument: vi.fn(actual.compressDocument),
    compressToTargetSize: vi.fn(actual.compressToTargetSize),
    grayscaleDocument: vi.fn(actual.grayscaleDocument)
  };
});

installCanvasShims();

const { commitTool } = await import('../../src/ui/tools/commit');
const store = await import('../../src/core/store');
const { resetHistory } = await import('../../src/core/history');
const { __memoryFallback } = await import('../../src/core/opfs');
const { toasts } = await import('../../src/core/notify');
const ops = await import('../../src/core/operations');
const { renderWorkerImpl } = await import('../../src/core/workers/render.worker');
const { compressColour, compressMode, compressSettings, compressTarget, lastCompressionResult } =
  await import('../../src/ui/tools/compress/state');

// Read before any test touches it: the shipped default.
const DEFAULT_COLOUR = compressColour.value;

/**
 * A colour scan of a text page: tinted, slightly noisy paper with dark-blue
 * "lines of text" and a red stamp, as one full-page JPEG with no text layer.
 */
async function colourScan(): Promise<Uint8Array> {
  const width = 1275; // letter at 150 DPI
  const height = 1650;
  const canvas = canvasLib.createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgb(250, 244, 222)';
  ctx.fillRect(0, 0, width, height);
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 6000; i++) {
    const shade = 225 + Math.floor(random() * 25);
    ctx.fillStyle = `rgb(${shade}, ${shade - 6}, ${shade - 30})`;
    ctx.fillRect(Math.floor(random() * width), Math.floor(random() * height), 3, 3);
  }
  ctx.fillStyle = 'rgb(20, 30, 90)';
  for (let y = 150; y < height - 150; y += 36) {
    for (let x = 120; x < width - 120;) {
      const word = 30 + Math.floor(random() * 90);
      ctx.fillRect(x, y, word, 14);
      x += word + 16;
    }
  }
  ctx.fillStyle = 'rgb(200, 30, 30)';
  ctx.fillRect(900, 80, 260, 50);
  const jpeg = new Uint8Array(canvas.toBuffer('image/jpeg', 0.92));

  const doc = await PDFDocument.create();
  const image = await doc.embedJpg(jpeg);
  const page = doc.addPage([612, 792]);
  page.drawImage(image, { x: 0, y: 0, width: 612, height: 792 });
  return doc.save();
}

/**
 * The colour scan, plus a second page that draws only a colour image in an
 * encoding pdf.js cannot decode here (`/JPXDecode` over bytes that are not a
 * JPEG 2000 codestream) — the case grey has to leave in colour and say so.
 */
async function scanWithJpxPage(): Promise<Uint8Array> {
  const doc = await PDFDocument.load(await colourScan());
  const image = doc.context.register(
    doc.context.stream(new Uint8Array(64).fill(0x5a), {
      Type: 'XObject',
      Subtype: 'Image',
      Width: 8,
      Height: 8,
      ColorSpace: 'DeviceRGB',
      BitsPerComponent: 8,
      Filter: 'JPXDecode'
    })
  );
  const page = doc.addPage([612, 792]);
  page.node.setXObject(PDFName.of('ImJ'), image);
  const content = doc.context.register(doc.context.stream('q 200 0 0 200 100 300 cm /ImJ Do Q'));
  page.node.set(PDFName.of('Contents'), content);
  return doc.save();
}

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

/** Largest |R−G|, |G−B| on the rendered first page, and how many levels of red it uses. */
async function pixels(bytes: Uint8Array): Promise<{ maxChroma: number; levels: number }> {
  const { handle } = await renderWorkerImpl.loadDocument(bytes.slice());
  try {
    const png = await renderWorkerImpl.pageToImageBytes(handle, 0, 'png', 50);
    const { data } = await decodeToRgba(png);
    let maxChroma = 0;
    const levels = new Set<number>();
    for (let p = 0; p < data.length; p += 4) {
      maxChroma = Math.max(
        maxChroma,
        Math.abs(data[p] - data[p + 1]),
        Math.abs(data[p + 1] - data[p + 2])
      );
      levels.add(data[p]);
    }
    return { maxChroma, levels: levels.size };
  } finally {
    await renderWorkerImpl.closeDocument(handle);
  }
}

function imagesOnFirstPage(doc: PDFDocument): PDFStream[] {
  const xobjects = doc.getPage(0).node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict);
  if (!xobjects) return [];
  return xobjects.entries().map(([, ref]) => doc.context.lookup(ref as PDFRef) as PDFStream);
}

beforeEach(() => {
  saved.length = 0;
  confirmations.length = 0;
  toasts.value = [];
  store.documents.value = [];
  store.sources.value = {};
  store.activeDocId.value = null;
  store.selectedPageKeys.value = new Set();
  compressMode.value = 'quality';
  compressTarget.value = { amount: 2, unit: 'MB' };
  compressSettings.value = { dpi: 150, quality: 0.75 };
  compressColour.value = 'keep';
  lastCompressionResult.value = null;
  resetHistory();
  vi.mocked(ops.compressDocument).mockClear();
  vi.mocked(ops.compressToTargetSize).mockClear();
  vi.mocked(ops.grayscaleDocument).mockClear();
});

describe('OPS-19 — black and white as a compression lever', () => {
  it('turns a colour scan into a smaller, verified 1-bit black-and-white file', async () => {
    const source = await colourScan();
    expect((await pixels(source)).maxChroma).toBeGreaterThan(50); // really a colour input
    await openPdf('scan', source);
    compressColour.value = 'bw';

    await commitTool('compress', {});

    expect(saved).toHaveLength(1);
    const out = saved[0].bytes;
    expect(saved[0].name).toBe('scan-compressed.pdf');
    expect(out.byteLength).toBeLessThan(source.byteLength);
    // Smaller than colour compression alone, too — the lever earned its place.
    const colourOnly = await vi.mocked(ops.compressDocument).mock.results[0].value;
    expect(out.byteLength).toBeLessThan(colourOnly.bytes.byteLength);

    const doc = await PDFDocument.load(out);
    const images = imagesOnFirstPage(doc);
    expect(images.length).toBeGreaterThan(0);
    for (const image of images) {
      expect(String(image.dict.lookup(PDFName.of('ColorSpace')))).toBe('/DeviceGray');
      expect(String(image.dict.lookup(PDFName.of('BitsPerComponent')))).toBe('1');
    }
    const rendered = await pixels(out);
    expect(rendered.maxChroma).toBeLessThanOrEqual(2);
    expect(rendered.levels).toBeGreaterThan(1); // the page is still there

    const success = toasts.value.find(t => t.tone === 'success' && /^Reduced by/.test(t.title));
    expect(success?.title).toMatch(/^Reduced by \d+%$/);
    expect(success?.detail).toMatch(/Converted to black and white\./);
    expect(lastCompressionResult.value?.compressedBytes).toBe(out.byteLength);
    expect(lastCompressionResult.value?.keptOriginal).toBe(false);
  }, 60_000);

  it('keeps the original, writes nothing and says so when the grey result is not smaller', async () => {
    const source = await colourScan();
    await openPdf('grow', source);
    compressColour.value = 'gray';
    vi.mocked(ops.grayscaleDocument).mockResolvedValueOnce({
      nothingToDo: false,
      pages: [
        { pageIndex: 0, route: 'vector', reasons: [], imagesConverted: 1, imagesLeftInColour: 0 }
      ],
      undecodable: [],
      colourLeft: [],
      originalBytes: source.byteLength,
      bytes: new Uint8Array(source.byteLength + 5_000)
    } as unknown as Awaited<ReturnType<typeof ops.grayscaleDocument>>);

    await commitTool('compress', {});

    // Neither helps: at these settings colour compression alone kept the original too.
    expect((await vi.mocked(ops.compressDocument).mock.results[0].value).keptOriginal).toBe(true);
    expect(ops.grayscaleDocument).toHaveBeenCalledTimes(1);
    expect(saved).toEqual([]);
    const warning = toasts.value.find(t => t.tone === 'warning');
    expect(warning?.title).toBe('Kept the original file.');
    expect(warning?.detail).toMatch(/→/);
    expect(warning?.detail).toMatch(/Converting to grey did not make this file smaller/);
    expect(lastCompressionResult.value?.keptOriginal).toBe(true);
    expect(lastCompressionResult.value?.compressedBytes).toBe(source.byteLength);
  }, 60_000);

  it('refuses to save a conversion its own re-read could not verify', async () => {
    const source = await colourScan();
    await openPdf('unverified', source);
    compressColour.value = 'bw';
    vi.mocked(ops.grayscaleDocument).mockResolvedValueOnce({
      nothingToDo: false,
      pages: [],
      undecodable: [],
      colourLeft: [0],
      originalBytes: source.byteLength,
      bytes: new Uint8Array(100)
    } as unknown as Awaited<ReturnType<typeof ops.grayscaleDocument>>);

    await commitTool('compress', {});

    expect((await vi.mocked(ops.compressDocument).mock.results[0].value).keptOriginal).toBe(true);
    expect(saved).toEqual([]);
    expect(toasts.value.find(t => t.tone === 'danger')?.title).toBe(
      'The conversion could not be verified — nothing was saved.'
    );
  }, 60_000);
});

describe('OPS-19 — pages grey could not convert are named, never claimed converted', () => {
  it('saves the conversion but lists the page whose JPX image stayed in colour', async () => {
    const source = await scanWithJpxPage();
    await openPdf('jpx', source);
    compressColour.value = 'bw';

    await commitTool('compress', {});

    const greyResult = await vi.mocked(ops.grayscaleDocument).mock.results[0].value;
    expect(greyResult.undecodable).toEqual([{ pageIndex: 1, count: 1 }]);
    // Saved, as the Grayscale tool saves it: page 1 really is black and white.
    expect(saved).toHaveLength(1);
    const out = await PDFDocument.load(saved[0].bytes);
    expect(out.getPageCount()).toBe(2);
    for (const image of imagesOnFirstPage(out)) {
      expect(String(image.dict.lookup(PDFName.of('BitsPerComponent')))).toBe('1');
    }
    // …and the JPX image on page 2 is still the colour original.
    const jpx = out
      .getPage(1)
      .node.Resources()
      ?.lookupMaybe(PDFName.of('XObject'), PDFDict)
      ?.lookup(PDFName.of('ImJ'), PDFStream);
    expect(String(jpx?.dict.lookup(PDFName.of('ColorSpace')))).toBe('/DeviceRGB');
    expect(String(jpx?.dict.lookup(PDFName.of('Filter')))).toBe('/JPXDecode');

    const success = toasts.value.find(t => t.tone === 'success' && /^Reduced by/.test(t.title));
    expect(success?.detail).not.toMatch(/Converted to black and white\./);
    expect(success?.detail).toMatch(/Converted to black and white, except pages 2\./);
    const gap = toasts.value.find(t => /^1 page was left in colour\.$/.test(t.title));
    expect(gap?.tone).toBe('warning');
    expect(gap?.detail).toMatch(/^Page 2: 1 image uses an encoding \(JPEG 2000 or JBIG2\)/);
  }, 60_000);

  it('names a page the converter could not convert, with its reason', async () => {
    const source = await scanWithJpxPage();
    await openPdf('failed', source);
    compressColour.value = 'bw';
    const actual = vi.mocked(ops.grayscaleDocument).getMockImplementation()!;
    // The real conversion, with page 2 reported as one the converter gave up on.
    vi.mocked(ops.grayscaleDocument).mockImplementationOnce(async (...args) => {
      const result = await actual(...args);
      return {
        ...result,
        undecodable: [],
        pages: result.pages.map(page =>
          page.pageIndex === 1
            ? { ...page, route: 'failed' as const, reasons: ['uses a construct it cannot convert'] }
            : page
        )
      };
    });

    await commitTool('compress', {});

    expect(saved).toHaveLength(1);
    const success = toasts.value.find(t => t.tone === 'success' && /^Reduced by/.test(t.title));
    expect(success?.detail).toMatch(/Converted to black and white, except pages 2\./);
    const gap = toasts.value.find(t => /^1 page was left in colour\.$/.test(t.title));
    expect(gap?.detail).toBe('Page 2: uses a construct it cannot convert.');
  }, 60_000);
});

describe('OPS-19 — when grey does not help, a good colour compression is still saved', () => {
  it('saves the colour-compressed file when grey is not smaller than the original', async () => {
    const source = await colourScan();
    await openPdf('fallback', source);
    compressColour.value = 'gray';
    compressSettings.value = { dpi: 72, quality: 0.5 }; // colour compression alone pays
    vi.mocked(ops.grayscaleDocument).mockResolvedValueOnce({
      nothingToDo: false,
      pages: [
        { pageIndex: 0, route: 'vector', reasons: [], imagesConverted: 1, imagesLeftInColour: 0 }
      ],
      undecodable: [],
      colourLeft: [],
      originalBytes: source.byteLength,
      bytes: new Uint8Array(source.byteLength + 5_000)
    } as unknown as Awaited<ReturnType<typeof ops.grayscaleDocument>>);

    await commitTool('compress', {});

    const colourOnly = await vi.mocked(ops.compressDocument).mock.results[0].value;
    expect(colourOnly.keptOriginal).toBe(false);
    expect(saved).toHaveLength(1);
    expect(saved[0].bytes).toEqual(colourOnly.bytes);
    expect(saved[0].bytes.byteLength).toBeLessThan(source.byteLength);
    expect((await pixels(saved[0].bytes)).maxChroma).toBeGreaterThan(50); // still colour
    const success = toasts.value.find(t => t.tone === 'success' && /^Reduced by/.test(t.title));
    expect(success?.detail).toMatch(/Compressed in colour; grey was not applied\./);
    expect(success?.detail).not.toMatch(/Converted/);
    const kept = toasts.value.find(t => t.title === 'Colour was kept.');
    expect(kept?.tone).toBe('warning');
    expect(kept?.detail).toMatch(/no smaller than the original, so the colour-compressed file/);
    expect(toasts.value.find(t => t.title === 'Kept the original file.')).toBeUndefined();
    expect(lastCompressionResult.value?.keptOriginal).toBe(false);
    expect(lastCompressionResult.value?.compressedBytes).toBe(colourOnly.bytes.byteLength);
  }, 60_000);

  it('saves the colour-compressed file when the grey result could not be verified', async () => {
    const source = await colourScan();
    await openPdf('fallback-unverified', source);
    compressColour.value = 'bw';
    compressSettings.value = { dpi: 72, quality: 0.5 };
    vi.mocked(ops.grayscaleDocument).mockResolvedValueOnce({
      nothingToDo: false,
      pages: [],
      undecodable: [],
      colourLeft: [0],
      originalBytes: source.byteLength,
      bytes: new Uint8Array(100)
    } as unknown as Awaited<ReturnType<typeof ops.grayscaleDocument>>);

    await commitTool('compress', {});

    const colourOnly = await vi.mocked(ops.compressDocument).mock.results[0].value;
    expect(colourOnly.keptOriginal).toBe(false);
    expect(saved).toHaveLength(1);
    expect(saved[0].bytes).toEqual(colourOnly.bytes);
    expect(toasts.value.find(t => t.tone === 'danger')).toBeUndefined();
    const kept = toasts.value.find(t => t.title === 'Colour was kept.');
    expect(kept?.detail).toMatch(/Colour was still found on pages 1 after converting/);
    const success = toasts.value.find(t => t.tone === 'success' && /^Reduced by/.test(t.title));
    expect(success?.detail).toMatch(/grey was not applied/);
  }, 60_000);
});

describe('OPS-19 — off by default, and off changes nothing', () => {
  it('ships with colour kept', () => {
    expect(DEFAULT_COLOUR).toBe('keep');
  });

  it('with the option off, saves exactly what colour compression produced and never converts', async () => {
    const source = await colourScan();
    await openPdf('off', source);
    // Low enough that colour compression alone pays on this scan, so there is
    // a file to compare.
    compressSettings.value = { dpi: 72, quality: 0.5 };

    await commitTool('compress', {});

    expect(ops.grayscaleDocument).not.toHaveBeenCalled();
    const colourOnly = await vi.mocked(ops.compressDocument).mock.results[0].value;
    expect(saved).toHaveLength(1);
    expect(saved[0].bytes).toEqual(colourOnly.bytes);
    expect((await pixels(saved[0].bytes)).maxChroma).toBeGreaterThan(50); // still colour
    const success = toasts.value.find(t => t.tone === 'success' && /^Reduced by/.test(t.title));
    expect(success?.detail).toMatch(/→/);
    expect(success?.detail).not.toMatch(/Converted|grey/);
  }, 60_000);

  it('is not applied when aiming for a size', async () => {
    const source = await colourScan();
    await openPdf('target', source);
    compressColour.value = 'bw';
    compressMode.value = 'target';
    compressTarget.value = {
      amount: Math.max(10, Math.round(source.byteLength / 2000)),
      unit: 'KB'
    };

    await commitTool('compress', {});

    expect(ops.compressToTargetSize).toHaveBeenCalledTimes(1);
    expect(ops.grayscaleDocument).not.toHaveBeenCalled();
  }, 60_000);
});
