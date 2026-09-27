import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  PDFArray,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFStream,
  StandardFonts,
  cmyk,
  decodePDFRawStream,
  rgb
} from 'pdf-lib';
import { ensureFixture, textPdf } from './fixtures';
import { commitAndRead, confirmExportReviewIfShown, gotoTool, openApp } from './helpers';

/**
 * GAP-6 — one happy path per new tool, judged on the saved bytes: Grayscale
 * (no colour operators left, text kept), duplex interleave (the page order that
 * is actually exported), and Repair entered from a refused import's own error.
 */

function contentText(doc: PDFDocument, pageIndex: number): string {
  const page = doc.getPage(pageIndex);
  const raw = page.node.get(PDFName.of('Contents'));
  const resolved = raw ? doc.context.lookup(raw) : undefined;
  const parts = resolved instanceof PDFArray ? resolved.asArray() : [raw];
  return parts
    .map(part => {
      const stream = doc.context.lookup(part as never);
      if (!(stream instanceof PDFStream)) return '';
      const bytes =
        stream instanceof PDFRawStream && stream.dict.get(PDFName.of('Filter'))
          ? decodePDFRawStream(stream).decode()
          : stream.getContents();
      return Buffer.from(bytes).toString('latin1');
    })
    .join('\n');
}

const hex = (text: string) => Buffer.from(text, 'latin1').toString('hex').toUpperCase();

test('Grayscale: converts colour text and shapes to grey and keeps the text', async ({
  page
}, info) => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage([400, 300]);
  p.drawText('Colour heading', { x: 20, y: 250, size: 20, font, color: rgb(0.9, 0.1, 0.1) });
  p.drawRectangle({ x: 20, y: 120, width: 200, height: 80, color: cmyk(0, 0.7, 1, 0) });
  p.drawText('Blue body', { x: 20, y: 60, size: 14, font, color: rgb(0, 0, 1) });
  const file = info.outputPath('colour.pdf');
  writeFileSync(file, await doc.save());

  await openApp(page);
  await page.locator('input[type="file"]').setInputFiles(file);
  await expect(page.getByRole('listbox', { name: /Pages of/ })).toBeVisible({ timeout: 30_000 });
  await gotoTool(page, 'grayscale');
  await expect(page.getByRole('radio', { name: 'Shades of grey' })).toBeChecked();

  const bytes = await commitAndRead(page, 'Convert & export');
  const out = await PDFDocument.load(bytes);
  expect(out.getPageCount()).toBe(1);
  const content = contentText(out, 0);
  expect(content).not.toMatch(/(^|\s)[-\d.]+\s+[-\d.]+\s+[-\d.]+\s+(rg|RG)(\s|$)/);
  expect(content).not.toMatch(/(^|\s)[-\d.]+\s+[-\d.]+\s+[-\d.]+\s+[-\d.]+\s+(k|K)(\s|$)/);
  expect(content).toMatch(/\sg(\s|$)/);
  // Text is still text: the same glyph strings are shown.
  expect(content).toContain(hex('Colour heading'));
  expect(content).toContain(hex('Blue body'));

  // The panel reports what was done, measured on the output.
  await expect(page.getByText(/converted directly — text and vectors kept/)).toBeVisible();
});

test('Duplex interleave: fronts then reversed backs become reading order in the export', async ({
  page
}) => {
  const file = await ensureFixture('text-4.pdf', () => textPdf(4));
  await openApp(page);
  await page.locator('input[type="file"]').setInputFiles(file);
  await expect(page.getByRole('listbox', { name: /Pages of/ })).toBeVisible({ timeout: 30_000 });
  await gotoTool(page, 'organize');

  await expect(page.getByLabel('Number of front pages')).toHaveValue('2');
  await expect(page.getByRole('checkbox', { name: /Backs are in reverse order/ })).toBeChecked();
  await page.getByRole('button', { name: 'Interleave pages' }).click();
  await expect(page.getByText('Pages interleaved.')).toBeVisible();

  const bytes = await commitAndRead(page, 'View changes…');
  const out = await PDFDocument.load(bytes);
  const order = [0, 1, 2, 3].map(index => {
    const text = contentText(out, index);
    return [1, 2, 3, 4].find(n => text.includes(hex(`Stapler fixture page ${n}`)));
  });
  // Fronts 1, 2; backs scanned in reverse: 4 is the back of 1, 3 of 2.
  expect(order).toEqual([1, 4, 2, 3]);
});

test('Repair: a refused import offers "Try to repair", and the saved copy opens', async ({
  page
}) => {
  const truncated = path.resolve('tests/fixtures/truncated.pdf');
  await openApp(page);
  await page.locator('input[type="file"]').setInputFiles(truncated);
  const tryRepair = page.getByRole('button', { name: 'Try to repair' });
  await expect(tryRepair).toBeVisible({ timeout: 30_000 });
  await tryRepair.click();

  await expect(page.getByText('File to repair: truncated.pdf')).toBeVisible();
  const download = page.waitForEvent('download', { timeout: 60_000 });
  await page.getByRole('button', { name: 'Repair & save' }).click();
  await confirmExportReviewIfShown(page, download);
  const saved = await download;
  expect(saved.suggestedFilename()).toBe('truncated-repaired.pdf');
  const { readFileSync } = await import('node:fs');
  const bytes = new Uint8Array(readFileSync((await saved.path())!));

  const out = await PDFDocument.load(bytes);
  expect(out.getPageCount()).toBeGreaterThan(0);
  expect(contentText(out, 0)).toContain(hex('Stapler fixture page 1'));
  // The report names what was fixed.
  await expect(page.getByRole('heading', { name: 'What was found' })).toBeVisible();
  await expect(page.getByText(/cut off before its end/)).toBeVisible();
});
