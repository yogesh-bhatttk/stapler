/**
 * Audit 2026-10-01 PLT-3 — a share the service worker cannot trace to this
 * app is only opened after the user says so.
 *
 * A foreign page that opens a POST to `/share-target` in a new window with
 * `no-referrer` sends no `Origin`, no referrer and no client the worker can
 * see: exactly what the OS share sheet sends. The worker stores such a batch
 * marked unverified, and the app asks "Open N shared files?" (Open / Discard)
 * before importing it. A share from the app's own origin opens at once, and
 * one carrying a foreign origin is never stored at all.
 *
 * Runs in the `chromium` project (hooks build; the worker is opted in) and,
 * via `pwa-shipped.config.ts`, against the shipped web zip.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { ensureFixture, textPdf } from './fixtures';
import { openApp } from './helpers';

const OPT_IN_KEY = 'stapler:e2e-service-worker';
const INBOX = 'stapler-share-inbox';

let foreign: Server;
let foreignOrigin = '';
let pdfBase64 = '';

test.beforeAll(async () => {
  pdfBase64 = readFileSync(await ensureFixture('text-4.pdf', () => textPdf(4))).toString('base64');
  // Another origin (127.0.0.1, not localhost) on a free port: the attacker's site.
  foreign = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const target = url.searchParams.get('target') ?? '';
    const noReferrer = url.searchParams.has('nr');
    const blank = url.searchParams.has('blank');
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html>${noReferrer ? '<meta name="referrer" content="no-referrer">' : ''}
<form id="f" method="post" enctype="multipart/form-data" action="${target}/share-target"${blank ? ' target="_blank"' : ''}>
  <input type="file" name="files" id="i">
  <button id="go" type="submit">Open the document</button>
</form>
<script>
  const bytes = Uint8Array.from(atob(${JSON.stringify(pdfBase64)}), c => c.charCodeAt(0));
  const dt = new DataTransfer();
  dt.items.add(new File([bytes], 'invoice.pdf', { type: 'application/pdf' }));
  document.getElementById('i').files = dt.files;
</script>`);
  });
  await new Promise<void>(resolve => foreign.listen(0, '127.0.0.1', resolve));
  foreignOrigin = `http://127.0.0.1:${(foreign.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise(resolve => foreign.close(resolve));
});

async function installApp(context: BrowserContext, page: Page) {
  // Every page of the context: the share opens in a new window.
  await context.addInitScript(key => localStorage.setItem(key, '1'), OPT_IN_KEY);
  await openApp(page);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
    timeout: 60_000
  });
}

/** The foreign page posts the file to the share target in a new no-referrer window. */
async function shareFromForeignWindow(context: BrowserContext, baseURL: string): Promise<Page> {
  const attacker = await context.newPage();
  await attacker.goto(
    `${foreignOrigin}/?nr&blank&target=${encodeURIComponent(new URL(baseURL).origin)}`
  );
  const [popup] = await Promise.all([context.waitForEvent('page'), attacker.click('#go')]);
  await popup.waitForURL(url => url.pathname === '/' && url.origin === new URL(baseURL).origin, {
    timeout: 30_000
  });
  return popup;
}

const consentDialog = (page: Page) =>
  page.getByRole('dialog', { name: /^Open 1 shared files?\?$/ });

test.describe('PLT-3 share-target consent', () => {
  test.setTimeout(120_000);

  test('an untraceable share asks first; Discard (Escape) opens nothing and deletes it', async ({
    context,
    page,
    baseURL
  }) => {
    await installApp(context, page);
    const popup = await shareFromForeignWindow(context, baseURL!);

    const dialog = consentDialog(popup);
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByText('invoice.pdf')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Open' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Discard' })).toBeVisible();
    // Keyboard: focus is inside the dialog, and Escape answers "Discard".
    expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
    await popup.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    await expect(popup.getByRole('listbox', { name: /Pages of/ })).toHaveCount(0);
    expect(await popup.evaluate(name => caches.has(name), INBOX)).toBe(false);
    // A reload does not bring it back.
    await popup.reload();
    await expect(popup.locator('header')).toBeVisible();
    await expect(consentDialog(popup)).toHaveCount(0);
  });

  test('an untraceable share opens once the user chooses Open', async ({
    context,
    page,
    baseURL
  }) => {
    await installApp(context, page);
    const popup = await shareFromForeignWindow(context, baseURL!);

    const dialog = consentDialog(popup);
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    // Keyboard only: Tab to "Open" and press Enter.
    const open = dialog.getByRole('button', { name: 'Open' });
    for (let i = 0; i < 6 && !(await open.evaluate(el => el === document.activeElement)); i++) {
      await popup.keyboard.press('Tab');
    }
    await expect(open).toBeFocused();
    await popup.keyboard.press('Enter');
    await expect(dialog).toBeHidden();

    const grid = popup.getByRole('listbox', { name: /Pages of/ });
    await expect(grid).toBeVisible({ timeout: 30_000 });
    await expect(grid.getByRole('option')).toHaveCount(4);
    expect(await popup.evaluate(name => caches.has(name), INBOX)).toBe(false);
  });

  test('a share from the app’s own origin opens without asking', async ({ context, page }) => {
    await installApp(context, page);
    // A POST from one of this app's pages carries this origin's `Origin`
    // header. (A form cannot do it: the app's CSP is `form-action 'none'`.)
    const redirect = await page.evaluate(async b64 => {
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const form = new FormData();
      form.append('files', new File([bytes], 'mine.pdf', { type: 'application/pdf' }));
      const response = await fetch('/share-target', {
        method: 'POST',
        body: form,
        redirect: 'manual'
      });
      return response.type;
    }, pdfBase64);
    expect(redirect).toBe('opaqueredirect');
    await page.goto('/?share-target=1');
    const grid = page.getByRole('listbox', { name: /Pages of/ });
    await expect(grid).toBeVisible({ timeout: 30_000 });
    await expect(grid.getByRole('option')).toHaveCount(4);
    await expect(page.getByRole('dialog', { name: /shared file/ })).toHaveCount(0);
  });

  test('a share that names a foreign origin is never stored', async ({
    context,
    page,
    baseURL
  }) => {
    await installApp(context, page);
    const attacker = await context.newPage();
    // Same window, default referrer policy: Origin and referrer name the attacker.
    await attacker.goto(`${foreignOrigin}/?target=${encodeURIComponent(new URL(baseURL!).origin)}`);
    await Promise.all([
      attacker.waitForURL(url => url.origin === new URL(baseURL!).origin, { timeout: 30_000 }),
      attacker.click('#go')
    ]);
    await expect(attacker.locator('header')).toBeVisible();
    expect(new URL(attacker.url()).searchParams.has('share-target')).toBe(false);
    expect(await attacker.evaluate(name => caches.has(name), INBOX)).toBe(false);
    await expect(attacker.getByRole('dialog', { name: /shared file/ })).toHaveCount(0);
    await expect(attacker.getByRole('listbox', { name: /Pages of/ })).toHaveCount(0);
  });
});
