/**
 * GAP-2 — the website twin is offline-capable and installable.
 *
 * Runs against the real `vite preview` of the web build (the `chromium`
 * project). The e2e build registers the service worker only when a test opts
 * in (`E2E_SW_OPT_IN_KEY` in `src/ui/pwa.ts`), so the rest of the suite is not
 * timed while the precache downloads.
 */
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { ensureFixture, textPdf } from './fixtures';
import { openApp } from './helpers';

const OPT_IN_KEY = 'stapler:e2e-service-worker';

async function optInToServiceWorker(page: Page) {
  await page.addInitScript(key => localStorage.setItem(key, '1'), OPT_IN_KEY);
}

/** Waits until the worker has installed (precache complete) and controls the page. */
async function waitForControllingWorker(page: Page) {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
    timeout: 60_000
  });
}

async function importPdf(page: Page, file: string) {
  await page.locator('input[type="file"]').setInputFiles(file);
}

test.describe('GAP-2 offline web app', () => {
  test.setTimeout(120_000);

  test('after one online visit, the app loads and imports a PDF with the network off', async ({
    page,
    context
  }) => {
    await optInToServiceWorker(page);
    await openApp(page);
    await waitForControllingWorker(page);

    await context.setOffline(true);
    try {
      await page.reload();
      await openApp(page);
      await expect(page.locator('header')).toBeVisible();

      const file = await ensureFixture('text-4.pdf', () => textPdf(4));
      await importPdf(page, file);
      const grid = page.getByRole('listbox', { name: /Pages of/ });
      await expect(grid).toBeVisible({ timeout: 30_000 });
      await expect(grid.getByRole('option')).toHaveCount(4);

      // A landing page (served at its extension-less URL) is available offline too.
      await page.goto('/merge-pdf');
      await expect(
        page.getByRole('heading', { level: 1, name: /Merge PDFs, entirely on your device/ })
      ).toBeVisible();
    } finally {
      await context.setOffline(false);
    }
  });

  test('files posted to the share target are stored locally and opened by the app', async ({
    page
  }) => {
    await optInToServiceWorker(page);
    await openApp(page);
    await waitForControllingWorker(page);

    const pdf = readFileSync(await ensureFixture('text-4.pdf', () => textPdf(4)));
    // The OS share sheet's multipart POST, reproduced from the page so the
    // controlling worker receives it (a same-origin request).
    const redirect = await page.evaluate(async bytes => {
      const form = new FormData();
      form.append(
        'files',
        new File([new Uint8Array(bytes)], 'shared.pdf', { type: 'application/pdf' })
      );
      const response = await fetch('/share-target', {
        method: 'POST',
        body: form,
        redirect: 'manual'
      });
      return { type: response.type, status: response.status };
    }, Array.from(pdf));
    // An opaque redirect: the worker answered with a 303 to the app.
    expect(redirect.type).toBe('opaqueredirect');

    await page.goto('/?share-target=1');
    const grid = page.getByRole('listbox', { name: /Pages of/ });
    await expect(grid).toBeVisible({ timeout: 30_000 });
    await expect(grid.getByRole('option')).toHaveCount(4);
    // The flag is removed from the address so a reload does not look again.
    expect(new URL(page.url()).searchParams.has('share-target')).toBe(false);
  });

  test('manifest.webmanifest is served, valid, and linked from every entry page', async ({
    request
  }) => {
    const response = await request.get('/manifest.webmanifest');
    expect(response.ok()).toBe(true);
    const manifest = await response.json();
    expect(manifest).toMatchObject({
      short_name: 'Stapler',
      start_url: './',
      display: 'standalone'
    });
    expect(manifest.theme_color).toMatch(/^#[0-9a-f]{3,8}$/i);
    expect(manifest.file_handlers[0].accept['application/pdf']).toEqual(['.pdf']);
    expect(manifest.share_target.method).toBe('POST');

    for (const icon of manifest.icons as { src: string; sizes: string }[]) {
      const png = await request.get(`/${icon.src}`);
      expect(png.ok(), icon.src).toBe(true);
      const bytes = await png.body();
      expect(`${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`).toBe(icon.sizes);
    }

    for (const entry of ['/', '/editor.html', '/merge-pdf', '/compress-pdf']) {
      const html = await (await request.get(entry)).text();
      expect(html, entry).toContain('<link rel="manifest" href="/manifest.webmanifest">');
      expect(html, entry).toContain('http-equiv="Content-Security-Policy"');
    }

    const sw = await request.get('/sw.js');
    expect(sw.ok()).toBe(true);
    const code = await sw.text();
    // Self-contained, with its precache list inlined — and no remote URL at all.
    expect(code).not.toMatch(/^\s*(import|export)\b/m);
    expect(code).toContain('manifest.webmanifest');
    expect(code).not.toMatch(/https?:\/\//);
  });
});
