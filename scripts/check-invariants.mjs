#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { cspFindings } from './csp.mjs';
import { analyzeNetwork } from './network-guard.mjs';

// Kept in sync with .claude/hooks/check-invariants.mjs — this is the same guard
// run as a one-shot, whole-repo scan (see item §9 of docs/AUDIT-FINDINGS.md: the
// PostToolUse hook only fires on Write/Edit and only looks at src/, so a file
// written by shell command, or a file outside src/ like public/privacy.html,
// needs this script wired into `pnpm check` to be covered at all).
//
// Zero network (audit 2026-09-25 PLT-6): the per-line regexes that used to
// live here (and in the hook) missed aliased/computed `fetch`, multi-line
// calls, remote `import()`/workers, URL sinks, CSS `url()` and any line
// starting with `*`. Both guards now call the same AST-based analyzer, which
// also owns the allowlist (the OCR model download in `src/core/ocr/model.ts`
// + `download.ts`; `devanagariFont.ts` may fetch a same-origin target only).
// §4 (docs/AUDIT-EDGE-CASES-2026-09-15.md), tightened by audit 2026-09-25
// PLT-3: the CSP allowlist and its checker live in `scripts/csp.mjs`, the same
// module the web build's `<meta>` CSP is generated from.

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
// §4 — this named `manifest.json` at the repo root, which does not exist (the
// real file is `public/manifest.json`); every scan of it below had been
// silently reading nothing since `readFileSync` throws and the loop just
// `continue`s past a missing file. Fixed alongside adding the CSP check that
// exposed it, since a check wired to a path that never resolves is exactly
// the same as no check at all.
const manifestPath = path.join(root, 'public/manifest.json');
// Audit 2026-09-25 PLT-6: the root entry pages (editor.html and every
// landing page) ship in the web build, so they are scanned like source.
const rootHtml = readdirSync(root)
  .filter(name => name.endsWith('.html'))
  .map(name => path.join(root, name));
const files = [
  ...getAllFiles(path.join(root, 'src')),
  ...rootHtml,
  path.join(root, 'public/privacy.html'),
  manifestPath
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

  const inSrc = rel.startsWith('src/') || (!rel.includes('/') && ext === '.html');
  const isSource = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.css', '.html'].includes(ext);

  if ((inSrc && isSource) || rel === 'public/privacy.html') {
    // doc-colors.ts feeds pdf-lib's colour constructor with document colours (a
    // PDF page is white, redaction fill is black) — not theme colours, so they
    // cannot be CSS vars. tokens.css itself is the one file allowed to declare
    // literal colours, since that's what tokens.css *is*.
    const colourExempt = rel === 'src/core/doc-colors.ts' || rel === TOKENS_FILE;
    const chromeExempt =
      rel.startsWith('src/platform/') || rel === 'src/background/service-worker.ts';

    if (!isTest) {
      for (const f of analyzeNetwork(text, rel)) findings.push(`${rel}:${f.line} — ${f.message}`);
    }

    lines.forEach((line, i) => {
      // Comment lines are skipped for the line-based checks below only.
      if (/^\s*(\/\/|\*|<!--)/.test(line)) return;

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

try {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  for (const key of ['permissions', 'host_permissions', 'optional_permissions']) {
    if (Array.isArray(manifest[key]) && manifest[key].length > 0) {
      findings.push(
        `public/manifest.json — "${key}" is non-empty (${manifest[key].join(', ')}). v1.0 ships ` +
          `with zero permissions so Chrome shows no install warning. See PLAN §5.4 item 3.`
      );
    }
  }
  if (manifest.content_scripts) {
    findings.push(
      'public/manifest.json — content_scripts declared; the architecture has none (PLAN §2.1)'
    );
  }
  const csp = manifest.content_security_policy?.extension_pages;
  if (typeof csp === 'string') {
    for (const msg of cspFindings(csp)) findings.push(`public/manifest.json — ${msg}`);
  }
} catch {
  findings.push('public/manifest.json — invalid JSON');
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
  console.log(
    '✅ Invariant check passed — no network access, raw colours, chrome leaks, or undefined tokens.'
  );
}
