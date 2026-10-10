/**
 * AUDIT-2026-10-10 UI26 — every `en.json` key is referenced from `src/`.
 *
 * 62 keys had piled up that nothing could ever look up: fragments the one-off
 * `scripts/i18n-extract.ts` codemod cut out of JSX that has since been
 * rewritten ("+ arrows reorders ·", "Stapler does all its work in this"), dev
 * gallery labels the gallery never translates, and a stray "tool.annotate".
 * Each one is a string every translator is asked to translate for nothing.
 * (`i18n-extract.ts` is a codemod that rewrites JSX, not a checker, so this
 * test does the inventory itself.)
 *
 * A key counts as referenced when it appears as a string literal anywhere in
 * `src/` — not only as a direct `t('…')` argument — because tool titles,
 * pattern labels and the like are stored as `tKey('…')` constants or plain
 * strings and translated later through a variable; a key split over
 * `'…' + '…'` for line length counts as its joined text. A plural entry
 * (`key_one`, `key_few`, …) is referenced when its base key is.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(process.cwd(), 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [full] : [];
  });
}

/** Every string a constant expression can evaluate to, or null if not constant. */
function resolve(node: ts.Node): string[] | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isParenthesizedExpression(node)) return resolve(node.expression);
  if (ts.isConditionalExpression(node)) {
    const a = resolve(node.whenTrue);
    const b = resolve(node.whenFalse);
    return a && b ? [...a, ...b] : null;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = resolve(node.left);
    const right = resolve(node.right);
    return left && right ? left.flatMap(l => right.map(r => l + r)) : null;
  }
  return null;
}

function stringLiterals(): Set<string> {
  const found = new Set<string>();
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf8');
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );
    const visit = (node: ts.Node) => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        found.add(node.text);
      }
      // Long keys are written as `'…' + '…'` (or a conditional between such
      // pieces) so they fit the line length; fold them back into the key.
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        for (const text of resolve(node) ?? []) found.add(text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

describe('en.json has no unreferenced keys (UI26)', () => {
  it('every key, or a plural entry’s base key, is a string literal in src/', () => {
    const en = JSON.parse(
      readFileSync(path.join(SRC, 'core/i18n/locales/en.json'), 'utf8')
    ) as Record<string, string>;
    const literals = stringLiterals();
    const unused = Object.keys(en).filter(key => {
      const base = key.replace(/_(zero|one|two|few|many|other)$/, '');
      return !literals.has(base);
    });
    expect(unused).toEqual([]);
  });
});
