#!/usr/bin/env node
/**
 * DIST-01 — Chrome Web Store screenshots (1280x800), captured against the
 * real built app rather than mocked up separately, so what ships is what
 * reviewers and installers actually see.
 *
 * Requires the preview server already running at http://localhost:4173
 * (`npm run build:web && npx vite preview --port 4173 --strictPort`).
 */
import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'docs', 'screenshots');
mkdirSync(outDir, { recursive: true });

const BASE_URL = process.env.STAPLER_PREVIEW_URL ?? 'http://localhost:4173';

/** Opens the app fresh and clears the first-run welcome dialog, if shown. */
async function openApp(page) {
  await page.addInitScript(() => {
    delete window.showOpenFilePicker;
    delete window.showSaveFilePicker;
    delete window.showDirectoryPicker;
  });
  await page.goto(`${BASE_URL}/editor.html`);
  const dialog = page.getByRole('dialog', { name: 'Welcome to Stapler' });
  await dialog.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
  if (await dialog.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'Get started' }).click();
    await dialog.waitFor({ state: 'hidden' });
  }
}

async function importFixture(page, filePath) {
  await openApp(page);
  const bytes = readFileSync(filePath);
  await page.locator('input[type="file"]').setInputFiles({
    name: path.basename(filePath),
    mimeType: 'application/pdf',
    buffer: bytes
  });
  await page.getByRole('listbox', { name: /Pages of/ }).waitFor({ timeout: 30_000 });
}

/** Switches tool by hash, exactly like tests/e2e/helpers.ts's gotoTool. */
async function gotoTool(page, tool) {
  await page.evaluate(id => {
    window.location.hash = `#/tool/${id}`;
  }, tool);
  await page.waitForFunction(
    id => document.querySelector(`a[href="#/tool/${id}"]`)?.getAttribute('aria-current') === 'page',
    tool
  );
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.setViewportSize({ width: 1280, height: 800 });

  // 1. Scan cleanup before/after — the store listing's lead screenshot.
  const scanned = path.join(root, 'tests', 'fixtures', 'scanned_skewed.pdf');
  await importFixture(page, scanned);
  await gotoTool(page, 'cleanup');
  await page.getByRole('radio', { name: 'B&W document' }).check();
  // Waits for the live preview round-trip to actually land — the same
  // `previewReady` gate the Apply buttons wait on (SCN-03) — otherwise the
  // before/after view is captured empty.
  const applyButton = page.getByRole('button', { name: 'Apply to this page' });
  await applyButton.waitFor({ state: 'visible' });
  await page.waitForFunction(
    el => el instanceof HTMLButtonElement && !el.disabled,
    await applyButton.elementHandle(),
    { timeout: 15_000 }
  );
  await page.waitForTimeout(500);
  // The "could not detect edges confidently" toast is real, honest behaviour
  // on this synthetic fixture (SCN-01 already tests the fallback), but it is
  // not the point of this screenshot — dismiss it so the before/after view
  // itself is what is visually convincing, per this ticket's requirement.
  await page
    .getByRole('button', { name: 'Dismiss notification' })
    .click({ timeout: 3_000 })
    .catch(() => {});
  await page.screenshot({ path: path.join(outDir, '1-scan-cleanup.png') });

  // 2. Home launcher / tool grid.
  await openApp(page);
  await page.waitForSelector('text=Offline PDF tools');
  await page.screenshot({ path: path.join(outDir, '2-home.png') });

  // 3. Merge, with a second source added to actually show the combine/reorder UI.
  const textFixture = path.join(root, 'tests', 'fixtures', 'mixed-sizes.pdf');
  const cmykFixture = path.join(root, 'tests', 'fixtures', 'cmyk-text.pdf');
  await importFixture(page, textFixture);
  await gotoTool(page, 'merge');
  const addFilesPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Add PDFs or images' }).click();
  const chooser = await addFilesPromise;
  await chooser.setFiles(cmykFixture);
  await page.getByText('cmyk-text.pdf').waitFor({ timeout: 15_000 });
  await page.screenshot({ path: path.join(outDir, '3-merge.png') });

  // 4. Redact, with a marked region.
  await importFixture(page, textFixture);
  await gotoTool(page, 'redact');
  await page.getByLabel('Find and mark text').fill('Letter');
  await page.getByRole('button', { name: 'Mark every occurrence' }).click();
  await page.getByText('Marks (1)').waitFor({ timeout: 15_000 });
  await page.screenshot({ path: path.join(outDir, '4-redact.png') });

  // 5. The offline trust panel — the product's central claim, in the UI itself.
  await page.getByRole('button', { name: /Offline/i }).click();
  await page.screenshot({ path: path.join(outDir, '5-offline-trust.png') });

  await browser.close();
  console.log(`Wrote 5 screenshots to ${outDir}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
