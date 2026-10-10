/**
 * AUDIT-2026-10-10 M7 / UI#5 — Insert pages with an image.
 *
 * `InsertPanel` asked for image import options but never rendered the dialog
 * that answers, so choosing an image hung forever with the button disabled.
 * The dialog must appear, and confirming it must insert the page.
 *
 * Written for the e2e suite; not run by the fix agent (RULES.md §3).
 */
import { expect, test } from '@playwright/test';
import { openAppWithFakeFs, queuePick, writeFakeFiles } from './fake-fs';
import { gotoTool, importFile } from './helpers';
import { ensureFixture, textPdf } from './fixtures';

test('Insert pages: an image shows the import-options dialog and is inserted', async ({ page }) => {
  await openAppWithFakeFs(page);
  // Small enough that every tile is mounted: the grid virtualises its rows.
  await importFile(page, await ensureFixture('text-4.pdf', () => textPdf(4)));
  const grid = page.getByRole('listbox', { name: /Pages of/ });
  const before = await grid.getByRole('option').count();

  await writeFakeFiles(page, { 'in/photo.jpg': 'tests/fixtures/phone-photo-01.jpg' });
  await gotoTool(page, 'insert');
  await queuePick(page, 'in/photo.jpg');
  const choose = page.getByRole('button', { name: 'Choose PDFs or images to insert' });
  await choose.click();

  const dialog = page.getByRole('dialog', { name: /^Import 1 images?$/ });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Import' }).click();

  await expect(grid.getByRole('option')).toHaveCount(before + 1, { timeout: 30_000 });
  await expect(choose).toBeEnabled();
});

test('Insert pages: cancelling the image dialog leaves the document and re-enables the button', async ({
  page
}) => {
  await openAppWithFakeFs(page);
  // Small enough that every tile is mounted: the grid virtualises its rows.
  await importFile(page, await ensureFixture('text-4.pdf', () => textPdf(4)));
  const grid = page.getByRole('listbox', { name: /Pages of/ });
  const before = await grid.getByRole('option').count();

  await writeFakeFiles(page, { 'in/photo.jpg': 'tests/fixtures/phone-photo-01.jpg' });
  await gotoTool(page, 'insert');
  await queuePick(page, 'in/photo.jpg');
  const choose = page.getByRole('button', { name: 'Choose PDFs or images to insert' });
  await choose.click();

  const dialog = page.getByRole('dialog', { name: /^Import 1 images?$/ });
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(choose).toBeEnabled();
  await expect(grid.getByRole('option')).toHaveCount(before);
});
