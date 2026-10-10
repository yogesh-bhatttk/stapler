/**
 * Audit 2026-10-10 T3 — `core/operations.ts` exports that had no test of their own.
 *
 * Every one of these is the main-thread wrapper the UI actually calls: it
 * leases a worker, threads a job handle through, and opens/closes a pdf.js
 * handle. The worker pools are replaced by the real worker implementations
 * called in-process (Comlink's transfer/proxy are the identity), so what is
 * graded is the real operation on real bytes, re-parsed afterwards — not a
 * mocked return value.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PDFDocument,
  PDFName,
  StandardFonts,
  concatTransformationMatrix,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
  rgb
} from 'pdf-lib';
import { unzipSync } from 'fflate';
import { canvasLib, installCanvasShims } from './helpers/node-canvas-shims';

vi.setConfig({ testTimeout: 60_000 });

/**
 * Every `Comlink.expose(api)` call, so the cv worker's implementation — which
 * the module does not export — can be driven in-process too.
 */
const exposed: unknown[] = [];
vi.mock('comlink', () => ({
  expose: vi.fn((api: unknown) => exposed.push(api)),
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
vi.mock('../../src/core/workers', async () => {
  const { processWorkerImpl } = await import('../../src/core/workers/process.worker');
  const { renderWorkerImpl } = await import('../../src/core/workers/render.worker');
  await import('../../src/core/workers/cv.worker');
  // `any`: stands in for the pool's `Comlink.Remote<T>` wrapper.
  const client = (impl: () => any) => ({
    lease: (fn: (api: any) => unknown) => fn(impl()),
    pin: () => ({ lease: (fn: (api: any) => unknown) => fn(impl()), release: () => {} })
  });
  const cv = () =>
    exposed.find(api => typeof (api as { trimBox?: unknown }).trimBox === 'function');
  const unavailable = new Proxy(
    {},
    {
      get: () => () => {
        throw new Error('This test does not run that worker');
      }
    }
  );
  return {
    processWorker: client(() => processWorkerImpl),
    // Comlink structured-clones a call's arguments unless the caller transfers
    // them, and these wrappers do not; pdf.js in-process would otherwise detach
    // the caller's buffer, which the real worker boundary never does.
    renderWorker: client(() => ({
      ...renderWorkerImpl,
      loadDocument: (bytes: Uint8Array, ...rest: unknown[]) =>
        // `any`: forwards the impl's own parameter list unchanged.
        (renderWorkerImpl.loadDocument as any)(bytes.slice(), ...rest)
    })),
    cvWorker: client(() => cv()),
    ocrWorker: client(() => unavailable),
    convertWorker: client(() => unavailable),
    imageWorker: client(() => unavailable)
  };
});

installCanvasShims();

/**
 * `renderPage` hands its result over with `transferToImageBitmap`, which the
 * shared shim's canvas does not have. The Skia canvas itself stands in for the
 * bitmap: it is a valid `drawImage` source for a Skia 2D context.
 */
{
  const Base = (globalThis as unknown as { OffscreenCanvas: new (w: number, h: number) => any })
    .OffscreenCanvas;
  if (!('transferToImageBitmap' in Base.prototype)) {
    class WithBitmap extends Base {
      transferToImageBitmap() {
        // `any`: a Skia canvas posing as an ImageBitmap.
        const skia: any = canvasLib.createCanvas(this.width, this.height);
        skia.getContext('2d').drawImage((this as any).canvas, 0, 0);
        skia.close = () => undefined;
        return skia;
      }
    }
    (globalThis as unknown as { OffscreenCanvas: unknown }).OffscreenCanvas = WithBitmap;
  }
}

/** `autoTrimDocument` draws into a DOM canvas on the main thread. */
(globalThis as unknown as { document: unknown }).document ??= {
  createElement: (tag: string) => {
    if (tag !== 'canvas') throw new Error(`unexpected element ${tag}`);
    return canvasLib.createCanvas(1, 1);
  }
};

const ops = await import('../../src/core/operations');
const store = await import('../../src/core/store');
const { resetHistory } = await import('../../src/core/history');
const { __memoryFallback } = await import('../../src/core/opfs');
const { cropBoxes } = await import('../../src/ui/tools/crop/state');
const fixtures = await import('../e2e/fixtures');

const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

/** Every page's text through pdf.js, in page order. */
async function pageTexts(bytes: Uint8Array): Promise<string[]> {
  const pdf = await pdfjs.getDocument({ data: bytes.slice(), disableFontFace: true, verbosity: 0 })
    .promise;
  const out: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const content = await (await pdf.getPage(i)).getTextContent();
    out.push(content.items.map(item => ('str' in item ? item.str : '')).join(' '));
  }
  await pdf.cleanup();
  return out;
}

function seed(sourceId: string, pageCount: number, bytes: Uint8Array, size = [595.28, 841.89]) {
  __memoryFallback.set(sourceId, bytes);
  store.registerSource({
    id: sourceId,
    name: `${sourceId}.pdf`,
    pageCount,
    pageSizes: Array.from({ length: pageCount }, () => ({ width: size[0], height: size[1] }))
  } as Parameters<typeof store.registerSource>[0]);
  const pages = store.makePageRefs(sourceId, pageCount);
  store.addDocument({
    id: `${sourceId}-doc`,
    name: `${sourceId}.pdf`,
    pages,
    annotations: [],
    dirty: false
  });
  return store.documents.value.find(d => d.id === `${sourceId}-doc`)!;
}

beforeEach(() => {
  store.documents.value = [];
  store.sources.value = {};
  store.activeDocId.value = null;
  store.activePageIndex.value = 0;
  store.selectedPageKeys.value = new Set();
  cropBoxes.value = {};
  resetHistory();
});

describe('splitDocument', () => {
  it('writes one file per slice, every page exactly once and in order', async () => {
    const doc = seed('split-src', 5, await fixtures.textPdf(5));
    const progress: number[] = [];
    const result = await ops.splitDocument(
      { pages: doc.pages, annotations: [], boundaries: [2, 3], baseName: 'report' },
      { onProgress: fraction => progress.push(fraction ?? -1) }
    );
    expect(result.isZip).toBe(true);
    const files = unzipSync(result.bytes);
    expect(Object.keys(files).sort()).toEqual(['report-01.pdf', 'report-02.pdf', 'report-03.pdf']);
    const texts = await Promise.all(
      Object.keys(files)
        .sort()
        .map(name => pageTexts(files[name]))
    );
    expect(texts.map(t => t.length)).toEqual([2, 1, 2]);
    expect(texts.flat().map(t => /fixture page (\d+)/.exec(t)?.[1])).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5'
    ]);
    expect(progress.length).toBeGreaterThan(0);
  });

  it('refuses an empty page list instead of writing an empty file', async () => {
    await expect(
      ops.splitDocument({ pages: [], annotations: [], boundaries: [], baseName: 'x' })
    ).rejects.toThrow(/no pages/i);
  });
});

describe('readDocumentOutline', () => {
  it('reads the real /Outlines tree with each entry resolved to its page', async () => {
    const outline = await ops.readDocumentOutline(await fixtures.bookmarkedPdf());
    expect(outline.map(node => [node.title, node.pageIndex])).toEqual(
      fixtures.BOOKMARK_CHAPTERS.map(chapter => [chapter.title, chapter.page])
    );
  });

  it('returns an empty outline for a document without one', async () => {
    expect(await ops.readDocumentOutline(await fixtures.textPdf(2))).toEqual([]);
  });
});

describe('scrubDocumentMetadata', () => {
  it('removes the author and every copy of the leaked Windows path from the bytes', async () => {
    const input = await fixtures.metadataLeakPdf();
    const latin1 = (bytes: Uint8Array) => Buffer.from(bytes).toString('latin1');
    const hex = (text: string) => Buffer.from(text, 'utf16le').swap16().toString('hex');
    // Precondition: the fixture really carries them.
    expect((await PDFDocument.load(input)).getAuthor()).toBe(fixtures.METADATA_LEAK.author);
    expect(latin1(input)).toContain(fixtures.METADATA_LEAK.xmpPath);

    const output = await ops.scrubDocumentMetadata(input, {
      title: true,
      author: true,
      creator: true,
      producer: true,
      customInfo: true,
      hasXmp: true,
      hasEmbeddedJavaScript: true
    });
    const out = await PDFDocument.load(output, { updateMetadata: false });
    expect(out.getAuthor()).toBeUndefined();
    expect(out.getTitle()).toBeUndefined();
    expect(out.catalog.get(PDFName.of('Metadata'))).toBeUndefined();
    const text = latin1(output);
    const upper = text.toUpperCase();
    for (const leak of [
      fixtures.METADATA_LEAK.author,
      fixtures.METADATA_LEAK.xmpPath,
      fixtures.METADATA_LEAK.sourcePath,
      fixtures.METADATA_LEAK.producerPath
    ]) {
      expect(text).not.toContain(leak);
      expect(upper).not.toContain(hex(leak).toUpperCase());
    }
    // The page itself is untouched.
    expect((await pageTexts(output))[0]).toContain('Quarterly board pack');
  });
});

describe('scanForPatterns', () => {
  it('proposes an email, a phone number and an SSN where they are printed, nothing else', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([612, 792]);
    page.drawText('Contact: jane.doe@example.com', { x: 72, y: 700, size: 12, font });
    page.drawText('Phone: (415) 555-0134', { x: 72, y: 670, size: 12, font });
    page.drawText('SSN 123-45-6789', { x: 72, y: 640, size: 12, font });
    page.drawText('Nothing sensitive on this line.', { x: 72, y: 610, size: 12, font });

    const found = await ops.scanForPatterns(await doc.save());
    const byCategory = Object.fromEntries(found.map(s => [s.category, s]));
    expect(byCategory.email?.text).toBe('jane.doe@example.com');
    expect(byCategory.phone?.text).toMatch(/555-0134/);
    expect(byCategory.ssn?.text).toBe('123-45-6789');
    // Each suggestion is a box on the page, top-left origin: the email is above the SSN.
    const top = (s: (typeof found)[number]) => s.regions[0].y;
    expect(top(byCategory.email)).toBeLessThan(top(byCategory.ssn));
    for (const suggestion of found) {
      expect(suggestion.pageIndex).toBe(0);
      for (const region of suggestion.regions) {
        expect(region.x).toBeGreaterThan(0);
        expect(region.x + region.width).toBeLessThanOrEqual(1);
      }
    }
    expect(found.some(s => s.text.includes('Nothing sensitive'))).toBe(false);
  });
});

describe('extractPageTextItems and proposeOutlineFromHeadings', () => {
  async function headedPdf(): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const chapters = ['Introduction', 'Method', 'Results'];
    for (const [i, title] of chapters.entries()) {
      const page = doc.addPage([595.28, 841.89]);
      page.drawText(title, { x: 56, y: 770, size: 26, font: bold });
      for (let line = 0; line < 20; line++) {
        page.drawText(`Body text line ${line + 1} of chapter ${i + 1}.`, {
          x: 56,
          y: 720 - line * 18,
          size: 11,
          font
        });
      }
    }
    return doc.save();
  }

  it('returns each run with its text and a top-left-origin position', async () => {
    const items = await ops.extractPageTextItems(await fixtures.textPdf(2), 1);
    const heading = items.find(item => item.text === 'Stapler fixture page 2');
    expect(heading).toBeDefined();
    // Drawn at x=56, baseline y=780 on an 841.89pt page → 61.89pt from the top.
    expect(heading!.x).toBeCloseTo(56, 0);
    expect(heading!.y).toBeCloseTo(841.89 - 780, 0);
    expect(heading!.height).toBeCloseTo(18, 0);
    const first = items.find(item => item.text.startsWith('Line 1 '));
    expect(first!.y).toBeGreaterThan(heading!.y);
  });

  it('proposes one entry per large heading, on its own page, reporting progress', async () => {
    const progress: number[] = [];
    const candidates = await ops.proposeOutlineFromHeadings(await headedPdf(), 3, {
      onProgress: fraction => progress.push(fraction ?? -1)
    });
    expect(candidates.map(c => [c.title, c.pageIndex])).toEqual([
      ['Introduction', 0],
      ['Method', 1],
      ['Results', 2]
    ]);
    expect(progress).toEqual([0, 1 / 3, 2 / 3]);
  });

  it('is cancellable before it reads a page', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      ops.proposeOutlineFromHeadings(await headedPdf(), 3, { signal: controller.signal })
    ).rejects.toThrow();
  });
});

describe('detectSignatureLines', () => {
  it('finds a captioned underscore line and nothing on an ordinary page', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const form = doc.addPage([612, 792]);
    form.drawText('Signature: ____________________', { x: 72, y: 200, size: 12, font });
    const plain = doc.addPage([612, 792]);
    plain.drawText('An ordinary paragraph with no place to sign.', {
      x: 72,
      y: 700,
      size: 12,
      font
    });

    const regions = await ops.detectSignatureLines(await doc.save());
    expect(regions.length).toBeGreaterThanOrEqual(1);
    expect(regions.every(region => region.pageIndex === 0)).toBe(true);
    const region = regions[0];
    // Baseline at y=200 of 792 → 0.747 from the top; the box sits just above it.
    expect(region.y).toBeLessThan((792 - 200) / 792);
    expect(region.y + region.height).toBeCloseTo((792 - 200) / 792, 1);
    expect(region.text).toMatch(/Signature/);
  });
});

describe('extractEmbeddedImages and findImagesForAltText', () => {
  /** Two pages, one shared 40×30 RGB image on both, plus a page with none. */
  async function imagePdf(): Promise<{ bytes: Uint8Array; samples: Uint8Array }> {
    const doc = await PDFDocument.create();
    const samples = new Uint8Array(40 * 30 * 3);
    for (let i = 0; i < samples.length; i++) samples[i] = (i * 7) % 256;
    const ref = doc.context.register(
      doc.context.flateStream(samples, {
        Type: 'XObject',
        Subtype: 'Image',
        Width: 40,
        Height: 30,
        ColorSpace: 'DeviceRGB',
        BitsPerComponent: 8
      })
    );
    for (let p = 0; p < 2; p++) {
      const page = doc.addPage([300, 300]);
      page.node.setXObject(PDFName.of('Im0'), ref);
      page.pushOperators(
        pushGraphicsState(),
        concatTransformationMatrix(200, 0, 0, 150, 50, 50),
        drawObject('Im0'),
        popGraphicsState()
      );
    }
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([300, 300]).drawText('No images here', { x: 20, y: 200, size: 12, font });
    return { bytes: await doc.save(), samples };
  }

  it('writes the shared image once, as a PNG of the exact source samples', async () => {
    const { bytes, samples } = await imagePdf();
    const result = await ops.extractEmbeddedImages(bytes, []);
    const extracted = result.entries.filter(e => e.status === 'extracted');
    const duplicates = result.entries.filter(e => e.status === 'duplicate');
    expect(extracted).toHaveLength(1);
    expect(duplicates).toHaveLength(1);
    expect(extracted[0]).toMatchObject({ pageIndex: 0, width: 40, height: 30 });

    const files = unzipSync(result.bytes);
    const png = files[extracted[0].fileName!];
    expect(png).toBeDefined();
    expect(Array.from(png.slice(1, 4))).toEqual([0x50, 0x4e, 0x47]); // "PNG"
    const image = await canvasLib.loadImage(Buffer.from(png));
    const ctx = canvasLib.createCanvas(40, 30).getContext('2d');
    ctx.drawImage(image, 0, 0);
    const { data } = ctx.getImageData(0, 0, 40, 30);
    for (const pixel of [0, 17, 599, 1199]) {
      expect([data[pixel * 4], data[pixel * 4 + 1], data[pixel * 4 + 2]]).toEqual([
        samples[pixel * 3],
        samples[pixel * 3 + 1],
        samples[pixel * 3 + 2]
      ]);
    }
  });

  it('honours the page selection', async () => {
    const { bytes } = await imagePdf();
    const result = await ops.extractEmbeddedImages(bytes, [2]);
    expect(result.entries.filter(e => e.status === 'extracted')).toHaveLength(0);
  });

  it('lists each distinct image once for the alt-text editor, with its own bytes', async () => {
    const { bytes } = await imagePdf();
    const images = await ops.findImagesForAltText(bytes);
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ pageIndex: 0, width: 40, height: 30, name: 'Im0' });
    expect(images[0].bytes.length).toBeGreaterThan(0);
  });
});

describe('autoTrimDocument', () => {
  it('sets a crop box that hugs the ink, as one undoable change', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 400]);
    // Ink only in the middle: x 100–300, y 150–250 (PDF space, y up).
    page.drawRectangle({ x: 100, y: 150, width: 200, height: 100, color: rgb(0, 0, 0) });
    const seeded = seed('trim-src', 1, await doc.save(), [400, 400]);

    await ops.autoTrimDocument(seeded, 'all');
    const box = cropBoxes.value[seeded.pages[0].key];
    expect(box).toBeDefined();
    // 1% padding each side; a 72 DPI render rounds to the pixel.
    expect(box.x).toBeCloseTo(0.25 - 0.01, 1);
    expect(box.y).toBeCloseTo(0.375 - 0.01, 1);
    expect(box.width).toBeCloseTo(0.5 + 0.02, 1);
    expect(box.height).toBeCloseTo(0.25 + 0.02, 1);
    expect(box.x).toBeGreaterThan(0.2);
    expect(box.x + box.width).toBeLessThan(0.8);

    const { undo } = await import('../../src/core/history');
    undo();
    expect(cropBoxes.value[seeded.pages[0].key]).toBeUndefined();
  });

  it('sets nothing when cancelled', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]).drawRectangle({ x: 50, y: 50, width: 50, height: 50 });
    const seeded = seed('trim-cancel', 1, await doc.save(), [200, 200]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      ops.autoTrimDocument(seeded, 'all', { signal: controller.signal })
    ).rejects.toThrow();
    expect(cropBoxes.value).toEqual({});
  });
});
