/**
 * HRD-23 — export claims checked against the downloaded bytes, through the UI.
 *
 * - §11.9 / CMP-06: with Protect on, the compression report's "Compressed Size"
 *   is the byte length of the file that was actually saved (after encryption),
 *   not the size compression measured before it.
 * - §11.8 / DOC-08: the export review's "Fast web view" option (persisted, off
 *   by default) writes no object streams and puts page 1's objects first.
 *
 * Unit twin: `tests/unit/export-fast-web-view.test.ts`.
 */
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { ensureFixture, textPdf } from './fixtures';
import { commitAndRead, gotoTool, importFile, openApp } from './helpers';
import { firstPageLayout } from './pdf-bytes';

const latin1 = (bytes: Uint8Array) => Buffer.from(bytes).toString('latin1');

async function exportThroughReview(page: Page, fastWebView: boolean) {
  const download = page.waitForEvent('download', { timeout: 60_000 });
  await page.getByRole('button', { name: 'View changes' }).click();
  const review = page.getByRole('dialog', { name: 'Review before saving' });
  await expect(review).toBeVisible();
  const option = review.getByRole('checkbox', { name: 'Fast web view' });
  if (fastWebView) await option.check();
  else await expect(option).not.toBeChecked();
  await review.getByRole('button', { name: /^Save / }).click();
  return new Uint8Array(readFileSync((await (await download).path())!));
}

test('HRD-23 §11.9: with Protect on, the compression report total equals the saved file', async ({
  page
}) => {
  test.setTimeout(180_000);
  await openApp(page);
  await importFile(page, 'tests/fixtures/scanned_skewed.pdf');

  await gotoTool(page, 'metadata');
  await page.getByRole('checkbox', { name: 'Password-protect exported files' }).check();
  await page.getByLabel('Password to open').fill('correct horse');
  await page.getByLabel('Confirm password').fill('correct horse');

  await gotoTool(page, 'compress');
  await page.getByRole('button', { name: /Analyse without changing/ }).click();
  await expect(page.getByText(/Re-rendered as images/i)).toBeVisible({ timeout: 90_000 });
  const pdf = await commitAndRead(page, 'Compress & export');
  // Really encrypted: the report must describe the bytes after Protect.
  expect(latin1(pdf)).toMatch(/\/Encrypt\s/);

  const reportDownload = page.waitForEvent('download', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Export Report' }).click();
  const report = readFileSync((await (await reportDownload).path())!, 'utf8');
  const compressed = report.match(/^Compressed Size:\s*([\d,.\s]+) bytes/m);
  expect(compressed, report).not.toBeNull();
  expect(Number(compressed![1].replace(/\D/g, ''))).toBe(pdf.byteLength);
  const original = report.match(/^Original Size:\s*([\d,.\s]+) bytes/m);
  expect(Number(original![1].replace(/\D/g, ''))).toBe(
    readFileSync('tests/fixtures/scanned_skewed.pdf').byteLength
  );
});

test.describe('HRD-23 §11.8: "Fast web view" in the export review', () => {
  test('off by default: the export keeps its object streams', async ({ page }) => {
    const file = await ensureFixture('text-3.pdf', () => textPdf(3));
    await openApp(page);
    await importFile(page, file);
    await gotoTool(page, 'organize');
    const bytes = await exportThroughReview(page, false);
    expect(latin1(bytes)).toContain('/ObjStm');
  });

  test('on: no object streams, page 1’s objects first, same pages — and it stays on', async ({
    page
  }) => {
    const file = await ensureFixture('text-3.pdf', () => textPdf(3));
    await openApp(page);
    await importFile(page, file);
    await gotoTool(page, 'organize');
    const bytes = await exportThroughReview(page, true);

    const text = latin1(bytes);
    expect(text).not.toContain('/ObjStm');
    expect(text).not.toMatch(/\/Type\s*\/XRef/);
    const { pageCount, first, later } = await firstPageLayout(bytes);
    expect(pageCount).toBe(3);
    expect(first.length).toBeGreaterThan(1);
    expect(later.length).toBeGreaterThan(1);
    expect([...first, ...later].every(offset => offset >= 0)).toBe(true);
    expect(Math.max(...first)).toBeLessThan(Math.min(...later));
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(3);

    // Persisted: after a reload the next review opens with it still checked.
    await openApp(page);
    await importFile(page, file);
    await gotoTool(page, 'organize');
    await page.getByRole('button', { name: 'View changes' }).click();
    const review = page.getByRole('dialog', { name: 'Review before saving' });
    await expect(review.getByRole('checkbox', { name: 'Fast web view' })).toBeChecked();
  });
});
