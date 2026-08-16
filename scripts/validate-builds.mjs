#!/usr/bin/env node
/**
 * validate-builds.mjs
 *
 * Validates that both `dist/ext` (Chrome/Edge) and `dist/firefox` are
 * structurally correct after a build. Run after `pnpm build:ext` and
 * `pnpm build:ext:firefox`.
 *
 * Exit 0 = all checks pass. Exit 1 = at least one failure.
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { resolve, join } from 'path';

const ROOT = resolve(import.meta.dirname, '..');
const EXT_DIR = join(ROOT, 'dist', 'ext');
const FF_DIR = join(ROOT, 'dist', 'firefox');

let failures = 0;

function check(label, condition) {
  if (condition) {
    console.log(`  ✅ ${label}`);
  } else {
    console.log(`  ❌ ${label}`);
    failures++;
  }
}

function loadJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function hasEditorHtml(dir) {
  const files = existsSync(dir) ? readdirSync(dir) : [];
  return files.some(f => f === 'editor.html' || f.startsWith('editor-'));
}

// ── Chrome / Edge build ─────────────────────────────────────────────────────
console.log('\n🔍 Checking dist/ext (Chrome/Edge build)...');
check('dist/ext directory exists', existsSync(EXT_DIR));

const extManifest = loadJson(join(EXT_DIR, 'manifest.json'));
check('dist/ext/manifest.json parses as valid JSON', extManifest !== null);
check(
  'dist/ext manifest.version is a non-empty string',
  typeof extManifest?.version === 'string' && extManifest.version.length > 0
);
check('dist/ext manifest.manifest_version is 3 (MV3)', extManifest?.manifest_version === 3);
check('dist/ext/background.js exists', existsSync(join(EXT_DIR, 'background.js')));
check('dist/ext contains editor.html or editor-*.html', hasEditorHtml(EXT_DIR));
check(
  'dist/ext manifest has no unexpected host_permissions',
  !extManifest?.host_permissions || extManifest.host_permissions.length === 0
);

// ── Firefox build ────────────────────────────────────────────────────────────
console.log('\n🔍 Checking dist/firefox (Firefox build)...');
check('dist/firefox directory exists', existsSync(FF_DIR));

const ffManifest = loadJson(join(FF_DIR, 'manifest.json'));
check('dist/firefox/manifest.json parses as valid JSON', ffManifest !== null);
check(
  'dist/firefox manifest.version matches dist/ext manifest.version',
  ffManifest?.version === extManifest?.version
);
check(
  'dist/firefox manifest has browser_specific_settings.gecko.id',
  typeof ffManifest?.browser_specific_settings?.gecko?.id === 'string'
);
check('dist/firefox manifest.manifest_version is 3 (MV3)', ffManifest?.manifest_version === 3);
check(
  'dist/firefox manifest has background.scripts (Firefox MV3 shape)',
  Array.isArray(ffManifest?.background?.scripts)
);
check(
  'dist/firefox manifest does NOT have background.service_worker',
  !ffManifest?.background?.service_worker
);
check('dist/firefox contains editor.html or editor-*.html', hasEditorHtml(FF_DIR));

// ── Summary ──────────────────────────────────────────────────────────────────
console.log('');
if (failures === 0) {
  console.log('✅ All build validation checks passed.');
  process.exit(0);
} else {
  console.log(
    `❌ ${failures} check(s) failed. Run \`pnpm build:ext && pnpm build:ext:firefox\` first.`
  );
  process.exit(1);
}
