import { describe, expect, it } from 'vitest';
import {
  IMAGE_KIND,
  blankCoverageLimit,
  inkCoverage,
  layoutText,
  toRgba,
  type TextRun
} from '../../src/core/text-layout';

/** Builds a pdf.js-shaped run: PDF space, so a larger `y` is higher on the page. */
function run(
  str: string,
  x: number,
  y: number,
  size = 12,
  width = str.length * size * 0.5
): TextRun {
  return { str, transform: [size, 0, 0, size, x, y], width, height: size };
}

describe('layoutText', () => {
  it('returns empty for no runs', () => {
    expect(layoutText([], 'text')).toBe('');
  });

  it('orders lines top to bottom regardless of input order', () => {
    // 14pt leading for 12pt type — ordinary single spacing.
    const items = [run('third', 50, 672), run('first', 50, 700), run('second', 50, 686)];
    expect(layoutText(items, 'text')).toBe('first\nsecond\nthird');
  });

  it('orders runs within a line left to right', () => {
    const items = [run('world', 150, 700), run('hello', 50, 700)];
    expect(layoutText(items, 'text')).toBe('hello world');
  });

  it('groups runs on a shared baseline even when it wobbles', () => {
    const items = [run('same', 50, 700), run('line', 120, 701.5)];
    expect(layoutText(items, 'text')).toBe('same line');
  });

  it('inserts a space where the producer split a run without one', () => {
    // Two runs 40pt apart, far more than a space at 12pt.
    const items = [run('Account', 50, 700, 12, 40), run('number', 130, 700, 12, 40)];
    expect(layoutText(items, 'text')).toBe('Account number');
  });

  it('does not insert a space between adjacent runs', () => {
    const items = [run('Sta', 50, 700, 12, 18), run('pler', 68, 700, 12, 24)];
    expect(layoutText(items, 'text')).toBe('Stapler');
  });

  it('breaks a paragraph where a blank line was left', () => {
    const items = [
      run('one', 50, 700),
      run('two', 50, 686),
      run('three', 50, 672),
      // A full blank line, i.e. twice the established 14pt leading.
      run('next para', 50, 644)
    ];
    expect(layoutText(items, 'text')).toBe('one\ntwo\nthree\n\nnext para');
  });

  // The regression the calibrated threshold exists for: a fixed multiple of the font
  // size split every line of a double-spaced document into its own paragraph.
  it('does not break paragraphs in double-spaced text', () => {
    const items = [
      run('first line', 50, 700),
      run('second line', 50, 676),
      run('third line', 50, 652),
      run('fourth line', 50, 628)
    ];
    expect(layoutText(items, 'text')).toBe('first line\nsecond line\nthird line\nfourth line');
  });

  it('promotes a larger line to a heading only in markdown mode', () => {
    const items = [
      run('Title', 50, 700, 24),
      run('body text one', 50, 660, 12),
      run('body text two', 50, 646, 12),
      run('body text three', 50, 632, 12)
    ];
    expect(layoutText(items, 'markdown').startsWith('## Title')).toBe(true);
    expect(layoutText(items, 'text').startsWith('Title')).toBe(true);
    expect(layoutText(items, 'text')).not.toContain('##');
  });

  // Body size is the size covering the most characters. A median over runs would make
  // a two-run page's 24pt title the "body" size, so headings would never be detected.
  it('treats the most common size as body even when a heading comes first', () => {
    const items = [
      run('Heading', 50, 700, 20),
      run('paragraph text that dominates the page', 50, 670, 11),
      run('more paragraph text on this page', 50, 656, 11)
    ];
    expect(layoutText(items, 'markdown')).toContain('## Heading');
  });

  it('keeps CJK runs intact', () => {
    const items = [run('契約書', 50, 700, 12, 36), run('第一条', 50, 686, 12, 36)];
    expect(layoutText(items, 'text')).toBe('契約書\n第一条');
  });

  it('keeps an RTL run in its own logical order', () => {
    // pdf.js emits the run already in logical order; layout must not reverse it.
    const items = [run('مرحبا', 50, 700, 12, 30), run('بالعالم', 50, 686, 12, 40)];
    expect(layoutText(items, 'text')).toBe('مرحبا\nبالعالم');
  });

  it('drops whitespace-only runs', () => {
    const items = [run('   ', 50, 700), run('real', 50, 660)];
    expect(layoutText(items, 'text')).toBe('real');
  });
});

describe('toRgba', () => {
  it('passes RGBA through', () => {
    const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(Array.from(toRgba(source, 2, 1, IMAGE_KIND.RGBA_32BPP)!)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8
    ]);
  });

  it('expands RGB to RGBA with full alpha', () => {
    const source = new Uint8Array([10, 20, 30, 40, 50, 60]);
    expect(Array.from(toRgba(source, 2, 1, IMAGE_KIND.RGB_24BPP)!)).toEqual([
      10, 20, 30, 255, 40, 50, 60, 255
    ]);
  });

  it('unpacks 1-bit rows MSB first with byte padding', () => {
    // 9px wide → 2 bytes per row. 0b10000000 sets only pixel 0.
    const source = new Uint8Array([0b10000000, 0b10000000]);
    const rgba = toRgba(source, 9, 1, IMAGE_KIND.GRAYSCALE_1BPP)!;
    expect(rgba[0]).toBe(255); // pixel 0 set → white
    expect(rgba[4]).toBe(0); // pixel 1 clear → black
    expect(rgba[8 * 4]).toBe(255); // pixel 8 is the first bit of byte 1
    expect(rgba.length).toBe(9 * 4);
  });

  // Refusing beats guessing: a wrong guess corrupts the image, and the compressor
  // would then write that corruption into the user's file.
  it('refuses an unknown pixel layout', () => {
    expect(toRgba(new Uint8Array(16), 2, 2, 99)).toBeNull();
  });

  it('refuses a buffer that is too short for its dimensions', () => {
    expect(toRgba(new Uint8Array(4), 10, 10, IMAGE_KIND.RGB_24BPP)).toBeNull();
    expect(toRgba(new Uint8Array(4), 10, 10, IMAGE_KIND.RGBA_32BPP)).toBeNull();
    expect(toRgba(new Uint8Array(1), 64, 64, IMAGE_KIND.GRAYSCALE_1BPP)).toBeNull();
  });

  it('refuses degenerate dimensions', () => {
    expect(toRgba(new Uint8Array(4), 0, 1, IMAGE_KIND.RGBA_32BPP)).toBeNull();
  });
});

describe('inkCoverage and blankCoverageLimit', () => {
  it('reports zero for pure white and one for pure black', () => {
    expect(inkCoverage(new Uint8ClampedArray([255, 255, 255, 255]))).toBe(0);
    expect(inkCoverage(new Uint8ClampedArray([0, 0, 0, 255]))).toBe(1);
  });

  it('measures the inked fraction', () => {
    const pixels = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]);
    expect(inkCoverage(pixels)).toBe(0.5);
  });

  it('handles an empty buffer', () => {
    expect(inkCoverage(new Uint8ClampedArray())).toBe(0);
  });

  it('maps sensitivity monotonically and clamps out-of-range input', () => {
    expect(blankCoverageLimit(0)).toBe(0);
    expect(blankCoverageLimit(100)).toBeCloseTo(0.01);
    expect(blankCoverageLimit(50)).toBeCloseTo(0.005);
    expect(blankCoverageLimit(-20)).toBe(0);
    expect(blankCoverageLimit(1000)).toBeCloseTo(0.01);
  });
});

import {
  sanitizeWinAnsiText,
  markdownToPdfBytes,
  hadUnsupportedCharacter
} from '../../src/core/markdown-to-pdf';

describe('sanitizeWinAnsiText and markdownToPdfBytes', () => {
  it('sanitizes smart quotes, dashes, and unicode symbols to WinAnsi equivalents', () => {
    const raw = '“Hello” — ‘World’ • Test… \u00A0 Trademark™ © ®';
    const sanitized = sanitizeWinAnsiText(raw);
    expect(sanitized).toBe('"Hello" - \'World\' - Test...   Trademark(TM) (C) (R)');
  });

  it('passes through Windows-1252 characters WinAnsi actually supports, like the euro sign', () => {
    expect(sanitizeWinAnsiText('Price: €50')).toBe('Price: €50');
    expect(hadUnsupportedCharacter()).toBe(false);
  });

  it('substitutes CJK/non-Latin1 text with "?" instead of crashing, and flags it', async () => {
    // CNV-05 regression: a prior fix removed the >255 substitution entirely,
    // so `page.drawText` (WinAnsi-only) threw on any CJK/Cyrillic/Arabic
    // character instead of degrading. This must never throw.
    const md = '# 日本語のタイトル\n\nSome mixed 中文 text.';
    const bytes = await markdownToPdfBytes(md);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);
    expect(hadUnsupportedCharacter()).toBe(true);
  });

  it('does not flag unsupported characters for plain ASCII/Latin1 input', async () => {
    await markdownToPdfBytes('# Plain ASCII title\n\nNothing exotic here.');
    expect(hadUnsupportedCharacter()).toBe(false);
  });

  it('converts Markdown containing non-ASCII characters to PDF bytes without throwing', async () => {
    const md =
      '# Title with “Smart Quotes”\n\nSome paragraph with an em-dash — and bullet points • plus non-ASCII: € §.';
    const bytes = await markdownToPdfBytes(md);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);
  });
});
