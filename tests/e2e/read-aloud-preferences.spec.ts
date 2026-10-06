import { expect, test, type Page } from '@playwright/test';
import { ensureFixture, textPdf } from './fixtures';
import { gotoTool, openApp } from './helpers';

/**
 * ACC-04 AC — "voice and rate survive a reload".
 *
 * Headless Chromium has no voices, so the page gets a scripted
 * `speechSynthesis` (the same shape `audit-2026-10-01-ui.spec.ts` uses) with
 * two on-device voices and one network voice. The init script runs again on
 * the reload, so the voice list is identical on both sides of it; only what
 * the app itself stored can carry the choice across.
 */

interface Spoken {
  text: string;
  voice: string | null;
  rate: number;
}

async function installScriptedVoices(page: Page) {
  await page.addInitScript(() => {
    const spoken: Spoken[] = [];
    (window as unknown as { __spoken: Spoken[] }).__spoken = spoken;
    class FakeUtterance {
      text: string;
      voice: { voiceURI: string } | null = null;
      lang = '';
      rate = 1;
      onend: ((e: unknown) => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      onboundary: ((e: unknown) => void) | null = null;
      constructor(text: string) {
        this.text = text;
      }
    }
    let current: FakeUtterance | null = null;
    const voices = [
      { name: 'Alpha Voice', lang: 'en-US', localService: true, default: true, voiceURI: 'alpha' },
      { name: 'Beta Voice', lang: 'en-GB', localService: true, default: false, voiceURI: 'beta' },
      { name: 'Cloud Voice', lang: 'en-US', localService: false, default: false, voiceURI: 'cloud' }
    ];
    const synth = {
      paused: false,
      speaking: false,
      pending: false,
      getVoices: () => voices,
      addEventListener: () => {},
      removeEventListener: () => {},
      cancel() {
        const c = current;
        current = null;
        c?.onend?.({});
      },
      speak(u: FakeUtterance) {
        current = u;
        spoken.push({ text: u.text, voice: u.voice?.voiceURI ?? null, rate: u.rate });
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

async function openReadAloud(page: Page) {
  const file = await ensureFixture('text-3.pdf', () => textPdf(3));
  await openApp(page);
  await page.locator('input[type="file"]').setInputFiles(file);
  await expect(page.getByRole('listbox', { name: /Pages of/ })).toBeVisible({ timeout: 30_000 });
  await gotoTool(page, 'read-aloud');
}

/** What the app has stored, read straight from its IndexedDB settings store. */
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

test.describe('read aloud remembers voice and rate (ACC-04)', () => {
  test('a chosen voice and rate survive a reload, and are what the next reading uses', async ({
    page
  }) => {
    await installScriptedVoices(page);
    await openReadAloud(page);

    const voice = page.getByLabel('Voice (on-device only)');
    const rate = page.getByRole('slider', { name: 'Reading speed' });
    // On-device voices only: the network voice is never offered.
    await expect(voice.locator('option')).toHaveText(['Alpha Voice (en-US)', 'Beta Voice (en-GB)']);
    await expect(voice).toHaveValue('alpha');
    await expect(rate).toHaveValue('1');

    // Keyboard only: pick the second voice and step the rate up 1 → 1.25.
    await voice.selectOption('beta');
    await rate.focus();
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
    await expect(rate).toHaveValue('1.25');

    // The rate write is debounced; wait for the store, not a fixed sleep.
    await expect.poll(() => storedSetting(page, 'readAloud.voiceUri')).toBe('beta');
    await expect.poll(() => storedSetting(page, 'readAloud.rate')).toBe(1.25);

    await page.reload();
    await openReadAloud(page);

    await expect(voice).toHaveValue('beta');
    await expect(rate).toHaveValue('1.25');
    await expect(page.getByText('Speed (1.25x)')).toBeVisible();

    // And the remembered pair is what the reading actually uses.
    await page.getByRole('button', { name: 'Play' }).click();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __spoken: Spoken[] }).__spoken))
      .not.toEqual([]);
    const spoken = await page.evaluate(
      () => (window as unknown as { __spoken: Spoken[] }).__spoken
    );
    expect(spoken[0]).toMatchObject({ voice: 'beta', rate: 1.25 });
    expect(spoken[0].text).toMatch(/^Stapler fixture page 1/);
    await page.getByRole('button', { name: 'Stop' }).click();
  });
});
