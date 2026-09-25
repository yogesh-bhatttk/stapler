#!/usr/bin/env node
/**
 * Post-build zero-network scan of the shipped bundle — audit 2026-09-25 PLT-6.
 *
 *   node scripts/check-bundle-network.mjs [dir …]     (default: dist/ext dist/web)
 *
 * The source guards (`scripts/check-invariants.mjs`, the PostToolUse hook) see
 * only Stapler's own code. This scans what actually ships — every JS/MJS,
 * CSS, HTML and JSON file in the build, third-party code included — two ways:
 *
 *  1. Sinks (AST, `scripts/network-guard.mjs` in 'bundle' mode): a remote URL
 *     that reaches something that loads it — `import()`, `new Worker()`, an
 *     assignment to `.src`/`.href`, `setAttribute`, `open()`, CSS `url()` /
 *     `@import`, an HTML resource attribute. Any hit fails, unless listed in
 *     SINK_ALLOWLIST (currently empty: nothing in the bundle needs it).
 *  2. Inventory (text): every absolute http(s)/ws(s)/ftp URL anywhere in those
 *     files, comments and strings alike, must match an entry in URL_ALLOWLIST
 *     below, each of which says why that URL is inert. A new dependency that
 *     talks to a new host — or a new hard-coded URL of ours — fails the build
 *     until someone looks at it and documents it here.
 *
 * Library references to `fetch`/`XMLHttpRequest` themselves are *not* flagged
 * here: pdf.js, tesseract.js and tfjs carry network code paths Stapler never
 * takes (URL loading, CDN defaults it overrides). Those are held off at run
 * time by the CSP (`scripts/csp.mjs`) and exercised by the extension e2e
 * project, which fails on any request.
 *
 * Source maps are skipped: they are not executed (and `pnpm package` leaves
 * them out of the store zip).
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { analyzeNetwork } from './network-guard.mjs';
import { OCR_MODEL_CONNECT_SOURCES } from './csp.mjs';

const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Remote URLs allowed to appear in the bundle, and why each is inert.
 * `pattern` is matched against the whole URL as found in the file (template
 * placeholders included); `file`, when given, limits the entry to matching paths.
 */
export const URL_ALLOWLIST = [
  {
    pattern: new RegExp(`^(?:${OCR_MODEL_CONNECT_SOURCES.map(escape).join('|')})`),
    reason:
      'The pinned OCR model directories (OCR-01) — the one sanctioned download, requested only ' +
      'by src/core/ocr/download.ts after explicit consent, SHA-256 verified. Appears in the CSP ' +
      '(manifest.json and the web build <meta>).'
  },
  {
    pattern: /^https:\/\/\$\{\w+\}\/npm\/\$\{\w+\}\/\$\{\w+\}@\$\{\w+\}\/\$\{\w+\}$/,
    reason:
      "The same pinned OCR model URL as built by src/core/ocr/model.ts's `resolveModelUrl` " +
      '(`https://${MODEL_HOST}/npm/${DATA_PACKAGE}/${lang}@${version}/${dataVersion}`), after ' +
      'minification. Fetched only by download.ts; tests/unit/csp.test.ts proves every URL it ' +
      'can build lies inside the CSP connect-src prefixes.'
  },
  {
    pattern: /^http:\/\/\$\{\w+\}$/,
    file: /(?:^|\/)(?:pdf\.worker|render\.worker)-[\w-]+\.m?js$/,
    reason:
      "pdf.js `createValidAbsoluteUrl(…, { addDefaultProtocol })`: turns a link annotation's " +
      '`www.example.org` text into `http://www.example.org` so the viewer can show it as a link. ' +
      'A string handed back to the caller (Stapler never follows it), not a request.'
  },
  {
    pattern: /^https:\/\/cdn\.jsdelivr\.net\/npm\/@tesseract\.js-data\/$/,
    reason:
      "tesseract.js worker's default `langPath`. Never used: ocr.worker.ts always passes " +
      'NO_NETWORK_LANG_PATH (audit CNV-2), and the model bytes come from the pinned cache.'
  },
  {
    pattern: /^https:\/\/cdn\.jsdelivr\.net\/npm\/tesseract\.js(?:-core)?@v/,
    reason:
      'tesseract.js default `workerPath` / `corePath`. Never used: ocr.worker.ts passes the ' +
      'bundled WORKER_PATH / CORE_PATH, so the CDN default is dead code.'
  },
  {
    pattern: /^https:\/\/fastly\.jsdelivr\.net\/npm\/zxing-wasm@/,
    reason:
      "zxing-wasm's default `locateFile`. Never used: src/core/barcode.ts calls " +
      'prepareZXingModule with a locateFile override pointing at the bundled .wasm.'
  },
  {
    pattern: /^https:\/\/stapler\.app\//,
    reason: 'Our own landing pages: `<link rel="canonical">` SEO metadata, never fetched.'
  },
  {
    pattern:
      /^https?:\/\/(?:schemas\.openxmlformats\.org|sheetjs\.openxmlformats\.org|schemas\.microsoft\.com|purl\.org|purl\.oclc\.org|ns\.adobe\.com|www\.xfa\.org|www\.aiim\.org|schemas\.zwobble\.org|www\.w3\.org)\//,
    reason:
      'XML namespace / relationship-type / schema identifiers (OOXML in docx, xlsx, pptxgenjs, ' +
      'mammoth, SheetJS; XMP and XFA in pdf.js and pdf-lib; SVG/XHTML/MathML/XLink in the DOM ' +
      'code). They name a vocabulary and are compared as strings; nothing dereferences them.'
  },
  {
    pattern: /^https?:\/\/(?:example\.com|foo\.bar)(?:\/|$)/,
    reason:
      'Dummy base URLs pdf.js passes to `new URL(x, base)` to test whether a link target is a ' +
      'valid relative URL. Parsed, never requested.'
  },
  {
    pattern: /^http:\/\/localhost:3000\//,
    reason:
      'tesseract.js embeds its own package.json; this is its `wait-on` dev script — inert data.'
  },
  {
    pattern:
      /^https?:\/\/(?:(?:www\.)?github\.com|raw\.github\.com|stuk\.github\.io|gitbrent\.github\.io|opencollective\.com|feross\.org|mths\.be|stuartk\.com|sheetjs\.com|www\.apache\.org|rolldown\.rs|goo\.gl|answers\.microsoft\.com|developer\.mozilla\.org|emscripten\.org|arxiv\.org|www\.shadertoy\.com)(?:\/|$)/,
    reason:
      'Documentation, issue-tracker and licence links inside third-party banners, comments and ' +
      'error-message strings (JSZip, pako, ieee754, SheetJS, pdf.js, tfjs/face-api, bluebird, ' +
      "docx, PptxGenJS, emscripten, rolldown), plus package.json metadata and Stapler's own " +
      'repository link (an `<a href>` the user may click). Text, not requests.'
  }
];

/**
 * Remote URLs allowed in a *sink* position (see header). Each entry:
 * `{ file: RegExp, message: RegExp, reason }`. Empty — keep it that way.
 */
export const SINK_ALLOWLIST = [];

// Template placeholders are kept (`https://${host}/npm/…`) so an entry can
// match a templated URL by its shape.
const URL_RE = /\b(?:https?|wss?|ftp):\/\/(?:\$\{[^}\n]{0,80}\}|[^\s"'`<>()\\,;{}[\]|^])+/gi;
const SCANNED = /\.(?:m?js|css|html?|json)$/i;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

export function scanBundle(dirs, { root = process.cwd() } = {}) {
  const failures = [];
  const used = new Set();
  let files = 0;
  let urls = 0;
  for (const dir of dirs) {
    for (const file of walk(dir)) {
      if (!SCANNED.test(file) || file.endsWith('.map')) continue;
      files++;
      const rel = path.relative(root, file).split(path.sep).join('/');
      const text = readFileSync(file, 'utf8');

      if (!rel.endsWith('.json')) {
        for (const f of analyzeNetwork(text, rel, { mode: 'bundle' })) {
          const allowed = SINK_ALLOWLIST.find(e => e.file.test(rel) && e.message.test(f.message));
          if (!allowed) failures.push(`${rel}:${f.line} — ${f.message}`);
        }
      }

      for (const m of text.matchAll(URL_RE)) {
        urls++;
        const url = m[0].replace(/[.:]+$/, '');
        const i = URL_ALLOWLIST.findIndex(
          e => e.pattern.test(url) && (!e.file || e.file.test(rel))
        );
        if (i === -1) {
          const line = text.slice(0, m.index).split('\n').length;
          failures.push(`${rel}:${line} — remote URL not in the bundle allowlist: ${url}`);
        } else used.add(i);
      }
    }
  }
  const unused = URL_ALLOWLIST.filter((_, i) => !used.has(i));
  return { failures, unused, files, urls };
}

const isMain =
  !!process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const args = process.argv.slice(2);
  const explicit = args.length > 0;
  const dirs = (explicit ? args : ['dist/ext', 'dist/web']).filter(d => {
    if (existsSync(d)) return true;
    if (explicit) {
      console.error(`❌ ${d} does not exist — build it first.`);
      process.exit(1);
    }
    return false;
  });
  if (dirs.length === 0) {
    console.error('❌ No build to scan: run `pnpm build` (dist/ext and/or dist/web) first.');
    process.exit(1);
  }
  const started = performance.now();
  const { failures, unused, files, urls } = scanBundle(dirs);
  const took = ((performance.now() - started) / 1000).toFixed(1);
  if (unused.length && dirs.length === 2) {
    for (const e of unused)
      console.warn(`⚠️  bundle allowlist entry matched nothing (stale?): ${e.pattern}`);
  }
  if (failures.length) {
    console.error(`❌ Bundle network scan failed with ${failures.length} findings:\n`);
    for (const f of failures) console.error(`  • ${f}`);
    console.error(
      '\nA remote URL in a sink breaks the zero-network guarantee. An inert one (namespace, ' +
        'licence or docs link) goes in URL_ALLOWLIST in scripts/check-bundle-network.mjs with a reason.'
    );
    process.exit(1);
  }
  console.log(
    `✅ Bundle network scan passed — ${files} files in ${dirs.join(', ')}, ${urls} remote URLs, ` +
      `all allowlisted, no remote URL in a sink (${took}s).`
  );
}
