/**
 * Audit 2026-10-01 — IMG-8 (a JPEG's pixel limit is checked from its SOF
 * marker, before decoding) and IMG-9 (an animated GIF imported through Images
 * to PDF says that only its first frame was used), on hand-built real bytes.
 *
 * The image worker's `resizeImage` runs for real here: Comlink is stubbed only
 * to capture the API object it exposes, and `createImageBitmap` (absent in
 * Node) is a spy, so "refused before decoding" is observed as "the decoder was
 * never called".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const exposed = vi.hoisted(() => ({ api: null as unknown }));

vi.mock('comlink', async importOriginal => ({
  ...(await importOriginal<typeof import('comlink')>()),
  expose: (api: unknown) => {
    exposed.api = api;
  },
  transfer: <T>(value: T) => value
}));

// `imagesToPdfBytes` composes through the process worker; only the warning
// plumbing around it is under test, so the composition is a stub.
vi.mock('../../src/core/workers', () => {
  const processApi = { imagesToPdf: async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]) };
  const lease = (fn: (api: typeof processApi) => Promise<unknown>) => fn(processApi);
  return {
    processWorker: { lease },
    renderWorker: { lease, pin: () => ({ lease, release: () => {} }) },
    cvWorker: { lease },
    imageWorker: { lease, terminate: () => {} }
  };
});

// Image decoding needs a browser (`createImageBitmap`); the frame count it is
// paired with does not, and stays real.
vi.mock('../../src/core/image', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/core/image')>()),
  imageFileToPdfImages: async (file: File) => [new Uint8Array(await file.arrayBuffer())]
}));

const { declaredImageSize, GifFrameCounter, MAX_RASTER_PIXELS } =
  await import('../../src/core/raster-decode');
const { readJpegInfo, gifFrameCountOf } = await import('../../src/core/image');
const { imagesToPdfBytes } = await import('../../src/core/import');
await import('../../src/core/workers/image.worker');
const worker = exposed.api as import('../../src/core/workers/image.worker').ImageJob;

/* ------------------------------------------------------------------ *
 * Byte builders
 * ------------------------------------------------------------------ */

const segment = (marker: number, body: number[]) => {
  const length = body.length + 2;
  return [0xff, marker, length >> 8, length & 0xff, ...body];
};

/**
 * A minimal JPEG: SOI, JFIF APP0, a frame header declaring `width`×`height`
 * with three components, a scan header, two bytes of entropy data, EOI. Under
 * 60 bytes whatever size it claims.
 */
function jpeg(width: number, height: number, sof = 0xc0): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8,
    ...segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...segment(sof, [
      8,
      height >> 8,
      height & 0xff,
      width >> 8,
      width & 0xff,
      3,
      ...[1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]
    ]),
    ...segment(0xda, [3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0]),
    0x00,
    0x00,
    0xff,
    0xd9
  ]);
}

/** A minimal GIF89a: 1×1, two-colour global table, `frames` image blocks with real LZW data. */
function gif(frames: number): Uint8Array {
  const parts: number[] = [
    ...Array.from('GIF89a', c => c.charCodeAt(0)),
    1,
    0,
    1,
    0,
    0x80,
    0,
    0,
    0,
    0,
    0,
    255,
    255,
    255
  ];
  for (let i = 0; i < frames; i++) {
    parts.push(0x21, 0xf9, 4, 0, 10, 0, 0, 0); // graphic control extension
    parts.push(0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0); // image descriptor
    parts.push(2, 2, 0x44, 0x01, 0); // LZW: clear, index 0, end
  }
  parts.push(0x3b);
  return new Uint8Array(parts);
}

const request = { targetBytes: null, maxDimension: 1000 };

afterEach(() => {
  vi.unstubAllGlobals();
});

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
}

/* ------------------------------------------------------------------ */

describe('IMG-8 — a JPEG is refused from its SOF marker, before decoding', () => {
  it('reads the declared size of every SOFn, and of a real JPEG', () => {
    for (const sof of [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xcf]) {
      expect(declaredImageSize(jpeg(20_000, 30_000, sof))).toEqual({
        width: 20_000,
        height: 30_000
      });
    }
    const tiny = new Uint8Array(readFileSync('tests/fixtures/tiny.jpg'));
    const info = readJpegInfo(tiny)!;
    expect(declaredImageSize(tiny)).toEqual({ width: info.width, height: info.height });
  });

  it('skips DHT/JPG/DAC rather than read them as a frame header', () => {
    // A DHT segment carrying bytes that would read as 20000×20000 comes first.
    const dht = segment(0xc4, [8, 0x4e, 0x20, 0x4e, 0x20, 3, 0, 0, 0]);
    const real = jpeg(64, 48);
    const bytes = new Uint8Array([0xff, 0xd8, ...dht, ...real.subarray(2)]);
    expect(declaredImageSize(bytes)).toEqual({ width: 64, height: 48 });
  });

  it('returns null, never throws, for truncated or garbage headers', () => {
    const big = jpeg(20_000, 20_000);
    const sofAt = 2 + 18; // SOI + APP0
    for (let cut = 0; cut <= sofAt + 8; cut++) {
      expect(() => declaredImageSize(big.subarray(0, cut))).not.toThrow();
    }
    expect(declaredImageSize(big.subarray(0, sofAt + 6))).toBeNull(); // mid-SOF
    expect(declaredImageSize(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull();
    expect(declaredImageSize(new Uint8Array([0xff, 0xd8, 0xff, 0x12, 0x34, 0x56]))).toBeNull();
    // A segment length running past the end of the file.
    expect(declaredImageSize(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff, 0]))).toBeNull();
    // Scan before any frame header.
    expect(declaredImageSize(new Uint8Array([0xff, 0xd8, ...segment(0xda, [0])]))).toBeNull();
    // Height deferred to a DNL marker: unknown, so left to the decoded check.
    expect(declaredImageSize(jpeg(20_000, 0))).toBeNull();
    for (let seed = 1; seed <= 200; seed++) {
      const junk = new Uint8Array(64).map((_, i) => (seed * 131 + i * 197) & 0xff);
      junk[0] = 0xff;
      junk[1] = 0xd8;
      junk[2] = 0xff;
      expect(() => declaredImageSize(junk)).not.toThrow();
    }
  });

  it('Image to size refuses a 20000×20000 JPEG with its dimensions, without decoding it', async () => {
    const decode = vi.fn();
    vi.stubGlobal('createImageBitmap', decode);
    const bytes = jpeg(20_000, 20_000);
    expect(bytes.length).toBeLessThan(64);
    expect(20_000 * 20_000).toBeGreaterThan(MAX_RASTER_PIXELS);
    const err = await caught(worker.resizeImage('bitmap', bytes, request, 'huge.jpg'));
    expect(err).toMatchObject({ kind: 'UnsupportedFeature' });
    expect(String((err as Error).message)).toContain('huge.jpg is 20000×20000 pixels');
    expect(decode).not.toHaveBeenCalled();
  });

  it('a JPEG with no readable SOF falls back to the post-decode check', async () => {
    const close = vi.fn();
    const decode = vi.fn(async () => ({ width: 20_000, height: 20_000, close }));
    vi.stubGlobal('createImageBitmap', decode);
    const err = await caught(worker.resizeImage('bitmap', jpeg(20_000, 0), request, 'dnl.jpg'));
    expect(decode).toHaveBeenCalledTimes(1);
    expect(err).toMatchObject({ kind: 'UnsupportedFeature' });
    expect(String((err as Error).message)).toContain('20000×20000');
    expect(close).toHaveBeenCalled();
  });

  it('a truncated JPEG still gets the existing decode error, not a parser exception', async () => {
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => {
        throw new Error('The source image could not be decoded.');
      })
    );
    const err = await caught(
      worker.resizeImage('bitmap', jpeg(20_000, 20_000).subarray(0, 25), request, 'cut.jpg')
    );
    expect(err).toMatchObject({ kind: 'CorruptDocument' });
    expect(String((err as Error).message)).toContain('cut.jpg could not be decoded');
  });
});

describe('IMG-9 — Images to PDF says when a GIF lost its animation', () => {
  const file = (bytes: Uint8Array, name: string, type: string) =>
    new File([bytes as BlobPart], name, { type });

  it('counts the same frames whether the file arrives whole or in chunks', () => {
    for (const frames of [1, 2, 3]) {
      const bytes = gif(frames);
      for (const size of [1, 2, 5, 64]) {
        const counter = new GifFrameCounter();
        for (let i = 0; i < bytes.length; i += size) counter.push(bytes.subarray(i, i + size));
        expect(counter.finish()).toBe(frames);
      }
    }
  });

  it('counts frames by signature, not by name', async () => {
    expect(await gifFrameCountOf(file(gif(3), 'anim.gif', 'image/gif'))).toBe(3);
    expect(await gifFrameCountOf(file(gif(1), 'still.gif', 'image/gif'))).toBe(1);
    expect(await gifFrameCountOf(file(gif(3), 'renamed.png', 'image/png'))).toBe(3);
    expect(await gifFrameCountOf(file(jpeg(4, 4), 'photo.gif', 'image/gif'))).toBe(0);
  });

  it('notes each animated GIF by name, and nothing for a still one', async () => {
    const { warnings } = await imagesToPdfBytes(
      [
        file(gif(3), 'spinner.gif', 'image/gif'),
        file(gif(1), 'still.gif', 'image/gif'),
        file(jpeg(4, 4), 'photo.jpg', 'image/jpeg'),
        file(gif(2), 'blink.gif', 'image/gif')
      ],
      {}
    );
    expect(warnings).toEqual([
      'spinner.gif: This GIF is animated (3 frames); only the first frame was used.',
      'blink.gif: This GIF is animated (2 frames); only the first frame was used.'
    ]);
  });
});
