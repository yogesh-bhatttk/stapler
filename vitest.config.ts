import { defineConfig } from 'vitest/config';

/**
 * Vitest owns `tests/unit`; Playwright owns `tests/e2e`.
 *
 * They were mixed before: `pnpm test` ran vitest over the whole `tests` directory,
 * picked up a Playwright spec, and failed with "test.describe() called here" — so the
 * unit-test command had never passed.
 */
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['tests/unit/setup.ts'],
    restoreMocks: true
  }
});
