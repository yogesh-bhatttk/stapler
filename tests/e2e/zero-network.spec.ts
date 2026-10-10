import { expect, test, type Request } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { statSync } from 'node:fs';
import {
  contractV1Pdf,
  contractV2Pdf,
  ensureFixture,
  excelToPdfXlsx,
  pdfToExcelPdf,
  pdfToPptPdf,
  pdfToWordPdf,
  pptToPdfPptx,
  textPdf,
  wordToPdfDocx
} from './fixtures';
import { commitAndRead, dismissToasts, gotoTool, importFile, openApp } from './helpers';
import { drawnText } from './pdf-bytes';
import { openAppWithFakeFs, queuePick, writeFakeFiles } from './fake-fs';
import { QR_TEXT, qrPdf } from './audit-2026-10-10-helpers';
import { LANDING_PAGES } from '../../src/landing/pages';

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

/**
 * Audit 2026-10-10 T9(c) — CSP violations, recorded two ways, as the extension
 * fixtures do (`extension/extension-fixtures.ts`): the `securitypolicyviolation`
 * event (installed before any app script, in every document the page loads)
 * and Chromium's `Refused to …` console error. A request the meta CSP blocks
 * never reaches the request log at all, so without this a blocked attempt
 * would pass the request watch silently.
 */
function recordCspViolations() {
  const w = window as unknown as { __cspViolations: string[] };
  w.__cspViolations = [];
  document.addEventListener('securitypolicyviolation', event => {
    w.__cspViolations.push(`${event.violatedDirective} blocked ${event.blockedURI}`);
  });
}

const cspScriptInstalled = new WeakSet<import('@playwright/test').Page>();

async function withNetworkWatch(
  page: import('@playwright/test').Page,
  origin: string,
  body: () => Promise<void>
) {
  const offending: string[] = [];
  const cspConsole: string[] = [];
  const record = (request: Request) => {
    const url = request.url();
    if (!isLocal(url, origin)) offending.push(`${request.method()} ${url}`);
  };
  const consoleRecord = (message: import('@playwright/test').ConsoleMessage) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (/Content Security Policy|Refused to/i.test(text)) cspConsole.push(text);
  };
  if (!cspScriptInstalled.has(page)) {
    cspScriptInstalled.add(page);
    await page.addInitScript(recordCspViolations);
  }
  page.on('request', record);
  page.on('console', consoleRecord);
  let events: string[];
  try {
    await body();
  } finally {
    page.off('request', record);
    page.off('console', consoleRecord);
    events = await page
      .evaluate(() => (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? [])
      .catch(() => [] as string[]);
  }
  expect(
    offending,
    `Stapler must make no external request. Observed:\n${offending.join('\n')}`
  ).toEqual([]);
  expect([...cspConsole, ...events], 'CSP violations').toEqual([]);
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
        // CNV-10 / CNV-11. Same reasoning as the two above — the panel is the
        // cheap half, and each conversion has its own test below.
        'pdf-to-excel',
        'excel-to-pdf',
        // CNV-12. Same reasoning again — the panel is the cheap half, and the
        // conversion (which is the only thing that loads the `pptxgenjs` chunk)
        // has its own test below.
        'pdf-to-ppt',
        // CNV-13. Same reasoning once more — the panel is the cheap half, and
        // the conversion has its own test below. This one loads no third-party
        // chunk at all (its reader is hand-rolled over `fflate`), which is
        // exactly why watching it matters: there is no library to blame if a
        // request ever appears.
        'ppt-to-pdf',
        'table-extract',
        'acc',
        'contact-sheet',
        'shortcuts',
        // Audit 2026-10-10 T9(a) — these seven were missing from the sweep.
        'grayscale',
        'repair',
        'image-to-size',
        'read-aloud',
        'reflow',
        'history',
        'side-by-side'
      ]) {
        await page.goto(`/#/tool/${tool}`);
        await expect(page.locator('header')).toBeVisible();
      }

      // Rendering a page exercises pdf.js, which is the most likely component to reach
      // for a remote cmap or standard font.
      await page.goto('/#/tool/organize');
      await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30_000 });
      // Was a fixed 1.5 s sleep (audit PLT-18). pdf.js asks for cmaps and
      // standard fonts *before* it can paint text, so a painted thumbnail is
      // the condition that every such request has already been made.
      await page.waitForFunction(
        () => {
          const canvas = document.querySelector('canvas');
          return canvas instanceof HTMLCanvasElement && canvas.width > 1;
        },
        undefined,
        { timeout: 30_000 }
      );
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

  /**
   * CNV-11 — the same argument again, for the direction that reads a workbook.
   * A rendered panel loads none of `xlsx` (SheetJS CE, one large pure-JS
   * bundle); the lazy `await import('xlsx')` inside `convert/xlsx-reader.ts` is
   * what pulls the chunk in, and that only happens when a conversion actually
   * runs. This is also the ticket that promoted `xlsx` from a test-only
   * devDependency to a real runtime dependency, so it is the first time that
   * package's code is in the shipped build at all — which makes watching its
   * first load the assertion that matters most here.
   */
  test('makes no external request while actually converting an Excel file to PDF', async ({
    page,
    baseURL
  }) => {
    const origin = new URL(baseURL!).origin;
    const fixture = await ensureFixture('excel-to-pdf.xlsx', excelToPdfXlsx);

    // Every request, not only the offending ones: this test has to be able to
    // prove the lazily-imported code really was pulled in while the monitor was
    // attached. A test that silently stopped converting would otherwise pass by
    // observing nothing.
    const seen: string[] = [];
    page.on('request', request => seen.push(request.url()));

    await withNetworkWatch(page, origin, async () => {
      await openApp(page);
      // A hash change rather than `page.goto`, so nothing reloads mid-watch.
      await gotoTool(page, 'excel-to-pdf');

      const panel = page.getByRole('complementary', { name: /Excel to PDF options/ });
      await expect(panel).toBeVisible();

      const chooser = page.waitForEvent('filechooser');
      await panel.getByRole('button', { name: /Choose an \.xlsx file/ }).click();
      await (await chooser).setFiles(fixture);

      const beforeConversion = seen.length;

      // The conversion itself: convert worker (xlsx) → process worker (pdf-lib),
      // and the `xlsx` chunk's first and only load.
      await panel.getByRole('button', { name: 'Preview conversion' }).click();
      await expect(
        panel.getByRole('list', { name: /Sheets that will be drawn into the PDF/ })
      ).toBeVisible({ timeout: 90_000 });

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
   * CNV-12 — the sharpest case in the build for this argument, and the reason
   * this test is not optional.
   *
   * `pptxgenjs` carries a browser media path that resolves an image with
   * `new XMLHttpRequest()` — for any media relationship whose `data` is unset.
   * `pptx-writer.ts` therefore sets `data` on every `addImage` and never sets
   * `path`, and the library's own candidate filter (`!rel.data && …`) excludes
   * such a relationship before any branch is chosen. That argument is made in
   * full in `pptx-writer.ts`'s module comment; what it rests on is source
   * reading, so **this test is the only place the claim is measured in the
   * environment it is actually about**. The unit suite's throwing
   * `XMLHttpRequest` stub does not substitute for it: Vitest runs under Node,
   * where `pptxgenjs` takes its `process.versions?.node` branch and the browser
   * XHR call is never a candidate at all.
   *
   * So: a real browser, its own request log, a conversion that really does embed
   * images, and the lazy `await import('pptxgenjs')` loading inside the watched
   * window.
   */
  test('makes no external request while actually converting a PDF to PowerPoint', async ({
    page,
    baseURL
  }) => {
    const origin = new URL(baseURL!).origin;
    const fixture = await ensureFixture('pdf-to-ppt.pdf', pdfToPptPdf);

    // Every request, not only the offending ones: this test has to be able to
    // prove the lazily-imported code really was pulled in while the monitor was
    // attached. A test that silently stopped converting would otherwise pass by
    // observing nothing.
    const seen: string[] = [];
    page.on('request', request => seen.push(request.url()));

    await withNetworkWatch(page, origin, async () => {
      await openApp(page);
      await importFile(page, fixture);
      // A hash change rather than `page.goto`, so the imported document survives.
      await gotoTool(page, 'pdf-to-ppt');

      const panel = page.getByRole('complementary', { name: /PDF to PowerPoint options/ });
      await expect(panel).toBeVisible();

      // The `pptxgenjs` chunk is not loaded by rendering the panel — that is the
      // whole reason the tool sweep above is not sufficient cover for this tool.
      const beforeConversion = seen.length;

      // The conversion itself: render worker (pdf.js text layer) → process
      // worker (pdf-lib: image bytes, then image placements) → convert worker,
      // and the `pptxgenjs` chunk's first and only load.
      await panel.getByRole('button', { name: 'Preview conversion' }).click();
      await expect(panel.getByRole('list', { name: /Slides that will be written/ })).toBeVisible({
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
      const save = page.getByRole('button', { name: 'Save .pptx' });
      await expect(save).toBeEnabled();
      const download = page.waitForEvent('download', { timeout: 60_000 });
      await save.click();
      const saved = await download;
      expect(saved.suggestedFilename()).toMatch(/\.pptx$/);
    });
  });

  /**
   * CNV-13 — the opposite direction, and the one conversion in the six that
   * pulls in no third-party library at all: `pptx-reader.ts` is a hand-rolled
   * walk over `fflate`, which is already in the initial bundle. That makes the
   * argument *narrower*, not weaker — there is no lazy chunk whose contents
   * have to be taken on trust — but it still has to be watched, because the
   * `convert` and `process` workers both start here for the first time.
   */
  test('makes no external request while actually converting a PowerPoint file to PDF', async ({
    page,
    baseURL
  }) => {
    const origin = new URL(baseURL!).origin;
    const fixture = await ensureFixture('ppt-to-pdf.pptx', pptToPdfPptx);

    // Every request, not only the offending ones: this test has to be able to
    // prove the conversion really ran while the monitor was attached. A test
    // that silently stopped converting would otherwise pass by observing
    // nothing.
    const seen: string[] = [];
    page.on('request', request => seen.push(request.url()));

    await withNetworkWatch(page, origin, async () => {
      await openApp(page);
      // A hash change rather than `page.goto`, so nothing reloads mid-watch.
      await gotoTool(page, 'ppt-to-pdf');

      const panel = page.getByRole('complementary', { name: /PowerPoint to PDF options/ });
      await expect(panel).toBeVisible();

      const chooser = page.waitForEvent('filechooser');
      await panel.getByRole('button', { name: /Choose a \.pptx file/ }).click();
      await (await chooser).setFiles(fixture);

      const beforeConversion = seen.length;

      // The conversion itself: convert worker (the hand-rolled reader) →
      // process worker (pdf-lib), both starting for the first time here.
      await panel.getByRole('button', { name: 'Preview conversion' }).click();
      await expect(
        panel.getByRole('list', { name: /Slides that will be drawn into the PDF/ })
      ).toBeVisible({ timeout: 90_000 });

      const duringConversion = seen.slice(beforeConversion);
      expect(
        duringConversion.filter(url => /\/assets\/.*\.js(\?|$)/.test(url)),
        `The conversion must load its workers inside the watched window; saw:\n${duringConversion.join('\n')}`
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
   * Audit 2026-10-10 T9(e) — this used to be called "ships no reference to a
   * known remote host in the bundle", but it only ever read the `src`/`href`
   * attributes of the entry page's own `<script>`/`<link>` tags. That is what
   * the name now says; the bundle-content claim is the next test's.
   */
  test("the entry page's own script and stylesheet tags all point at its own origin", async ({
    page,
    baseURL
  }) => {
    const origin = new URL(baseURL!).origin;
    await page.goto('/');
    const scripts = await page.evaluate(() =>
      Array.from(document.querySelectorAll('script[src], link[href]')).map(
        element => element.getAttribute('src') ?? element.getAttribute('href') ?? ''
      )
    );
    expect(scripts.length).toBeGreaterThan(0);
    for (const reference of scripts) {
      expect(isLocal(new URL(reference, origin).href, origin), reference).toBe(true);
    }
  });

  /**
   * Audit 2026-10-10 T9(e) — what "ships no reference to a remote host" should
   * have meant: every script, stylesheet, page and JSON file the running app
   * actually fetches — the entry chunks, every lazily-loaded chunk a tool
   * pulls in, and the worker scripts — is scanned with the same inventory
   * `scripts/check-bundle-network.mjs` applies to `dist/` after a build:
   * every remote URL in it must be on that script's documented allowlist, and
   * no remote URL may reach a loading sink. This measures the files as served,
   * not as built, so a server-side rewrite or a chunk the build scan missed
   * would show here.
   */
  test('no script, stylesheet or page the app fetches names a remote host outside the bundle allowlist', async ({
    page,
    baseURL
  }) => {
    test.setTimeout(180_000);
    const origin = new URL(baseURL!).origin;
    const { scanText } = await import('../../scripts/check-bundle-network.mjs');
    const bodies = new Map<string, Promise<string | null>>();
    page.on('response', response => {
      const url = response.url();
      if (!url.startsWith(origin) || bodies.has(url)) return;
      const path = new URL(url).pathname;
      if (!/\.(?:m?js|css|html?|json|webmanifest)$/i.test(path) && path !== '/') return;
      bodies.set(
        url,
        response.text().catch(() => null)
      );
    });

    const fixture = await ensureFixture('text-10.pdf', () => textPdf(10));
    await openApp(page);
    await importFile(page, fixture);
    // Each tool lazily loads its own chunks; the conversions load the big
    // third-party bundles (docx, mammoth, xlsx, pptxgenjs) only when run, so
    // their previews are run too.
    for (const tool of ['compress', 'redact', 'ocr', 'compare', 'metadata', 'batch', 'md-to-pdf']) {
      await gotoTool(page, tool);
      await expect(page.locator('header')).toBeVisible();
    }
    await gotoTool(page, 'organize');
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30_000 });

    const scanned: string[] = [];
    const failures: string[] = [];
    for (const [url, body] of bodies) {
      const text = await body;
      if (text === null) continue;
      const rel = new URL(url).pathname.replace(/^\//, '') || 'index.html';
      scanned.push(rel);
      failures.push(
        ...scanText(text, rel.endsWith('/') || rel === '' ? 'index.html' : rel).failures
      );
    }
    // Non-vacuous: the entry chunk, worker scripts and pdf.js were all scanned.
    expect(scanned.some(rel => /\.m?js$/.test(rel))).toBe(true);
    expect(scanned.some(rel => /render\.worker/.test(rel))).toBe(true);
    expect(failures, failures.join('\n')).toEqual([]);
  });

  /**
   * Audit 2026-10-10 T9(d) — the website's landing pages and the privacy page
   * are entry points of their own (they are what a search result opens), each
   * with its own chunks; the sweep above only ever loaded the app shell.
   */
  test('every landing page and the privacy page load with no external request and no CSP violation', async ({
    browser,
    baseURL
  }) => {
    test.setTimeout(240_000);
    const origin = new URL(baseURL!).origin;
    const paths = [...LANDING_PAGES.map(({ slug }) => `/${slug}.html`), '/privacy.html'];
    expect(paths.length).toBeGreaterThan(10);
    for (const path of paths) {
      // A fresh context per page, as in the CSP-tag test below: nineteen app
      // boots in one tab exhaust a low-memory runner.
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await withNetworkWatch(page, origin, async () => {
          const response = await page.goto(path);
          expect(response?.status(), path).toBe(200);
          await page.waitForLoadState('load');
          await expect(page.locator('body')).not.toBeEmpty();
          // Whatever the page mounts (the landing pages embed the drop zone)
          // has had its frame to request anything it was going to.
          await page.evaluate(
            () =>
              new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
          );
        });
      } finally {
        await context.close();
      }
    }
  });

  /**
   * Audit 2026-09-25 PLT-4 — GitHub Pages cannot send a CSP header, so every
   * entry page of the website twin carries the policy as its first <head>
   * element (the `stapler:web-csp` Vite plugin). The request watch above is
   * the test; this is the runtime backstop on the deployed site.
   */
  test('every web entry page carries the default-deny CSP meta tag', async ({ browser }) => {
    const pages = [
      '/',
      '/editor.html',
      ...LANDING_PAGES.map(({ slug }) => `/${slug}.html`),
      '/privacy.html'
    ];
    // A fresh context per page, closed before the next one opens. Nineteen full
    // app boots in one tab (workers, pdf.js, the share inbox) piled up until
    // the renderer crashed on a low-memory machine; each page's tag is
    // independent, so nothing is lost by isolating them.
    for (const path of pages) {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await page.goto(path);
        const csp = await page
          .locator('meta[http-equiv="Content-Security-Policy"]')
          .getAttribute('content');
        expect(csp, path).toContain("default-src 'self'");
        expect(csp, path).toContain("object-src 'none'");
        expect(csp, path).not.toMatch(/connect-src[^;]*https:\/\/cdn\.jsdelivr\.net(\s|;)/);
      } finally {
        await context.close();
      }
    }
  });
});

/**
 * Audit 2026-10-10 T9(b) — the sweep above opens each panel; the code that
 * could reach the network runs when the operation does. These run the
 * operation itself, end to end, under the request and CSP watch, and each
 * asserts the operation's real output so a no-op click cannot pass by
 * observing nothing.
 */
test.describe('zero network — running the operations', () => {
  test('compress: a raster re-encode of a scan', async ({ page, baseURL }) => {
    test.setTimeout(180_000);
    const origin = new URL(baseURL!).origin;
    const scan = 'tests/fixtures/scanned_skewed.pdf';
    await withNetworkWatch(page, origin, async () => {
      await openApp(page);
      await importFile(page, scan);
      await gotoTool(page, 'compress');
      await page.getByRole('button', { name: /Analyse without changing/ }).click();
      await expect(page.getByText(/Re-rendered as images/i)).toBeVisible({ timeout: 90_000 });
      const bytes = await commitAndRead(page, 'Compress & export');
      expect(bytes.byteLength).toBeLessThan(statSync(scan).size);
    });
  });

  test('sign: a text stamp drawn into the page', async ({ page, baseURL }) => {
    const origin = new URL(baseURL!).origin;
    const file = await ensureFixture('text-6.pdf', () => textPdf(6));
    await withNetworkWatch(page, origin, async () => {
      await openApp(page);
      await importFile(page, file);
      await gotoTool(page, 'sign');
      await page.getByRole('button', { name: 'Text', exact: true }).click();
      await page.getByRole('group', { name: /Stamp placement area/ }).focus();
      await page.keyboard.press('Enter');
      await page.getByLabel('Stamp text').fill('Signed offline');
      const bytes = await commitAndRead(page, 'Export signed PDF');
      expect(await drawnText(bytes)).toContain('Signed offline');
    });
  });

  test('redact: a verified redaction', async ({ page, baseURL }) => {
    const origin = new URL(baseURL!).origin;
    const file = await ensureFixture('text-6.pdf', () => textPdf(6));
    await withNetworkWatch(page, origin, async () => {
      await openApp(page);
      await importFile(page, file);
      await gotoTool(page, 'redact');
      await page.getByLabel('Find and mark text').fill('Line 1 of body text on page 1.');
      await page.getByRole('button', { name: 'Mark every occurrence' }).click();
      await expect(page.getByText('Marks (1)')).toBeVisible();
      await page.getByRole('button', { name: 'Verify & apply' }).click();
      await expect(page.getByText('Redaction verified and applied')).toBeVisible({
        timeout: 60_000
      });
      await dismissToasts(page);
      await gotoTool(page, 'organize');
      const bytes = await commitAndRead(page, 'View changes');
      expect(await drawnText(bytes)).not.toContain('Line 1 of body text on page 1.');
    });
  });

  test('barcode scan: the bundled zxing engine decodes a QR code', async ({ page, baseURL }) => {
    test.setTimeout(120_000);
    const origin = new URL(baseURL!).origin;
    const file = await ensureFixture('audit-qr.pdf', qrPdf);
    // zxing-wasm defaults to fetching its engine from a CDN (barcode.ts);
    // the engine must come from this origin, and nothing else may be asked for.
    const seen: string[] = [];
    page.on('request', request => seen.push(request.url()));
    await withNetworkWatch(page, origin, async () => {
      await openApp(page);
      await importFile(page, file);
      await gotoTool(page, 'metadata');
      await page.getByRole('button', { name: 'Scan for barcodes' }).click();
      await expect(page.getByText(new RegExp(`Page 1 — .+: ${QR_TEXT}`))).toBeVisible({
        timeout: 90_000
      });
    });
    expect(seen.some(url => url.startsWith(origin) && /zxing_reader\.wasm/.test(url))).toBe(true);
  });

  test('markdown to PDF', async ({ page, baseURL }) => {
    const origin = new URL(baseURL!).origin;
    await withNetworkWatch(page, origin, async () => {
      await openApp(page);
      await gotoTool(page, 'md-to-pdf');
      await page
        .getByLabel('Markdown Content')
        .fill(
          '# Offline heading\n\nA paragraph with **bold** text and a [link](https://example.com).'
        );
      const bytes = await commitAndRead(page, 'Export PDF');
      expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThanOrEqual(1);
    });
  });

  test('cleanup: the B&W preset applied and exported', async ({ page, baseURL }) => {
    test.setTimeout(120_000);
    const origin = new URL(baseURL!).origin;
    const file = await ensureFixture('text-6.pdf', () => textPdf(6));
    await withNetworkWatch(page, origin, async () => {
      await openApp(page);
      await importFile(page, file);
      await gotoTool(page, 'cleanup');
      await page.getByRole('radio', { name: 'B&W document' }).check();
      await page.getByRole('button', { name: 'Apply to this page' }).click();
      await expect(page.getByText('Page cleaned.')).toBeVisible({ timeout: 60_000 });
      const bytes = await commitAndRead(page, 'Apply & export');
      expect((await PDFDocument.load(bytes)).getPageCount()).toBe(6);
    });
  });

  test('compare: a text diff of two documents, exported', async ({ page, baseURL }) => {
    test.setTimeout(120_000);
    const origin = new URL(baseURL!).origin;
    const v1 = await ensureFixture('contract-v1.pdf', contractV1Pdf);
    const v2 = await ensureFixture('contract-v2.pdf', contractV2Pdf);
    await withNetworkWatch(page, origin, async () => {
      await openApp(page);
      await importFile(page, v1);
      await gotoTool(page, 'compare');
      const chooser = page.waitForEvent('filechooser');
      await page.getByRole('button', { name: 'Open file to compare...' }).click();
      await (await chooser).setFiles(v2);
      await expect(page.locator('canvas').first()).toBeAttached({ timeout: 30_000 });
      await page.getByRole('radio', { name: 'Text Diff' }).check();
      const bytes = await commitAndRead(page, 'Export Diff PDF');
      expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThanOrEqual(1);
    });
  });

  test('batch: the default recipe over a folder', async ({ page, baseURL }) => {
    test.setTimeout(120_000);
    const origin = new URL(baseURL!).origin;
    const [two, three] = await Promise.all([
      ensureFixture('text-2.pdf', () => textPdf(2)),
      ensureFixture('text-3.pdf', () => textPdf(3))
    ]);
    await withNetworkWatch(page, origin, async () => {
      await openAppWithFakeFs(page);
      await writeFakeFiles(page, { 'in/two.pdf': two, 'in/three.pdf': three });
      await gotoTool(page, 'batch');
      await queuePick(page, 'in');
      await page.getByRole('button', { name: 'Select Input Folder' }).click();
      await queuePick(page, 'out');
      await page.getByRole('button', { name: 'Select Output Folder' }).click();
      await expect(page.getByRole('button', { name: 'Output: out/' })).toBeVisible();
      await page
        .getByLabel('Batch process options')
        .getByRole('button', { name: 'Run Batch' })
        .click();
      await expect(page.getByText('Batch Processing Complete').first()).toBeVisible({
        timeout: 90_000
      });
      await expect(page.getByText(/Successfully processed 2 files/)).toBeVisible();
    });
  });
});
