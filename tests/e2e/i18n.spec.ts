/**
 * NFR-04 — real translated content actually reaching the screen.
 *
 * `translate()`'s params substitution and the locale-persistence/region-
 * matching logic have unit coverage (`tests/unit/i18n.test.ts`), but nothing
 * previously drove the language switcher through a real browser and checked
 * that a non-English string actually renders — every locale file could have
 * been reverted to English copies (as most of them were, per the 2026-08-17
 * audit) and no test would have failed.
 */
import { expect, test } from '@playwright/test';
import { openApp } from './helpers';

test.describe('i18n', () => {
  test('switching language renders real translated text, not English fallback', async ({
    page
  }) => {
    await openApp(page);
    await expect(page.getByRole('heading', { name: 'Offline PDF tools' })).toBeVisible();

    await page.getByLabel('Change Language').selectOption('es');

    // "Offline PDF tools" -> "Herramientas de PDF sin conexión" (es.json).
    await expect(
      page.getByRole('heading', { name: 'Herramientas de PDF sin conexión' })
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Offline PDF tools' })).toHaveCount(0);

    // Persists across reload rather than resetting to English.
    await page.reload();
    await expect(
      page.getByRole('heading', { name: 'Herramientas de PDF sin conexión' })
    ).toBeVisible();
  });

  test('an exact regional tag (pt-BR) resolves to its own dictionary', async ({ page }) => {
    await openApp(page);
    await page.getByLabel('Change Language').selectOption('pt-BR');

    // "Offline PDF tools" -> "Ferramentas de PDF offline" (pt-BR.json).
    await expect(page.getByRole('heading', { name: 'Ferramentas de PDF offline' })).toBeVisible();
  });

  test('Arabic switches document direction to RTL', async ({ page }) => {
    await openApp(page);
    await page.getByLabel('Change Language').selectOption('ar');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByRole('heading', { name: 'أدوات PDF دون اتصال' })).toBeVisible();
  });
});
