/**
 * Audit 2026-10-10 CV8 — Markdown → PDF layout, graded on the text positions
 * pdf.js reads back from the output.
 *
 * Code blocks were re-flowed as prose (`runsToWords` split on whitespace), so
 * indentation vanished; and a word longer than the line (a URL, a long table
 * cell) was never broken, so it ran off the page or over the next column.
 */
import { describe, expect, it } from 'vitest';

const { markdownToPdfBytes } = await import('../../src/core/markdown-to-pdf');

const PAGE_WIDTH = 595.28;
const MARGIN = 50;

interface Item {
  str: string;
  x: number;
  end: number;
  y: number;
}

async function items(md: string): Promise<Item[]> {
  const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const res = await markdownToPdfBytes(md);
  const pdf = await lib.getDocument({ data: res.bytes.slice(), verbosity: 0 }).promise;
  const out: Item[] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    for (const raw of tc.items as { str: string; transform: number[]; width: number }[]) {
      if (!raw.str.trim()) continue;
      out.push({
        str: raw.str,
        x: raw.transform[4],
        end: raw.transform[4] + raw.width,
        y: raw.transform[5]
      });
    }
  }
  return out;
}

describe('CV8 — code blocks keep their indentation', () => {
  it('places each code line at its indentation (spaces and tabs) instead of re-flowing it', async () => {
    const md = '```python\ndef f(x):\n    if x:\n        return 1\n\treturn 2\n```\n';
    const found = await items(md);
    const at = (s: string) => found.find(i => i.str === s);
    const base = at('def f(x):')!;
    expect(base).toBeDefined();
    const col = 6; // Courier 10pt: one column is 6pt
    expect(at('if x:')!.x).toBeCloseTo(base.x + 4 * col, 1);
    expect(at('return 1')!.x).toBeCloseTo(base.x + 8 * col, 1);
    // A tab expands to the next 4-column stop.
    expect(at('return 2')!.x).toBeCloseTo(base.x + 4 * col, 1);
    // One line each: four distinct baselines, in order.
    const ys = ['def f(x):', 'if x:', 'return 1', 'return 2'].map(s => at(s)!.y);
    expect([...ys].sort((a, b) => b - a)).toEqual(ys);
    expect(new Set(ys).size).toBe(4);
  });

  it('breaks a code line wider than the page by characters, inside the margin', async () => {
    const long = 'x = "' + 'y'.repeat(200) + '"';
    const found = await items('```\n' + long + '\n```\n');
    expect(found.length).toBeGreaterThan(1);
    for (const item of found) expect(item.end).toBeLessThanOrEqual(PAGE_WIDTH - MARGIN + 0.5);
    expect(found.map(i => i.str).join('')).toBe(long);
  });
});

describe('CV8 — overlong words wrap instead of overflowing', () => {
  it('splits a long URL in a paragraph across lines, all within the right margin', async () => {
    const url = 'https://example.com/' + 'a'.repeat(150);
    const found = await items(url + '\n');
    expect(found.length).toBeGreaterThan(1);
    for (const item of found) expect(item.end).toBeLessThanOrEqual(PAGE_WIDTH - MARGIN + 0.5);
    expect(found.map(i => i.str).join('')).toBe(url);
  });

  it('wraps a long table cell inside its own column, not over the next one', async () => {
    const cell = 'x'.repeat(120);
    const found = await items(`| a | b |\n|---|---|\n| ${cell} | y |\n`);
    const second = found.find(i => i.str === 'y')!;
    expect(second).toBeDefined();
    const pieces = found.filter(i => /^x+$/.test(i.str));
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) expect(piece.end).toBeLessThan(second.x);
    expect(pieces.map(p => p.str).join('')).toBe(cell);
  });
});
