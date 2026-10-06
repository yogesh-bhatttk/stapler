import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import { BOOKMARK_CHAPTERS, bookmarkedPdf, ensureFixture } from './fixtures';
import { dismissToasts, importFile, openApp } from './helpers';

/**
 * DS-10 AC — "a mobile Playwright project (390×844, touch) walks Home → a tool →
 * options → export with no horizontal scroll, no overlap between the options
 * sheet and the preview, every modal above every sheet".
 *
 * `mobile.spec.ts` covers the layout pieces; this walks one tool end to end and
 * checks the file that comes out. Bookmarks is the tool: it has an options
 * sheet, an export review, and an in-sheet action that raises a confirm dialog,
 * and none of it depends on the Compress or Grayscale UIs.
 */
const PHONE = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  userAgent:
    'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36'
};

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function intersection(a: Box, b: Box): Box | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

async function expectNoSideways(page: Page) {
  const [scroll, client] = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    document.documentElement.clientWidth
  ]);
  expect(scroll, 'the page never scrolls sideways').toBeLessThanOrEqual(client);
}

/**
 * The modal is above the sheet by hit-testing, not by reading z-index: the
 * centre of the region where the two overlap belongs to the dialog, and a
 * point of the sheet outside the dialog belongs to neither the sheet nor
 * anything in it (the modal's scrim is on top).
 */
async function expectModalAboveSheet(page: Page, dialog: Locator, sheet: Locator) {
  await expect(dialog).toBeVisible();
  const dialogBox = (await dialog.boundingBox())!;
  const sheetBox = (await sheet.boundingBox())!;
  const shared = intersection(dialogBox, sheetBox);
  expect(shared, 'the dialog and the sheet share screen space to fight over').not.toBeNull();

  const outside = [
    { x: sheetBox.x + 4, y: sheetBox.y + sheetBox.height - 4 },
    { x: sheetBox.x + sheetBox.width - 4, y: sheetBox.y + sheetBox.height - 4 },
    { x: sheetBox.x + 4, y: sheetBox.y + 4 }
  ].filter(
    p =>
      p.x < dialogBox.x ||
      p.x > dialogBox.x + dialogBox.width ||
      p.y < dialogBox.y ||
      p.y > dialogBox.y + dialogBox.height
  );

  const hits = await page.evaluate(
    ({ centre, outside }) => {
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
      const at = (x: number, y: number) => document.elementFromPoint(x, y);
      const hit = at(centre.x, centre.y);
      return {
        centreInDialog: dialogs.some(d => hit !== null && d.contains(hit)),
        outsideInSheet: outside.map(p => at(p.x, p.y)?.closest('aside') !== null)
      };
    },
    {
      centre: { x: shared!.x + shared!.width / 2, y: shared!.y + shared!.height / 2 },
      outside
    }
  );
  expect(hits.centreInDialog, 'the overlap belongs to the dialog').toBe(true);
  expect(hits.outsideInSheet.length, 'some of the sheet lies outside the dialog').toBeGreaterThan(
    0
  );
  expect(hits.outsideInSheet, 'the scrim covers the rest of the sheet').toEqual(
    hits.outsideInSheet.map(() => false)
  );
}

/** Top-level bookmark titles of a produced file, in `/First`→`/Next` order. */
async function outlineTitles(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes);
  const outlines = doc.catalog.lookupMaybe(PDFName.of('Outlines'), PDFDict);
  if (!outlines) return [];
  const titles: string[] = [];
  let item = outlines.lookupMaybe(PDFName.of('First'), PDFDict);
  while (item) {
    const title = item.lookup(PDFName.of('Title')) as unknown as { decodeText(): string };
    titles.push(title.decodeText());
    item = item.lookupMaybe(PDFName.of('Next'), PDFDict);
  }
  return titles;
}

async function openBookmarksFromToolsSheet(page: Page) {
  await openApp(page);
  await importFile(page, await ensureFixture('bookmarked-9.pdf', bookmarkedPdf));
  await dismissToasts(page);
  await expectNoSideways(page);

  // Home → a tool, the way a phone user gets there: the Tools sheet, not a hash.
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const tools = page.getByRole('dialog', { name: 'Tools' });
  await tools.getByRole('link', { name: /^Bookmarks/ }).click();
  await expect(tools).toBeHidden();
  await expect(page).toHaveURL(/#\/tool\/outline/);

  const sheet = page.getByRole('complementary', { name: 'Bookmarks options' });
  await expect(sheet).toBeVisible();
  return sheet;
}

test.describe('phone width: a tool walked to export (DS-10)', () => {
  test.use(PHONE);

  test('options → confirm → export review → saved file, every modal above the sheet', async ({
    page
  }) => {
    test.setTimeout(120_000);
    const sheet = await openBookmarksFromToolsSheet(page);

    // Options: edit inside the sheet.
    const titles = sheet.getByRole('textbox', { name: /^Bookmark title/ });
    await expect(titles).toHaveCount(BOOKMARK_CHAPTERS.length);
    await titles.first().fill('Front matter');
    await expectNoSideways(page);

    // A confirm dialog raised from inside the sheet stacks above it…
    await sheet.getByRole('button', { name: 'Detect headings from font size' }).click();
    const confirm = page.getByRole('dialog', { name: 'Replace the current outline?' });
    await expectModalAboveSheet(page, confirm, sheet);
    // …and is operable: its own button answers it, and "no" changes nothing.
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toBeHidden();
    await expect(titles).toHaveCount(BOOKMARK_CHAPTERS.length);
    await expect(titles.first()).toHaveValue('Front matter');

    // Export: the CTA opens the review, which also stacks above the sheet.
    await page.getByRole('button', { name: /View changes/i }).click();
    const review = page.getByRole('dialog', { name: 'Review before saving' });
    await expectModalAboveSheet(page, review, sheet);
    await expectNoSideways(page);

    const download = page.waitForEvent('download', { timeout: 60_000 });
    await review.getByRole('button', { name: /^Save / }).click();
    const saved = await download;
    await expect(review).toBeHidden();
    const bytes = new Uint8Array(readFileSync((await saved.path())!));

    // The bytes carry the edit made in the sheet, and nothing was lost.
    expect(await outlineTitles(bytes)).toEqual([
      'Front matter',
      ...BOOKMARK_CHAPTERS.slice(1).map(chapter => chapter.title)
    ]);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(9);
  });

  /**
   * The AC's "no overlap between the options sheet and the preview", measured
   * literally: the rendered page and the open sheet share no pixels.
   *
   * Below 1100px the sheet is an overlay; `OptionsPanel`'s sheet reservation
   * pads the canvas by the sheet's measured height so the two never overlap
   * (fixed 2026-10-02 — before, the open sheet covered 269 of the preview's
   * 480px at 390×844).
   */
  test('the open options sheet does not cover the page preview', async ({ page }) => {
    const sheet = await openBookmarksFromToolsSheet(page);
    const preview = page.locator('main canvas[aria-label^="Page "]').first();
    await expect(preview).toBeVisible();
    const previewBox = (await preview.boundingBox())!;
    const sheetBox = (await sheet.boundingBox())!;
    const shared = intersection(previewBox, sheetBox);
    expect(
      shared,
      `sheet ${JSON.stringify(sheetBox)} overlaps preview ${JSON.stringify(previewBox)}`
    ).toBeNull();
  });

  test('every pager control is fully on screen', async ({ page }) => {
    await openBookmarksFromToolsSheet(page);
    const width = page.viewportSize()!.width;
    for (const name of ['Previous', 'Next', 'Zoom out', 'Zoom in']) {
      const control = page.getByRole('button', { name, exact: true });
      await expect(control).toBeVisible();
      const box = (await control.boundingBox())!;
      expect(box.x, `${name} starts on screen`).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, `${name} ends on screen`).toBeLessThanOrEqual(width);
    }
  });
});
