/**
 * DOC-02 — import and validation, through the real app.
 *
 * The unit suite (`tests/unit/import.test.ts`) stubs the workers, so it proves what
 * `core/import.ts` decides but nothing about what pdf.js decides or what a browser
 * can decode. This file covers exactly that half: a truncated PDF handed to the real
 * pdf.js, a real password-protected PDF, and every accepted image encoding decoded
 * by the real `createImageBitmap`/UTIF path — each judged on what the UI ends up
 * showing.
 */
import { expect, test } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { corruptPdf, ensureFixture, FIXTURES_DIR, textPdf } from './fixtures';
import { openApp } from './helpers';

/** Imports through the real file input; images pause on the options dialog first. */
async function importThrough(page: import('@playwright/test').Page, file: string) {
  await page.locator('input[type="file"]').setInputFiles(file);
  const dialog = page.getByRole('dialog', { name: /Import \d+ image/ });
  if (await dialog.isVisible({ timeout: 2000 }).catch(() => false)) {
    await dialog.getByRole('button', { name: 'Import', exact: true }).click();
  }
}

test.describe('DOC-02 import and validation', () => {
  /**
   * The acceptance criterion, verbatim: "A truncated PDF never crashes the tab."
   * The previously existing coverage used a file that is not a PDF at all, which
   * never reaches pdf.js — the truncated case is the one that does.
   */
  test('a truncated PDF is handled without breaking the tab, and the tab still works after', async ({
    page
  }) => {
    const file = await ensureFixture('truncated.pdf', corruptPdf);
    const crashes: string[] = [];
    page.on('pageerror', err => crashes.push(String(err)));

    await openApp(page);
    await importThrough(page, file);

    // Refused with the reason, not a generic "failed to import" — and refused
    // outright rather than half-imported.
    await expect(page.getByRole('status')).toContainText(/invalid or truncated/i, {
      timeout: 30_000
    });
    await expect(page.getByRole('listbox', { name: /Pages of/ })).toHaveCount(0);

    // The tab is alive: no uncaught error, and a good file still imports afterwards.
    expect(crashes).toEqual([]);
    const good = await ensureFixture('text-4.pdf', () => textPdf(4));
    await openApp(page);
    await importThrough(page, good);
    await expect(page.getByRole('listbox', { name: /Pages of text-4.pdf/ })).toBeVisible({
      timeout: 30_000
    });
  });

  /**
   * The same again for two other shapes of damage, because they fail in different
   * places inside pdf.js: half a file loses object bodies, a 200-byte prefix loses
   * the page tree entirely. All three must produce the same accurate sentence.
   */
  for (const { name, slice } of [
    { name: 'mid-body', slice: (v: Uint8Array) => v.slice(0, Math.floor(v.length * 0.5)) },
    { name: 'header-only', slice: (v: Uint8Array) => v.slice(0, 200) }
  ]) {
    test(`a PDF truncated ${name} is refused with the same accurate reason`, async ({ page }) => {
      const file = await ensureFixture(`truncated-${name}.pdf`, async () =>
        slice(await textPdf(6))
      );
      const crashes: string[] = [];
      page.on('pageerror', err => crashes.push(String(err)));

      await openApp(page);
      await importThrough(page, file);

      await expect(page.getByRole('status')).toContainText(/invalid or truncated/i, {
        timeout: 30_000
      });
      await expect(page.getByRole('listbox', { name: /Pages of/ })).toHaveCount(0);
      expect(crashes).toEqual([]);
    });
  }

  /**
   * `encrypted.pdf` is a real Ghostscript-encrypted file. Until now it was only ever
   * fed to `processWorker.inspect` in a unit test — the import path that a user
   * actually walks was never exercised on it.
   */
  test('encrypted.pdf is explained as password-protected, not as damaged', async ({ page }) => {
    await openApp(page);
    await importThrough(page, 'tests/fixtures/encrypted.pdf');

    const status = page.getByRole('status');
    await expect(status).toBeVisible({ timeout: 30_000 });
    await expect(status).toContainText(/password/i);
    await expect(page.getByRole('listbox', { name: /Pages of/ })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Offline PDF tools' })).toBeVisible();
  });

  test('one bad file in a batch does not stop the good ones', async ({ page }) => {
    const good = await ensureFixture('text-4.pdf', () => textPdf(4));
    await openApp(page);
    await page.locator('input[type="file"]').setInputFiles([good, 'tests/fixtures/encrypted.pdf']);

    await expect(page.getByRole('listbox', { name: /Pages of text-4.pdf/ })).toBeVisible({
      timeout: 30_000
    });
    await expect(page.getByRole('status')).toContainText(/password/i);
  });

  /**
   * DOC-02 requires PNG, JPEG, WebP, TIFF and HEIC to be accepted. Each of these is a
   * different decode path — the browser's own decoder for PNG/JPEG/WebP, `utif` for
   * TIFF, and `heic2any` for HEIC — and none of them had been run through the real pipeline before.
   */
  for (const { file, format } of [
    { file: 'tests/fixtures/sample.png', format: 'PNG' },
    { file: 'tests/fixtures/tiny.jpg', format: 'JPEG' },
    { file: 'tests/fixtures/sample.webp', format: 'WebP' },
    { file: 'tests/fixtures/sample.tiff', format: 'TIFF' },
    { file: 'tests/fixtures/sample.heic', format: 'HEIC' }
  ]) {
    test(`a ${format} image imports as a one-page PDF`, async ({ page }) => {
      page.on('console', msg => console.log('BROWSER:', msg.text()));
      page.on('pageerror', err => console.log('PAGE ERROR:', err.message));
      await openApp(page);
      await importThrough(page, file);

      const name = file
        .split('/')
        .pop()!
        .replace(/\.[^.]+$/, '.pdf');
      const grid = page.getByRole('listbox', { name: `Pages of ${name}` });
      await expect(grid).toBeVisible({ timeout: 30_000 });
      await expect(grid.getByRole('option')).toHaveCount(1);
    });
  }

  test('several images become one document, and the bytes really are a PDF', async ({ page }) => {
    await openApp(page);
    await page
      .locator('input[type="file"]')
      .setInputFiles([
        'tests/fixtures/sample.png',
        'tests/fixtures/sample.webp',
        'tests/fixtures/sample.tiff'
      ]);
    const dialog = page.getByRole('dialog', { name: /Import 3 images/ });
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await dialog.getByRole('button', { name: 'Import', exact: true }).click();

    // CNV-01: 3 photos are one 3-page document, not three tabs.
    const grid = page.getByRole('listbox', { name: 'Pages of Images.pdf' });
    await expect(grid).toBeVisible({ timeout: 30_000 });
    await expect(grid.getByRole('option')).toHaveCount(3);

    const download = page.waitForEvent('download', { timeout: 60_000 });
    await page.getByRole('button', { name: /Export PDF/i }).click();
    const saved = await download;
    const location = await saved.path();
    expect(location).toBeTruthy();
    const { readFileSync } = await import('node:fs');
    const output = await PDFDocument.load(new Uint8Array(readFileSync(location!)));
    expect(output.getPageCount()).toBe(3);
  });

  /**
   * HEIC's disclosed unknown: orientation (`sample.heic` above already covers
   * plain decode-without-crashing). This fixture's pixels are
   * physically stored rotated 90°, with an EXIF Orientation=6 tag telling a
   * correct reader to rotate it back — the same shape of bug CNV-01's own
   * `imageOrientation: 'from-image'` comment describes for JPEG ("a sideways
   * photo must not stay sideways"), never previously proven for HEIC
   * specifically since heic2any decodes to an intermediate PNG blob first.
   */
  test('a rotated .heic photo with EXIF orientation imports right-side up', async ({ page }) => {
    await openApp(page);
    await importThrough(page, 'tests/fixtures/photo-rotated.heic');

    const grid = page.getByRole('listbox', { name: /Pages of/ });
    await expect(grid).toBeVisible({ timeout: 30_000 });

    // The fixture (scripts don't generate this one — built once with
    // pillow-heif + piexif) draws a red square at the top-left of the
    // *upright* 400×300 landscape image and a blue square at bottom-right.
    // A reader that ignored the EXIF Orientation=6 tag would show the raw
    // 300×400 portrait storage instead, putting neither color in that corner.
    await page.waitForFunction(
      () => {
        const canvas = document.querySelector<HTMLCanvasElement>('[role="option"] canvas');
        const ctx = canvas?.getContext('2d');
        if (!canvas || !ctx || canvas.width < 2 || canvas.height < 2) return false;
        return ctx.getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data[3] > 0;
      },
      undefined,
      { timeout: 30_000 }
    );

    const [topLeft, bottomRight] = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('[role="option"] canvas')!;
      const ctx = canvas.getContext('2d')!;
      const sample = (fx: number, fy: number) => {
        const x = Math.min(canvas.width - 1, Math.round(fx * canvas.width));
        const y = Math.min(canvas.height - 1, Math.round(fy * canvas.height));
        const d = ctx.getImageData(x, y, 1, 1).data;
        return [d[0], d[1], d[2]];
      };
      return [sample(0.05, 0.05), sample(0.95, 0.95)];
    });

    // Red top-left: R channel clearly dominant.
    expect(topLeft[0]).toBeGreaterThan(150);
    expect(topLeft[0] - topLeft[2]).toBeGreaterThan(50);
    // Blue bottom-right: B channel clearly dominant.
    expect(bottomRight[2]).toBeGreaterThan(150);
    expect(bottomRight[2] - bottomRight[0]).toBeGreaterThan(50);
  });

  /**
   * The acceptance criterion itself: *every* fixture in the corpus either imports or
   * produces its specific, accurate explanation. Written as a sweep rather than a
   * list so a fixture added later is covered the day it lands.
   *
   * "Specific" is enforced by an allow-list: a refusal must be one of the sentences
   * the pipeline is designed to produce. A generic internal error ("Something went
   * wrong inside Stapler") fails this test, which is the whole point.
   */
  test('every PDF in the corpus imports or is refused with a specific reason', async ({ page }) => {
    test.setTimeout(900_000);
    const { readdirSync } = await import('node:fs');

    // Make sure the dynamic fixtures exist so the sweep is the same set every run,
    // whatever order the suites happened to execute in.
    await ensureFixture('text-4.pdf', () => textPdf(4));
    await ensureFixture('truncated.pdf', corruptPdf);
    await ensureFixture('not-a-pdf.pdf', async () =>
      new TextEncoder().encode('This is definitely not a PDF.')
    );

    const specific = [
      /invalid or truncated/i,
      /requires a password/i,
      /does not start with a PDF header/i,
      /contains no pages/i,
      /is empty/i,
      /cannot be imported/i
    ];

    const results: Record<string, string> = {};
    const names = readdirSync(FIXTURES_DIR)
      .filter(f => f.endsWith('.pdf'))
      .sort();
    expect(names.length).toBeGreaterThan(20); // the sweep is worthless if the corpus is empty

    // `openApp` once: the welcome dialog is a first-run flag in IndexedDB, so after the
    // first dismissal a plain reload is enough — and waiting 10s per fixture for a
    // dialog that will never reappear is what made this sweep time out.
    await openApp(page);
    for (const name of names) {
      await page.goto('/');
      await expect(page.locator('header')).toBeVisible();
      await page.locator('input[type="file"]').setInputFiles(`${FIXTURES_DIR}/${name}`);

      const grid = page.getByRole('listbox', { name: /Pages of/ });
      const status = page.getByRole('status');
      await expect(grid.or(status).first()).toBeVisible({ timeout: 60_000 });

      if (await grid.isVisible().catch(() => false)) {
        results[name] = 'imported';
        continue;
      }
      const text = (await status.allTextContents()).join(' ');
      results[name] = text;
      expect(
        specific.some(re => re.test(text)),
        `${name} was refused without a specific reason: ${text}`
      ).toBe(true);
    }
    // Recorded in the run log so a reviewer can see what each fixture actually did.
    console.log(JSON.stringify(results, null, 2));
  });

  test('a file type Stapler does not accept is named, with the list of ones it does', async ({
    page
  }) => {
    await openApp(page);
    await page.locator('input[type="file"]').setInputFiles({
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('not a document Stapler can open')
    });

    const status = page.getByRole('status');
    await expect(status).toBeVisible({ timeout: 15_000 });
    await expect(status).toContainText(/cannot be imported/i);
    await expect(status).toContainText(/TIFF/);
    await expect(page.getByRole('heading', { name: 'Offline PDF tools' })).toBeVisible();
  });
});

test('CNV-07: Paste image as page from clipboard', async ({ page, context }) => {
  await openApp(page);
  // Need to bypass clipboard permissions in Playwright
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);

  // Write a small image to the clipboard using JS evaluation
  page.on('console', msg => console.log(msg.text()));
  await page.evaluate(async () => {
    // 1x1 red PNG
    const base64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const res = await fetch(`data:image/png;base64,${base64}`);
    const blob = await res.blob();

    // Set the mock file
    (window as any).__mockClipboardImage = new File([blob], 'Pasted Image.png', {
      type: 'image/png'
    });

    // Dispatch the paste event to trigger the AppShell listener
    window.dispatchEvent(new Event('paste', { bubbles: true, cancelable: true }));
  });

  // The importImages dialog should appear
  const dialog = page.getByRole('dialog', { name: /Import 1 image/ });
  await dialog.getByRole('button', { name: 'Import' }).click();

  // A new page should appear
  const grid = page.getByRole('listbox', { name: /Pages of/ });
  await expect(grid.getByRole('option')).toHaveCount(1);
});
