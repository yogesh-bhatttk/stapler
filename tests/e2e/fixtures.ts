import {
  PDFDict,
  PDFDocument,
  PDFName,
  PDFHexString,
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

/** The chapter starts used by the bookmarked fixture, in page order (0-based). */
export const BOOKMARK_CHAPTERS = [
  { title: 'Cover', page: 0 },
  { title: 'Chapter 2: Costs', page: 3 },
  { title: 'Appendix', page: 6 }
];

export async function contractV1Pdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595.28, 841.89]);
  page.drawText('Independent Contractor Agreement', { x: 50, y: 780, size: 18, font });
  page.drawText('This agreement is between Company A and Contractor B.', {
    x: 50,
    y: 740,
    size: 12,
    font
  });
  page.drawText('The contractor will be paid $50 per hour.', { x: 50, y: 700, size: 12, font });
  page.drawText('Confidentiality: The contractor shall not disclose trade secrets.', {
    x: 50,
    y: 660,
    size: 12,
    font
  });
  page.drawText('Governing Law: California', { x: 50, y: 620, size: 12, font });
  return doc.save();
}

export async function contractV2Pdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595.28, 841.89]);
  page.drawText('Independent Contractor Agreement', { x: 50, y: 780, size: 18, font });
  page.drawText('This agreement is between Company A and Contractor B.', {
    x: 50,
    y: 740,
    size: 12,
    font
  });
  page.drawText('The contractor will be paid $75 per hour.', { x: 50, y: 700, size: 12, font });
  page.drawText('The contractor will also receive a 10% bonus.', { x: 50, y: 680, size: 12, font }); // Insertion
  page.drawText(
    'Confidentiality: The contractor shall not disclose trade secrets or proprietary info.',
    { x: 50, y: 660, size: 12, font }
  );
  page.drawText('Governing Law: New York', { x: 50, y: 620, size: 12, font }); // Modification
  return doc.save();
}

/**
 * A 9-page document carrying a real `/Outlines` tree — the fixture OPS-10's editor
 * and OPS-12's split mode both need. Written by hand because pdf-lib has no outline
 * API, the same reason `process.worker.ts` walks the raw dictionaries.
 */
export async function bookmarkedPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.load(await textPdf(9));
  const ctx = doc.context;
  const pages = doc.getPages();
  const outlines = ctx.obj({ Type: 'Outlines' });
  const outlinesRef = ctx.register(outlines);

  let firstRef: PDFRef | undefined;
  let prevRef: PDFRef | undefined;
  let lastRef: PDFRef | undefined;
  for (const chapter of BOOKMARK_CHAPTERS) {
    const dict = ctx.obj({
      Title: PDFHexString.fromText(chapter.title),
      Parent: outlinesRef,
      Dest: [pages[chapter.page].ref, PDFName.of('Fit')]
    });
    const ref = ctx.register(dict);
    if (!firstRef) firstRef = ref;
    if (prevRef) {
      ctx.lookup(prevRef, PDFDict).set(PDFName.of('Next'), ref);
      dict.set(PDFName.of('Prev'), prevRef);
    }
    prevRef = ref;
    lastRef = ref;
  }

  outlines.set(PDFName.of('First'), firstRef!);
  outlines.set(PDFName.of('Last'), lastRef!);
  doc.catalog.set(PDFName.of('Outlines'), outlinesRef);
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

/**
 * The same image object drawn at a small size on page 1 and full-bleed on the
 * last page — for the "shared image sized at its largest use, not whichever
 * page is processed first" acceptance criterion.
 */
export async function sharedImageDifferentSizesPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const image = await doc.embedPng(encodePng(photoPixels(1600, 1200), 1600, 1200, false));

  const small = doc.addPage([595.28, 841.89]);
  small.drawText('Small placement page', { x: 40, y: 790, size: 14, font });
  for (let i = 0; i < 10; i++) {
    small.drawText(`Body line ${i + 1}, enough text to keep the page surgical.`, {
      x: 40,
      y: 758 - i * 18,
      size: 11,
      font
    });
  }
  // A tiny thumbnail — the "processed first, size everyone else inherited" case.
  small.drawImage(image, { x: 40, y: 100, width: 60, height: 45 });

  const large = doc.addPage([595.28, 841.89]);
  large.drawText('Full-bleed placement page', { x: 40, y: 790, size: 14, font });
  for (let i = 0; i < 10; i++) {
    large.drawText(`Body line ${i + 1}, enough text to keep the page surgical.`, {
      x: 40,
      y: 758 - i * 18,
      size: 11,
      font
    });
  }
  large.drawImage(image, { x: 0, y: 0, width: 595.28, height: 446 });

  return doc.save();
}

/**
 * Three pages whose image area deliberately climbs: text only, a small image,
 * then a large one.
 *
 * CMP-05's preview claims to show "the page with the most image area", and a
 * one-page fixture cannot tell that apart from "the first page". Every page
 * carries a real text layer so the whole document stays on the surgical route
 * and the preview is judging image quality rather than a rasterised page.
 */
export async function imageOnLastPagePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const small = await doc.embedPng(encodePng(photoPixels(400, 300), 400, 300, false));
  const large = await doc.embedPng(encodePng(photoPixels(1600, 1200), 1600, 1200, false));

  for (let p = 0; p < 3; p++) {
    const page = doc.addPage([595.28, 841.89]);
    page.drawText(`Page ${p + 1} of 3`, { x: 40, y: 790, size: 14, font });
    for (let i = 0; i < 12; i++) {
      page.drawText(`Body line ${i + 1}: the quick brown fox jumps over the lazy dog.`, {
        x: 40,
        y: 758 - i * 18,
        size: 11,
        font
      });
    }
    if (p === 1) page.drawImage(small, { x: 40, y: 300, width: 200, height: 150 });
    if (p === 2) page.drawImage(large, { x: 40, y: 120, width: 450, height: 338 });
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

/**
 * SGN-07's fixture: three numeric input fields and one empty field meant to hold
 * their total.
 *
 * `Line Total` carries a space on purpose. PDF field names commonly contain
 * spaces, and a formula language whose references are an identifier regex cannot
 * address them at all — this is the fixture that proves the document's own field
 * list drives the tokenizer.
 */
export async function calculatedFormPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]);
  const form = doc.getForm();

  const rows: [string, string][] = [
    ['subtotal', '100'],
    ['tax', '7.5'],
    ['shipping', '12.25']
  ];
  let y = 700;
  for (const [name, value] of rows) {
    const field = form.createTextField(name);
    field.setText(value);
    field.addToPage(page, { x: 50, y, width: 200, height: 30 });
    y -= 50;
  }

  // The calculated target: an ordinary, empty text field. Nothing about it is
  // special in the document — the formula lives in Stapler, not in the PDF.
  const total = form.createTextField('Line Total');
  total.addToPage(page, { x: 50, y, width: 200, height: 30 });

  // A non-numeric field, so a test can prove a bad reference is an error rather
  // than a silent zero.
  const note = form.createTextField('note');
  note.setText('paid in cash');
  note.addToPage(page, { x: 50, y: y - 50, width: 200, height: 30 });

  return doc.save();
}

/** The string baked in by the annotated fixture's `/FreeText` appearance. */
export const ANNOTATION_TEXT = 'Reviewed by QA';

/**
 * SGN-05's fixture: a page carrying real annotation dictionaries of the kinds a
 * flatten has to tell apart.
 *
 * Written by hand because pdf-lib has no annotation API beyond widgets, which is
 * the same reason `flattenAnnotations` walks raw dictionaries.
 *
 * - `/FreeText` with a `/Matrix` that is *not* the identity, so a flatten that
 *   ignores `/Matrix` draws it at twice the size and fails the assertion.
 * - `/Square` whose `/BBox` is half its `/Rect`, so the rect-fitting scale is
 *   exercised too.
 * - `/Link`, which has no appearance at all and must be dropped, not baked.
 * - `/Text` flagged Hidden, which draws nothing on screen and so must not
 *   suddenly appear in the flattened page.
 */
export async function annotatedPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.load(await textPdf(1));
  const ctx = doc.context;
  const page = doc.getPage(0);
  const font = await doc.embedFont(StandardFonts.Helvetica);

  const appearance = (contents: string, bbox: number[], matrix?: number[]) =>
    ctx.register(
      ctx.stream(contents, {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: bbox,
        Resources: { Font: { Helv: font.ref } },
        ...(matrix ? { Matrix: matrix } : {})
      })
    );

  // /Matrix scales by 2, so the 100x10 BBox covers the 200x20 /Rect exactly and
  // the fitting transform must come out as a pure translate.
  const freeText = ctx.register(
    ctx.obj({
      Type: 'Annot',
      Subtype: 'FreeText',
      Rect: [50, 700, 250, 720],
      F: 4,
      Contents: PDFHexString.fromText(ANNOTATION_TEXT),
      AP: {
        N: appearance(
          `BT /Helv 6 Tf 0 0 0 rg 1 2 Td (${ANNOTATION_TEXT}) Tj ET`,
          [0, 0, 100, 10],
          [2, 0, 0, 2, 0, 0]
        )
      }
    })
  );

  const square = ctx.register(
    ctx.obj({
      Type: 'Annot',
      Subtype: 'Square',
      Rect: [300, 400, 350, 450],
      AP: { N: appearance('1 0 0 RG 2 w 1 1 98 98 re S', [0, 0, 100, 100]) }
    })
  );

  const link = ctx.register(
    ctx.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [50, 100, 200, 120],
      Border: [0, 0, 0]
    })
  );

  const hidden = ctx.register(
    ctx.obj({
      Type: 'Annot',
      Subtype: 'Text',
      Rect: [400, 700, 420, 720],
      // Bit 2 (Hidden) — the viewer draws nothing, so nor may the flatten.
      F: 2,
      AP: { N: appearance('BT /Helv 12 Tf 0 0 Td (SHOULD NOT APPEAR) Tj ET', [0, 0, 20, 20]) }
    })
  );

  page.node.set(PDFName.of('Annots'), ctx.obj([freeText, square, link, hidden]));
  return doc.save();
}

/** A truncated PDF to test error taxonomy and recovery */
export async function corruptPdf(): Promise<Uint8Array> {
  const valid = await textPdf(1);
  // Truncate the last 500 bytes (which removes the xref table and trailer)
  return valid.slice(0, valid.length - 500);
}

/**
 * A large file (~5MB) to test memory safety, chunked processing, and the
 * "10 × 5MB merge in <8s" performance budget.
 *
 * The previous version ran a "noise" buffer through PNG/DEFLATE before
 * embedding it, on the assumption that pseudo-random bytes are incompressible
 * — they are not, for a plain linear congruential generator: `deflateSync`
 * collapses the intended 5.76MB buffer down to ~55KB (a ~104x ratio, far
 * beyond what's possible for genuinely random data), so the "heavy" fixture
 * was actually ~70KB on disk. Every test budgeted against "10 × 5MB" was
 * really exercising 10 × ~7KB. Embedding the pixel data as a raw, unfiltered
 * image XObject (no `/Filter` at all) sidesteps the question entirely: the
 * output size is the pixel buffer's size, deterministically, regardless of
 * how compressible its content turns out to be.
 */
export async function heavyPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();

  // 1350 x 1350 x 3 (RGB, no alpha) = ~5.47MB of raw pixel data, safely over
  // the 5MB-per-file budget the merge test asserts against (with margin for
  // the ~4KB of page/xref overhead added on top).
  const width = 1350;
  const height = 1350;
  const px = new Uint8Array(width * height * 3);
  let seed = 12345;
  for (let i = 0; i < px.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    px[i] = (seed >> 16) & 0xff;
  }

  const imageStream = doc.context.stream(px, {
    Type: 'XObject',
    Subtype: 'Image',
    Width: width,
    Height: height,
    ColorSpace: 'DeviceRGB',
    BitsPerComponent: 8
  });
  const imageRef = doc.context.register(imageStream);

  // Ten pages sharing one indirect object: the same dedup property the PNG
  // version relied on, but now the shared object is genuinely ~5MB rather
  // than however small DEFLATE happened to make it.
  for (let i = 0; i < 10; i++) {
    const page = doc.addPage([595.28, 841.89]);
    (page.node.Resources() as PDFDict).set(
      PDFName.of('XObject'),
      doc.context.obj({ Im0: imageRef })
    );
    page.node.set(
      PDFName.of('Contents'),
      doc.context.register(doc.context.flateStream('q 595.28 0 0 841.89 0 0 cm /Im0 Do Q'))
    );
  }

  return doc.save({ useObjectStreams: false });
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

/* ------------------------------------------------------------------ *
 * RED-04 — metadata disclosure fixture
 * ------------------------------------------------------------------ */

/**
 * The exact strings the metadata tests assert on, exported so the unit test, the
 * e2e test, and the generator cannot drift apart.
 */
export const METADATA_LEAK = {
  author: 'Grace Hopper',
  /** Lives in a custom Info key, the way a Word/Acrobat plugin writes it. */
  sourcePath: 'C:\\Users\\ghopper\\Documents\\Q3\\board-pack.docx',
  /** A second copy inside the Producer string — the one users never expect. */
  producerPath: 'C:\\Users\\ghopper\\AppData\\Local\\Acme\\engine.dll',
  /** A third copy inside the XMP packet, which survives an Info-only scrub. */
  xmpPath: 'C:\\Users\\ghopper\\Desktop\\drafts',
  javascript: 'app.alert("stapler fixture");'
} as const;

/**
 * A document whose metadata carries an author name and a Windows user path in the
 * three places a path actually hides — a custom Info key, the Producer string, and
 * the XMP packet — plus a document-level JavaScript action. RED-04's acceptance
 * criteria are asserted against this file.
 */
export async function metadataLeakPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595.28, 841.89]);
  page.drawText('Quarterly board pack', { x: 56, y: 780, size: 18, font });
  page.drawText('The body text is unrelated to the metadata under test.', {
    x: 56,
    y: 740,
    size: 11,
    font
  });

  doc.setTitle('Q3 board pack');
  doc.setAuthor(METADATA_LEAK.author);
  doc.setCreator('Acme Report Writer 4.2');
  doc.setProducer(`Acme PDF Engine (${METADATA_LEAK.producerPath})`);

  const info = doc.context.lookup(doc.context.trailerInfo.Info, PDFDict);
  // A hex string, not `PDFString.of`: pdf-lib writes a literal string verbatim without
  // escaping backslashes, so `C:\Users\…` would come back out of its own parser as
  // `C:Usersghopper…` (the `\U`/`\b` sequences swallowed). Real producers write the
  // Info dictionary as UTF-16 hex, which is also what pdf-lib's own setters emit.
  info.set(PDFName.of('SourceFile'), PDFHexString.fromText(METADATA_LEAK.sourcePath));

  // XMP, stored unfiltered as the convention is, so a viewer (and the inspector)
  // can read the packet without decoding it.
  const xmp = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:xmp="http://ns.adobe.com/xap/1.0/">
   <dc:creator><rdf:Seq><rdf:li>${METADATA_LEAK.author}</rdf:li></rdf:Seq></dc:creator>
   <xmp:CreatorTool>Acme Report Writer 4.2</xmp:CreatorTool>
   <xmp:Label>${METADATA_LEAK.xmpPath}</xmp:Label>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
  const xmpRef = doc.context.register(
    doc.context.stream(xmp, { Type: 'Metadata', Subtype: 'XML' })
  );
  doc.catalog.set(PDFName.of('Metadata'), xmpRef);

  // Document-level JavaScript, reached through the Names tree the way Acrobat writes it.
  const actionRef = doc.context.register(
    doc.context.obj({
      Type: 'Action',
      S: 'JavaScript',
      JS: PDFHexString.fromText(METADATA_LEAK.javascript)
    })
  );
  const jsTree = doc.context.obj({
    Names: [PDFHexString.fromText('StaplerFixture'), actionRef]
  });
  const names = doc.context.obj({ JavaScript: jsTree });
  doc.catalog.set(PDFName.of('Names'), names);

  return doc.save();
}

/* ------------------------------------------------------------------ *
 * CNV-08 — PDF → Word
 * ------------------------------------------------------------------ */

/**
 * The exact content CNV-08's acceptance criteria are stated against, exported so
 * the round-trip test asserts against these strings rather than against a copy of
 * them that can drift from the fixture.
 */
export const PDF_TO_WORD = {
  h1: 'Quarterly Operations Report',
  h2: 'Revenue by region',
  appendixH2: 'Appendix A: method',
  paragraph: [
    'This document exists so a converter can be graded against a page whose',
    'structure is known: one title, one wrapped paragraph, a run of bold and a',
    'run of italic text, a three column table, and one embedded raster image.'
  ],
  boldRun: '12 percent',
  italicRun: 'restated',
  appendixParagraph: [
    'The appendix page carries the image, so the conversion has to place content',
    'from two different source pages into one Word document.'
  ],
  /** Header row first, in reading order. Column x-positions are 56 / 250 / 420. */
  table: [
    ['Region', 'Revenue', 'Change'],
    ['North', '1,204', 'plus 8'],
    ['South', '987', 'plus 3'],
    ['East', '1,455', 'plus 12']
  ],
  image: { width: 480, height: 320 }
} as const;

/**
 * A two-page document with a title, a wrapped paragraph, inline bold and italic
 * runs, a real three-column table, and an embedded PNG (CNV-08).
 *
 * Everything is positioned rather than laid out by a producer, so the geometry the
 * heuristics read is exactly what this builder wrote:
 *
 *  • Type sizes are 22 / 14 / 11pt. 11pt covers the most characters, so it is the
 *    body size; 22 clears the level-1 ratio (1.6x) and 14 clears the promotion
 *    ratio (1.25x) without reaching level 1.
 *  • The paragraph's own leading is 14pt and the gaps around the headings are 40
 *    and 52pt, so the paragraph-break threshold falls between them and the three
 *    wrapped lines become one paragraph rather than three.
 *  • Table cells are drawn as separate `drawText` calls 190pt apart — far beyond
 *    the widest word space a justified line can stretch to, which is what tells a
 *    table row apart from a sentence.
 *  • The bold and italic runs sit immediately after the text they follow, so their
 *    gaps are near zero and the line stays a single-cell paragraph.
 */
export async function pdfToWordPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const body = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const italic = await doc.embedFont(StandardFonts.HelveticaOblique);

  const one = doc.addPage([612, 792]);
  one.drawText(PDF_TO_WORD.h1, { x: 56, y: 730, size: 22, font: bold });
  PDF_TO_WORD.paragraph.forEach((line, i) => {
    one.drawText(line, { x: 56, y: 690 - i * 14, size: 11, font: body });
  });
  one.drawText(PDF_TO_WORD.h2, { x: 56, y: 610, size: 14, font: bold });

  // One line, four runs, three fonts: "Revenue rose <b>12 percent</b> against a
  // <i>restated</i> baseline." Each run starts where the previous one ended.
  let x = 56;
  const inline: [string, typeof body][] = [
    ['Revenue rose ', body],
    [PDF_TO_WORD.boldRun, bold],
    [' against a ', body],
    [PDF_TO_WORD.italicRun, italic],
    [' baseline.', body]
  ];
  for (const [text, font] of inline) {
    one.drawText(text, { x, y: 580, size: 11, font });
    x += font.widthOfTextAtSize(text, 11);
  }

  const columnX = [56, 250, 420];
  PDF_TO_WORD.table.forEach((row, r) => {
    row.forEach((cell, c) => {
      one.drawText(cell, {
        x: columnX[c],
        y: 540 - r * 20,
        size: 11,
        font: r === 0 ? bold : body
      });
    });
  });

  const two = doc.addPage([612, 792]);
  two.drawText(PDF_TO_WORD.appendixH2, { x: 56, y: 730, size: 14, font: bold });
  PDF_TO_WORD.appendixParagraph.forEach((line, i) => {
    two.drawText(line, { x: 56, y: 700 - i * 14, size: 11, font: body });
  });
  const { width, height } = PDF_TO_WORD.image;
  const image = await doc.embedPng(encodePng(photoPixels(width, height), width, height, false));
  two.drawImage(image, { x: 56, y: 340, width: 360, height: 240 });

  return doc.save();
}

/* ------------------------------------------------------------------ *
 * CNV-09 — Word → PDF
 * ------------------------------------------------------------------ */

/**
 * The exact content CNV-09's acceptance criteria are stated against, exported so
 * the round-trip test asserts against these strings rather than against a copy of
 * them that can drift from the fixture.
 *
 * Same content *categories* as `PDF_TO_WORD` — headings, a wrapped paragraph,
 * bold and italic runs, a three-column table, an image — plus the two the
 * opposite direction adds: a bulleted list and a numbered one, which a `.docx`
 * states outright and a PDF's geometry never could.
 */
export const WORD_TO_PDF = {
  h1: 'Quarterly Operations Report',
  h2: 'Revenue by region',
  appendixH2: 'Appendix A: method',
  paragraph:
    'This document exists so a converter can be graded against a file whose structure is ' +
    'known: one title, one wrapped paragraph, a run of bold and a run of italic text, two ' +
    'lists, a three column table, and one embedded raster image.',
  boldRun: '12 percent',
  italicRun: 'restated',
  /** The sentence the bold and italic runs sit inside, as one flat string. */
  inlineSentence: 'Revenue rose 12 percent against a restated baseline.',
  bullets: ['Collected from the regional ledgers', 'Reconciled against the general ledger'],
  numbered: ['Extract', 'Reconcile', 'Report'],
  /** Header row first, in reading order. */
  table: [
    ['Region', 'Revenue', 'Change'],
    ['North', '1,204', 'plus 8'],
    ['South', '987', 'plus 3'],
    ['East', '1,455', 'plus 12']
  ],
  appendixParagraph:
    'The appendix section carries the image, so the conversion has to place a raster it ' +
    'decoded from a data URI onto a page it laid out itself.',
  image: { width: 480, height: 320 }
} as const;

/**
 * A `.docx` with the same content categories as `pdfToWordPdf()`, built with the
 * `docx` package rather than committed as a binary — the same policy the rest of
 * this file follows, and the reason a fixture can be read as source instead of
 * being taken on trust.
 *
 * The header row is bold so the round trip can prove CNV-09 carries character
 * formatting *into* table cells, which is the one thing CNV-08 states it cannot
 * carry out of them (`docs/TICKETS.md`, CNV-08 limitation 3).
 */
export async function wordToPdfDocx(): Promise<Uint8Array> {
  const {
    Document,
    HeadingLevel,
    ImageRun,
    Packer,
    Paragraph,
    Table,
    TableCell,
    TableRow,
    TextRun,
    WidthType
  } = await import('docx');

  const { width, height } = WORD_TO_PDF.image;
  const png = encodePng(photoPixels(width, height), width, height, false);

  const cell = (text: string, bold: boolean) =>
    new TableCell({ children: [new Paragraph({ children: [new TextRun({ text, bold })] })] });

  const doc = new Document({
    numbering: {
      config: [
        {
          reference: 'word-to-pdf-steps',
          levels: [{ level: 0, format: 'decimal', text: '%1.', alignment: 'start' }]
        }
      ]
    },
    sections: [
      {
        children: [
          new Paragraph({
            heading: HeadingLevel.HEADING_1,
            children: [new TextRun(WORD_TO_PDF.h1)]
          }),
          new Paragraph({ children: [new TextRun(WORD_TO_PDF.paragraph)] }),
          new Paragraph({
            heading: HeadingLevel.HEADING_2,
            children: [new TextRun(WORD_TO_PDF.h2)]
          }),
          // One sentence, five runs, three styles — the inline-formatting case.
          new Paragraph({
            children: [
              new TextRun('Revenue rose '),
              new TextRun({ text: WORD_TO_PDF.boldRun, bold: true }),
              new TextRun(' against a '),
              new TextRun({ text: WORD_TO_PDF.italicRun, italics: true }),
              new TextRun(' baseline.')
            ]
          }),
          ...WORD_TO_PDF.bullets.map(
            text => new Paragraph({ children: [new TextRun(text)], bullet: { level: 0 } })
          ),
          ...WORD_TO_PDF.numbered.map(
            text =>
              new Paragraph({
                children: [new TextRun(text)],
                numbering: { reference: 'word-to-pdf-steps', level: 0 }
              })
          ),
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: WORD_TO_PDF.table.map(
              (row, index) => new TableRow({ children: row.map(text => cell(text, index === 0)) })
            )
          }),
          // Word requires a paragraph after a table.
          new Paragraph({ children: [] }),
          new Paragraph({
            heading: HeadingLevel.HEADING_2,
            children: [new TextRun(WORD_TO_PDF.appendixH2)]
          }),
          new Paragraph({ children: [new TextRun(WORD_TO_PDF.appendixParagraph)] }),
          new Paragraph({
            children: [
              new ImageRun({
                type: 'png',
                data: png,
                transformation: { width: 360, height: 240 },
                altText: {
                  name: 'Fixture image',
                  description: 'Fixture image',
                  title: 'Fixture image'
                }
              })
            ]
          })
        ]
      }
    ]
  });

  return new Uint8Array(await Packer.toArrayBuffer(doc));
}

/* ------------------------------------------------------------------ *
 * CNV-10 — PDF → Excel
 * ------------------------------------------------------------------ */

/**
 * The exact content CNV-10's acceptance criteria are stated against, exported so
 * the round-trip test asserts against these strings rather than against a copy of
 * them that can drift from the fixture.
 */
export const PDF_TO_EXCEL = {
  heading: 'Regional Sales Summary',
  intro: 'Figures are in thousands of dollars.',
  closing: 'Prepared by the operations team.',
  /** Header row first, in reading order. Column x-positions are 56 / 220 / 360 / 470. */
  table: [
    ['Region', 'Revenue', 'Units', 'Change'],
    ['North', '1,204', '318', 'plus 8'],
    ['South', '987', '245', 'plus 3'],
    ['East', '1,455', '402', 'plus 12'],
    ['West', '623', '168', 'minus 4']
  ],
  /** Page 2 carries no table at all, so one document exercises both criteria. */
  appendix: [
    'The appendix page carries no table, only prose, so the converter has to',
    'write one row per line of text rather than leaving the page out.',
    'A third line, so the sheet is unambiguously multi-row.'
  ]
} as const;

/**
 * A two-page document whose first page holds one unambiguous 5x4 table and whose
 * second holds none (CNV-10).
 *
 * Everything is positioned rather than laid out by a producer, so the geometry the
 * heuristics read is exactly what this builder wrote:
 *
 *  • Type sizes are 18 / 11pt. 11pt covers the most characters, so it is the body
 *    size, and 18 clears CNV-05's 1.25x promotion ratio — which matters because
 *    `table-regions.ts` refuses to start a table on a heading line.
 *  • Table cells are drawn as separate `drawText` calls at least 110pt apart, far
 *    beyond the 2.5x body size (27.5pt) that separates a column gap from the
 *    widest word space a justified line can stretch to.
 *  • The intro and closing lines are single `drawText` calls, so they split into
 *    one cell and cannot extend the table's line run.
 */
export async function pdfToExcelPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const body = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const one = doc.addPage([612, 792]);
  one.drawText(PDF_TO_EXCEL.heading, { x: 56, y: 730, size: 18, font: bold });
  one.drawText(PDF_TO_EXCEL.intro, { x: 56, y: 690, size: 11, font: body });

  const columnX = [56, 220, 360, 470];
  PDF_TO_EXCEL.table.forEach((row, r) => {
    row.forEach((cell, c) => {
      one.drawText(cell, {
        x: columnX[c],
        y: 650 - r * 20,
        size: 11,
        font: r === 0 ? bold : body
      });
    });
  });

  one.drawText(PDF_TO_EXCEL.closing, { x: 56, y: 520, size: 11, font: body });

  const two = doc.addPage([612, 792]);
  PDF_TO_EXCEL.appendix.forEach((line, i) => {
    two.drawText(line, { x: 56, y: 730 - i * 14, size: 11, font: body });
  });

  return doc.save();
}

/**
 * A document with no table anywhere — the second acceptance criterion on its own.
 *
 * Deliberately prose that *wraps*: `pageSheet` keeps lines rather than merging
 * them into paragraphs the way CNV-08's block model does, and "one row per line"
 * is the criterion's own wording.
 */
export const PDF_TO_EXCEL_PROSE = [
  'This document contains no tabular content of any kind, so the converter',
  'has nothing to cluster into a grid and must fall back to writing each',
  'line of text as its own row rather than producing an empty workbook.'
] as const;

export async function pdfToExcelProsePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  PDF_TO_EXCEL_PROSE.forEach((line, i) => {
    page.drawText(line, { x: 56, y: 730 - i * 14, size: 11, font });
  });
  return doc.save();
}

/* ------------------------------------------------------------------ *
 * CNV-11 — Excel → PDF
 * ------------------------------------------------------------------ */

/**
 * The exact content CNV-11's acceptance criteria are stated against, exported so
 * the round-trip test asserts against these strings rather than against a copy of
 * them that can drift from the fixture.
 *
 * Every grid below is written as the **displayed** text, not the raw value: the
 * ticket asks for "basic number/date formatting preserved", so `1204.5` under
 * `#,##0.00` has to come back out of the PDF as `1,204.50`. The raw values and
 * their formats are in `excelToPdfXlsx()`; these are what must survive.
 */
export const EXCEL_TO_PDF = {
  /** Sheet names, in workbook order. `notes` is hidden; `blank` holds no cells. */
  sheets: {
    summary: 'Summary',
    regions: 'Regions',
    notes: 'Notes',
    blank: 'Blank',
    wide: 'Wide'
  },
  /**
   * Header row first, in reading order. Row 4's revenue and share are formula
   * cells with cached results — the computed value is what must appear, never
   * `SUM(B2:B3)`.
   */
  summary: [
    ['Region', 'Revenue', 'Booked', 'Share'],
    ['North', '1,204.50', '2026-01-15', '8.1%'],
    ['South', '987.00', '2026-02-01', '3.0%'],
    ['Total', '2,191.50', '', '11.1%']
  ],
  /** What `Regions` must look like *after* its hidden row and column are dropped. */
  regionsVisible: [
    ['Region', 'Lead'],
    ['North', 'Alice'],
    ['South', 'Bob']
  ],
  /** Strings that live only in the hidden row, hidden column, or hidden sheet. */
  hiddenOnly: [
    'Withdrawn',
    'W-000',
    'Confidential',
    'S-101',
    'S-102',
    'This sheet is hidden in Excel'
  ],
  /** The `Wide` sheet's 20 headers — wide enough to need more than one band. */
  wideHeaders: Array.from(
    { length: 20 },
    (_, index) => `Metric ${String(index + 1).padStart(2, '0')}`
  ),
  wideValues: Array.from({ length: 20 }, (_, index) => `v${index + 1}`)
} as const;

/**
 * A multi-sheet `.xlsx` built with the `xlsx` package's own writer rather than
 * committed as a binary — the same policy the rest of this file follows, and the
 * reason a fixture can be read as source instead of being taken on trust.
 *
 * It is deliberately not just a grid. Each sheet is one of the cases CNV-11 has
 * to make a decision about and disclose:
 *
 *  • `Summary` — number formats, a date column, and two formula cells with
 *    cached results, so the round trip can prove the *computed value* is drawn
 *    and the formula text is not.
 *  • `Regions` — one hidden row and one hidden column, so the round trip can
 *    prove hidden content is excluded (and say so) rather than leaking.
 *  • `Notes` — a hidden *sheet*, same reason.
 *  • `Blank` — a sheet with no cells at all, which must still produce a section
 *    rather than vanishing from the output.
 *  • `Wide` — 20 columns, which no page width fits, so the column-band split has
 *    a fixture that exercises it and can be shown to lose no column.
 */
export async function excelToPdfXlsx(): Promise<Uint8Array> {
  const XLSX = await import('xlsx');

  const summary = XLSX.utils.aoa_to_sheet([
    ['Region', 'Revenue', 'Booked', 'Share'],
    ['North', 1204.5, new Date(Date.UTC(2026, 0, 15)), 0.081],
    ['South', 987, new Date(Date.UTC(2026, 1, 1)), 0.03],
    ['Total', 0, '', 0]
  ]);
  // Number and date formats, which are what `w` (the string Excel displays) is
  // computed from on the way back in.
  summary.B2.z = '#,##0.00';
  summary.B3.z = '#,##0.00';
  summary.C2.z = 'yyyy-mm-dd';
  summary.C3.z = 'yyyy-mm-dd';
  summary.D2.z = '0.0%';
  summary.D3.z = '0.0%';
  // Two formula cells, each with the cached result Excel would have stored. The
  // conversion must draw 2,191.50 and 11.1%, not "SUM(B2:B3)".
  summary.B4 = { t: 'n', f: 'SUM(B2:B3)', v: 2191.5, z: '#,##0.00' };
  summary.D4 = { t: 'n', f: 'SUM(D2:D3)', v: 0.111, z: '0.0%' };
  summary.C4 = { t: 'z' };
  summary['!cols'] = [{ wch: 14 }, { wch: 12 }, { wch: 14 }, { wch: 8 }];

  const regions = XLSX.utils.aoa_to_sheet([
    ['Region', 'Lead', 'Confidential'],
    ['North', 'Alice', 'S-101'],
    ['Withdrawn', 'Nobody', 'W-000'],
    ['South', 'Bob', 'S-102']
  ]);
  // Row 3 (0-based index 2) and column C (index 2) are hidden in Excel.
  regions['!rows'] = [{}, {}, { hidden: true }, {}];
  regions['!cols'] = [{ wch: 14 }, { wch: 12 }, { wch: 16, hidden: true }];

  const notes = XLSX.utils.aoa_to_sheet([['This sheet is hidden in Excel']]);

  // `aoa_to_sheet([])` produces a sheet with no `!ref` at all, which is what
  // Excel writes for a sheet the user never typed in.
  const blank = XLSX.utils.aoa_to_sheet([]);

  const wide = XLSX.utils.aoa_to_sheet([
    [...EXCEL_TO_PDF.wideHeaders],
    [...EXCEL_TO_PDF.wideValues]
  ]);

  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, summary, EXCEL_TO_PDF.sheets.summary);
  XLSX.utils.book_append_sheet(book, regions, EXCEL_TO_PDF.sheets.regions);
  XLSX.utils.book_append_sheet(book, notes, EXCEL_TO_PDF.sheets.notes);
  XLSX.utils.book_append_sheet(book, blank, EXCEL_TO_PDF.sheets.blank);
  XLSX.utils.book_append_sheet(book, wide, EXCEL_TO_PDF.sheets.wide);
  // Sheet visibility is workbook-level and positional: 0 = visible, 1 = hidden.
  book.Workbook = {
    Sheets: book.SheetNames.map(name => ({
      name,
      Hidden: name === EXCEL_TO_PDF.sheets.notes ? (1 as const) : (0 as const)
    }))
  };

  return new Uint8Array(
    XLSX.write(book, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
  ) as Uint8Array;
}
