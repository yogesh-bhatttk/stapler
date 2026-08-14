/**
 * CMP-05 — the compress tool's before/after quality preview.
 *
 * Everything here is asserted against what the preview actually produced: the
 * page it chose, the bytes the real re-encoder returned for it, the pixels on
 * the two canvases, and — for the projection — the byte length of the file the
 * export really wrote. Nothing asserts that a control was clickable.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ensureFixture, imageOnLastPagePdf, mixedTextImagePdf } from './fixtures';
import { gotoTool, openApp } from './helpers';

const PREVIEW = '[data-preview-status]';

async function importFixture(page: import('@playwright/test').Page, file: string) {
  await openApp(page);
  await page.locator('input[type="file"]').setInputFiles(file);
  await expect(page.getByRole('listbox', { name: /Pages of/ })).toBeVisible({ timeout: 30_000 });
}

/** Waits for a settled preview whose "after" half was produced at `quality`. */
async function waitForPreview(page: import('@playwright/test').Page, quality: number) {
  const preview = page.locator(PREVIEW);
  await expect(preview).toHaveAttribute('data-preview-quality', String(quality), {
    timeout: 120_000
  });
  await expect(preview).toHaveAttribute('data-preview-status', 'ready', { timeout: 120_000 });
  return preview;
}

/** Reads a numeric data attribute off the preview. */
async function previewNumber(
  page: import('@playwright/test').Page,
  attribute: string
): Promise<number> {
  const raw = await page.locator(PREVIEW).getAttribute(attribute);
  expect(raw, `${attribute} is set`).toBeTruthy();
  return Number(raw);
}

/**
 * Centre-pixel samples of the preview's own two canvases.
 *
 * Scoped to `[data-preview-canvas]`: the page grid renders thumbnail canvases
 * too, and a bare `canvas` selector silently sampled those instead.
 */
async function canvasSamples(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const canvases = ['before', 'after'].map(half =>
      document.querySelector<HTMLCanvasElement>(`[data-preview-canvas="${half}"]`)
    );
    if (canvases.some(canvas => !canvas)) throw new Error('preview canvases are not mounted');
    return (canvases as HTMLCanvasElement[]).map(canvas => {
      const ctx = canvas.getContext('2d');
      if (!ctx || canvas.width < 2) return { width: canvas.width, pixels: [] as number[] };
      const data = ctx.getImageData(canvas.width >> 1, canvas.height >> 1, 8, 8).data;
      return { width: canvas.width, pixels: Array.from(data) };
    });
  });
}

test.describe('CMP-05 quality preview', () => {
  test('previews the page with the most image area, from the real encoder', async ({ page }) => {
    // The preview runs the real compression pipeline for every setting it shows.
    test.setTimeout(180_000);
    const file = await ensureFixture('image-on-last-page.pdf', imageOnLastPagePdf);
    await importFixture(page, file);
    await gotoTool(page, 'compress');

    // Page 3 carries the 1600×1200 image; pages 1 and 2 carry none and a small
    // one. Choosing by image area is the whole requirement.
    const preview = await waitForPreview(page, 75);
    await expect(preview).toHaveAttribute('data-preview-page', '3');

    // Both halves are painted, and they are not the same image: the "after"
    // canvas came from bytes the encoder produced, not from a copy of "before".
    const [before, after] = await canvasSamples(page);
    expect(before.width).toBeGreaterThan(2);
    expect(after.width).toBe(before.width);
    expect(after.pixels.length).toBe(before.pixels.length);
    expect(after.pixels).not.toEqual(before.pixels);

    // And the measured page bytes really did shrink.
    const pageBefore = await previewNumber(page, 'data-preview-page-before');
    const pageAfter = await previewNumber(page, 'data-preview-page-after');
    expect(pageAfter).toBeLessThan(pageBefore);
  });

  test('a keyboard quality change re-renders the preview within 400ms', async ({ page }) => {
    test.setTimeout(180_000);
    const file = await ensureFixture('image-on-last-page.pdf', imageOnLastPagePdf);
    await importFixture(page, file);
    await gotoTool(page, 'compress');
    await waitForPreview(page, 75);

    // Keyboard only: focus the slider and step it down. `step` is 5, so one
    // ArrowLeft is 75 → 70.
    const slider = page.getByRole('slider', { name: /Image quality/i });
    await slider.focus();
    const started = Date.now();
    await page.keyboard.press('ArrowLeft');
    await waitForPreview(page, 70);
    const elapsed = Date.now() - started;
    console.log(`CMP-05 preview latency for a one-step quality change: ${elapsed}ms`);
    expect(elapsed).toBeLessThan(400);

    // A large quality drop must show up as fewer bytes from the real encoder,
    // which is what proves the preview is re-encoding rather than re-drawing.
    const at70 = await previewNumber(page, 'data-preview-page-after');
    for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowLeft'); // 70 → 30
    await waitForPreview(page, 30);
    const at30 = await previewNumber(page, 'data-preview-page-after');
    expect(at30).toBeLessThan(at70);

    // Returning to a setting already computed is served from cache and must not
    // regress past the same budget.
    const back = Date.now();
    for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowRight'); // 30 → 70
    await waitForPreview(page, 70);
    expect(Date.now() - back).toBeLessThan(400);
  });

  test('zooms to 400% and keeps the compare divider keyboard-operable', async ({ page }) => {
    test.setTimeout(180_000);
    const file = await ensureFixture('image-on-last-page.pdf', imageOnLastPagePdf);
    await importFixture(page, file);
    await gotoTool(page, 'compress');
    await waitForPreview(page, 75);

    const zoomIn = page.getByRole('button', { name: 'Zoom in' });
    for (let i = 0; i < 4; i++) await zoomIn.click(); // 100 → 150 → 200 → 300 → 400
    await expect(page.locator('[data-preview-zoom]')).toHaveAttribute('data-preview-zoom', '400');
    await expect(zoomIn).toBeDisabled();
    // The re-render at 400% is a render, not a re-encode, and must still settle.
    await waitForPreview(page, 75);
    const [before] = await canvasSamples(page);
    expect(before.width).toBeGreaterThan(1000);

    const divider = page.getByRole('slider', { name: /Compare original and compressed/i });
    await divider.focus();
    const start = Number(await divider.getAttribute('aria-valuenow'));
    await page.keyboard.press('ArrowRight');
    expect(Number(await divider.getAttribute('aria-valuenow'))).toBe(start + 1);
    await page.keyboard.press('Home');
    expect(Number(await divider.getAttribute('aria-valuenow'))).toBe(0);
  });

  /**
   * The CMP-05 acceptance criterion for the projection: the live projected
   * output size shown next to the preview has to be within 15% of the bytes the
   * export actually writes, on both compression routes.
   */
  for (const route of ['surgical', 'raster'] as const) {
    test(`projected output size is within 15% of the real ${route} output`, async ({ page }) => {
      test.setTimeout(240_000);
      const file =
        route === 'surgical'
          ? await ensureFixture('mixed-text-image-flate.pdf', () => mixedTextImagePdf())
          : path.resolve(process.cwd(), 'tests/fixtures/scanned_skewed.pdf');
      await importFixture(page, file);
      await gotoTool(page, 'compress');
      await waitForPreview(page, 75);

      const projected = await previewNumber(page, 'data-projected-bytes');
      // The projection has to be the *measured* one — an unmeasured fallback
      // passing this criterion by luck would not be evidence of anything.
      await expect(page.locator(PREVIEW)).toHaveAttribute('data-projected-measured', 'true');

      const download = page.waitForEvent('download', { timeout: 180_000 });
      await page.getByRole('button', { name: 'Compress & export' }).click();
      const saved = await download;
      const location = await saved.path();
      expect(location).toBeTruthy();
      const actual = readFileSync(location!).length;

      const error = Math.abs(projected - actual) / actual;
      console.log(
        `CMP-05 ${route}: projected ${projected} vs actual ${actual} — ${(error * 100).toFixed(1)}% off`
      );
      expect(error).toBeLessThanOrEqual(0.15);
    });
  }
});
