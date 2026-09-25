/**
 * Audit 2026-09-25 PLT-12 — both builds ship code from dozens of npm packages
 * (pdf.js, tesseract and TensorFlow.js under Apache-2.0, among others) and
 * shipped none of their license texts or NOTICE files, which the MIT, BSD and
 * Apache licences all require of a redistribution.
 *
 * This walks the *production* dependency tree (`dependencies` and installed
 * `optionalDependencies`, transitively, from `package.json`) with Node's own
 * resolution rules, so it works with pnpm's nested layout and follows the tree
 * as packages are added or replaced — no hand-kept list, and no new
 * dependency. Over-inclusion (a dependency tree-shaken out of the bundle) is
 * harmless in a notice file; omission is not.
 *
 * For each package it records name, version, declared licence, and the text
 * of every root-level LICENSE / LICENCE / COPYING / NOTICE file, plus the
 * extra licence files for binaries the build copies out of a package
 * (`EXTRA_LICENSE_FILES`). Code another project vendored *inside* a package's
 * own bundle, which carries no licence file of its own, is listed from
 * `EMBEDDED_COMPONENTS`, only when that package is actually in the tree.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Licence-bearing file names at a package root. */
const LICENSE_FILE = /^(licen[cs]e|copying|notice|copyright)([._-].*)?$/i;

/**
 * Licence files for binaries `vite.config.ts` copies out of a package that sit
 * outside the package root (directory relative to the package, and a name
 * pattern).
 */
const EXTRA_LICENSE_FILES = {
  // openjpeg.wasm, jbig2.wasm and qcms_bg.wasm are shipped in `pdfjs/wasm/`.
  'pdfjs-dist': [{ dir: 'wasm', pattern: /^LICENSE_/ }]
};

/** Third-party code bundled inside another package's dist with no licence file of its own. */
const EMBEDDED_COMPONENTS = {
  '@vladmandic/face-api': [
    'TensorFlow.js (tfjs-core, tfjs-backend-cpu, tfjs-backend-webgl), bundled into ' +
      'dist/face-api.esm.js. Apache License 2.0. Copyright Google LLC. ' +
      'https://github.com/tensorflow/tfjs'
  ],
  'tesseract.js-core': [
    'Tesseract OCR, compiled to WebAssembly. Apache License 2.0. ' +
      'https://github.com/tesseract-ocr/tesseract',
    'Leptonica, compiled into the same WebAssembly module. BSD 2-Clause. ' +
      'Copyright Dan Bloomberg and contributors. http://www.leptonica.org'
  ],
  heic2any: [
    'libheif and libde265, compiled into dist/heic2any.js. GNU Lesser General ' +
      'Public License v3.0. https://github.com/strukturag/libheif ' +
      'https://github.com/strukturag/libde265. Under the LGPL you may replace ' +
      'this library: rebuild Stapler from source with a modified copy.'
  ],
  'zxing-wasm': [
    'zxing-cpp, compiled to WebAssembly. Apache License 2.0. ' +
      'https://github.com/zxing-cpp/zxing-cpp'
  ]
};

/** Directory of `name`'s package.json as Node would resolve it from `fromDir`, or null. */
function findPackageDir(name, fromDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** `license` in any of the historical shapes npm has accepted. */
function licenseOf(pkg) {
  if (typeof pkg.license === 'string') return pkg.license;
  if (pkg.license && typeof pkg.license.type === 'string') return pkg.license.type;
  if (Array.isArray(pkg.licenses)) {
    return pkg.licenses.map(l => (typeof l === 'string' ? l : l.type)).join(' OR ');
  }
  return 'UNKNOWN';
}

function repositoryOf(pkg) {
  const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  return repo ?? pkg.homepage ?? '';
}

function licenseFilesIn(dir, pattern) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(file => pattern.test(file) && statSync(join(dir, file)).isFile())
    .sort()
    .map(file => ({ file, text: readFileSync(join(dir, file), 'utf8').trim() }));
}

/**
 * @param {string} root  Project root (the directory holding package.json).
 * @returns {Array<{ name: string, version: string, license: string, repository: string,
 *   files: Array<{ file: string, text: string }>, embedded: string[] }>}
 */
export function collectThirdPartyLicenses(root) {
  const rootPkg = readJson(resolve(root, 'package.json'));
  /** @type {Map<string, ReturnType<typeof collectThirdPartyLicenses>[number]>} */
  const found = new Map();
  const queue = [
    ...Object.keys(rootPkg.dependencies ?? {}).map(name => ({ name, from: root, optional: false })),
    ...Object.keys(rootPkg.optionalDependencies ?? {}).map(name => ({
      name,
      from: root,
      optional: true
    }))
  ];

  while (queue.length > 0) {
    const { name, from, optional } = /** @type {(typeof queue)[number]} */ (queue.shift());
    const dir = findPackageDir(name, from);
    if (!dir) {
      if (optional) continue;
      throw new Error(`third-party-licenses: ${name} (needed from ${from}) is not installed`);
    }
    const pkg = readJson(join(dir, 'package.json'));
    const key = `${pkg.name}@${pkg.version}`;
    if (found.has(key)) continue;

    const files = licenseFilesIn(dir, LICENSE_FILE);
    for (const extra of EXTRA_LICENSE_FILES[pkg.name] ?? []) {
      for (const f of licenseFilesIn(join(dir, extra.dir), extra.pattern)) {
        files.push({ file: `${extra.dir}/${f.file}`, text: f.text });
      }
    }
    found.set(key, {
      name: pkg.name,
      version: pkg.version,
      license: licenseOf(pkg),
      repository: repositoryOf(pkg),
      files,
      embedded: EMBEDDED_COMPONENTS[pkg.name] ?? []
    });

    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      queue.push({ name: dep, from: dir, optional: false });
    }
    for (const dep of Object.keys(pkg.optionalDependencies ?? {})) {
      queue.push({ name: dep, from: dir, optional: true });
    }
  }

  return [...found.values()].sort((a, b) =>
    a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name)
  );
}

/** @param {ReturnType<typeof collectThirdPartyLicenses>} entries @param {string} product */
export function renderThirdPartyLicenses(entries, product) {
  const rule = '='.repeat(78);
  const out = [
    `${product} — third-party software notices`,
    '',
    `${product} includes the open-source packages below. Each is listed with its`,
    'declared licence and the licence and NOTICE files it ships, reproduced as the',
    'licences require. Generated at build time from the production dependency tree.',
    '',
    `Packages: ${entries.length}`,
    ''
  ];
  for (const entry of entries) {
    out.push(rule, `${entry.name}@${entry.version}`, `License: ${entry.license}`);
    if (entry.repository) out.push(`Source: ${entry.repository}`);
    for (const note of entry.embedded) out.push(`Includes: ${note}`);
    if (entry.files.length === 0) {
      out.push(
        '',
        `(No licence file ships in this package; its declared licence is ${entry.license}.)`
      );
    }
    for (const file of entry.files) {
      out.push('', `--- ${file.file} ---`, '', file.text);
    }
    out.push('');
  }
  return `${out.join('\n')}\n`;
}
