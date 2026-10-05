/**
 * HRD-37 — the picker-only error paths, through real `FileSystemHandle`s
 * (OPFS behind the picker API, `fake-fs.ts`), since the repo has no component
 * harness:
 *
 * - §3 #7: reopening from Recents a handle whose file is gone shows "Permission
 *   was declined, or the file has moved…". OPFS handles report `granted`, so
 *   this is exactly the "permission says yes, the file is gone" case:
 *   `getFile()` throws a real `NotFoundError`.
 * - §3 #9: folder-search results apply only for the latest query.
 */
import { expect, test, type Page } from '@playwright/test';
import { contractV1Pdf, ensureFixture, textPdf } from './fixtures';
import { gotoTool } from './helpers';
import { openAppWithFakeFs, queuePick, removeFakeFile, writeFakeFiles } from './fake-fs';

/** Opens a fake-disk file through Home's drop zone, i.e. through `showOpenFilePicker`. */
async function openThroughPicker(page: Page, filePath: string) {
  await queuePick(page, filePath);
  await page.locator('label[aria-label="Choose PDFs or images to open"]').click();
  await expect(page.getByRole('listbox', { name: /Pages of/ })).toBeVisible({ timeout: 30_000 });
}

/** Reloads to Home, declining session restore so Recents is all that is left. */
async function reloadToHome(page: Page) {
  await page.evaluate(() => (window.location.hash = '#/'));
  await page.reload();
  const recovery = page.getByRole('dialog', { name: 'Restore your previous session?' });
  await recovery.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
  if (await recovery.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'Start fresh' }).click();
    await expect(recovery).toBeHidden();
  }
  await expect(page.getByRole('heading', { name: 'Recent' })).toBeVisible({ timeout: 15_000 });
}

test.describe('HRD-37 §3 #7 — Recents', () => {
  test('a Recents entry reopens the file it was opened from', async ({ page }) => {
    await openAppWithFakeFs(page);
    await writeFakeFiles(page, { 'docs/report.pdf': await textPdf(2) });
    await openThroughPicker(page, 'docs/report.pdf');

    await reloadToHome(page);
    await page.getByRole('button', { name: 'report.pdf', exact: true }).click();
    const grid = page.getByRole('listbox', { name: 'Pages of report.pdf' });
    await expect(grid.getByRole('option')).toHaveCount(2, { timeout: 30_000 });
  });

  test('a Recents entry whose file was deleted says it moved, and opens nothing', async ({
    page
  }) => {
    await openAppWithFakeFs(page);
    await writeFakeFiles(page, { 'docs/report.pdf': await textPdf(2) });
    await openThroughPicker(page, 'docs/report.pdf');

    await reloadToHome(page);
    await removeFakeFile(page, 'docs/report.pdf');
    await page.getByRole('button', { name: 'report.pdf', exact: true }).click();

    await expect(page.getByText('Could not reopen report.pdf.')).toBeVisible();
    await expect(
      page.getByText('Permission was declined, or the file has moved. Open it again from disk.')
    ).toBeVisible();
    // Not the generic internal-error copy, and no tab.
    await expect(page.getByText(/something went wrong|file an issue/i)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Close report.pdf' })).toHaveCount(0);
  });
});

test('HRD-37 §3 #9 — folder search shows the latest query, not a slower earlier one', async ({
  page
}) => {
  const [text, contract] = await Promise.all([
    ensureFixture('text-2.pdf', () => textPdf(2)),
    ensureFixture('contract-v1.pdf', contractV1Pdf)
  ]);
  await openAppWithFakeFs(page);
  await writeFakeFiles(page, { 'folder/body.pdf': text, 'folder/contract.pdf': contract });
  // The OCR panel, which hosts folder search, needs an open document.
  await page.locator('input[type="file"]').setInputFiles(text);
  await expect(page.getByRole('listbox', { name: /Pages of/ })).toBeVisible({ timeout: 30_000 });
  await gotoTool(page, 'ocr');

  await queuePick(page, 'folder');
  await page.getByRole('button', { name: 'Select Folder' }).click();
  await page.getByRole('button', { name: 'Index PDFs' }).click();
  await expect(page.getByText(/Indexed 2 PDFs/)).toBeVisible({ timeout: 60_000 });

  const results = page.locator('li').filter({ has: page.getByText(/^Page \d+$/) });
  const box = page.getByLabel('Search indexed PDFs');

  // Each query on its own finds only its own file.
  await box.fill('fixture');
  await expect(results.first()).toContainText('body.pdf');
  await expect(results.filter({ hasText: 'contract.pdf' })).toHaveCount(0);

  // A six-token query (six index reads) then, in the same task, a one-token
  // one: the first lookup finishes last. Without `searchSeq` its body.pdf hits
  // overwrote the contract.pdf hits for the query actually in the box.
  await box.fill('');
  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>(
      'input[placeholder="Type search terms..."]'
    );
    if (!input) throw new Error('search box not found');
    for (const value of ['stapler fixture page line body text', 'agreement']) {
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  await expect(box).toHaveValue('agreement');
  await expect(results.first()).toContainText('contract.pdf');
  // Long enough for the slower, older lookup to have landed if it were allowed to.
  await page.waitForTimeout(1500);
  await expect(results.filter({ hasText: 'body.pdf' })).toHaveCount(0);
  await expect(results.filter({ hasText: 'contract.pdf' })).not.toHaveCount(0);
});
