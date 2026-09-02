import { expect, test, type Request } from '@playwright/test';
import { ensureFixture, pdfToExcelPdf, pdfToWordPdf, textPdf, wordToPdfDocx } from './fixtures';
import { gotoTool, importFile, openApp } from './helpers';

/**
 * QA-03 — the test that protects the entire product claim.
 *
 * Any request to a URL that is not same-origin, `blob:`, or `data:` fails the run. Add a
 * Google Fonts link, a CDN import, or an analytics snippet and this goes red.
 *
 * It runs against the *built* preview server rather than the dev server, because Vite's
 * dev client opens a websocket of its own and would make the assertion meaningless.
 */

/** Same-origin, blob:, and data: are local. Everything else is a violation. */
function isLocal(url: string, origin: string): boolean {
  if (url.startsWith('blob:') || url.startsWith('data:')) return true;
  if (url.startsWith('chrome-extension://')) return true;
  return url.startsWith(origin);
}

async function withNetworkWatch(
  page: import('@playwright/test').Page,
  origin: string,
  body: () => Promise<void>
) {
  const offending: string[] = [];
  const record = (request: Request) => {
    const url = request.url();
    if (!isLocal(url, origin)) offending.push(`${request.method()} ${url}`);
  };
  page.on('request', record);
  try {
    await body();
  } finally {
    page.off('request', record);
  }
  expect(
    offending,
    `Stapler must make no external request. Observed:\n${offending.join('\n')}`
  ).toEqual([]);
}

test.describe('zero network', () => {
  test('makes no external request while loading and using the app', async ({ page, baseURL }) => {
    const origin = new URL(baseURL!).origin;
    const fixture = await ensureFixture('text-10.pdf', () => textPdf(10));

    await withNetworkWatch(page, origin, async () => {
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'Offline PDF tools' })).toBeVisible();

      // First run shows the welcome dialog; dismiss it before touching anything else.
      const welcome = page.getByRole('dialog', { name: 'Welcome to Stapler' });
      if (await welcome.isVisible()) {
        await page.getByRole('button', { name: 'Get started' }).click();
      }

      // Import through the real file input, then visit every tool: each one lazily
      // touches different code, and any of them could smuggle in a fetch.
      await page.locator('input[type="file"]').setInputFiles(fixture);
      await expect(page.getByRole('listbox', { name: /Pages of/ })).toBeVisible({
        timeout: 30_000
      });

      for (const tool of [
        'merge',
        'organize',
        'split',
        'insert',
        'remove-blanks',
        'cleanup',
        'pdf-to-img',
        'images-to-pdf',
        'extract-img',
        'extract',
        'compress',
        'crop',
        'watermark',
        'outline',
        'sign',
        'redact',
        'metadata',
        'normalize',
        'nup',
        'compare',
        'annotate',
        'batch',
        'md-to-pdf',
        // OCR is the one route allowed to touch the network — on the model's
        // one-time download consent, and only after the user explicitly agrees.
        // Visiting the panel without agreeing must stay silent; this is the only
        // test that exercises the route at all, so its absence used to mean the
        // one deliberate exception to the zero-network guarantee was the one path
        // this suite never actually watched.
        'ocr',
        // CNV-08 / CNV-09. Visiting the panel is the cheap half of watching
        // these two tools; the half that matters is the conversion itself, which
        // is the only thing that loads the `docx` and `mammoth` chunks — see the
        // dedicated tests below.
        'pdf-to-word',
        'word-to-pdf',
        // CNV-10. Same reasoning as the two above — the panel is the cheap half,
        // and the conversion has its own test below.
        'pdf-to-excel',
        'table-extract',
        'acc',
        'contact-sheet',
        'shortcuts'
      ]) {
        await page.goto(`/#/tool/${tool}`);
        await expect(page.locator('header')).toBeVisible();
      }

      // Rendering a page exercises pdf.js, which is the most likely component to reach
      // for a remote cmap or standard font.
      await page.goto('/#/tool/organize');
      await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30_000 });
      await page.waitForTimeout(1500);
    });
  });

  /**
   * CNV-08 — the sweep above only *renders* each panel, and the comment on it
   * already says why that is not enough: the code that could reach the network
   * runs when the operation runs. This tool is the sharpest case of that in the
   * build, because a conversion is what triggers the lazy
   * `await import('docx')` inside `docx-writer.ts` — a chunk that carries jszip,
   * pako and buffer, none of which is loaded until this moment. Watching a
   * rendered panel would have watched none of it.
   *
   * So this runs the whole thing under the same monitor: import, convert, and
   * write the `.docx` out.
   */
  test('makes no external request while actually converting a PDF to Word', async ({
    page,
    baseURL
  }) => {
    const origin = new URL(baseURL!).origin;
    const fixture = await ensureFixture('pdf-to-word.pdf', pdfToWordPdf);

    // Every request, not only the offending ones: this test has to be able to
    // prove the lazily-imported code really was pulled in while the monitor was
    // attached. A test that silently stopped converting — a renamed button, a
    // click that no-ops — would otherwise still pass by observing nothing.
    const seen: string[] = [];
    page.on('request', request => seen.push(request.url()));

    await withNetworkWatch(page, origin, async () => {
      await openApp(page);
      await importFile(page, fixture);
      // A hash change rather than `page.goto`, so the imported document survives.
      await gotoTool(page, 'pdf-to-word');

      const panel = page.getByRole('complementary', { name: /PDF to Word options/ });
      await expect(panel).toBeVisible();

      // The `docx` chunk is not loaded by rendering the panel — that is the whole
      // reason the tool sweep above is not sufficient cover for this tool.
      const beforeConversion = seen.length;

      // The conversion itself: render worker → process worker → convert worker,
      // and the `docx` chunk's first and only load.
      await panel.getByRole('button', { name: 'Preview conversion' }).click();
      await expect(panel.getByRole('list', { name: /Blocks that will be written/ })).toBeVisible({
        timeout: 90_000
      });

      // Chunks really were fetched at conversion time, under the monitor. The
      // convert worker is the one module that only ever loads here, and the
      // `docx` bundle rides in behind it as `docx-writer.ts`'s dynamic import.
      const duringConversion = seen.slice(beforeConversion);
      expect(
        duringConversion.filter(url => /\/assets\/.*\.js(\?|$)/.test(url)),
        `The conversion must load its lazy chunks inside the watched window; saw:\n${duringConversion.join('\n')}`
      ).not.toEqual([]);
      expect(duringConversion.some(url => /convert\.worker/.test(url))).toBe(true);

      // And the save, because writing the file is a separate code path from
      // building it.
      const save = page.getByRole('button', { name: 'Save .docx' });
      await expect(save).toBeEnabled();
      const download = page.waitForEvent('download', { timeout: 60_000 });
      await save.click();
      const saved = await download;
      expect(saved.suggestedFilename()).toMatch(/\.docx$/);
    });
  });

  /**
   * CNV-09 — the same argument as the test above, for the opposite direction.
   * A rendered panel loads none of `mammoth` (jszip, @xmldom/xmldom, bluebird,
   * underscore, lop); the lazy `await import('mammoth')` inside
   * `convert/docx-reader.ts` is what pulls the chunk in, and that only happens
   * when a conversion actually runs. So the whole flow runs under the monitor:
   * pick the file, convert, and write the PDF out.
   */
  test('makes no external request while actually converting a Word file to PDF', async ({
    page,
    baseURL
  }) => {
    const origin = new URL(baseURL!).origin;
    const fixture = await ensureFixture('word-to-pdf.docx', wordToPdfDocx);

    // Every request, not only the offending ones: this test has to be able to
    // prove the lazily-imported code really was pulled in while the monitor was
    // attached. A test that silently stopped converting would otherwise pass by
    // observing nothing.
    const seen: string[] = [];
    page.on('request', request => seen.push(request.url()));

    await withNetworkWatch(page, origin, async () => {
      await openApp(page);
      // A hash change rather than `page.goto`, so nothing reloads mid-watch.
      await gotoTool(page, 'word-to-pdf');

      const panel = page.getByRole('complementary', { name: /Word to PDF options/ });
      await expect(panel).toBeVisible();

      const chooser = page.waitForEvent('filechooser');
      await panel.getByRole('button', { name: /Choose a \.docx file/ }).click();
      await (await chooser).setFiles(fixture);

      const beforeConversion = seen.length;

      // The conversion itself: convert worker (mammoth) → process worker
      // (pdf-lib), and the `mammoth` chunk's first and only load.
      await panel.getByRole('button', { name: 'Preview conversion' }).click();
      await expect(panel.getByRole('list', { name: /Blocks that will be written/ })).toBeVisible({
        timeout: 90_000
      });

      const duringConversion = seen.slice(beforeConversion);
      expect(
        duringConversion.filter(url => /\/assets\/.*\.js(\?|$)/.test(url)),
        `The conversion must load its lazy chunks inside the watched window; saw:\n${duringConversion.join('\n')}`
      ).not.toEqual([]);
      expect(duringConversion.some(url => /convert\.worker/.test(url))).toBe(true);

      // And the save, because writing the file is a separate code path from
      // building it.
      const save = page.getByRole('button', { name: 'Save PDF' });
      await expect(save).toBeEnabled();
      const download = page.waitForEvent('download', { timeout: 60_000 });
      await save.click();
      const saved = await download;
      expect(saved.suggestedFilename()).toMatch(/\.pdf$/);
    });
  });

  /**
   * CNV-10 — the tool sweep above only *renders* this panel, and the comment on
   * it already says why that is not enough: the code that could reach the
   * network runs when the operation runs. This conversion is the one that pulls
   * in the convert worker's chunk, and the one that touches pdf.js's text layer
   * across every page of a document.
   *
   * Its lazy-chunk story is milder than CNV-08's — the XLSX writer is
   * hand-rolled on `fflate`, so there is no `docx`- or `mammoth`-sized bundle
   * behind it — which is exactly why the assertion below is about *observed
   * requests*, not about a specific chunk: what matters is that the whole
   * conversion and save ran under the monitor and asked for nothing external.
   */
  test('makes no external request while actually converting a PDF to Excel', async ({
    page,
    baseURL
  }) => {
    const origin = new URL(baseURL!).origin;
    const fixture = await ensureFixture('pdf-to-excel.pdf', pdfToExcelPdf);

    // Every request, not only the offending ones: this test has to be able to
    // prove the conversion really ran while the monitor was attached. A test
    // that silently stopped converting — a renamed button, a click that no-ops —
    // would otherwise still pass by observing nothing.
    const seen: string[] = [];
    page.on('request', request => seen.push(request.url()));

    await withNetworkWatch(page, origin, async () => {
      await openApp(page);
      await importFile(page, fixture);
      // A hash change rather than `page.goto`, so the imported document survives.
      await gotoTool(page, 'pdf-to-excel');

      const panel = page.getByRole('complementary', { name: /PDF to Excel options/ });
      await expect(panel).toBeVisible();

      const beforeConversion = seen.length;

      // The conversion itself: render worker (pdf.js text layer, every page) →
      // convert worker (the workbook).
      await panel.getByRole('button', { name: 'Preview conversion' }).click();
      await expect(panel.getByRole('list', { name: /Sheets that will be written/ })).toBeVisible({
        timeout: 90_000
      });

      // The convert worker's own module only ever loads here, so seeing it
      // fetched inside the watched window is the proof that the conversion ran
      // rather than silently no-op'd.
      const duringConversion = seen.slice(beforeConversion);
      expect(
        duringConversion.some(url => /convert\.worker/.test(url)),
        `The conversion must load the convert worker inside the watched window; saw:\n${duringConversion.join('\n')}`
      ).toBe(true);

      // And the save, because writing the file is a separate code path from
      // building it.
      const save = page.getByRole('button', { name: 'Save .xlsx' });
      await expect(save).toBeEnabled();
      const download = page.waitForEvent('download', { timeout: 60_000 });
      await save.click();
      const saved = await download;
      expect(saved.suggestedFilename()).toMatch(/\.xlsx$/);
    });
  });

  test('ships no reference to a known remote host in the bundle', async ({ page, baseURL }) => {
    const origin = new URL(baseURL!).origin;
    await page.goto('/');
    const scripts = await page.evaluate(() =>
      Array.from(document.querySelectorAll('script[src], link[href]')).map(
        element => element.getAttribute('src') ?? element.getAttribute('href') ?? ''
      )
    );
    for (const reference of scripts) {
      expect(isLocal(new URL(reference, origin).href, origin)).toBe(true);
    }
  });
});
