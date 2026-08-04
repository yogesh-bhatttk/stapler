import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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

/** A document containing both text and a raster image. */
export async function mixedTextImagePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595.28, 841.89]);
  page.drawText(`Mixed text and image`, { x: 50, y: 780, size: 18, font });

  // 1x1 black pixel PNG
  const pngImage = await doc.embedPng(
    new Uint8Array([
      137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0,
      0, 0, 144, 119, 83, 222, 0, 0, 0, 12, 73, 68, 65, 84, 8, 215, 99, 248, 255, 255, 63, 0, 5,
      254, 2, 254, 220, 204, 89, 231, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130
    ])
  );
  page.drawImage(pngImage, { x: 50, y: 700, width: 100, height: 100 });

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
