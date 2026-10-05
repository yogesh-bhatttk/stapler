/**
 * Batch over a real folder, through the real Batch panel and the real pdf.js.
 *
 * - HRD-32 / AUDIT-EDGE-CASES-2026-09-15 §1.8: a folder holding `not-a-pdf.pdf`,
 *   an empty file and `truncated-mid-body.pdf` reports three classified failures
 *   and still processes the good files. The unit suite (`batch-runner.test.ts`)
 *   stubs the render worker, so only here does a truncated file meet pdf.js.
 * - HRD-37 / §3 #10: the ZIP-output picker feature-detects like its siblings.
 *
 * The folders are OPFS directories behind the real picker API (`fake-fs.ts`);
 * outputs are read back from them byte for byte.
 */
import { expect, test } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { unzipSync } from 'fflate';
import { ensureFixture, textPdf } from './fixtures';
import { gotoTool } from './helpers';
import { openAppWithFakeFs, queuePick, readFakeDir, writeFakeFiles } from './fake-fs';

async function seedFolder(page: import('@playwright/test').Page) {
  const [two, three] = await Promise.all([
    ensureFixture('text-2.pdf', () => textPdf(2)),
    ensureFixture('text-3.pdf', () => textPdf(3))
  ]);
  await writeFakeFiles(page, {
    'in/good-two.pdf': two,
    'in/good-three.pdf': three,
    'in/not-a-pdf.pdf': 'tests/fixtures/not-a-pdf.pdf',
    'in/empty.pdf': new Uint8Array(),
    'in/truncated-mid-body.pdf': 'tests/fixtures/truncated-mid-body.pdf'
  });
}

/** The panel's per-file notes (failures and kept-original), `file → detail`. */
async function failureNotes(page: import('@playwright/test').Page) {
  const rows = await page.getByRole('listitem').filter({ hasText: ' — ' }).allInnerTexts();
  return Object.fromEntries(
    rows.map(row => {
      const [file, ...detail] = row.split(' — ');
      return [file.trim(), detail.join(' — ').trim()];
    })
  );
}

test.describe('batch over a folder with bad files (HRD-32 §1.8)', () => {
  test('three bad files fail with classified reasons; the two good ones are written', async ({
    page
  }) => {
    await openAppWithFakeFs(page);
    await seedFolder(page);
    await gotoTool(page, 'batch');

    await queuePick(page, 'in');
    await page.getByRole('button', { name: 'Select Input Folder' }).click();
    await expect(page.getByRole('button', { name: 'Input: in' })).toBeVisible();
    await queuePick(page, 'out');
    await page.getByRole('button', { name: 'Select Output Folder' }).click();
    await expect(page.getByRole('button', { name: 'Output: out/' })).toBeVisible();

    await page
      .getByLabel('Batch process options')
      .getByRole('button', { name: 'Run Batch' })
      .click();
    await expect(page.getByText('Batch Processing Complete').first()).toBeVisible({
      timeout: 60_000
    });

    const notes = await failureNotes(page);
    expect(notes).toEqual({
      'empty.pdf': 'The file is empty.',
      'not-a-pdf.pdf': 'The file does not start with a PDF header, so it is not a PDF.',
      // pdf.js's own verdict, classified — not a raw TypeError, and not a
      // silently shortened file.
      'truncated-mid-body.pdf':
        'The file is not a readable PDF — its structure is invalid or truncated.',
      // The good files ran; the default recipe's compress step had nothing to do.
      'good-two.pdf': 'Already optimised — there was nothing left to compress.',
      'good-three.pdf': 'Already optimised — there was nothing left to compress.'
    });
    await expect(page.getByText(/Successfully processed 2 files\. 3 failed\./)).toBeVisible();

    const written = await readFakeDir(page, 'out');
    expect(Object.keys(written).sort()).toEqual(['good-three.pdf', 'good-two.pdf']);
    expect((await PDFDocument.load(written['good-two.pdf'])).getPageCount()).toBe(2);
    expect((await PDFDocument.load(written['good-three.pdf'])).getPageCount()).toBe(3);
  });

  test('the same folder to a ZIP holds only the good files', async ({ page }) => {
    await openAppWithFakeFs(page);
    await seedFolder(page);
    await gotoTool(page, 'batch');

    await queuePick(page, 'in');
    await page.getByRole('button', { name: 'Select Input Folder' }).click();
    await queuePick(page, 'zips/batch-output.zip');
    await page.getByRole('button', { name: 'Select Output ZIP' }).click();
    await expect(page.getByRole('button', { name: 'Output: batch-output.zip' })).toBeVisible();

    await page
      .getByLabel('Batch process options')
      .getByRole('button', { name: 'Run Batch' })
      .click();
    await expect(page.getByText('Batch Processing Complete').first()).toBeVisible({
      timeout: 60_000
    });

    const zip = unzipSync((await readFakeDir(page, 'zips'))['batch-output.zip']);
    expect(Object.keys(zip).sort()).toEqual(['good-three.pdf', 'good-two.pdf']);
    expect((await PDFDocument.load(zip['good-three.pdf'])).getPageCount()).toBe(3);
  });
});

test('HRD-37 §3 #10: without a save picker, "Select Output ZIP" says why instead of a raw error', async ({
  page
}) => {
  // Firefox/Safari shape: no showSaveFilePicker.
  await openAppWithFakeFs(page, { saveFilePicker: false });
  await gotoTool(page, 'batch');
  await page.getByRole('button', { name: 'Select Output ZIP' }).click();

  await expect(page.getByText('Saving a ZIP file this way is unavailable')).toBeVisible();
  await expect(
    page.getByText(
      'Batch processing requires a browser with File System Access support (Chrome or Edge).'
    )
  ).toBeVisible();
  await expect(page.getByText(/showSaveFilePicker/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Select Output ZIP' })).toBeVisible();
});
