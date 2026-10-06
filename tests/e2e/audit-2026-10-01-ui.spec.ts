import { expect, test, type Page } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { commitAndRead, gotoTool, openApp } from './helpers';
import { ensureFixture, textPdf } from './fixtures';

/**
 * AUDIT-2026-10-01 — read-aloud UI-1 (stale page cache), UI-2 (a synthesis
 * error leaves the panel stuck) and UI-10 (the end of the document), driven
 * through the real panel with a scripted on-device voice.
 */

interface SpeechControl {
  spoken: string[];
  /** Answer every utterance with `end` after a few ms (reads straight through). */
  autoEnd: boolean;
  /** The next utterance fails with this `error` instead of speaking. */
  failNext: string | null;
}

async function installScriptedSpeech(page: Page) {
  await page.addInitScript(() => {
    const control: SpeechControl = { spoken: [], autoEnd: false, failNext: null };
    (window as unknown as { __speech: SpeechControl }).__speech = control;
    class FakeUtterance {
      text: string;
      voice: unknown = null;
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
    const synth = {
      paused: false,
      speaking: false,
      pending: false,
      getVoices: () => [
        { name: 'Test Voice', lang: 'en-US', localService: true, default: true, voiceURI: 'test' }
      ],
      addEventListener: () => {},
      removeEventListener: () => {},
      cancel() {
        const c = current;
        current = null;
        // Chrome answers cancel() with `end`.
        c?.onend?.({});
      },
      speak(u: FakeUtterance) {
        current = u;
        if (control.failNext) {
          const error = control.failNext;
          control.failNext = null;
          setTimeout(() => {
            if (current === u) u.onerror?.({ error });
          }, 10);
          return;
        }
        control.spoken.push(u.text);
        if (control.autoEnd) {
          setTimeout(() => {
            if (current !== u) return;
            current = null;
            u.onend?.({});
          }, 10);
        }
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

const speech = (page: Page) =>
  page.evaluate(() => (window as unknown as { __speech: SpeechControl }).__speech);

async function openReadAloud(page: Page) {
  await installScriptedSpeech(page);
  const file = await ensureFixture('text-3.pdf', () => textPdf(3));
  await openApp(page);
  await page.locator('input[type="file"]').setInputFiles(file);
  await expect(page.getByRole('listbox', { name: /Pages of/ })).toBeVisible({ timeout: 30_000 });
}

test.describe('AUDIT-2026-10-01 — read aloud', () => {
  test('UI-1: after the page list changes, Play reads the page that is there now', async ({
    page
  }) => {
    await openReadAloud(page);
    // Delete page 2 in Organize, then read: the panel's bytes are of pages 1, 3.
    await gotoTool(page, 'organize');
    const grid = page.getByRole('listbox', { name: /Pages of/ });
    await grid.getByRole('option', { name: /^Page 2 of/ }).focus();
    await page.keyboard.press('Delete');
    await expect(page.getByText('2 pages').first()).toBeVisible();

    await gotoTool(page, 'read-aloud');
    const status = page.getByRole('status').filter({ hasText: /Ready to read|Reading/ });
    await page.getByRole('button', { name: 'Play' }).click();
    await expect(status).toHaveText(/Reading page 1 of 2/, { timeout: 30_000 });
    await page.getByRole('button', { name: 'Stop' }).click();

    // Undo the delete while the panel is open: page 2 is back.
    await page.locator('body').click({ position: { x: 1, y: 1 } });
    await page.keyboard.press('Control+z');
    await expect(status).toHaveText(/page 1 of 3/);

    await page.getByRole('button', { name: 'Next page' }).click();
    await page.getByRole('button', { name: 'Play' }).click();
    await expect(status).toHaveText(/Reading page 2 of 3/, { timeout: 30_000 });
    const { spoken } = await speech(page);
    // The restored page 2, not page 3 out of the stale two-page bytes.
    expect(spoken[spoken.length - 1]).toMatch(/^Stapler fixture page 2/);
  });

  test('UI-2: a synthesis error resets the panel to idle with a note', async ({ page }) => {
    await openReadAloud(page);
    await gotoTool(page, 'read-aloud');
    await page.evaluate(() => {
      (window as unknown as { __speech: SpeechControl }).__speech.failNext = 'synthesis-failed';
    });
    await page.getByRole('button', { name: 'Play' }).click();
    const status = page.getByRole('status').filter({ hasText: /page 1 of 3/ });
    await expect(status).toHaveText(
      /Ready to read page 1 of 3\. Reading stopped: the voice reported an error \(synthesis-failed\)\./,
      { timeout: 30_000 }
    );
    await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop' })).toBeDisabled();
  });

  test('UI-10: reading to the end goes back to page 1, so Play starts over', async ({ page }) => {
    await openReadAloud(page);
    await gotoTool(page, 'read-aloud');
    await page.evaluate(() => {
      (window as unknown as { __speech: SpeechControl }).__speech.autoEnd = true;
    });
    await page.getByRole('button', { name: 'Play' }).click();
    const status = page.getByRole('status').filter({ hasText: /page \d of 3/ });
    // Read through to the last sentence of page 3…
    await expect
      .poll(async () => (await speech(page)).spoken.at(-1) ?? '', { timeout: 30_000 })
      .toMatch(/page 3\.$/);
    // …and then back at the start, idle.
    await expect(status).toHaveText(/^Ready to read page 1 of 3\.$/);
    const first = (await speech(page)).spoken;
    expect(first[0]).toMatch(/^Stapler fixture page 1/);
    expect(first[first.length - 1]).toMatch(/page 3\.$/);

    await page.evaluate(() => {
      (window as unknown as { __speech: SpeechControl }).__speech.autoEnd = false;
    });
    await page.getByRole('button', { name: 'Play' }).click();
    await expect(status).toHaveText(/Reading page 1 of 3/);
    const again = (await speech(page)).spoken;
    expect(again[again.length - 1]).toMatch(/^Stapler fixture page 1/);
  });
});

/** Pages of the given sizes, each with a line of text so the diff has something to see. */
async function sizedPdf(sizes: [number, number][], label: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  sizes.forEach(([w, h], i) => {
    const page = doc.addPage([w, h]);
    page.drawText(`${label} page ${i + 1}`, { x: 40, y: h - 60, size: 18, font });
  });
  return doc.save();
}

const A4: [number, number] = [595.28, 841.89];
const A4_LANDSCAPE: [number, number] = [841.89, 595.28];
const LETTER: [number, number] = [612, 792];

async function openComparePair(page: Page) {
  const before = await ensureFixture('audit-1001-before.pdf', () =>
    sizedPdf([A4, A4_LANDSCAPE], 'Before')
  );
  const after = await ensureFixture('audit-1001-after.pdf', () =>
    sizedPdf([LETTER, A4_LANDSCAPE], 'After')
  );
  await openApp(page);
  await page.locator('input[type="file"]').setInputFiles(before);
  await expect(page.getByRole('listbox', { name: /Pages of/ })).toBeVisible({ timeout: 30_000 });
  await gotoTool(page, 'compare');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open file to compare...' }).click();
  await (await chooser).setFiles(after);
  await expect(page.locator('canvas').first()).toBeAttached({ timeout: 30_000 });
}

test.describe('AUDIT-2026-10-01 — compare exports (X-2, X-3, X-6)', () => {
  test('visual diff: every page at its real size, A4 against Letter exported, not refused', async ({
    page
  }) => {
    await openComparePair(page);
    const out = await PDFDocument.load(await commitAndRead(page, 'Export Diff PDF'));
    expect(out.getPageCount()).toBe(2);
    const sizes = out.getPages().map(p => p.getSize());
    expect(sizes[0].width).toBeCloseTo(A4[0], 1);
    expect(sizes[0].height).toBeCloseTo(A4[1], 1);
    // Landscape stays landscape — never squashed into 612×792.
    expect(sizes[1].width).toBeCloseTo(A4_LANDSCAPE[0], 1);
    expect(sizes[1].height).toBeCloseTo(A4_LANDSCAPE[1], 1);
  });

  test('redline: each pane at its own page size', async ({ page }) => {
    await openComparePair(page);
    await page.getByRole('radio', { name: 'Redline (side by side)' }).check();
    const out = await PDFDocument.load(await commitAndRead(page, 'Export Diff PDF'));
    expect(out.getPageCount()).toBe(2);
    // margins + before pane + gutter + after pane
    expect(out.getPage(0).getWidth()).toBeCloseTo(24 * 2 + A4[0] + 24 + LETTER[0], 1);
    expect(out.getPage(1).getWidth()).toBeCloseTo(24 * 3 + A4_LANDSCAPE[0] * 2, 1);
  });
});
