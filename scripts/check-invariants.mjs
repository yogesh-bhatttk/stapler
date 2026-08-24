#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

// Kept in sync with .claude/hooks/check-invariants.mjs — this is the same guard
// run as a one-shot, whole-repo scan (see item §9 of docs/AUDIT-FINDINGS.md: the
// PostToolUse hook only fires on Write/Edit and only looks at src/, so a file
// written by shell command, or a file outside src/ like public/privacy.html,
// needs this script wired into `pnpm check` to be covered at all).
// OCR-01 Defect 4: this script previously had no network-scanning logic at
// all — only the PostToolUse hook (`.claude/hooks/check-invariants.mjs`) did,
// and that hook exempts `src/core/ocr/` and `src/core/faceblur/` *wholesale*,
// so a `fetch()` added anywhere in either directory (not just the one
// legitimate model-download module) would never be caught by either guard.
// These constants and the loop below are kept in sync with that hook's
// versions, but narrower: the exemption only covers the one file in each
// directory that is actually allowed to name the host or call a network API.
const NETWORK_APIS = [
  [/\bfetch\s*\(/, 'fetch() — no runtime network requests are permitted'],
  [/\bXMLHttpRequest\b/, 'XMLHttpRequest — no runtime network requests are permitted'],
  [/new\s+WebSocket\b/, 'WebSocket — no runtime network requests are permitted'],
  [/\bnavigator\.sendBeacon\b/, 'sendBeacon — telemetry is forbidden'],
  [/new\s+EventSource\b/, 'EventSource — no runtime network requests are permitted'],
  [/importScripts\s*\(\s*['"`]https?:/, 'remote importScripts — MV3 forbids remote code']
];

const REMOTE_HOSTS =
  /(fonts\.googleapis|fonts\.gstatic|cdn\.jsdelivr|unpkg\.com|cdnjs\.cloudflare|googletagmanager|google-analytics|sentry\.io)/;

const REMOTE_IMPORT = [
  [
    /\b(?:import|from|require\s*\()\s*['"`]https?:\/\//,
    'remote module import — bundle it locally instead'
  ],
  [
    /<(?:script|link)[^>]+(?:src|href)\s*=\s*['"]https?:\/\//i,
    'remote <script>/<link> — bundle it locally instead'
  ],
  [/@import\s+(?:url\()?['"]?https?:\/\//i, 'remote CSS @import — bundle it locally instead']
];

// The two documented exceptions to zero-network (CLAUDE.md invariant #1, PLAN
// §5.4 item 5), each narrowed to the one module allowed to actually fetch:
// `model.ts` resolves the pinned URL, `download.ts` is the only place that
// fetches it (see either directory's own comments). Every other file in these
// two directories — including the OCR worker — is fully checked.
const NETWORK_API_ALLOWED_FILES = new Set([
  'src/core/ocr/model.ts',
  'src/core/ocr/download.ts',
  'src/core/faceblur/model.ts',
  'src/core/faceblur/download.ts',
  // Pre-existing, narrower exception: `devanagariFont.ts` reads a bundled font
  // file, same-origin, via `fetch(new URL('./assets/...', import.meta.url))` —
  // it never names a remote host and is not part of this ticket's fix, but the
  // wholesale directory exemption this script is replacing used to cover it,
  // so it needs an explicit line here rather than silently regressing.
  'src/core/ocr/devanagariFont.ts'
]);
// No file gets a pass on naming a remote host, other than the two that resolve
// the pinned CDN URL itself — not even `devanagariFont.ts` above, whose fetch
// target is always a same-origin bundled asset.
const REMOTE_HOST_ALLOWED_FILES = new Set([
  'src/core/ocr/model.ts',
  'src/core/ocr/download.ts',
  'src/core/faceblur/model.ts',
  'src/core/faceblur/download.ts'
]);

const COLOR_KEYWORDS = '(?:red|green|blue|white|black|orange|yellow|purple|gray|grey)';
const COLOR_PROPS =
  '(?:color|background(?:-color)?|backgroundColor|border(?:-[a-z]+)?(?:-color)?|borderColor|' +
  'outline(?:-color)?|outlineColor|fill|stroke|box-shadow|boxShadow|text-shadow|textShadow|' +
  'caret-color|caretColor|accent-color|accentColor)';
const RAW_COLOR = new RegExp(
  '(' +
    '#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\\b' +
    '|\\b(?:rgba?|hsla?)\\s*\\(\\s*(?:\\d|\\.\\d)' +
    `|\\b${COLOR_PROPS}\\s*:\\s*['"\`]?${COLOR_KEYWORDS}['"\`]?\\b` +
    ')'
);

/** A CSS custom-property *declaration* (`--foo: #hex;`) is where a literal colour
 * is supposed to live — same reason tokens.css itself is exempt below. Applies to
 * privacy.html's page-scoped custom properties too, so the exemption only covers
 * the declarations, not stray raw colours anywhere else in the file. */
const isTokenDeclaration = line => /^\s*--[\w-]+\s*:/.test(line);

const TOKENS_FILE = 'src/ui/styles/tokens.css';

const DEFINED_TOKENS = (() => {
  try {
    const css = readFileSync(path.resolve(process.cwd(), TOKENS_FILE), 'utf8');
    return new Set([...css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gim)].map(m => m[1]));
  } catch {
    return null;
  }
})();

function getAllFiles(dirPath, arrayOfFiles = []) {
  const files = readdirSync(dirPath);
  files.forEach(file => {
    const fullPath = path.join(dirPath, file);
    if (statSync(fullPath).isDirectory()) {
      getAllFiles(fullPath, arrayOfFiles);
    } else {
      arrayOfFiles.push(fullPath);
    }
  });
  return arrayOfFiles;
}

const root = process.cwd();
const files = [
  ...getAllFiles(path.join(root, 'src')),
  path.join(root, 'public/privacy.html'),
  path.join(root, 'manifest.json')
];

const findings = [];

for (const file of files) {
  const rel = path.relative(root, file).split(path.sep).join('/');
  const ext = path.extname(rel);
  const isTest = /(^|\/)tests?\//.test(rel) || /\.(test|spec)\.[tj]sx?$/.test(rel);

  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  const lines = text.split('\n');

  const inSrc = rel.startsWith('src/');
  const isSource = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.css', '.html'].includes(ext);

  if ((inSrc && isSource) || rel === 'public/privacy.html') {
    // doc-colors.ts feeds pdf-lib's colour constructor with document colours (a
    // PDF page is white, redaction fill is black) — not theme colours, so they
    // cannot be CSS vars. tokens.css itself is the one file allowed to declare
    // literal colours, since that's what tokens.css *is*.
    const colourExempt = rel === 'src/core/doc-colors.ts' || rel === TOKENS_FILE;
    const chromeExempt =
      rel.startsWith('src/platform/') || rel === 'src/background/service-worker.ts';
    const networkApiAllowed = NETWORK_API_ALLOWED_FILES.has(rel);
    const remoteHostAllowed = REMOTE_HOST_ALLOWED_FILES.has(rel);

    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*|<!--)/.test(line)) return;

      if (!isTest) {
        for (const [re, msg] of REMOTE_IMPORT) {
          if (re.test(line)) findings.push(`${rel}:${i + 1} — ${msg}`);
        }
        if (!remoteHostAllowed && REMOTE_HOSTS.test(line)) {
          findings.push(
            `${rel}:${i + 1} — reference to a remote host — breaks the zero-network guarantee`
          );
        }
        if (!networkApiAllowed) {
          for (const [re, msg] of NETWORK_APIS) {
            if (re.test(line)) findings.push(`${rel}:${i + 1} — ${msg}`);
          }
        }
      }

      if (
        ['.css', '.ts', '.tsx', '.html'].includes(ext) &&
        !colourExempt &&
        !isTest &&
        !isTokenDeclaration(line)
      ) {
        if (RAW_COLOR.test(line)) {
          findings.push(`${rel}:${i + 1} — raw colour literal`);
        }
      }

      if (DEFINED_TOKENS && ['.css', '.ts', '.tsx'].includes(ext) && rel !== TOKENS_FILE) {
        for (const m of line.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) {
          if (!DEFINED_TOKENS.has(m[1])) {
            findings.push(`${rel}:${i + 1} — var(${m[1]}) is not defined in tokens.css`);
          }
        }
      }

      if (inSrc && !chromeExempt && !isTest && /\bchrome\.\w/.test(line)) {
        findings.push(`${rel}:${i + 1} — chrome.* outside src/platform/`);
      }
    });
  }
}

const firefoxManifestPath = path.join(root, 'dist', 'firefox', 'manifest.json');
if (statSync(firefoxManifestPath, { throwIfNoEntry: false })) {
  try {
    JSON.parse(readFileSync(firefoxManifestPath, 'utf8'));
  } catch {
    console.error('❌ dist/firefox/manifest.json is not valid JSON.');
    process.exit(1);
  }
}

if (findings.length > 0) {
  console.error(`❌ Invariant check failed with ${findings.length} findings:\n`);
  findings.forEach(f => console.error(`  • ${f}`));
  process.exit(1);
} else {
  console.log('✅ Invariant check passed — no raw colours, chrome leaks, or undefined tokens.');
}
