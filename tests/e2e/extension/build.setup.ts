import { test as setup, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { EXTENSION_DIR } from './extension-fixtures';

/**
 * Audit 2026-09-25 PLT-7 / M4 — the `extension` project tests the real
 * packaged extension, so it needs a real `BUILD_TARGET=ext` build: no
 * `VITE_E2E_TEST_HOOKS`, no `vite preview`, the MV3 CSP from the manifest.
 *
 * CI builds `dist/ext` in its own step (so the artifact under test is the one
 * the job built) and sets `STAPLER_EXT_PREBUILT=1`; locally this builds it.
 */
setup('build the unpacked extension', async () => {
  setup.setTimeout(300_000);
  if (process.env.STAPLER_EXT_PREBUILT !== '1') {
    const vite = path.resolve(process.cwd(), 'node_modules/.bin/vite');
    execFileSync(vite, ['build'], {
      env: { ...process.env, BUILD_TARGET: 'ext', VITE_E2E_TEST_HOOKS: '' },
      stdio: 'inherit'
    });
  }
  expect(existsSync(path.join(EXTENSION_DIR, 'manifest.json'))).toBe(true);
  expect(existsSync(path.join(EXTENSION_DIR, 'background.js'))).toBe(true);
});
