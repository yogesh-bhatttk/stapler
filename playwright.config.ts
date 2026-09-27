import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright owns `tests/e2e`; vitest owns `tests/unit`.
 *
 * They shared `./tests` before, so `pnpm test` fed a Playwright spec to vitest and the
 * unit-test command failed outright.
 *
 * Projects (audit 2026-09-25 PLT-7, PLT-18):
 *
 * - `chromium` — the functional suite, against a `vite preview` of the web build.
 * - `perf` — PLAN §5.1's wall-clock budgets (`perf.spec.ts`). Never retried: a
 *   retry that turns a slow run green hides the regression the budget exists for.
 *   Run on its own with `pnpm test:perf`.
 * - `extension` — smoke tests against the real packaged extension (`dist/ext`,
 *   built by the `extension-build` setup project unless `STAPLER_EXT_PREBUILT=1`),
 *   loaded into Chromium with `--load-extension`, under its MV3 CSP.
 *
 * Functional tests get one retry in CI, and `failOnFlakyTests` makes a test that
 * only passed on that retry fail the run: a flake is reported, not absorbed.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  failOnFlakyTests: !!process.env.CI,
  // Serial: the perf assertions measure wall-clock, and parallel workers skew them.
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
    video: 'off'
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: ['**/extension/**', '**/perf.spec.ts']
    },
    {
      name: 'perf',
      use: { ...devices['Desktop Chrome'] },
      testMatch: '**/perf.spec.ts',
      retries: 0
    },
    {
      name: 'extension-build',
      testMatch: '**/extension/build.setup.ts',
      retries: 0
    },
    {
      name: 'extension',
      testMatch: '**/extension/*.spec.ts',
      dependencies: ['extension-build'],
      // The fixture launches its own persistent context with the extension
      // loaded; `trace` needs a browser-level context Playwright created.
      use: { trace: 'off' }
    }
  ],
  webServer: {
    // Preview the *built* site, not the dev server: the dev server injects its own
    // websocket client, so a zero-network assertion against it would be meaningless.
    command:
      'BUILD_TARGET=web VITE_E2E_TEST_HOOKS=true pnpm exec vite build && pnpm exec vite preview --port 4173 --strictPort',
    port: 4173,
    reuseExistingServer: false,
    timeout: 180_000
  }
});
