/**
 * CONV-1 — HEIC import can never hang and really stops on cancel; CONV-10 —
 * "100% (Lossless)" is lossless.
 *
 * CONV-1: HEIC (and TIFF, CONV-16) now decode in the image worker
 * (`workers/image.worker.ts`; the decoders themselves are tested against the
 * real fixtures in `raster-decode.test.ts`). The worker client is mocked here to
 * reproduce a decode that never returns: the import must fail with a clear
 * message on timeout, reject promptly on abort, and in both cases *terminate*
 * the worker — a WASM call cannot be interrupted, so terminating is the only
 * way the decode actually stops.
 *
 * CONV-10: at quality 1 an upright JPEG's own bytes go to `embedJpg` untouched,
 * and the worker embeds PNG input as PNG (Flate) rather than as a DCT JPEG.
 *
 * Regression review (R-CONV-1/2/3): a *rotated* JPEG is passed through too,
 * with its EXIF orientation applied by the placement matrix instead of by
 * re-encoding; an embedded ICC profile travels into the PDF as `/ICCBased`;
 * lossless/arithmetic JPEGs are decoded rather than passed through; and
 * concurrent HEIC/TIFF decodes queue, so cancelling or timing out one never
 * kills another and a timeout only runs while its own decode does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  decodePDFRawStream,
  PDFArray,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFStream
} from 'pdf-lib';

const worker = vi.hoisted(() => ({
  impl: (() => new Promise(() => {})) as (...args: unknown[]) => Promise<Uint8Array[]>,
  calls: [] as unknown[][],
  terminated: 0
}));
vi.mock('../../src/core/workers', () => ({
  imageWorker: {
    lease: (fn: (api: unknown) => Promise<unknown>) =>
      fn({
        decodeToPdfImages: (...args: unknown[]) => {
          worker.calls.push(args);
          return worker.impl(...args);
        }
      }),
    terminate: () => {
      worker.terminated += 1;
    }
  }
}));
vi.mock('comlink', () => ({
  expose: () => {},
  transfer: <T>(value: T) => value,
  proxy: <T>(value: T) => value,
  wrap: () => ({})
}));

import {
  canEmbedJpegAsIs,
  decodeRasterInWorker,
  heicTimeoutMs,
  imageFileToPdfImages,
  jpegPassthrough,
  rasterKindOf,
  readJpegInfo
} from '../../src/core/image';
import { orientationMatrix } from '../../src/core/image-embed';
import {
  hasTransparency,
  preferJpegAtMaximum,
  PHOTO_MIN_BITS_PER_PIXEL,
  webpTraits
} from '../../src/core/max-quality';

const TINY_JPG = new Uint8Array(readFileSync('tests/fixtures/tiny.jpg'));
const heicFile = () =>
  new File([readFileSync('tests/fixtures/sample.heic')], 'sample.heic', { type: 'image/heic' });

/** tiny.jpg with an APP1/Exif segment stating `orientation`, inserted after SOI. */
function withOrientation(jpeg: Uint8Array, orientation: number): Uint8Array {
  const tiff = [
    0x4d,
    0x4d,
    0x00,
    0x2a,
    0x00,
    0x00,
    0x00,
    0x08, // big-endian header, IFD0 at 8
    0x00,
    0x01, // one entry
    0x01,
    0x12,
    0x00,
    0x03,
    0x00,
    0x00,
    0x00,
    0x01,
    0x00,
    orientation,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00 // no next IFD
  ];
  const body = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff];
  const length = body.length + 2;
  const app1 = [0xff, 0xe1, length >> 8, length & 0xff, ...body];
  return new Uint8Array([...jpeg.subarray(0, 2), ...app1, ...jpeg.subarray(2)]);
}

beforeEach(() => {
  worker.calls = [];
  worker.terminated = 0;
  worker.impl = () => new Promise(() => {});
});
afterEach(() => vi.useRealTimers());

describe('HEIC/TIFF decode in the image worker (CONV-1, CONV-16)', () => {
  it('routes HEIC and TIFF to the worker, everything else to the browser', () => {
    expect(rasterKindOf(heicFile())).toBe('heic');
    expect(rasterKindOf(new File([], 'scan.TIF'))).toBe('tiff');
    expect(rasterKindOf(new File([], 'x', { type: 'image/tiff' }))).toBe('tiff');
    expect(rasterKindOf(new File([], 'IMG_1.HEIC'))).toBe('heic');
    expect(rasterKindOf(new File([], 'a.png', { type: 'image/png' }))).toBeNull();
  });

  it('times out a never-returning decode with a clear message and terminates the worker', async () => {
    await expect(
      decodeRasterInWorker(heicFile(), 'heic', 0.9, { timeoutMs: 50 })
    ).rejects.toMatchObject({
      kind: 'UnsupportedFeature',
      message: expect.stringMatching(/did not finish within .* so it was stopped/)
    });
    expect(worker.terminated).toBe(1);
  });

  it('rejects as a cancellation as soon as the signal aborts, and terminates the worker', async () => {
    const controller = new AbortController();
    const pending = decodeRasterInWorker(heicFile(), 'heic', 0.9, {
      signal: controller.signal,
      timeoutMs: 60_000
    });
    setTimeout(() => controller.abort(), 20);
    const t = performance.now();
    await expect(pending).rejects.toMatchObject({ kind: 'UserCancelled' });
    expect(performance.now() - t).toBeLessThan(1000);
    expect(worker.terminated).toBe(1);
  });

  it('never starts the worker for an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(imageFileToPdfImages(heicFile(), 0.9, controller.signal)).rejects.toMatchObject({
      kind: 'UserCancelled'
    });
    expect(worker.calls).toHaveLength(0);
  });

  it('wraps an unexpected worker failure in a decode message, without terminating', async () => {
    worker.impl = () => Promise.reject(new Error('boom'));
    await expect(imageFileToPdfImages(heicFile(), 0.9)).rejects.toThrow(
      /Failed to decode HEIC file sample\.heic: boom/
    );
    expect(worker.terminated).toBe(0);
  });

  it("passes the worker's own refusal through unchanged", async () => {
    const err = Object.assign(new Error('x.heic contains no readable image'), {
      name: 'StaplerError(CorruptDocument)'
    });
    worker.impl = () => Promise.reject(err);
    await expect(imageFileToPdfImages(heicFile(), 0.9)).rejects.toMatchObject({
      kind: 'CorruptDocument',
      message: 'x.heic contains no readable image'
    });
  });

  it('hands the file bytes, quality and name to the worker and returns its output', async () => {
    const out = [new Uint8Array([1, 2, 3])];
    worker.impl = () => Promise.resolve(out);
    const tiff = new File([readFileSync('tests/fixtures/sample.tiff')], 'sample.tiff');
    expect(await imageFileToPdfImages(tiff, 1)).toBe(out);
    const [kind, bytes, quality, name] = worker.calls[0] as [string, Uint8Array, number, string];
    expect([kind, quality, name]).toEqual(['tiff', 1, 'sample.tiff']);
    expect(bytes).toEqual(new Uint8Array(readFileSync('tests/fixtures/sample.tiff')));
  });

  it('scales the timeout with file size, within bounds', () => {
    expect(heicTimeoutMs(0)).toBe(20_000);
    expect(heicTimeoutMs(5 * 1024 * 1024)).toBe(30_000);
    expect(heicTimeoutMs(10 ** 9)).toBe(120_000);
  });
});

describe('lossless image import (CONV-10)', () => {
  it('reads JPEG frame info and EXIF orientation from the markers', () => {
    const info = readJpegInfo(TINY_JPG);
    expect(info).toMatchObject({ precision: 8, orientation: 1 });
    expect(info!.width).toBeGreaterThan(0);
    expect(readJpegInfo(withOrientation(TINY_JPG, 6))?.orientation).toBe(6);
    expect(readJpegInfo(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
  });

  it('passes an upright JPEG through byte for byte at quality 1', async () => {
    expect(canEmbedJpegAsIs(TINY_JPG)).toBe(true);
    const file = new File([TINY_JPG], 'photo.jpg', { type: 'image/jpeg' });
    const [out] = await imageFileToPdfImages(file, 1);
    expect(out).toEqual(TINY_JPG);
  });

  it('canEmbedJpegAsIs is only for upright JPEGs; a rotated one passes through with its orientation', async () => {
    expect(canEmbedJpegAsIs(withOrientation(TINY_JPG, 6))).toBe(false);
    expect(canEmbedJpegAsIs(withOrientation(TINY_JPG, 1))).toBe(true);
    const rotated = withOrientation(TINY_JPG, 6);
    expect(jpegPassthrough(rotated)).toEqual({ orientation: 6 });
    const file = new File([rotated], 'phone.jpg', { type: 'image/jpeg' });
    const [out] = await imageFileToPdfImages(file, 1);
    // The original bytes, not a re-encode (R-CONV-1): no size growth at all.
    expect(out).toEqual({ bytes: rotated, orientation: 6 });
  });

  it('the worker embeds PNG input losslessly (FlateDecode, not DCTDecode)', async () => {
    const { processWorkerImpl } = await import('../../src/core/workers/process.worker');
    const png = new Uint8Array(readFileSync('tests/fixtures/sample.png'));
    const bytes = await processWorkerImpl.imagesToPdf([png, TINY_JPG]);
    const doc = await PDFDocument.load(bytes);
    const filters: string[] = [];
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      if (
        obj instanceof PDFRawStream &&
        obj.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')
      ) {
        const filter = obj.dict.get(PDFName.of('Filter'));
        if (filter) filters.push(String(filter));
      }
    }
    expect(filters).toContain('/FlateDecode');
    expect(filters).toContain('/DCTDecode');
    expect(doc.getPageCount()).toBe(2);
  });
});

/** tiny.jpg with its SOF0 marker changed to `marker` (e.g. 0xC3 lossless, 0xC9 arithmetic). */
function withFrameMarker(jpeg: Uint8Array, marker: number): Uint8Array {
  const out = jpeg.slice();
  for (let i = 2; i + 1 < out.length;) {
    if (out[i + 1] === 0xc0) {
      out[i + 1] = marker;
      return out;
    }
    i += 2 + ((out[i + 2] << 8) | out[i + 3]);
  }
  throw new Error('no SOF0');
}

/** A structurally valid ICC profile header (no tags) for data colour space `space`. */
function iccProfile(space: 'GRAY' | 'RGB '): Uint8Array {
  const p = new Uint8Array(132);
  p[3] = 132; // size, big-endian
  for (let i = 0; i < 4; i++) {
    p[16 + i] = space.charCodeAt(i);
    p[36 + i] = 'acsp'.charCodeAt(i);
  }
  return p;
}

/** Inserts `profile` as APP2 ICC_PROFILE chunks of at most `chunk` bytes, after SOI. */
function withIcc(jpeg: Uint8Array, profile: Uint8Array, chunk = 1000, count?: number): Uint8Array {
  const parts: number[] = [];
  const total = count ?? Math.ceil(profile.length / chunk);
  for (let seq = 1, at = 0; at < profile.length; seq++, at += chunk) {
    const data = profile.subarray(at, at + chunk);
    const body = [...'ICC_PROFILE'].map(c => c.charCodeAt(0));
    body.push(0, seq, total, ...data);
    const length = body.length + 2;
    parts.push(0xff, 0xe2, length >> 8, length & 0xff, ...body);
  }
  return new Uint8Array([...jpeg.subarray(0, 2), ...parts, ...jpeg.subarray(2)]);
}

async function imageXObjects(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes);
  const images: PDFRawStream[] = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (
      obj instanceof PDFRawStream &&
      obj.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')
    ) {
      images.push(obj);
    }
  }
  return { doc, images };
}

describe('JPEG passthrough at Maximum (R-CONV-1, R-CONV-2)', () => {
  it('refuses lossless, hierarchical and arithmetic-coded frames, accepts baseline/progressive', () => {
    expect(jpegPassthrough(withFrameMarker(TINY_JPG, 0xc2))).toEqual({ orientation: 1 });
    for (const marker of [0xc3, 0xc5, 0xc9, 0xca, 0xcb, 0xcd]) {
      expect(jpegPassthrough(withFrameMarker(TINY_JPG, marker)), marker.toString(16)).toBeNull();
    }
    expect(readJpegInfo(withFrameMarker(TINY_JPG, 0xc9))?.frameMarker).toBe(0xc9);
  });

  it('reassembles a multi-chunk ICC profile, and refuses a broken or mismatched one', () => {
    const gray = iccProfile('GRAY');
    const chunked = withIcc(TINY_JPG, gray, 50); // three APP2 chunks
    expect(readJpegInfo(chunked)?.iccProfile).toEqual(gray);
    expect(jpegPassthrough(chunked)).toEqual({ orientation: 1 });
    // A chunk missing from a declared set of 4: not trusted, so decoded instead.
    expect(readJpegInfo(withIcc(TINY_JPG, gray, 50, 4))?.iccProfile).toBe('invalid');
    expect(jpegPassthrough(withIcc(TINY_JPG, gray, 50, 4))).toBeNull();
    // An RGB profile on a one-component frame cannot describe it.
    expect(jpegPassthrough(withIcc(TINY_JPG, iccProfile('RGB ')))).toBeNull();
  });

  it('embeds the original JPEG bytes with the ICC profile as /ICCBased', async () => {
    const { processWorkerImpl } = await import('../../src/core/workers/process.worker');
    const jpeg = withIcc(TINY_JPG, iccProfile('GRAY'));
    const { doc, images } = await imageXObjects(await processWorkerImpl.imagesToPdf([jpeg]));
    expect(images).toHaveLength(1);
    // Byte-identical passthrough: the DCT stream *is* the file.
    expect(images[0].getContents()).toEqual(jpeg);
    const colorSpace = images[0].dict.lookup(PDFName.of('ColorSpace'), PDFArray);
    expect(colorSpace.get(0)).toBe(PDFName.of('ICCBased'));
    const icc = colorSpace.lookup(1, PDFStream);
    expect(icc.dict.get(PDFName.of('N'))?.toString()).toBe('1');
    expect(doc.getPageCount()).toBe(1);
  });

  it('draws an EXIF-rotated JPEG upright by its placement matrix, on a page of the rotated size', async () => {
    const { processWorkerImpl } = await import('../../src/core/workers/process.worker');
    const info = readJpegInfo(TINY_JPG)!;
    const rotated = withOrientation(TINY_JPG, 6);
    const bytes = await processWorkerImpl.imagesToPdf([{ bytes: rotated, orientation: 6 }], {
      pageSize: 'original',
      orientation: 'auto',
      margin: 0,
      quality: 1
    });
    const { doc, images } = await imageXObjects(bytes);
    expect(images[0].getContents()).toEqual(rotated);
    const { width, height } = doc.getPage(0).getSize();
    expect([width, height]).toEqual([info.height, info.width]);
    const contents = doc.getPage(0).node.Contents();
    const streams =
      contents instanceof PDFArray
        ? contents.asArray().map(ref => doc.context.lookup(ref))
        : [contents];
    const content = streams
      .map(stream =>
        stream instanceof PDFRawStream
          ? new TextDecoder().decode(decodePDFRawStream(stream).decode())
          : ''
      )
      .join('\n');
    const [a, b, c, d, e, f] = orientationMatrix(6, { x: 0, y: 0, width, height });
    expect(content).toContain(`${a} ${b} ${c} ${d} ${e} ${f} cm`);
  });

  it('maps the unit square so every orientation shows stored row 0 where EXIF says', () => {
    // Where the stored image's top-left corner (u=0, v=1) lands, per orientation.
    const rect = { x: 0, y: 0, width: 10, height: 20 };
    const topLeft = (o: number) => {
      const [a, b, c, d, e, f] = orientationMatrix(o, rect);
      return [a * 0 + c * 1 + e, b * 0 + d * 1 + f];
    };
    expect(topLeft(1)).toEqual([0, 20]); // top-left
    expect(topLeft(2)).toEqual([10, 20]); // top-right (mirrored)
    expect(topLeft(3)).toEqual([10, 0]); // bottom-right (180°)
    expect(topLeft(4)).toEqual([0, 0]); // bottom-left (flipped)
    expect(topLeft(5)).toEqual([0, 20]); // transposed
    expect(topLeft(6)).toEqual([10, 20]); // 90° CW: top row goes to the right edge
    expect(topLeft(7)).toEqual([10, 0]); // transverse
    expect(topLeft(8)).toEqual([0, 0]); // 90° CCW: top row goes to the left edge
  });
});

describe('Maximum encoding rule for decoded photos (R-CONV-1)', () => {
  it('uses the 95% JPEG only for a photographic image, and only when it is smaller', () => {
    const pixels = 4032 * 3024;
    // A 12 MP photo: PNG ~23 MB (15 bpp), JPEG-95 far smaller → JPEG.
    expect(preferJpegAtMaximum(23_356_129, 5_000_000, pixels)).toBe(true);
    // Line art / text scan: PNG under the photographic threshold → PNG.
    const flat = Math.floor((pixels * (PHOTO_MIN_BITS_PER_PIXEL - 1)) / 8);
    expect(preferJpegAtMaximum(flat, flat / 2, pixels)).toBe(false);
    // Never a larger JPEG.
    expect(preferJpegAtMaximum(23_000_000, 24_000_000, pixels)).toBe(false);
  });

  it('reads WebP lossiness and alpha from the container', () => {
    expect(webpTraits(new Uint8Array(readFileSync('tests/fixtures/sample.webp')))).toEqual({
      lossless: false,
      alpha: false
    });
    const riff = (chunk: string, data: number[]) => {
      const body = [...'WEBP'].map(c => c.charCodeAt(0));
      body.push(...[...chunk].map(c => c.charCodeAt(0)), data.length, 0, 0, 0, ...data);
      if (data.length % 2) body.push(0);
      return new Uint8Array([
        ...[...'RIFF'].map(c => c.charCodeAt(0)),
        body.length,
        0,
        0,
        0,
        ...body
      ]);
    };
    // VP8L with alpha_is_used (bit 28 of the header after the 0x2f signature).
    expect(webpTraits(riff('VP8L', [0x2f, 0, 0, 0, 0x10]))).toEqual({
      lossless: true,
      alpha: true
    });
    expect(webpTraits(riff('VP8X', [0x10, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toMatchObject({
      alpha: true
    });
    expect(webpTraits(TINY_JPG)).toBeNull();
  });

  it('detects transparency in RGBA', () => {
    expect(hasTransparency(new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255]))).toBe(false);
    expect(hasTransparency(new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 254]))).toBe(true);
  });
});

describe('concurrent HEIC/TIFF decodes queue (R-CONV-3)', () => {
  // vitest resolves a mocked module for a dynamic import once per importer at
  // a time; two decodes whose `import('./workers')` overlap can see the real
  // module for the second. Each decode is therefore started after the one
  // before it has reached the worker queue — which is also the order a user
  // produces by dropping one file, then another.
  const settle = () => new Promise(resolve => setTimeout(resolve, 15));

  it('a queued decode is not timed out while it waits, and cancelling the first does not fail it', async () => {
    let calls = 0;
    worker.impl = () => {
      calls += 1;
      // The first decode never returns; the second succeeds immediately.
      return calls === 1 ? new Promise(() => {}) : Promise.resolve([new Uint8Array([9])]);
    };
    const first = new AbortController();
    const a = decodeRasterInWorker(heicFile(), 'heic', 0.9, {
      signal: first.signal,
      timeoutMs: 60_000
    });
    await settle();
    // 30 ms of budget — far less than it waits behind the first.
    const b = decodeRasterInWorker(heicFile(), 'heic', 0.9, { timeoutMs: 30 });
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(worker.calls).toHaveLength(1); // b has not started, and has not timed out
    first.abort();
    await expect(a).rejects.toMatchObject({ kind: 'UserCancelled' });
    expect(worker.terminated).toBe(1);
    await expect(b).resolves.toEqual([new Uint8Array([9])]);
    expect(worker.terminated).toBe(1); // nothing was stopped on b's behalf
  });

  it('cancelling a queued decode rejects at once and leaves the running one alone', async () => {
    let calls = 0;
    let finishFirst: (value: Uint8Array[]) => void = () => {};
    worker.impl = () => {
      calls += 1;
      return new Promise<Uint8Array[]>(resolve => {
        if (calls === 1) finishFirst = resolve;
        else resolve([new Uint8Array([2])]);
      });
    };
    const a = decodeRasterInWorker(heicFile(), 'heic', 0.9, { timeoutMs: 60_000 });
    await settle();
    const queued = new AbortController();
    const b = decodeRasterInWorker(heicFile(), 'heic', 0.9, {
      signal: queued.signal,
      timeoutMs: 60_000
    });
    await settle();
    const c = decodeRasterInWorker(heicFile(), 'heic', 0.9, { timeoutMs: 60_000 });
    await settle();
    queued.abort();
    await expect(b).rejects.toMatchObject({ kind: 'UserCancelled' });
    expect(worker.terminated).toBe(0);
    finishFirst([new Uint8Array([1])]);
    await expect(a).resolves.toEqual([new Uint8Array([1])]);
    await expect(c).resolves.toEqual([new Uint8Array([2])]);
    expect(worker.calls).toHaveLength(2); // b never reached the worker
  });
});
