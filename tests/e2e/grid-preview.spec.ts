/**
 * Watermark and Crop are global signals composed in only at Export time — they
 * were invisible on every other tool's page grid until then, which read as
 * "did my watermark disappear?" when switching to Organize. `PageGrid.tsx` now
 * renders both as a live, read-only preview on each thumbnail via `Thumbnail`'s
 * `overlay` prop, so the pending edit stays visible while reordering, merging,
 * or doing anything else with the page grid open.
 */
import { expect, test } from '@playwright/test';
import path from 'node:path';
import { FIXTURES_DIR } from './fixtures';
import { gotoTool, importFile, openApp, waitForPageRendered } from './helpers';

test.describe('watermark/crop preview on the page grid', () => {
  test('a staged watermark and crop box are still visible after switching to Organize', async ({
    page
  }) => {
    await openApp(page);
    await importFile(page, path.join(FIXTURES_DIR, 'bookmarked-9.pdf'));

    await gotoTool(page, 'watermark');
    await page.getByRole('textbox', { name: 'Text', exact: true }).fill('CONFIDENTIAL');

    await gotoTool(page, 'crop');
    const cropCanvas = page.locator('[aria-label="Page preview, scrollable"] canvas').first();
    await expect(cropCanvas).toBeVisible();
    const box = await cropCanvas.boundingBox();
    if (!box) throw new Error('crop canvas has no bounding box');
    await waitForPageRendered(page);
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.8, { steps: 5 });
    await page.mouse.up();

    await gotoTool(page, 'organize');
    await expect(page.getByRole('listbox', { name: /Pages of/ })).toBeVisible();

    await expect(page.getByText('CONFIDENTIAL').first()).toBeVisible();
    await expect(page.getByTestId('crop-box-preview').first()).toBeVisible();
  });

  test('the staged watermark preview is hidden from the accessibility tree', async ({ page }) => {
    await openApp(page);
    await importFile(page, path.join(FIXTURES_DIR, 'bookmarked-9.pdf'));

    await gotoTool(page, 'watermark');
    await page.getByRole('textbox', { name: 'Text', exact: true }).fill('CONFIDENTIAL');

    await gotoTool(page, 'organize');
    const watermarkText = page.getByText('CONFIDENTIAL').first();
    await expect(watermarkText).toBeVisible();

    // Purely visual, like the crop-box overlay it sits alongside in every
    // thumbnail — composed into every visible page's `role="option"` cell, so
    // without this a screen reader user reviewing the grid would hear the
    // watermark text announced once per page.
    const overlay = watermarkText.locator('xpath=ancestor-or-self::*[@aria-hidden="true"][1]');
    await expect(overlay).toHaveCount(1);
  });
});
