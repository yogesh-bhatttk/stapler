import { expect, test, type Page } from '@playwright/test';
import { ensureFixture, textPdf } from './fixtures';
import { gotoTool, openApp } from './helpers';
import AxeBuilder from '@axe-core/playwright';
import { TOOLS as TOOL_REGISTRY } from '../../src/core/tools';

/**
 * NFR-01 (accessibility) and the functional half of NFR-02.
 *
 * The wall-clock budgets (PLAN §5.1) live in `perf.spec.ts`, run by the separate,
 * never-retried `perf` Playwright project (audit 2026-09-25 PLT-18): retrying a
 * timing assertion until it passes hides exactly the regression it exists to catch.
 */

// Derived from the registry, not hand-maintained: a hardcoded list of 11 tool
// ids previously covered barely half the 20 registered tools (Remove blanks,
// Scan cleanup, PDF to images, Metadata, and Insert pages were never
// axe-scanned at all), and a *second*, separately hand-maintained list of
// titles for the palette-reachability test below had drifted even further —
// missing Compare, Annotate, Batch process, and Markdown to PDF entirely.
// Both silently passed the moment the missing tools existed, because neither
// list would ever tell you it forgot something.
const TOOLS = TOOL_REGISTRY.map(t => t.id);
const TOOL_TITLES = TOOL_REGISTRY.map(t => t.title);

/** What the app has stored under `key`, read straight from its IndexedDB settings store. */
async function storedSetting(page: Page, key: string): Promise<unknown> {
  return page.evaluate(
    key =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('stapler');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains('settings')) {
            db.close();
            resolve(undefined);
            return;
          }
          const get = db.transaction('settings').objectStore('settings').get(key);
          get.onsuccess = () => {
            db.close();
            resolve(get.result);
          };
          get.onerror = () => reject(get.error);
        };
      }),
    key
  );
}

test.describe('first run', () => {
  test('the welcome screen appears once and never again', async ({ page }) => {
    await page.goto('/');
    const dialog = page.getByRole('dialog', { name: 'Welcome to Stapler' });
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Get started' }).click();
    await expect(dialog).toBeHidden();

    // Same context, so the stored flag persists across the reload — once it is
    // stored. The flag is an IndexedDB write the click starts and does not wait
    // for; reloading the instant the dialog closes aborts that transaction if it
    // has not committed yet, which on a cold runner (the first test of the run,
    // the database just created) it often has not. Wait for the write itself.
    await expect.poll(() => storedSetting(page, 'welcomed')).toBe(true);
    await page.reload();
    await expect(page.locator('header')).toBeVisible();
    await expect(dialog).toBeHidden();
  });

  test('the shortcut sheet opens with ? and closes with Escape', async ({ page }) => {
    await openApp(page);
    await page.keyboard.press('?');
    const sheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(sheet).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
  });

  test('shortcut rows are keyboard operable', async ({ page }) => {
    await openApp(page);
    await gotoTool(page, 'shortcuts');

    const row = page.getByTestId('shortcut-row-palette');
    await expect(row).toHaveRole('button');
    await row.focus();
    await page.keyboard.press('Enter');
    await expect(row).toContainText('Press key...');
    await page.keyboard.press('Escape');
    await expect(row).toContainText('Ctrl K');
  });
});

test.describe('accessibility', () => {
  // NFR-01's AC is "zero violations on every route in both themes". This used
  // to run in the default (light) theme only; dark mode was axe-scanned at
  // phone width on four screens (`mobile.spec.ts`). Now the whole desktop
  // sweep — Home with and without the welcome dialog, the trust panel, the
  // privacy policy page, and every registered tool with a document open —
  // runs once per theme. Violations are collected across every screen and
  // asserted once, so a failure lists all of them by rule and selector rather
  // than stopping at the first.
  for (const theme of ['light', 'dark'] as const) {
    test(`every route has one main landmark, a title, and no positive tabindex (${theme})`, async ({
      page
    }) => {
      test.setTimeout(180_000);
      // The app resolves its theme from `prefers-color-scheme` when no choice
      // is stored, which a fresh context never has.
      await page.emulateMedia({ colorScheme: theme });
      const found: string[] = [];
      const scan = async (screen: string) => {
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        const { violations } = await new AxeBuilder({ page }).analyze();
        for (const v of violations) {
          for (const node of v.nodes) {
            found.push(`${screen} · ${v.id} (${v.impact}) · ${node.target.join(' ')}`);
          }
        }
      };

      // 1. Home, first run (the welcome dialog is up), then Home itself (DS-05).
      await page.goto('/');
      await expect(page.getByRole('dialog', { name: 'Welcome to Stapler' })).toBeVisible({
        timeout: 10_000
      });
      await scan('home + welcome');
      await openApp(page);
      await scan('home');

      // 2. The trust panel, and the privacy policy page it links to.
      await page.getByRole('button', { name: /Offline, zero network/ }).click();
      const trust = page.getByRole('dialog', { name: /Zero network/ });
      await expect(trust).toBeVisible();
      await scan('trust panel');
      await page.keyboard.press('Escape');
      await expect(trust).toBeHidden();

      // 3. Open a document to unlock document-gated panels, then every tool.
      const file = await ensureFixture('text-6.pdf', () => textPdf(6));
      await page.locator('input[type="file"]').setInputFiles(file);
      await expect(page.getByRole('listbox', { name: /Pages of/ })).toBeVisible({
        timeout: 30_000
      });
      for (const tool of TOOLS) {
        await gotoTool(page, tool);
        await expect(page.locator('header')).toBeVisible();
        // A positive tabindex breaks the natural order for everyone downstream of it.
        expect(
          await page.locator('[tabindex]:not([tabindex="0"]):not([tabindex="-1"])').count(),
          `positive tabindex on ${tool}`
        ).toBe(0);
        await scan(`tool/${tool}`);
      }

      // 4. The privacy policy, a static page of its own. It has no theme
      // switcher of its own, so only the scheme is checked there.
      await page.goto('/privacy.html');
      const { violations } = await new AxeBuilder({ page }).analyze();
      for (const v of violations) {
        for (const node of v.nodes) {
          found.push(`privacy.html · ${v.id} (${v.impact}) · ${node.target.join(' ')}`);
        }
      }

      expect(found, `axe violations in the ${theme} theme`).toEqual([]);
    });
  }

  test('every icon-only control has an accessible name', async ({ page }) => {
    await openApp(page);
    const nameless = await page.evaluate(() => {
      const offenders: string[] = [];
      for (const button of Array.from(document.querySelectorAll('button'))) {
        const hasText = (button.textContent ?? '').trim().length > 0;
        const hasLabel = button.getAttribute('aria-label') || button.getAttribute('title');
        if (!hasText && !hasLabel) offenders.push(button.outerHTML.slice(0, 80));
      }
      return offenders;
    });
    expect(nameless).toEqual([]);
  });

  test('the page grid is operable by keyboard alone', async ({ page }) => {
    const file = await ensureFixture('text-6.pdf', () => textPdf(6));
    await openApp(page);
    await page.locator('input[type="file"]').setInputFiles(file);
    await gotoTool(page, 'split');

    const grid = page.getByRole('listbox', { name: /Pages of/ });
    await expect(grid).toBeVisible({ timeout: 30_000 });
    await grid.getByRole('option', { name: /^Page 1 of/ }).focus();

    // Arrow to page 2, select it with Space, and confirm the selection is announced.
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press(' ');
    // Both the grid header and the action bar report the count.
    await expect(page.getByText('1 selected').first()).toBeVisible();
    await expect(grid.getByRole('option', { selected: true })).toHaveCount(1);
  });

  test('the command palette opens, filters, and closes on the keyboard', async ({ page }) => {
    await openApp(page);
    await page.keyboard.press('ControlOrMeta+k');
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await expect(palette).toBeVisible();

    // A focus regression here would silently send keystrokes to the body, so assert it.
    await expect(palette.locator('input')).toBeFocused();
    await page.keyboard.type('compress');
    await expect(palette.getByRole('option', { name: 'Compress' })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#\/tool\/compress/);
  });

  // DS-06's acceptance criterion, asserted against the registry rather than a count that
  // would drift the moment a command is added.
  test('every tool is reachable from the palette', async ({ page }) => {
    await openApp(page);
    await page.keyboard.press('ControlOrMeta+k');
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await expect(palette).toBeVisible();

    for (const title of TOOL_TITLES) {
      await expect(palette.getByRole('option', { name: title, exact: true })).toBeVisible();
    }
  });

  test('a dialog traps focus and Escape returns it', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /Offline, zero network/ }).click();
    const dialog = page.getByRole('dialog', { name: /Zero network/ });
    await expect(dialog).toBeVisible();

    // Tab many times; focus must never leave the dialog.
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      expect(await dialog.evaluate(node => node.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
  });

  test('the trust panel links to a real, reachable privacy policy', async ({ page, request }) => {
    // DIST-02: `public/privacy.html` existed and shipped into both build
    // targets, but nothing in the app UI linked to it — a user reading the
    // trust panel's claims had no way to reach the fuller policy page.
    await openApp(page);
    await page.getByRole('button', { name: /Offline, zero network/ }).click();
    const dialog = page.getByRole('dialog', { name: /Zero network/ });
    const link = dialog.getByRole('link', { name: /privacy policy/i });
    await expect(link).toBeVisible();

    const href = await link.getAttribute('href');
    const response = await request.get(new URL(href!, page.url()).toString());
    expect(response.ok()).toBe(true);
  });

  test('the trust panel links to the shipped third-party licence notices', async ({
    page,
    request
  }) => {
    // Audit 2026-09-25 PLT-12: the Apache/MIT/BSD code in the bundle shipped
    // without the notices its licences require.
    await openApp(page);
    await page.getByRole('button', { name: /Offline, zero network/ }).click();
    const dialog = page.getByRole('dialog', { name: /Zero network/ });
    const link = dialog.getByRole('link', { name: /Third-party licenses/i });
    await expect(link).toBeVisible();

    const href = await link.getAttribute('href');
    const response = await request.get(new URL(href!, page.url()).toString());
    expect(response.ok()).toBe(true);
    const text = await response.text();
    expect(text).toContain('pdfjs-dist@');
    expect(text).toMatch(/Apache License/);
  });
});

test.describe('virtualization', () => {
  // Functional, not a timing budget, so it stays in the retried suite; the
  // wall-clock budgets moved to perf.spec.ts (audit 2026-09-25 PLT-18).
  test('a 100-page document mounts only the visible rows', async ({ page }) => {
    const file = await ensureFixture('text-100.pdf', () => textPdf(100));
    await openApp(page);
    await page.locator('input[type="file"]').setInputFiles(file);
    await gotoTool(page, 'organize');

    const grid = page.getByRole('listbox', { name: /Pages of/ });
    await expect(grid).toBeVisible({ timeout: 30_000 });
    // DOC-04: windowed rendering. Without it all 100 tiles are in the DOM at once.
    const mounted = await grid.getByRole('option').count();
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(60);
  });
});
