/**
 * HRD-40 / AUDIT-2026-09-25 M1 — the "fix once" lint rule.
 *
 * `copyPages`, `embedPage`, `embedPages` and `embedPdf` each build a fresh
 * pdf-lib object copier. Called per page, they duplicated shared fonts/images
 * and copied referenced pages as orphans still carrying their unredacted
 * content. The rule in `eslint.config.js` bans those calls inside loops
 * everywhere except `src/core/pdf/rebuild.ts`; this test runs the repo's own
 * ESLint config over snippets to prove it fires, and that it does not fire on
 * the legitimate one-call shapes.
 */
import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const eslint = new ESLint({ cwd: root });

async function copierErrors(code: string, filePath = 'src/core/lint-probe.ts'): Promise<number> {
  const [result] = await eslint.lintText(code, { filePath: `${root}/${filePath}` });
  return result.messages.filter(
    m => m.ruleId === 'no-restricted-syntax' && m.message.includes('HRD-40')
  ).length;
}

const PRELUDE = `
import type { PDFDocument, PDFPage } from 'pdf-lib';
declare const out: PDFDocument;
declare const src: PDFDocument;
declare const pages: PDFPage[];
declare const indices: number[];
`;

describe('lint: no per-page object copier (HRD-40 M1)', () => {
  const flagged: Record<string, string> = {
    'copyPages in for…of': `for (const i of indices) { await out.copyPages(src, [i]); }`,
    'copyPages in classic for': `for (let i = 0; i < 3; i++) { const [p] = await out.copyPages(src, [i]); out.addPage(p); }`,
    'embedPage in while': `let i = 0; while (i < pages.length) { await out.embedPage(pages[i]); i++; }`,
    'embedPages in do…while': `let i = 0; do { await out.embedPages([pages[i]]); i++; } while (i < 2);`,
    'embedPdf in for…in': `for (const k in indices) { await out.embedPdf(src, [Number(k)]); }`,
    'loop body is the bare call': `for (const p of pages) void out.embedPage(p);`,
    'loop body is the bare call, no braces': `for (const i of indices) out.copyPages(src, [i]);`,
    'copyPages in forEach callback': `indices.forEach(async i => { await out.copyPages(src, [i]); });`,
    'embedPage in map with expression body': `await Promise.all(pages.map(p => out.embedPage(p)));`,
    'embedPage in async map with await body': `await Promise.all(pages.map(async p => await out.embedPage(p)));`,
    'nested inside an if in a loop': `for (const p of pages) { if (p) { await out.embedPage(p); } }`
  };
  for (const [name, body] of Object.entries(flagged)) {
    it(`fires on ${name}`, async () => {
      expect(await copierErrors(`${PRELUDE}\nexport async function f() { ${body} }`)).toBe(1);
    });
  }

  const allowed: Record<string, string> = {
    'one copyPages call for all pages': `const copies = await out.copyPages(src, indices); for (const c of copies) out.addPage(c);`,
    'one embedPages call before a loop': `const forms = await out.embedPages(pages); for (const f of forms) void f;`,
    'call in the loop head, run once': `for (const c of await out.copyPages(src, indices)) out.addPage(c);`
  };
  for (const [name, body] of Object.entries(allowed)) {
    it(`does not fire on ${name}`, async () => {
      expect(await copierErrors(`${PRELUDE}\nexport async function f() { ${body} }`)).toBe(0);
    });
  }

  it('exempts the single rebuild path, src/core/pdf/rebuild.ts', async () => {
    const code = `${PRELUDE}\nexport async function f() { for (const i of indices) await out.copyPages(src, [i]); }`;
    expect(await copierErrors(code, 'src/core/pdf/other.ts')).toBe(1);
    expect(await copierErrors(code, 'src/core/pdf/rebuild.ts')).toBe(0);
  });
});
