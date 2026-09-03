import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import {
  PPT_TO_PDF,
  PPT_TO_PDF_PARTIAL,
  ensureFixture,
  pptToPdfPartiallyBlankPptx,
  pptToPdfPptx
} from './fixtures';
import { gotoTool, openApp } from './helpers';

/**
 * CNV-13 — the half of the acceptance criterion a unit test cannot reach: the
 * beta label and the mandatory preview really gate the save action in a real
 * browser, and the file the browser writes is a real PDF.
 *
 * Everything about the *conversion* is graded in `tests/unit/ppt-to-pdf.test.ts`
 * against the output bytes. What is here is the gate, because "the save button
 * is disabled until a preview has rendered" is a claim about the shell, the two
 * worker round-trips and the panel together — the one place where asserting on a
 * label instead of on behaviour would be exactly the mistake PLAN §5.5 exists to
 * prevent.
 *
 * The `.pptx` reaches the panel through the real file chooser (`openFiles`
 * builds an `<input type=file>` and clicks it), captured with Playwright's
 * `filechooser` event the same way `excel-to-pdf.spec.ts` drives its picker.
 */

/** Picks the fixture through the panel's own file chooser. */
async function chooseFixture(page: import('@playwright/test').Page, file: string, label: RegExp) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: label }).click();
  await (await chooser).setFiles(file);
}

test.describe('CNV-13 — PowerPoint to PDF', () => {
  test('labels itself beta and refuses to save until the preview has run', async ({ page }) => {
    const fixture = await ensureFixture('ppt-to-pdf.pptx', pptToPdfPptx);
    await openApp(page);
    // No PDF is opened first on purpose: the input is the `.pptx`, and the tool
    // is declared `worksWithoutDocument` so it does not demand an unrelated one.
    await gotoTool(page, 'ppt-to-pdf');

    const panel = page.getByRole('complementary', { name: /PowerPoint to PDF options/ });
    await expect(panel).toBeVisible();

    // The beta label is in the panel itself, not only in the tool's summary line
    // (which is marketing copy the palette also shows).
    await expect(panel.getByLabel('This tool is in beta')).toBeVisible();

    // The ticket's own out-of-scope list is stated in the panel, before the
    // conversion runs — not left to be discovered in the output.
    const limits = panel.getByRole('list', {
      name: /What this converter does not carry across/
    });
    await expect(limits.getByText(/Transitions, animations and speaker notes/)).toBeVisible();
    await expect(limits.getByText(/Slide layouts and masters are not read/)).toBeVisible();
    await expect(limits.getByText(/All text is black/)).toBeVisible();

    // The gate: the action bar's primary CTA starts disabled, and the reason is
    // readable rather than being left to the user to guess.
    const save = page.getByRole('button', { name: 'Save PDF' });
    await expect(save).toBeDisabled();
    await expect(page.getByText(/Choose a \.pptx file to convert first/)).toBeVisible();

    // Nothing to preview yet, so that control is disabled too.
    await expect(panel.getByRole('button', { name: 'Preview conversion' })).toBeDisabled();

    await chooseFixture(page, fixture, /Choose a \.pptx file/);
    await expect(panel.getByText(/ppt-to-pdf\.pptx/)).toBeVisible();

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
    const outline = panel.getByRole('list', { name: /Slides that will be drawn into the PDF/ });
    await expect(outline).toBeVisible({ timeout: 90_000 });
    await expect(save).toBeEnabled();
    await expect(page.getByText(/Preview the conversion first/)).toBeHidden();

    // The preview describes real structure, not a placeholder: one row per
    // slide, each carrying that slide's own leading text.
    await expect(outline.getByRole('listitem')).toHaveCount(4);
    await expect(outline.getByText(new RegExp(PPT_TO_PDF.slide1.title))).toBeVisible();
    await expect(outline.getByText(new RegExp(PPT_TO_PDF.slide3.heading))).toBeVisible();
    await expect(outline.getByText(/1 image/).first()).toBeVisible();
    await expect(outline.getByText(/1 table/)).toBeVisible();

    // Changing an option must re-close the gate: the previewed bytes were laid
    // out on a different page.
    await panel.getByLabel('Page size').selectOption('a4');
    await expect(save).toBeDisabled();
    await expect(panel.getByText(/A preview is required before saving/)).toBeVisible();

    // Preview again, then save, and check what actually landed on disk. The
    // control is back to "Preview conversion" rather than "Convert again",
    // because changing the option threw the held conversion away.
    await panel.getByRole('button', { name: 'Preview conversion' }).click();
    await expect(save).toBeEnabled({ timeout: 90_000 });

    const download = page.waitForEvent('download', { timeout: 60_000 });
    await save.click();
    const saved = await download;
    expect(saved.suggestedFilename()).toBe('ppt-to-pdf.pdf');
    const location = await saved.path();
    expect(location).toBeTruthy();

    const bytes = new Uint8Array(readFileSync(location!));
    expect([...bytes.subarray(0, 5)]).toEqual([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"
    const doc = await PDFDocument.load(bytes);
    // One page per slide, in the file the browser actually wrote.
    expect(doc.getPageCount()).toBe(4);
    // Saved after switching to A4, so the bytes on disk are the ones the
    // *second* preview described, not the first (which was 16:9).
    const { width, height } = doc.getPage(0).getSize();
    expect(width).toBeCloseTo(595.28, 1);
    expect(height).toBeCloseTo(841.89, 1);
  });

  /**
   * The staleness half of the gate. CNV-08's audit finding 4 was that a preview
   * survived a change to its input because the check keyed on identity alone.
   * This tool's input is a picked file rather than the open document, so the
   * equivalent is a *re-pick*: choosing another file must re-close the gate even
   * though a preview is still held.
   */
  test('re-closes the gate when a different file is chosen after a preview', async ({ page }) => {
    const fixture = await ensureFixture('ppt-to-pdf.pptx', pptToPdfPptx);
    await openApp(page);
    await gotoTool(page, 'ppt-to-pdf');

    const panel = page.getByRole('complementary', { name: /PowerPoint to PDF options/ });
    const save = page.getByRole('button', { name: 'Save PDF' });
    const outline = panel.getByRole('list', { name: /Slides that will be drawn into the PDF/ });

    await chooseFixture(page, fixture, /Choose a \.pptx file/);
    await panel.getByRole('button', { name: 'Preview conversion' }).click();
    await expect(outline).toBeVisible({ timeout: 90_000 });
    await expect(save).toBeEnabled();

    // Re-pick — the same bytes, but a new `File`, so the held preview no longer
    // belongs to the input as it stands.
    await chooseFixture(page, fixture, /Choose a different \.pptx/);
    await expect(save).toBeDisabled();
    await expect(page.getByText(/Preview the conversion first/)).toBeVisible();
    await expect(panel.getByText(/A preview is required before saving/)).toBeVisible();

    // And it is not a permanent lock: converting again re-opens it.
    await panel.getByRole('button', { name: 'Preview conversion' }).click();
    await expect(save).toBeEnabled({ timeout: 90_000 });
  });

  /**
   * The second review pass's third finding, graded where it actually matters.
   *
   * `SlideSummary.empty` was computed at preview time and read by nothing: the
   * panel drew a row with a page number and a slide number for a page that
   * would come out blank, and said nothing about it. Only the all-or-nothing
   * refusal protected the user, and a deck with *some* inherited-placeholder
   * slides is the commoner shape. This drives the panel itself, because the
   * finding was about the panel: the model-level half is asserted in
   * `tests/unit/ppt-to-pdf.test.ts`.
   */
  test('marks the slides that will come out blank in the preview', async ({ page }) => {
    const fixture = await ensureFixture(
      'ppt-to-pdf-partially-blank.pptx',
      pptToPdfPartiallyBlankPptx
    );
    await openApp(page);
    await gotoTool(page, 'ppt-to-pdf');

    const panel = page.getByRole('complementary', { name: /PowerPoint to PDF options/ });
    await chooseFixture(page, fixture, /Choose a \.pptx file/);
    await panel.getByRole('button', { name: 'Preview conversion' }).click();

    const outline = panel.getByRole('list', { name: /Slides that will be drawn into the PDF/ });
    await expect(outline).toBeVisible({ timeout: 90_000 });
    const rows = outline.getByRole('listitem');
    await expect(rows).toHaveCount(PPT_TO_PDF_PARTIAL.slides);

    // The slide that has content is not marked…
    await expect(rows.nth(0)).toContainText(PPT_TO_PDF_PARTIAL.content);
    await expect(rows.nth(0)).not.toContainText(/appears blank/);
    // …and each of the three that will be blank pages says so on its own row,
    // which is the assertion that fails without the fix.
    for (const number of PPT_TO_PDF_PARTIAL.blank) {
      await expect(rows.nth(number - 1)).toContainText(/appears blank/);
    }

    // The same fact is in the preview's "left out" list, naming the slides.
    await expect(panel.getByText(/Slides 2, 3 and 4 will be blank pages/)).toBeVisible();

    // Disclosed, not refused: the deck still converts and the save unlocks.
    await expect(page.getByRole('button', { name: 'Save PDF' })).toBeEnabled();
  });

  test('renders in the dark theme with no literal colour of its own', async ({ page }) => {
    await openApp(page);
    await gotoTool(page, 'ppt-to-pdf');

    const panel = page.getByRole('complementary', { name: /PowerPoint to PDF options/ });
    const heading = panel.getByRole('heading', { level: 1, name: 'PowerPoint to PDF' });
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
