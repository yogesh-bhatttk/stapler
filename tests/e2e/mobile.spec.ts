import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { contractV1Pdf, ensureFixture } from './fixtures';
import { gotoTool, openApp } from './helpers';
import { TOOLS } from '../../src/core/tools';

/**
 * GAP-3 — phone-width layout (< 600px), and GAP-7's rail labels.
 *
 * Runs in the `chromium` project with a phone's viewport, touch and user agent
 * (Pixel 7 at 390×844, the audit's measuring width) rather than a separate
 * project: `defaultBrowserType` cannot be switched per-describe, and the
 * layout under test is CSS, not engine-specific.
 */
const PHONE = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  userAgent:
    'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36'
};

/** No element of the top bar extends past the viewport, and the page never scrolls sideways. */
async function expectNothingClipped(page: Page) {
  const problems = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const found: string[] = [];
    if (document.documentElement.scrollWidth > width) {
      found.push(`page scrolls sideways: ${document.documentElement.scrollWidth} > ${width}`);
    }
    for (const el of Array.from(document.querySelectorAll('header *'))) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.left < -0.5 || rect.right > width + 0.5) {
        found.push(`${el.tagName}.${el.className} spans ${rect.left}–${rect.right}`);
      }
    }
    return found;
  });
  expect(problems).toEqual([]);
}

async function openDocument(page: Page) {
  const file = await ensureFixture('contract-v1.pdf', contractV1Pdf);
  await page.locator('input[type="file"]').first().setInputFiles(file);
  await expect(page.getByRole('listbox', { name: /Pages of/ })).toBeVisible({ timeout: 30_000 });
}

test.describe('phone width (GAP-3)', () => {
  test.use(PHONE);

  for (const width of [360, 390, 414]) {
    test(`nothing is clipped at ${width}px, in the longest-label locales too`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await openApp(page);
      await expectNothingClipped(page);
      for (const locale of ['de', 'pt-BR', 'ru', 'ar']) {
        await page.locator('header select').selectOption(locale);
        await expectNothingClipped(page);
      }
    });
  }

  test('the rail is replaced by a Tools button, and the trust chip by a named icon', async ({
    page
  }) => {
    await openApp(page);
    await expect(page.getByRole('navigation', { name: 'Tools' })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Tools', exact: true })).toBeVisible();

    const chip = page.getByRole('button', {
      name: 'Offline, zero network requests. Read how to verify this.'
    });
    await expect(chip).toBeVisible();
    // Collapsed: the chip text is not rendered, only the shield.
    await expect(chip.getByText('Offline · 0 requests')).toBeHidden();
    const box = await chip.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);

    // The full claim is one keyboard focus away.
    await chip.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('tooltip')).toHaveText('Offline · 0 requests');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('tooltip')).toBeHidden();
  });

  test('shortcut hints are hidden on a touch screen', async ({ page }) => {
    await openApp(page);
    const search = page.getByRole('button', { name: 'Command palette' });
    await expect(search).toBeVisible();
    await expect(search.getByText(/⌘K|Ctrl K/)).toBeHidden();
  });

  test('the tools sheet reaches every tool, searches, and manages focus', async ({ page }) => {
    await openApp(page);
    const trigger = page.getByRole('button', { name: 'Tools', exact: true });
    await trigger.click();

    const sheet = page.getByRole('dialog', { name: 'Tools' });
    await expect(sheet).toBeVisible();
    // Grouped like the home page, and every registered tool is there.
    await expect(sheet.getByRole('heading', { name: 'Organize' })).toBeVisible();
    await expect(sheet.getByRole('link')).toHaveCount(TOOLS.length);

    // Escape closes it and focus goes back to the button that opened it.
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect(trigger).toBeFocused();

    // Keyboard only: open, search, Enter opens the best match.
    await page.keyboard.press('Enter');
    await expect(sheet).toBeVisible();
    await sheet.getByRole('searchbox', { name: 'Search tools' }).fill('compress');
    await expect(sheet.getByRole('link').first()).toHaveAccessibleName(/^Compress/);
    await sheet.getByRole('searchbox', { name: 'Search tools' }).press('Enter');
    await expect(sheet).toBeHidden();
    await expect(page).toHaveURL(/#\/tool\/compress/);

    // Tapping a tool navigates and closes the sheet; the current tool is marked.
    await trigger.click();
    await expect(sheet.getByRole('link', { name: /^Compress/ })).toHaveAttribute(
      'aria-current',
      'page'
    );
    await sheet.getByRole('link', { name: /^Merge/ }).click();
    await expect(sheet).toBeHidden();
    await expect(page).toHaveURL(/#\/tool\/merge/);
  });

  test('focus is visible on the phone top bar', async ({ page }) => {
    await openApp(page);
    const trigger = page.getByRole('button', { name: 'Tools', exact: true });
    await trigger.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(trigger).toBeFocused();
    const outline = await trigger.evaluate(el => {
      const style = getComputedStyle(el);
      return { style: style.outlineStyle, width: style.outlineWidth, shadow: style.boxShadow };
    });
    expect(outline.style !== 'none' || outline.shadow !== 'none').toBe(true);
  });

  test('the options sheet is opaque, sits above the preview, and never covers the CTA', async ({
    page
  }) => {
    await openApp(page);
    await openDocument(page);
    await gotoTool(page, 'compress');

    const panel = page.getByRole('complementary', { name: 'Compress options' });
    await expect(panel).toBeVisible();
    const cta = page.getByRole('button', { name: 'Compress & export' });
    await expect(cta).toBeVisible();

    const [panelBox, ctaBox] = [await panel.boundingBox(), await cta.boundingBox()];
    expect(panelBox!.y + panelBox!.height).toBeLessThanOrEqual(ctaBox!.y);
    expect(panelBox!.x).toBeGreaterThanOrEqual(0);
    expect(panelBox!.x + panelBox!.width).toBeLessThanOrEqual(390);

    // Opaque: its background has no transparency, so the preview can't show through.
    const background = await panel.evaluate(el => getComputedStyle(el).backgroundColor);
    expect(background).not.toMatch(/rgba\(.*,\s*0?\.\d+\)|transparent/);

    // On top: the point in the middle of the sheet belongs to the sheet, and the
    // CTA's centre belongs to the CTA.
    const hits = await page.evaluate(
      ([p, c]) => {
        const at = (x: number, y: number) => document.elementFromPoint(x, y);
        return {
          panel: at(p.x + p.width / 2, p.y + p.height / 2)?.closest('aside') !== null,
          cta: at(c.x + c.width / 2, c.y + c.height / 2)?.closest('button')?.textContent ?? ''
        };
      },
      [panelBox!, ctaBox!] as const
    );
    expect(hits.panel).toBe(true);
    expect(hits.cta).toContain('Compress & export');

    // Collapsible: folding it leaves only the title row.
    await page.getByRole('button', { name: 'Hide options' }).click();
    const folded = await panel.boundingBox();
    expect(folded!.height).toBeLessThan(panelBox!.height / 2);
    await page.getByRole('button', { name: 'Show options' }).click();
    await expect(page.getByRole('button', { name: 'Hide options' })).toBeVisible();
  });

  test('axe finds nothing at phone width, light and dark', async ({ page }) => {
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await openApp(page);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

      await page.getByRole('button', { name: 'Tools', exact: true }).click();
      await expect(page.getByRole('dialog', { name: 'Tools' })).toBeVisible();
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.keyboard.press('Escape');
    }
    await openDocument(page);
    for (const tool of ['compress', 'sign', 'redact', 'organize']) {
      await gotoTool(page, tool);
      await expect(page.locator('aside')).toBeVisible();
      await expectNothingClipped(page);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    }
  });
});

test.describe('rail labels (GAP-7)', () => {
  test('every rail item shows its label on keyboard focus, and groups are named', async ({
    page
  }) => {
    // The icon-only rail, where a label matters most.
    await page.setViewportSize({ width: 760, height: 900 });
    await openApp(page);
    const rail = page.getByRole('navigation', { name: 'Tools' });
    await expect(rail.getByRole('group', { name: 'Organize' })).toBeVisible();
    await expect(rail.getByRole('group', { name: 'Convert' })).toBeVisible();

    const links = rail.getByRole('link');
    await expect(links).toHaveCount(TOOLS.length);
    await links.first().focus();
    // Keyboard focus, not programmatic: move out and back with Tab.
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    for (let i = 0; i < TOOLS.length; i++) {
      const link = links.nth(i);
      await expect(link).toBeFocused();
      // The label text is visually hidden here but stays the accessible name.
      const label = ((await link.textContent()) ?? '').trim();
      expect(label.length).toBeGreaterThan(0);
      await expect(link).toHaveAccessibleName(label);
      await expect(page.getByRole('tooltip')).toContainText(label);
      await page.keyboard.press('Tab');
    }
  });

  test('the label also shows on hover', async ({ page }) => {
    await page.setViewportSize({ width: 760, height: 900 });
    await openApp(page);
    const rail = page.getByRole('navigation', { name: 'Tools' });
    await rail.getByRole('link', { name: 'Compress' }).hover();
    await expect(page.getByRole('tooltip')).toContainText('Compress');
    await page.mouse.move(700, 600);
    await expect(page.getByRole('tooltip')).toBeHidden();
  });
});
