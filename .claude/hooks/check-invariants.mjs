#!/usr/bin/env node
/**
 * Stapler invariant guard — runs as a PostToolUse hook on Write|Edit.
 *
 * Enforces the four constraints that the product's core claim depends on, at the
 * moment code is written rather than at review time. See docs/PLAN.md §5.4.
 *
 *   1. Zero network      — no CDN imports, no fetch/XHR/WebSocket in src/, except
 *                          the two disclosed model downloads (src/core/ocr/,
 *                          src/core/faceblur/)
 *   2. Design tokens     — no raw hex/rgb colours outside tokens.css
 *   3. Layer boundary    — no chrome.* outside src/platform/
 *   4. Zero permissions  — manifest.json permissions arrays stay empty
 *
 * Emits {"decision":"block","reason":...} so findings are fed back to Claude and
 * the turn continues. Exits 0 silently when the file is clean or out of scope.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

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

// OCR-01 Defect 4: this used to carve out `src/core/ocr/` and
// `src/core/faceblur/` *wholesale*, so a `fetch()` or a remote-host reference
// added anywhere in either directory — not just the one legitimate
// model-download module — would never be caught. Narrowed to the specific
// files that are actually allowed to do each thing; kept in sync with
// `scripts/check-invariants.mjs`.
const NETWORK_API_ALLOWED_FILES = new Set([
  'src/core/ocr/model.ts',
  'src/core/ocr/download.ts',
  'src/core/faceblur/model.ts',
  'src/core/faceblur/download.ts',
  // Pre-existing, narrower exception: reads a bundled font file, same-origin,
  // via `fetch(new URL('./assets/...', import.meta.url))`. Never names a
  // remote host — see `REMOTE_HOST_ALLOWED_FILES` below, which does not
  // include it.
  'src/core/ocr/devanagariFont.ts'
]);
const REMOTE_HOST_ALLOWED_FILES = new Set([
  'src/core/ocr/model.ts',
  'src/core/ocr/download.ts',
  'src/core/faceblur/model.ts',
  'src/core/faceblur/download.ts'
]);

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

// Colour keyword, restricted to properties that actually carry a colour. A bare
// keyword check (any quoted 'gray') would false-positive on things like the
// `{ kind: 'gray' }` colour-space discriminant in process.worker.ts, which is a
// PDF colour-space tag, not a CSS colour.
const COLOR_KEYWORDS = '(?:red|green|blue|white|black|orange|yellow|purple|gray|grey)';
const COLOR_PROPS =
  '(?:color|background(?:-color)?|backgroundColor|border(?:-[a-z]+)?(?:-color)?|borderColor|' +
  'outline(?:-color)?|outlineColor|fill|stroke|box-shadow|boxShadow|text-shadow|textShadow|' +
  'caret-color|caretColor|accent-color|accentColor)';

// Only a *literal* colour trips this. `rgb(DOC_INK.r, …)` is pdf-lib's colour
// constructor consuming a token, not a hard-coded colour, so the numeric-argument
// lookahead matters. The colour-property alternative covers both bare CSS
// (`color: black;`) and quoted JS/TSX string literals — single, double, AND
// backtick-quoted — since `style={{ color: 'black' }}` and template-literal CSS
// (`` `background: ${x} black` ``) hide a raw colour just as well as bare CSS does.
const RAW_COLOR = new RegExp(
  '(' +
    '#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\\b' +
    '|\\b(?:rgba?|hsla?)\\s*\\(\\s*(?:\\d|\\.\\d)' +
    `|\\b${COLOR_PROPS}\\s*:\\s*['"\`]?${COLOR_KEYWORDS}['"\`]?\\b` +
    ')'
);

const TOKENS_FILE = 'src/ui/styles/tokens.css';

/** Tokens declared in tokens.css, so we can catch references to ones that aren't. */
const DEFINED_TOKENS = (() => {
  try {
    const css = readFileSync(path.resolve(process.cwd(), TOKENS_FILE), 'utf8');
    return new Set([...css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gim)].map(m => m[1]));
  } catch {
    return null;
  }
})();

function read(stdin) {
  try {
    return JSON.parse(stdin);
  } catch {
    return null;
  }
}

const payload = read(readFileSync(0, 'utf8'));
const file = payload?.tool_response?.filePath ?? payload?.tool_input?.file_path;
if (!file || !existsSync(file)) process.exit(0);

const root = process.cwd();
const rel = path.relative(root, file).split(path.sep).join('/');
const base = path.basename(rel);
const ext = path.extname(rel);
const findings = [];

// Only guard project source. Docs, config, and this hook itself are exempt.
const inSrc = rel.startsWith('src/');
const isSource = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.css', '.html'].includes(ext);
const isTest = /(^|\/)tests?\//.test(rel) || /\.(test|spec)\.[tj]sx?$/.test(rel);

let text;
try {
  text = readFileSync(file, 'utf8');
} catch {
  process.exit(0);
}
const lines = text.split('\n');

const flag = (i, msg) => findings.push(`${rel}:${i + 1} — ${msg}`);

if (inSrc && isSource) {
  // The two documented model downloads (PLAN §5.4 item 5): the OCR language
  // model and RED-08's face-detector weights. Both are fetched once, on an
  // explicit confirmation, from a pinned URL — and nothing else in src/ may
  // name a remote host or call a network API. Narrowed to the specific files
  // named above rather than the two directories wholesale, so a stray
  // `fetch()` elsewhere in either directory still trips this guard.
  const networkApiAllowed = NETWORK_API_ALLOWED_FILES.has(rel);
  const remoteHostAllowed = REMOTE_HOST_ALLOWED_FILES.has(rel);

  // Document colours (a PDF page is white; redaction fill is black) are numbers
  // handed to canvas/pdf-lib, not theme colours, so they cannot be CSS vars. They
  // are confined to one audited module — see also scripts/check-tokens.mjs.
  const colourExempt = rel === 'src/core/doc-colors.ts';

  // The MV3 service worker is platform code by definition: its whole job is
  // chrome.action → chrome.tabs (PLAN §2.1). It holds no product logic.
  const chromeExempt =
    rel.startsWith('src/platform/') || rel === 'src/background/service-worker.ts';

  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*|<!--)/.test(line)) return; // skip comment lines

    for (const [re, msg] of REMOTE_IMPORT) if (re.test(line)) flag(i, msg);
    if (!remoteHostAllowed && REMOTE_HOSTS.test(line))
      flag(i, 'reference to a remote host — breaks the zero-network guarantee');
    if (!networkApiAllowed)
      for (const [re, msg] of NETWORK_APIS) if (re.test(line)) flag(i, msg);

    // Design tokens: colour literals belong in tokens.css only.
    if (
      ['.css', '.ts', '.tsx'].includes(ext) &&
      rel !== 'src/ui/styles/tokens.css' &&
      !colourExempt &&
      !isTest
    ) {
      if (RAW_COLOR.test(line)) {
        flag(i, 'raw colour literal — use a var(--token) from src/ui/styles/tokens.css');
      }
    }

    // A var(--x) that is not defined in tokens.css is dropped silently by the
    // browser, so it never surfaces as an error — only as a broken-looking UI.
    if (DEFINED_TOKENS && ['.css', '.ts', '.tsx'].includes(ext) && rel !== TOKENS_FILE) {
      for (const m of line.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) {
        if (!DEFINED_TOKENS.has(m[1])) {
          flag(i, `var(${m[1]}) is not defined in src/ui/styles/tokens.css`);
        }
      }
    }

    // Layer boundary: only the platform adapter may touch chrome.*
    if (!chromeExempt && !isTest && /\bchrome\.\w/.test(line)) {
      flag(i, 'chrome.* outside src/platform/ — go through the platform adapter (PLAN §2.2)');
    }
  });
}

if (base === 'manifest.json') {
  try {
    const m = JSON.parse(text);
    for (const key of ['permissions', 'host_permissions', 'optional_permissions']) {
      if (Array.isArray(m[key]) && m[key].length > 0) {
        findings.push(
          `${rel} — "${key}" is non-empty (${m[key].join(', ')}). v1.0 ships with zero permissions so ` +
            `Chrome shows no install warning. See PLAN §5.4 item 3.`
        );
      }
    }
    if (m.content_scripts)
      findings.push(`${rel} — content_scripts declared; the architecture has none (PLAN §2.1)`);
  } catch {
    findings.push(`${rel} — invalid JSON`);
  }
}

if (findings.length === 0) process.exit(0);

process.stdout.write(
  JSON.stringify({
    decision: 'block',
    reason:
      `Invariant violations in the file just written — fix these before continuing:\n\n` +
      findings.map(f => `  • ${f}`).join('\n') +
      `\n\nThese are hard product constraints, not style preferences. If one is genuinely a false ` +
      `positive, say so explicitly rather than working around the check.`,
    systemMessage: `Invariant guard: ${findings.length} finding${findings.length === 1 ? '' : 's'} in ${base}`
  })
);
process.exit(0);
