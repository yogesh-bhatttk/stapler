/**
 * HRD-32 / AUDIT-EDGE-CASES-2026-09-15 §1.1 — a file dragged in from the OS and
 * dropped on an open document never navigates the tab away (losing the whole
 * workspace) and never imports twice.
 *
 * A synthetic `DragEvent` cannot trigger the browser's default navigation, so the
 * load-bearing assertion is the one the browser itself acts on: both `dragover`
 * and `drop` come back `defaultPrevented`. A drop the app did not cancel is the
 * one a real browser would follow to the dropped file. The URL, the open tab and
 * its pages are then checked as well.
 */
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { ensureFixture, textPdf } from './fixtures';
import { openApp } from './helpers';

/** Dispatches dragenter → dragover → drop of a real PDF `File` on the element `selector` matches. */
async function dropPdfOn(page: Page, selector: string) {
  const bytes = [...readFileSync('tests/fixtures/merge-source-1.pdf')];
  return page.evaluate(
    ({ data, selector }) => {
      const target = selector === 'window' ? window : document.querySelector(selector);
      if (!target) throw new Error(`no element matches ${selector}`);
      const file = new File([new Uint8Array(data)], 'dropped.pdf', { type: 'application/pdf' });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      const fire = (type: string) => {
        const event = new DragEvent(type, {
          dataTransfer: transfer,
          bubbles: true,
          cancelable: true
        });
        target.dispatchEvent(event);
        return event.defaultPrevented;
      };
      fire('dragenter');
      return { dragover: fire('dragover'), drop: fire('drop') };
    },
    { data: bytes, selector }
  );
}

async function openThreePages(page: Page) {
  const file = await ensureFixture('text-3.pdf', () => textPdf(3));
  await openApp(page);
  await page.locator('input[type="file"]').setInputFiles(file);
  const grid = page.getByRole('listbox', { name: /Pages of/ });
  await expect(grid.getByRole('option')).toHaveCount(3, { timeout: 30_000 });
  return grid;
}

test.describe('HRD-32 §1.1 — dropping a file on an open document', () => {
  for (const [where, selector] of [
    ['a page tile in the grid', '[role="listbox"] [role="option"]'],
    ['the top bar', 'header'],
    ['the window itself', 'window']
  ] as const) {
    test(`a PDF dropped on ${where} keeps the tab, its document and its URL`, async ({ page }) => {
      const grid = await openThreePages(page);
      const url = page.url();

      const prevented = await dropPdfOn(page, selector);
      expect(prevented, 'the browser would navigate to an uncancelled drop').toEqual({
        dragover: true,
        drop: true
      });

      // Pointed at the real affordance instead of guessing what was meant.
      await expect(
        page.getByText('Use "Add PDF" to insert pages into this document.').first()
      ).toBeVisible();
      // Given time to import if it were going to: neither a new tab nor new pages.
      await page.waitForTimeout(1500);
      expect(page.url()).toBe(url);
      await expect(page.getByRole('button', { name: 'Close text-3.pdf' })).toHaveCount(1);
      await expect(page.getByRole('button', { name: 'Close dropped.pdf' })).toHaveCount(0);
      await expect(grid.getByRole('option')).toHaveCount(3);
    });
  }

  test('with nothing open, a PDF dropped on the window opens exactly one tab', async ({ page }) => {
    await openApp(page);
    const url = page.url();
    const prevented = await dropPdfOn(page, 'header');
    expect(prevented).toEqual({ dragover: true, drop: true });
    // The tab opens; unlike a Home drop-zone drop, this path stays on Home
    // rather than switching to Organize, so the tab is what is asserted.
    const tab = page.getByRole('button', { name: 'Close dropped.pdf' });
    await expect(tab).toHaveCount(1, { timeout: 30_000 });
    await page.waitForTimeout(1000);
    await expect(tab).toHaveCount(1);
    // Same page: only the in-app route (the hash) may change.
    expect(page.url().split('#')[0]).toBe(url.split('#')[0]);
  });
});
