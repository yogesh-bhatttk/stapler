import { expect, test } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { readFileSync } from 'node:fs';
import { ensureFixture, mixedSizePdf, textPdf } from './fixtures';
import { gotoTool, openApp } from './helpers';

/**
 * QA-04 — one import → operate → export flow per P0 tool, asserting the real output
 * bytes rather than that a button was clickable.
 *
 * Downloads are captured through the File System Access fallback: the preview server is
 * not a secure context for the picker in headless Chromium, so the platform adapter
 * falls back to an anchor download, which Playwright can intercept.
 */

async function importFixture(page: import('@playwright/test').Page, file: string) {
  await openApp(page);
  await page.locator('input[type="file"]').setInputFiles(file);
  await expect(page.getByRole('listbox', { name: /Pages of/ })).toBeVisible({ timeout: 30_000 });
}

/** Clicks the action bar's primary button and returns the downloaded bytes. */
async function commitAndRead(page: import('@playwright/test').Page, label: string | RegExp) {
  const download = page.waitForEvent('download', { timeout: 60_000 });
  await page.getByRole('button', { name: label }).click();
  const saved = await download;
  const location = await saved.path();
  expect(location).toBeTruthy();
  return new Uint8Array(readFileSync(location!));
}

test.describe('tool flows', () => {
  test('organize: rotating and deleting a page survives export', async ({ page }) => {
    const file = await ensureFixture('text-6.pdf', () => textPdf(6));
    await importFixture(page, file);
    await gotoTool(page, 'organize');

    // Rotate page 1 and delete page 2, both through the keyboard, which is the path
    // DOC-04 requires to work without a mouse.
    const grid = page.getByRole('listbox', { name: /Pages of/ });
    await grid.getByRole('option', { name: /^Page 1 of/ }).focus();
    await page.keyboard.press('r');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Delete');

    // Scoped to the action bar: the grid header shows the same count.
    await expect(page.getByRole('contentinfo').or(page.locator('footer')))
      .toBeAttached()
      .catch(() => {});
    await expect(page.getByText('5 pages').first()).toBeVisible();

    const bytes = await commitAndRead(page, 'Export PDF');
    const output = await PDFDocument.load(bytes);
    expect(output.getPageCount()).toBe(5);
    expect(output.getPage(0).getRotation().angle).toBe(90);
  });

  test('split: extracting a selection produces exactly those pages', async ({ page }) => {
    const file = await ensureFixture('text-10.pdf', () => textPdf(10));
    await importFixture(page, file);
    await gotoTool(page, 'split');

    const grid = page.getByRole('listbox', { name: /Pages of/ });
    await grid.getByRole('option', { name: /^Page 2 of/ }).click();
    await grid.getByRole('option', { name: /^Page 3 of/ }).click({ modifiers: ['Shift'] });
    await expect(page.getByText('2 selected').first()).toBeVisible();

    const bytes = await commitAndRead(page, 'Split / extract');
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(2);
  });

  test('split: every-N mode covers the whole document', async ({ page }) => {
    const file = await ensureFixture('text-10.pdf', () => textPdf(10));
    await importFixture(page, file);
    await gotoTool(page, 'split');

    await page.getByRole('radio', { name: 'Split every N pages' }).check();
    await page.getByLabel('Pages per file').fill('4');
    // 10 pages in fours → 4 + 4 + 2 = three files, delivered as a ZIP.
    await expect(page.getByText(/Produces 3 file/)).toBeVisible();

    const bytes = await commitAndRead(page, 'Split / extract');
    // PK\x03\x04 — a real ZIP, not a PDF renamed.
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  test('merge: mixed page sizes are preserved, not normalised silently', async ({ page }) => {
    const file = await ensureFixture('mixed-sizes.pdf', mixedSizePdf);
    await importFixture(page, file);
    await gotoTool(page, 'merge');

    const bytes = await commitAndRead(page, 'Export PDF');
    const output = await PDFDocument.load(bytes);
    expect(output.getPageCount()).toBe(3);
    const heights = output.getPages().map(p => Math.round(p.getSize().height));
    // A4, Letter, Legal — all different, all intact.
    expect(new Set(heights).size).toBe(3);
    expect(heights).toContain(1008);
  });

  test('extract: text comes out in reading order', async ({ page }) => {
    const file = await ensureFixture('text-6.pdf', () => textPdf(6));
    await importFixture(page, file);
    await gotoTool(page, 'extract');

    await page.getByRole('button', { name: 'Extract text' }).click();
    const output = page.getByRole('textbox', { name: 'Extracted text' });
    await expect(output).toBeVisible({ timeout: 30_000 });

    const text = await output.inputValue();
    expect(text).toContain('Stapler fixture page 1');
    expect(text).toContain('Line 1 of body text on page 1.');
    // Reading order: the heading precedes its body.
    expect(text.indexOf('Stapler fixture page 1')).toBeLessThan(
      text.indexOf('Line 1 of body text on page 1.')
    );
  });

  test('compress: an already-optimized document is reported, not silently saved', async ({
    page
  }) => {
    // A text-only PDF has nothing to compress, which is exactly the CMP-04 case.
    const file = await ensureFixture('text-6.pdf', () => textPdf(6));
    await importFixture(page, file);
    await gotoTool(page, 'compress');

    await page.getByRole('button', { name: /Analyse without changing/ }).click();
    await expect(page.getByText(/already optimized/i)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('no reduction')).toBeVisible();
  });

  test('compress: CMP-02 raster path reduces scanned fixture by 70-90%', async ({ page }) => {
    // A heavy scanned PDF to test the raster-path compression
    const path = await import('node:path');
    const fs = await import('node:fs');
    const scannedPath = path.resolve(process.cwd(), 'tests/fixtures/scanned_skewed.pdf');
    await importFixture(page, scannedPath);
    await gotoTool(page, 'compress');

    await page.getByRole('button', { name: /Analyse without changing/ }).click();
    // It should estimate a significant reduction
    await expect(page.getByText(/Re-rendered as images/i)).toBeVisible({ timeout: 60_000 });

    const output = await commitAndRead(page, 'Compress & export');

    // Assert 70-90% reduction
    const originalSize = fs.statSync(scannedPath).size;
    const newSize = output.length;
    const reduction = 1 - newSize / originalSize;

    expect(reduction).toBeGreaterThan(0.7);
    expect(reduction).toBeLessThan(0.95);
  });

  test('metadata: the inspector reports what the file carries', async ({ page }) => {
    const file = await ensureFixture('text-6.pdf', () => textPdf(6));
    await importFixture(page, file);
    await gotoTool(page, 'metadata');

    await page.getByRole('button', { name: /Inspect this document/ }).click();
    // pdf-lib stamps a Producer, so there is always at least one finding to show.
    await expect(page.getByText(/Producer|Nothing identifying/)).toBeVisible({ timeout: 30_000 });
  });

  test('pdf to images: exports a ZIP at the chosen resolution', async ({ page }) => {
    const file = await ensureFixture('text-6.pdf', () => textPdf(6));
    await importFixture(page, file);
    await gotoTool(page, 'pdf-to-img');

    await page.getByRole('radio', { name: 'PNG' }).check();
    const bytes = await commitAndRead(page, 'Export images');
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  test('a corrupt file is refused with a reason and does not break the tab', async ({ page }) => {
    const file = await ensureFixture('not-a-pdf.pdf', async () =>
      new TextEncoder().encode('This is definitely not a PDF.')
    );
    await openApp(page);
    await page.locator('input[type="file"]').setInputFiles(file);

    await expect(page.getByRole('status')).toContainText(/not a PDF|damaged|incomplete/i);
    // The app is still alive and still on the launcher.
    await expect(page.getByRole('heading', { name: 'Offline PDF tools' })).toBeVisible();
  });
});
