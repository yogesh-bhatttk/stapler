import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import path from 'node:path';

export const FIXTURES_DIR = path.resolve(process.cwd(), 'tests/fixtures');

/**
 * Fixtures are generated rather than committed (QA-01 asks for the corpus to stay a
 * reasonable repo size). Generation is deterministic, so a golden comparison is stable.
 */
export async function ensureFixture(
  name: string,
  build: () => Promise<Uint8Array>
): Promise<string> {
  mkdirSync(FIXTURES_DIR, { recursive: true });
  const file = path.join(FIXTURES_DIR, name);
  if (!existsSync(file)) writeFileSync(file, await build());
  return file;
}

/** A text document with a predictable page count and per-page marker text. */
export async function textPdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([595.28, 841.89]);
    page.drawText(`Stapler fixture page ${i + 1}`, { x: 56, y: 780, size: 18, font });
    for (let line = 0; line < 24; line++) {
      page.drawText(`Line ${line + 1} of body text on page ${i + 1}.`, {
        x: 56,
        y: 720 - line * 22,
        size: 11,
        font,
        color: rgb(0, 0, 0)
      });
    }
  }
  return doc.save();
}

/* ------------------------------------------------------------------ *
 * Image fixtures for CMP-03
 *
 * Built with a small PNG encoder rather than an external tool, so the corpus
 * stays reproducible on a bare checkout (the static fixtures that *do* need
 * ImageMagick are committed instead — see tests/fixtures/README.md).
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const body = new Uint8Array(type.length + data.length);
  for (let i = 0; i < type.length; i++) body[i] = type.charCodeAt(i);
  body.set(data, type.length);
  const out = new Uint8Array(body.length + 8);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(body, 4);
  view.setUint32(out.length - 4, crc32(body));
  return out;
}

/** 8-bit PNG, no filtering, from raw RGB or RGBA samples. */
function encodePng(pixels: Uint8Array, width: number, height: number, alpha: boolean): Uint8Array {
  const channels = alpha ? 4 : 3;
  const stride = width * channels;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type: none
    raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = alpha ? 6 : 2;
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', new Uint8Array(deflateSync(raw, { level: 9 }))),
    pngChunk('IEND', new Uint8Array(0))
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const png = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    png.set(part, at);
    at += part.length;
  }
  return png;
}

/**
 * A deterministic photograph stand-in: smooth gradients, one bright blob, and a
 * little grain — compressible enough to be realistic, detailed enough that JPEG
 * has something to do.
 */
function photoPixels(width: number, height: number): Uint8Array {
  const px = new Uint8Array(width * height * 3);
  let seed = 20260804;
  const grain = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed / 0x7fffffff - 0.5) * 10;
  };
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const fx = x / width;
      const fy = y / height;
      const blob = Math.exp(-(((fx - 0.35) ** 2 + (fy - 0.4) ** 2) / 0.03));
      px[i] = clamp(40 + 180 * fx + 60 * blob + grain());
      px[i + 1] = clamp(90 + 120 * fy - 40 * blob + grain());
      px[i + 2] = clamp(200 - 120 * fx * fy + grain());
    }
  }
  return px;
}

/**
 * Four vertical bands of known colour and known alpha, in an image large enough
 * to be re-encoded (CMP-03 only touches over-sampled images) and coarse enough
 * that a renderer's downsampling cannot smear one band into the next.
 *
 * `smaskPdf()` above is a 2×2 image: it proves an /SMask can be *parsed*, but it
 * is far below the re-encode threshold and has no sampleable interior, so it
 * cannot show whether transparency survives compression. This can.
 */
export const TRANSPARENCY_BANDS = [
  { rgb: [220, 30, 40], alpha: 255 },
  { rgb: [30, 200, 90], alpha: 128 },
  { rgb: [40, 80, 230], alpha: 0 },
  { rgb: [240, 200, 20], alpha: 255 }
] as const;

export async function transparentImagePdf(): Promise<Uint8Array> {
  const width = 1600;
  const height = 1200;
  const px = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const band = TRANSPARENCY_BANDS[Math.floor((x / width) * TRANSPARENCY_BANDS.length)];
      const i = (y * width + x) * 4;
      // A gentle vertical shade keeps the JPEG honest without moving the centre
      // of each band, which is what the pixel assertions sample.
      const shade = 1 - (y / height) * 0.15;
      px[i] = Math.round(band.rgb[0] * shade);
      px[i + 1] = Math.round(band.rgb[1] * shade);
      px[i + 2] = Math.round(band.rgb[2] * shade);
      px[i + 3] = band.alpha;
    }
  }

  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595.28, 841.89]);
  page.drawText('Transparency fixture: opaque, half, clear, opaque.', {
    x: 40,
    y: 780,
    size: 14,
    font
  });
  const image = await doc.embedPng(encodePng(px, width, height, true));
  // 400×300pt from a 1600×1200 source is 288 DPI — over-sampled for the 150 DPI
  // default, so the surgical path acts on it.
  page.drawImage(image, { x: 40, y: 400, width: 400, height: 300 });
  return doc.save();
}

/**
 * A document containing both text and a substantial raster image.
 *
 * Pass `jpeg` to embed an already-compressed photo, which is the realistic shape
 * of the mixed document PLAN §4.1 projects 30–70% for. Without it the image is
 * stored Flate-encoded, and re-encoding then saves far more than that band —
 * accurate, but not evidence for the band.
 */
export async function mixedTextImagePdf(jpeg?: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595.28, 841.89]);
  page.drawText('Mixed text and image', { x: 40, y: 790, size: 18, font });
  for (let i = 0; i < 14; i++) {
    page.drawText(`Body line ${i + 1}: the quick brown fox jumps over the lazy dog.`, {
      x: 40,
      y: 758 - i * 18,
      size: 11,
      font,
      color: rgb(0, 0, 0)
    });
  }
  const image = jpeg
    ? await doc.embedJpg(jpeg)
    : await doc.embedPng(encodePng(photoPixels(1600, 1200), 1600, 1200, false));
  page.drawImage(image, { x: 40, y: 120, width: 450, height: 338 });
  return doc.save();
}

/** The same image on every page, for the encode-once acceptance criterion. */
export async function sharedImagePdf(pageCount = 10): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const image = await doc.embedPng(encodePng(photoPixels(1600, 1200), 1600, 1200, false));
  for (let p = 0; p < pageCount; p++) {
    const page = doc.addPage([595.28, 841.89]);
    page.drawText(`Shared image page ${p + 1} of ${pageCount}`, {
      x: 40,
      y: 790,
      size: 14,
      font
    });
    for (let i = 0; i < 10; i++) {
      page.drawText(`Page ${p + 1} body line ${i + 1}, enough text to keep the page surgical.`, {
        x: 40,
        y: 758 - i * 18,
        size: 11,
        font
      });
    }
    page.drawImage(image, { x: 40, y: 120, width: 450, height: 338 });
  }
  return doc.save();
}

/** Mixed page sizes, for the merge and normalise assertions. */
export async function mixedSizePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const [label, size] of [
    ['A4', [595.28, 841.89]],
    ['Letter', [612, 792]],
    ['Legal', [612, 1008]]
  ] as const) {
    const page = doc.addPage(size as [number, number]);
    page.drawText(`${label} page`, { x: 40, y: size[1] - 60, size: 20, font });
  }
  return doc.save();
}

/** 300-page document for memory limit testing */
export async function largePdf(): Promise<Uint8Array> {
  return textPdf(300);
}

/** Document with pages rotated 90, 180, 270 degrees to test normalization */
export async function rotatedPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  const angles = [90, 180, 270, 0];
  for (let i = 0; i < angles.length; i++) {
    const page = doc.addPage([595.28, 841.89]);
    page.setRotation(degrees(angles[i]));
    page.drawText(`Rotated ${angles[i]} degrees`, { x: 200, y: 400, size: 20, font });
  }

  return doc.save();
}

/** Contains interactive text fields and checkboxes to test filling */
export async function acroformPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]);

  const form = doc.getForm();

  const textField = form.createTextField('name.first');
  textField.setText('Jane');
  textField.addToPage(page, { x: 50, y: 700, width: 200, height: 30 });

  const checkbox = form.createCheckBox('agreed');
  checkbox.check();
  checkbox.addToPage(page, { x: 50, y: 650, width: 30, height: 30 });

  return doc.save();
}

/** A truncated PDF to test error taxonomy and recovery */
export async function corruptPdf(): Promise<Uint8Array> {
  const valid = await textPdf(1);
  // Truncate the last 500 bytes (which removes the xref table and trailer)
  return valid.slice(0, valid.length - 500);
}

/**
 * A large file (~20MB) to test memory safety and chunked processing.
 * We generate this by creating many large unique objects.
 */
export async function heavyPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  // Create 100 pages with lots of distinct text to bloat the file
  for (let i = 0; i < 100; i++) {
    const page = doc.addPage([595.28, 841.89]);
    for (let j = 0; j < 50; j++) {
      // Create a unique long string so it doesn't get deduplicated easily
      const longText = Array(100)
        .fill(`Heavy page ${i} line ${j} padding ` + Math.random())
        .join(' ');
      page.drawText(longText.slice(0, 50), { x: 10, y: 800 - j * 15, size: 8, font });
    }
  }
  return doc.save({ useObjectStreams: false }); // Avoid compressing objects to ensure file size is actually large
}

/**
 * Contains transparency (SMask) to test conservative re-encoding paths.
 * We generate this by embedding a PNG with alpha channel.
 */
export async function smaskPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]);

  // A 2x2 PNG with transparency (alpha channel)
  const transparentPngBytes = new Uint8Array([
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 2, 0, 0, 0, 2, 8, 6, 0,
    0, 0, 114, 182, 13, 36, 0, 0, 0, 16, 73, 68, 65, 84, 120, 156, 99, 252, 255, 255, 63, 3, 3, 3,
    3, 3, 19, 0, 18, 127, 4, 182, 219, 13, 40, 48, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130
  ]);

  const pngImage = await doc.embedPng(transparentPngBytes);
  page.drawImage(pngImage, {
    x: 100,
    y: 600,
    width: 200,
    height: 200
  });

  return doc.save();
}
