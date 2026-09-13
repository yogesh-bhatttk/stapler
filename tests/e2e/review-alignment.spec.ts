/**
 * The "Review before saving" diff used to be blind to anything Organize did —
 * rotate/reorder/delete/duplicate mutate `doc.pages` immediately, long before
 * Export is clicked, so "before" and "after" were composed from the identical
 * page list and the diff could only ever show crop/watermark/etc. `doc.baseline`
 * (core/store.ts) plus `alignPages` (core/page-alignment.ts) fix that: "before"
 * is now built from the page list as of the last save/import, so the review
 * correctly reflects rotation, and names pages removed since then.
 */
import { expect, test } from '@playwright/test';
import path from 'node:path';
import { FIXTURES_DIR } from './fixtures';
import { openApp, gotoTool, importFile } from './helpers';

test.describe('review diff reflects organize edits', () => {
  test('a rotated page shows a "Rotated" badge in the review', async ({ page }) => {
    await openApp(page);
    await importFile(page, path.join(FIXTURES_DIR, 'bookmarked-9.pdf'));
    await gotoTool(page, 'organize');

    const grid = page.getByRole('listbox', { name: /Pages of/ });
    await grid.getByRole('option', { name: /^Page 1 of/ }).focus();
    await page.keyboard.press('r');

    await page.getByRole('button', { name: 'View changes' }).click();
    await expect(page.getByRole('dialog', { name: 'Review before saving' })).toBeVisible();
    await expect(page.getByText('Rotated', { exact: true })).toBeVisible();
    await expect(page.getByText(/rotated/i).first()).toBeVisible();
  });

  test('a removed page is named and can be previewed', async ({ page }) => {
    await openApp(page);
    await importFile(page, path.join(FIXTURES_DIR, 'bookmarked-9.pdf'));
    await gotoTool(page, 'organize');

    const grid = page.getByRole('listbox', { name: /Pages of/ });
    await grid.getByRole('option', { name: /^Page 3 of/ }).focus();
    await page.keyboard.press('Delete');

    await page.getByRole('button', { name: 'View changes' }).click();
    const dialog = page.getByRole('dialog', { name: 'Review before saving' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Removed:')).toBeVisible();

    const chip = dialog.getByRole('button', { name: 'page 3' });
    await expect(chip).toBeVisible();
    await chip.click();
    await expect(dialog.getByText('Removed — will not be in the saved file.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Back to review' }).click();
    await expect(dialog.getByText('Removed:')).toBeVisible();
  });

  test('a rotation made in Organize is still visible when reviewing from Normalize', async ({
    page
  }) => {
    await openApp(page);
    await importFile(page, path.join(FIXTURES_DIR, 'bookmarked-9.pdf'));
    await gotoTool(page, 'organize');

    const grid = page.getByRole('listbox', { name: /Pages of/ });
    await grid.getByRole('option', { name: /^Page 1 of/ }).focus();
    await page.keyboard.press('r');

    await gotoTool(page, 'normalize');
    await page.getByRole('button', { name: 'Normalize & export' }).click();
    await expect(page.getByRole('dialog', { name: 'Review before saving' })).toBeVisible();
    await expect(page.getByText(/rotated/i).first()).toBeVisible();
  });
});
