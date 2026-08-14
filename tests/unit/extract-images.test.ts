/**
 * CNV-06 — extraction of embedded image XObjects, checked against real output
 * bytes rather than against intent.
 *
 * The acceptance criterion ("extracted bytes match the source image object's
 * decoded pixels exactly, no generational loss versus a re-encoded round trip")
 * is asserted in the strongest available form for each path:
 *
 *  • `/DCTDecode` and `/JPXDecode` — the written file is byte-identical to the
 *    stream the PDF carries, so there is no decode step in which loss could
 *    occur at all.
 *  • Raw rasters — the PNG's IDAT payload, inflated and stripped of its
 *    per-scanline filter bytes, is byte-identical to the PDF stream's decoded
 *    samples, and the palette/bit depth survive unchanged.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { unzipSync, unzlibSync } from 'fflate';
import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFStream
} from 'pdf-lib';

vi.mock('comlink', () => ({
  expose: vi.fn(),
  transfer: vi.fn(val => val)
}));

const { processWorkerImpl } = await import('../../src/core/workers/process.worker');
const { encodePng } = await import('../../src/core/png');

function fixture(name: string): Uint8Array {
  const path = fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
  return new Uint8Array(readFileSync(path));
}

/* ------------------------------------------------------------------ *
 * Helpers that read the *output* rather than trusting the operation
 * ------------------------------------------------------------------ */

interface PngFacts {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  palette?: Uint8Array;
  /** IDAT inflated, with the filter byte removed from each scanline. */
  samples: Uint8Array;
}

/** A deliberately independent PNG reader, so the test does not reuse the writer. */
function readPng(bytes: Uint8Array): PngFacts {
  expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let header: { width: number; height: number; bitDepth: number; colorType: number } | undefined;
  let palette: Uint8Array | undefined;
  const idat: Uint8Array[] = [];

  while (at < bytes.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const data = bytes.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      const head = new DataView(data.buffer, data.byteOffset, data.byteLength);
      header = {
        width: head.getUint32(0),
        height: head.getUint32(4),
        bitDepth: data[8],
        colorType: data[9]
      };
      expect(data[12]).toBe(0); // never interlaced
    }
    if (type === 'PLTE') palette = new Uint8Array(data);
    if (type === 'IDAT') idat.push(new Uint8Array(data));
    at += 12 + length;
  }
  if (!header) throw new Error('PNG has no IHDR');

  const joined = new Uint8Array(idat.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of idat) {
    joined.set(part, offset);
    offset += part.length;
  }
  const raw = unzlibSync(joined);
  const channels = header.colorType === 2 ? 3 : 1;
  const rowBytes = Math.ceil((header.width * channels * header.bitDepth) / 8);
  const samples = new Uint8Array(rowBytes * header.height);
  for (let y = 0; y < header.height; y++) {
    expect(raw[y * (rowBytes + 1)]).toBe(0); // filter type "None"
    samples.set(raw.subarray(y * (rowBytes + 1) + 1, (y + 1) * (rowBytes + 1)), y * rowBytes);
  }
  return { ...header, palette, samples };
}

/** Every image XObject of a page, as pdf-lib streams, in resource order. */
async function imageStreams(bytes: Uint8Array, pageIndex = 0): Promise<PDFStream[]> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const resources = doc.getPage(pageIndex).node.Resources();
  const xobjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
  const found: PDFStream[] = [];
  if (!xobjects) return found;
  for (const [key] of xobjects.entries()) {
    const stream = xobjects.lookup(key);
    if (!(stream instanceof PDFStream)) continue;
    const subtype = stream.dict.get(PDFName.of('Subtype'));
    if (subtype instanceof PDFName && subtype.asString() === '/Image') found.push(stream);
  }
  return found;
}

function rawContents(stream: PDFStream): Uint8Array {
  if (!(stream instanceof PDFRawStream)) throw new Error('not a raw stream');
  return new Uint8Array(stream.contents);
}

function decodedSamples(stream: PDFStream): Uint8Array {
  if (!(stream instanceof PDFRawStream)) throw new Error('not a raw stream');
  return decodePDFRawStream(stream).decode();
}

/* ------------------------------------------------------------------ *
 * Fixtures built here, so the exact encoding under test is known
 * ------------------------------------------------------------------ */

/** A page carrying a JPEG (DCTDecode) and a Flate RGB raster, both drawn. */
async function jpegAndRasterPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 300]);
  const jpg = await doc.embedJpg(fixture('tiny.jpg'));
  const png = await doc.embedPng(fixture('sample.png'));
  page.drawImage(jpg, { x: 10, y: 10, width: 40, height: 200 });
  page.drawImage(png, { x: 100, y: 10, width: 120, height: 80 });
  return doc.save();
}

/**
 * A hand-built page with a 4-bit `/Indexed` image, an 8-bit greyscale image
 * carrying an `/SMask`, and a raster whose declared size exceeds its data.
 *
 * Hand-built because no encoder in this toolchain emits an indexed PDF image,
 * and because the truncated case has to be malformed on purpose.
 */
async function handBuiltRastersPdf(): Promise<{ bytes: Uint8Array; indexed: Uint8Array }> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([200, 200]);
  const context = doc.context;

  // 4 pixels per row at 4 bits per pixel = 2 bytes per row, 4 rows.
  const indexedSamples = new Uint8Array([0x01, 0x23, 0x32, 0x10, 0x11, 0x00, 0x23, 0x11]);
  const palette = new Uint8Array([
    0,
    0,
    0,
    255,
    0,
    0,
    0,
    255,
    0,
    0,
    0,
    255 // black, red, green, blue
  ]);
  const colorSpace = PDFArray.withContext(context);
  colorSpace.push(PDFName.of('Indexed'));
  colorSpace.push(PDFName.of('DeviceRGB'));
  colorSpace.push(PDFNumber.of(3));
  colorSpace.push(PDFHexString.fromText(''));
  // Replace the placeholder with the real palette bytes as a hex string.
  colorSpace.set(
    3,
    PDFHexString.of([...palette].map(b => b.toString(16).padStart(2, '0')).join(''))
  );

  const indexedRef = context.register(
    context.flateStream(indexedSamples, {
      Type: 'XObject',
      Subtype: 'Image',
      Width: 4,
      Height: 4,
      BitsPerComponent: 4,
      ColorSpace: colorSpace
    })
  );

  const graySamples = new Uint8Array([0, 40, 80, 120, 160, 200, 240, 255, 10, 20, 30, 40]);
  const maskSamples = new Uint8Array([255, 128, 64, 0, 255, 128, 64, 0, 255, 128, 64, 0]);
  const maskRef = context.register(
    context.flateStream(maskSamples, {
      Type: 'XObject',
      Subtype: 'Image',
      Width: 4,
      Height: 3,
      BitsPerComponent: 8,
      ColorSpace: 'DeviceGray'
    })
  );
  const grayRef = context.register(
    context.flateStream(graySamples, {
      Type: 'XObject',
      Subtype: 'Image',
      Width: 4,
      Height: 3,
      BitsPerComponent: 8,
      ColorSpace: 'DeviceGray',
      SMask: maskRef
    })
  );

  const truncatedRef = context.register(
    context.flateStream(new Uint8Array(8), {
      Type: 'XObject',
      Subtype: 'Image',
      Width: 100,
      Height: 100,
      BitsPerComponent: 8,
      ColorSpace: 'DeviceGray'
    })
  );

  const xobjects = context.obj({
    ImIndexed: indexedRef,
    ImGray: grayRef,
    ImTruncated: truncatedRef
  });
  page.node.set(PDFName.of('Resources'), context.obj({ XObject: xobjects }));
  return { bytes: await doc.save(), indexed: indexedSamples };
}

/** One image object drawn on three pages. */
async function sharedImagePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const jpg = await doc.embedJpg(fixture('tiny.jpg'));
  for (let i = 0; i < 3; i++) {
    const page = doc.addPage([200, 200]);
    page.drawImage(jpg, { x: 10, y: 10, width: 40, height: 120 });
  }
  return doc.save();
}

describe('CNV-06: extracting embedded images', () => {
  it('writes a DCTDecode image out byte-for-byte, with no decode step at all', async () => {
    const bytes = await jpegAndRasterPdf();
    const result = await processWorkerImpl.extractImages(bytes);
    const files = unzipSync(result.bytes);

    const jpegName = Object.keys(files).find(name => name.endsWith('.jpg'));
    expect(jpegName).toBeDefined();
    const written = files[jpegName as string];

    // Against the PDF's own stream …
    const streams = await imageStreams(bytes);
    const dct = streams.find(
      s => (s.dict.get(PDFName.of('Filter')) as PDFName | undefined)?.asString() === '/DCTDecode'
    );
    expect(dct).toBeDefined();
    expect(written).toEqual(rawContents(dct as PDFStream));

    // … and against the original file on disk, which pdf-lib embedded verbatim:
    // the round trip PDF → extraction is the identity on these bytes.
    expect(written).toEqual(fixture('tiny.jpg'));
  });

  it('re-frames a Flate raster into PNG with the samples unchanged', async () => {
    const bytes = await jpegAndRasterPdf();
    const result = await processWorkerImpl.extractImages(bytes);
    const files = unzipSync(result.bytes);

    const pngName = Object.keys(files).find(name => name.endsWith('.png'));
    expect(pngName).toBeDefined();
    const png = readPng(files[pngName as string]);

    const streams = await imageStreams(bytes);
    const flate = streams.find(
      s => (s.dict.get(PDFName.of('Filter')) as PDFName | undefined)?.asString() === '/FlateDecode'
    );
    expect(flate).toBeDefined();
    const source = flate as PDFStream;

    expect(png.width).toBe((source.dict.get(PDFName.of('Width')) as PDFNumber).asNumber());
    expect(png.height).toBe((source.dict.get(PDFName.of('Height')) as PDFNumber).asNumber());
    expect(png.bitDepth).toBe(8);
    expect(png.colorType).toBe(2); // DeviceRGB → truecolour
    // The whole criterion, at sample level: not "close", identical.
    expect(png.samples).toEqual(decodedSamples(source));
  });

  it('yields one file per image on a page with N images', async () => {
    const bytes = await jpegAndRasterPdf();
    const result = await processWorkerImpl.extractImages(bytes);
    const files = unzipSync(result.bytes);

    expect((await imageStreams(bytes)).length).toBe(2);
    expect(Object.keys(files).sort()).toEqual(['page-001-image-01.jpg', 'page-001-image-02.png']);
    expect(result.entries.filter(entry => entry.status === 'extracted')).toHaveLength(2);
    expect(result.entries.map(entry => entry.pageIndex)).toEqual([0, 0]);
    expect(result.entries.map(entry => entry.position)).toEqual([1, 2]);
  });

  it('preserves an Indexed image as a palette PNG, palette and bit depth intact', async () => {
    const { bytes, indexed } = await handBuiltRastersPdf();
    const result = await processWorkerImpl.extractImages(bytes);
    const files = unzipSync(result.bytes);

    const entry = result.entries.find(e => e.name === 'ImIndexed');
    expect(entry?.status).toBe('extracted');
    const png = readPng(files[entry?.fileName as string]);

    expect(png.colorType).toBe(3);
    expect(png.bitDepth).toBe(4); // not widened to 8
    expect(png.width).toBe(4);
    expect(png.height).toBe(4);
    expect(png.palette).toEqual(new Uint8Array([0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]));
    expect(png.samples).toEqual(indexed);
  });

  it('writes an SMask beside the image it belongs to, rather than baking it in', async () => {
    const { bytes } = await handBuiltRastersPdf();
    const result = await processWorkerImpl.extractImages(bytes);
    const files = unzipSync(result.bytes);

    const entry = result.entries.find(e => e.name === 'ImGray');
    expect(entry?.status).toBe('extracted');
    expect(entry?.maskFileName).toBeDefined();
    expect(entry?.note).toContain('separate PDF object');

    const base = readPng(files[entry?.fileName as string]);
    const mask = readPng(files[entry?.maskFileName as string]);
    expect(base.colorType).toBe(0);
    expect(base.samples).toEqual(
      new Uint8Array([0, 40, 80, 120, 160, 200, 240, 255, 10, 20, 30, 40])
    );
    expect(mask.samples).toEqual(
      new Uint8Array([255, 128, 64, 0, 255, 128, 64, 0, 255, 128, 64, 0])
    );
  });

  it('refuses a truncated raster instead of writing a short file', async () => {
    const { bytes } = await handBuiltRastersPdf();
    const result = await processWorkerImpl.extractImages(bytes);
    const files = unzipSync(result.bytes);

    const entry = result.entries.find(e => e.name === 'ImTruncated');
    expect(entry?.status).toBe('skipped');
    expect(entry?.note).toMatch(/truncated/i);
    expect(entry?.fileName).toBeUndefined();
    expect(Object.keys(files).some(name => name.includes('image-03'))).toBe(false);
  });

  it('extracts a reused image object once and reports the reuse', async () => {
    const bytes = await sharedImagePdf();
    const result = await processWorkerImpl.extractImages(bytes);
    const files = unzipSync(result.bytes);

    expect(Object.keys(files)).toEqual(['page-001-image-01.jpg']);
    expect(result.entries.map(e => e.status)).toEqual(['extracted', 'duplicate', 'duplicate']);
    expect(result.entries[1].fileName).toBe('page-001-image-01.jpg');
    expect(result.entries[2].note).toContain('already extracted');
    expect(files['page-001-image-01.jpg']).toEqual(fixture('tiny.jpg'));
  });

  it('extracts only the requested pages', async () => {
    const bytes = await sharedImagePdf();
    const result = await processWorkerImpl.extractImages(bytes, [2]);
    expect(result.entries.map(e => e.pageIndex)).toEqual([2]);
    expect(Object.keys(unzipSync(result.bytes))).toEqual(['page-003-image-01.jpg']);
  });

  it('leaves a CMYK raster in the document and says why, rather than converting it', async () => {
    // `cmyk.pdf` is a RunLength-encoded raw raster in an *indirect* ICCBased
    // 4-component space — not a JPEG — so there is no CMYK image file to hand
    // over. Converting it to RGB would be the re-encode this ticket exists to
    // avoid, and would flatten the very colour the fixture is about.
    const bytes = fixture('cmyk.pdf');
    const result = await processWorkerImpl.extractImages(bytes);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].status).toBe('skipped');
    expect(result.entries[0].note).toMatch(/CMYK/);
    expect(result.entries[0].fileName).toBeUndefined();
    expect(Object.keys(unzipSync(result.bytes))).toEqual([]);
  });

  it('hands a CMYK JPEG over byte-for-byte, Adobe marker and all', async () => {
    // Built here rather than taken from the corpus: `cmyk.pdf` is a raw raster,
    // and this is the case where a CMYK image *does* have a native file form.
    const source = fixture('tiny.jpg');
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);
    const context = doc.context;
    const ref = context.register(
      context.stream(source, {
        Type: 'XObject',
        Subtype: 'Image',
        Width: 10,
        Height: 210,
        BitsPerComponent: 8,
        ColorSpace: 'DeviceCMYK',
        Filter: 'DCTDecode'
      })
    );
    page.node.set(PDFName.of('Resources'), context.obj({ XObject: context.obj({ Im0: ref }) }));
    const bytes = await doc.save();

    const result = await processWorkerImpl.extractImages(bytes);
    const files = unzipSync(result.bytes);
    const entry = result.entries[0];

    expect(entry.status).toBe('extracted');
    expect(entry.fileName).toBe('page-001-image-01.jpg');
    // The colour space is never consulted on this path, because nothing decodes:
    // the bytes the document carries are the bytes written out.
    expect(files[entry.fileName as string]).toEqual(source);
    expect(files[entry.fileName as string]).toEqual(rawContents((await imageStreams(bytes))[0]));
  });

  it('writes a JPXDecode image as .jp2 without decoding it, and refuses JBIG2', async () => {
    const jpx = await processWorkerImpl.extractImages(fixture('jpx.pdf'));
    const jbig2 = await processWorkerImpl.extractImages(fixture('jbig2.pdf'));

    // The jpx fixture's stream is deliberately zero-length (see the corpus
    // README), so this asserts the routing and the byte-for-byte handover, not
    // a JPEG 2000 decode — which is the point: extraction never decodes it.
    expect(jpx.entries[0].status).toBe('extracted');
    expect(jpx.entries[0].fileName?.endsWith('.jp2')).toBe(true);
    expect(unzipSync(jpx.bytes)[jpx.entries[0].fileName as string]).toEqual(
      rawContents((await imageStreams(fixture('jpx.pdf')))[0])
    );

    expect(jbig2.entries[0].status).toBe('skipped');
    expect(jbig2.entries[0].note).toContain('JBIG2');
    expect(Object.keys(unzipSync(jbig2.bytes))).toEqual([]);
  });

  it('unwraps transport filters around a JPEG instead of skipping the chain', async () => {
    // `[/ASCIIHexDecode /DCTDecode]` — a JPEG inside a transport wrapper, which
    // several producers emit. The wrapper is stripped with pdf-lib's own
    // decoders; the codec payload itself is still never decoded.
    const source = fixture('tiny.jpg');
    const hex = [...source].map(b => b.toString(16).padStart(2, '0')).join('') + '>';
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);
    const context = doc.context;
    const ref = context.register(
      context.stream(new TextEncoder().encode(hex), {
        Type: 'XObject',
        Subtype: 'Image',
        Width: 10,
        Height: 210,
        BitsPerComponent: 8,
        ColorSpace: 'DeviceGray',
        Filter: ['ASCIIHexDecode', 'DCTDecode']
      })
    );
    page.node.set(PDFName.of('Resources'), context.obj({ XObject: context.obj({ Im0: ref }) }));

    const result = await processWorkerImpl.extractImages(await doc.save());
    const files = unzipSync(result.bytes);
    expect(result.entries[0].status).toBe('extracted');
    expect(files['page-001-image-01.jpg']).toEqual(source);
  });

  it('refuses an encrypted document with an explanation, extracting nothing', async () => {
    await expect(processWorkerImpl.extractImages(fixture('encrypted.pdf'))).rejects.toThrow(
      /encrypted/i
    );
  });

  it('reports determinate progress and cancels between pages', async () => {
    const bytes = await sharedImagePdf();
    const progress: number[] = [];
    let cancelled = false;
    const job = {
      progress(fraction: number | null) {
        if (fraction !== null) progress.push(fraction);
      },
      cancelled() {
        return cancelled;
      }
    };

    await processWorkerImpl.extractImages(bytes, undefined, job);
    expect(progress.length).toBeGreaterThanOrEqual(3);
    expect(progress.every((value, i) => i === 0 || value >= progress[i - 1])).toBe(true);

    cancelled = true;
    await expect(processWorkerImpl.extractImages(bytes, undefined, job)).rejects.toThrow(/cancel/i);
  });
});

describe('CNV-06: the PNG writer', () => {
  it('round-trips samples at every bit depth it accepts', () => {
    for (const bitDepth of [1, 2, 4, 8, 16] as const) {
      const width = 8;
      const height = 2;
      const rowBytes = Math.ceil((width * bitDepth) / 8);
      const samples = new Uint8Array(rowBytes * height).map((_, i) => (i * 37) % 256);
      const png = readPng(encodePng({ width, height, bitDepth, colorType: 0, samples }));
      expect(png.bitDepth).toBe(bitDepth);
      expect(png.samples).toEqual(samples);
    }
  });

  it('throws rather than emitting a short file', () => {
    expect(() =>
      encodePng({ width: 10, height: 10, bitDepth: 8, colorType: 0, samples: new Uint8Array(9) })
    ).toThrow(/truncated/i);
  });
});
