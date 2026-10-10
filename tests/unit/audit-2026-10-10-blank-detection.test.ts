/**
 * Audit 2026-10-10 T2 — OPS-05 blank-page detection on a real PDF.
 *
 * Nothing exercised `detectBlankPages` before: the panel calls it and selects
 * whatever it returns, so a false positive is a content page the user is
 * invited to delete. This renders a real document through the real render
 * worker (pdf.js + Skia in Node) and grades the indices it returns at the
 * panel's default sensitivity and at both ends of the slider.
 *
 * The document, page by page:
 *   0. truly blank
 *   1. near-blank — three specks of scanner dust
 *   2. a full page of body text
 *   3. a single short line of 11pt text ("See overleaf.") — sparse, but content
 *   4. a mid-grey photo-like rectangle with no text at all
 *   5. a pale (85% grey) table drawn in hairlines — faint, but content
 *   6. truly blank, again, at the end
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  PDFDocument,
  StandardFonts,
  TextRenderingMode,
  rgb,
  setTextRenderingMode,
  type PDFPage
} from 'pdf-lib';
import { installCanvasShims } from './helpers/node-canvas-shims';

vi.setConfig({ testTimeout: 60_000 });

vi.mock('comlink', () => ({
  expose: vi.fn(),
  transfer: vi.fn(value => value),
  proxy: vi.fn(value => value),
  releaseProxy: Symbol('releaseProxy')
}));
vi.mock('../../src/core/workers/pdfjs-setup', async () => {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return {
    pdfjsLib,
    openDocument: ({ data, password }: { data: Uint8Array; password?: string }) =>
      pdfjsLib.getDocument({
        data,
        password,
        disableFontFace: true,
        verbosity: 0,
        // As the app does: without the bundled CMaps a CID font shows no glyphs.
        cMapUrl: `${process.cwd()}/node_modules/pdfjs-dist/cmaps/`,
        cMapPacked: true
      })
  };
});
vi.mock('../../src/core/workers', async () => {
  const { renderWorkerImpl } = await import('../../src/core/workers/render.worker');
  // `any`: stands in for the pool's `Comlink.Remote<T>` wrapper.
  const run = (fn: (api: any) => unknown) =>
    fn({
      ...renderWorkerImpl,
      // Comlink copies arguments across the worker boundary; pdf.js in-process
      // would otherwise detach the caller's buffer on the first load.
      loadDocument: (bytes: Uint8Array, ...rest: unknown[]) =>
        (renderWorkerImpl.loadDocument as any)(bytes.slice(), ...rest)
    });
  return { renderWorker: { lease: run, pin: () => ({ lease: run, release: () => {} }) } };
});

installCanvasShims();
const { detectBlankPages } = await import('../../src/core/operations');
const { removeBlanksThreshold } = await import('../../src/ui/tools/state');

const BLANK = [0, 1, 6];

async function corpus(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const A4: [number, number] = [595.28, 841.89];

  doc.addPage(A4);

  const dusty = doc.addPage(A4);
  for (const [x, y] of [
    [120, 300],
    [410, 620],
    [300, 90]
  ]) {
    dusty.drawEllipse({ x, y, xScale: 0.6, yScale: 0.6, color: rgb(0.3, 0.3, 0.3) });
  }

  const text = doc.addPage(A4);
  text.drawText('Quarterly report', { x: 56, y: 780, size: 18, font });
  for (let line = 0; line < 36; line++) {
    text.drawText(`Line ${line + 1}: the quick brown fox jumps over the lazy dog, again.`, {
      x: 56,
      y: 740 - line * 19,
      size: 11,
      font
    });
  }

  doc.addPage(A4).drawText('See overleaf.', { x: 56, y: 780, size: 11, font });

  doc.addPage(A4).drawRectangle({
    x: 100,
    y: 300,
    width: 400,
    height: 300,
    color: rgb(0.5, 0.5, 0.5)
  });

  const table = doc.addPage(A4);
  const pale = rgb(0.85, 0.85, 0.85);
  for (let row = 0; row <= 12; row++) {
    table.drawLine({
      start: { x: 56, y: 760 - row * 40 },
      end: { x: 540, y: 760 - row * 40 },
      thickness: 0.75,
      color: pale
    });
  }
  for (let col = 0; col <= 4; col++) {
    table.drawLine({
      start: { x: 56 + col * 121, y: 760 },
      end: { x: 56 + col * 121, y: 280 },
      thickness: 0.75,
      color: pale
    });
  }

  doc.addPage(A4);
  return doc.save();
}

describe('OPS-05 — detectBlankPages on a rendered document', () => {
  it('at the default sensitivity, finds the blank and dusty pages', async () => {
    const bytes = await corpus();
    const progress: number[] = [];
    const found = await detectBlankPages(bytes, removeBlanksThreshold.value, {
      onProgress: fraction => progress.push(fraction ?? -1)
    });
    expect(found).toEqual(expect.arrayContaining(BLANK));
    // Determinate, one step per page.
    expect(progress.length).toBeGreaterThanOrEqual(7);
  });

  it('never flags a dense text page, a photo, or a pale table, at any sensitivity', async () => {
    const bytes = await corpus();
    for (const threshold of [0, 25, 50, 75, 100]) {
      const found = await detectBlankPages(bytes, threshold);
      for (const contentPage of [2, 4, 5]) {
        expect(found, `threshold ${threshold} flagged page ${contentPage + 1}`).not.toContain(
          contentPage
        );
      }
      // Truly empty pages are blank even at the strictest setting.
      expect(found).toEqual(expect.arrayContaining([0, 6]));
    }
  });

  it('at the strictest setting keeps a page with one short line of text', async () => {
    expect(await detectBlankPages(await corpus(), 0)).not.toContain(3);
  });

  /**
   * Formerly an `it.fails` (audit 2026-10-10): one short line of 11pt text
   * covers well under the default 0.5% of the page, so the coverage-only
   * detector flagged it from sensitivity ~25 up. The detector now also weighs
   * the largest connected blob of ink and the page's visible text.
   */
  it('at the default sensitivity keeps a page with one short line of text', async () => {
    expect(await detectBlankPages(await corpus(), removeBlanksThreshold.value)).not.toContain(3);
  });

  it('keeps the short-line page at every sensitivity up to the default', async () => {
    const bytes = await corpus();
    for (let threshold = 0; threshold <= removeBlanksThreshold.value; threshold += 5) {
      const found = await detectBlankPages(bytes, threshold);
      expect(found, `threshold ${threshold}`).not.toContain(3);
    }
  });

  it('still treats a short line as blank-ish at the loosest setting', async () => {
    // The slider's top end has always meant "tolerate about one short line".
    expect(await detectBlankPages(await corpus(), 100)).toContain(3);
  });

  it('only counts text a reader can see, on the page', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const A4: [number, number] = [595.28, 841.89];
    const speck = (page: PDFPage) =>
      page.drawEllipse({ x: 200, y: 400, xScale: 0.6, yScale: 0.6, color: rgb(0.3, 0.3, 0.3) });

    // 0. A dusty blank scan carrying an invisible (Tr 3) OCR layer of noise.
    const ocr = doc.addPage(A4);
    speck(ocr);
    ocr.pushOperators(setTextRenderingMode(TextRenderingMode.Invisible));
    ocr.drawText("' . , ~", { x: 56, y: 700, size: 11, font });
    ocr.pushOperators(setTextRenderingMode(TextRenderingMode.Fill));

    // 1. Dust plus a line positioned entirely off the page.
    const off = doc.addPage(A4);
    speck(off);
    off.drawText('Printer slug', { x: 56, y: 2000, size: 11, font });

    // 2. A lone page number: the text alone keeps it at the default.
    doc.addPage(A4).drawText('3', { x: 295, y: 30, size: 9, font });

    // 3. One short line drawn as vector outlines (no text object at all).
    doc.addPage(A4).drawRectangle({ x: 56, y: 776, width: 64, height: 8, color: rgb(0, 0, 0) });

    const bytes = await doc.save();
    const found = await detectBlankPages(bytes, removeBlanksThreshold.value);
    expect(found).toEqual([0, 1]);
    // The loosest setting forgives a page number.
    expect(await detectBlankPages(bytes, 100)).toContain(2);
  });

  it('keeps a page of text the renderer cannot draw (non-embedded CJK / Arabic)', async () => {
    // In Node pdf.js has no system font for these, so the page renders white;
    // the text is still there for anyone who opens the file with the font.
    for (const name of ['cjk.pdf', 'rtl.pdf']) {
      const bytes = new Uint8Array(readFileSync(`tests/fixtures/${name}`));
      expect(await detectBlankPages(bytes, removeBlanksThreshold.value), name).toEqual([]);
    }
  });

  it('is cancellable', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      detectBlankPages(await corpus(), 50, { signal: controller.signal })
    ).rejects.toThrow();
  });
});
