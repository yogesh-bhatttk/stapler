import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { strFromU8, unzipSync } from 'fflate';
import { ensureFixture, PDF_TO_EXCEL, pdfToExcelPdf } from './fixtures';
import { gotoTool, openApp } from './helpers';

/**
 * CNV-10 — the half of the acceptance criteria a unit test cannot reach: the beta
 * label and the mandatory preview really gate the save action in a real browser,
 * and the file the browser writes is a real `.xlsx` carrying the fixture's cells.
 *
 * Everything about the *conversion* is graded in `tests/unit/pdf-to-excel.test.ts`
 * against the output bytes, cell by cell. What is here is the gate, because "the
 * save button is disabled until a preview has rendered" is a claim about the
 * shell, the worker round-trip and the panel together — the one place where
 * asserting on a label instead of on behaviour would be exactly the mistake
 * PLAN §5.5 exists to prevent.
 */
test.describe('CNV-10 — PDF to Excel', () => {
  test('labels itself beta and refuses to save until the preview has run', async ({ page }) => {
    const fixture = await ensureFixture('pdf-to-excel.pdf', pdfToExcelPdf);
    await openApp(page);
    await page.locator('input[type="file"]').setInputFiles(fixture);
    await expect(page.getByRole('listbox', { name: /Pages of/ })).toBeVisible({ timeout: 30_000 });
    await gotoTool(page, 'pdf-to-excel');

    const panel = page.getByRole('complementary', { name: /PDF to Excel options/ });
    await expect(panel).toBeVisible();

    // The beta label is in the panel itself, not only in the tool's summary line
    // (which is marketing copy the palette also shows).
    await expect(panel.getByLabel('This tool is in beta')).toBeVisible();

    // The gate: the action bar's primary CTA starts disabled, and the reason is
    // readable rather than being left to the user to guess.
    const save = page.getByRole('button', { name: 'Save .xlsx' });
    await expect(save).toBeDisabled();
    await expect(page.getByText(/Preview the conversion first/)).toBeVisible();
    await expect(panel.getByText(/A preview is required before saving/)).toBeVisible();

    // Keyboard-only: the preview control is reachable and activates with Enter.
    const preview = panel.getByRole('button', { name: 'Preview conversion' });
    await preview.focus();
    await expect(preview).toBeFocused();
    await page.keyboard.press('Enter');

    // Only once the preview exists does the CTA unlock.
    const outline = panel.getByRole('list', { name: /Sheets that will be written/ });
    await expect(outline).toBeVisible({ timeout: 60_000 });
    await expect(save).toBeEnabled();
    await expect(page.getByText(/Preview the conversion first/)).toBeHidden();

    // The preview describes real sheets, not a placeholder — including the
    // detected table's own header row, which is where a mis-clustered table is
    // visible before anything is written.
    await expect(outline.getByText('Page 1 Table')).toBeVisible();
    await expect(outline.getByText(/5 rows × 4 columns/)).toBeVisible();
    await expect(outline.getByText(/Region \| Revenue \| Units \| Change/)).toBeVisible();
    await expect(outline.getByText('Page 2 Text')).toBeVisible();

    // Changing an option must re-close the gate: the previewed bytes were built
    // the other way round.
    await panel.getByLabel('Include page text').uncheck();
    await expect(save).toBeDisabled();
    await expect(panel.getByText(/A preview is required before saving/)).toBeVisible();

    // Preview again, then save, and check what actually landed on disk.
    await panel.getByRole('button', { name: 'Preview conversion' }).click();
    await expect(save).toBeEnabled({ timeout: 60_000 });

    const download = page.waitForEvent('download', { timeout: 60_000 });
    await save.click();
    const saved = await download;
    expect(saved.suggestedFilename()).toMatch(/\.xlsx$/);
    const location = await saved.path();
    expect(location).toBeTruthy();

    const parts = unzipSync(new Uint8Array(readFileSync(location!)));
    // An `.xlsx` is an OPC package: these parts are what makes it one.
    expect(Object.keys(parts)).toContain('[Content_Types].xml');
    expect(Object.keys(parts)).toContain('xl/workbook.xml');
    expect(Object.keys(parts)).toContain('_rels/.rels');
    expect(Object.keys(parts)).toContain('xl/worksheets/sheet1.xml');

    // Page text was switched off for this save, so the workbook holds the table
    // sheet alone — and it holds every one of the fixture's cells.
    const workbook = strFromU8(parts['xl/workbook.xml']);
    expect(workbook).toContain('Page 1 Table');
    expect(workbook).not.toContain('Page 1 Text');
    const sheet = strFromU8(parts['xl/worksheets/sheet1.xml']);
    for (const cell of PDF_TO_EXCEL.table.flat()) expect(sheet).toContain(`<t>${cell}</t>`);
  });

  /**
   * The staleness rule CNV-08's audit had to add after the fact, adopted here
   * from the start: the gate keys on `historyVersion` as well as the document id,
   * because editing a document leaves its id alone — so pre-edit bytes would
   * otherwise stay marked valid and Save would write them, silently.
   */
  test('re-closes the gate when the document is edited after a preview', async ({ page }) => {
    const fixture = await ensureFixture('pdf-to-excel.pdf', pdfToExcelPdf);
    await openApp(page);
    await page.locator('input[type="file"]').setInputFiles(fixture);
    await expect(page.getByRole('listbox', { name: /Pages of/ })).toBeVisible({ timeout: 30_000 });
    await gotoTool(page, 'pdf-to-excel');

    const panel = page.getByRole('complementary', { name: /PDF to Excel options/ });
    const save = page.getByRole('button', { name: 'Save .xlsx' });

    await panel.getByRole('button', { name: 'Preview conversion' }).click();
    await expect(panel.getByRole('list', { name: /Sheets that will be written/ })).toBeVisible({
      timeout: 90_000
    });
    await expect(save).toBeEnabled();

    // Edit the document somewhere else: delete a page in Organize, through the
    // keyboard. Same document, same id — different content.
    await gotoTool(page, 'organize');
    const grid = page.getByRole('listbox', { name: /Pages of/ });
    await expect(grid.getByRole('option')).toHaveCount(2);
    await grid.getByRole('option', { name: /^Page 2 of/ }).focus();
    await page.keyboard.press('Delete');
    await expect(grid.getByRole('option')).toHaveCount(1);

    // Back in the converter, the held bytes are pre-edit, so the gate must be
    // shut again and say so.
    await gotoTool(page, 'pdf-to-excel');
    await expect(panel).toBeVisible();
    await expect(save).toBeDisabled();
    await expect(page.getByText(/Preview the conversion first/)).toBeVisible();
    await expect(panel.getByText(/A preview is required before saving/)).toBeVisible();

    // And it is not a permanent lock: converting again re-opens it.
    await panel.getByRole('button', { name: 'Preview conversion' }).click();
    await expect(save).toBeEnabled({ timeout: 90_000 });
  });

  test('renders in the dark theme with no literal colour of its own', async ({ page }) => {
    const fixture = await ensureFixture('pdf-to-excel.pdf', pdfToExcelPdf);
    await openApp(page);
    await page.locator('input[type="file"]').setInputFiles(fixture);
    await expect(page.getByRole('listbox', { name: /Pages of/ })).toBeVisible({ timeout: 30_000 });
    await gotoTool(page, 'pdf-to-excel');

    const panel = page.getByRole('complementary', { name: /PDF to Excel options/ });
    const heading = panel.getByRole('heading', { level: 1, name: 'PDF to Excel' });
    const beforeInk = await heading.evaluate(el => getComputedStyle(el).color);

    await page.getByRole('button', { name: 'Switch to dark theme' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    // The panel's own text colour has to have moved with the theme. Every colour
    // in this panel comes from a token, so a value that did *not* change would
    // mean a literal had crept in — which is what invariant 3 forbids.
    const afterInk = await heading.evaluate(el => getComputedStyle(el).color);
    expect(afterInk).not.toBe(beforeInk);

    // …and the gate is still legible and still doing its job in the dark theme.
    await expect(panel.getByLabel('This tool is in beta')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save .xlsx' })).toBeDisabled();
    await expect(page.getByText(/Preview the conversion first/)).toBeVisible();
  });
});
