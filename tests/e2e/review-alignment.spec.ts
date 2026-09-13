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

  test('a crop shows both pages side by side, not just the after page', async ({ page }) => {
    await openApp(page);
    await importFile(page, path.join(FIXTURES_DIR, 'bookmarked-9.pdf'));
    await gotoTool(page, 'crop');

    const cropCanvas = page.locator('[aria-label="Page preview, scrollable"] canvas').first();
    await expect(cropCanvas).toBeVisible();
    const box = await cropCanvas.boundingBox();
    if (!box) throw new Error('crop canvas has no bounding box');
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.8, { steps: 5 });
    await page.mouse.up();

    await page.getByRole('button', { name: 'View changes' }).click();
    const dialog = page.getByRole('dialog', { name: 'Review before saving' });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByText(
        'This page changed size, so before and after cannot be lined up pixel for pixel.'
      )
    ).toBeVisible();
    await expect(dialog.getByText('Before', { exact: true })).toBeVisible();
    await expect(dialog.getByText('After', { exact: true })).toBeVisible();
    // Both a genuinely different-sized "before" and "after" render, not one
    // discarded in favour of the other.
    await expect(dialog.locator('canvas')).toHaveCount(2);
  });

  test('a rotated page compares cleanly, not as a false "changed size"', async ({ page }) => {
    await openApp(page);
    await importFile(page, path.join(FIXTURES_DIR, 'bookmarked-9.pdf'));
    await gotoTool(page, 'organize');

    const grid = page.getByRole('listbox', { name: /Pages of/ });
    await grid.getByRole('option', { name: /^Page 1 of/ }).focus();
    await page.keyboard.press('r');

    await page.getByRole('button', { name: 'View changes' }).click();
    const dialog = page.getByRole('dialog', { name: 'Review before saving' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Rotated', { exact: true })).toBeVisible();
    // A 90° rotation swaps rendered width/height; the diff renders "before" at
    // the page's own new rotation so the two still line up pixel for pixel —
    // proven by the highlight toggle being offered at all (only shown for a
    // comparable pair) and the size-change note being absent.
    await expect(dialog.getByRole('button', { name: 'Highlight changes' })).toBeVisible();
    await expect(
      dialog.getByText(
        'This page changed size, so before and after cannot be lined up pixel for pixel.'
      )
    ).not.toBeVisible();
  });

  test('an N-up export does not misapply per-page alignment badges to sheets', async ({ page }) => {
    await openApp(page);
    await importFile(page, path.join(FIXTURES_DIR, 'bookmarked-9.pdf'));
    await gotoTool(page, 'organize');

    const grid = page.getByRole('listbox', { name: /Pages of/ });
    await grid.getByRole('option', { name: /^Page 1 of/ }).focus();
    await page.keyboard.press('r');

    await gotoTool(page, 'nup');
    await page.getByLabel('Layout', { exact: true }).selectOption('2-up');
    await page.getByRole('button', { name: 'Export layout' }).click();

    const dialog = page.getByRole('dialog', { name: 'Review before saving' });
    await expect(dialog).toBeVisible();
    // Each output sheet combines two original pages — a page-level alignment
    // entry (rotated/moved/new, keyed by *original* page position) read at a
    // *sheet* index would name the wrong baseline page, so none of that
    // metadata is shown at all once N-up is active; the review still opens
    // and Save still works, just without a misleading badge.
    await expect(dialog.getByText('Rotated', { exact: true })).not.toBeVisible();
    await expect(dialog.getByText(/Was page/)).not.toBeVisible();
    await expect(dialog.getByRole('button', { name: /^Save /, exact: false })).toBeEnabled();
  });

  test('a duplicated page is badged "New page", not the misleading size-change note', async ({
    page
  }) => {
    await openApp(page);
    await importFile(page, path.join(FIXTURES_DIR, 'bookmarked-9.pdf'));
    await gotoTool(page, 'organize');

    const grid = page.getByRole('listbox', { name: /Pages of/ });
    await grid.getByRole('option', { name: /^Page 1 of/ }).click();
    await page.getByRole('button', { name: 'Duplicate' }).click();
    await expect(page.getByText('10 pages', { exact: false }).first()).toBeVisible();

    await page.getByRole('button', { name: 'View changes' }).click();
    const dialog = page.getByRole('dialog', { name: 'Review before saving' });
    await expect(dialog).toBeVisible();

    // The duplicate lands right after its source (page 2 of 10).
    await dialog.getByRole('button', { name: 'Next page' }).click();
    await expect(dialog.getByText('New page', { exact: true })).toBeVisible();
    await expect(
      dialog.getByText(
        'This page changed size, so before and after cannot be lined up pixel for pixel.'
      )
    ).not.toBeVisible();
  });
});
