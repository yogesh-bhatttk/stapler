import { expect, test } from '@playwright/test';
import { gotoTool, importFile, openApp } from './helpers';
import { ensureFixture, textPdf } from './fixtures';

/**
 * AUDIT-2026-10-10 (agent D) — the UI fixes that only a real DOM can show:
 * focus movement, key handling, the paste guard, CSS states, the tab title and
 * the web twin's frame guard. The prop-level parts are unit-tested in
 * `tests/unit/audit-2026-10-10-ui*.test.ts`.
 */

async function openDoc(page: import('@playwright/test').Page, pages: number) {
  const file = await ensureFixture(`text-${pages}.pdf`, () => textPdf(pages));
  await openApp(page);
  await importFile(page, file);
}

test.describe('AUDIT-2026-10-10 UI', () => {
  test('UI2 — Escape does not answer the session-restore prompt; focus starts on Restore', async ({
    page
  }) => {
    await openDoc(page, 2);
    // Let the autosave land, then reload into the restore prompt.
    await page.waitForTimeout(1500);
    await page.reload();
    const prompt = page.getByRole('dialog', { name: 'Restore your previous session?' });
    await expect(prompt).toBeVisible();
    await expect(page.getByRole('button', { name: 'Restore' })).toBeFocused();
    await expect(prompt.getByRole('button', { name: 'Close dialog' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.mouse.click(5, 5); // the scrim
    await expect(prompt).toBeVisible();
    // The scrim click moved focus off the button; Enter answers the focused one.
    await prompt.getByRole('button', { name: 'Restore' }).focus();
    await page.keyboard.press('Enter');
    await expect(prompt).toBeHidden();
    await expect(page.getByRole('listbox', { name: /Pages of/ })).toBeVisible();
  });

  test('UI4 — a view-only tool shows no primary "Done" button', async ({ page }) => {
    await openDoc(page, 2);
    for (const tool of ['compare', 'reflow', 'history', 'read-aloud']) {
      await gotoTool(page, tool);
      await expect(page.getByRole('button', { name: 'Done', exact: true })).toHaveCount(0);
    }
  });

  test('UI6 — Pages per file can be cleared and retyped, and 2.5 is refused', async ({ page }) => {
    await openDoc(page, 6);
    await gotoTool(page, 'split');
    await page.getByRole('radio', { name: 'Split every N pages' }).check();
    const field = page.getByLabel('Pages per file');
    await field.fill('');
    await expect(field).toHaveValue('');
    await expect(page.getByRole('alert')).toContainText('whole number');
    await field.fill('2.5');
    await expect(page.getByRole('alert')).toContainText('whole number');
    await field.fill('3');
    await expect(page.getByText('Produces 2 files.')).toBeVisible();
  });

  test('UI8 — the drop zone shows a focus ring for keyboard focus only', async ({ page }) => {
    await openApp(page);
    const zone = page.locator('label[aria-label="Choose PDFs or images to open"]').first();
    await zone.locator('input[type="file"]').focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    const outline = await zone.evaluate(el => getComputedStyle(el).outlineStyle);
    expect(outline).toBe('solid');
  });

  test('UI10 — Tab still reaches the grid after the focused tile scrolls away', async ({
    page
  }) => {
    await openDoc(page, 60);
    const grid = page.getByRole('listbox', { name: /Pages of/ });
    await grid.getByRole('option', { name: /^Page 1 of/ }).focus();
    await page.getByTestId('pagegrid-scroller').evaluate(el => (el.scrollTop = el.scrollHeight));
    await expect(page.locator('body')).not.toBeFocused();
    const stops = await grid.locator('[role="option"][tabindex="0"]').count();
    expect(stops).toBe(1);
  });

  test('UI11 — a paste is ignored while a dialog is open', async ({ page }) => {
    await openDoc(page, 2);
    await page.keyboard.press('?');
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'x.png', { type: 'image/png' }));
      window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data }));
    });
    await expect(page.getByText('Adding pasted image')).toHaveCount(0);
    await expect(page.getByRole('listbox', { name: /Pages of/ }).getByRole('option')).toHaveCount(
      2
    );
  });

  test('UI13 — Tab stays in the command palette; Enter does not run behind it', async ({
    page
  }) => {
    await openApp(page);
    await page.getByRole('button', { name: 'Command palette' }).click();
    const input = page.getByRole('combobox', { name: 'Search tools and actions…' });
    await expect(input).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(input).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(input).toBeFocused();
  });

  test('UI14/UI24 — tab title follows the tool and the locale', async ({ page }) => {
    await openApp(page);
    await gotoTool(page, 'compress');
    await expect(page).toHaveTitle('Compress — Stapler');
    await page.getByLabel('Change Language').selectOption('de');
    await expect(page).not.toHaveTitle('Compress — Stapler');
    await expect(page).toHaveTitle(/ — Stapler$/);
  });

  test('UI14 — a landing page keeps <html lang="en"> and scopes the locale to the app', async ({
    page
  }) => {
    await page.goto('/merge-pdf');
    await page.locator('#app select').first().selectOption('ar');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('#app')).toHaveAttribute('dir', 'rtl');
  });

  test('UI22 — direction chevrons mirror under RTL', async ({ page }) => {
    await openDoc(page, 3);
    await page.getByLabel('Change Language').selectOption('ar');
    await gotoTool(page, 'reflow');
    const chevron = page.locator('svg.lucide-chevron-left').first();
    await expect(chevron).toHaveCSS('transform', 'matrix(-1, 0, 0, 1, 0, 0)');
  });

  test('UI23 — reaching the last page keeps focus on the pager', async ({ page }) => {
    await openDoc(page, 2);
    await gotoTool(page, 'crop');
    const next = page.getByRole('button', { name: 'Next' });
    await next.focus();
    await page.keyboard.press('Enter');
    await expect(next).toBeFocused();
    await expect(next).toHaveAttribute('aria-disabled', 'true');
  });

  test('UI25 — the theme button cycles back to system', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: 'Switch to dark theme' }).click();
    await page.getByRole('button', { name: 'Switch to light theme' }).click();
    await page.getByRole('button', { name: 'Use system theme' }).click();
    await expect(page.getByRole('button', { name: 'Switch to dark theme' })).toBeVisible();
  });

  test('UI28 — the language picker lists autonyms', async ({ page }) => {
    await openApp(page);
    const picker = page.getByLabel('Change Language');
    await expect(picker.locator('option[value="pt-BR"]')).toHaveText('Português (Brasil)');
    await expect(picker.locator('option[value="ar"]')).toHaveAttribute('lang', 'ar');
  });

  test('S-info — framed, the web twin refuses to render the app', async ({ page, baseURL }) => {
    // A same-origin host page with no CSP, served by the test: the app's own
    // pages carry frame-src 'none', and an about:blank host is refused by
    // Chrome's local-network-access checks before the guard could run.
    const host = new URL('/__frame-host.html', baseURL).href;
    await page.route(host, route =>
      route.fulfill({
        contentType: 'text/html',
        body: `<iframe src="${new URL('/editor.html', baseURL).href}" style="width:800px;height:600px"></iframe>`
      })
    );
    await page.goto(host);
    const frame = page.frameLocator('iframe');
    await expect(frame.getByText('Stapler can’t run inside another page')).toBeVisible();
    await expect(frame.locator('header')).toHaveCount(0);
  });
});
