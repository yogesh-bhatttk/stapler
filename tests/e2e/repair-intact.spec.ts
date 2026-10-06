import { expect, test } from '@playwright/test';
import { ensureFixture, textPdf } from './fixtures';
import { gotoTool, openApp } from './helpers';

/**
 * DOC-13 AC, the UI half — an intact file goes through Repair and comes back
 * "already valid". The byte-level round trip (no findings, page text, size and
 * rotation unchanged in the output, read by pdf.js and pdf-lib) is
 * `tests/unit/repair-intact.test.ts`; this checks what the user is told, and
 * that nothing is written for a file that needed no repair.
 */
test('Repair: an intact open document is reported as already valid and nothing is saved', async ({
  page
}) => {
  const file = await ensureFixture('text-3.pdf', () => textPdf(3));
  await openApp(page);
  await page.locator('input[type="file"]').setInputFiles(file);
  await expect(page.getByRole('listbox', { name: /Pages of/ })).toBeVisible({ timeout: 30_000 });
  let downloads = 0;
  page.on('download', () => downloads++);

  await gotoTool(page, 'repair');
  await expect(
    page.getByText('The open document, text-3.pdf, will be checked and repaired.')
  ).toBeVisible();
  await page.getByRole('button', { name: 'Repair & save' }).click();

  await expect(page.getByRole('heading', { name: 'What was found' })).toBeVisible({
    timeout: 30_000
  });
  await expect(
    page.getByText('No damage was found — this file opens cleanly as it is.')
  ).toBeVisible();
  await expect(page.getByText('Pages: 3 before → 3 after.')).toBeVisible();
  await expect(
    page.getByText('text-3.pdf opens cleanly as it is, so nothing was saved.')
  ).toBeVisible();
  // No "repaired copy" is offered, and none was written.
  await expect(page.getByRole('button', { name: 'Open the repaired copy' })).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Review before saving' })).toHaveCount(0);
  expect(downloads).toBe(0);
});
