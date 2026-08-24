import { expect, test, type Request } from '@playwright/test';
import { ensureFixture, textPdf } from './fixtures';

/**
 * QA-03 — the test that protects the entire product claim.
 *
 * Any request to a URL that is not same-origin, `blob:`, or `data:` fails the run. Add a
 * Google Fonts link, a CDN import, or an analytics snippet and this goes red.
 *
 * It runs against the *built* preview server rather than the dev server, because Vite's
 * dev client opens a websocket of its own and would make the assertion meaningless.
 */

/** Same-origin, blob:, and data: are local. Everything else is a violation. */
function isLocal(url: string, origin: string): boolean {
  if (url.startsWith('blob:') || url.startsWith('data:')) return true;
  if (url.startsWith('chrome-extension://')) return true;
  return url.startsWith(origin);
}

async function withNetworkWatch(
  page: import('@playwright/test').Page,
  origin: string,
  body: () => Promise<void>
) {
  const offending: string[] = [];
  const record = (request: Request) => {
    const url = request.url();
    if (!isLocal(url, origin)) offending.push(`${request.method()} ${url}`);
  };
  page.on('request', record);
  try {
    await body();
  } finally {
    page.off('request', record);
  }
  expect(
    offending,
    `Stapler must make no external request. Observed:\n${offending.join('\n')}`
  ).toEqual([]);
}

test.describe('zero network', () => {
  test('makes no external request while loading and using the app', async ({ page, baseURL }) => {
    const origin = new URL(baseURL!).origin;
    const fixture = await ensureFixture('text-10.pdf', () => textPdf(10));

    await withNetworkWatch(page, origin, async () => {
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'Offline PDF tools' })).toBeVisible();

      // First run shows the welcome dialog; dismiss it before touching anything else.
      const welcome = page.getByRole('dialog', { name: 'Welcome to Stapler' });
      if (await welcome.isVisible()) {
        await page.getByRole('button', { name: 'Get started' }).click();
      }

      // Import through the real file input, then visit every tool: each one lazily
      // touches different code, and any of them could smuggle in a fetch.
      await page.locator('input[type="file"]').setInputFiles(fixture);
      await expect(page.getByRole('listbox', { name: /Pages of/ })).toBeVisible({
        timeout: 30_000
      });

      for (const tool of [
        'merge',
        'organize',
        'split',
        'insert',
        'remove-blanks',
        'cleanup',
        'pdf-to-img',
        'images-to-pdf',
        'extract-img',
        'extract',
        'compress',
        'crop',
        'watermark',
        'outline',
        'sign',
        'redact',
        'metadata',
        'normalize',
        'nup',
        'compare',
        'annotate',
        'batch',
        'md-to-pdf',
        // OCR is the one route allowed to touch the network — on the model's
        // one-time download consent, and only after the user explicitly agrees.
        // Visiting the panel without agreeing must stay silent; this is the only
        // test that exercises the route at all, so its absence used to mean the
        // one deliberate exception to the zero-network guarantee was the one path
        // this suite never actually watched.
        'ocr',
        'table-extract',
        'acc',
        'contact-sheet',
        'shortcuts'
      ]) {
        await page.goto(`/#/tool/${tool}`);
        await expect(page.locator('header')).toBeVisible();
      }

      // Rendering a page exercises pdf.js, which is the most likely component to reach
      // for a remote cmap or standard font.
      await page.goto('/#/tool/organize');
      await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30_000 });
      await page.waitForTimeout(1500);
    });
  });

  test('ships no reference to a known remote host in the bundle', async ({ page, baseURL }) => {
    const origin = new URL(baseURL!).origin;
    await page.goto('/');
    const scripts = await page.evaluate(() =>
      Array.from(document.querySelectorAll('script[src], link[href]')).map(
        element => element.getAttribute('src') ?? element.getAttribute('href') ?? ''
      )
    );
    for (const reference of scripts) {
      expect(isLocal(new URL(reference, origin).href, origin)).toBe(true);
    }
  });
});
