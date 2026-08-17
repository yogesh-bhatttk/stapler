#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

// Kept in sync with .claude/hooks/check-invariants.mjs — this is the same guard
// run as a one-shot, whole-repo scan (see item §9 of docs/AUDIT-FINDINGS.md: the
// PostToolUse hook only fires on Write/Edit and only looks at src/, so a file
// written by shell command, or a file outside src/ like public/privacy.html,
// needs this script wired into `pnpm check` to be covered at all).
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

    lines.forEach((line, i) => {
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

if (findings.length > 0) {
  console.error(`❌ Invariant check failed with ${findings.length} findings:\n`);
  findings.forEach(f => console.error(`  • ${f}`));
  process.exit(1);
} else {
  console.log('✅ Invariant check passed — no raw colours, chrome leaks, or undefined tokens.');
}
