/**
 * DOC-13 AC — "an intact file round-trips with an 'already valid' report and
 * unchanged page text".
 *
 * `repair.test.ts` checks `changed === false` on one healthy file. This checks
 * the round trip itself, on the bytes Repair produced: across a spread of
 * intact files (Latin, CJK, RTL, CMYK, scanned, forms, annotations, outlines,
 * mixed page sizes), the report is empty and every page's text, size and
 * rotation read back from the output by pdf.js match the input page for page.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { repairPdfBytes } from '../../src/core/pdf/repair';
import { loadPdfDocument } from '../../src/core/pdf/load';
import {
  acroformPdf,
  annotatedPdf,
  bookmarkedPdf,
  contractV1Pdf,
  mixedSizePdf,
  rotatedPdf,
  textPdf
} from '../e2e/fixtures';

const FIXTURES = path.resolve(__dirname, '../fixtures');
const committed = (name: string) => () =>
  Promise.resolve(new Uint8Array(fs.readFileSync(path.join(FIXTURES, name))));

interface PageFacts {
  text: string;
  width: number;
  height: number;
  rotate: number;
}

async function readPages(bytes: Uint8Array): Promise<PageFacts[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: bytes.slice(), disableFontFace: true, verbosity: 0 });
  const doc = await task.promise;
  const pages: PageFacts[] = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const viewport = page.getViewport({ scale: 1 });
      pages.push({
        text: content.items.map(item => ('str' in item ? item.str : '')).join('␟'),
        width: Math.round(viewport.width * 100) / 100,
        height: Math.round(viewport.height * 100) / 100,
        rotate: page.rotate
      });
    }
  } finally {
    await task.destroy();
  }
  return pages;
}

const INTACT: [string, () => Promise<Uint8Array>][] = [
  ['text (3 pages)', () => textPdf(3)],
  ['contract', contractV1Pdf],
  ['bookmarks', bookmarkedPdf],
  ['form fields', acroformPdf],
  ['annotations', annotatedPdf],
  ['mixed page sizes', mixedSizePdf],
  ['rotated pages', rotatedPdf],
  ['CJK', committed('cjk.pdf')],
  ['RTL', committed('rtl.pdf')],
  ['CMYK text', committed('cmyk-text.pdf')],
  ['scanned', committed('scanned_skewed.pdf')]
];

describe('repair — an intact file round-trips as already valid (DOC-13)', () => {
  for (const [label, build] of INTACT) {
    it(`${label}: no findings, and the output's pages read back unchanged`, async () => {
      const input = await build();
      const before = await readPages(input);
      expect(before.length, 'the premise: the input opens').toBeGreaterThan(0);

      const outcome = await repairPdfBytes(input);
      expect(outcome.changed, 'reported as already valid').toBe(false);
      expect(outcome.findings).toEqual([]);
      expect(outcome.warnings).toEqual([]);
      expect(outcome.pageCount).toBe(before.length);

      // Judged on the bytes Repair produced, through both parsers.
      const strict = await loadPdfDocument(outcome.bytes);
      expect(strict.getPageCount()).toBe(before.length);
      const after = await readPages(outcome.bytes);
      expect(after).toEqual(before);
    });
  }

  it('the text check is not vacuous: the fixtures carry real text', async () => {
    const pages = await readPages(await textPdf(3));
    expect(pages.map(page => page.text)).toEqual(
      [1, 2, 3].map(n => expect.stringContaining(`Stapler fixture page ${n}`))
    );
  });
});
