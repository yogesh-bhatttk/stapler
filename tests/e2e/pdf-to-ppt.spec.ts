import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { strFromU8, unzipSync } from 'fflate';
import { ensureFixture, PDF_TO_PPT, pdfToPptPdf } from './fixtures';
import { gotoTool, openApp } from './helpers';

/**
 * CNV-12 — the halves of the acceptance criterion a unit test cannot reach: the
 * beta label and the mandatory preview really gate the save action in a real
 * browser, and the file the browser writes is a real `.pptx`.
 *
 * Everything about the *conversion* is graded in `tests/unit/pdf-to-ppt.test.ts`
 * against the output bytes. What is here is the gate, because "the save button is
 * disabled until a preview has rendered" is a claim about the shell, the worker
 * round-trip and the panel together — the one place where asserting on a label
 * instead of on behaviour would be exactly the mistake PLAN §5.5 exists to
 * prevent.
 *
 * Downloads arrive through the File System Access fallback (`openApp`), the same
 * way every other export test captures them.
 */
test.describe('CNV-12 — PDF to PowerPoint', () => {
  test('labels itself beta, states its limits, and refuses to save until previewed', async ({
    page
  }) => {
    const fixture = await ensureFixture('pdf-to-ppt.pdf', pdfToPptPdf);
    await openApp(page);
    await page.locator('input[type="file"]').setInputFiles(fixture);
    await expect(page.getByRole('listbox', { name: /Pages of/ })).toBeVisible({ timeout: 30_000 });
    await gotoTool(page, 'pdf-to-ppt');

    const panel = page.getByRole('complementary', { name: /PDF to PowerPoint options/ });
    await expect(panel).toBeVisible();

    // The beta label is in the panel itself, not only in the tool's summary line
    // (which is marketing copy the palette also shows).
    await expect(panel.getByLabel('This tool is in beta')).toBeVisible();

    // The ticket requires this tool's beta copy to state the fidelity gap
    // plainly *before* the conversion runs, because it is the widest of the six.
    // Asserted as rendered text, not as a source constant.
    const limits = panel.getByRole('list', { name: 'Known limits of this conversion' });
    await expect(limits).toBeVisible();
    await expect(limits.getByText(/Text does not reflow/)).toBeVisible();
    await expect(limits.getByText(/One slide size for the whole deck/)).toBeVisible();
    await expect(limits.getByText(/invisible text layer becomes/)).toBeVisible();
    await expect(panel.getByText(/not an editable presentation/)).toBeVisible();

    // The gate: the action bar's primary CTA starts disabled, and the reason is
    // readable rather than being left to the user to guess.
    const save = page.getByRole('button', { name: 'Save .pptx' });
    await expect(save).toBeDisabled();
    await expect(page.getByText(/Preview the conversion first/)).toBeVisible();
    await expect(panel.getByText(/A preview is required before saving/)).toBeVisible();

    // Keyboard-only: the preview control is reachable and activates with Enter.
    const preview = panel.getByRole('button', { name: 'Preview conversion' });
    await preview.focus();
    await expect(preview).toBeFocused();
    await page.keyboard.press('Enter');

    // Only once the preview exists does the CTA unlock.
    const outline = panel.getByRole('list', { name: /Slides that will be written/ });
    await expect(outline).toBeVisible({ timeout: 90_000 });
    await expect(save).toBeEnabled();
    await expect(page.getByText(/Preview the conversion first/)).toBeHidden();

    // The preview describes real structure, not a placeholder: four slides, the
    // deck's real size, and the mixed-size page reported as left behind.
    await expect(outline.getByRole('listitem')).toHaveCount(4);
    await expect(outline.getByText(PDF_TO_PPT.page1.title)).toBeVisible();
    await expect(panel.getByText('Slide size: 8.5 × 11 in')).toBeVisible();
    await expect(panel.getByText(/not the same size as the first page/)).toBeVisible();

    // Changing an option must re-close the gate: the previewed bytes were built
    // the other way round.
    await panel.getByLabel('Place embedded images').uncheck();
    await expect(save).toBeDisabled();
    await expect(panel.getByText(/A preview is required before saving/)).toBeVisible();

    // Preview again, then save, and check what actually landed on disk.
    await panel.getByRole('button', { name: 'Preview conversion' }).click();
    await expect(save).toBeEnabled({ timeout: 90_000 });

    const download = page.waitForEvent('download', { timeout: 60_000 });
    await save.click();
    const saved = await download;
    expect(saved.suggestedFilename()).toMatch(/\.pptx$/);
    const location = await saved.path();
    expect(location).toBeTruthy();

    const parts = unzipSync(new Uint8Array(readFileSync(location!)));
    // A `.pptx` is an OOXML package: these parts are what makes it one.
    const names = Object.keys(parts);
    expect(names).toContain('[Content_Types].xml');
    expect(names).toContain('_rels/.rels');
    expect(names).toContain('ppt/presentation.xml');
    for (let i = 1; i <= 4; i++) expect(names).toContain(`ppt/slides/slide${i}.xml`);

    // The bytes on disk are the *second* preview's — images were switched off
    // for that run, so the package carries no media *part*. `pptxgenjs` calls
    // `zip.folder('ppt/media')` unconditionally, so the directory entry
    // `ppt/media/` is present either way and has to be excluded here — a
    // `startsWith` alone would fail on a deck that genuinely has no images.
    expect(names.filter(name => name.startsWith('ppt/media/') && !name.endsWith('/'))).toEqual([]);
    const slide1 = strFromU8(parts['ppt/slides/slide1.xml']);
    expect(slide1).toContain(PDF_TO_PPT.page1.title);
    expect(strFromU8(parts['ppt/slides/slide2.xml'])).toContain(PDF_TO_PPT.page2.heading);
    // US Letter, from page 1: 612 × 792 pt in EMU.
    expect(strFromU8(parts['ppt/presentation.xml'])).toContain('<p:sldSz cx="7772400"');
  });

  /**
   * CNV-08, audit finding 4, built in here from the start — the preview gate
   * must not key on the active document's *id* only. Editing the document in
   * another tool leaves the id alone, so the pre-edit bytes would stay marked
   * valid and Save would write a deck of a document that no longer existed,
   * silently. The gate also keys on `historyVersion`, which every store mutator
   * bumps through `commit()`.
   */
  test('re-closes the gate when the document is edited after a preview', async ({ page }) => {
    const fixture = await ensureFixture('pdf-to-ppt.pdf', pdfToPptPdf);
    await openApp(page);
    await page.locator('input[type="file"]').setInputFiles(fixture);
    await expect(page.getByRole('listbox', { name: /Pages of/ })).toBeVisible({ timeout: 30_000 });
    await gotoTool(page, 'pdf-to-ppt');

    const panel = page.getByRole('complementary', { name: /PDF to PowerPoint options/ });
    const save = page.getByRole('button', { name: 'Save .pptx' });

    await panel.getByRole('button', { name: 'Preview conversion' }).click();
    await expect(panel.getByRole('list', { name: /Slides that will be written/ })).toBeVisible({
      timeout: 90_000
    });
    await expect(save).toBeEnabled();

    // Edit the document somewhere else: delete a page in Organize, through the
    // keyboard, the same way `tool-flows.spec.ts` does it. Same document, same
    // id — different content.
    await gotoTool(page, 'organize');
    const grid = page.getByRole('listbox', { name: /Pages of/ });
    await expect(grid.getByRole('option')).toHaveCount(4);
    await grid.getByRole('option', { name: /^Page 4 of/ }).focus();
    await page.keyboard.press('Delete');
    await expect(grid.getByRole('option')).toHaveCount(3);

    // Back in the converter, the held bytes describe four pages, so the gate has
    // to be shut again and say so.
    await gotoTool(page, 'pdf-to-ppt');
    await expect(panel).toBeVisible();
    await expect(save).toBeDisabled();
    await expect(page.getByText(/Preview the conversion first/)).toBeVisible();
    await expect(panel.getByText(/A preview is required before saving/)).toBeVisible();

    // And it is not a permanent lock: converting again re-opens it, now with
    // three slides — so the second preview really re-read the document.
    await panel.getByRole('button', { name: 'Preview conversion' }).click();
    await expect(save).toBeEnabled({ timeout: 90_000 });
    await expect(
      panel.getByRole('list', { name: /Slides that will be written/ }).getByRole('listitem')
    ).toHaveCount(3);

    const download = page.waitForEvent('download', { timeout: 60_000 });
    await save.click();
    const parts = unzipSync(new Uint8Array(readFileSync((await (await download).path())!)));
    // The file on disk is the *post-edit* deck: three slides, not four.
    expect(
      Object.keys(parts).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    ).toHaveLength(3);
  });

  test('renders in the dark theme with no literal colour of its own', async ({ page }) => {
    const fixture = await ensureFixture('pdf-to-ppt.pdf', pdfToPptPdf);
    await openApp(page);
    await page.locator('input[type="file"]').setInputFiles(fixture);
    await expect(page.getByRole('listbox', { name: /Pages of/ })).toBeVisible({ timeout: 30_000 });
    await gotoTool(page, 'pdf-to-ppt');

    const panel = page.getByRole('complementary', { name: /PDF to PowerPoint options/ });
    const heading = panel.getByRole('heading', { level: 1, name: 'PDF to PowerPoint' });
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
    await expect(page.getByRole('button', { name: 'Save .pptx' })).toBeDisabled();
    await expect(page.getByText(/Preview the conversion first/)).toBeVisible();
  });
});
