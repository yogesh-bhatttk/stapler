import { expect, test, type Page } from '@playwright/test';
import { statSync } from 'node:fs';
import { unzipSync } from 'fflate';
import { PDFDocument } from 'pdf-lib';
import { ensureFixture, heavyPdf, letterPdf, textPdf } from './fixtures';
import {
  commitAndRead,
  confirmExportReviewIfShown,
  gotoTool,
  importFile,
  openApp
} from './helpers';
import { HeapProbe, emptyPeak, mb, type HeapPeak } from './worker-heap';
import { LARGE_PDF_PAGES, ensureLargePdf } from './audit-2026-10-10-helpers';

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

/**
 * Memory ceilings. Not scaled by `SLACK`: a heap is not slower on a shared
 * runner, it is the same size.
 *
 * - Per realm, 200 MB of V8 heap — the ceiling NFR-03 has always asserted for
 *   the main thread, now applied to each worker as well (HRD-12).
 * - All realms together, counting ArrayBuffer backing stores and Blink's heap
 *   (where decoded pixels and PDF bytes actually sit), 1.5 GB — PLAN §5.1's
 *   peak-memory budget.
 */
const REALM_HEAP_CEILING = 200 * 1024 * 1024;
const TOTAL_MEMORY_CEILING = 1.5 * 1024 * 1024 * 1024;

function expectMemoryWithinCeilings(label: string, peak: HeapPeak) {
  test.info().annotations.push({
    type: 'memory',
    description:
      `${label}: main heap ${mb(peak.mainUsed)}, largest worker heap ${mb(peak.workerUsed)}` +
      ` (${peak.workerName || 'none'}), workers incl. buffers ${mb(peak.workersTotal)},` +
      ` all realms incl. buffers ${mb(peak.total)}; ${peak.workerCount} workers at most,` +
      ` ${peak.samples} samples`
  });
  // A probe that never saw a worker would pass the worker ceilings vacuously.
  expect(peak.workerCount, `${label}: no worker was measured`).toBeGreaterThan(0);
  expect(peak.mainUsed, `${label}: main-thread heap`).toBeLessThan(REALM_HEAP_CEILING);
  expect(peak.workerUsed, `${label}: ${peak.workerName} heap`).toBeLessThan(REALM_HEAP_CEILING);
  expect(peak.total, `${label}: all realms incl. buffers`).toBeLessThan(TOTAL_MEMORY_CEILING);
}

/** Nearest-rank percentile of `values` (0..100). */
function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

/** Width and height from a PNG's IHDR. */
function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(Array.from(bytes.subarray(1, 4))).toEqual([0x50, 0x4e, 0x47]);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** Inserts an EXIF APP1 segment with Orientation = `orientation` right after SOI. */
function withOrientation(jpeg: Uint8Array, orientation: number): Uint8Array {
  // prettier-ignore
  const tiff = [
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, // little-endian header, IFD at 8
    0x01, 0x00, // one entry
    0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, orientation, 0x00, 0x00, 0x00, // 0x0112 SHORT
    0x00, 0x00, 0x00, 0x00 // no next IFD
  ];
  const body = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff];
  const length = body.length + 2;
  const app1 = new Uint8Array([0xff, 0xe1, length >> 8, length & 0xff, ...body]);
  const out = new Uint8Array(jpeg.length + app1.length);
  out.set(jpeg.subarray(0, 2), 0);
  out.set(app1, 2);
  out.set(jpeg.subarray(2), 2 + app1.length);
  return out;
}

/**
 * A 12-megapixel (4032 × 3024) JPEG the size of a real phone photo (~2-4 MB),
 * encoded by the browser: a gradient with per-pixel grain, so it does not
 * compress to nothing the way a flat fill would.
 */
async function phonePhoto(page: Page, index: number): Promise<Uint8Array> {
  const base64 = await page.evaluate(async seed => {
    const width = 4032;
    const height = 3024;
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d')!;
    const image = ctx.createImageData(width, height);
    const px = image.data;
    let state = seed + 1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        const grain = ((state >> 16) % 13) - 6;
        const i = (y * width + x) * 4;
        px[i] = ((x * 255) / width + seed * 13 + grain) & 0xff;
        px[i + 1] = ((y * 255) / height + grain) & 0xff;
        px[i + 2] = (((x + y) * 128) / width + seed * 29 + grain) & 0xff;
        px[i + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }, index);
  return new Uint8Array(Buffer.from(base64, 'base64'));
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

    // `performance.memory` is non-standard, Chromium only, and sees this realm's
    // heap alone. HRD-12: the render and process workers have their own heaps —
    // that is where parsed documents and re-encoded pages live — so the probe
    // also reads every worker's heap over CDP, sampling throughout.
    const heap = () =>
      page.evaluate(
        () =>
          (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
            ?.usedJSHeapSize ?? 0
      );
    const probe = await HeapProbe.attach(page);
    const peak = emptyPeak();

    await openApp(page);

    const mem1 = await probe.sampleWhile(async () => {
      await page.locator('input[type="file"]').setInputFiles(heavyFile);
      await gotoTool(page, 'organize');
      await expect(page.getByRole('listbox', { name: /Pages of/ })).toBeVisible({
        timeout: 30_000
      });
      return heap();
    }, peak);

    await page.getByRole('button', { name: 'Close heavy.pdf' }).click();
    await page.goto('/#/');
    await expect(page.locator('input[type="file"]')).toBeVisible();

    const mem2 = await probe.sampleWhile(async () => {
      await page.locator('input[type="file"]').setInputFiles(longFile);
      await gotoTool(page, 'organize');
      await expect(page.getByRole('listbox', { name: /Pages of/ })).toBeVisible({
        timeout: 30_000
      });
      return heap();
    }, peak);

    await page.getByRole('button', { name: 'Close text-300.pdf' }).click();
    await page.goto('/#/');
    await expect(page.locator('input[type="file"]')).toBeVisible();

    // The third file of the 3-file sequence the AC asks for.
    const mem3 = await probe.sampleWhile(async () => {
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
            canvases.length > 0 &&
            canvases.every(c => c instanceof HTMLCanvasElement && c.width > 1)
          );
        },
        undefined,
        { timeout: 20_000 }
      );
      return heap();
    }, peak);
    await probe.detach();

    expectMemoryWithinCeilings('three large files in sequence', peak);
    // A leak of offscreen canvases or PDF documents balloons past 500 MB; the
    // ceiling is 200 MB per realm.
    for (const { result: mem } of [mem1, mem2, mem3]) {
      if (mem > 0) expect(mem).toBeLessThan(REALM_HEAP_CEILING);
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

  test('DOC-04: a 300-page grid scrolls at 60 fps', async ({ page }) => {
    // DOC-04's AC: "300 pages scroll at 60fps". A scripted scroll moves the
    // grid a fixed distance every animation frame, top to bottom, while
    // thumbnails mount, render in the worker and paint. Every frame's duration
    // is recorded with `requestAnimationFrame`, and every main-thread long task
    // with a `longtask` observer. 60 fps is a 16.7 ms frame; the p95 frame must
    // meet it (× slack), and no task may block longer than the 50 ms budget.
    const file = await ensureFixture('text-300.pdf', () => textPdf(300));
    await openApp(page);
    await page.locator('input[type="file"]').setInputFiles(file);
    await gotoTool(page, 'organize');
    const grid = page.getByRole('listbox', { name: /Pages of/ });
    await expect(grid).toBeVisible({ timeout: 30_000 });
    await expect(grid.getByRole('option', { name: 'Page 1 of 300' })).toBeVisible();
    await page.waitForFunction(
      () => {
        const canvas = document.querySelector('[role="listbox"] canvas');
        return canvas instanceof HTMLCanvasElement && canvas.width > 1;
      },
      undefined,
      { timeout: 20_000 }
    );
    await nextPaint(page);

    const scroller = page.locator('[data-testid="pagegrid-scroller"]');
    const run = await scroller.evaluate(async (el, pxPerFrame) => {
      const longTasks: number[] = [];
      const observer = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) longTasks.push(entry.duration);
      });
      observer.observe({ type: 'longtask' });
      const frames: number[] = [];
      const started = performance.now();
      await new Promise<void>(resolve => {
        let last = -1;
        const step = (now: number) => {
          if (last >= 0) frames.push(now - last);
          last = now;
          const max = el.scrollHeight - el.clientHeight;
          if (el.scrollTop >= max - 1) {
            resolve();
            return;
          }
          el.scrollTop = Math.min(max, el.scrollTop + pxPerFrame);
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
      // Let the observer deliver anything still queued.
      await new Promise(resolve => setTimeout(resolve, 100));
      for (const entry of observer.takeRecords()) longTasks.push(entry.duration);
      observer.disconnect();
      return {
        frames,
        longTasks,
        elapsed: performance.now() - started,
        scrolled: el.scrollTop,
        scrollHeight: el.scrollHeight
      };
    }, 40);

    // The scroll really went through all 300 pages, not one screenful.
    expect(run.frames.length).toBeGreaterThan(100);
    await expect(grid.getByRole('option', { name: 'Page 300 of 300' })).toBeVisible();

    const p95 = percentile(run.frames, 95);
    const fps = (run.frames.length / run.elapsed) * 1000;
    const longest = Math.max(0, ...run.longTasks);
    test.info().annotations.push({
      type: 'perf',
      description:
        `300-page scroll: ${run.frames.length} frames over ${Math.round(run.scrollHeight)} px in ` +
        `${Math.round(run.elapsed)} ms = ${fps.toFixed(1)} fps; p50 ` +
        `${percentile(run.frames, 50).toFixed(1)} ms, p95 ${p95.toFixed(1)} ms, max ` +
        `${Math.max(...run.frames).toFixed(1)} ms; ${run.frames.filter(f => f > 25).length} frames ` +
        `over 25 ms; ${run.longTasks.length} long tasks, longest ` +
        `${Math.round(longest)} ms`
    });
    expectWithinBudget('p95 frame time scrolling 300 pages', p95, 1000 / 60);
    expectWithinBudget('longest main-thread task scrolling 300 pages', longest, 50);
  });

  test('CNV-01: 20 phone photos become a correctly-oriented 20-page PDF within 10s', async ({
    page
  }) => {
    // CNV-01's AC, at its own scale: twenty 12-megapixel JPEGs, a quarter of
    // them stored landscape with EXIF Orientation=6 (shot in portrait, the way
    // a phone saves them). Generated outside the timed section.
    test.setTimeout(180_000);
    const rotated = new Set([0, 4, 8, 12, 16]);
    const files: string[] = [];
    let bytesIn = 0;
    // Encoded in a page of their own, closed before the timed run, and cached
    // in the (git-ignored) fixture directory: encoding 240 megapixels is the
    // heaviest thing this test does, and none of it belongs in the measurement.
    let encoder: Page | null = null;
    for (let i = 0; i < 20; i++) {
      const name = `phone-photo-${String(i + 1).padStart(2, '0')}.jpg`;
      const file = await ensureFixture(name, async () => {
        encoder ??= await page.context().newPage();
        const jpeg = await phonePhoto(encoder, i);
        return rotated.has(i) ? withOrientation(jpeg, 6) : jpeg;
      });
      files.push(file);
      bytesIn += statSync(file).size;
    }
    await (encoder as Page | null)?.close();

    await openApp(page);
    await gotoTool(page, 'images-to-pdf');
    const started = Date.now();
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Add images' }).click();
    await (await chooser).setFiles(files);
    await expect(page.getByText('20. phone-photo-20.jpg')).toBeVisible();
    const output = await commitAndRead(page, 'Export PDF');
    const elapsed = Date.now() - started;

    const doc = await PDFDocument.load(output);
    expect(doc.getPageCount()).toBe(20);
    doc.getPages().forEach((p, i) => {
      const { width, height } = p.getSize();
      // Stored 4032 × 3024; Orientation=6 means it is seen 3024 × 4032.
      if (rotated.has(i)) expect(height, `page ${i + 1} is portrait`).toBeGreaterThan(width);
      else expect(width, `page ${i + 1} is landscape`).toBeGreaterThan(height);
    });
    test.info().annotations.push({
      type: 'perf',
      description: `20 photos, ${mb(bytesIn)} in, ${mb(output.length)} PDF out`
    });
    expectWithinBudget('20 phone photos to PDF', elapsed, 10_000);
  });

  test('CNV-02: 300 DPI export of 20 pages stays under the memory ceiling, at exact DPI', async ({
    page
  }) => {
    // CNV-02's AC: "300 DPI export of a 20-page fixture completes without
    // exceeding the memory ceiling; output dimensions match the requested DPI
    // exactly." US Letter is exactly 8.5 × 11 in, so at 300 DPI every page must
    // come out exactly 2550 × 3300 px, with no rounding to argue about. PNG,
    // the larger of the two formats.
    test.setTimeout(180_000);
    const file = await ensureFixture('letter-20.pdf', () => letterPdf(20));
    const probe = await HeapProbe.attach(page);
    await openApp(page);
    await importFile(page, file);
    await gotoTool(page, 'pdf-to-img');
    await page.getByRole('radio', { name: 'PNG' }).check();
    await page.getByLabel('Resolution', { exact: true }).selectOption('300');

    const started = Date.now();
    const { result: zip, peak } = await probe.sampleWhile(() =>
      commitAndRead(page, 'Export images')
    );
    const elapsed = Date.now() - started;
    await probe.detach();

    const entries = Object.entries(unzipSync(zip)).sort(([a], [b]) => a.localeCompare(b));
    expect(entries).toHaveLength(20);
    for (const [name, png] of entries) {
      expect(pngSize(png), name).toEqual({ width: 2550, height: 3300 });
    }
    test.info().annotations.push({
      type: 'perf',
      description: `20 pages at 300 DPI PNG: ${mb(zip.length)} ZIP in ${Math.round(elapsed)} ms`
    });
    expectMemoryWithinCeilings('300 DPI export of 20 pages', peak);
  });

  test('F-05: Cancel takes effect within 200ms', async ({ page }) => {
    // F-05's AC: a job "cancels within 200ms of request". Measured on a real
    // job a user would cancel — a 20-page export at 300 DPI — at three points
    // into it. The click is made in the page and timed there until the job
    // has unwound (the action bar drops its Cancel button only when the job's
    // promise settles), so Playwright's round trips are not in the number.
    //
    // The points are progress, not wall-clock: Cancel is clicked, from inside
    // the page, on the first determinate progress at or past 1%, 35% and 70%.
    // Fixed delays made the test a race against the runner — a fast CI machine
    // finished the whole export before a 1.1 s click — and would have measured
    // a different point of the job on every machine anyway.
    test.setTimeout(180_000);
    const file = await ensureFixture('letter-20.pdf', () => letterPdf(20));
    await openApp(page);
    await importFile(page, file);
    await gotoTool(page, 'pdf-to-img');
    await page.getByRole('radio', { name: 'PNG' }).check();
    await page.getByLabel('Resolution', { exact: true }).selectOption('300');

    // The action bar's Cancel, not the review dialog's.
    const cancel = page.getByRole('main').getByRole('button', { name: 'Cancel', exact: true });
    const review = page.getByRole('dialog', { name: 'Review before saving' });
    const latencies: number[] = [];
    const cancelledAt: number[] = [];
    for (const threshold of [1, 35, 70]) {
      let downloaded = false;
      const onDownload = () => (downloaded = true);
      page.on('download', onDownload);
      await page.getByRole('button', { name: 'Export images' }).click();
      await expect(cancel).toBeVisible();
      const outcome = await cancel.evaluate(
        (button, threshold) =>
          new Promise<{ ms: number; percent: number } | null>(resolve => {
            const main = button.closest('main') ?? document.body;
            const percentNow = () => {
              const bar = main.querySelector('[role="progressbar"][aria-valuenow]');
              return bar ? Number(bar.getAttribute('aria-valuenow')) : null;
            };
            let fired = false;
            const check = () => {
              if (fired) return;
              // The job settled on its own before reaching the threshold.
              if (!button.isConnected) {
                watch.disconnect();
                resolve(null);
                return;
              }
              const percent = percentNow();
              if (percent === null || percent < threshold) return;
              fired = true;
              watch.disconnect();
              const t0 = performance.now();
              const settled = new MutationObserver(() => {
                if (!button.isConnected) {
                  settled.disconnect();
                  resolve({ ms: performance.now() - t0, percent });
                }
              });
              settled.observe(document.body, { childList: true, subtree: true });
              (button as HTMLButtonElement).click();
            };
            const watch = new MutationObserver(check);
            watch.observe(document.body, {
              childList: true,
              subtree: true,
              attributes: true,
              attributeFilter: ['aria-valuenow']
            });
            check();
          }),
        threshold
      );
      expect(outcome, `the export finished before reaching ${threshold}% progress`).not.toBeNull();
      const { ms, percent } = outcome as { ms: number; percent: number };
      // Mid-job, not already waiting on the save review.
      expect(percent, `cancelled at ${percent}%`).toBeLessThan(100);
      await expect(review, `the export reached the save review at ${percent}%`).toBeHidden();
      latencies.push(ms);
      cancelledAt.push(percent);
      // Cancelled means nothing is saved and nothing is left running: no
      // download arrives late, and the next export is accepted at once.
      await page.waitForTimeout(1_000);
      page.off('download', onDownload);
      expect(downloaded, `cancel at ${percent}% still saved a file`).toBe(false);
      await expect(page.getByRole('button', { name: 'Export images' })).toBeEnabled();
    }
    test.info().annotations.push({
      type: 'perf',
      description:
        `cancel latency at ${cancelledAt.map(p => `${p}%`).join('/')} progress: ` +
        `${latencies.map(Math.round).join(', ')} ms`
    });
    expectWithinBudget('Cancel to job settled', Math.max(...latencies), 200);
  });
  /**
   * Audit 2026-10-10 T12 — NFR-03 on a ~100 MB document, every P0 operation.
   *
   * The test above measures *opening* heavy documents. This runs merge,
   * rotate/delete + export, split and compress on a generated ~100 MB file
   * (`ensureLargePdf`: twenty distinct uncompressed 5 MB images, generated
   * into tests/fixtures/.generated/, never committed), sampling every realm's
   * heap throughout, and holds the whole run to the same ceilings.
   *
   * What this measures and what it cannot: `HeapProbe` reads each realm's V8
   * heap plus ArrayBuffer backing stores and Blink's heap over CDP. Canvas and
   * ImageBitmap *pixel* memory lives in Skia/GPU memory, which none of the
   * page-visible or CDP heap APIs report; `performance.measureUserAgentSpecificMemory`
   * would, but it needs cross-origin isolation (COOP/COEP), which neither
   * build sets (see worker-heap.ts). So a leak of decoded pixels shows up here
   * only through the objects that own them — which is what the heap-snapshot
   * test below counts.
   */
  test('NFR-03: every P0 operation on a ~100 MB document stays within memory limits', async ({
    page
  }) => {
    test.setTimeout(900_000);
    const [large, small] = await Promise.all([
      ensureLargePdf(),
      ensureFixture('text-4.pdf', () => textPdf(4))
    ]);
    const largeBytes = statSync(large).size;
    expect(largeBytes).toBeGreaterThan(95 * 1024 * 1024);

    const probe = await HeapProbe.attach(page);
    const peak = emptyPeak();
    const step = async <T>(label: string, operation: () => Promise<T>): Promise<T> => {
      const { result } = await probe.sampleWhile(operation, peak);
      test.info().annotations.push({
        type: 'memory',
        description: `${label}: peak so far — all realms incl. buffers ${mb(peak.total)}`
      });
      return result;
    };

    await openApp(page);
    await step('open', async () => {
      await importFile(page, large);
      await gotoTool(page, 'organize');
      await expect(page.getByRole('listbox', { name: /Pages of/ })).toBeVisible({
        timeout: 120_000
      });
    });

    // Merge: a second document appended, exported as one.
    await step('merge', async () => {
      await gotoTool(page, 'merge');
      const chooser = page.waitForEvent('filechooser');
      await page.getByRole('button', { name: 'Add PDFs or images' }).click();
      await (await chooser).setFiles(small);
      const grid = page.getByRole('listbox', { name: /Pages of/ });
      await expect(
        grid.getByRole('option', { name: new RegExp(`^Page 1 of ${LARGE_PDF_PAGES + 4}\\b`) })
      ).toHaveCount(1, {
        timeout: 120_000
      });
      const bytes = await commitAndRead(page, 'View changes');
      expect((await PDFDocument.load(bytes)).getPageCount()).toBe(LARGE_PDF_PAGES + 4);
    });

    // Rotate and delete, then export.
    await step('rotate/delete + export', async () => {
      await gotoTool(page, 'organize');
      const grid = page.getByRole('listbox', { name: /Pages of/ });
      await grid.getByRole('option', { name: /^Page 1 of/ }).focus();
      await page.keyboard.press('r');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Delete');
      await expect(
        grid.getByRole('option', { name: new RegExp(`^Page 1 of ${LARGE_PDF_PAGES + 3}\\b`) })
      ).toHaveCount(1);
      const bytes = await commitAndRead(page, 'View changes');
      const out = await PDFDocument.load(bytes);
      expect(out.getPageCount()).toBe(LARGE_PDF_PAGES + 3);
      expect(out.getPage(0).getRotation().angle).toBe(90);
    });

    // Split into parts of six.
    await step('split', async () => {
      await gotoTool(page, 'split');
      await page.getByRole('radio', { name: 'Split every N pages' }).check();
      await page.getByLabel('Pages per file').fill('6');
      const zip = unzipSync(await commitAndRead(page, 'Split / extract'));
      const counts = await Promise.all(
        Object.values(zip).map(async part => (await PDFDocument.load(part)).getPageCount())
      );
      expect(counts.reduce((a, b) => a + b, 0)).toBe(LARGE_PDF_PAGES + 3);
    });

    // Compress: every large image is over-sampled at the default 150 DPI.
    await step('compress', async () => {
      await gotoTool(page, 'compress');
      await page.getByRole('button', { name: /Analyse without changing/ }).click();
      // A one-line page may route either way (CMP-01); either is real work.
      await expect(
        page.getByText(/Images re-encoded, text kept|Re-rendered as images/i).first()
      ).toBeVisible({ timeout: 300_000 });
      const bytes = await commitAndRead(page, 'Compress & export');
      expect(bytes.byteLength).toBeLessThan(largeBytes);
    });
    await probe.detach();

    expectMemoryWithinCeilings('100 MB document, merge/rotate/delete/split/compress/export', peak);
  });

  /**
   * Audit 2026-10-10 T12 — after three large files are opened and closed, the
   * main realm retains no decoded pages: a V8 heap snapshot (CDP
   * `HeapProfiler.takeHeapSnapshot`, after a forced GC) is counted for
   * `ImageBitmap` and `OffscreenCanvas` objects, detached `<canvas>` elements,
   * and ArrayBuffer backing-store bytes.
   *
   * Self-checking: before the snapshot the page parks one known probe of each
   * (an 8 MB ArrayBuffer, a 1×1 ImageBitmap, a 1×1 OffscreenCanvas) on
   * `window`, and the counts must include them — so a snapshot format this
   * parser does not understand fails loudly instead of counting zero.
   *
   * Limitations, stated rather than hidden: this snapshots the main realm
   * only — worker heaps are covered by the probe's sampled peaks, not by a
   * snapshot — and a bitmap's pixels are Skia/GPU memory a heap snapshot does
   * not size; what it does see is every JS object that keeps them alive. The
   * thresholds are first estimates from the code (closing a document prunes
   * its render handle and invalidates its thumbnails, render-cache.ts), not
   * measurements: tune them on the first real run.
   */
  test('NFR-03: after three large files, the main heap retains no bitmaps, canvases or file buffers', async ({
    page
  }) => {
    test.setTimeout(600_000);
    const [large, heavy, long] = await Promise.all([
      ensureLargePdf(),
      ensureFixture('heavy.pdf', heavyPdf),
      ensureFixture('text-300.pdf', () => textPdf(300))
    ]);
    await openApp(page);

    for (const file of [large, heavy, long]) {
      const name = file.replace(/^.*[\\/]/, '');
      // Back to Home (in-app, no reload — the heap must keep its history) for its file input.
      await page.getByRole('link', { name: 'Stapler' }).click();
      await importFile(page, file);
      await gotoTool(page, 'organize');
      await page.waitForFunction(
        () => {
          const canvases = Array.from(document.querySelectorAll('[role="listbox"] canvas'));
          return canvases.length > 0 && canvases.every(c => (c as HTMLCanvasElement).width > 1);
        },
        undefined,
        { timeout: 120_000 }
      );
      await page.getByRole('button', { name: `Close ${name}` }).click();
      await expect(page.getByRole('button', { name: `Close ${name}` })).toHaveCount(0);
    }
    await page.getByRole('link', { name: 'Stapler' }).click();
    await expect(page.locator('header')).toBeVisible();

    const PROBE_BUFFER = 8 * 1024 * 1024;
    await page.evaluate(async size => {
      const w = window as unknown as Record<string, unknown>;
      w.__probeBuffer = new ArrayBuffer(size);
      w.__probeBitmap = await createImageBitmap(new ImageData(1, 1));
      w.__probeCanvas = new OffscreenCanvas(1, 1);
    }, PROBE_BUFFER);

    const cdp = await page.context().newCDPSession(page);
    const chunks: string[] = [];
    cdp.on('HeapProfiler.addHeapSnapshotChunk', ({ chunk }) => chunks.push(chunk));
    await cdp.send('HeapProfiler.enable');
    await cdp.send('HeapProfiler.collectGarbage');
    await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
    const counters = await cdp.send('Memory.getDOMCounters').catch(() => null);
    const uaMemory = await page.evaluate(async () => {
      const perf = performance as unknown as {
        measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>;
      };
      if (!globalThis.crossOriginIsolated || !perf.measureUserAgentSpecificMemory) {
        return 'unavailable (needs cross-origin isolation)';
      }
      return (await perf.measureUserAgentSpecificMemory()).bytes;
    });
    await cdp.detach();

    const snapshot = JSON.parse(chunks.join('')) as {
      snapshot: { meta: { node_fields: string[]; node_types: (string[] | string)[] } };
      nodes: number[];
      strings: string[];
    };
    const fields = snapshot.snapshot.meta.node_fields;
    const width = fields.length;
    const NAME = fields.indexOf('name');
    const SIZE = fields.indexOf('self_size');
    const DETACHED = fields.indexOf('detachedness');
    let bitmaps = 0;
    let offscreen = 0;
    let detachedCanvases = 0;
    let bufferBytes = 0;
    for (let i = 0; i < snapshot.nodes.length; i += width) {
      const name = snapshot.strings[snapshot.nodes[i + NAME]];
      if (name === 'ImageBitmap') bitmaps++;
      else if (name === 'OffscreenCanvas') offscreen++;
      else if (name === 'system / JSArrayBufferData') bufferBytes += snapshot.nodes[i + SIZE];
      else if (
        name.startsWith('Detached HTMLCanvasElement') ||
        (name === 'HTMLCanvasElement' && DETACHED >= 0 && snapshot.nodes[i + DETACHED] === 2)
      ) {
        detachedCanvases++;
      }
    }

    test.info().annotations.push({
      type: 'memory',
      description:
        `after three large files: ${bitmaps} ImageBitmap, ${offscreen} OffscreenCanvas, ` +
        `${detachedCanvases} detached canvases, ${mb(bufferBytes)} ArrayBuffer data ` +
        `(probes included); DOM counters ${JSON.stringify(counters)}; ` +
        `measureUserAgentSpecificMemory: ${String(uaMemory)}`
    });

    // The probes prove the parser sees each kind of object at all.
    expect(bitmaps, 'snapshot parser sees ImageBitmap').toBeGreaterThanOrEqual(1);
    expect(offscreen, 'snapshot parser sees OffscreenCanvas').toBeGreaterThanOrEqual(1);
    expect(bufferBytes, 'snapshot parser sizes ArrayBuffer data').toBeGreaterThanOrEqual(
      PROBE_BUFFER
    );

    // With every document closed, nothing decoded should be left behind.
    expect(bitmaps - 1, 'retained ImageBitmaps').toBeLessThanOrEqual(4);
    expect(offscreen - 1, 'retained OffscreenCanvases').toBeLessThanOrEqual(4);
    expect(detachedCanvases, 'detached <canvas> elements').toBeLessThanOrEqual(4);
    // Smaller than any one of the three files (heavy.pdf is ~5.4 MB), so a
    // retained copy of any of them fails.
    expect(bufferBytes - PROBE_BUFFER, 'retained ArrayBuffer bytes').toBeLessThan(5 * 1024 * 1024);
  });
});

declare global {
  interface Window {
    __maxFrameGap: number;
    __stopMonitor: boolean;
  }
}
