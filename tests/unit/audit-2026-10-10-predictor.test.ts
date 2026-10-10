/**
 * Audit 2026-10-10 — image extraction graded on output bytes.
 *
 * CV2: pdf-lib's `decodePDFRawStream` ignores /DecodeParms /Predictor, so a
 * PNG- or TIFF-predicted raster was re-framed as if its filtered rows were
 * samples and reported "extracted". `core/pdf/predictor.ts` undoes them (and
 * greyscale reads streams through it too).
 * CV7: a DCT/JPX image with a non-identity /Decode was handed over as its own
 * file — DeviceGray [1 0] came out inverted. Now refused, except an Adobe
 * CMYK JPEG's inverted [1 0 1 0 1 0 1 0], which is the normal pairing.
 * CV15: a bare JPEG 2000 codestream is written as `.j2k`, not `.jp2`.
 */
import { describe, expect, it, vi } from 'vitest';
import { unzipSync, unzlibSync, zlibSync } from 'fflate';
import { PDFDocument, PDFName, PDFRawStream, type PDFDict } from 'pdf-lib';

vi.setConfig({ testTimeout: 60_000 });
vi.mock('comlink', () => ({
  expose: vi.fn(),
  transfer: vi.fn(value => value),
  proxy: vi.fn(value => value),
  releaseProxy: Symbol('releaseProxy')
}));

const { processWorkerImpl } = await import('../../src/core/workers/process.worker');
const { undoPredictor, decodeStreamBytes } = await import('../../src/core/pdf/predictor');
const { encodeGrayJpeg } = await import('../../src/core/jpeg-gray');

/* ------------------------------------------------------------------ *
 * An independent PNG row-filter encoder (RFC 2083 §6), for building inputs
 * ------------------------------------------------------------------ */

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Filters `rows` (each `rowBytes` long) with the given per-row filter types. */
function pngPredict(rows: number[][], types: number[], bpp: number): Uint8Array {
  const out: number[] = [];
  rows.forEach((row, r) => {
    const prev = r > 0 ? rows[r - 1] : row.map(() => 0);
    const type = types[r];
    out.push(type);
    row.forEach((x, i) => {
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      const pred = [0, a, b, (a + b) >> 1, paeth(a, b, c)][type];
      out.push((x - pred) & 0xff);
    });
  });
  return new Uint8Array(out);
}

/** 4×2 RGB: red, green, blue, white / a ramp (so every predictor has work to do). */
const PIXELS = [
  [255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255],
  [10, 200, 30, 40, 50, 250, 1, 2, 3, 128, 129, 130]
];

/** One-page PDF drawing a single image XObject with `dict` and `data`. */
async function pdfWithImage(dict: Record<string, unknown>, data: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([100, 100]);
  const ref = doc.context.register(
    PDFRawStream.of(
      doc.context.obj({ Type: 'XObject', Subtype: 'Image', ...dict }) as PDFDict,
      data
    )
  );
  const name = page.node.newXObject('Im', ref);
  page.node.set(
    PDFName.of('Contents'),
    doc.context.register(doc.context.flateStream(`q 100 0 0 100 0 0 cm ${name.asString()} Do Q`))
  );
  return doc.save();
}

type Extracted = {
  bytes: Uint8Array;
  entries: { status: string; fileName?: string; note?: string }[];
};

async function extract(pdf: Uint8Array) {
  const result = (await processWorkerImpl.extractImages(pdf, null)) as unknown as Extracted;
  return { entries: result.entries, files: unzipSync(result.bytes) };
}

/** The samples of a PNG this test did not write (IDAT inflated, row filters undone). */
function pngSamples(png: Uint8Array, rowBytes: number, bpp: number): number[][] {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const idat: number[] = [];
  for (let at = 8; at < png.length;) {
    const length = view.getUint32(at);
    if (String.fromCharCode(...png.subarray(at + 4, at + 8)) === 'IDAT') {
      idat.push(...png.subarray(at + 8, at + 8 + length));
    }
    at += 12 + length;
  }
  const raw = unzlibSync(new Uint8Array(idat));
  const plain = undoPredictor(raw, {
    predictor: 15,
    colors: bpp,
    bitsPerComponent: 8,
    columns: rowBytes / bpp
  });
  const rows: number[][] = [];
  for (let r = 0; r < plain.length / rowBytes; r++) {
    rows.push([...plain.subarray(r * rowBytes, (r + 1) * rowBytes)]);
  }
  return rows;
}

describe('CV2 — /Predictor is undone before an image is re-framed', () => {
  for (const type of [0, 1, 2, 3, 4]) {
    it(`extracts a 4×2 RGB /Predictor 15 image whose rows use PNG filter ${type}`, async () => {
      const predicted = pngPredict(PIXELS, [type, type], 3);
      const pdf = await pdfWithImage(
        {
          Width: 4,
          Height: 2,
          ColorSpace: 'DeviceRGB',
          BitsPerComponent: 8,
          Filter: 'FlateDecode',
          DecodeParms: { Predictor: 15, Colors: 3, BitsPerComponent: 8, Columns: 4 }
        },
        zlibSync(predicted)
      );
      const { entries, files } = await extract(pdf);
      expect(entries).toHaveLength(1);
      expect(entries[0].status).toBe('extracted');
      expect(pngSamples(files[entries[0].fileName!], 12, 3)).toEqual(PIXELS);
    });
  }

  it('mixes filter types row by row (Paeth then Average), as encoders do', () => {
    const predicted = pngPredict(PIXELS, [4, 3], 3);
    const out = undoPredictor(predicted, {
      predictor: 12, // the declared value does not pick the filter; the row tag does
      colors: 3,
      bitsPerComponent: 8,
      columns: 4
    });
    expect([...out]).toEqual(PIXELS.flat());
  });

  it('undoes TIFF predictor 2 at 8, 16 and 4 bits', () => {
    // 8-bit RGB: each sample minus the same sample one pixel left.
    const flat = PIXELS[0];
    const tiff8 = flat.map((v, i) => (i >= 3 ? (v - flat[i - 3]) & 0xff : v));
    expect([
      ...undoPredictor(new Uint8Array(tiff8), {
        predictor: 2,
        colors: 3,
        bitsPerComponent: 8,
        columns: 4
      })
    ]).toEqual(flat);
    // 16-bit grey: 1000, 1300, 65535 → stored 1000, 300, 64235 (big-endian).
    const tiff16 = new Uint8Array([0x03, 0xe8, 0x01, 0x2c, 0xfa, 0xeb]);
    expect([
      ...undoPredictor(tiff16, { predictor: 2, colors: 1, bitsPerComponent: 16, columns: 3 })
    ]).toEqual([0x03, 0xe8, 0x05, 0x14, 0xff, 0xff]);
    // 4-bit grey, 4 pixels 1,3,6,15 → stored 1,2,3,9.
    expect([
      ...undoPredictor(new Uint8Array([0x12, 0x39]), {
        predictor: 2,
        colors: 1,
        bitsPerComponent: 4,
        columns: 4
      })
    ]).toEqual([0x13, 0x6f]);
  });

  it('undoes a predictor on the Flate step of an [ASCIIHex Flate] chain', async () => {
    const predicted = zlibSync(pngPredict(PIXELS, [1, 2], 3));
    const hex = new TextEncoder().encode(
      [...predicted].map(b => b.toString(16).padStart(2, '0')).join('') + '>'
    );
    const pdf = await pdfWithImage(
      {
        Width: 4,
        Height: 2,
        ColorSpace: 'DeviceRGB',
        BitsPerComponent: 8,
        Filter: ['ASCIIHexDecode', 'FlateDecode'],
        DecodeParms: [null, { Predictor: 15, Colors: 3, Columns: 4 }]
      },
      hex
    );
    const { entries, files } = await extract(pdf);
    expect(entries[0].status).toBe('extracted');
    expect(pngSamples(files[entries[0].fileName!], 12, 3)).toEqual(PIXELS);
  });

  it('refuses (does not "extract") a stream whose predictor it cannot undo', async () => {
    const bad = pngPredict(PIXELS, [0, 0], 3);
    bad[13] = 7; // row 2's tag: no such PNG filter
    const pdf = await pdfWithImage(
      {
        Width: 4,
        Height: 2,
        ColorSpace: 'DeviceRGB',
        BitsPerComponent: 8,
        Filter: 'FlateDecode',
        DecodeParms: { Predictor: 15, Colors: 3, Columns: 4 }
      },
      zlibSync(bad)
    );
    const { entries, files } = await extract(pdf);
    expect(entries[0].status).toBe('skipped');
    expect(entries[0].note).toMatch(/Predictor.*row 2 has filter type 7/);
    expect(Object.keys(files)).toEqual([]);
    // An unknown predictor number is refused the same way.
    expect(() =>
      undoPredictor(new Uint8Array(4), { predictor: 5, colors: 1, bitsPerComponent: 8, columns: 4 })
    ).toThrow(/predictor 5/);
  });

  it('decodeStreamBytes leaves an unpredicted stream exactly as pdf-lib decodes it', async () => {
    const doc = await PDFDocument.create();
    const stream = PDFRawStream.of(
      doc.context.obj({ Filter: 'FlateDecode' }) as PDFDict,
      zlibSync(new Uint8Array([1, 2, 3, 4, 5]))
    );
    expect([...decodeStreamBytes(stream)]).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('CV2 — greyscale reads predicted streams correctly', () => {
  it('converts a page whose content stream is Flate + /Predictor 12', async () => {
    const content = new TextEncoder().encode('1 0 0 rg 0 0 50 50 re f\n'); // 24 bytes
    const rows: number[][] = [];
    for (let i = 0; i < content.length; i += 4) rows.push([...content.subarray(i, i + 4)]);
    const doc = await PDFDocument.create();
    const page = doc.addPage([100, 100]);
    const stream = PDFRawStream.of(
      doc.context.obj({
        Filter: 'FlateDecode',
        DecodeParms: { Predictor: 12, Columns: 4 }
      }) as PDFDict,
      zlibSync(
        pngPredict(
          rows,
          rows.map(() => 2),
          1
        )
      )
    );
    page.node.set(PDFName.of('Contents'), doc.context.register(stream));
    const input = await doc.save();
    const plans = (await processWorkerImpl.grayscalePlan(
      input,
      [0],
      'gray',
      undefined
    )) as unknown as {
      rasterReasons: string[];
      chromaticConstructs: number;
    }[];
    // Read correctly, the page is one red vector fill: one chromatic construct
    // and nothing that forces a raster. Before the fix the row-filtered bytes
    // were parsed as the content stream and the red fill was never seen.
    expect(plans).toHaveLength(1);
    expect(plans[0].rasterReasons).toEqual([]);
    expect(plans[0].chromaticConstructs).toBe(1);
  });
});

describe('CV7 — /Decode on a DCT image', () => {
  const W = 8;
  const H = 8;
  const gray = () => encodeGrayJpeg(new Uint8Array(W * H).fill(20), W, H, { quality: 0.9 });

  it('refuses a DeviceGray JPEG with /Decode [1 0] instead of writing an inverted file', async () => {
    const pdf = await pdfWithImage(
      {
        Width: W,
        Height: H,
        ColorSpace: 'DeviceGray',
        BitsPerComponent: 8,
        Filter: 'DCTDecode',
        Decode: [1, 0]
      },
      gray()
    );
    const { entries, files } = await extract(pdf);
    expect(entries[0].status).toBe('skipped');
    expect(entries[0].note).toMatch(/non-default \/Decode/);
    expect(Object.keys(files)).toEqual([]);
  });

  it('still hands over a JPEG with an identity /Decode byte for byte', async () => {
    const jpg = gray();
    const pdf = await pdfWithImage(
      {
        Width: W,
        Height: H,
        ColorSpace: 'DeviceGray',
        BitsPerComponent: 8,
        Filter: 'DCTDecode',
        Decode: [0, 1]
      },
      jpg
    );
    const { entries, files } = await extract(pdf);
    expect(entries[0].status).toBe('extracted');
    expect([...files[entries[0].fileName!]]).toEqual([...jpg]);
  });

  /** A structurally valid 4-component JPEG header (APP14 optional) — never decoded here. */
  function cmykJpegHeader(adobe: boolean): Uint8Array {
    const app14 = [
      0xff,
      0xee,
      0x00,
      0x0e,
      ...[...'Adobe'].map(c => c.charCodeAt(0)),
      0,
      100,
      0,
      0,
      0,
      0,
      2
    ];
    const sof = [
      0xff, 0xc0, 0x00, 0x14, 8, 0, 8, 0, 8, 4, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0, 4, 0x11, 0
    ];
    return new Uint8Array([0xff, 0xd8, ...(adobe ? app14 : []), ...sof, 0xff, 0xd9]);
  }

  it('hands over an Adobe CMYK JPEG with the inverted /Decode [1 0 1 0 1 0 1 0]', async () => {
    const jpg = cmykJpegHeader(true);
    const pdf = await pdfWithImage(
      {
        Width: 8,
        Height: 8,
        ColorSpace: 'DeviceCMYK',
        BitsPerComponent: 8,
        Filter: 'DCTDecode',
        Decode: [1, 0, 1, 0, 1, 0, 1, 0]
      },
      jpg
    );
    const { entries, files } = await extract(pdf);
    expect(entries[0].status).toBe('extracted');
    expect([...files[entries[0].fileName!]]).toEqual([...jpg]);
  });

  it('refuses the same inverted /Decode on a CMYK JPEG without the Adobe marker', async () => {
    const pdf = await pdfWithImage(
      {
        Width: 8,
        Height: 8,
        ColorSpace: 'DeviceCMYK',
        BitsPerComponent: 8,
        Filter: 'DCTDecode',
        Decode: [1, 0, 1, 0, 1, 0, 1, 0]
      },
      cmykJpegHeader(false)
    );
    const { entries } = await extract(pdf);
    expect(entries[0].status).toBe('skipped');
  });

  it('refuses a JPX image with an inverting /Decode', async () => {
    const pdf = await pdfWithImage(
      {
        Width: 8,
        Height: 8,
        ColorSpace: 'DeviceGray',
        BitsPerComponent: 8,
        Filter: 'JPXDecode',
        Decode: [1, 0]
      },
      new Uint8Array([0xff, 0x4f, 0xff, 0x51, 0, 0])
    );
    const { entries } = await extract(pdf);
    expect(entries[0].status).toBe('skipped');
    expect(entries[0].note).toMatch(/non-default \/Decode/);
  });
});

describe('CV15 — JPEG 2000 file type', () => {
  it('writes a bare codestream as .j2k and a JP2 box file as .jp2', async () => {
    const codestream = new Uint8Array([0xff, 0x4f, 0xff, 0x51, 0x00, 0x2f, 1, 2, 3]);
    const jp2 = new Uint8Array([
      0, 0, 0, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a, 9, 9
    ]);
    for (const [bytes, ext] of [
      [codestream, 'j2k'],
      [jp2, 'jp2']
    ] as const) {
      const pdf = await pdfWithImage(
        { Width: 8, Height: 8, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'JPXDecode' },
        bytes
      );
      const { entries, files } = await extract(pdf);
      expect(entries[0].status).toBe('extracted');
      expect(entries[0].fileName).toMatch(new RegExp(`\\.${ext}$`));
      expect([...files[entries[0].fileName!]]).toEqual([...bytes]);
    }
  });
});
