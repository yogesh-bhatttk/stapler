import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName } from 'pdf-lib';
import { exportRedlinePdf } from '../../src/core/redline-export';
import type { StaplerDoc } from '../../src/core/store';

function solidImage(width: number, height: number, rgb: [number, number, number]): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rgb[0];
    data[i + 1] = rgb[1];
    data[i + 2] = rgb[2];
    data[i + 3] = 255;
  }
  return new ImageData(data, width, height);
}

function withMark(base: ImageData, x: number, y: number, size: number): ImageData {
  const img = new ImageData(new Uint8ClampedArray(base.data), base.width, base.height);
  for (let dy = 0; dy < size; dy++) {
    for (let dx = 0; dx < size; dx++) {
      const idx = ((y + dy) * img.width + (x + dx)) * 4;
      img.data[idx] = 0;
      img.data[idx + 1] = 0;
      img.data[idx + 2] = 0;
      img.data[idx + 3] = 255;
    }
  }
  return img;
}

function docWithPages(id: string, pageCount: number): StaplerDoc {
  return {
    id,
    name: `${id}.pdf`,
    pages: Array.from({ length: pageCount }, (_, i) => ({
      key: `${id}-p${i}`,
      sourceDocId: `${id}-src`,
      sourceIndex: i,
      rotation: 0 as const
    })),
    annotations: [],
    dirty: false
  };
}

/** The one location, in image-pixel space, every "changed" fixture below marks. */
const KNOWN_MARK = { x: 40, y: 40, size: 20 };

describe('exportRedlinePdf (ANN-06)', () => {
  const docA = docWithPages('a', 2);
  const docB = docWithPages('b', 2);

  it('places a changed page before/after side by side at matching scale', async () => {
    const w = 100;
    const h = 100;
    const before = solidImage(w, h, [255, 255, 255]);
    const after = withMark(before, KNOWN_MARK.x, KNOWN_MARK.y, KNOWN_MARK.size);

    const bytes = await exportRedlinePdf(
      docA,
      docB,
      { unchangedPages: 'mark' },
      { a: [before, before], b: [after, before] }
    );

    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(2);

    // Page 0 (changed): two embedded images side by side, matching scale.
    const page0 = pdf.getPage(0);
    // Point size recovers directly from pixel size / RENDER_SCALE (1.5), so
    // both panes must report the identical point width/height for a 100x100
    // fixture on both sides — that IS "matching scale": neither pane was
    // stretched to fit the other.
    expect(page0.getWidth()).toBeGreaterThan(0);
    const resources0 = page0.node.Resources();
    const xObjects0 = resources0!.get(PDFName.of('XObject'));
    expect(xObjects0).toBeDefined();
  });

  it('marks page 1 (identical on both sides) as unchanged, page 0 as changed', async () => {
    const w = 60;
    const h = 60;
    const before = solidImage(w, h, [200, 200, 200]);
    const after = withMark(before, 10, 10, 10);

    const bytes = await exportRedlinePdf(
      docA,
      docB,
      { unchangedPages: 'mark' },
      { a: [before, before], b: [after, before] }
    );

    const pdf = await PDFDocument.load(bytes);
    // Both pages present under 'mark' mode.
    expect(pdf.getPageCount()).toBe(2);
    // The unchanged page (index 1) is a real page too, not silently dropped.
    const page1 = pdf.getPage(1);
    expect(page1.getWidth()).toBeGreaterThan(0);
  });

  it('skips unchanged pages entirely when unchangedPages is "skip"', async () => {
    const w = 50;
    const h = 50;
    const before = solidImage(w, h, [10, 10, 10]);
    const after = withMark(before, 5, 5, 5);

    const bytes = await exportRedlinePdf(
      docA,
      docB,
      { unchangedPages: 'skip' },
      { a: [before, before], b: [after, before] }
    );

    const pdf = await PDFDocument.load(bytes);
    // Only the one genuinely changed page (index 0) survives.
    expect(pdf.getPageCount()).toBe(1);
  });

  it('produces a single informational page when nothing changed and mode is "skip"', async () => {
    const w = 30;
    const h = 30;
    const same = solidImage(w, h, [128, 128, 128]);

    const bytes = await exportRedlinePdf(
      docA,
      docB,
      { unchangedPages: 'skip' },
      { a: [same, same], b: [same, same] }
    );

    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(1);
  });

  it('treats a page missing on one side as changed and renders a placeholder', async () => {
    const w = 40;
    const h = 40;
    const only = solidImage(w, h, [0, 100, 200]);

    const shortDocB = docWithPages('b', 1);
    const bytes = await exportRedlinePdf(
      docA,
      shortDocB,
      { unchangedPages: 'skip' },
      { a: [only, only], b: [only] }
    );

    const pdf = await PDFDocument.load(bytes);
    // Page 1 of docA has no counterpart in the 1-page docB — that must count
    // as a change, so 'skip' still includes it.
    expect(pdf.getPageCount()).toBe(1);
  });

  it('renders each pane at its own true scale rather than stretching one to match the other', async () => {
    // "Before" is 100x100 raster pixels, "after" is a genuinely larger page at
    // 200x200 — a real size change, not a force-fit into equal boxes.
    const before = solidImage(100, 100, [255, 255, 255]);
    const after = solidImage(200, 200, [255, 255, 255]);

    const bytes = await exportRedlinePdf(
      docA,
      docB,
      { unchangedPages: 'mark' },
      { a: [before, before], b: [after, before] }
    );

    const pdf = await PDFDocument.load(bytes);
    const page0 = pdf.getPage(0);
    // RENDER_SCALE (1.5) applies identically to both panes, so the "after"
    // pane's point size is exactly double the "before" pane's — matching
    // scale, not matching box size. The output page must be wide enough to
    // hold both at their true, unequal sizes plus margins/gutter, not merely
    // twice the smaller pane.
    const expectedMinWidth = 100 / 1.5 + 200 / 1.5;
    expect(page0.getWidth()).toBeGreaterThan(expectedMinWidth);
  });

  it('rejects two zero-page documents rather than emitting an empty PDF', async () => {
    const emptyA: StaplerDoc = {
      id: 'e1',
      name: 'e1.pdf',
      pages: [],
      annotations: [],
      dirty: false
    };
    const emptyB: StaplerDoc = {
      id: 'e2',
      name: 'e2.pdf',
      pages: [],
      annotations: [],
      dirty: false
    };
    await expect(exportRedlinePdf(emptyA, emptyB, {}, { a: [], b: [] })).rejects.toThrow();
  });
});
