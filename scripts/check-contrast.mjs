#!/usr/bin/env node
/**
 * DS-02 — executable contrast audit.
 *
 * Parses src/ui/styles/tokens.css and asserts every foreground/background pair we
 * actually ship clears WCAG 2.1 AA in BOTH themes: 4.5:1 for text, 3:1 for large
 * text, focus rings, and interactive-control boundaries (SC 1.4.3 / 1.4.11).
 *
 * A failing pair is corrected in tokens.css, never waived — so this runs in
 * `pnpm check` rather than living in a stale markdown table.
 *
 *   node scripts/check-contrast.mjs           # table + exit 1 on any failure
 *   node scripts/check-contrast.mjs --markdown  # emit docs/CONTRAST-AUDIT.md body
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const TOKENS = path.resolve(process.cwd(), 'src/ui/styles/tokens.css');

/** [foreground, background, minimum ratio, what the pair is] */
const PAIRS = [
  ['--ink', '--canvas', 4.5, 'body text on page'],
  ['--ink', '--surface-1', 4.5, 'body text on raised surface'],
  ['--ink', '--surface-2', 4.5, 'body text on panel'],
  ['--ink', '--surface-3', 4.5, 'body text on sunken surface'],
  ['--ink-muted', '--canvas', 4.5, 'secondary text'],
  ['--ink-muted', '--surface-2', 4.5, 'secondary text on panel'],
  ['--ink-subtle', '--canvas', 4.5, 'label text'],
  ['--ink-subtle', '--surface-1', 4.5, 'label text on raised surface'],
  ['--ink-subtle', '--surface-2', 4.5, 'label text on panel'],
  ['--ink-subtle', '--surface-3', 4.5, 'label text on sunken surface'],
  ['--ink-tertiary', '--canvas', 3.0, 'decorative glyph — never text'],
  ['--primary-text', '--canvas', 4.5, 'accent text / link'],
  ['--primary-text', '--surface-2', 4.5, 'accent text on panel'],
  ['--on-primary', '--primary', 4.5, 'label on the primary CTA'],
  ['--primary', '--canvas', 3.0, 'primary fill boundary'],
  ['--primary-focus', '--canvas', 3.0, 'focus ring on page'],
  ['--primary-focus', '--surface-2', 3.0, 'focus ring on panel'],
  ['--border-control', '--canvas', 3.0, 'control boundary on page'],
  ['--border-control', '--surface-1', 3.0, 'control boundary on raised surface'],
  ['--success', '--canvas', 4.5, 'success text'],
  ['--success', '--success-bg', 4.5, 'success text on tint'],
  ['--on-status', '--success', 4.5, 'label on success fill'],
  ['--warning', '--canvas', 4.5, 'warning text'],
  ['--warning', '--warning-bg', 4.5, 'warning text on tint'],
  ['--on-status', '--warning', 4.5, 'label on warning fill'],
  ['--danger', '--canvas', 4.5, 'danger text'],
  ['--danger', '--danger-bg', 4.5, 'danger text on tint'],
  ['--on-status', '--danger', 4.5, 'label on danger fill'],
  // Document chrome sits on a page that is white in both themes (§3.1).
  ['--doc-redact', '--doc-page', 4.5, 'redaction fill on a page'],
  ['--doc-select', '--doc-page', 3.0, 'selection ring on a page']
];

function parseTheme(css, selector) {
  const start = css.indexOf(selector);
  if (start === -1) throw new Error(`No ${selector} block in tokens.css`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('\n}', open);
  const out = {};
  for (const m of css.slice(open, close).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    out[m[1]] = m[2].trim();
  }
  return out;
}

function toRgb(value) {
  let h = value.replace('#', '');
  if (h.length === 3) h = [...h].map(c => c + c).join('');
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
}

function luminance(value) {
  const channel = c => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const [r, g, b] = toRgb(value);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Follows `var(--x)` indirection to a literal. */
function resolve(theme, token, seen = new Set()) {
  let value = theme[token];
  while (value && value.startsWith('var(')) {
    const next = value.slice(4, -1).trim();
    if (seen.has(next)) throw new Error(`Circular token reference at ${token}`);
    seen.add(next);
    value = theme[next];
  }
  return value;
}

const css = readFileSync(TOKENS, 'utf8');
const light = parseTheme(css, ':root');
const dark = { ...light, ...parseTheme(css, "[data-theme='dark']") };

const rows = [];
const failures = [];

for (const [fg, bg, min, what] of PAIRS) {
  const cells = [];
  for (const [name, theme] of [
    ['light', light],
    ['dark', dark]
  ]) {
    const f = resolve(theme, fg);
    const b = resolve(theme, bg);
    if (!f || !b) {
      failures.push(`${fg} or ${bg} is not defined in the ${name} theme`);
      cells.push('undefined ❌');
      continue;
    }
    if (!f.startsWith('#') || !b.startsWith('#')) {
      // Translucent tokens have no fixed ratio; they are excluded by design.
      cells.push('n/a');
      continue;
    }
    const r = contrast(f, b);
    const ok = r >= min;
    if (!ok) failures.push(`${fg} on ${bg} (${name}): ${r.toFixed(2)}:1 < ${min}:1 — ${what}`);
    cells.push(`${r.toFixed(2)}:1 ${ok ? '✅' : '❌'}`);
  }
  rows.push(`| \`${fg}\` on \`${bg}\` | ${what} | ${min}:1 | ${cells[0]} | ${cells[1]} |`);
}

const table = ['| Pair | Role | Minimum | Light | Dark |', '|---|---|---|---|---|', ...rows].join(
  '\n'
);

if (process.argv.includes('--markdown')) {
  process.stdout.write(table + '\n');
} else {
  console.log(table);
  console.log('');
  if (failures.length) {
    console.error(`❌ DS-02 contrast audit FAILED — ${failures.length} pair(s):`);
    for (const f of failures) console.error(`   • ${f}`);
    console.error('\nFix the value in tokens.css. Waiving a pair is not an option (DS-02).');
    process.exit(1);
  }
  console.log(`✅ DS-02 contrast audit passed — ${PAIRS.length} pairs × 2 themes.`);
}
