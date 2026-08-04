import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright owns `tests/e2e`; vitest owns `tests/unit`.
 *
 * They shared `./tests` before, so `pnpm test` fed a Playwright spec to vitest and the
 * unit-test command failed outright.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // Serial: the perf assertions measure wall-clock, and parallel workers skew them.
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
    video: 'off'
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // Preview the *built* site, not the dev server: the dev server injects its own
    // websocket client, so a zero-network assertion against it would be meaningless.
    command: 'npm run build:web && npx vite preview --port 4173 --strictPort',
    port: 4173,
    reuseExistingServer: false,
    timeout: 180_000
  }
});
