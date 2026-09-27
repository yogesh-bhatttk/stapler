import { expect, test, type Locator, type Page } from '@playwright/test';
import { gotoTool, openApp } from './helpers';
import { ensureFixture, textPdf } from './fixtures';

/**
 * AUDIT-2026-09-25 GAP-11a (per-document undo) and GAP-10 (read-aloud
 * basics), driven through the real UI.
 */

/** A document tab's switch button (its name gains "Unsaved changes" while dirty). */
function tab(tabs: Locator, name: string): Locator {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return tabs.getByRole('button', { name: new RegExp(`^(Unsaved changes )?${escaped}$`) });
}

async function openTwo(page: Page) {
  const a = await ensureFixture('text-3.pdf', () => textPdf(3));
  const b = await ensureFixture('text-4.pdf', () => textPdf(4));
  await openApp(page);
  await page.locator('input[type="file"]').setInputFiles([a, b]);
  const tabs = page.locator('[aria-label="Open documents"]');
  await expect(tab(tabs, 'text-4.pdf')).toBeVisible({ timeout: 30_000 });
  await expect(tab(tabs, 'text-3.pdf')).toBeVisible();
  return tabs;
}

test.describe('GAP-11a — undo is per document', () => {
  test('Ctrl+Z in one document never touches another, and never closes a document', async ({
    page
  }) => {
    const tabs = await openTwo(page);
    await gotoTool(page, 'organize');

    // The last file opened is active: rotate its first page.
    const tabB = tab(tabs, 'text-4.pdf');
    await expect(tabB).toHaveAttribute('aria-current', 'true');
    const grid = page.getByRole('listbox', { name: 'Pages of text-4.pdf' });
    await grid.getByRole('option', { name: /^Page 1 of/ }).focus();
    await page.keyboard.press('r');
    await expect(tabB.getByLabel('Unsaved changes')).toBeVisible();

    // Undo in the other document: nothing to undo there, B keeps its edit.
    await tab(tabs, 'text-3.pdf').click();
    await expect(page.getByRole('listbox', { name: 'Pages of text-3.pdf' })).toBeVisible();
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');
    await expect(tabB.getByLabel('Unsaved changes')).toBeVisible();
    await expect(
      tabs.getByRole('button', { name: /^(Unsaved changes )?text-[34]\.pdf$/ })
    ).toHaveCount(2);

    // Undo in B reverts exactly B's edit.
    await tabB.click();
    await expect(grid).toBeVisible();
    await page.keyboard.press('Control+z');
    await expect(tabB.getByLabel('Unsaved changes')).toHaveCount(0);
    // Opening is not an undo step: more Ctrl+Z leaves both documents open.
    await page.keyboard.press('Control+z');
    await expect(
      tabs.getByRole('button', { name: /^(Unsaved changes )?text-[34]\.pdf$/ })
    ).toHaveCount(2);
  });

  test('the Edit history tool shows the active document’s history', async ({ page }) => {
    const tabs = await openTwo(page);
    await gotoTool(page, 'organize');
    const grid = page.getByRole('listbox', { name: 'Pages of text-4.pdf' });
    await grid.getByRole('option', { name: /^Page 1 of/ }).focus();
    await page.keyboard.press('r');

    await gotoTool(page, 'history');
    await expect(page.getByText(/Every edit made to text-4\.pdf/)).toBeVisible();
    await expect(
      page.getByRole('list', { name: 'Operation log' }).getByRole('listitem')
    ).toHaveCount(1);

    await tab(tabs, 'text-3.pdf').click();
    await expect(page.getByText(/Every edit made to text-3\.pdf/)).toBeVisible();
    await expect(page.getByText('No operations recorded yet.')).toBeVisible();
  });
});

/**
 * A scripted on-device voice: headless Chromium has none, and a real one
 * would make the test depend on the machine. It records what it is asked to
 * say and fires one `boundary` event for the first word of each utterance —
 * never `end`, so the state under test is stable.
 */
async function installFakeSpeech(page: Page) {
  await page.addInitScript(() => {
    const spoken: string[] = [];
    (window as unknown as { __spoken: string[] }).__spoken = spoken;
    class FakeUtterance {
      text: string;
      voice: unknown = null;
      lang = '';
      rate = 1;
      onend: ((e: unknown) => void) | null = null;
      onboundary: ((e: unknown) => void) | null = null;
      constructor(text: string) {
        this.text = text;
      }
    }
    let current: FakeUtterance | null = null;
    const synth = {
      paused: false,
      speaking: false,
      pending: false,
      getVoices: () => [
        {
          name: 'Test Voice',
          lang: 'en-US',
          localService: true,
          default: true,
          voiceURI: 'test-voice'
        }
      ],
      addEventListener: () => {},
      removeEventListener: () => {},
      cancel() {
        const c = current;
        current = null;
        c?.onend?.({});
      },
      speak(u: FakeUtterance) {
        current = u;
        spoken.push(u.text);
        setTimeout(() => {
          if (current !== u) return;
          const first = u.text.split(' ')[0];
          u.onboundary?.({ name: 'word', charIndex: 0, charLength: first.length });
        }, 30);
      },
      pause() {
        this.paused = true;
      },
      resume() {
        this.paused = false;
      }
    };
    Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', {
      value: FakeUtterance,
      configurable: true
    });
  });
}

test.describe('GAP-10 — read-aloud basics', () => {
  test('highlights the sentence and word being read, steps by sentence from the keyboard', async ({
    page
  }) => {
    await installFakeSpeech(page);
    const file = await ensureFixture('text-3.pdf', () => textPdf(3));
    await openApp(page);
    await page.locator('input[type="file"]').setInputFiles(file);
    await expect(page.getByRole('listbox', { name: /Pages of/ })).toBeVisible({ timeout: 30_000 });
    await gotoTool(page, 'read-aloud');

    const status = page.getByRole('status').filter({ hasText: /page 1 of 3/ });
    await expect(status).toHaveText(/Ready to read page 1 of 3/);
    await page.getByRole('button', { name: 'Play' }).click();
    await expect(status).toHaveText(/Reading page 1 of 3/, { timeout: 30_000 });

    const region = page.getByRole('region', { name: 'Text being read' });
    await expect(region).toBeVisible();
    const current = region.locator('[aria-current="true"]');
    await expect(current).toHaveText('Stapler fixture page 1 Line 1 of body text on page 1.');
    // The boundary event's word is marked inside the current sentence.
    await expect(current.locator('mark')).toHaveText('Stapler');

    // Right arrow → next sentence, spoken and highlighted.
    await region.focus();
    await page.keyboard.press('ArrowRight');
    await expect(current).toHaveText('Line 2 of body text on page 1.');
    await page.keyboard.press('ArrowLeft');
    await expect(current).toHaveText(/Line 1 of body text on page 1\.$/);
    const spoken = await page.evaluate(
      () => (window as unknown as { __spoken: string[] }).__spoken
    );
    expect(spoken).toEqual([
      'Stapler fixture page 1 Line 1 of body text on page 1.',
      'Line 2 of body text on page 1.',
      'Stapler fixture page 1 Line 1 of body text on page 1.'
    ]);

    // Space pauses and resumes; the status line (a live region) says so.
    await page.keyboard.press(' ');
    await expect(status).toHaveText(/Paused on page 1 of 3/);
    await page.keyboard.press(' ');
    await expect(status).toHaveText(/Reading page 1 of 3/);

    // Page Down moves to the next page's first sentence.
    await page.keyboard.press('PageDown');
    await expect(page.getByRole('status').filter({ hasText: /page 2 of 3/ })).toBeVisible();
    await expect(current).toHaveText(/^Stapler fixture page 2/);
  });
});
