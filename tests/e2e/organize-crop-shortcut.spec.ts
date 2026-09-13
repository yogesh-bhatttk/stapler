/**
 * UX-06 — Organize's "Crop…" button is a shortcut into the Crop tool, scoped
 * from whatever is currently selected in the page grid: nothing selected
 * means "all pages", one page selected means "just that page", and a
 * selection Crop's own scope model (current/all/odd/even) cannot express
 * (more than one page, fewer than all) just disables the button rather than
 * guessing at a scope. No prior test coverage existed for any of this.
 */
import { expect, test } from '@playwright/test';
import path from 'node:path';
import { FIXTURES_DIR } from './fixtures';
import { openApp, gotoTool, importFile } from './helpers';

test.describe('organize: shortcut into Crop', () => {
  test('nothing selected scopes the crop to all pages', async ({ page }) => {
    await openApp(page);
    await importFile(page, path.join(FIXTURES_DIR, 'bookmarked-9.pdf'));
    await gotoTool(page, 'organize');

    await page.getByRole('button', { name: 'Crop…' }).click();
    await expect(page.getByLabel('Apply crop to')).toHaveValue('all');
  });

  test('selecting exactly one page scopes the crop to that page', async ({ page }) => {
    await openApp(page);
    await importFile(page, path.join(FIXTURES_DIR, 'bookmarked-9.pdf'));
    await gotoTool(page, 'organize');

    const grid = page.getByRole('listbox', { name: /Pages of/ });
    await grid.getByRole('option', { name: /^Page 3 of/ }).click();
    await page.getByRole('button', { name: 'Crop…' }).click();

    await expect(page.getByLabel('Apply crop to')).toHaveValue('current');
    // The shortcut also has to move the crop canvas's own active page, not
    // just the scope setting, or "current" would silently mean whichever
    // page Crop last happened to be looking at.
    await expect(page.getByText('Page 3', { exact: false }).first()).toBeVisible();
  });

  test('selecting more than one page disables the shortcut rather than guessing a scope', async ({
    page
  }) => {
    await openApp(page);
    await importFile(page, path.join(FIXTURES_DIR, 'bookmarked-9.pdf'));
    await gotoTool(page, 'organize');

    const grid = page.getByRole('listbox', { name: /Pages of/ });
    await grid.getByRole('option', { name: /^Page 1 of/ }).click();
    await grid.getByRole('option', { name: /^Page 2 of/ }).click({ modifiers: ['Shift'] });

    await expect(page.getByRole('button', { name: 'Crop…' })).toBeDisabled();
  });
});
