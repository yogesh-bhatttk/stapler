/**
 * Browser-level regressions for AUDIT-2026-09-25 findings that only show up
 * with real DOM events: event bubbling to `window` (UI-2) and several
 * `document` capture listeners seeing the same keypress (UI-7).
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { openApp } from './helpers';
import { waitForJobsIdle } from './audit-2026-10-10-helpers';

test.describe('AUDIT-2026-09-25', () => {
  test('UI-2: a PDF dropped on the Home drop zone opens exactly one tab', async ({ page }) => {
    await openApp(page);
    const bytes = [...readFileSync('tests/fixtures/merge-source-1.pdf')];

    await page.evaluate(data => {
      const file = new File([new Uint8Array(data)], 'dropped.pdf', { type: 'application/pdf' });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      const zone = document.querySelector('label[aria-label="Choose PDFs or images to open"]');
      if (!zone) throw new Error('drop zone not found');
      zone.dispatchEvent(
        new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true })
      );
    }, bytes);

    await expect(page.getByRole('listbox', { name: /Pages of/ })).toBeVisible({ timeout: 30_000 });
    // Both the zone and the window handler used to import — two identical tabs.
    // Audit 2026-10-10 T10: was a fixed 1 s sleep. Both handlers start on the
    // same drop event, and an import holds the app's one job slot (RT-7) from
    // its first task to its last; once no job has been running for a run of
    // frames, a second import has either been refused or has finished.
    await waitForJobsIdle(page);
    await expect(page.getByRole('button', { name: 'Close dropped.pdf' })).toHaveCount(1);
  });

  test('UI-7: shortcuts stay inert behind an open dialog, and Escape closes only it', async ({
    page
  }) => {
    await openApp(page);
    await page.getByRole('button', { name: /Offline, zero network/ }).click();
    const dialog = page.getByRole('dialog', { name: /Zero network/ });
    await expect(dialog).toBeVisible();

    // The palette used to open over a dialog; its Escape then closed both.
    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0);

    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
  });
});
