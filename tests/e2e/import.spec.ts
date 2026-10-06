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
import { readFileSync } from 'node:fs';
import {
  corruptPdf,
  ensureFixture,
  FIXTURES_DIR,
  notAPdf,
  textPdf,
  truncatedTextPdf
} from './fixtures';
import { confirmExportReviewIfShown, openApp } from './helpers';

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
  for (const name of ['mid-body', 'header-only'] as const) {
    test(`a PDF truncated ${name} is refused with the same accurate reason`, async ({ page }) => {
      const file = await ensureFixture(`truncated-${name}.pdf`, () => truncatedTextPdf(name));
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
   * TIFF, and libheif (WASM, in the image worker) for HEIC — and none of them had been run through the real pipeline before.
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
    // Importing images generically (rather than through the dedicated Images
    // to PDF panel) lands on Organize once the conversion resolves, so this
    // is Organize's button, not Images to PDF's — hence "View changes…".
    await page.getByRole('button', { name: /View changes/i }).click();
    await confirmExportReviewIfShown(page, download);
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
   * specifically since the HEIC decoder (libheif) applies the HEIF rotation itself.
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
  test('every PDF in the corpus imports or is refused with a specific reason', async ({
    page,
    context
  }) => {
    test.setTimeout(900_000);
    const { readdirSync } = await import('node:fs');

    // Make sure the dynamic fixtures exist so the sweep is the same set every run,
    // whatever order the suites happened to execute in.
    await ensureFixture('text-4.pdf', () => textPdf(4));
    await ensureFixture('truncated.pdf', corruptPdf);
    await ensureFixture('not-a-pdf.pdf', notAPdf);

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
    await page.close();
    for (const name of names) {
      // A fresh tab per fixture, in the same context (so the dismissed welcome
      // flag in IndexedDB carries over): reloading one tab ~40 times made the
      // renderer run out of resources (net::ERR_INSUFFICIENT_RESOURCES) on a
      // low-memory machine, and the sweep failed on a page that never rendered.
      const tab = await context.newPage();
      try {
        await tab.goto('/');
        await expect(tab.locator('header')).toBeVisible();
        // The previous fixture's import was autosaved, so the reload offers to
        // restore it. Imports are refused until that prompt is answered
        // (AUDIT-2026-09-25 RT-14) — answer it the way a user would.
        const recovery = tab.getByRole('dialog', { name: 'Restore your previous session?' });
        await recovery.waitFor({ state: 'visible', timeout: 2_000 }).catch(() => {});
        if (await recovery.isVisible().catch(() => false)) {
          await tab.getByRole('button', { name: 'Start fresh' }).click();
          await expect(recovery).toBeHidden();
        }
        await tab.locator('input[type="file"]').setInputFiles(`${FIXTURES_DIR}/${name}`);

        const grid = tab.getByRole('listbox', { name: /Pages of/ });
        const status = tab.getByRole('status');
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
      } finally {
        await tab.close();
      }
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

/**
 * CNV-07 / HRD-23 (AUDIT-FINDINGS §11.10) — paste through the real clipboard.
 *
 * No test hook: Playwright grants the clipboard permissions, the page writes a
 * real image `ClipboardItem` with the async Clipboard API, and the paste is the
 * real Ctrl/Cmd+V, so the browser itself builds the `ClipboardEvent`.
 */
test.describe('CNV-07 paste image as page', () => {
  const PASTED = { width: 240, height: 160 };

  /** Puts a real PNG of the given size on the system clipboard. */
  async function writeClipboardImage(page: import('@playwright/test').Page) {
    await page.evaluate(async ({ width, height }) => {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = 'red';
      ctx.fillRect(0, 0, width, height);
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    }, PASTED);
  }

  async function confirmImageOptions(page: import('@playwright/test').Page) {
    const dialog = page.getByRole('dialog', { name: /Import 1 image/ });
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await dialog.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(dialog).toBeHidden();
  }

  test.beforeEach(async ({ context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  });

  test('with nothing open, a pasted image becomes a one-page document', async ({ page }) => {
    await openApp(page);
    await writeClipboardImage(page);
    await page.locator('body').click({ position: { x: 5, y: 200 } });
    await page.keyboard.press('ControlOrMeta+V');

    await confirmImageOptions(page);
    const grid = page.getByRole('listbox', { name: /Pages of/ });
    await expect(grid.getByRole('option')).toHaveCount(1, { timeout: 30_000 });
  });

  test('into an open 3-page document, the image lands after the selected page 2, at its own size', async ({
    page
  }) => {
    const file = await ensureFixture('text-3.pdf', () => textPdf(3));
    await openApp(page);
    await page.locator('input[type="file"]').setInputFiles(file);
    const grid = page.getByRole('listbox', { name: /Pages of/ });
    await expect(grid.getByRole('option')).toHaveCount(3, { timeout: 30_000 });
    const original = await PDFDocument.load(readFileSync(file));
    const textSize = original.getPage(0).getSize();

    // Select page 2: the insertion point is just after the selection.
    await grid.getByRole('option', { name: /^Page 2 of/ }).click();
    await writeClipboardImage(page);
    await page.keyboard.press('ControlOrMeta+V');
    await confirmImageOptions(page);
    await expect(grid.getByRole('option')).toHaveCount(4, { timeout: 30_000 });

    const download = page.waitForEvent('download', { timeout: 60_000 });
    await page.getByRole('button', { name: 'View changes' }).click();
    await confirmExportReviewIfShown(page, download);
    const bytes = new Uint8Array(readFileSync((await (await download).path())!));
    const output = await PDFDocument.load(bytes);
    expect(output.getPageCount()).toBe(4);
    const sizes = output.getPages().map(p => {
      const { width, height } = p.getSize();
      return [Math.round(width), Math.round(height)];
    });
    const text = [Math.round(textSize.width), Math.round(textSize.height)];
    // Index 2 (0-based) is the pasted image at 1 px = 1 pt; the rest keep their order.
    expect(sizes).toEqual([text, text, [PASTED.width, PASTED.height], text]);
  });

  test('a clipboard with no image is refused with a clear message', async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => navigator.clipboard.writeText('just some words'));
    await page.locator('body').click({ position: { x: 5, y: 200 } });
    await page.keyboard.press('ControlOrMeta+V');
    await expect(page.getByText('No image found on the clipboard.')).toBeVisible();
    await expect(page.getByRole('dialog', { name: /Import \d+ image/ })).toHaveCount(0);
  });
});
