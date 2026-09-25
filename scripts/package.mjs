#!/usr/bin/env node
/**
 * `pnpm package` — audit 2026-09-25 GAP-8 / PLT-17: release packaging was
 * entirely manual (a zip made by hand, sourcemaps included).
 *
 *   1. builds all three targets (Chrome/Edge extension, Firefox, website);
 *   2. runs `validate-builds.mjs` and re-checks the zero-permission and
 *      version invariants on the *built* manifests;
 *   3. zips `dist/ext` and `dist/firefox`, leaving out every `*.map`, with
 *      fixed timestamps so the same tree always produces the same bytes;
 *   4. writes `dist/release/SHA256SUMS` for the zips.
 *
 * Node built-ins plus `fflate` (already a dependency) only.
 *
 * Usage: node scripts/package.mjs [--skip-build]
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { zipSync } from 'fflate';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist');
const RELEASE = join(DIST, 'release');
const skipBuild = process.argv.includes('--skip-build');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;

/** Zip entries are stamped with this, not the build time, so zips are reproducible. */
const FIXED_MTIME = new Date('2000-01-01T00:00:00Z');

function fail(message) {
  console.error(`\n✗ package: ${message}`);
  process.exit(1);
}

function build(target) {
  console.log(`\n▶ vite build (BUILD_TARGET=${target})`);
  execFileSync(join(ROOT, 'node_modules/.bin/vite'), ['build'], {
    cwd: ROOT,
    env: { ...process.env, BUILD_TARGET: target, VITE_E2E_TEST_HOOKS: '' },
    stdio: 'inherit'
  });
}

/** Every file under `dir`, as sorted POSIX paths relative to it. */
function listFiles(dir) {
  const out = [];
  const walk = current => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(dir, full).split(sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

function checkManifest(dir, label) {
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) fail(`${label}: no manifest.json in ${dir}`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.version !== version) {
    fail(`${label}: manifest version ${manifest.version} ≠ package.json ${version}`);
  }
  for (const key of ['permissions', 'optional_permissions', 'host_permissions']) {
    if ((manifest[key] ?? []).length > 0) fail(`${label}: manifest.${key} is not empty`);
  }
  if (manifest.content_scripts) fail(`${label}: manifest declares content_scripts`);
  if (!existsSync(join(dir, 'THIRD_PARTY_LICENSES.txt'))) {
    fail(`${label}: THIRD_PARTY_LICENSES.txt is missing`);
  }
}

function zipDir(dir, zipName) {
  const files = listFiles(dir).filter(file => !file.endsWith('.map'));
  /** @type {Record<string, [Uint8Array, { mtime: Date }]>} */
  const entries = {};
  for (const file of files) entries[file] = [readFileSync(join(dir, file)), { mtime: FIXED_MTIME }];
  const bytes = zipSync(entries, { level: 9 });
  const out = join(RELEASE, zipName);
  writeFileSync(out, bytes);
  console.log(`  ${zipName}: ${files.length} files, ${(bytes.length / 1024 / 1024).toFixed(2)} MB`);
  return out;
}

if (!skipBuild) {
  build('ext');
  build('firefox');
  build('web');
}

for (const dir of ['ext', 'firefox', 'web']) {
  if (!existsSync(join(DIST, dir))) fail(`dist/${dir} does not exist (drop --skip-build?)`);
}

console.log('\n▶ validate builds');
execFileSync(process.execPath, [join(ROOT, 'scripts/validate-builds.mjs')], { stdio: 'inherit' });
checkManifest(join(DIST, 'ext'), 'dist/ext');
checkManifest(join(DIST, 'firefox'), 'dist/firefox');
if (existsSync(join(DIST, 'web', 'manifest.json'))) {
  fail('dist/web ships the extension manifest.json (PLT-14)');
}
if (!existsSync(join(DIST, 'web', 'THIRD_PARTY_LICENSES.txt'))) {
  fail('dist/web: THIRD_PARTY_LICENSES.txt is missing');
}

console.log('\n▶ zip');
rmSync(RELEASE, { recursive: true, force: true });
mkdirSync(RELEASE, { recursive: true });
const zips = [
  zipDir(join(DIST, 'ext'), `stapler-${version}-chrome.zip`),
  zipDir(join(DIST, 'firefox'), `stapler-${version}-firefox.zip`)
];

const sums = zips
  .map(
    file =>
      `${createHash('sha256').update(readFileSync(file)).digest('hex')}  ${relative(RELEASE, file)}`
  )
  .join('\n');
writeFileSync(join(RELEASE, 'SHA256SUMS'), `${sums}\n`);
console.log(`\n▶ dist/release/SHA256SUMS\n${sums}\n\n✓ packaged Stapler ${version}`);
