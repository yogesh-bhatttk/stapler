/**
 * Audit 2026-10-10 — tools that had no end-to-end flow at all (T1, T2, T11).
 *
 *  - OPS-04 Insert pages: a PDF inserted at a chosen position, and an image —
 *    judged on the saved bytes (page order, page text, page size), not on the
 *    grid having grown.
 *  - ACC-03 Reflow view: the document's own text, in reading order, page by page.
 *  - ANN-07 Side by side: both documents' pages actually painted, side by side.
 *  - ANN-04 annotation summary: the panel's button really exports a summary PDF
 *    that carries the notes (the behavioural half of what
 *    `annotation-summary-job.test.ts` can only check as source).
 *
 * Written by the 2026-10-10 test audit; not yet run (RULES.md §3).
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { readFileSync } from 'node:fs';
import { ensureFixture, mixedSizePdf, textPdf } from './fixtures';
import { commitAndRead, dismissToasts, gotoTool, importFile, openApp } from './helpers';
import { insertSourcePdf, pageHasImage, pdfPageTexts } from './audit-2026-10-10-helpers';

/** Sets the Insert panel's position stepper, the way a keyboard user would. */
async function setInsertPosition(page: Page, position: number) {
  const stepper = page.getByRole('spinbutton', { name: 'Insert at position' });
  await stepper.fill(String(position));
  await stepper.press('Enter');
  await expect(stepper).toHaveAttribute('aria-valuenow', String(position));
  await expect(
    page.getByText(position === 0 ? 'At the start' : `After page ${position}`)
  ).toBeVisible();
}

/** Clicks the Insert panel's picker button and answers the file chooser. */
async function chooseFilesToInsert(page: Page, files: string[]) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Choose PDFs or images to insert' }).click();
  await (await chooser).setFiles(files);
}

test.describe('OPS-04 — Insert pages', () => {
  test('a PDF inserted after page 2 lands exactly there, in order, in the saved bytes', async ({
    page
  }) => {
    const host = await ensureFixture('text-4.pdf', () => textPdf(4));
    const insert = await insertSourcePdf();
    await openApp(page);
    await importFile(page, host);
    await gotoTool(page, 'insert');

    await setInsertPosition(page, 2);
    await chooseFilesToInsert(page, [insert]);

    const grid = page.getByRole('listbox', { name: /Pages of/ });
    await expect(grid.getByRole('option')).toHaveCount(6, { timeout: 30_000 });
    await dismissToasts(page);

    const bytes = await commitAndRead(page, 'View changes');
    const out = await PDFDocument.load(bytes);
    expect(out.getPageCount()).toBe(6);

    const texts = await pdfPageTexts(bytes);
    expect(texts[0]).toContain('Stapler fixture page 1');
    expect(texts[1]).toContain('Stapler fixture page 2');
    expect(texts[2]).toBe('Inserted page 1');
    expect(texts[3]).toBe('Inserted page 2');
    expect(texts[4]).toContain('Stapler fixture page 3');
    expect(texts[5]).toContain('Stapler fixture page 4');

    // And the inserted pages keep their own (US Letter) size among the A4 ones.
    const sizes = out.getPages().map(p => [Math.round(p.getWidth()), Math.round(p.getHeight())]);
    expect(sizes).toEqual([
      [595, 842],
      [595, 842],
      [612, 792],
      [612, 792],
      [595, 842],
      [595, 842]
    ]);
  });

  test('an image inserted at the start becomes one image page, before the others', async ({
    page
  }) => {
    // UI#5: the image options dialog was not rendered, so this hung for ever
    // with the button disabled (the dialog itself is covered by
    // audit-2026-10-10-insert.spec.ts; this one checks the bytes).
    test.setTimeout(120_000);
    const host = await ensureFixture('text-4.pdf', () => textPdf(4));
    await openApp(page);
    await importFile(page, host);
    await gotoTool(page, 'insert');

    await setInsertPosition(page, 0);
    await chooseFilesToInsert(page, ['tests/fixtures/sample.png']);

    const options = page.getByRole('dialog', { name: /^Import 1 images?$/ });
    await expect(options).toBeVisible({ timeout: 30_000 });
    await options.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(options).toBeHidden();

    const grid = page.getByRole('listbox', { name: /Pages of/ });
    await expect(grid.getByRole('option')).toHaveCount(5, { timeout: 60_000 });
    await expect(
      page.getByRole('button', { name: 'Choose PDFs or images to insert' })
    ).toBeEnabled();
    await dismissToasts(page);

    const bytes = await commitAndRead(page, 'View changes');
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(5);
    expect(await pageHasImage(bytes, 0)).toBe(true);
    const texts = await pdfPageTexts(bytes);
    expect(texts[0]).toBe('');
    expect(texts.slice(1).map(t => /fixture page (\d)/.exec(t)?.[1])).toEqual(['1', '2', '3', '4']);
  });
});

test.describe('ACC-03 — Reflow view', () => {
  test("shows the page's own text, in reading order, and follows the pager", async ({ page }) => {
    const file = await ensureFixture('text-4.pdf', () => textPdf(4));
    await openApp(page);
    await importFile(page, file);
    await gotoTool(page, 'reflow');

    const view = page.getByLabel('Reflowed page text, scrollable');
    await expect(view).toBeVisible();
    await expect(view).not.toContainText('Reading…', { timeout: 30_000 });
    await expect(view).toContainText('Stapler fixture page 1');

    // Reading order: the heading, then lines 1…24, top to bottom.
    const text = (await view.innerText()).replace(/\s+/g, ' ');
    const heading = text.indexOf('Stapler fixture page 1');
    const positions = Array.from({ length: 24 }, (_, i) =>
      text.indexOf(`Line ${i + 1} of body text on page 1.`)
    );
    expect(heading).toBeGreaterThanOrEqual(0);
    expect(positions.every(p => p > heading)).toBe(true);
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i], `line ${i + 1} after line ${i}`).toBeGreaterThan(positions[i - 1]);
    }
    expect(text).not.toContain('page 2.');

    // The pager moves the reflowed text to the next page's own text.
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(view).toContainText('Stapler fixture page 2', { timeout: 30_000 });
    await expect(view).toContainText('Line 24 of body text on page 2.');
    await expect(view).not.toContainText('page 1.');

    // Purely presentational: the text size changes the view, never the document.
    const before = await view
      .locator('p')
      .first()
      .evaluate(p => getComputedStyle(p).fontSize);
    const slider = page.getByRole('slider', { name: 'Reflow text size' });
    await slider.focus();
    for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowRight');
    await expect
      .poll(() =>
        view
          .locator('p')
          .first()
          .evaluate(p => getComputedStyle(p).fontSize)
      )
      .not.toBe(before);
    await expect(
      page.getByRole('group', { name: 'Open documents' }).getByText('Unsaved changes')
    ).toHaveCount(0);
  });
});

/** Dark pixels and a digest of a painted canvas, once it has painted. */
async function canvasSignature(canvas: Locator) {
  await expect
    .poll(
      () =>
        canvas.evaluate((c: HTMLCanvasElement) => {
          const ctx = c.getContext('2d');
          if (!ctx || c.width < 2 || c.height < 2) return 0;
          const { data } = ctx.getImageData(0, 0, c.width, c.height);
          let dark = 0;
          for (let i = 0; i < data.length; i += 4)
            if (data[i] + data[i + 1] + data[i + 2] < 300) dark++;
          return dark;
        }),
      { timeout: 30_000 }
    )
    .toBeGreaterThan(50);
  return canvas.evaluate((c: HTMLCanvasElement) => {
    const ctx = c.getContext('2d')!;
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let hash = 0;
    for (let i = 0; i < data.length; i += 16) hash = (hash * 31 + data[i]) | 0;
    return { width: c.width, height: c.height, hash };
  });
}

test.describe('ANN-07 — Side by side', () => {
  test("paints both documents' pages, next to each other, and pages them together", async ({
    page
  }) => {
    const a = await ensureFixture('text-4.pdf', () => textPdf(4));
    const b = await ensureFixture('mixed-sizes.pdf', mixedSizePdf);
    await openApp(page);
    await importFile(page, a);
    await gotoTool(page, 'side-by-side');

    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Open a document to view alongside…' }).click();
    await (await chooser).setFiles(b);
    await expect(page.getByText('Comparing against mixed-sizes.pdf')).toBeVisible({
      timeout: 30_000
    });

    const left = page.locator('canvas[aria-label="text-4.pdf, page"]');
    const right = page.locator('canvas[aria-label="mixed-sizes.pdf, page"]');
    await expect(left).toBeVisible();
    await expect(right).toBeVisible();
    await expect(page.getByText('Loading page…')).toHaveCount(0, { timeout: 30_000 });

    // Both really painted, and they are two different documents' pages.
    const leftPage1 = await canvasSignature(left);
    const rightPage1 = await canvasSignature(right);
    expect(leftPage1.hash).not.toBe(rightPage1.hash);
    // Side by side, not stacked. The panes are compared: at 100% a page wider
    // than its pane scrolls inside it, so the canvas box can extend under the
    // neighbouring pane.
    const [lb, rb] = [
      await page.locator('div[aria-label="text-4.pdf"]').boundingBox(),
      await page.locator('div[aria-label="mixed-sizes.pdf"]').boundingBox()
    ];
    expect(lb && rb && lb.x + lb.width <= rb.x + 1).toBe(true);

    // The pager covers the longer document and moves both panes at once.
    await expect(page.getByText('Page 1 of 4', { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByText('Page 2 of 4', { exact: true }).first()).toBeVisible();
    // "Loading page…" may not have appeared yet right after the click, so its
    // absence alone proves nothing: wait for both canvases to hold pixels again.
    for (const canvas of [left, right]) {
      await expect
        .poll(() => canvas.evaluate(c => (c as HTMLCanvasElement).width), { timeout: 30_000 })
        .toBeGreaterThan(0);
    }
    await expect(page.getByText('Loading page…')).toHaveCount(0, { timeout: 30_000 });
    const leftPage2 = await canvasSignature(left);
    const rightPage2 = await canvasSignature(right);
    expect(leftPage2.hash).not.toBe(leftPage1.hash);
    // mixed-sizes.pdf page 2 is US Letter, page 1 is A4: a different shape, too.
    expect(rightPage2.width / rightPage2.height).not.toBeCloseTo(
      rightPage1.width / rightPage1.height,
      2
    );

    // Past the shorter document's end, its pane says so instead of a stale page.
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByText('Page 4 of 4', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('No page to show.')).toBeVisible();
  });
});

test.describe('ANN-04 — annotation summary from the panel', () => {
  test('Export annotation summary writes a PDF listing every highlight on its page', async ({
    page
  }) => {
    test.setTimeout(120_000);
    const file = await ensureFixture('text-6.pdf', () => textPdf(6));
    await openApp(page);
    await importFile(page, file);
    await gotoTool(page, 'annotate');

    await page.getByLabel('Find and highlight text').fill('Line 3 of body text');
    await page.keyboard.press('Enter');
    await expect(
      page.getByRole('status').filter({ hasText: 'Highlighted 6 matches.' }).first()
    ).toBeVisible({ timeout: 60_000 });
    await dismissToasts(page);

    const download = page.waitForEvent('download', { timeout: 60_000 });
    await page.getByRole('button', { name: 'Export annotation summary' }).click();
    const saved = await download;
    expect(saved.suggestedFilename()).toBe('text-6-annotation-summary.pdf');
    const bytes = new Uint8Array(readFileSync((await saved.path())!));

    const text = (await pdfPageTexts(bytes)).join(' ');
    expect(text).toContain('text-6.pdf');
    expect(text).toContain('Total Notes: 6');
    for (let n = 1; n <= 6; n++) expect(text).toMatch(new RegExp(`Page: ${n}\\b`));
    await expect(page.getByText('Exported annotation summary PDF.')).toBeVisible();
  });
});
