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
 *
 * The build narrows the list to what it actually shipped (R-BUILD-1):
 * `vite.config.ts` records every package a bundled module came from — the
 * pages and each worker build — plus the packages whose files it copies
 * verbatim, and passes that set as `shipped`. The notices then cover those
 * packages and everything they reach through their regular `dependencies`
 * (a package consumed as a prebuilt bundle, like jszip's `dist/jszip.min.js`,
 * carries its dependencies inside it, where no module id shows them). What is
 * left out is what only a Node-only *optional* dependency pulls in — pdf.js's
 * `@napi-rs/canvas` and its platform binaries — or what no shipped package
 * depends on at all.
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
  'pdfjs-dist': [{ dir: 'wasm', pattern: /^LICENSE_/ }],
  // Audit 2026-10-10: the image worker bundles `libheif-wasm/libheif.{js,wasm}`.
  // That directory's LICENSE carries the full LGPL-3.0 *and* the GPL-3.0 it
  // builds on, which LGPL-3.0 §4(b) requires to accompany the combined work
  // (the package-root LICENSE is the LGPL text alone).
  'libheif-js': [{ dir: 'libheif-wasm', pattern: /^LICENSE$/ }]
};

/**
 * Audit 2026-10-10 — LGPL-3.0 §4 notices for code Stapler links that users
 * have the right to replace. Printed under the package's entry.
 */
const LGPL_NOTICES = {
  'libheif-js': [
    'libheif-js is an Emscripten (WebAssembly) build of libheif and libde265, both',
    'licensed under the GNU Lesser General Public License v3.0. Stapler uses it',
    'only to decode HEIC images, in its image worker.',
    '',
    'Corresponding source:',
    '  libheif-js  https://github.com/catdad-experiments/libheif-js',
    '  libheif     https://github.com/strukturag/libheif',
    '  libde265    https://github.com/strukturag/libde265',
    '  Stapler     https://github.com/yogesh-bhatttk/stapler (MIT)',
    '',
    'Under the LGPL you may replace this library with a modified version. Build',
    'Stapler from source (see the README) with your copy of libheif-js in place of',
    'the one pinned in pnpm-lock.yaml (for example with a pnpm override or by',
    'replacing node_modules/libheif-js before `pnpm build`), and the resulting',
    'extension or website uses your library. The text of the LGPL-3.0 and of the',
    'GPL-3.0 it refers to is reproduced below.'
  ]
};

/**
 * Audit 2026-10-10 — third-party assets vendored into this repository (not
 * npm packages, so the dependency walk never sees them) and shipped in every
 * build. `files` are repo-relative and reproduced in full. An entry is listed
 * whenever its `asset` exists under the root (a synthetic test root has none),
 * and a present asset whose licence file is missing fails the build.
 */
export const VENDORED_ASSETS = [
  {
    name: 'Noto Sans Devanagari (font)',
    license: 'OFL-1.1',
    repository: 'https://github.com/notofonts/devanagari',
    asset: 'src/core/ocr/assets/NotoSansDevanagari.ttf',
    use: 'src/core/ocr/assets/NotoSansDevanagari.ttf — embedded in OCR text layers for Hindi.',
    files: ['src/core/ocr/assets/NotoSansDevanagari-OFL.txt']
  },
  {
    name: 'Liberation Sans Regular (font)',
    license: 'OFL-1.1',
    repository: 'https://github.com/liberationfonts/liberation-fonts',
    asset: 'src/core/pdf/assets/LiberationSans-Regular.ttf',
    use: 'src/core/pdf/assets/LiberationSans-Regular.ttf — embedded by the process worker.',
    files: ['src/core/pdf/assets/LICENSE_LIBERATION']
  }
];

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
  'libheif-js': [
    'libheif and libde265, compiled to WebAssembly (libheif-wasm/). GNU Lesser ' +
      'General Public License v3.0. https://github.com/strukturag/libheif ' +
      'https://github.com/strukturag/libde265'
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
 * @param {{ shipped?: (name: string) => boolean }} [options]  When given, keep only
 *   the packages `shipped` accepts and their regular-dependency closure.
 * @returns {Array<{ name: string, version: string, license: string, repository: string,
 *   files: Array<{ file: string, text: string }>, embedded: string[], notice: string[] }>}
 *   Packages first (sorted), then `VENDORED_ASSETS` (version `''`), which every
 *   build ships whatever `shipped` says.
 */
export function collectThirdPartyLicenses(root, options = {}) {
  const rootPkg = readJson(resolve(root, 'package.json'));
  /** @type {Map<string, ReturnType<typeof collectThirdPartyLicenses>[number]>} */
  const found = new Map();
  /** `name@version` → the `name@version` keys of its regular (non-optional) dependencies. */
  const edges = new Map();
  /** @type {Array<{ name: string, from: string, optional: boolean, parent?: string }>} */
  const queue = [
    ...Object.keys(rootPkg.dependencies ?? {}).map(name => ({ name, from: root, optional: false })),
    ...Object.keys(rootPkg.optionalDependencies ?? {}).map(name => ({
      name,
      from: root,
      optional: true
    }))
  ];

  while (queue.length > 0) {
    const { name, from, optional, parent } = /** @type {(typeof queue)[number]} */ (queue.shift());
    const dir = findPackageDir(name, from);
    if (!dir) {
      if (optional) continue;
      throw new Error(`third-party-licenses: ${name} (needed from ${from}) is not installed`);
    }
    const pkg = readJson(join(dir, 'package.json'));
    const key = `${pkg.name}@${pkg.version}`;
    if (parent && !optional) edges.get(parent)?.add(key);
    if (found.has(key)) continue;
    edges.set(key, new Set());

    const files = licenseFilesIn(dir, LICENSE_FILE);
    for (const extra of EXTRA_LICENSE_FILES[pkg.name] ?? []) {
      for (const f of licenseFilesIn(join(dir, extra.dir), extra.pattern)) {
        files.push({ file: `${extra.dir}/${f.file}`, text: f.text });
      }
    }
    const entry = {
      name: pkg.name,
      version: pkg.version,
      license: licenseOf(pkg),
      repository: repositoryOf(pkg),
      files,
      embedded: EMBEDDED_COMPONENTS[pkg.name] ?? [],
      notice: LGPL_NOTICES[pkg.name] ?? []
    };
    found.set(key, entry);

    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      queue.push({ name: dep, from: dir, optional: false, parent: key });
    }
    for (const dep of Object.keys(pkg.optionalDependencies ?? {})) {
      queue.push({ name: dep, from: dir, optional: true, parent: key });
    }
  }

  let kept = [...found.entries()];
  if (options.shipped) {
    const reach = new Set();
    const stack = kept.filter(([, e]) => options.shipped?.(e.name)).map(([key]) => key);
    while (stack.length > 0) {
      const key = /** @type {string} */ (stack.pop());
      if (reach.has(key)) continue;
      reach.add(key);
      for (const dep of edges.get(key) ?? []) stack.push(dep);
    }
    kept = kept.filter(([key]) => reach.has(key));
  }
  const vendored = VENDORED_ASSETS.filter(asset => existsSync(resolve(root, asset.asset))).map(
    asset => ({
      name: asset.name,
      version: '',
      license: asset.license,
      repository: asset.repository,
      files: asset.files.map(file => {
        if (!existsSync(resolve(root, file)))
          throw new Error(`third-party-licenses: ${asset.asset} ships without its licence ${file}`);
        return { file, text: readFileSync(resolve(root, file), 'utf8').trim() };
      }),
      embedded: [asset.use],
      notice: []
    })
  );
  return [
    ...kept
      .map(([, entry]) => entry)
      .sort((a, b) =>
        a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name)
      ),
    ...vendored
  ];
}

/** @param {ReturnType<typeof collectThirdPartyLicenses>} entries @param {string} product */
export function renderThirdPartyLicenses(entries, product) {
  const rule = '='.repeat(78);
  const out = [
    `${product} — third-party software notices`,
    '',
    `${product} includes the open-source packages and vendored assets below. Each is`,
    'listed with its declared licence and the licence and NOTICE files it ships,',
    'reproduced as the licences require. Generated at build time from the packages the',
    'build bundled or copied, followed by the fonts kept in the repository itself.',
    '',
    `Packages: ${entries.length}`,
    ''
  ];
  for (const entry of entries) {
    out.push(
      rule,
      entry.version ? `${entry.name}@${entry.version}` : entry.name,
      `License: ${entry.license}`
    );
    if (entry.repository) out.push(`Source: ${entry.repository}`);
    for (const note of entry.embedded) out.push(`Includes: ${note}`);
    if (entry.notice?.length) out.push('', ...entry.notice);
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

/**
 * The npm package a bundled module id belongs to (`…/node_modules/@scope/name/x.js`
 * → `@scope/name`), or null for project source and virtual modules. Works with
 * pnpm's `.pnpm/<pkg>@<v>/node_modules/<pkg>` layout: the *last* `node_modules`
 * segment names the package.
 */
export function packageOfModuleId(id) {
  const clean = id.replace(/^\0/, '').split('?')[0].replace(/\\/g, '/');
  const at = clean.lastIndexOf('/node_modules/');
  if (at < 0) return null;
  const parts = clean.slice(at + '/node_modules/'.length).split('/');
  if (parts[0] === '' || parts[0] === '.pnpm') return null;
  return parts[0].startsWith('@') ? (parts[1] ? `${parts[0]}/${parts[1]}` : null) : parts[0];
}
