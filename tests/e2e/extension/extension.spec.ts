import { PDFDocument } from 'pdf-lib';
import { readFileSync } from 'node:fs';
import { ensureFixture, mixedSizePdf, mixedTextImagePdf, textPdf } from '../fixtures';
import { expect, expectClean, test } from './extension-fixtures';
import { confirmExportReviewIfShown, gotoTool } from '../helpers';

/**
 * Audit 2026-09-25 PLT-7 / M4 — smoke tests against the real, packaged MV3
 * extension (`dist/ext`, loaded with `--load-extension`), under its manifest
 * CSP, from its `chrome-extension://` origin, with no test hooks compiled in.
 *
 * Each test fails on any network request (all http(s)/ws(s) is routed and
 * aborted), any CSP violation, and any uncaught page error — the three ways a
 * change that passes against `vite preview` has broken the extension before.
 */

test('the service worker registers and the editor loads cleanly', async ({
  editor,
  diagnostics,
  extensionId
}) => {
  expect(extensionId).toMatch(/^[a-p]{32}$/);
  await expect(editor.getByRole('heading', { name: 'Offline PDF tools' })).toBeVisible();
  await expectClean(editor, diagnostics);
  // PLT-14: modulepreload is off for the extension, so it logs nothing either.
  expect(diagnostics.consoleErrors, 'console errors').toEqual([]);
});

test('the build ships the licence notices and no website-only files', async ({
  editor,
  extensionId
}) => {
  // PLT-12 / PLT-14, checked through the extension's own origin.
  const status = (file: string) =>
    editor.evaluate(async url => {
      try {
        return (await fetch(url)).status;
      } catch {
        return 0;
      }
    }, `chrome-extension://${extensionId}/${file}`);
  expect(await status('THIRD_PARTY_LICENSES.txt')).toBe(200);
  expect(await status('robots.txt')).not.toBe(200);
  expect(await status('sitemap.xml')).not.toBe(200);
});

test('a PNG imports as a one-page document', async ({ editor, diagnostics }) => {
  await editor.locator('input[type="file"]').setInputFiles('tests/fixtures/sample.png');
  const grid = editor.getByRole('listbox', { name: 'Pages of sample.pdf' });
  // Images go through the import-options dialog first (CNV-01).
  const options = editor.getByRole('dialog', { name: /Import \d+ image/ });
  await expect(options.or(grid)).toBeVisible({ timeout: 30_000 });
  if (await options.isVisible()) {
    await options.getByRole('button', { name: 'Import', exact: true }).click();
  }
  await expect(grid).toBeVisible({ timeout: 30_000 });
  await expect(grid.getByRole('option')).toHaveCount(1);
  // A painted thumbnail proves the render worker and pdf.js ran under the CSP.
  await editor.waitForFunction(
    () => {
      const canvas = document.querySelector('[role="listbox"] canvas');
      return canvas instanceof HTMLCanvasElement && canvas.width > 1;
    },
    undefined,
    { timeout: 30_000 }
  );
  await expectClean(editor, diagnostics);
});

test('merge two PDFs and export the result', async ({ editor, diagnostics }) => {
  const [a, b] = await Promise.all([
    ensureFixture('mixed-sizes.pdf', mixedSizePdf),
    ensureFixture('text-6.pdf', () => textPdf(6))
  ]);
  await gotoTool(editor, 'merge');
  await expect(editor.getByText('No document open')).toBeVisible();

  const chooser = editor.waitForEvent('filechooser');
  await editor.getByRole('button', { name: 'Add PDFs or images' }).click();
  await (await chooser).setFiles([a, b]);
  await expect(editor.getByRole('listbox', { name: /Pages of/ })).toBeVisible({ timeout: 30_000 });

  const download = editor.waitForEvent('download', { timeout: 60_000 });
  await editor.getByRole('button', { name: 'View changes' }).click();
  await confirmExportReviewIfShown(editor, download);
  const saved = await download;
  const location = await saved.path();
  const output = await PDFDocument.load(new Uint8Array(readFileSync(location)));
  expect(output.getPageCount()).toBe(3 + 6);
  await expectClean(editor, diagnostics);
});

test('face blur runs with the bundled detector and no network', async ({ editor, diagnostics }) => {
  test.setTimeout(120_000);
  const fixture = await ensureFixture('mixed-text-image-flate.pdf', () => mixedTextImagePdf());
  await editor.locator('input[type="file"]').setInputFiles(fixture);
  await expect(editor.getByRole('listbox', { name: /Pages of/ })).toBeVisible({ timeout: 30_000 });
  await gotoTool(editor, 'redact');

  await expect(editor.getByText(/face detector is built into Stapler/i)).toBeVisible();
  await expect(editor.getByRole('checkbox', { name: 'Blur faces' })).toBeEnabled();
  await editor.getByRole('button', { name: 'Find and blur' }).click();

  // The detector (TensorFlow.js + bundled weights) ran to a result under the
  // extension CSP — `'wasm-unsafe-eval'` only, no `'unsafe-eval'`.
  await expect(
    editor.getByText(/Nothing was blurred|face\(s\) and .* logo\(s\) blurred/i).first()
  ).toBeVisible({ timeout: 90_000 });
  await expect(editor.getByRole('dialog', { name: /Download/ })).toHaveCount(0);
  await expectClean(editor, diagnostics);
});

test('the omnibox keyword is wired and switches an open editor tab in place (GAP-7)', async ({
  context,
  editor,
  diagnostics
}) => {
  const [worker] = context.serviceWorkers();
  // The `pdf` keyword registered its listeners in the real service worker.
  expect(
    await worker.evaluate(
      () =>
        chrome.omnibox.onInputEntered.hasListeners() && chrome.omnibox.onInputChanged.hasListeners()
    )
  ).toBe(true);

  // The same message the omnibox path sends, from the real service worker to
  // the real editor tab: the tab answers and switches tool without reloading.
  await editor.evaluate(() => ((window as unknown as { __marker: number }).__marker = 1));
  // Target *this* editor tab by its URL: a fresh install also opens the
  // welcome tab (`#/welcome`), so "the first TAB context" can be the other one.
  const answered = await worker.evaluate(async editorUrl => {
    const tabs = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
    const tab = tabs.find(context => context.documentUrl === editorUrl);
    if (!tab) throw new Error(`editor tab not found among ${tabs.length} tabs`);
    return chrome.runtime.sendMessage({
      type: 'stapler:navigate',
      route: '/tool/compress',
      tabId: tab.tabId
    });
  }, editor.url());
  expect(answered).toBe(true);
  await expect(editor).toHaveURL(/#\/tool\/compress$/);
  expect(await editor.evaluate(() => (window as unknown as { __marker?: number }).__marker)).toBe(
    1
  );
  await expectClean(editor, diagnostics);
});
