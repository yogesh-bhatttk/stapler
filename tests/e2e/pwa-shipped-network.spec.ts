/**
 * Audit 2026-10-01 PLT-7 — what only the shipped web bytes can show.
 *
 * `zero-network.spec.ts` watches the page's requests. On the real site the
 * service worker registers on every visit and downloads the precache itself,
 * which a page-level watch does not see; and the instrumented e2e build only
 * registers the worker when a test opts in. So this spec, run only by
 * `pwa-shipped.config.ts` against the unzipped `stapler-<version>-web.zip`,
 * watches the whole browser context, the worker's own requests included
 * (`PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS`, set by that config).
 */
import { expect, test, type Request } from '@playwright/test';
import { ensureFixture, textPdf } from './fixtures';
import { openApp } from './helpers';

test.skip(
  !process.env.STAPLER_SHIPPED_WEB,
  'Shipped-bytes only: run with -c tests/e2e/pwa-shipped.config.ts'
);

test.describe('shipped web build', () => {
  test.setTimeout(120_000);

  test('registers its worker with no test hook, precaches and works offline, all same-origin', async ({
    context,
    page,
    baseURL
  }) => {
    const origin = new URL(baseURL!).origin;
    const offending: string[] = [];
    const fromWorker: string[] = [];
    const record = (request: Request) => {
      const url = request.url();
      if (request.serviceWorker()) fromWorker.push(url);
      if (url.startsWith('blob:') || url.startsWith('data:') || url.startsWith(`${origin}/`)) {
        return;
      }
      offending.push(`${request.method()} ${url}${request.serviceWorker() ? ' (worker)' : ''}`);
    };
    context.on('request', record);

    await openApp(page);
    // No opt-in: the shipped build registers the worker on its own.
    expect(
      await page.evaluate(() => localStorage.getItem('stapler:e2e-service-worker'))
    ).toBeNull();
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
      timeout: 60_000
    });
    // The precache was downloaded by the worker, and the watch saw it.
    expect(fromWorker.some(url => /\/assets\//.test(url))).toBe(true);
    const cached = await page.evaluate(async () => {
      const names = (await caches.keys()).filter(name => name.startsWith('stapler-precache-'));
      return names.length === 1 ? (await (await caches.open(names[0]!)).keys()).length : 0;
    });
    expect(cached).toBeGreaterThan(20);

    await context.setOffline(true);
    try {
      await page.reload();
      await openApp(page);
      await page
        .locator('input[type="file"]')
        .setInputFiles(await ensureFixture('text-4.pdf', () => textPdf(4)));
      const grid = page.getByRole('listbox', { name: /Pages of/ });
      await expect(grid).toBeVisible({ timeout: 30_000 });
      await expect(grid.getByRole('option')).toHaveCount(4);
    } finally {
      await context.setOffline(false);
      context.off('request', record);
    }

    expect(
      offending,
      `The shipped site must make no external request. Observed:\n${offending.join('\n')}`
    ).toEqual([]);
  });
});
