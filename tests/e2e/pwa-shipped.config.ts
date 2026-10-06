import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Audit 2026-10-01 PLT-7 — the website suites that matter most, run against
 * the *shipped* web bytes: the unzipped `stapler-<version>-web.zip` from
 * `pnpm package`, served as it is, with no e2e test hooks
 * (`VITE_E2E_TEST_HOOKS`) and no rebuild. The service worker registers on
 * every page load, as it does on the real site.
 *
 *   STAPLER_SHIPPED_WEB=shipped/web pnpm exec playwright test -c tests/e2e/pwa-shipped.config.ts
 *
 * The main `playwright.config.ts` (a hooks build on port 4173) stays the
 * home of every other web e2e test; this config only *selects* specs that do
 * not need the hooks. `STAPLER_SHIPPED_PORT` moves it off its default port.
 */
const shipped = process.env.STAPLER_SHIPPED_WEB;
if (!shipped) {
  throw new Error('Set STAPLER_SHIPPED_WEB to the unzipped stapler-<version>-web.zip directory.');
}
const dir = resolve(shipped);
if (!existsSync(resolve(dir, 'index.html')) || !existsSync(resolve(dir, 'sw.js'))) {
  throw new Error(`${dir} is not an unpacked web build (no index.html or sw.js).`);
}
const port = Number(process.env.STAPLER_SHIPPED_PORT ?? 4810);
// Lets `pwa-shipped-network.spec.ts` see the service worker's own requests
// (the precache download) in the context's request events. Read by the
// browser the test workers launch, which inherit this environment.
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS ??= '1';

export default defineConfig({
  testDir: '.',
  testMatch: [
    'zero-network.spec.ts',
    'pwa-offline.spec.ts',
    'pwa-share-consent.spec.ts',
    'pwa-shipped-network.spec.ts'
  ],
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  failOnFlakyTests: !!process.env.CI,
  workers: 1,
  // Paths from the working directory (the repo root in CI), not this folder.
  outputDir: resolve('test-results/shipped-web'),
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never', outputFolder: resolve('playwright-report') }]]
    : 'list',
  timeout: 60_000,
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://localhost:${port}`,
    trace: 'on-first-retry',
    video: 'off'
  },
  projects: [{ name: 'shipped-web' }],
  webServer: {
    // `vite preview` only serves the directory (with the `/merge-pdf` →
    // `merge-pdf.html` fallback GitHub Pages also has); nothing is built.
    command: `pnpm exec vite preview --outDir ${JSON.stringify(dir)} --port ${port} --strictPort`,
    env: { BUILD_TARGET: 'web' },
    port,
    reuseExistingServer: false,
    timeout: 60_000
  }
});
