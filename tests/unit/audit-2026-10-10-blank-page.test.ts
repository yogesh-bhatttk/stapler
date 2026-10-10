/**
 * OPS-05 — the pure halves of the blank-page verdict (`src/core/blank-page.ts`).
 * The rendered end-to-end cases live in audit-2026-10-10-blank-detection.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts, TextRenderingMode, setTextRenderingMode } from 'pdf-lib';
import {
  blankSpeckLimit,
  blankTextAllowance,
  isBlankPage,
  measureInk,
  onPageTextLength,
  visibleGlyphCount,
  type TextOpCodes
} from '../../src/core/blank-page';

function canvas(width: number, height: number, ink: [number, number][]): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(width * height * 4).fill(255);
  for (const [x, y] of ink) rgba.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 3);
  return rgba;
}

describe('measureInk', () => {
  it('is zero on white', () => {
    expect(measureInk(canvas(10, 10, []), 10, 10)).toEqual({ coverage: 0, largestBlob: 0 });
  });

  it('tells scattered specks from one connected mark of the same area', () => {
    const specks = measureInk(
      canvas(20, 20, [
        [1, 1],
        [5, 5],
        [9, 9],
        [13, 13],
        [17, 17]
      ]),
      20,
      20
    );
    const line = measureInk(
      canvas(20, 20, [
        [3, 10],
        [4, 10],
        [5, 10],
        [6, 11],
        [7, 11]
      ]),
      20,
      20
    );
    expect(specks.coverage).toBeCloseTo(line.coverage);
    expect(specks.largestBlob).toBe(1);
    // Diagonal neighbours join: 8-connectivity.
    expect(line.largestBlob).toBe(5);
  });
});

describe('sensitivity curves', () => {
  it('forgive dust, never a short line of text, up to the default', () => {
    for (let t = 0; t <= 50; t++) {
      // "See overleaf." at 18 dpi is ~50 pixels of 16pt² each.
      expect(blankSpeckLimit(t)).toBeLessThan(800);
      expect(blankTextAllowance(t)).toBe(0);
    }
    expect(blankSpeckLimit(50)).toBeGreaterThanOrEqual(64);
    expect(blankSpeckLimit(100)).toBeGreaterThan(2000);
    expect(blankTextAllowance(100)).toBeGreaterThanOrEqual(34); // "This page intentionally left blank"
  });

  it('are monotonic', () => {
    for (let t = 1; t <= 100; t++) {
      expect(blankSpeckLimit(t)).toBeGreaterThanOrEqual(blankSpeckLimit(t - 1));
      expect(blankTextAllowance(t)).toBeGreaterThanOrEqual(blankTextAllowance(t - 1));
    }
  });
});

describe('isBlankPage', () => {
  const ink = { coverage: 0.0004, largestBlob: 2 };
  it('lets text veto a page the ink alone calls blank', async () => {
    expect(await isBlankPage({ ink, pt2PerPixel: 16, textLength: () => 0 }, 50)).toBe(true);
    expect(await isBlankPage({ ink, pt2PerPixel: 16, textLength: () => 1 }, 50)).toBe(false);
  });

  it('lets text veto a page even when the renderer drew no ink for it', async () => {
    // A non-embedded CJK font the renderer could not draw is still content.
    const none = { coverage: 0, largestBlob: 0 };
    expect(await isBlankPage({ ink: none, pt2PerPixel: 16, textLength: () => 2 }, 50)).toBe(false);
    expect(await isBlankPage({ ink: none, pt2PerPixel: 16, textLength: () => 0 }, 0)).toBe(true);
  });
});

describe('visible text', () => {
  it('ignores render mode 3 and restores the mode across q/Q', async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([595, 842]);
    page.pushOperators(setTextRenderingMode(TextRenderingMode.Invisible));
    page.drawText('Hidden', { x: 56, y: 700, size: 11, font }); // drawText wraps in q/Q
    page.drawText('Also hidden', { x: 56, y: 680, size: 11, font });
    page.pushOperators(setTextRenderingMode(TextRenderingMode.Fill));
    page.drawText('Seen.', { x: 56, y: 660, size: 11, font });
    const task = pdfjs.getDocument({ data: await doc.save(), verbosity: 0 });
    const loaded = await task.promise;
    const ops = await (await loaded.getPage(1)).getOperatorList();
    expect(visibleGlyphCount(ops.fnArray, ops.argsArray, pdfjs.OPS as unknown as TextOpCodes)).toBe(
      'Seen.'.length
    );
    await task.destroy();
  });

  it('counts only non-whitespace text whose box touches the page', () => {
    const view = [0, 0, 595, 842];
    const at = (str: string, x: number, y: number) => ({
      str,
      transform: [11, 0, 0, 11, x, y],
      width: str.length * 5,
      height: 11
    });
    expect(
      onPageTextLength(
        [at('On page', 56, 700), at('   ', 56, 680), at('Off', 56, 2000), at('Left', -400, 100)],
        view
      )
    ).toBe('Onpage'.length);
  });
});
