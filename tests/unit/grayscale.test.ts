/**
 * GAP-6 — greyscale / B&W, graded on real output bytes.
 *
 * `operations.grayscaleDocument` runs end to end against the *real* worker
 * implementations (process + render; pdf.js's legacy build renders through a
 * napi-rs canvas). Every output is then re-read three ways:
 *
 *  • structurally — the output's content streams, shadings and images are
 *    re-planned; a converted page must have nothing left to convert, and the
 *    raw bytes are scanned for colour operators independently of that code;
 *  • textually — pdf.js still extracts the text of vector-converted pages;
 *  • visually — the page is rendered and every pixel must have R ≈ G ≈ B.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFStream,
  StandardFonts,
  cmyk,
  decodePDFRawStream,
  rgb
} from 'pdf-lib';
import { canvasLib, decodeToRgba, installCanvasShims } from './helpers/node-canvas-shims';

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
  const lease =
    <A>(api: A) =>
    <T>(fn: (a: A) => Promise<T>) =>
      fn(api);
  return {
    processWorker: { lease: lease(processWorkerImpl) },
    renderWorker: {
      lease: lease(renderWorkerImpl),
      pin: () => ({ lease: lease(renderWorkerImpl), release: () => {} })
    },
    cvWorker: { lease: vi.fn() },
    convertWorker: { lease: vi.fn() }
  };
});

installCanvasShims();
const { grayscaleDocument } = await import('../../src/core/operations');
const { encodeGrayJpeg } = await import('../../src/core/jpeg-gray');
const { renderWorkerImpl } = await import('../../src/core/workers/render.worker');

const FIXTURES = path.resolve(__dirname, '../fixtures');
const fixture = (name: string) => new Uint8Array(fs.readFileSync(path.join(FIXTURES, name)));

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function colourJpeg(size = 64): Uint8Array {
  const canvas = canvasLib.createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  for (let y = 0; y < size; y += 8) {
    for (let x = 0; x < size; x += 8) {
      ctx.fillStyle = `rgb(${(x * 4) % 255}, ${(y * 4) % 255}, 40)`;
      ctx.fillRect(x, y, 8, 8);
    }
  }
  return new Uint8Array(canvas.toBuffer('image/jpeg', 90)); // @napi-rs/canvas takes 0–100
}

function colourPngWithAlpha(size = 32): Uint8Array {
  const canvas = canvasLib.createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(0, 0, 255, 0.5)';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = 'rgb(255, 0, 0)';
  ctx.fillRect(size / 4, size / 4, size / 2, size / 2);
  return new Uint8Array(canvas.toBuffer('image/png'));
}

function streamText(stream: PDFStream): string {
  const bytes =
    stream instanceof PDFRawStream && stream.dict.get(PDFName.of('Filter'))
      ? decodePDFRawStream(stream).decode()
      : stream.getContents();
  return Buffer.from(bytes).toString('latin1');
}

/**
 * Independent structural scan: every content stream reachable from `pageIndex`
 * (page, forms, tiling patterns, annotation appearances), searched for colour
 * operators, plus every image and shading for a non-grey colour space. Written
 * separately from the converter on purpose — grading it with itself would prove
 * nothing.
 */
function colourLeftOnPage(doc: PDFDocument, pageIndex: number): string[] {
  const found: string[] = [];
  const ctx = doc.context;
  const seen = new Set<unknown>();
  const deref = (v: unknown) => (v instanceof PDFRef ? ctx.lookup(v) : v);
  const grayCs = (v: unknown, resources?: PDFDict): boolean => {
    let cs = deref(v);
    if (cs instanceof PDFName) {
      const n = cs.decodeText();
      if (['DeviceGray', 'G', 'CalGray', 'Pattern'].includes(n)) return true;
      const named = resources?.lookupMaybe(PDFName.of('ColorSpace'), PDFDict)?.get(cs);
      if (named === undefined) return false;
      cs = deref(named);
      if (cs instanceof PDFName) return grayCs(cs);
    }
    if (cs instanceof PDFArray) {
      const family = (deref(cs.get(0)) as PDFName).decodeText();
      if (family === 'Pattern') return cs.size() < 2 || grayCs(cs.get(1));
      if (family === 'ICCBased') {
        const s = deref(cs.get(1)) as PDFStream;
        return String(s.dict.lookup(PDFName.of('N'))) === '1';
      }
      return family === 'CalGray' || family === 'DeviceGray';
    }
    return false;
  };
  const scanContent = (text: string, resources: PDFDict | undefined, where: string) => {
    if (/(^|\s)[-\d.]+\s+[-\d.]+\s+[-\d.]+\s+(rg|RG)(\s|$)/.test(text)) found.push(`${where}: rg`);
    if (/(^|\s)[-\d.]+\s+[-\d.]+\s+[-\d.]+\s+[-\d.]+\s+(k|K)(\s|$)/.test(text)) {
      found.push(`${where}: k`);
    }
    for (const m of text.matchAll(/\/([^\s/[\]()<>]+)\s+(cs|CS)(\s|$)/g)) {
      if (!grayCs(PDFName.of(m[1]), resources)) found.push(`${where}: /${m[1]} ${m[2]}`);
    }
    for (const m of text.matchAll(/\/([^\s/[\]()<>]+)\s+Do(\s|$)/g)) {
      const x = deref(
        resources?.lookupMaybe(PDFName.of('XObject'), PDFDict)?.get(PDFName.of(m[1]))
      );
      if (x instanceof PDFStream) visitXObject(x, resources, `${where}/${m[1]}`);
    }
    for (const m of text.matchAll(/\/([^\s/[\]()<>]+)\s+sh(\s|$)/g)) {
      const sh = deref(
        resources?.lookupMaybe(PDFName.of('Shading'), PDFDict)?.get(PDFName.of(m[1]))
      );
      const dict = sh instanceof PDFStream ? sh.dict : (sh as PDFDict);
      if (!grayCs(dict.get(PDFName.of('ColorSpace')))) found.push(`${where}: shading ${m[1]}`);
    }
  };
  const visitXObject = (x: PDFStream, parent: PDFDict | undefined, where: string) => {
    if (seen.has(x)) return;
    seen.add(x);
    const subtype = (x.dict.lookup(PDFName.of('Subtype')) as PDFName).decodeText();
    if (subtype === 'Image') {
      if (String(x.dict.lookup(PDFName.of('ImageMask'))) === 'true') return;
      if (!grayCs(x.dict.get(PDFName.of('ColorSpace')), parent)) found.push(`${where}: image`);
      return;
    }
    const res = x.dict.lookupMaybe(PDFName.of('Resources'), PDFDict) ?? parent;
    scanContent(streamText(x), res, where);
  };
  const page = doc.getPage(pageIndex);
  const contents = deref(page.node.get(PDFName.of('Contents')));
  const parts = contents instanceof PDFArray ? contents.asArray() : [contents];
  const text = parts.map(p => streamText(deref(p) as PDFStream)).join('\n');
  scanContent(text, page.node.Resources(), `page ${pageIndex + 1}`);
  return found;
}

async function pdfjsText(bytes: Uint8Array): Promise<string[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: bytes.slice(), disableFontFace: true, verbosity: 0 });
  const doc = await task.promise;
  const out: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    out.push(content.items.map(item => ('str' in item ? item.str : '')).join(' '));
  }
  await task.destroy();
  return out;
}

/** Renders every page and returns the largest |R−G|, |G−B| found, plus mean ink. */
async function pixelReport(
  bytes: Uint8Array
): Promise<{ maxChroma: number; distinctLevels: number; pages: number }[]> {
  const { handle, pageCount } = await renderWorkerImpl.loadDocument(bytes.slice());
  const out: { maxChroma: number; distinctLevels: number; pages: number }[] = [];
  try {
    for (let i = 0; i < pageCount; i++) {
      const png = await renderWorkerImpl.pageToImageBytes(handle, i, 'png', 50);
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
      out.push({ maxChroma, distinctLevels: levels.size, pages: pageCount });
    }
  } finally {
    await renderWorkerImpl.closeDocument(handle);
  }
  return out;
}

async function allPages(bytes: Uint8Array): Promise<number[]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPageIndices();
}

async function run(bytes: Uint8Array, mode: 'gray' | 'bw' = 'gray', pages?: number[]) {
  const indices = pages ?? (await allPages(bytes));
  const total = (await PDFDocument.load(bytes)).getPageCount();
  return grayscaleDocument(bytes, indices, total, { mode, rasterDpi: 72 });
}

/** A colour document built here: text, vectors, a JPEG, a PNG with alpha. */
async function colourDocument(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const jpeg = await doc.embedJpg(colourJpeg());
  const png = await doc.embedPng(colourPngWithAlpha());
  const page = doc.addPage([300, 300]);
  page.drawRectangle({ x: 0, y: 0, width: 300, height: 300, color: rgb(0.9, 0.95, 1) });
  page.drawText('Red heading', { x: 20, y: 260, size: 18, font, color: rgb(1, 0, 0) });
  page.drawRectangle({ x: 20, y: 200, width: 100, height: 40, color: cmyk(0, 0.8, 1, 0) });
  page.drawLine({
    start: { x: 20, y: 190 },
    end: { x: 280, y: 190 },
    thickness: 3,
    color: rgb(0, 0.6, 0)
  });
  page.drawImage(jpeg, { x: 20, y: 20, width: 120, height: 120 });
  page.drawImage(png, { x: 160, y: 20, width: 120, height: 120 });
  // A second page reusing the same JPEG: it must be converted once, shared.
  const page2 = doc.addPage([300, 300]);
  page2.drawImage(jpeg, { x: 20, y: 20, width: 200, height: 200 });
  page2.drawText('Second page text', { x: 20, y: 250, size: 14, font, color: rgb(0, 0, 1) });
  return doc.save({ useObjectStreams: false });
}

/** Content with a Separation tint (type 2), an axial RGB shading, and an Indexed fill. */
async function specialColourDocument(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([200, 200]);
  const ctx = doc.context;
  const tint = ctx.obj({
    FunctionType: 2,
    Domain: [0, 1],
    C0: [0, 0, 0, 0],
    C1: [0, 1, 1, 0],
    N: 1
  });
  const sep = ctx.obj([
    PDFName.of('Separation'),
    PDFName.of('Spot'),
    PDFName.of('DeviceCMYK'),
    tint
  ]);
  const indexed = ctx.obj([
    PDFName.of('Indexed'),
    PDFName.of('DeviceRGB'),
    1,
    PDFHexString.of('FF000000FF00')
  ]);
  const shading = ctx.obj({
    ShadingType: 2,
    ColorSpace: 'DeviceRGB',
    Coords: [0, 0, 200, 0],
    Function: { FunctionType: 2, Domain: [0, 1], C0: [1, 0, 0], C1: [0, 0, 1], N: 1 },
    Extend: [true, true]
  });
  page.node.set(
    PDFName.of('Resources'),
    ctx.obj({
      ColorSpace: { CS1: sep, CS2: indexed },
      Shading: { Sh1: ctx.register(shading) }
    })
  );
  const content =
    'q 0 0 200 60 re W n /Sh1 sh Q\n' +
    '/CS1 cs 0.8 sc 10 70 80 50 re f\n' +
    '/CS2 cs 1 sc 110 70 80 50 re f\n' +
    '/CS1 CS 1 SC 4 w 10 150 m 190 150 l S\n';
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream(content)));
  return doc.save({ useObjectStreams: false });
}

/** A page with an inline image — cannot be rewritten, must be rasterised. */
async function inlineImageDocument(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([100, 100]);
  const ctx = doc.context;
  const content =
    '1 0 0 rg 0 0 50 50 re f\n' +
    'q 40 0 0 40 50 50 cm BI /W 2 /H 1 /CS /RGB /BPC 8 ID \xff\x00\x00\x00\x00\xff EI Q\n';
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.stream(Buffer.from(content, 'latin1'))));
  return doc.save({ useObjectStreams: false });
}

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

describe('grayscale — vector conversion', () => {
  it('leaves no colour operators or colour images, keeps text, renders grey', async () => {
    const input = await colourDocument();
    const before = await pixelReport(input);
    expect(before[0].maxChroma).toBeGreaterThan(100); // the premise: it really is colour

    const result = await run(input);
    expect(result.nothingToDo).toBe(false);
    expect(result.colourLeft).toEqual([]);
    expect(result.pages.map(p => p.route)).toEqual(['vector', 'vector']);
    expect(result.pages[0].imagesConverted).toBe(2);

    const out = await PDFDocument.load(result.bytes);
    expect(out.getPageCount()).toBe(2);
    expect(colourLeftOnPage(out, 0)).toEqual([]);
    expect(colourLeftOnPage(out, 1)).toEqual([]);

    const text = await pdfjsText(result.bytes);
    expect(text[0]).toContain('Red heading');
    expect(text[1]).toContain('Second page text');

    const after = await pixelReport(result.bytes);
    for (const page of after) {
      expect(page.maxChroma).toBeLessThanOrEqual(2);
      expect(page.distinctLevels).toBeGreaterThan(8); // real greys, not blanked
    }
  });

  it('converts a shared image once and points both pages at the same grey copy', async () => {
    const result = await run(await colourDocument());
    const out = await PDFDocument.load(result.bytes);
    const imageRefs = [0, 1].map(i => {
      const xobjects = out.getPage(i).node.Resources()!.lookup(PDFName.of('XObject'), PDFDict);
      return [...xobjects.entries()]
        .map(([, v]) => v as PDFRef)
        .filter(ref => {
          const s = out.context.lookup(ref) as PDFStream;
          return (s.dict.lookup(PDFName.of('Filter')) as PDFName).decodeText() === 'DCTDecode';
        })
        .map(ref => ref.objectNumber);
    });
    expect(imageRefs[0].length).toBe(1);
    expect(imageRefs[1]).toEqual(imageRefs[0]);
    // The old colour JPEG is gone from the file, not just unreferenced.
    const jpegs = [...out.context.enumerateIndirectObjects()].filter(
      ([, o]) =>
        o instanceof PDFStream && String(o.dict.lookup(PDFName.of('Filter'))) === '/DCTDecode'
    );
    expect(jpegs.length).toBe(1);
  });

  it('keeps the soft mask of a transparent image attached', async () => {
    const result = await run(await colourDocument());
    const out = await PDFDocument.load(result.bytes);
    const xobjects = out.getPage(0).node.Resources()!.lookup(PDFName.of('XObject'), PDFDict);
    const withMask = [...xobjects.entries()]
      .map(([, v]) => out.context.lookup(v as PDFRef) as PDFStream)
      .filter(s => s.dict.get(PDFName.of('SMask')) !== undefined);
    expect(withMask.length).toBe(1);
    expect(String(withMask[0].dict.lookup(PDFName.of('ColorSpace')))).toBe('/DeviceGray');
    const mask = withMask[0].dict.lookup(PDFName.of('SMask'), PDFStream);
    expect(String(mask.dict.lookup(PDFName.of('ColorSpace')))).toBe('/DeviceGray');
  });

  it('converts Separation, Indexed and shading colour as vectors', async () => {
    const input = await specialColourDocument();
    expect((await pixelReport(input))[0].maxChroma).toBeGreaterThan(100);
    const result = await run(input);
    expect(result.pages[0].route).toBe('vector');
    expect(result.colourLeft).toEqual([]);
    const out = await PDFDocument.load(result.bytes);
    expect(colourLeftOnPage(out, 0)).toEqual([]);
    const after = await pixelReport(result.bytes);
    expect(after[0].maxChroma).toBeLessThanOrEqual(2);
    expect(after[0].distinctLevels).toBeGreaterThan(8); // the gradient survived as a gradient
  });

  it('converts only the selected pages and leaves the others byte-for-byte in colour', async () => {
    const input = await colourDocument();
    const result = await run(input, 'gray', [1]);
    expect(result.pages.map(p => p.pageIndex)).toEqual([1]);
    const out = await PDFDocument.load(result.bytes);
    expect(colourLeftOnPage(out, 1)).toEqual([]);
    expect(colourLeftOnPage(out, 0).length).toBeGreaterThan(0);
    const pixels = await pixelReport(result.bytes);
    expect(pixels[0].maxChroma).toBeGreaterThan(100);
    expect(pixels[1].maxChroma).toBeLessThanOrEqual(2);
  });

  it('says there is nothing to do for a document that is already grey', async () => {
    const result = await run(fixture('text-2.pdf'));
    expect(result.nothingToDo).toBe(true);
  });
});

describe('grayscale — fixtures with hard colour spaces', () => {
  it('cmyk-image.pdf: the CMYK image is converted and renders grey', async () => {
    const input = fixture('cmyk-image.pdf');
    const result = await run(input);
    expect(result.nothingToDo).toBe(false);
    expect(result.colourLeft).toEqual([]);
    for (const page of await pixelReport(result.bytes))
      expect(page.maxChroma).toBeLessThanOrEqual(2);
  });

  // These fixtures *declare* an image in their resources but no content stream
  // ever draws it — there is nothing visible to convert, and the honest answer
  // is "already grey", not a rewritten file.
  for (const name of ['indexed.pdf', 'icc.pdf', 'soft-mask.pdf', 'color-key.pdf']) {
    it(`${name}: an image that is never drawn is left alone`, async () => {
      const result = await run(fixture(name));
      expect(result.nothingToDo).toBe(true);
    });
  }

  it('Indexed, ICCBased and colour-keyed images that *are* drawn are converted', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 150]);
    const ctx = doc.context;
    const { zlibSync } = await import('fflate');
    const { PDFHexString } = await import('pdf-lib');
    const indexed = ctx.register(
      ctx.stream(zlibSync(new Uint8Array([0, 1, 2, 3])), {
        Type: 'XObject',
        Subtype: 'Image',
        Width: 4,
        Height: 1,
        BitsPerComponent: 8,
        Filter: 'FlateDecode',
        ColorSpace: [
          PDFName.of('Indexed'),
          PDFName.of('DeviceRGB'),
          3,
          PDFHexString.of('FF000000FF000000FFFFFF00')
        ]
      })
    );
    const icc = ctx.register(ctx.flateStream(new Uint8Array(16), { N: 3, Alternate: 'DeviceRGB' }));
    const rgbPixels = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]);
    const iccImage = ctx.register(
      ctx.stream(zlibSync(rgbPixels), {
        Type: 'XObject',
        Subtype: 'Image',
        Width: 4,
        Height: 1,
        BitsPerComponent: 8,
        Filter: 'FlateDecode',
        ColorSpace: [PDFName.of('ICCBased'), icc]
      })
    );
    const keyed = ctx.register(
      ctx.stream(zlibSync(rgbPixels), {
        Type: 'XObject',
        Subtype: 'Image',
        Width: 4,
        Height: 1,
        BitsPerComponent: 8,
        Filter: 'FlateDecode',
        ColorSpace: 'DeviceRGB',
        // Pure red is transparent.
        Mask: [255, 255, 0, 0, 0, 0]
      })
    );
    page.node.set(
      PDFName.of('Resources'),
      ctx.obj({ XObject: { Ix: indexed, Ic: iccImage, Ik: keyed } })
    );
    page.node.set(
      PDFName.of('Contents'),
      ctx.register(
        ctx.flateStream(
          'q 120 0 0 120 10 10 cm /Ix Do Q q 120 0 0 120 140 10 cm /Ic Do Q q 120 0 0 120 270 10 cm /Ik Do Q'
        )
      )
    );
    const input = await doc.save({ useObjectStreams: false });
    expect((await pixelReport(input))[0].maxChroma).toBeGreaterThan(100);

    const result = await run(input);
    expect(result.colourLeft).toEqual([]);
    expect(result.pages[0].route).toBe('vector');
    expect(result.pages[0].imagesConverted).toBe(3);
    const out = await PDFDocument.load(result.bytes);
    expect(colourLeftOnPage(out, 0)).toEqual([]);
    // The colour key meant "red is transparent" in RGB; in grey it has to
    // become an explicit soft mask, or red pixels would suddenly paint.
    const xobjects = out.getPage(0).node.Resources()!.lookup(PDFName.of('XObject'), PDFDict);
    const keyedOut = out.context.lookup(xobjects.get(PDFName.of('Ik')) as PDFRef) as PDFStream;
    expect(keyedOut.dict.get(PDFName.of('Mask'))).toBeUndefined();
    expect(keyedOut.dict.get(PDFName.of('SMask'))).toBeDefined();
    const pixels = await pixelReport(result.bytes);
    expect(pixels[0].maxChroma).toBeLessThanOrEqual(2);
    expect(pixels[0].distinctLevels).toBeGreaterThan(3);
  });
});

describe('grayscale — fallbacks', () => {
  it('rasterises a page with an inline image, names it, and still leaves no colour', async () => {
    const result = await run(await inlineImageDocument());
    expect(result.pages[0].route).toBe('raster');
    expect(result.pages[0].reasons.join(' ')).toMatch(/inline image/);
    expect(result.colourLeft).toEqual([]);
    const pixels = await pixelReport(result.bytes);
    expect(pixels[0].maxChroma).toBeLessThanOrEqual(2);
    expect(pixels[0].distinctLevels).toBeGreaterThan(1); // not a blank page
  });
});

describe('black and white', () => {
  it('writes 1-bit images and only pure black or white vector colours', async () => {
    const input = await colourDocument();
    const result = await run(input, 'bw');
    expect(result.colourLeft).toEqual([]);
    const out = await PDFDocument.load(result.bytes);
    for (const index of out.getPageIndices()) {
      expect(colourLeftOnPage(out, index)).toEqual([]);
      const page = out.getPage(index);
      const xobjects = page.node.Resources()!.lookup(PDFName.of('XObject'), PDFDict);
      for (const [, ref] of xobjects.entries()) {
        const image = out.context.lookup(ref as PDFRef) as PDFStream;
        expect(String(image.dict.lookup(PDFName.of('ColorSpace')))).toBe('/DeviceGray');
        expect(String(image.dict.lookup(PDFName.of('BitsPerComponent')))).toBe('1');
      }
      const contents = page.node.get(PDFName.of('Contents'));
      const text = streamText(out.context.lookup(contents as PDFRef) as PDFStream);
      for (const m of text.matchAll(/(^|\s)([-\d.]+)\s+(g|G|sc|SC)(\s|$)/g)) {
        expect(['0', '1']).toContain(m[2]);
      }
    }
    // The rendered page is still recognisably the page: not all one colour.
    const pixels = await pixelReport(result.bytes);
    expect(pixels[0].maxChroma).toBeLessThanOrEqual(2);
    expect(pixels[0].distinctLevels).toBeGreaterThan(1);
  });
});

describe('encodeGrayJpeg', () => {
  it('writes a real single-component JPEG that decodes back to the same image', async () => {
    const width = 37;
    const height = 23;
    const gray = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) gray[y * width + x] = (x * 7 + y * 3) % 256;
    }
    const jpeg = encodeGrayJpeg(gray, width, height, { quality: 0.95 });
    // SOF0 with one component.
    const sof = Buffer.from(jpeg).indexOf(Buffer.from([0xff, 0xc0]));
    expect(sof).toBeGreaterThan(0);
    expect(jpeg[sof + 9]).toBe(1);
    const decoded = await decodeToRgba(jpeg);
    expect(decoded.width).toBe(width);
    expect(decoded.height).toBe(height);
    let maxError = 0;
    for (let p = 0; p < gray.length; p++) {
      maxError = Math.max(maxError, Math.abs(decoded.data[p * 4] - gray[p]));
    }
    expect(maxError).toBeLessThan(24);
  });
});
