/**
 * GAP-4 / GAP-5 — "compress PDF to 100 KB" landing pages and image target sizes,
 * against the built web twin.
 *
 * Asserted on real output: the landing page's pre-filled target is read from
 * the live Compress panel after a real import, and the image-to-size download
 * is measured byte for byte against the target the link set.
 */
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import { confirmExportReviewIfShown, gotoTool, importFile, useDownloadFallback } from './helpers';

/** `openApp`, for any entry page: clears the first-run and recovery dialogs. */
async function openPage(page: Page, path: string) {
  await useDownloadFallback(page);
  await page.goto(path);
  const dialog = page.getByRole('dialog', { name: 'Welcome to Stapler' });
  await dialog.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
  if (await dialog.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'Get started' }).click();
    await expect(dialog).toBeHidden();
  }
  const recovery = page.getByRole('dialog', { name: 'Restore your previous session?' });
  if (await recovery.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'Start fresh' }).click();
    await expect(recovery).toBeHidden();
  }
}

/**
 * Opens a PDF from the tool's own empty state ("Open a document or image…"),
 * which is what a landing-page visitor sees first — there is no drop zone on
 * a tool route.
 */
async function importPdfIntoCompress(page: Page, file: string) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open a document or image…' }).click();
  await (await chooser).setFiles(file);
  await expect(page.getByRole('group', { name: 'How should Stapler compress?' })).toBeVisible({
    timeout: 30_000
  });
}

test.describe('GAP-4 — compress PDF to a size', () => {
  test('compress-pdf-to-100kb.html opens Compress with 100 KB pre-filled', async ({ page }) => {
    await openPage(page, '/compress-pdf-to-100kb.html');
    await expect(page.getByRole('heading', { name: 'Compress a PDF to 100 KB' })).toBeVisible();
    // The link's query is applied, then stripped so a reload can't re-apply it
    // over the person's own edit.
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/tool/compress');

    await importPdfIntoCompress(page, 'tests/fixtures/mixed-text-image-flate.pdf');
    await expect(page.getByRole('radio', { name: /Aim for a size/ })).toBeChecked();
    await expect(page.locator('[data-target-amount]')).toHaveValue('100');
    await expect(page.getByRole('combobox', { name: 'Target size unit' })).toHaveValue('KB');
  });

  test('the 1 MB page pre-fills 1 MB, and the pick-your-own page only picks the mode', async ({
    page
  }) => {
    await openPage(page, '/compress-pdf-to-1mb.html');
    await importPdfIntoCompress(page, 'tests/fixtures/text-2.pdf');
    await expect(page.locator('[data-target-amount]')).toHaveValue('1');
    await expect(page.getByRole('combobox', { name: 'Target size unit' })).toHaveValue('MB');

    await openPage(page, '/compress-pdf-to-size.html?target=300KB');
    await importPdfIntoCompress(page, 'tests/fixtures/text-2.pdf');
    await expect(page.getByRole('radio', { name: /Aim for a size/ })).toBeChecked();
    await expect(page.locator('[data-target-amount]')).toHaveValue('300');
    // The page's own query string is consumed too.
    expect(await page.evaluate(() => window.location.search)).toBe('');
  });

  test('the same link works in the editor', async ({ page }) => {
    await openPage(page, '/editor.html#/tool/compress?target=250kb');
    await importPdfIntoCompress(page, 'tests/fixtures/text-2.pdf');
    await expect(page.locator('[data-target-amount]')).toHaveValue('250');
    await expect(page.getByRole('combobox', { name: 'Target size unit' })).toHaveValue('KB');
  });

  test('garbage in the link is ignored', async ({ page }) => {
    await openPage(page, '/editor.html#/tool/compress?target=%3Cscript%3E');
    await importPdfIntoCompress(page, 'tests/fixtures/text-2.pdf');
    await expect(page.getByRole('radio', { name: /Choose quality/ })).toBeChecked();
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/tool/compress');
  });

  test('"Use it now" scrolls to the tool instead of routing away from it', async ({ page }) => {
    await openPage(page, '/compress-pdf-to-200kb.html');
    await page.getByRole('link', { name: 'Use it now, no install needed' }).click();
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/tool/compress');
    await expect(
      page.getByRole('heading', { name: 'Compress to 200 KB right here' })
    ).toBeFocused();
  });
});

test.describe('GAP-5 — image target sizes', () => {
  test('image to size: a 1440×960 HEIC photo comes out as a JPEG at or under 20 KB', async ({
    page
  }) => {
    await openPage(page, '/#/tool/image-to-size?target=20KB');
    await expect(page.locator('[data-image-target-amount]')).toHaveValue('20');

    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Choose an image' }).click();
    await (await chooser).setFiles('tests/fixtures/sample.heic');
    await expect(page.locator('[data-image-size-file="sample.heic"]')).toBeVisible();

    const download = page.waitForEvent('download', { timeout: 60_000 });
    await page.getByRole('button', { name: 'Resize & save' }).click();
    const saved = await download;
    expect(saved.suggestedFilename()).toBe('sample-20kb.jpg');
    const bytes = new Uint8Array(readFileSync((await saved.path())!));

    expect(bytes.byteLength).toBeLessThanOrEqual(20_000);
    expect(Array.from(bytes.subarray(0, 3))).toEqual([0xff, 0xd8, 0xff]);
    const outcome = page.locator('[data-image-size-outcome]');
    await expect(outcome).toHaveAttribute('data-image-size-outcome', 'reached');
    await expect(outcome).toHaveAttribute('data-image-size-bytes', String(bytes.byteLength));
    // The canvas previews the saved result.
    await expect(page.getByRole('img', { name: 'Resized version of sample.heic' })).toBeVisible();
  });

  test('image to size: a pixel box plus a small target, from the link', async ({ page }) => {
    await openPage(page, '/#/tool/image-to-size?target=5KB&max=16');
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Choose an image' }).click();
    await (await chooser).setFiles('tests/fixtures/face-chip.png');

    // 16 px on the longest side makes 5 KB trivially reachable.
    const download = page.waitForEvent('download', { timeout: 60_000 });
    await page.getByRole('button', { name: 'Resize & save' }).click();
    const bytes = new Uint8Array(readFileSync((await (await download).path())!));
    expect(bytes.byteLength).toBeLessThanOrEqual(5_000);
    expect(Array.from(bytes.subarray(0, 3))).toEqual([0xff, 0xd8, 0xff]);
  });

  test('pdf to images: "Aim for a file size" keeps every page at or under the target', async ({
    page
  }) => {
    await openPage(page, '/');
    await importFile(page, 'tests/fixtures/text-4.pdf');
    await gotoTool(page, 'pdf-to-img');

    await page.getByRole('radio', { name: /Aim for a file size/ }).check();
    const target = page.getByRole('spinbutton', { name: 'Size per image (KB)' });
    await target.fill('40');
    await expect(target).toHaveAttribute('data-image-target-kb', '40');

    const download = page.waitForEvent('download', { timeout: 60_000 });
    await page.getByRole('button', { name: 'Export images' }).click();
    await confirmExportReviewIfShown(page, download);
    const zip = new Uint8Array(readFileSync((await (await download).path())!));
    const files = unzipSync(zip);
    const names = Object.keys(files).sort();
    expect(names).toEqual(['page-01.jpg', 'page-02.jpg', 'page-03.jpg', 'page-04.jpg']);
    for (const name of names) {
      expect(files[name].byteLength, name).toBeLessThanOrEqual(40_000);
      expect(Array.from(files[name].subarray(0, 3)), name).toEqual([0xff, 0xd8, 0xff]);
    }
    await expect(page.locator('[data-image-target-report]')).toHaveAttribute(
      'data-image-target-report',
      'reached'
    );
  });
});
