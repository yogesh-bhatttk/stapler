/**
 * "Discard all changes…" — reverts page structure to `doc.baseline` (rotate/
 * reorder/delete/duplicate since the last import/save) and clears crop/
 * watermark/outline/redaction/annotation state alongside it, so there's a
 * single action to back out of everything rather than stepping through undo
 * one action at a time, or closing and re-importing the file.
 *
 * Lives on the action bar (src/ui/shell/ActionBar.tsx), not inside Organize's
 * panel — it's a document-level action, not specific to any one tool, so it
 * has to be reachable from whichever tool the user happens to be on.
 */
import { expect, test } from '@playwright/test';
import path from 'node:path';
import { FIXTURES_DIR } from './fixtures';
import { gotoTool, importFile, openApp, waitForPageRendered } from './helpers';

test.describe('discard all changes', () => {
  test('is not offered on a freshly opened document with nothing to discard', async ({ page }) => {
    await openApp(page);
    await importFile(page, path.join(FIXTURES_DIR, 'bookmarked-9.pdf'));
    await gotoTool(page, 'organize');

    // Nothing has been touched yet — the button must not sit there enabled,
    // ready to pop a "danger" confirmation for a click that would discard
    // nothing at all.
    await expect(page.getByRole('button', { name: 'Discard all changes…' })).toHaveCount(0);

    const grid = page.getByRole('listbox', { name: /Pages of/ });
    await grid.getByRole('option', { name: /^Page 1 of/ }).focus();
    await page.keyboard.press('r');
    await expect(page.getByRole('button', { name: 'Discard all changes…' })).toBeVisible();
  });

  test('reverts rotation, crop, and a watermark in one action', async ({ page }) => {
    await openApp(page);
    await importFile(page, path.join(FIXTURES_DIR, 'bookmarked-9.pdf'));
    await gotoTool(page, 'organize');

    const grid = page.getByRole('listbox', { name: /Pages of/ });
    await grid.getByRole('option', { name: /^Page 1 of/ }).focus();
    await page.keyboard.press('r');
    await expect(grid.getByRole('option', { name: /^Page 1 of/ }).getByText('90°')).toBeVisible();

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

    await gotoTool(page, 'watermark');
    await page.getByRole('textbox', { name: 'Text', exact: true }).fill('CONFIDENTIAL');

    await gotoTool(page, 'organize');
    await expect(grid.getByTestId('crop-box-preview').first()).toBeVisible();
    await expect(page.getByText('CONFIDENTIAL').first()).toBeVisible();

    await page.getByRole('button', { name: 'Discard all changes…' }).click();
    await page
      .getByRole('dialog', { name: 'Discard all changes to this document?' })
      .getByRole('button', { name: 'Discard everything' })
      .click();

    await expect(grid.getByRole('option', { name: /^Page 1 of/ }).getByText('90°')).toBeHidden();
    await expect(grid.getByTestId('crop-box-preview')).toHaveCount(0);
    await expect(page.getByText('CONFIDENTIAL')).toHaveCount(0);
  });

  test('cancelling the confirm dialog keeps every change', async ({ page }) => {
    await openApp(page);
    await importFile(page, path.join(FIXTURES_DIR, 'bookmarked-9.pdf'));
    await gotoTool(page, 'organize');

    const grid = page.getByRole('listbox', { name: /Pages of/ });
    await grid.getByRole('option', { name: /^Page 1 of/ }).focus();
    await page.keyboard.press('r');

    await page.getByRole('button', { name: 'Discard all changes…' }).click();
    await page
      .getByRole('dialog', { name: 'Discard all changes to this document?' })
      .getByRole('button', { name: 'Keep my changes' })
      .click();

    await expect(grid.getByRole('option', { name: /^Page 1 of/ }).getByText('90°')).toBeVisible();
  });

  test('is available from other tools too, not only Organize', async ({ page }) => {
    await openApp(page);
    await importFile(page, path.join(FIXTURES_DIR, 'bookmarked-9.pdf'));

    // Never visits Organize at all — rotates nothing, only sets a watermark
    // from the Watermark panel directly.
    await gotoTool(page, 'watermark');
    await page.getByRole('textbox', { name: 'Text', exact: true }).fill('CONFIDENTIAL');
    await expect(page.getByText('CONFIDENTIAL').first()).toBeVisible();

    await page.getByRole('button', { name: 'Discard all changes…' }).click();
    await page
      .getByRole('dialog', { name: 'Discard all changes to this document?' })
      .getByRole('button', { name: 'Discard everything' })
      .click();

    await expect(page.getByText('CONFIDENTIAL')).toHaveCount(0);
  });
});
