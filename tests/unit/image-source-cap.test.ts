/**
 * AUDIT-2026-10-01 review — Image to size caps its quality search at the source
 * file's byte length only when the original could be kept as it is
 * (`imageOriginalSatisfies`). A file that must be converted — here a sideways
 * JPEG — gets no such cap: holding its JPEG under the source size would only
 * lower its quality for nothing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const exposed = vi.hoisted(() => ({ api: null as unknown }));
const requests = vi.hoisted(() => [] as { sourceBytes?: number }[]);

vi.mock('comlink', async importOriginal => ({
  ...(await importOriginal<typeof import('comlink')>()),
  expose: (api: unknown) => {
    exposed.api = api;
  },
  transfer: <T>(value: T) => value
}));

vi.mock('../../src/core/image-resize', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/core/image-resize')>()),
  resizeToTarget: async (
    source: { width: number; height: number },
    request: { sourceBytes?: number }
  ) => {
    requests.push(request);
    return {
      bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      width: source.width,
      height: source.height,
      sourceWidth: source.width,
      sourceHeight: source.height,
      quality: 0.9,
      reached: true,
      trials: []
    };
  }
}));

await import('../../src/core/workers/image.worker');
const worker = exposed.api as import('../../src/core/workers/image.worker').ImageJob;

afterEach(() => {
  vi.unstubAllGlobals();
  requests.length = 0;
});

/** Inserts an EXIF APP1 segment with Orientation = `orientation` right after SOI. */
function withOrientation(jpeg: Uint8Array, orientation: number): Uint8Array {
  const tiff = [
    0x49,
    0x49,
    0x2a,
    0x00,
    0x08,
    0x00,
    0x00,
    0x00, // little-endian header, IFD at 8
    0x01,
    0x00, // one entry
    0x12,
    0x01,
    0x03,
    0x00,
    0x01,
    0x00,
    0x00,
    0x00,
    orientation,
    0x00,
    0x00,
    0x00, // 0x0112 SHORT
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

const request = { targetBytes: 50_000_000, maxDimension: null };

function stubDecoder() {
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width: 10, height: 10, close: () => {} }))
  );
}

describe('Image to size — the source-size cap only applies to a keepable original', () => {
  it('caps an upright JPEG at its own size', async () => {
    stubDecoder();
    const upright = new Uint8Array(readFileSync('tests/fixtures/tiny.jpg'));
    await worker.resizeImage('bitmap', upright, request, 'upright.jpg');
    expect(requests).toHaveLength(1);
    expect(requests[0].sourceBytes).toBe(upright.byteLength);
  });

  it('does not cap a sideways JPEG, which has to be converted anyway', async () => {
    stubDecoder();
    const sideways = withOrientation(new Uint8Array(readFileSync('tests/fixtures/tiny.jpg')), 6);
    await worker.resizeImage('bitmap', sideways, request, 'sideways.jpg');
    expect(requests).toHaveLength(1);
    expect(requests[0].sourceBytes).toBeUndefined();
  });
});
