/**
 * Audit 2026-10-10 — CMP-01 routing on images the old classifier mis-read.
 *
 * Two defects, both found by the NFR-03 100 MB perf fixture (20 pages, each a
 * 1300×1300 *uncompressed* DeviceRGB image drawn 480 pt square on A4 under a
 * line of text), which `planCompression` reported as `already-optimized` —
 * "images already at the target resolution" — with zero actionable bytes:
 *
 *  1. Over-sampling was judged against the *page*, as if every image filled it.
 *     The image is 195 DPI as drawn; the page-span reading made it ~140, under
 *     the 150 × 1.15 threshold. The inventory now measures each image's
 *     placement from the content stream's CTM and the planner uses that.
 *  2. An image with no `/Filter` was never acted on unless over-sampled. Raw
 *     samples are now Flate-compressed in place, losslessly, when they are not
 *     over-sampled — and only when that measurably shrinks them.
 *
 * Everything here runs the real process and render workers in-process (pdf.js
 * plus Skia standing in for OffscreenCanvas) and asserts on the produced bytes,
 * re-parsed.
 */
import { describe, expect, it, vi } from 'vitest';
import { unzlibSync } from 'fflate';
import {
  PDFArray,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  StandardFonts,
  concatTransformationMatrix,
  decodePDFRawStream,
  drawObject,
  popGraphicsState,
  pushGraphicsState
} from 'pdf-lib';
import { canvasLib, decodeToRgba, installCanvasShims } from './helpers/node-canvas-shims';
import type { ImageFacts, PageImageInventory } from '../../src/core/workers/process.worker';

vi.setConfig({ testTimeout: 240_000 });

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
vi.mock('../../src/core/workers', async () => {
  const { processWorkerImpl } = await import('../../src/core/workers/process.worker');
  const { renderWorkerImpl } = await import('../../src/core/workers/render.worker');
  // `any`: stands in for the pool's `Comlink.Remote<T>` wrapper.
  const client = (impl: any) => ({
    lease: (fn: (api: any) => unknown) => fn(impl),
    pin: () => ({ lease: (fn: (api: any) => unknown) => fn(impl), release: () => {} })
  });
  // Comlink structured-clones arguments the caller does not transfer.
  // `any`: forwards each method's own parameter list unchanged.
  const cloning = (impl: any) =>
    new Proxy(impl, {
      get: (target, key) => {
        const value = target[key];
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) =>
          value.apply(
            target,
            args.map(arg => (arg instanceof Uint8Array ? arg.slice() : arg))
          );
      }
    });
  return {
    processWorker: client(cloning(processWorkerImpl)),
    renderWorker: client(cloning(renderWorkerImpl))
  };
});

installCanvasShims();
const ops = await import('../../src/core/operations');
const { processWorkerImpl } = await import('../../src/core/workers/process.worker');
const { classifyPages, effectiveDpi, estimateSavings } =
  await import('../../src/core/compress-plan');
const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');

const A4: [number, number] = [595.28, 841.89];
const SETTINGS = { dpi: 150, quality: 0.75 };

type Kind = 'noise' | 'smooth' | 'lineart';

/** Raw RGB samples. `lineart` is a white field with a black grid, like a diagram. */
function rgbSamples(kind: Kind, width: number, height = width): Uint8Array {
  const px = new Uint8Array(width * height * 3);
  let seed = 20261010;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 3;
      for (let c = 0; c < 3; c++) {
        if (kind === 'noise') {
          seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
          px[at + c] = (seed >> 16) & 0xff;
        } else if (kind === 'smooth') {
          px[at + c] = Math.floor((x * 255) / width);
        } else {
          px[at + c] = x % 25 === 0 || y % 25 === 0 ? 0 : 255;
        }
      }
    }
  }
  return px;
}

interface Placed {
  /** The image XObject's stream, already registered. */
  ref: PDFRef;
  /** `cm` operands: drawn width, height, and origin. */
  w: number;
  h: number;
  x: number;
  y: number;
}

/** One page carrying `images`, plus a line of real text unless `text` is false. */
async function pageDoc(
  build: (d: PDFDocument) => Placed[],
  options: { text?: boolean; size?: [number, number]; pages?: number } = {}
): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  const placed = build(d);
  for (let p = 0; p < (options.pages ?? 1); p++) {
    const page = d.addPage(options.size ?? A4);
    placed.forEach((img, i) => {
      page.node.setXObject(PDFName.of(`Im${i}`), img.ref);
      page.pushOperators(
        pushGraphicsState(),
        concatTransformationMatrix(img.w, 0, 0, img.h, img.x, img.y),
        drawObject(`Im${i}`),
        popGraphicsState()
      );
    });
    if (options.text !== false) {
      page.drawText(`Large fixture page ${p + 1}`, { x: 56, y: 780, size: 18, font });
    }
  }
  return d.save({ useObjectStreams: false });
}

function rawImage(d: PDFDocument, kind: Kind, side: number): PDFRef {
  return d.context.register(
    d.context.stream(rgbSamples(kind, side), {
      Type: 'XObject',
      Subtype: 'Image',
      Width: side,
      Height: side,
      ColorSpace: 'DeviceRGB',
      BitsPerComponent: 8
    })
  );
}

function flateImage(d: PDFDocument, kind: Kind, side: number): PDFRef {
  return d.context.register(
    d.context.flateStream(rgbSamples(kind, side), {
      Type: 'XObject',
      Subtype: 'Image',
      Width: side,
      Height: side,
      ColorSpace: 'DeviceRGB',
      BitsPerComponent: 8
    })
  );
}

/** The single image XObject on page `pageIndex` of a re-parsed output. */
async function outputImage(bytes: Uint8Array, pageIndex = 0) {
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPage(pageIndex);
  const xobjects = page.node.Resources()!.lookup(PDFName.of('XObject')) as never as {
    entries(): [PDFName, PDFRef][];
  };
  const [[name, ref]] = xobjects.entries();
  const stream = doc.context.lookup(ref) as PDFRawStream;
  const num = (key: string) => (stream.dict.lookup(PDFName.of(key)) as PDFNumber).asNumber();
  return {
    doc,
    page,
    name: name.asString(),
    ref,
    stream,
    width: num('Width'),
    height: num('Height')
  };
}

/** Every `cm` in the page's decoded content, as numbers. */
function contentMatrices(doc: PDFDocument, pageIndex = 0): number[][] {
  const contents = doc.getPage(pageIndex).node.Contents();
  const streams =
    contents instanceof PDFArray
      ? contents.asArray().map(r => doc.context.lookup(r) as PDFRawStream)
      : [contents as unknown as PDFRawStream];
  const text = streams
    .map(s => new TextDecoder('latin1').decode(decodePDFRawStream(s).decode()))
    .join('\n');
  return [...text.matchAll(/((?:-?[\d.]+\s+){6})cm/g)].map(m =>
    m[1].trim().split(/\s+/).map(Number)
  );
}

async function pageText(bytes: Uint8Array): Promise<string[]> {
  const task = pdfjsLib.getDocument({ data: bytes.slice(), verbosity: 0 });
  const doc = await task.promise;
  const out: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    out.push(content.items.map(item => ('str' in item ? item.str : '')).join(''));
  }
  await task.destroy();
  return out;
}

describe('CMP-01 — the NFR-03 perf page (1300 px raw RGB drawn 480 pt on A4)', () => {
  for (const kind of ['noise', 'smooth'] as const) {
    it(`${kind}: routes to surgical and the output is smaller, re-parsed`, async () => {
      const input = await pageDoc(d => [
        { ref: rawImage(d, kind, 1300), w: 480, h: 480, x: 56, y: 200 }
      ]);

      // The inventory measured the placement, not the page.
      const [inventory] = await processWorkerImpl.imageInventory(input.slice());
      expect(inventory.images[0].placedWidthPt).toBeCloseTo(480, 5);
      expect(inventory.images[0].placedHeightPt).toBeCloseTo(480, 5);
      expect(Math.round(effectiveDpi(inventory.images[0], A4[0], A4[1]))).toBe(195);

      const report = await ops.planCompression(input, SETTINGS);
      const [page] = report.plan.pages;
      expect(page.route).toBe('surgical');
      expect(page.actionableBytes).toBe(1300 * 1300 * 3);
      // Over-sampled, so the downscale+JPEG path — 480 pt at 150 DPI is 1000 px.
      expect(page.reencode).toEqual([{ name: 'Im0', objectNumber: expect.any(Number) }]);
      expect(page.targetPixels).toBe(1000 * 1000);
      expect(report.alreadyOptimized).toBe(false);

      const result = await ops.compressDocument(input, SETTINGS, report);
      expect(result.keptOriginal).toBe(false);
      expect(result.bytes.byteLength).toBeLessThan(input.byteLength);
      if (kind === 'smooth') {
        expect(result.bytes.byteLength).toBeLessThan(input.byteLength * 0.05);
      }

      const out = await outputImage(result.bytes);
      expect(out.doc.getPageCount()).toBe(1);
      expect(out.stream.dict.lookup(PDFName.of('Filter'))).toBe(PDFName.of('DCTDecode'));
      expect([out.width, out.height]).toEqual([1000, 1000]);
      // Same placement: the content stream (text and vectors) is untouched.
      expect(contentMatrices(out.doc)).toContainEqual([480, 0, 0, 480, 56, 200]);
      expect((await pageText(result.bytes))[0]).toContain('Large fixture page 1');

      // The JPEG holds the picture, not a blank: a left-to-right ramp stays a ramp.
      // (Only the ramp is checked by pixel: the Node canvas shim passes the
      // 0–1 quality straight to @napi-rs/canvas, whose JPEG scale is 0–100, so
      // every JPEG here is encoded at ~1% quality — enough to keep a ramp's
      // block averages, not a noise field's variance.)
      if (kind === 'smooth') {
        const decoded = await decodeToRgba(out.stream.getContents());
        const lum = (x: number, y: number) => decoded.data[(y * decoded.width + x) * 4];
        expect(lum(10, 500)).toBeLessThan(30);
        expect(lum(990, 500)).toBeGreaterThan(225);
      }
    });
  }

  it('the multi-page perf shape: one surgical page per image, each image encoded once', async () => {
    const input = await pageDoc(
      d => [{ ref: rawImage(d, 'smooth', 1300), w: 480, h: 480, x: 56, y: 200 }],
      { pages: 3 }
    );
    const report = await ops.planCompression(input, SETTINGS);
    expect(report.plan.pages.map(p => p.route)).toEqual(['surgical', 'surgical', 'surgical']);
    // One shared object: its bytes count once.
    expect(report.plan.actionableBytes).toBe(1300 * 1300 * 3);
    const result = await ops.compressDocument(input, SETTINGS, report);
    expect(result.bytes.byteLength).toBeLessThan(input.byteLength * 0.05);
    const refs = await Promise.all([0, 1, 2].map(i => outputImage(result.bytes, i)));
    expect(new Set(refs.map(r => r.ref.toString())).size).toBe(1);
  });
});

describe('CMP-01 — over-sampling is judged against the placement', () => {
  it('a 1000 px image drawn 2 inches wide (500 DPI) is over-sampled, and downscaled to 300 px', async () => {
    // Flate-compressed, so only over-sampling can make it a candidate. Against
    // the page it reads as 121 DPI — "already at the target resolution".
    const input = await pageDoc(d => [
      { ref: flateImage(d, 'smooth', 1000), w: 144, h: 144, x: 200, y: 400 }
    ]);
    const [inventory] = await processWorkerImpl.imageInventory(input.slice());
    const facts = inventory.images[0];
    expect(Math.round(effectiveDpi(facts, A4[0], A4[1]))).toBe(500);
    expect(
      Math.round(
        effectiveDpi(
          { ...facts, placedWidthPt: undefined, placedHeightPt: undefined },
          A4[0],
          A4[1]
        )
      )
    ).toBe(121);

    const report = await ops.planCompression(input, SETTINGS);
    expect(report.plan.pages[0].route).toBe('surgical');
    expect(report.plan.pages[0].targetPixels).toBe(300 * 300);

    const result = await ops.compressDocument(input, SETTINGS, report);
    expect(result.keptOriginal).toBe(false);
    const out = await outputImage(result.bytes);
    expect([out.width, out.height]).toEqual([300, 300]);
    expect(contentMatrices(out.doc)).toContainEqual([144, 0, 0, 144, 200, 400]);
  });

  it('a full-page scan under a text stamp is planned exactly as before', async () => {
    // 1240×1754 drawn over the whole 595×842 page: 150 DPI, at a 72 DPI target.
    const scan = (d: PDFDocument) => [
      { ref: flateImage(d, 'smooth', 1240), w: 595, h: 842, x: 0, y: 0 }
    ];
    const size: [number, number] = [595, 842];
    const withText = await pageDoc(scan, { size });
    const report = await ops.planCompression(withText, { dpi: 72, quality: 0.75 });
    const [page] = report.plan.pages;
    expect(page.route).toBe('surgical');
    // The page-span formula's answer: min(1240, 595) × min(1240, 842).
    expect(page.targetPixels).toBe(595 * 842);

    const textless = await pageDoc(scan, { size, text: false });
    const raster = await ops.planCompression(textless, { dpi: 72, quality: 0.75 });
    expect(raster.plan.pages[0].route).toBe('raster');
  });
});

describe('CMP-01 — raw samples at the target resolution are Flate-compressed losslessly', () => {
  it('line art: routed lossless, Flate-encoded, and every sample survives byte for byte', async () => {
    // 300 px drawn 144 pt: exactly 150 DPI, so not over-sampled at 150.
    const samples = rgbSamples('lineart', 300);
    const input = await pageDoc(d => [
      { ref: rawImage(d, 'lineart', 300), w: 144, h: 144, x: 100, y: 300 }
    ]);
    const report = await ops.planCompression(input, SETTINGS);
    const [page] = report.plan.pages;
    expect(page.route).toBe('surgical');
    expect(page.reencode).toEqual([
      { name: 'Im0', objectNumber: expect.any(Number), lossless: true }
    ]);
    expect(page.actionableBytes).toBe(samples.length);
    // Not projected as a JPEG.
    expect(page.targetPixels).toBe(0);
    expect(page.lossless!.bytes).toBe(samples.length);
    expect(page.lossless!.projectedBytes).toBeLessThan(samples.length * 0.1);
    expect(page.reason).toBe(
      'Has text — 1 uncompressed image re-compressed losslessly, text left untouched'
    );
    // The estimate is the measured Flate size, not a JPEG projection.
    const untouched = input.byteLength - samples.length;
    expect(report.estimatedBytes).toBe(Math.round(untouched + page.lossless!.projectedBytes));

    const result = await ops.compressDocument(input, SETTINGS, report);
    expect(result.keptOriginal).toBe(false);
    expect(result.bytes.byteLength).toBeLessThan(input.byteLength);
    expect(result.imageStats).toEqual([
      expect.objectContaining({ status: 're-encoded', originalBytes: samples.length })
    ]);

    const out = await outputImage(result.bytes);
    expect(out.stream.dict.lookup(PDFName.of('Filter'))).toBe(PDFName.of('FlateDecode'));
    expect([out.width, out.height]).toEqual([300, 300]);
    expect(out.stream.dict.lookup(PDFName.of('ColorSpace'))).toBe(PDFName.of('DeviceRGB'));
    expect((out.stream.dict.lookup(PDFName.of('BitsPerComponent')) as PDFNumber).asNumber()).toBe(
      8
    );
    expect(unzlibSync(out.stream.getContents())).toEqual(samples);
    // The plan's projection was conservative: the stream written is no larger.
    expect(out.stream.getContents().length).toBeLessThanOrEqual(page.lossless!.projectedBytes);
    expect(contentMatrices(out.doc)).toContainEqual([144, 0, 0, 144, 100, 300]);
    expect((await pageText(result.bytes))[0]).toContain('Large fixture page 1');
  });

  it('Indexed + ASCIIHex + /SMask + /Decode: only the filter changes, the samples do not', async () => {
    const side = 200;
    const indices = new Uint8Array(side * side);
    for (let i = 0; i < indices.length; i++) indices[i] = i % side < 100 ? 0 : 1;
    const alpha = new Uint8Array(side * side).fill(255);
    alpha.fill(128, 0, side * 20);
    const hex = (bytes: Uint8Array) =>
      new TextEncoder().encode(
        Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('') + '>'
      );
    let smaskRef!: PDFRef;
    let paletteHex!: string;
    const input = await pageDoc(d => {
      smaskRef = d.context.register(
        d.context.stream(alpha, {
          Type: 'XObject',
          Subtype: 'Image',
          Width: side,
          Height: side,
          ColorSpace: 'DeviceGray',
          BitsPerComponent: 8
        })
      );
      paletteHex = 'FF0000' + '0000FF';
      const palette = PDFHexString.of(paletteHex);
      const colorSpace = d.context.obj([
        PDFName.of('Indexed'),
        PDFName.of('DeviceRGB'),
        1,
        palette
      ]);
      const image = d.context.stream(hex(indices), {
        Type: 'XObject',
        Subtype: 'Image',
        Width: side,
        Height: side,
        BitsPerComponent: 8,
        Filter: 'ASCIIHexDecode',
        Decode: [0, 255]
      });
      image.dict.set(PDFName.of('ColorSpace'), colorSpace);
      image.dict.set(PDFName.of('SMask'), smaskRef);
      return [{ ref: d.context.register(image), w: 96, h: 96, x: 100, y: 300 }];
    });

    const report = await ops.planCompression(input, SETTINGS);
    expect(report.plan.pages[0].reencode).toEqual([
      { name: 'Im0', objectNumber: expect.any(Number), lossless: true }
    ]);
    const result = await ops.compressDocument(input, SETTINGS, report);
    expect(result.keptOriginal).toBe(false);

    const out = await outputImage(result.bytes);
    const dict = out.stream.dict;
    expect(dict.lookup(PDFName.of('Filter'))).toBe(PDFName.of('FlateDecode'));
    expect(unzlibSync(out.stream.getContents())).toEqual(indices);
    const cs = dict.lookup(PDFName.of('ColorSpace')) as PDFArray;
    expect(cs.lookup(0)).toBe(PDFName.of('Indexed'));
    expect((cs.lookup(3) as PDFHexString).asString().toUpperCase()).toBe(paletteHex);
    expect((dict.lookup(PDFName.of('Decode')) as PDFArray).asArray().map(n => String(n))).toEqual([
      '0',
      '255'
    ]);
    // The soft mask is still attached, and still the same samples.
    const smask = dict.lookup(PDFName.of('SMask')) as PDFStream;
    expect(smask).toBeInstanceOf(PDFRawStream);
    expect(decodePDFRawStream(smask as PDFRawStream).decode()).toEqual(alpha);
  });

  it('raw noise at the target resolution is left alone — Flate cannot shrink it', async () => {
    const input = await pageDoc(d => [
      { ref: rawImage(d, 'noise', 300), w: 144, h: 144, x: 100, y: 300 }
    ]);
    const report = await ops.planCompression(input, SETTINGS);
    expect(report.plan.pages[0].route).toBe('already-optimized');
    expect(report.plan.actionableBytes).toBe(0);
  });

  it('the rebuild keeps the original when the Flate stream is not smaller (per-image guard)', async () => {
    const input = await pageDoc(d => [
      { ref: rawImage(d, 'noise', 300), w: 144, h: 144, x: 100, y: 300 }
    ]);
    const [inventory] = await processWorkerImpl.imageInventory(input.slice());
    const objectNumber = inventory.images[0].objectNumber;
    // Asked directly, bypassing the plan that would not have asked.
    const result = await processWorkerImpl.rebuildCompressed(input.slice(), {}, {}, undefined, {
      0: [objectNumber]
    });
    expect(result.keptOriginal).toBe(true);
    expect(result.bytes).toEqual(input);
    expect(result.imageStats).toEqual([
      expect.objectContaining({ status: 'skipped', objectNumber, originalBytes: 300 * 300 * 3 })
    ]);
    expect(result.imageStats[0].skipReason).toMatch(/original stream was kept/);
  });

  it('the rebuild re-checks the file: a Flate image named as lossless is not touched', async () => {
    const input = await pageDoc(d => [
      { ref: flateImage(d, 'lineart', 300), w: 144, h: 144, x: 100, y: 300 }
    ]);
    const [inventory] = await processWorkerImpl.imageInventory(input.slice());
    const result = await processWorkerImpl.rebuildCompressed(input.slice(), {}, {}, undefined, {
      0: [inventory.images[0].objectNumber]
    });
    expect(result.keptOriginal).toBe(true);
    expect(result.bytes).toEqual(input);
    expect(result.imageStats[0].status).toBe('skipped');
  });

  it('an image at the target resolution that is already a JPEG stays untouched', async () => {
    const canvas = canvasLib.createCanvas(300, 300);
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 300, 0);
    gradient.addColorStop(0, '#203040');
    gradient.addColorStop(1, '#d0e0f0');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 300, 300);
    const jpeg = new Uint8Array(canvas.toBuffer('image/jpeg', 80)); // @napi-rs/canvas takes 0–100
    const input = await pageDoc(d => {
      const ref = d.context.register(
        d.context.stream(jpeg, {
          Type: 'XObject',
          Subtype: 'Image',
          Width: 300,
          Height: 300,
          ColorSpace: 'DeviceRGB',
          BitsPerComponent: 8,
          Filter: 'DCTDecode'
        })
      );
      return [{ ref, w: 144, h: 144, x: 100, y: 300 }];
    });
    const report = await ops.planCompression(input, SETTINGS);
    expect(report.plan.pages[0].route).toBe('already-optimized');
    expect(report.plan.pages[0].reason).toBe(
      'Text and vectors only, or images already at the target resolution'
    );
    expect(report.plan.actionableBytes).toBe(0);
    expect(report.alreadyOptimized).toBe(true);
  });
});

describe('CMP-01 — classifyPages, document-wide placement rules', () => {
  function facts(overrides: Partial<ImageFacts>): ImageFacts {
    return {
      name: 'Im0',
      objectNumber: 7,
      width: 1000,
      height: 1000,
      bitsPerComponent: 8,
      colorSpace: 'DeviceRGB',
      filter: 'FlateDecode',
      filters: ['FlateDecode'],
      maskFilters: [],
      hasSMask: false,
      hasMask: false,
      maskKind: 'none',
      isImageMask: false,
      byteLength: 500_000,
      ...overrides
    };
  }
  const page = (pageIndex: number, images: ImageFacts[]): PageImageInventory => ({
    pageIndex,
    images,
    width: 612,
    height: 792
  });
  const text = (n: number) =>
    Array.from({ length: n }, (_, pageIndex) => ({ pageIndex, charCount: 40, runCount: 4 }));

  it('a shared image is judged at its largest placement, not its smallest', () => {
    // 1000 px: 1000 DPI drawn 72 pt on page 1, 150 DPI drawn 480 pt on page 2.
    // The encoder sizes the one replacement for page 2, i.e. full size — so it
    // is not over-sampled, and a Flate image is left alone on both pages.
    const plan = classifyPages(
      [
        page(0, [facts({ placedWidthPt: 72, placedHeightPt: 72 })]),
        page(1, [facts({ placedWidthPt: 480, placedHeightPt: 480 })])
      ],
      text(2),
      { rasterDpi: 150 }
    );
    expect(plan.pages.map(p => p.route)).toEqual(['already-optimized', 'already-optimized']);

    // At 72 DPI the larger use is over-sampled too, and it decides the size:
    // 480 pt at 72 DPI = 480 px, counted once for the one shared object.
    const at72 = classifyPages(
      [
        page(0, [facts({ placedWidthPt: 72, placedHeightPt: 72 })]),
        page(1, [facts({ placedWidthPt: 480, placedHeightPt: 480 })])
      ],
      text(2),
      { rasterDpi: 72 }
    );
    expect(at72.pages.map(p => p.route)).toEqual(['surgical', 'surgical']);
    expect(at72.pages[0].targetPixels).toBe(480 * 480);
    expect(at72.pages[1].targetPixels).toBe(0);
    expect(at72.actionableBytes).toBe(500_000);
  });

  it('a lossless candidate is not projected as a JPEG, and never promised past its measured size', () => {
    const raw = facts({
      filter: 'unknown',
      filters: [],
      byteLength: 3_000_000,
      placedWidthPt: 480,
      placedHeightPt: 480,
      rawSamples: { sampleBytes: 3_000_000, projectedFlateBytes: 900_000 }
    });
    const plan = classifyPages([page(0, [raw])], text(1), { rasterDpi: 150 });
    expect(plan.pages[0].route).toBe('surgical');
    expect(plan.pages[0].targetPixels).toBe(0);
    expect(plan.pages[0].lossless).toEqual({ bytes: 3_000_000, projectedBytes: 900_000 });
    const estimate = estimateSavings(plan, 3_100_000, 0.75);
    expect(estimate.estimatedBytes).toBe(100_000 + 900_000);

    // Both kinds on one page: each projected by its own model, reason names both.
    const both = classifyPages(
      [
        page(0, [
          raw,
          facts({ objectNumber: 8, name: 'Im1', placedWidthPt: 72, placedHeightPt: 72 })
        ])
      ],
      text(1),
      { rasterDpi: 150 }
    );
    expect(both.pages[0].reason).toBe(
      'Has text — 1 over-sampled image(s) re-encoded and 1 uncompressed image(s) re-compressed losslessly, text left untouched'
    );
    expect(both.pages[0].targetPixels).toBe(150 * 150);
    expect(both.pages[0].lossless).toEqual({ bytes: 3_000_000, projectedBytes: 900_000 });
  });

  it('an unsafe raw image (a /Separation plate) is still refused — lossless follows the same rules', () => {
    const plan = classifyPages(
      [
        page(0, [
          facts({
            colorSpace: 'Separation',
            filters: [],
            placedWidthPt: 480,
            placedHeightPt: 480,
            rawSamples: { sampleBytes: 500_000, projectedFlateBytes: 10_000 }
          })
        ])
      ],
      text(1),
      { rasterDpi: 150 }
    );
    expect(plan.pages[0].route).toBe('skip');
    expect(plan.actionableBytes).toBe(0);
  });
});
