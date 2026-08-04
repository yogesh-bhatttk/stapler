#!/usr/bin/env node
/**
 * Guards the design-token contract (PLAN §5.4 invariant 3 / DS-01).
 *
 * Two checks over everything under src/:
 *   1. Every `var(--x)` referenced resolves to a token defined in tokens.css.
 *      An undefined custom property fails silently in the browser — the
 *      declaration is dropped and the element inherits. That is how a UI ends up
 *      with no modal background and 16px body text everywhere, with a green build.
 *   2. No colour literal outside tokens.css (and the two document-colour
 *      modules, which encode PDF page colours, not theme colours).
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(process.cwd(), 'src');
const TOKENS_FILE = 'src/ui/styles/tokens.css';

/**
 * Colours of the document itself (a PDF page is white; redaction fill is black)
 * are not theme colours and cannot be CSS variables — they are numbers handed to
 * pdf-lib and canvas. They live in exactly one module so they stay reviewable.
 */
const DOC_COLOUR_ALLOWLIST = new Set(['src/core/doc-colors.ts']);

/**
 * Only a *literal* colour trips this. `rgb(DOC_INK.r, …)` is pdf-lib's colour
 * constructor consuming a token, so the numeric-argument lookahead matters —
 * without it every legitimate pdf-lib draw call is a false positive.
 */
const RAW_COLOUR =
  /(#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b|\b(?:rgba?|hsla?)\s*\(\s*(?:\d|\.\d)|\bcolor\s*:\s*(?:red|green|blue|white|black|orange|yellow|purple|gray|grey)\b)/;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(css|ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const rel = f => path.relative(process.cwd(), f).split(path.sep).join('/');

const tokensCss = readFileSync(path.resolve(process.cwd(), TOKENS_FILE), 'utf8');
const defined = new Set([...tokensCss.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gim)].map(m => m[1]));

const problems = [];

for (const file of walk(SRC)) {
  const name = rel(file);
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');

  lines.forEach((line, i) => {
    for (const m of line.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) {
      if (!defined.has(m[1])) {
        problems.push(`${name}:${i + 1} — var(${m[1]}) is not defined in ${TOKENS_FILE}`);
      }
    }

    if (name === TOKENS_FILE || DOC_COLOUR_ALLOWLIST.has(name)) return;
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    if (RAW_COLOUR.test(line)) {
      problems.push(`${name}:${i + 1} — colour literal; use a var(--token) from ${TOKENS_FILE}`);
    }
  });
}

if (problems.length) {
  console.error(`❌ Design-token check FAILED — ${problems.length} problem(s):`);
  for (const p of problems) console.error(`   • ${p}`);
  process.exit(1);
}

console.log(
  `✅ Design-token check passed — ${defined.size} tokens, no undefined refs, no literals.`
);
