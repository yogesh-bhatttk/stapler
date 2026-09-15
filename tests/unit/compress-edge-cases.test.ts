/**
 * The four compression findings from the 2026-09-15 edge-case audit's "High"
 * section — §2.4, §2.5, §2.9 and §2.10 — each graded against real pdf-lib
 * documents and, where the fix changes what is written, against the real output
 * bytes rather than against intent.
 *
 *  • §2.4 — the undecodable-filter skip list read only the *base* image's
 *    `/Filter`, so a FlateDecode photo carrying a JPXDecode `/SMask` was routed
 *    to `surgical`: the one route that has to decode the mask it re-attaches.
 *  • §2.5 — `embedJpg` is pdf-lib's JPEG parser, and it was called unguarded on
 *    both rebuild paths. One replacement it could not parse threw out of
 *    `rebuildCompressed` entirely, failing compression for the whole document,
 *    where every other per-image failure skips the image and carries on.
 *  • §2.9 — `bitsPerComponent < 8` marked the whole *page* unsafe, so a 1-bit
 *    bilevel fax scan — the archetypal input this feature targets — was
 *    reported "cannot be safely rasterized" and compressed by nothing, without
 *    the raster route (which never reads that stream) ever being tried.
 *  • §2.10 — `storedStreamBytes` returned `0` for a failed read and `0` for a
 *    genuinely empty stream, and the caller's `originalBytes > 0 &&` guard read
 *    the failure as permission to skip the never-grow check for that image.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, PDFStream } from 'pdf-lib';

vi.mock('comlink', () => ({
  expose: vi.fn(),
  transfer: vi.fn(value => value),
  proxy: vi.fn(value => value)
}));

const { processWorkerImpl } = await import('../../src/core/workers/process.worker');
const { silentJob } = await import('../../src/core/workers/protocol');
const { classifyPages } = await import('../../src/core/compress-plan');
const { decodeStream } = await import('../../src/core/pdf/interpreter');

const OPTIONS = { rasterDpi: 150 };

/** A4 at 300 DPI — twice the 150 DPI target, so an image this size is a candidate. */
const IMAGE_WIDTH = 2480;
const IMAGE_HEIGHT = 3508;
const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;

/** A text census for `classifyPages`, which takes it from `render.worker`. */
function census(charCount: number, pageIndex = 0) {
  return { pageIndex, charCount, runCount: charCount > 0 ? Math.ceil(charCount / 8) : 0 };
}

/** A 2×2 baseline JPEG, ~35 bytes — smaller than any stream built below. */
const TINY_JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x02, 0x00, 0x02, 0x01, 0x01, 0x11,
  0x00, 0xff, 0xd9
]);

/** A baseline JPEG whose SOF0 declares `width` × `height`. */
function jpegOfSize(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x10,
    0x4a,
    0x46,
    0x49,
    0x46,
    0x00,
    0x01,
    0x01,
    0x00,
    0x00,
    0x01,
    0x00,
    0x01,
    0x00,
    0x00,
    0xff,
    0xc0,
    0x00,
    0x0b,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x01,
    0x01,
    0x11,
    0x00,
    0xff,
    0xd9
  ]);
}

/**
 * Bytes that are emphatically not a JPEG: no SOI marker, so pdf-lib's
 * `JpegEmbedder` throws `SOI not found in JPEG` on them — the exact failure
 * §2.5 is about. Kept short so it clears the never-grow gate and actually
 * reaches `embedJpg`.
 */
const NOT_A_JPEG = new Uint8Array([0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77]);

interface ImageSpec {
  /** `/Filter` on the image itself; an array becomes a real `/Filter` chain. */
  filter?: string | string[];
  bitsPerComponent?: number;
  colorSpace?: string;
  width?: number;
  height?: number;
  byteLength?: number;
  /** A `/SMask` or stencil `/Mask` stream, with its own filter chain. */
  mask?: { key: 'SMask' | 'Mask'; filter?: string | string[] };
  /** Extra dict entries, e.g. a marker the §2.10 spy recognises. */
  extra?: Record<string, unknown>;
}

/**
 * A one-page document carrying `specs` as image XObjects named `Im0`, `Im1`, …
 *
 * Streams are built with `context.stream`, so the declared `/Filter` is written
 * verbatim onto raw bytes. Nothing on the paths under test decodes an image
 * stream — the classifier reads the dictionary and `rebuildCompressed` compares
 * stored lengths — so a declared filter is exactly as load-bearing here as it is
 * in a real file.
 */
async function docWithImages(specs: ImageSpec[], pageCount = 1, contentPadding = 0) {
  const doc = await PDFDocument.create();
  const refs: PDFRef[] = [];

  for (const spec of specs) {
    const dict: Record<string, unknown> = {
      Type: 'XObject',
      Subtype: 'Image',
      Width: spec.width ?? IMAGE_WIDTH,
      Height: spec.height ?? IMAGE_HEIGHT,
      ColorSpace: spec.colorSpace ?? 'DeviceGray',
      BitsPerComponent: spec.bitsPerComponent ?? 8,
      ...(spec.extra ?? {})
    };
    if (spec.filter) dict.Filter = spec.filter;

    if (spec.mask) {
      const maskDict: Record<string, unknown> = {
        Type: 'XObject',
        Subtype: 'Image',
        Width: spec.width ?? IMAGE_WIDTH,
        Height: spec.height ?? IMAGE_HEIGHT,
        ColorSpace: 'DeviceGray',
        BitsPerComponent: 8
      };
      if (spec.mask.filter) maskDict.Filter = spec.mask.filter;
      const maskStream = doc.context.stream(new Uint8Array(512).fill(0x40), maskDict);
      dict[spec.mask.key] = doc.context.register(maskStream);
    }

    const stream = doc.context.stream(new Uint8Array(spec.byteLength ?? 4096).fill(0x7f), dict);
    refs.push(doc.context.register(stream));
  }

  const names: Record<string, PDFRef> = {};
  refs.forEach((ref, i) => {
    names[`Im${i}`] = ref;
  });

  for (let p = 0; p < pageCount; p++) {
    const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    (page.node.Resources() as PDFDict).set(PDFName.of('XObject'), doc.context.obj(names));
    page.node.set(
      PDFName.of('Contents'),
      doc.context.register(
        // Uncompressed, so `contentPadding` really does weigh what it looks
        // like it weighs — flate would squeeze a repeated word to nothing.
        doc.context.stream(
          refs.map((_, i) => `q ${PAGE_WIDTH} 0 0 ${PAGE_HEIGHT} 0 0 cm /Im${i} Do Q`).join('\n') +
            // Deliberate bulk, so that a page replaced by one small raster is
            // comfortably smaller than it was and CMP-04's never-grow gate does
            // not hand the original bytes back before anything can be asserted.
            (contentPadding > 0 ? `\n% ${'padding '.repeat(contentPadding)}` : '')
        )
      )
    );
  }

  return {
    bytes: await doc.save({ useObjectStreams: false }),
    objectNumbers: refs.map(ref => ref.objectNumber)
  };
}

/** The stored byte length of `name` on page 0 of a produced file. */
async function storedBytesOf(bytes: Uint8Array, name: string): Promise<number> {
  const doc = await PDFDocument.load(bytes);
  const xobjs = doc.getPage(0).node.Resources()?.lookup(PDFName.of('XObject'), PDFDict);
  const ref = xobjs!.get(PDFName.of(name));
  if (!(ref instanceof PDFRef)) throw new Error(`expected ${name} to be an indirect image`);
  return doc.context.lookup(ref, PDFStream).getContents().byteLength;
}

/** A page's decoded content stream, for asserting what survived a rebuild. */
async function pageContent(bytes: Uint8Array, pageIndex: number): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  const contents = doc.getPage(pageIndex).node.Contents();
  if (!contents) return '';
  const streams =
    contents instanceof PDFArray
      ? contents.asArray().map(ref => doc.context.lookup(ref))
      : [contents];

  let text = '';
  for (const stream of streams) {
    if (!(stream instanceof PDFStream)) continue;
    const raw = stream.getContents();
    const filter = String(stream.dict.get(PDFName.of('Filter')));
    text += new TextDecoder('latin1').decode(
      filter === '/FlateDecode' ? await decodeStream(raw) : raw
    );
  }
  return text;
}

afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ *
 * §2.4 — an undecodable mask disqualifies the image it masks
 * ------------------------------------------------------------------ */

describe('§2.4 the skip list inspects the mask’s filter chain, not just the image’s', () => {
  it('records a /SMask’s own filter chain in the inventory', async () => {
    const { bytes } = await docWithImages([
      { filter: 'FlateDecode', mask: { key: 'SMask', filter: 'JPXDecode' } }
    ]);
    const inventory = await processWorkerImpl.imageInventory(bytes, silentJob);

    // The base image is perfectly ordinary; only the mask is not.
    expect(inventory[0].images[0].filters).toEqual(['FlateDecode']);
    expect(inventory[0].images[0].maskFilters).toEqual(['JPXDecode']);
  });

  it.each([
    ['a JPXDecode /SMask', 'SMask' as const, 'JPXDecode', 'JPXDecode'],
    ['a JBIG2Decode /SMask', 'SMask' as const, 'JBIG2Decode', 'JBIG2Decode'],
    ['a JPXDecode stencil /Mask', 'Mask' as const, 'JPXDecode', 'JPXDecode'],
    // A chain applies left to right, so the *last* entry is the codec — the
    // same reason the base image's chain is read whole rather than at its head.
    [
      'an ASCII85-wrapped JPXDecode /SMask',
      'SMask' as const,
      ['ASCII85Decode', 'JPXDecode'],
      'JPXDecode'
    ]
  ])('refuses an image with %s', async (_label, key, maskFilter, expected) => {
    const { bytes } = await docWithImages([
      { filter: 'FlateDecode', mask: { key, filter: maskFilter } }
    ]);
    const inventory = await processWorkerImpl.imageInventory(bytes, silentJob);
    const plan = classifyPages(inventory, [census(3000)], OPTIONS);

    // Measured before the fix: route `surgical`, `skipped: []` — the
    // undecodable mask stream walked straight into the re-encode path.
    expect(plan.pages[0].route).toBe('skip');
    expect(plan.pages[0].reencode).toEqual([]);
    expect(plan.actionableBytes).toBe(0);
    expect(plan.skipped.join(' ')).toContain(expected);
    expect(plan.skipped.join(' ')).toContain('mask');
  });

  it('refuses to rasterise a textless page whose image carries an undecodable mask', async () => {
    const { bytes } = await docWithImages([
      { filter: 'FlateDecode', mask: { key: 'SMask', filter: 'JPXDecode' } }
    ]);
    const inventory = await processWorkerImpl.imageInventory(bytes, silentJob);
    const plan = classifyPages(inventory, [census(0)], OPTIONS);

    // pdf.js cannot decode the mask to render the page either, so unlike the
    // 1-bit case below this one really does block both routes.
    expect(plan.pages[0].route).toBe('already-optimized');
    expect(plan.pages[0].reason).toContain('cannot be safely rasterized');
  });

  it('still re-encodes an image whose mask is an ordinary Flate stream', async () => {
    const { bytes } = await docWithImages([
      { filter: 'FlateDecode', mask: { key: 'SMask', filter: 'FlateDecode' } }
    ]);
    const inventory = await processWorkerImpl.imageInventory(bytes, silentJob);
    const plan = classifyPages(inventory, [census(3000)], OPTIONS);

    expect(inventory[0].images[0].maskFilters).toEqual(['FlateDecode']);
    expect(plan.pages[0].route).toBe('surgical');
    expect(plan.pages[0].reencode).toHaveLength(1);
  });

  it('keeps the original stream when rebuildCompressed is asked to swap one anyway', async () => {
    // The classifier is the primary gate; this is the second lock on the same
    // door, so it is graded on a plan that has already gone wrong.
    const { bytes, objectNumbers } = await docWithImages([
      { filter: 'FlateDecode', mask: { key: 'SMask', filter: 'JPXDecode' } }
    ]);
    const result = await processWorkerImpl.rebuildCompressed(
      bytes,
      {},
      { 0: { [objectNumbers[0]]: { jpeg: TINY_JPEG, width: 2, height: 2 } } },
      silentJob
    );

    expect(result.imageStats).toHaveLength(1);
    expect(result.imageStats[0].status).toBe('skipped');
    expect(result.imageStats[0].skipReason).toContain('JPXDecode');
    // Nothing was swapped, so the user gets their own bytes back.
    expect(result.keptOriginal).toBe(true);
    expect(await storedBytesOf(result.bytes, 'Im0')).toBe(4096);
  });
});

/* ------------------------------------------------------------------ *
 * §2.5 — a replacement pdf-lib cannot parse costs one image, not the file
 * ------------------------------------------------------------------ */

describe('§2.5 an unparseable replacement JPEG skips one image, not the whole run', () => {
  it('does not throw out of the surgical path, and keeps the original image', async () => {
    const { bytes, objectNumbers } = await docWithImages([{ filter: 'FlateDecode' }]);

    // Before the fix this rejected with `Error: SOI not found in JPEG`.
    const result = await processWorkerImpl.rebuildCompressed(
      bytes,
      {},
      { 0: { [objectNumbers[0]]: { jpeg: NOT_A_JPEG, width: 2, height: 2 } } },
      silentJob
    );

    expect(result.imageStats).toHaveLength(1);
    expect(result.imageStats[0].status).toBe('skipped');
    expect(result.imageStats[0].skipReason).toMatch(/could not be read back as a JPEG/);
    // The message names the real cause rather than swallowing it.
    expect(result.imageStats[0].skipReason).toMatch(/SOI/);
    expect(result.keptOriginal).toBe(true);
    expect(Array.from(result.bytes)).toEqual(Array.from(bytes));
  });

  it('re-encodes the good image on a page whose other replacement is unparseable', async () => {
    const { bytes, objectNumbers } = await docWithImages([
      { filter: 'FlateDecode', byteLength: 8192 },
      { filter: 'FlateDecode', byteLength: 8192 }
    ]);

    const result = await processWorkerImpl.rebuildCompressed(
      bytes,
      {},
      {
        0: {
          [objectNumbers[0]]: { jpeg: TINY_JPEG, width: 2, height: 2 },
          [objectNumbers[1]]: { jpeg: NOT_A_JPEG, width: 2, height: 2 }
        }
      },
      silentJob
    );

    expect(result.keptOriginal).toBe(false);
    const byObject = new Map(result.imageStats.map(s => [s.objectNumber, s]));
    expect(byObject.get(objectNumbers[0])!.status).toBe('re-encoded');
    expect(byObject.get(objectNumbers[1])!.status).toBe('skipped');

    // Measured on the produced file: one image really was swapped, the other
    // really was left at its original stored length.
    expect(await storedBytesOf(result.bytes, 'Im0')).toBe(TINY_JPEG.byteLength);
    expect(await storedBytesOf(result.bytes, 'Im1')).toBe(8192);
  });

  it('leaves a page alone when its replacement raster will not parse', async () => {
    const { bytes } = await docWithImages([{ filter: 'FlateDecode' }]);

    const result = await processWorkerImpl.rebuildCompressed(
      bytes,
      { 0: NOT_A_JPEG },
      {},
      silentJob
    );

    expect(result.keptOriginal).toBe(true);
    expect(Array.from(result.bytes)).toEqual(Array.from(bytes));
    expect(result.imageStats).toHaveLength(1);
    expect(result.imageStats[0].pageIndex).toBe(0);
    expect(result.imageStats[0].imageId).toBe('page-1-raster');
    expect(result.imageStats[0].status).toBe('skipped');
    expect(result.imageStats[0].skipReason).toMatch(/could not be read back as a JPEG/);
  });

  it('rasterises the pages whose rasters parse and copies the one that does not', async () => {
    const { bytes } = await docWithImages([{ filter: 'FlateDecode' }], 2, 20_000);

    const result = await processWorkerImpl.rebuildCompressed(
      bytes,
      { 0: jpegOfSize(PAGE_WIDTH * 2, PAGE_HEIGHT * 2), 1: NOT_A_JPEG },
      {},
      silentJob
    );

    expect(result.keptOriginal).toBe(false);
    const out = await PDFDocument.load(result.bytes);
    expect(out.getPageCount()).toBe(2);

    // Page 0 became one image: its content stream is the placement matrix and
    // a single `Do`, with the original `/Im0 Do` gone.
    expect(await pageContent(result.bytes, 0)).toMatch(/cm\s*\/Image/);
    // Page 1 is the original page, byte-for-byte in content terms — the raster
    // that could not be parsed cost this page its compression and nothing else.
    expect(await pageContent(result.bytes, 1)).toContain('/Im0 Do');

    const stats = result.imageStats.filter(s => s.pageIndex === 1);
    expect(stats).toHaveLength(1);
    expect(stats[0].status).toBe('skipped');
  });
});

/* ------------------------------------------------------------------ *
 * §2.9 — bit depth gates the surgical route, not the raster one
 * ------------------------------------------------------------------ */

describe('§2.9 a 1-bit bilevel scan can still be rasterised', () => {
  it('routes a textless 1-bit fax page to raster instead of reporting it unsafe', async () => {
    const { bytes } = await docWithImages([
      { filter: 'CCITTFaxDecode', bitsPerComponent: 1, byteLength: 120_000 }
    ]);
    const inventory = await processWorkerImpl.imageInventory(bytes, silentJob);
    const plan = classifyPages(inventory, [census(0)], OPTIONS);

    // Measured before the fix: `already-optimized`, reason "…cannot be safely
    // rasterized", `actionableBytes: 0` — a false "already optimized" report on
    // the single most compressible input this feature will ever see.
    expect(plan.pages[0].route).toBe('raster');
    expect(plan.pages[0].reason).not.toMatch(/cannot be safely rasterized/);
    expect(plan.pages[0].actionableBytes).toBe(120_000);
    expect(plan.actionableBytes).toBe(120_000);
    expect(plan.pages[0].targetPixels).toBeGreaterThan(0);

    // And the report does not claim the image was left untouched: it is
    // re-rendered into the page's new JPEG along with everything else.
    expect(plan.skipped).toEqual([]);
  });

  it('rasterises a page mixing a photo with a 1-bit stencil-style logo', async () => {
    const { bytes } = await docWithImages([
      { filter: 'DCTDecode', bitsPerComponent: 8, colorSpace: 'DeviceRGB', byteLength: 900_000 },
      { filter: 'FlateDecode', bitsPerComponent: 1, width: 400, height: 120, byteLength: 6_000 }
    ]);
    const inventory = await processWorkerImpl.imageInventory(bytes, silentJob);
    const plan = classifyPages(inventory, [census(0)], OPTIONS);

    expect(plan.pages[0].route).toBe('raster');
    expect(plan.actionableBytes).toBe(906_000);
    expect(plan.skipped).toEqual([]);
  });

  it('still keeps a 1-bit image off the surgical route on a page that has text', async () => {
    // The gate is right for `surgical`, which re-encodes the original stream in
    // place and has no way to express 1-bit samples as a JPEG. Only the raster
    // verdict changed.
    const { bytes } = await docWithImages([
      { filter: 'CCITTFaxDecode', bitsPerComponent: 1, byteLength: 120_000 }
    ]);
    const inventory = await processWorkerImpl.imageInventory(bytes, silentJob);
    const plan = classifyPages(inventory, [census(3000)], OPTIONS);

    expect(plan.pages[0].route).toBe('skip');
    expect(plan.pages[0].reencode).toEqual([]);
    expect(plan.actionableBytes).toBe(0);
    expect(plan.skipped.join(' ')).toContain('1-bit image');
  });

  it('still refuses to rasterise a textless page whose image is a spot-colour plate', async () => {
    // The raster gate is not gone, only narrowed: a `/Separation` plate still
    // blocks the whole page, because flattening it to RGB destroys the ink.
    const { bytes } = await docWithImages([
      { filter: 'FlateDecode', colorSpace: 'Separation', byteLength: 120_000 }
    ]);
    const inventory = await processWorkerImpl.imageInventory(bytes, silentJob);
    const plan = classifyPages(inventory, [census(0)], OPTIONS);

    expect(plan.pages[0].route).toBe('already-optimized');
    expect(plan.pages[0].reason).toContain('cannot be safely rasterized');
    expect(plan.skipped.join(' ')).toContain('Separation');
  });
});

/* ------------------------------------------------------------------ *
 * §2.10 — an unreadable original is not a zero-byte original
 * ------------------------------------------------------------------ */

/**
 * Makes the *first* `getContents()` anywhere on a marked image stream throw.
 *
 * pdf-lib's own base `PDFStream.getContents()` throws
 * `MethodNotImplementedError`, which is precisely the failure
 * `storedStreamBytes` catches — and it is a stream shape a parsed file cannot
 * produce, so it is induced on the one stream under test rather than faked
 * wholesale. The very first read is `storedStreamBytes`'s size measurement;
 * every later read — `copyPages`' clone of the same stream into the output
 * document, and the writer serialising it — returns the real bytes, so the
 * produced file is genuinely written and the assertions below are made against
 * it rather than against a crippled document.
 */
function failFirstReadOfMarkedStream() {
  const real = PDFRawStream.prototype.getContents;
  let failuresLeft = 1;
  vi.spyOn(PDFRawStream.prototype, 'getContents').mockImplementation(function (this: PDFRawStream) {
    const marked = this.dict.get(PDFName.of('StaplerUnreadable')) !== undefined;
    if (marked && failuresLeft > 0) {
      failuresLeft -= 1;
      throw new Error('PDFRawStream.getContents() is not implemented');
    }
    return real.call(this);
  });
}

describe('§2.10 a stream whose size cannot be read is not treated as empty', () => {
  it('skips an image whose stored size could not be measured', async () => {
    const { bytes, objectNumbers } = await docWithImages([
      { filter: 'FlateDecode', byteLength: 4096, extra: { StaplerUnreadable: true } }
    ]);
    failFirstReadOfMarkedStream();

    // The audit's measured case: a replacement of 20,000 bytes against an
    // original whose size could not be read was reported "re-encoded", because
    // the failed read returned 0 and `originalBytes > 0 &&` short-circuited the
    // never-grow comparison for that image.
    const grown = new Uint8Array(20_000);
    grown.set(TINY_JPEG);

    const result = await processWorkerImpl.rebuildCompressed(
      bytes,
      {},
      { 0: { [objectNumbers[0]]: { jpeg: grown, width: 2, height: 2 } } },
      silentJob
    );

    expect(result.imageStats).toHaveLength(1);
    expect(result.imageStats[0].status).toBe('skipped');
    expect(result.imageStats[0].skipReason).toMatch(/could not be measured/);
    // No original size is claimed, because none was read.
    expect(result.imageStats[0].originalBytes).toBeUndefined();
    expect(result.imageStats[0].compressedBytes).toBe(20_000);

    // And the file the user keeps is their own, unchanged.
    expect(result.keptOriginal).toBe(true);
    expect(Array.from(result.bytes)).toEqual(Array.from(bytes));
  });

  it('keeps re-encoding the readable images in the same run', async () => {
    const { bytes, objectNumbers } = await docWithImages([
      { filter: 'FlateDecode', byteLength: 8192 },
      { filter: 'FlateDecode', byteLength: 8192, extra: { StaplerUnreadable: true } }
    ]);
    failFirstReadOfMarkedStream();

    const grown = new Uint8Array(20_000);
    grown.set(TINY_JPEG);
    const result = await processWorkerImpl.rebuildCompressed(
      bytes,
      {},
      {
        0: {
          [objectNumbers[0]]: { jpeg: TINY_JPEG, width: 2, height: 2 },
          [objectNumbers[1]]: { jpeg: grown, width: 2, height: 2 }
        }
      },
      silentJob
    );

    expect(result.keptOriginal).toBe(false);
    const byObject = new Map(result.imageStats.map(s => [s.objectNumber, s]));
    expect(byObject.get(objectNumbers[0])!.status).toBe('re-encoded');
    expect(byObject.get(objectNumbers[1])!.status).toBe('skipped');

    // Measured on the produced bytes: the unmeasurable image did not grow from
    // 8,192 to 20,000 — it is still exactly the stream it always was.
    expect(await storedBytesOf(result.bytes, 'Im0')).toBe(TINY_JPEG.byteLength);
    expect(await storedBytesOf(result.bytes, 'Im1')).toBe(8192);
  });

  it('treats a genuinely empty stream as zero bytes, not as an unreadable one', async () => {
    // No spy at all: a real, readable, zero-length image stream. It still never
    // grows — a 35-byte replacement is bigger than nothing — but the reason it
    // reports is the never-grow one, with the measured `0`, not "could not be
    // measured".
    const { bytes, objectNumbers } = await docWithImages([
      { filter: 'FlateDecode', byteLength: 0 }
    ]);

    const result = await processWorkerImpl.rebuildCompressed(
      bytes,
      {},
      { 0: { [objectNumbers[0]]: { jpeg: TINY_JPEG, width: 2, height: 2 } } },
      silentJob
    );

    expect(result.imageStats).toHaveLength(1);
    expect(result.imageStats[0].status).toBe('skipped');
    expect(result.imageStats[0].originalBytes).toBe(0);
    expect(result.imageStats[0].compressedBytes).toBe(TINY_JPEG.byteLength);
    expect(result.imageStats[0].skipReason).toMatch(/against the original 0/);
    expect(result.imageStats[0].skipReason).not.toMatch(/could not be measured/);
    expect(result.keptOriginal).toBe(true);
  });
});
