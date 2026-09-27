/**
 * GAP-6 — a baseline, single-component (greyscale) JPEG encoder.
 *
 * Why this exists: the browser's only JPEG encoder is `canvas.convertToBlob`,
 * which always writes three YCbCr components. Embedding that as `/DeviceGray`
 * is a component-count mismatch (a corrupt image), and embedding it as
 * `/DeviceRGB` leaves a colour image in a document the user asked to be
 * greyscale — and costs the chroma planes' bytes for nothing. A one-component
 * JPEG is the correct object, and it is small enough to write by hand: one
 * quantisation table, the two standard luminance Huffman tables (ITU T.81
 * Annex K), no subsampling.
 *
 * Pure — no DOM, no canvas — so the process worker can call it and the unit
 * tests can decode its output with pdf.js to prove it is a real JPEG.
 */

/** ITU T.81 Annex K.1, the example luminance quantisation table (natural order). */
const BASE_LUMA_QUANT = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113,
  92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99
];

/** Zig-zag order: `ZIGZAG[k]` is the natural index of the k-th coefficient. */
const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20,
  13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52,
  45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63
];

/* Annex K.3 — standard luminance DC and AC Huffman tables. */
const DC_LUMA_COUNTS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_LUMA_SYMBOLS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_LUMA_COUNTS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_LUMA_SYMBOLS = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
  0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
  0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
  0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
  0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
  0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
  0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa
];

interface HuffmanTable {
  codes: Uint16Array;
  lengths: Uint8Array;
}

/** Annex C — code assignment from the (counts, symbols) pair. */
function buildHuffman(counts: number[], symbols: number[]): HuffmanTable {
  const codes = new Uint16Array(256);
  const lengths = new Uint8Array(256);
  let code = 0;
  let k = 0;
  for (let length = 1; length <= 16; length++) {
    for (let i = 0; i < counts[length - 1]; i++) {
      codes[symbols[k]] = code;
      lengths[symbols[k]] = length;
      code++;
      k++;
    }
    code <<= 1;
  }
  return { codes, lengths };
}

const DC_TABLE = buildHuffman(DC_LUMA_COUNTS, DC_LUMA_SYMBOLS);
const AC_TABLE = buildHuffman(AC_LUMA_COUNTS, AC_LUMA_SYMBOLS);

/** libjpeg's quality → table scaling, clamped to the baseline 1..255 range. */
function quantTable(quality: number): Uint8Array {
  const q = Math.min(100, Math.max(1, Math.round(quality * 100)));
  const scale = q < 50 ? 5000 / q : 200 - q * 2;
  const table = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    table[i] = Math.min(255, Math.max(1, Math.floor((BASE_LUMA_QUANT[i] * scale + 50) / 100)));
  }
  return table;
}

/** Growable byte sink with the entropy coder's bit buffer. */
class ByteWriter {
  private buffer: Uint8Array;
  length = 0;
  private bitBuffer = 0;
  private bitCount = 0;

  constructor(initial: number) {
    this.buffer = new Uint8Array(Math.max(1024, initial));
  }

  private ensure(extra: number): void {
    if (this.length + extra <= this.buffer.length) return;
    let size = this.buffer.length * 2;
    while (size < this.length + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buffer.subarray(0, this.length));
    this.buffer = next;
  }

  byte(value: number): void {
    this.ensure(1);
    this.buffer[this.length++] = value & 0xff;
  }

  word(value: number): void {
    this.byte(value >> 8);
    this.byte(value);
  }

  bytes(values: ArrayLike<number>): void {
    this.ensure(values.length);
    for (let i = 0; i < values.length; i++) this.buffer[this.length++] = values[i] & 0xff;
  }

  /** Entropy-coded bits, most significant first, with 0xFF byte stuffing. */
  bits(code: number, count: number): void {
    this.bitBuffer = (this.bitBuffer << count) | (code & ((1 << count) - 1));
    this.bitCount += count;
    while (this.bitCount >= 8) {
      const byte = (this.bitBuffer >> (this.bitCount - 8)) & 0xff;
      this.byte(byte);
      if (byte === 0xff) this.byte(0);
      this.bitCount -= 8;
    }
    this.bitBuffer &= (1 << this.bitCount) - 1;
  }

  /** Pads the final partial byte with 1-bits, as T.81 F.1.2.3 requires. */
  flushBits(): void {
    if (this.bitCount > 0) this.bits((1 << (8 - this.bitCount)) - 1, 8 - this.bitCount);
  }

  result(): Uint8Array {
    return this.buffer.slice(0, this.length);
  }
}

/** Precomputed cosine table for the separable 8-point forward DCT. */
const COS = (() => {
  const table = new Float64Array(64);
  for (let u = 0; u < 8; u++) {
    const cu = u === 0 ? Math.SQRT1_2 : 1;
    for (let x = 0; x < 8; x++) table[u * 8 + x] = cu * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
  }
  return table;
})();

/** Forward DCT of one level-shifted 8×8 block, in place order: natural. */
function fdct(block: Float64Array, out: Float64Array, tmp: Float64Array): void {
  for (let y = 0; y < 8; y++) {
    for (let u = 0; u < 8; u++) {
      let sum = 0;
      for (let x = 0; x < 8; x++) sum += block[y * 8 + x] * COS[u * 8 + x];
      tmp[y * 8 + u] = sum / 2;
    }
  }
  for (let u = 0; u < 8; u++) {
    for (let v = 0; v < 8; v++) {
      let sum = 0;
      for (let y = 0; y < 8; y++) sum += tmp[y * 8 + u] * COS[v * 8 + y];
      out[v * 8 + u] = sum / 2;
    }
  }
}

/** Number of bits needed for the magnitude of `value` (the "category"). */
function category(value: number): number {
  let magnitude = value < 0 ? -value : value;
  let bits = 0;
  while (magnitude > 0) {
    bits++;
    magnitude >>= 1;
  }
  return bits;
}

/** The value's additional bits: ones' complement for negatives (F.1.2.1). */
function amplitude(value: number, bits: number): number {
  return value < 0 ? value + (1 << bits) - 1 : value;
}

export interface GrayJpegOptions {
  /** 0..1, the same scale `canvas.convertToBlob` takes. */
  quality: number;
  /** Cancellation/yield hook, called once per block row. */
  onRow?: (row: number, rows: number) => void;
}

/**
 * Encodes 8-bit greyscale samples (`width × height`, one byte each, top row
 * first) as a baseline JFIF JPEG with a single component.
 */
export function encodeGrayJpeg(
  samples: Uint8Array,
  width: number,
  height: number,
  options: GrayJpegOptions
): Uint8Array {
  if (!(width > 0 && height > 0) || width > 65535 || height > 65535) {
    throw new RangeError(`Cannot JPEG-encode a ${width}×${height} image`);
  }
  if (samples.length < width * height) {
    throw new RangeError('Fewer samples than width × height');
  }

  const quant = quantTable(options.quality);
  const out = new ByteWriter(Math.ceil((width * height) / 4) + 1024);

  // SOI
  out.word(0xffd8);
  // APP0 JFIF 1.01, no thumbnail, 1:1 aspect.
  out.word(0xffe0);
  out.word(16);
  out.bytes([0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  // DQT — table 0, 8-bit precision, zig-zag order.
  out.word(0xffdb);
  out.word(67);
  out.byte(0x00);
  for (let k = 0; k < 64; k++) out.byte(quant[ZIGZAG[k]]);
  // SOF0 — baseline, 8-bit, one component (id 1, 1×1 sampling, table 0).
  out.word(0xffc0);
  out.word(11);
  out.byte(8);
  out.word(height);
  out.word(width);
  out.byte(1);
  out.bytes([1, 0x11, 0]);
  // DHT — DC table 0, then AC table 0.
  out.word(0xffc4);
  out.word(2 + (1 + 16 + DC_LUMA_SYMBOLS.length) + (1 + 16 + AC_LUMA_SYMBOLS.length));
  out.byte(0x00);
  out.bytes(DC_LUMA_COUNTS);
  out.bytes(DC_LUMA_SYMBOLS);
  out.byte(0x10);
  out.bytes(AC_LUMA_COUNTS);
  out.bytes(AC_LUMA_SYMBOLS);
  // SOS — one component, tables 0/0, full spectral range.
  out.word(0xffda);
  out.word(8);
  out.byte(1);
  out.bytes([1, 0x00]);
  out.bytes([0, 63, 0]);

  const block = new Float64Array(64);
  const coeffs = new Float64Array(64);
  const tmp = new Float64Array(64);
  const quantised = new Int32Array(64);
  let previousDc = 0;
  const rows = Math.ceil(height / 8);
  const cols = Math.ceil(width / 8);

  for (let by = 0; by < rows; by++) {
    options.onRow?.(by, rows);
    for (let bx = 0; bx < cols; bx++) {
      // Edge blocks replicate the last row/column rather than padding with
      // black, which would ring into the visible pixels at the border.
      for (let y = 0; y < 8; y++) {
        const sy = Math.min(height - 1, by * 8 + y) * width;
        for (let x = 0; x < 8; x++) {
          const sx = Math.min(width - 1, bx * 8 + x);
          block[y * 8 + x] = samples[sy + sx] - 128;
        }
      }
      fdct(block, coeffs, tmp);
      for (let k = 0; k < 64; k++) {
        const natural = ZIGZAG[k];
        quantised[k] = Math.round(coeffs[natural] / quant[natural]);
      }

      // DC: difference from the previous block.
      const diff = quantised[0] - previousDc;
      previousDc = quantised[0];
      const dcBits = category(diff);
      out.bits(DC_TABLE.codes[dcBits], DC_TABLE.lengths[dcBits]);
      if (dcBits > 0) out.bits(amplitude(diff, dcBits), dcBits);

      // AC: run-length of zeros + category, ZRL for 16 zeros, EOB at the end.
      let run = 0;
      for (let k = 1; k < 64; k++) {
        const value = quantised[k];
        if (value === 0) {
          run++;
          continue;
        }
        while (run > 15) {
          out.bits(AC_TABLE.codes[0xf0], AC_TABLE.lengths[0xf0]);
          run -= 16;
        }
        const bits = category(value);
        const symbol = (run << 4) | bits;
        out.bits(AC_TABLE.codes[symbol], AC_TABLE.lengths[symbol]);
        out.bits(amplitude(value, bits), bits);
        run = 0;
      }
      if (run > 0) out.bits(AC_TABLE.codes[0x00], AC_TABLE.lengths[0x00]);
    }
  }

  out.flushBits();
  out.word(0xffd9);
  return out.result();
}
