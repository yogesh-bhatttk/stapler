import { expect, test, type Page } from '@playwright/test';
import { ensureFixture, heavyPdf, textPdf } from './fixtures';
import { confirmExportReviewIfShown, gotoTool, openApp } from './helpers';

/**
 * NFR-02 — the wall-clock budgets from PLAN §5.1.
 *
 * Audit 2026-09-25 PLT-18: these used to sit in the functional suite, which CI
 * retried twice, so a budget that failed once and passed on retry reported
 * green — the retry hid the regression the assertion exists to catch. They now
 * run only in the `perf` Playwright project (`pnpm test:perf`), which has
 * `retries: 0`, and a separate CI job.
 *
 * Every budget is PLAN §5.1's number. Headless CI runners are slower and
 * noisier than a user's machine, so each assertion allows the budget times one
 * explicit, visible factor, `STAPLER_PERF_SLACK` (default 1.5) — never a
 * quietly widened constant. The measured value, the budget and the slack are
 * attached to the test as an annotation on every run, so a creeping number is
 * visible long before it fails.
 */
const SLACK = Number(process.env.STAPLER_PERF_SLACK ?? '1.5');

function expectWithinBudget(label: string, measuredMs: number, budgetMs: number) {
  const allowed = budgetMs * SLACK;
  test.info().annotations.push({
    type: 'perf',
    description: `${label}: ${Math.round(measuredMs)} ms (budget ${budgetMs} ms × slack ${SLACK} = ${allowed} ms)`
  });
  expect(
    measuredMs,
    `${label}: ${Math.round(measuredMs)} ms against PLAN §5.1's ${budgetMs} ms (× ${SLACK} CI slack)`
  ).toBeLessThan(allowed);
}

/** Resolves after two animation frames — i.e. once the page has rendered a scroll. */
async function nextPaint(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
}

test.describe('performance budgets (PLAN §5.1)', () => {
  test('the app is interactive within 500ms of navigation', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Offline PDF tools' })).toBeVisible();
    const interactive = await page.evaluate(() => {
      const [nav] = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
      return nav.domInteractive - nav.startTime;
    });
    expectWithinBudget('domInteractive', interactive, 500);
  });

  test('the first thumbnail of a 100-page PDF appears within 1.5s', async ({ page }) => {
    const file = await ensureFixture('text-100.pdf', () => textPdf(100));
    await openApp(page);

    await page.locator('input[type="file"]').setInputFiles(file);
    const started = Date.now();
    // Wait for a canvas that has actually been painted, not merely mounted.
    await page.waitForFunction(
      () => {
        const canvas = document.querySelector('canvas');
        return canvas instanceof HTMLCanvasElement && canvas.width > 1;
      },
      undefined,
      { timeout: 20_000 }
    );
    expectWithinBudget('first thumbnail', Date.now() - started, 1500);
  });

  test('all 100 thumbnails of a 100-page PDF render within 6s of scrolling through', async ({
    page
  }) => {
    // Not just the first paint, but scrolling the whole way through a 100-page
    // document. Row virtualization (DOC-04) means only visible rows are ever
    // mounted, so this scrolls in steps to pass every row through the
    // viewport, then times how long the *last* page's thumbnail takes to paint.
    const file = await ensureFixture('text-100.pdf', () => textPdf(100));
    await openApp(page);
    await page.locator('input[type="file"]').setInputFiles(file);
    await gotoTool(page, 'organize');

    const grid = page.getByRole('listbox', { name: /Pages of/ });
    await expect(grid).toBeVisible({ timeout: 30_000 });
    const scroller = page.locator('[data-testid="pagegrid-scroller"]');

    const started = Date.now();
    const steps = 10;
    for (let i = 1; i <= steps; i++) {
      await scroller.evaluate((el, fraction) => {
        el.scrollTo(0, el.scrollHeight * fraction);
      }, i / steps);
      // Was a fixed 50 ms sleep: wait for the scroll to have been painted, so
      // the virtualizer has mounted the rows now in view.
      await nextPaint(page);
    }

    const lastPage = grid.getByRole('option', { name: 'Page 100 of 100' });
    await expect(lastPage).toBeVisible({ timeout: 20_000 });
    await page.waitForFunction(
      option => {
        const canvas = option?.querySelector('canvas');
        return canvas instanceof HTMLCanvasElement && canvas.width > 1;
      },
      await lastPage.elementHandle(),
      { timeout: 20_000 }
    );
    expectWithinBudget('scroll through 100 thumbnails', Date.now() - started, 6000);
  });

  test('NFR-03: processes heavy documents within memory limits', async ({ page }) => {
    const [heavyFile, longFile] = await Promise.all([
      ensureFixture('heavy.pdf', heavyPdf),
      ensureFixture('text-300.pdf', () => textPdf(300))
    ]);

    // `performance.memory` is non-standard, Chromium only.
    const heap = () =>
      page.evaluate(
        () =>
          (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
            ?.usedJSHeapSize ?? 0
      );

    await openApp(page);

    await page.locator('input[type="file"]').setInputFiles(heavyFile);
    await gotoTool(page, 'organize');
    await expect(page.getByRole('listbox', { name: /Pages of/ })).toBeVisible({ timeout: 30_000 });
    const mem1 = await heap();

    await page.getByRole('button', { name: 'Close heavy.pdf' }).click();
    await page.goto('/#/');
    await expect(page.locator('input[type="file"]')).toBeVisible();

    await page.locator('input[type="file"]').setInputFiles(longFile);
    await gotoTool(page, 'organize');
    await expect(page.getByRole('listbox', { name: /Pages of/ })).toBeVisible({ timeout: 30_000 });
    const mem2 = await heap();

    await page.getByRole('button', { name: 'Close text-300.pdf' }).click();
    await page.goto('/#/');
    await expect(page.locator('input[type="file"]')).toBeVisible();

    // The third file of the 3-file sequence the AC asks for.
    await page.locator('input[type="file"]').setInputFiles(heavyFile);
    await gotoTool(page, 'organize');
    const grid = page.getByRole('listbox', { name: /Pages of/ });
    await expect(grid).toBeVisible({ timeout: 30_000 });

    const scroller = page.locator('[data-testid="pagegrid-scroller"]');
    if (await scroller.isVisible()) {
      await scroller.evaluate(e => e.scrollTo(0, e.scrollHeight));
    }
    // Was a fixed 1 s sleep: wait until every mounted thumbnail has painted,
    // which is the state whose memory this measures.
    await nextPaint(page);
    await page.waitForFunction(
      () => {
        const canvases = Array.from(document.querySelectorAll('[role="listbox"] canvas'));
        return (
          canvases.length > 0 && canvases.every(c => c instanceof HTMLCanvasElement && c.width > 1)
        );
      },
      undefined,
      { timeout: 20_000 }
    );
    const mem3 = await heap();

    // A leak of offscreen canvases or PDF documents balloons past 500 MB; the
    // ceiling is 200 MB. Known limitation, stated rather than glossed:
    // `performance.memory` reports *this realm's* heap only. The render and
    // process workers have their own, and
    // `performance.measureUserAgentSpecificMemory()`, which would cover them,
    // requires cross-origin isolation (COOP/COEP) that neither target sets.
    // Worker-heap budget therefore remains unverified here.
    if (mem1 > 0 && mem2 > 0 && mem3 > 0) {
      for (const mem of [mem1, mem2, mem3]) expect(mem).toBeLessThan(200 * 1024 * 1024);
    }
  });

  test('merges 10 × 5MB PDFs within 8 seconds', async ({ page }) => {
    const file = await ensureFixture('heavy.pdf', heavyPdf);
    const files = Array<string>(10).fill(file);
    await openApp(page);
    await page.locator('input[type="file"]').setInputFiles(files[0]);
    // The app auto-navigates to 'organize' once the import resolves; switching
    // tools before that resolves races it.
    await expect(page.getByRole('listbox', { name: /Pages of/ })).toBeVisible({ timeout: 30_000 });
    await gotoTool(page, 'merge');
    await expect(page.getByRole('heading', { name: 'Source files' })).toBeVisible({
      timeout: 30_000
    });

    const started = Date.now();
    // Headless Chromium auto-cancels a native file chooser nobody listens for,
    // so feed it through the `filechooser` event.
    const filechooserPromise = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Add PDFs or images' }).click();
    const filechooser = await filechooserPromise;
    await filechooser.setFiles(files.slice(1));

    await expect(page.locator('ol').first().locator('li')).toHaveCount(10, { timeout: 30_000 });

    const downloadPromise = page.waitForEvent('download');

    // Longest gap between animation frames during the merge: the main-thread
    // blocking budget (CLAUDE.md: no task over 50 ms).
    await page.evaluate(() => {
      window.__maxFrameGap = 0;
      let lastTime = performance.now();
      const measure = (time: number) => {
        window.__maxFrameGap = Math.max(window.__maxFrameGap, time - lastTime);
        lastTime = time;
        if (!window.__stopMonitor) requestAnimationFrame(measure);
      };
      requestAnimationFrame(measure);
    });

    await page.getByRole('button', { name: 'View changes' }).click();
    await confirmExportReviewIfShown(page, downloadPromise);
    await downloadPromise;
    const elapsed = Date.now() - started;

    const maxGap = await page.evaluate(() => {
      window.__stopMonitor = true;
      return window.__maxFrameGap;
    });

    expectWithinBudget('merge 10 × 5 MB', elapsed, 8000);
    expectWithinBudget('longest main-thread frame gap during merge', maxGap, 50);
  });
});

declare global {
  interface Window {
    __maxFrameGap: number;
    __stopMonitor: boolean;
  }
}
