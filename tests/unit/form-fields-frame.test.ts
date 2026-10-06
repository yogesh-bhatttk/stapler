/**
 * HRD-42 — `getFormFields` reports widget rectangles in the frame the overlay is
 * drawn in (M2, reverse direction).
 *
 * `AcroFormOverlay` lays each field over the pdf.js render as top-left
 * percentages of the displayed page. `getFormFields` used to divide the raw
 * `/Rect` by `page.getSize()` — the raw MediaBox from (0, 0), unrotated — so on
 * a page with an offset MediaBox, a CropBox or `/Rotate` the inputs sat off the
 * printed boxes (or off the page altogether).
 *
 * The reference is the installed pdf.js: each widget's rect as pdf.js reads it
 * from the same bytes, pushed through `page.getViewport({ scale: 1 })` and
 * divided by the viewport's size. Agreement within 1 pt is the HRD-42 AC.
 */
import { describe, expect, it, vi } from 'vitest';
import { PDFDocument, PDFName, degrees } from 'pdf-lib';

// Real pdf.js / worker work on generated documents: give each test room on a
// busy machine instead of vitest's 5 s default (as other real-worker suites do).
vi.setConfig({ testTimeout: 60_000 });

vi.mock('comlink', () => ({
  expose: vi.fn(),
  transfer: vi.fn(value => value),
  proxy: vi.fn(value => value)
}));

const { processWorkerImpl } = await import('../../src/core/workers/process.worker');
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

type Box = [number, number, number, number];

const MEDIA: Box = [100, 100, 712, 892];
const CROP: Box = [150, 130, 650, 850];

/** One page with a text field and a check box at fixed raw rects. */
async function formPage(rotation: number, crop: Box | null, media: Box = MEDIA) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const form = doc.getForm();
  const name = form.createTextField('name');
  name.addToPage(page, { x: 200, y: 700, width: 180, height: 24 });
  const agree = form.createCheckBox('agree');
  agree.addToPage(page, { x: 500, y: 180, width: 16, height: 16 });
  // Set after the widgets: pdf-lib's addToPage only needs the page leaf.
  page.node.set(PDFName.of('MediaBox'), doc.context.obj(media));
  if (crop) page.node.set(PDFName.of('CropBox'), doc.context.obj(crop));
  if (rotation) page.setRotation(degrees(rotation));
  return doc.save();
}

interface Frac {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** pdf.js's viewport placement of every widget, as fractions of the viewport. */
async function pdfjsWidgetFractions(
  bytes: Uint8Array
): Promise<{ map: Map<string, Frac>; width: number; height: number }> {
  const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 });
  const doc = await task.promise;
  const page = await doc.getPage(1);
  const viewport = page.getViewport({ scale: 1 });
  const map = new Map<string, Frac>();
  for (const annot of await page.getAnnotations()) {
    if (annot.subtype !== 'Widget') continue;
    const [a, b] = viewport.convertToViewportPoint(annot.rect[0], annot.rect[1]);
    const [c, d] = viewport.convertToViewportPoint(annot.rect[2], annot.rect[3]);
    map.set(annot.fieldName, {
      x: Math.min(a, c) / viewport.width,
      y: Math.min(b, d) / viewport.height,
      width: Math.abs(c - a) / viewport.width,
      height: Math.abs(d - b) / viewport.height
    });
  }
  const size = { width: viewport.width, height: viewport.height };
  await task.destroy();
  return { map, ...size };
}

const CASES: { label: string; rotation: number; crop: Box | null; media?: Box }[] = [
  { label: 'offset MediaBox + CropBox, no rotation', rotation: 0, crop: CROP },
  { label: 'offset MediaBox + CropBox, /Rotate 90', rotation: 90, crop: CROP },
  { label: 'offset MediaBox + CropBox, /Rotate 180', rotation: 180, crop: CROP },
  { label: 'offset MediaBox + CropBox, /Rotate 270', rotation: 270, crop: CROP },
  { label: 'offset MediaBox, no CropBox, /Rotate 90', rotation: 90, crop: null },
  { label: 'plain page from the origin', rotation: 0, crop: null, media: [0, 0, 612, 792] }
];

describe('getFormFields rects are in the visible, rotated frame (HRD-42)', () => {
  for (const { label, rotation, crop, media } of CASES) {
    it(`matches the pdf.js viewport within 1 pt: ${label}`, async () => {
      const bytes = await formPage(rotation, crop, media);
      const { fields, isXfa } = await processWorkerImpl.getFormFields(bytes);
      expect(isXfa).toBe(false);
      const reference = await pdfjsWidgetFractions(bytes);
      expect(reference.map.size).toBe(2);

      for (const fieldName of ['name', 'agree']) {
        const field = fields.find(f => f.name === fieldName);
        expect(field?.rects).toHaveLength(1);
        const got = field!.rects[0];
        const want = reference.map.get(fieldName)!;
        expect(got.pageIndex).toBe(0);
        // Fractions → points of the displayed page, so the tolerance is 1 pt.
        expect(Math.abs(got.x - want.x) * reference.width).toBeLessThan(1);
        expect(Math.abs(got.y - want.y) * reference.height).toBeLessThan(1);
        expect(Math.abs(got.width - want.width) * reference.width).toBeLessThan(1);
        expect(Math.abs(got.height - want.height) * reference.height).toBeLessThan(1);
      }
    });
  }

  it('was wrong before: the raw-MediaBox mapping misses by far more than 1 pt on a rotated crop', async () => {
    const bytes = await formPage(90, CROP);
    const { fields } = await processWorkerImpl.getFormFields(bytes);
    const got = fields.find(f => f.name === 'name')!.rects[0];
    // The old formula: raw /Rect over getSize() of the 612 × 792 MediaBox.
    const old = { x: 200 / 612, y: 1 - (700 + 24) / 792 };
    const reference = await pdfjsWidgetFractions(bytes);
    const want = reference.map.get('name')!;
    const miss = (r: { x: number; y: number }) =>
      Math.hypot((r.x - want.x) * reference.width, (r.y - want.y) * reference.height);
    expect(miss(old)).toBeGreaterThan(100);
    expect(miss(got)).toBeLessThan(1);
  });
});
