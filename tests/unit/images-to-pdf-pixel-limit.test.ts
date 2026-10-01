/**
 * AUDIT-2026-10-01 — Images to PDF decodes JPEG/PNG/WebP/GIF on the main thread
 * (`imageFileToPdfImages`). It now applies the same pixel limit as the image
 * worker (IMG-8): from the header before decoding, and on the decoded bitmap
 * when the header could not be read.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const { imageFileToPdfImages } = await import('../../src/core/image');

afterEach(() => vi.unstubAllGlobals());

const segment = (marker: number, body: number[]) => {
  const length = body.length + 2;
  return [0xff, marker, length >> 8, length & 0xff, ...body];
};

/** A minimal JPEG whose frame header declares `width`×`height`. */
function jpeg(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8,
    ...segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...segment(0xc0, [
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

const file = (bytes: Uint8Array, name: string) =>
  new File([bytes as BlobPart], name, { type: 'image/jpeg' });

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
}

describe('Images to PDF — pixel limit on the main-thread decode path', () => {
  it('refuses a 20000×20000 JPEG from its header, without decoding it', async () => {
    const decode = vi.fn();
    vi.stubGlobal('createImageBitmap', decode);
    const err = await caught(imageFileToPdfImages(file(jpeg(20_000, 20_000), 'huge.jpg'), 0.9));
    expect(err).toMatchObject({ kind: 'UnsupportedFeature' });
    expect(String((err as Error).message)).toContain('huge.jpg is 20000×20000 pixels');
    expect(decode).not.toHaveBeenCalled();
  });

  it('checks the decoded bitmap when the header gives no size, and closes it', async () => {
    const close = vi.fn();
    const decode = vi.fn(async () => ({ width: 20_000, height: 20_000, close }));
    vi.stubGlobal('createImageBitmap', decode);
    const err = await caught(imageFileToPdfImages(file(jpeg(20_000, 0), 'dnl.jpg'), 0.9));
    expect(decode).toHaveBeenCalledTimes(1);
    expect(err).toMatchObject({ kind: 'UnsupportedFeature' });
    expect(String((err as Error).message)).toContain('20000×20000');
    expect(close).toHaveBeenCalled();
  });
});
