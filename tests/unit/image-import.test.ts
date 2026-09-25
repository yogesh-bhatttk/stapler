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
 * a rotated JPEG is not passed through, and the worker embeds PNG input as PNG
 * (Flate) rather than as a DCT JPEG.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';

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
  rasterKindOf,
  readJpegInfo
} from '../../src/core/image';

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

  it('does not pass through a JPEG whose EXIF rotation must be applied', () => {
    expect(canEmbedJpegAsIs(withOrientation(TINY_JPG, 6))).toBe(false);
    expect(canEmbedJpegAsIs(withOrientation(TINY_JPG, 1))).toBe(true);
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
