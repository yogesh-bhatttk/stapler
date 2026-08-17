/**
 * CMP-04/CMP-06 — what `rebuildCompressed` is allowed to claim.
 *
 * Two dishonest reports are possible on this path and both are asserted against
 * here, on real output bytes:
 *
 *  1. A run that re-encoded nothing still returns a rebuilt file, whose byte
 *     length differs from the input purely because pdf-lib re-serialised it. Any
 *     difference reported as "saved" credits compression for work it did not do.
 *  2. A replacement that is *larger* than the stream it replaces makes that image
 *     worse. The whole-file gate cannot see it whenever the run shrinks the file
 *     overall for other reasons.
 *
 * The per-image `imageStats` the report sidecar prints (CMP-06) is measured on
 * this path too, so it is graded here as well: before/after byte lengths that
 * come from the streams themselves, not from an estimate.
 */
import { describe, expect, it, vi } from 'vitest';
import { PDFDocument, PDFDict, PDFName, PDFRef, PDFStream } from 'pdf-lib';

vi.mock('comlink', () => ({
  expose: vi.fn(),
  transfer: vi.fn(value => value),
  proxy: vi.fn(value => value)
}));

const { processWorkerImpl } = await import('../../src/core/workers/process.worker');
const { silentJob } = await import('../../src/core/workers/protocol');

/** A 2x2 baseline JPEG, ~35 bytes — smaller than any stream built below. */
const TINY_JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x02, 0x00, 0x02, 0x01, 0x01, 0x11,
  0x00, 0xff, 0xd9
]);

/**
 * A document with one image XObject shared by `pageCount` pages, stored
 * uncompressed so its stored length is known exactly (`imageBytes`).
 */
async function docWithSharedImage(pageCount = 1, imageBytes = 4096) {
  const doc = await PDFDocument.create();
  const image = doc.context.stream(new Uint8Array(imageBytes).fill(0x7f), {
    Type: 'XObject',
    Subtype: 'Image',
    Width: 32,
    Height: 32,
    ColorSpace: 'DeviceGray',
    BitsPerComponent: 8
  });
  const ref = doc.context.register(image);
  for (let i = 0; i < pageCount; i++) {
    const page = doc.addPage([200, 200]);
    (page.node.Resources() as PDFDict).set(PDFName.of('XObject'), doc.context.obj({ Im0: ref }));
    page.node.set(
      PDFName.of('Contents'),
      doc.context.register(doc.context.flateStream('q 200 0 0 200 0 0 cm /Im0 Do Q'))
    );
  }
  return {
    bytes: await doc.save({ useObjectStreams: false }),
    objectNumber: ref.objectNumber,
    imageBytes
  };
}

async function im0StoredBytes(bytes: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(bytes);
  const xobjs = doc.getPage(0).node.Resources()?.lookup(PDFName.of('XObject'), PDFDict);
  const ref = xobjs!.get(PDFName.of('Im0'));
  if (!(ref instanceof PDFRef)) throw new Error('expected an indirect image');
  return doc.context.lookup(ref, PDFStream).getContents().byteLength;
}

describe('rebuildCompressed reports no savings when it did no work (CMP-04)', () => {
  it('keeps the original bytes for an empty compression plan', async () => {
    const { bytes } = await docWithSharedImage();
    const result = await processWorkerImpl.rebuildCompressed(bytes, {}, {}, silentJob);

    expect(result.keptOriginal).toBe(true);
    // Byte-identical, so nothing downstream can compute a saving from it.
    expect(result.bytes.byteLength).toBe(bytes.byteLength);
    expect(Array.from(result.bytes)).toEqual(Array.from(bytes));
    expect(result.imageStats).toEqual([]);
    // And it is still a readable PDF with its page intact.
    expect((await PDFDocument.load(result.bytes)).getPageCount()).toBe(1);
  });

  it('keeps the original bytes for a plan naming an image that is not on the page', async () => {
    const { bytes, objectNumber } = await docWithSharedImage();
    const result = await processWorkerImpl.rebuildCompressed(
      bytes,
      {},
      { 0: { [objectNumber + 500]: { jpeg: TINY_JPEG, width: 2, height: 2 } } },
      silentJob
    );

    expect(result.keptOriginal).toBe(true);
    expect(result.bytes.byteLength).toBe(bytes.byteLength);
    // The report says which image was asked about and why nothing happened,
    // rather than silently listing it as re-encoded.
    expect(result.imageStats).toHaveLength(1);
    expect(result.imageStats[0].status).toBe('skipped');
    expect(result.imageStats[0].skipReason).toMatch(/not reachable/);
  });

  it('refuses a replacement that is larger than the stream it replaces', async () => {
    // A 512-byte original against a ~35-byte JPEG is a real saving; invert it by
    // making the "replacement" larger than the original.
    const { bytes, objectNumber } = await docWithSharedImage(1, 256);
    const bloated = new Uint8Array(4096);
    bloated.set(TINY_JPEG);

    const result = await processWorkerImpl.rebuildCompressed(
      bytes,
      {},
      { 0: { [objectNumber]: { jpeg: bloated, width: 2, height: 2 } } },
      silentJob
    );

    expect(result.keptOriginal).toBe(true);
    expect(result.imageStats[0].status).toBe('skipped');
    expect(result.imageStats[0].skipReason).toMatch(/larger|against the original/);
    expect(result.imageStats[0].originalBytes).toBe(256);
    expect(result.imageStats[0].compressedBytes).toBe(4096);
    // The original image survives in the file the user keeps.
    expect(await im0StoredBytes(result.bytes)).toBe(256);
  });
});

describe('rebuildCompressed measures per-image sizes (CMP-06)', () => {
  it('reports the original and replacement byte lengths of a real swap', async () => {
    const { bytes, objectNumber, imageBytes } = await docWithSharedImage(1, 8192);
    const result = await processWorkerImpl.rebuildCompressed(
      bytes,
      {},
      { 0: { [objectNumber]: { jpeg: TINY_JPEG, width: 2, height: 2 } } },
      silentJob
    );

    expect(result.keptOriginal).toBe(false);
    expect(result.imageStats).toHaveLength(1);
    const [stat] = result.imageStats;
    expect(stat.status).toBe('re-encoded');
    expect(stat.imageId).toBe('Im0');
    expect(stat.objectNumber).toBe(objectNumber);
    expect(stat.originalBytes).toBe(imageBytes);
    expect(stat.compressedBytes).toBe(TINY_JPEG.byteLength);
    // Measured, not asserted: the output really does carry the small stream.
    expect(await im0StoredBytes(result.bytes)).toBe(TINY_JPEG.byteLength);
  });

  it('reports one entry per page for a shared image, all pointing at one stream', async () => {
    const { bytes, objectNumber } = await docWithSharedImage(3, 8192);
    const result = await processWorkerImpl.rebuildCompressed(
      bytes,
      {},
      {
        0: { [objectNumber]: { jpeg: TINY_JPEG, width: 2, height: 2 } },
        1: { [objectNumber]: { jpeg: TINY_JPEG, width: 2, height: 2 } },
        2: { [objectNumber]: { jpeg: TINY_JPEG, width: 2, height: 2 } }
      },
      silentJob
    );

    expect(result.keptOriginal).toBe(false);
    expect(result.imageStats).toHaveLength(3);
    for (const stat of result.imageStats) {
      expect(stat.status).toBe('re-encoded');
      expect(stat.originalBytes).toBe(8192);
      expect(stat.compressedBytes).toBe(TINY_JPEG.byteLength);
    }

    // One embedded stream, not three: every page's /Im0 resolves to the same ref.
    const out = await PDFDocument.load(result.bytes);
    const refs = new Set<string>();
    for (let i = 0; i < out.getPageCount(); i++) {
      const xobjs = out.getPage(i).node.Resources()?.lookup(PDFName.of('XObject'), PDFDict);
      for (const [, value] of xobjs!.entries()) refs.add(String(value));
    }
    expect(refs.size).toBe(1);
  });
});
