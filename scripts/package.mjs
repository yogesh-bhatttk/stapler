#!/usr/bin/env node
/**
 * `pnpm package` — audit 2026-09-25 GAP-8 / PLT-17: release packaging was
 * entirely manual (a zip made by hand, sourcemaps included).
 *
 *   1. builds all three targets (Chrome/Edge extension, Firefox, website);
 *   2. runs `validate-builds.mjs` and re-checks the zero-permission and
 *      version invariants on the *built* manifests;
 *   3. zips `dist/ext`, `dist/firefox` and `dist/web` (the static website,
 *      ready to unpack onto any static host that serves files unmodified — the
 *      service worker hash-checks every file, see RELEASE_CHECKLIST.md), leaving
 *      out every `*.map`, with
 *      fixed timestamps so the same tree always produces the same bytes;
 *   4. writes a `<zip>.sha256` next to each zip (audit 2026-10-01 DIST-07 —
 *      `sha256sum --check <zip>.sha256` verifies one download on its own) and
 *      `dist/release/SHA256SUMS` covering all of them;
 *   5. writes `dist/release/BUILD_INFO.txt` — the Node and pnpm versions,
 *      platform and commit that produced the zips (audit 2026-10-10).
 *
 * It refuses to zip a build containing the e2e test hook, and holds both
 * extension manifests to `manifest-invariants.mjs`.
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
import { manifestFindings } from './manifest-invariants.mjs';

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
  // Audit 2026-10-10: the shared check, which also rejects
  // optional_host_permissions, web_accessible_resources, externally_connectable
  // and a missing or loosened CSP.
  const problems = manifestFindings(manifest, `${label}/manifest.json`);
  if (problems.length) fail(problems.join('\n  '));
  if (!existsSync(join(dir, 'THIRD_PARTY_LICENSES.txt'))) {
    fail(`${label}: THIRD_PARTY_LICENSES.txt is missing`);
  }
  // GAP-2: the offline service worker and web app manifest are the website's.
  for (const webOnly of ['sw.js', 'manifest.webmanifest']) {
    if (existsSync(join(dir, webOnly))) fail(`${label}: ships the website's ${webOnly}`);
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

// The e2e build's service-worker opt-in key (src/ui/pwa.ts) is compiled out
// of a build without VITE_E2E_TEST_HOOKS. Checked here rather than only in
// release.yml (audit 2026-10-10), so `--skip-build` cannot zip an instrumented
// dist/ left behind by an e2e run.
const E2E_HOOK = Buffer.from('stapler:e2e-service-worker');
for (const dir of ['ext', 'firefox', 'web']) {
  for (const file of listFiles(join(DIST, dir))) {
    if (file.endsWith('.map')) continue;
    if (readFileSync(join(DIST, dir, file)).includes(E2E_HOOK)) {
      fail(
        `dist/${dir}/${file} contains the e2e test hook (${E2E_HOOK}) — this is an ` +
          'instrumented build; rebuild without --skip-build'
      );
    }
  }
}

console.log('\n▶ validate builds');
try {
  execFileSync(process.execPath, [join(ROOT, 'scripts/validate-builds.mjs')], { stdio: 'inherit' });
} catch {
  fail('validate-builds.mjs failed (see the ❌ lines above)');
}
checkManifest(join(DIST, 'ext'), 'dist/ext');
checkManifest(join(DIST, 'firefox'), 'dist/firefox');
if (existsSync(join(DIST, 'web', 'manifest.json'))) {
  fail('dist/web ships the extension manifest.json (PLT-14)');
}
if (!existsSync(join(DIST, 'web', 'THIRD_PARTY_LICENSES.txt'))) {
  fail('dist/web: THIRD_PARTY_LICENSES.txt is missing');
}
for (const webOnly of ['sw.js', 'manifest.webmanifest']) {
  if (!existsSync(join(DIST, 'web', webOnly))) fail(`dist/web: ${webOnly} is missing (GAP-2)`);
}
// Audit 2026-10-01 PLT-1: the website's entry scripts are content-hashed, so a
// deploy can never pair new HTML with an old cached `editor.js`.
for (const file of readdirSync(join(DIST, 'web'))) {
  if (!file.endsWith('.html')) continue;
  const stem = file === 'index.html' ? 'editor' : file.slice(0, -'.html'.length);
  if (existsSync(join(DIST, 'web', `${stem}.js`))) {
    fail(`dist/web: entry script ${stem}.js is not content-hashed (PLT-1)`);
  }
}

console.log('\n▶ zip');
rmSync(RELEASE, { recursive: true, force: true });
mkdirSync(RELEASE, { recursive: true });
const zips = [
  zipDir(join(DIST, 'ext'), `stapler-${version}-chrome.zip`),
  zipDir(join(DIST, 'firefox'), `stapler-${version}-firefox.zip`),
  zipDir(join(DIST, 'web'), `stapler-${version}-web.zip`)
];

/** `sha256sum` format: `<hex>  <name>`, so `sha256sum --check` reads it. */
const sumLine = file =>
  `${createHash('sha256').update(readFileSync(file)).digest('hex')}  ${relative(RELEASE, file)}`;

/** Best effort: the tool's own answer, or `unknown` — never a reason to fail. */
function toolVersion(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    return 'unknown';
  }
}

// Audit 2026-10-10: the environment that produced these zips, so a reviewer
// rebuilding from source (docs/AMO_SOURCE_BUILD.md) can use the same Node and
// pnpm. Written beside the zips, not into them: the zips' contents stay
// exactly what the build emitted.
const pnpmFromAgent = /\bpnpm\/(\S+)/.exec(process.env.npm_config_user_agent ?? '')?.[1];
const buildInfo = [
  `Stapler ${version}`,
  `node ${process.version}`,
  `pnpm ${pnpmFromAgent ?? toolVersion('pnpm', ['--version'])}`,
  `platform ${process.platform}-${process.arch}`,
  `commit ${process.env.GITHUB_SHA ?? toolVersion('git', ['rev-parse', 'HEAD'])}`
].join('\n');
writeFileSync(join(RELEASE, 'BUILD_INFO.txt'), `${buildInfo}\n`);

const lines = zips.map(sumLine);
zips.forEach((file, i) => writeFileSync(`${file}.sha256`, `${lines[i]}\n`));
const sums = lines.join('\n');
writeFileSync(join(RELEASE, 'SHA256SUMS'), `${sums}\n`);
console.log(
  `\n▶ dist/release/SHA256SUMS (+ one .sha256 per zip)\n${sums}\n\n▶ dist/release/BUILD_INFO.txt\n${buildInfo}\n\n✓ packaged Stapler ${version}`
);
