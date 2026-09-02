import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { EXCEL_TO_PDF, ensureFixture, excelToPdfXlsx } from './fixtures';
import { gotoTool, openApp } from './helpers';

/**
 * CNV-11 — the half of the acceptance criterion a unit test cannot reach: the
 * beta label and the mandatory preview really gate the save action in a real
 * browser, and the file the browser writes is a real PDF.
 *
 * Everything about the *conversion* is graded in `tests/unit/excel-to-pdf.test.ts`
 * against the output bytes. What is here is the gate, because "the save button is
 * disabled until a preview has rendered" is a claim about the shell, the two
 * worker round-trips and the panel together — the one place where asserting on a
 * label instead of on behaviour would be exactly the mistake PLAN §5.5 exists to
 * prevent.
 *
 * The `.xlsx` reaches the panel through the real file chooser (`openFiles` builds
 * an `<input type=file>` and clicks it), captured with Playwright's `filechooser`
 * event the same way `word-to-pdf.spec.ts` drives its picker.
 */

/** Picks the fixture through the panel's own file chooser. */
async function chooseFixture(page: import('@playwright/test').Page, file: string, label: RegExp) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: label }).click();
  await (await chooser).setFiles(file);
}

test.describe('CNV-11 — Excel to PDF', () => {
  test('labels itself beta and refuses to save until the preview has run', async ({ page }) => {
    const fixture = await ensureFixture('excel-to-pdf.xlsx', excelToPdfXlsx);
    await openApp(page);
    // No PDF is opened first on purpose: the input is the `.xlsx`, and the tool
    // is declared `worksWithoutDocument` so it does not demand an unrelated one.
    await gotoTool(page, 'excel-to-pdf');

    const panel = page.getByRole('complementary', { name: /Excel to PDF options/ });
    await expect(panel).toBeVisible();

    // The beta label is in the panel itself, not only in the tool's summary line
    // (which is marketing copy the palette also shows).
    await expect(panel.getByLabel('This tool is in beta')).toBeVisible();

    // The gate: the action bar's primary CTA starts disabled, and the reason is
    // readable rather than being left to the user to guess.
    const save = page.getByRole('button', { name: 'Save PDF' });
    await expect(save).toBeDisabled();
    await expect(page.getByText(/Choose an \.xlsx file to convert first/)).toBeVisible();

    // Nothing to preview yet, so that control is disabled too.
    await expect(panel.getByRole('button', { name: 'Preview conversion' })).toBeDisabled();

    await chooseFixture(page, fixture, /Choose an \.xlsx file/);
    await expect(panel.getByText(/excel-to-pdf\.xlsx/)).toBeVisible();

    // A file alone does not unlock the save — the preview is the gate.
    await expect(save).toBeDisabled();
    await expect(page.getByText(/Preview the conversion first/)).toBeVisible();
    await expect(panel.getByText(/A preview is required before saving/)).toBeVisible();

    // Keyboard-only: the preview control is reachable and activates with Enter.
    const preview = panel.getByRole('button', { name: 'Preview conversion' });
    await preview.focus();
    await expect(preview).toBeFocused();
    await page.keyboard.press('Enter');

    // Only once the preview exists does the CTA unlock.
    const outline = panel.getByRole('list', { name: /Sheets that will be drawn into the PDF/ });
    await expect(outline).toBeVisible({ timeout: 90_000 });
    await expect(save).toBeEnabled();
    await expect(page.getByText(/Preview the conversion first/)).toBeHidden();

    // The preview describes real structure, not a placeholder: a section per
    // visible sheet, the hidden sheet absent, and the grid's own size.
    await expect(outline.getByText(EXCEL_TO_PDF.sheets.summary, { exact: true })).toBeVisible();
    await expect(outline.getByText(EXCEL_TO_PDF.sheets.regions, { exact: true })).toBeVisible();
    await expect(outline.getByText(EXCEL_TO_PDF.sheets.blank, { exact: true })).toBeVisible();
    await expect(outline.getByText(EXCEL_TO_PDF.sheets.notes, { exact: true })).toHaveCount(0);
    await expect(outline.getByText(/Table, 4 rows × 4 columns/)).toBeVisible();

    // What was excluded is disclosed in the panel, not only in a ticket.
    const left = panel.getByRole('list', { name: /Content left out of the PDF/ });
    await expect(left.getByText(/hidden sheet/)).toBeVisible();
    await expect(left.getByText(/hidden row/)).toBeVisible();
    await expect(left.getByText(/hidden column/)).toBeVisible();

    // Changing an option must re-close the gate: the previewed bytes were laid
    // out on a different page size.
    await panel.getByLabel('Page size').selectOption('letter');
    await expect(save).toBeDisabled();
    await expect(panel.getByText(/A preview is required before saving/)).toBeVisible();

    // Preview again, then save, and check what actually landed on disk.
    await panel.getByRole('button', { name: 'Preview conversion' }).click();
    await expect(save).toBeEnabled({ timeout: 90_000 });

    const download = page.waitForEvent('download', { timeout: 60_000 });
    await save.click();
    const saved = await download;
    expect(saved.suggestedFilename()).toBe('excel-to-pdf.pdf');
    const location = await saved.path();
    expect(location).toBeTruthy();

    const bytes = new Uint8Array(readFileSync(location!));
    expect([...bytes.subarray(0, 5)]).toEqual([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(0);
    // Saved after switching to US Letter, so the bytes on disk are the ones the
    // *second* preview described, not the first.
    const { width, height } = doc.getPage(0).getSize();
    expect(width).toBeCloseTo(612, 1);
    expect(height).toBeCloseTo(792, 1);
  });

  /**
   * The staleness half of the gate. CNV-08's audit finding 4 was that a preview
   * survived a change to its input because the check keyed on identity alone.
   * This tool's input is a picked file rather than the open document, so the
   * equivalent is a *re-pick*: choosing another file must re-close the gate even
   * though a preview is still held.
   */
  test('re-closes the gate when a different file is chosen after a preview', async ({ page }) => {
    const fixture = await ensureFixture('excel-to-pdf.xlsx', excelToPdfXlsx);
    await openApp(page);
    await gotoTool(page, 'excel-to-pdf');

    const panel = page.getByRole('complementary', { name: /Excel to PDF options/ });
    const save = page.getByRole('button', { name: 'Save PDF' });
    const outline = panel.getByRole('list', { name: /Sheets that will be drawn into the PDF/ });

    await chooseFixture(page, fixture, /Choose an \.xlsx file/);
    await panel.getByRole('button', { name: 'Preview conversion' }).click();
    await expect(outline).toBeVisible({ timeout: 90_000 });
    await expect(save).toBeEnabled();

    // Re-pick — the same bytes, but a new `File`, so the held preview no longer
    // belongs to the input as it stands.
    await chooseFixture(page, fixture, /Choose a different \.xlsx/);
    await expect(save).toBeDisabled();
    await expect(page.getByText(/Preview the conversion first/)).toBeVisible();
    await expect(panel.getByText(/A preview is required before saving/)).toBeVisible();

    // And it is not a permanent lock: converting again re-opens it.
    await panel.getByRole('button', { name: 'Preview conversion' }).click();
    await expect(save).toBeEnabled({ timeout: 90_000 });
  });

  test('renders in the dark theme with no literal colour of its own', async ({ page }) => {
    await openApp(page);
    await gotoTool(page, 'excel-to-pdf');

    const panel = page.getByRole('complementary', { name: /Excel to PDF options/ });
    const heading = panel.getByRole('heading', { level: 1, name: 'Excel to PDF' });
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
    await expect(page.getByRole('button', { name: 'Save PDF' })).toBeDisabled();
  });
});
