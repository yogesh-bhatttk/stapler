/**
 * Audit 2026-10-10 — reading order of extracted text.
 *
 * CV3: `layoutLines` grouped runs by raw `transform[5]` and sorted by
 * `transform[4]`, so text drawn upright on a `/Rotate 90` page came out
 * column by column ("BravoDeltaFoxtrot\nAlphaCharlieEcho"). Runs are now
 * turned by the inverse of the page's dominant text angle first.
 * CV5: a Hebrew/Arabic line in two runs came out word-reversed; a
 * right-to-left line is now ordered right to left.
 * Graded on real PDFs through the render worker (pdf.js), as the exports see them.
 */
import { describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import * as fontkitModule from 'fontkit';

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
      pdfjsLib.getDocument({ data, password, disableFontFace: true, verbosity: 0 })
  };
});

const { renderWorkerImpl } = await import('../../src/core/workers/render.worker');
const { layoutLines, layoutText } = await import('../../src/core/text-layout');
const { lineRuns } = await import('../../src/core/convert/blocks');

async function textOf(bytes: Uint8Array): Promise<string> {
  const { handle } = await renderWorkerImpl.loadDocument(bytes.slice());
  try {
    return await renderWorkerImpl.extractText(handle, 0, 'text');
  } finally {
    await renderWorkerImpl.closeDocument(handle);
  }
}

describe('CV3 — rotated text reads line by line', () => {
  it('reads text drawn upright on a /Rotate 90 page in order', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([612, 792]);
    page.setRotation(degrees(90));
    const lines = [
      ['Alpha', 'Bravo'],
      ['Charlie', 'Delta'],
      ['Echo', 'Foxtrot']
    ];
    lines.forEach((words, li) =>
      words.forEach((w, wi) =>
        page.drawText(w, {
          x: 100 + li * 20,
          y: 100 + wi * 80,
          size: 12,
          font,
          rotate: degrees(90)
        })
      )
    );
    expect(await textOf(await doc.save())).toBe('Alpha Bravo\nCharlie Delta\nEcho Foxtrot');
  });

  it('turns runs at 180° and 270° upright too, and leaves an upright page untouched', () => {
    const run = (str: string, angle: number, x: number, y: number) => {
      const r = (angle * Math.PI) / 180;
      const [c, s] = [Math.cos(r) * 12, Math.sin(r) * 12];
      return { str, width: str.length * 6, height: 12, transform: [c, s, -s, c, x, y] };
    };
    // 180°: baselines run right to left, lines stack upwards on the page.
    const upsideDown = [
      run('one', 180, 500, 700),
      run('two', 180, 470, 700),
      run('three', 180, 500, 714)
    ];
    expect(layoutText(upsideDown, 'text')).toBe('one two\nthree');
    // 270°: baselines run downwards, lines stack to the left.
    const down = [run('one', 270, 100, 700), run('two', 270, 100, 670), run('three', 270, 86, 700)];
    expect(layoutText(down, 'text')).toBe('one two\nthree');
    // Sizes come from the up-vector, not |d| (which is 0 at 90°/270°).
    expect(layoutLines(down).lines[0].maxSize).toBeCloseTo(12);
    // Upright: the very same run objects come back (no copying, no coordinate change).
    const upright = [run('a', 0, 10, 700), run('b', 0, 30, 700)];
    expect(layoutLines(upright).lines[0].runs[0]).toBe(upright[0]);
  });
});

/**
 * The bundled Liberation Sans has no Hebrew glyphs; DejaVu Sans (present on
 * the Linux CI image and most dev machines) does. The pure-geometry test below
 * covers the same ordering rule wherever the font is missing.
 */
const HEBREW_FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';

describe('CV5 — right-to-left lines', () => {
  it.skipIf(!existsSync(HEBREW_FONT))(
    'reads a Hebrew line drawn as two runs in logical order',
    async () => {
      const fontkit = (fontkitModule as unknown as { default?: unknown }).default ?? fontkitModule;
      const doc = await PDFDocument.create();
      doc.registerFontkit(fontkit as Parameters<PDFDocument['registerFontkit']>[0]);
      const font = await doc.embedFont(readFileSync(HEBREW_FONT), {
        subset: true
      });
      const page = doc.addPage([612, 792]);
      // Visually right to left: the first word (שלום) sits on the right.
      page.drawText('שלום', { x: 300, y: 700, size: 14, font });
      page.drawText('עולם', { x: 200, y: 700, size: 14, font });
      page.drawText('Hello', { x: 100, y: 600, size: 14, font });
      page.drawText('world', { x: 150, y: 600, size: 14, font });
      const lines = (await textOf(await doc.save())).split('\n').filter(Boolean);
      expect(lines).toEqual(['שלום עולם', 'Hello world']);
    }
  );

  it('orders a right-to-left line right to left, keeping the word space in the Word export', () => {
    const run = (str: string, x: number) => ({
      str,
      width: 30,
      height: 14,
      transform: [14, 0, 0, 14, x, 700]
    });
    const [line] = layoutLines([run('עולם', 200), run('שלום', 300)]).lines;
    expect(line.runs.map(r => r.str)).toEqual(['שלום', 'עולם']);
    expect(
      lineRuns(line.runs)
        .map(r => r.text)
        .join('')
    ).toBe('שלום עולם');
  });
});
