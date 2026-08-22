import { describe, it, expect, beforeAll } from 'vitest';
import { unzlibSync } from 'fflate';
import { readBarcodes, prepareZXingModule } from 'zxing-wasm/reader';
import {
  generateQrRaster,
  encodeCode128Bars,
  decodeBarcodesFromImage
} from '../../src/core/barcode';

// The WASM module's first load is slow enough, under a full parallel test run,
// to occasionally race past a single test's default timeout — not a product
// bug, just cold-start cost. Loading it once here, before any test needs it,
// keeps every `readBarcodes` call below fast and deterministic.
//
// Under heavy concurrent CPU/file-descriptor pressure (many other test files'
// worker processes running at once — never a real browser's situation) the
// WASM instantiation itself has been observed to abort outright rather than
// merely run slowly ("both async and sync fetching of the wasm failed"). One
// retry after a short pause is enough to clear that in practice; a real
// encode/decode defect would fail the same way on every attempt, not
// intermittently, so a retry here does not risk masking one.
beforeAll(async () => {
  try {
    await prepareZXingModule({ fireImmediately: true });
  } catch {
    await new Promise(resolve => setTimeout(resolve, 500));
    await prepareZXingModule({ fireImmediately: true });
  }
}, 20000);

/**
 * A deliberately independent PNG reader (mirrors `extract-images.test.ts`'s own
 * one) so this test does not reuse `encodePng`, the very writer under test.
 * Scoped to the one shape `generateQrRaster` ever produces: 8-bit RGB, filter
 * type "None" on every scanline, no interlacing.
 */
function readRgbPng(bytes: Uint8Array): { width: number; height: number; rgb: Uint8Array } {
  expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let width = 0;
  let height = 0;
  const idat: Uint8Array[] = [];

  while (at < bytes.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const data = bytes.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      const head = new DataView(data.buffer, data.byteOffset, data.byteLength);
      width = head.getUint32(0);
      height = head.getUint32(4);
      expect(data[8]).toBe(8); // bit depth
      expect(data[9]).toBe(2); // colour type: truecolour RGB
    }
    if (type === 'IDAT') idat.push(new Uint8Array(data));
    at += 12 + length;
  }

  const joined = new Uint8Array(idat.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of idat) {
    joined.set(part, offset);
    offset += part.length;
  }
  const raw = unzlibSync(joined);
  const rowBytes = width * 3;
  const rgb = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y++) {
    expect(raw[y * (rowBytes + 1)]).toBe(0); // filter type "None"
    rgb.set(raw.subarray(y * (rowBytes + 1) + 1, (y + 1) * (rowBytes + 1)), y * rowBytes);
  }
  return { width, height, rgb };
}

function rgbToImageData(width: number, height: number, rgb: Uint8Array) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    data[p * 4] = rgb[p * 3];
    data[p * 4 + 1] = rgb[p * 3 + 1];
    data[p * 4 + 2] = rgb[p * 3 + 2];
    data[p * 4 + 3] = 255;
  }
  return { data, width, height, colorSpace: 'srgb' as const };
}

/**
 * Rasterises a CODE128 bar/space string at a crisp, generous pixel scale —
 * this test is proving `encodeCode128Bars` produces a correct pattern, not
 * exercising the PDF-vector rendering path `process.worker.ts` actually
 * draws it through (see the comment on `encodeCode128Bars` for why that path
 * is vector rather than raster).
 */
function rasterizeBars(bars: string, moduleWidth = 8, height = 200, quiet = 10) {
  const width = (bars.length + quiet * 2) * moduleWidth;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let i = 0; i < bars.length; i++) {
    if (bars[i] !== '1') continue;
    for (let y = 0; y < height; y++) {
      for (let dx = 0; dx < moduleWidth; dx++) {
        const x = (quiet + i) * moduleWidth + dx;
        const idx = (y * width + x) * 4;
        data[idx] = 0;
        data[idx + 1] = 0;
        data[idx + 2] = 0;
      }
    }
  }
  return { data, width, height, colorSpace: 'srgb' as const };
}

describe('generateQrRaster (OPS-18)', () => {
  it('encodes text as a QR code an independent decoder reads back exactly', async () => {
    const text = 'https://example.com/doc/STAPLER-0001';
    const raster = generateQrRaster(text);
    const { width, height, rgb } = readRgbPng(raster.pngBytes);
    expect(width).toBe(raster.width);
    expect(height).toBe(raster.height);

    const results = await readBarcodes(rgbToImageData(width, height, rgb), { formats: ['QRCode'] });
    expect(results).toHaveLength(1);
    expect(results[0].isValid).toBe(true);
    expect(results[0].text).toBe(text);
  });

  it('produces a decodable QR code for each fixture text independently', async () => {
    for (const text of ['A', '1234567890', 'Invoice #2026-08-0099', 'short']) {
      const raster = generateQrRaster(text);
      const { width, height, rgb } = readRgbPng(raster.pngBytes);
      const results = await readBarcodes(rgbToImageData(width, height, rgb), {
        formats: ['QRCode']
      });
      expect(results[0]?.text).toBe(text);
    }
  });

  it('rejects empty input rather than encoding nothing', () => {
    expect(() => generateQrRaster('')).toThrow();
    expect(() => generateQrRaster('   ')).toThrow();
  });
});

describe('encodeCode128Bars (OPS-18)', () => {
  it('encodes text as a bar pattern an independent decoder reads back exactly', async () => {
    const text = 'DOC-ID-88421';
    const bars = encodeCode128Bars(text);
    expect(bars).toMatch(/^[01]+$/);

    const results = await readBarcodes(rasterizeBars(bars), { formats: ['Code128'] });
    expect(results).toHaveLength(1);
    expect(results[0].isValid).toBe(true);
    expect(results[0].text).toBe(text);
  });

  it('produces a decodable barcode for each fixture text independently', async () => {
    for (const text of ['A', '1234567890', 'INV-2026-0099', 'X']) {
      const bars = encodeCode128Bars(text);
      const results = await readBarcodes(rasterizeBars(bars), { formats: ['Code128'] });
      expect(results[0]?.text).toBe(text);
    }
  });

  it('rejects empty input rather than encoding nothing', () => {
    expect(() => encodeCode128Bars('')).toThrow();
    expect(() => encodeCode128Bars('   ')).toThrow();
  });
});

describe('decodeBarcodesFromImage (SCN-04)', () => {
  it('reads a known QR value off a planted bitmap', async () => {
    const text = 'STAPLER-SCAN-4471';
    const raster = generateQrRaster(text);
    const { width, height, rgb } = readRgbPng(raster.pngBytes);

    const found = await decodeBarcodesFromImage(rgbToImageData(width, height, rgb));
    expect(found).toEqual([{ text, format: 'QRCode' }]);
  });

  it('reads a known CODE128 value off a planted bitmap', async () => {
    const text = 'PLANTED-000123';
    const bars = encodeCode128Bars(text);

    const found = await decodeBarcodesFromImage(rasterizeBars(bars));
    expect(found).toEqual([{ text, format: 'Code128' }]);
  });

  it('reports none on a page with no barcode, not a false positive', async () => {
    // A blank page: solid white, the same "nothing here" a rendered text-only
    // PDF page would produce.
    const width = 400;
    const height = 500;
    const blank = { data: new Uint8ClampedArray(width * height * 4).fill(255), width, height };
    const found = await decodeBarcodesFromImage(blank);
    expect(found).toEqual([]);
  });

  it('reports none on plain text-shaped noise rather than guessing a match', async () => {
    // A handful of thin vertical bars that are not a real, checksummed
    // CODE128 pattern — close enough in appearance to a barcode that a naive
    // "any dark stripes" heuristic would be fooled, but a real decoder is not.
    const width = 300;
    const height = 200;
    const data = new Uint8ClampedArray(width * height * 4).fill(255);
    for (let x = 20; x < width - 20; x += 7) {
      for (let y = 0; y < height; y++) {
        const idx = (y * width + x) * 4;
        data[idx] = 0;
        data[idx + 1] = 0;
        data[idx + 2] = 0;
      }
    }
    const found = await decodeBarcodesFromImage({ data, width, height });
    expect(found).toEqual([]);
  });
});
