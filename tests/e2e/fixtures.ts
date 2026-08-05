import {
  PDFDocument,
  PDFName,
  PDFRef,
  StandardFonts,
  concatTransformationMatrix,
  degrees,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
  rgb
} from 'pdf-lib';
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

/* ------------------------------------------------------------------ *
 * CMP-03 fixtures that pdf-lib cannot express through `embedPng`/`embedJpg`
 *
 * `embedPng` always writes a DeviceRGB/DeviceGray image, and always sizes an
 * alpha `/SMask` identically to its base image. So neither a real DeviceCMYK
 * image nor a colour/mask *resolution mismatch* is reachable through it — both
 * are hand-registered as raw image XObjects and drawn with a hand-written
 * `cm`/`Do` pair instead.
 * ------------------------------------------------------------------ */

const A4: [number, number] = [595.28, 841.89];

/** Registers `samples` as an 8-bit image XObject and returns its reference. */
function registerImageStream(
  doc: PDFDocument,
  samples: Uint8Array,
  width: number,
  height: number,
  colorSpace: 'DeviceRGB' | 'DeviceGray' | 'DeviceCMYK',
  extra: Record<string, PDFRef> = {}
): PDFRef {
  return doc.context.register(
    doc.context.flateStream(samples, {
      Type: 'XObject',
      Subtype: 'Image',
      Width: width,
      Height: height,
      ColorSpace: colorSpace,
      BitsPerComponent: 8,
      ...extra
    })
  );
}

/** Places an already-registered image XObject into `page` at a rectangle in points. */
function drawRawImage(
  page: ReturnType<PDFDocument['addPage']>,
  ref: PDFRef,
  name: string,
  box: { x: number; y: number; width: number; height: number }
): void {
  page.node.setXObject(PDFName.of(name), ref);
  page.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(box.width, 0, 0, box.height, box.x, box.y),
    drawObject(name),
    popGraphicsState()
  );
}

/**
 * A smooth, deterministic scalar field in [-1, 1].
 *
 * Deliberately low-frequency, and varying along *both* axes: no two rows are
 * alike, so Flate cannot crush a fixture built from it down to nothing, yet its
 * gradient is a fraction of a level per pixel, so downscaling and JPEG both
 * reproduce it almost exactly. That is what lets the colour-shift assertion use
 * a tight tolerance instead of measuring resampling noise.
 */
function smoothField(fx: number, fy: number): number {
  return 0.6 * Math.sin(fx * 11) * Math.cos(fy * 7) + 0.4 * Math.sin((fx + fy) * 5);
}

const clamp255 = (n: number) => Math.max(0, Math.min(255, Math.round(n)));

/**
 * Four vertical bands of known DeviceCMYK ink, for CMP-03's "the CMYK fixture
 * has no colour shift beyond a documented tolerance" criterion.
 *
 * Components are 8-bit samples, so 255 is full ink. Every band deliberately
 * keeps all four of its channels away from both ends of the range: a channel
 * swap, an inverted `/K`, or a naive `1 - min(1, ink + k)` conversion then each
 * move the rendered colour by tens of levels instead of hiding inside a
 * saturated clip.
 */
export const CMYK_BANDS = [
  { label: 'cyan', cmyk: [220, 34, 26, 24] },
  { label: 'magenta', cmyk: [30, 215, 40, 24] },
  { label: 'yellow', cmyk: [26, 40, 225, 24] },
  { label: 'shadow', cmyk: [72, 62, 56, 138] }
] as const;

/** Ink modulation depth, in 8-bit sample levels, applied via `smoothField`. */
const CMYK_BAND_MODULATION = 20;

const BAND_IMAGE_BOX = { x: 40, y: 400, width: 400, height: 300 };

/**
 * The four band centres as page fractions, derived from `BAND_IMAGE_BOX` so the
 * sampling points cannot drift away from the geometry they describe. Y is
 * measured from the top, which is what `samplePage` wants.
 */
export const BAND_SAMPLE_POINTS: [number, number][] = [0, 1, 2, 3].map(band => [
  (BAND_IMAGE_BOX.x + (BAND_IMAGE_BOX.width * (band + 0.5)) / 4) / A4[0],
  (A4[1] - (BAND_IMAGE_BOX.y + BAND_IMAGE_BOX.height / 2)) / A4[1]
]);

/**
 * A page of text plus one genuine DeviceCMYK image, over-sampled so the surgical
 * path acts on it: 1600×1200 stored, drawn at 400×300pt, i.e. 288 DPI against a
 * 150 DPI default.
 */
export async function cmykImagePdf(): Promise<Uint8Array> {
  const width = 1600;
  const height = 1200;
  const samples = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const band = CMYK_BANDS[Math.floor((x / width) * CMYK_BANDS.length)];
      const shift = CMYK_BAND_MODULATION * smoothField(x / width, y / height);
      const i = (y * width + x) * 4;
      for (let c = 0; c < 4; c++) samples[i + c] = clamp255(band.cmyk[c] + shift);
    }
  }

  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage(A4);
  page.drawText('CMYK fixture: cyan, magenta, yellow, and a K-built shadow.', {
    x: 40,
    y: 780,
    size: 14,
    font
  });
  page.drawText('Body text, so this page keeps a text layer and stays surgical.', {
    x: 40,
    y: 752,
    size: 11,
    font,
    color: rgb(0, 0, 0)
  });

  const ref = registerImageStream(doc, samples, width, height, 'DeviceCMYK');
  drawRawImage(page, ref, 'ImCmyk', BAND_IMAGE_BOX);
  return doc.save();
}

/**
 * The "small image, large mask" shape: a 100×2100 colour strip behind a 400×8400
 * soft mask — an /SMask carrying 16× as many samples as the image it modulates.
 * Nothing in the PDF spec ties the two resolutions together, and `embedPng`
 * cannot produce the mismatch, so both streams are registered by hand.
 *
 * Drawn at 40×800pt, i.e. 180 DPI down the page, so the page is picked for the
 * surgical route and the image is genuinely over-sampled for the 150 DPI default.
 *
 * Worth knowing when reading the assertions: pdf.js decodes an image at
 * `max(image, smask, mask)` in each axis (`PDFImage.drawWidth`/`drawHeight`), so
 * the pixels handed to the re-encoder for *this* fixture are 400×8400, not
 * 100×2100 — the base image is upsampled to meet its mask before anything else
 * happens. That is why the re-encoded output lands at the placement's target size
 * rather than at either stored resolution.
 */
export const OVERSIZED_MASK_FIXTURE = {
  colour: { width: 100, height: 2100 },
  mask: { width: 400, height: 8400 },
  box: { x: 40, y: 20, width: 40, height: 800 }
} as const;

export async function oversizedMaskPdf(): Promise<Uint8Array> {
  const { colour, mask, box } = OVERSIZED_MASK_FIXTURE;
  const colourSamples = photoPixels(colour.width, colour.height);

  const maskSamples = new Uint8Array(mask.width * mask.height);
  for (let y = 0; y < mask.height; y++) {
    for (let x = 0; x < mask.width; x++) {
      const fx = x / mask.width;
      const fy = y / mask.height;
      // Opaque down the left edge, then a soft horizontal ramp with a gentle
      // wobble, so the mask has real structure to preserve at either resolution.
      const alpha = 1.15 - fx * 0.9 + 0.2 * smoothField(fx * 3, fy);
      maskSamples[y * mask.width + x] = clamp255(255 * Math.max(0, Math.min(1, alpha)));
    }
  }

  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage(A4);
  page.drawText('Small image, large soft mask.', { x: 130, y: 790, size: 16, font });
  for (let line = 0; line < 12; line++) {
    page.drawText(`Body line ${line + 1}: the text layer keeps this page on the surgical path.`, {
      x: 130,
      y: 760 - line * 18,
      size: 11,
      font,
      color: rgb(0, 0, 0)
    });
  }

  const maskRef = registerImageStream(doc, maskSamples, mask.width, mask.height, 'DeviceGray');
  const colourRef = registerImageStream(
    doc,
    colourSamples,
    colour.width,
    colour.height,
    'DeviceRGB',
    {
      SMask: maskRef
    }
  );
  drawRawImage(page, colourRef, 'ImStrip', box);
  return doc.save();
}
