#!/usr/bin/env node
/**
 * Stapler invariant guard — runs as a PostToolUse hook on Write|Edit.
 *
 * Enforces the four constraints that the product's core claim depends on, at the
 * moment code is written rather than at review time. See docs/PLAN.md §5.4.
 *
 *   1. Zero network      — no CDN imports, no fetch/XHR/WebSocket, no remote URL
 *                          sinks in src/ or the root entry pages, except the one
 *                          disclosed model download (src/core/ocr/model.ts +
 *                          download.ts). AST-based: scripts/network-guard.mjs.
 *   2. Design tokens     — no raw hex/rgb colours outside tokens.css
 *   3. Layer boundary    — no chrome.* outside src/platform/
 *   4. Zero permissions  — manifest.json permissions arrays stay empty
 *
 * Emits {"decision":"block","reason":...} so findings are fed back to Claude and
 * the turn continues. Exits 0 silently when the file is clean or out of scope.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

// §4 (docs/AUDIT-EDGE-CASES-2026-09-15.md), tightened by audit 2026-09-25
// PLT-3: the manifest CSP is checked directive by directive against an
// allowlist. Every directive may only carry the sources listed here; the only
// remote source anywhere is the exact, path-scoped pinned OCR model
// directories in connect-src — a bare `https://cdn.jsdelivr.net` would allow
// every npm package on that CDN and is refused. DUPLICATED from
// `scripts/csp.mjs` (the source of truth) so the manifest check never depends
// on anything but this file; `tests/unit/csp.test.ts` keeps them in sync.
const CSP_ALLOWED_SOURCES = {
  'default-src': ["'self'"],
  'script-src': ["'self'", "'wasm-unsafe-eval'"],
  'worker-src': ["'self'"],
  'connect-src': [
    "'self'",
    'blob:',
    'data:',
    'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int/',
    'https://cdn.jsdelivr.net/npm/@tesseract.js-data/hin@1.0.0/4.0.0_best_int/'
  ],
  'img-src': ["'self'", 'blob:', 'data:'],
  'style-src': ["'self'", "'unsafe-inline'"],
  'font-src': ["'self'", 'data:'],
  'object-src': ["'none'"],
  'frame-src': ["'none'"],
  'base-uri': ["'none'"],
  'form-action': ["'none'"]
};
const CSP_REQUIRED_DIRECTIVES = ['default-src', 'script-src', 'object-src', 'base-uri'];

/** Every CSP violation in one `content_security_policy.extension_pages` string. */
function cspFindings(csp) {
  const out = [];
  const seen = new Set();
  for (const directive of csp.split(';').map(d => d.trim()).filter(Boolean)) {
    const [name, ...sources] = directive.split(/\s+/);
    seen.add(name);
    const allowed = CSP_ALLOWED_SOURCES[name];
    if (!allowed) {
      out.push(`CSP directive "${name}" is not in the allowlist (scripts/csp.mjs).`);
      continue;
    }
    for (const source of sources) {
      if (allowed.includes(source)) continue;
      out.push(
        `CSP directive "${name}" allows "${source}" — not in the allowlist (scripts/csp.mjs). ` +
          `Only connect-src may name a remote source, and only the exact pinned OCR model paths. ` +
          `See PLAN §5.4 item 5.`
      );
    }
  }
  for (const name of CSP_REQUIRED_DIRECTIVES) {
    if (!seen.has(name)) out.push(`CSP is missing the required "${name}" directive.`);
  }
  return out;
}

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
// Audit 2026-09-25 PLT-6: the root entry pages (editor.html and the landing
// pages) ship in the build too, so they are guarded like source.
const inSrc = rel.startsWith('src/') || (!rel.includes('/') && ext === '.html');
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
  // Zero network (audit 2026-09-25 PLT-6): an AST analysis of this one file,
  // shared with `scripts/check-invariants.mjs` and the bundle scan — aliased
  // or computed network APIs, remote imports/workers, URL sinks, CSS url() and
  // HTML resource attributes. The one documented model download (PLAN §5.4
  // item 5, `src/core/ocr/model.ts` + `download.ts`) is allowlisted there.
  // Loaded lazily so a manifest edit never pays for the TypeScript import.
  try {
    const guardUrl = new URL('../../scripts/network-guard.mjs', import.meta.url);
    const { analyzeNetwork } = await import(guardUrl.href);
    for (const f of analyzeNetwork(text, rel)) findings.push(`${rel}:${f.line} — ${f.message}`);
  } catch (err) {
    // Failing closed: a guard that cannot run must not look like a pass.
    findings.push(
      `${rel} — the zero-network analyzer (scripts/network-guard.mjs) could not run: ` +
        `${err instanceof Error ? err.message : String(err)}. Run \`pnpm install\`.`
    );
  }

  // Document colours (a PDF page is white; redaction fill is black) are numbers
  // handed to canvas/pdf-lib, not theme colours, so they cannot be CSS vars. They
  // are confined to one audited module — see also scripts/check-tokens.mjs.
  const colourExempt = rel === 'src/core/doc-colors.ts';

  // The MV3 service worker is platform code by definition: its whole job is
  // chrome.action → chrome.tabs (PLAN §2.1). It holds no product logic.
  const chromeExempt =
    rel.startsWith('src/platform/') || rel === 'src/background/service-worker.ts';

  lines.forEach((line, i) => {
    // Comment lines are skipped for the line-based checks below only; the
    // network analysis above works on the syntax tree, not on lines.
    if (/^\s*(\/\/|\*|<!--)/.test(line)) return;

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
    const csp = m.content_security_policy?.extension_pages;
    if (typeof csp === 'string') {
      for (const msg of cspFindings(csp)) findings.push(`${rel} — ${msg}`);
    }
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
