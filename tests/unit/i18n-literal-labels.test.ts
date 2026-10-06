/**
 * HRD-60 (AUDIT-2026-10-01 pattern 9; was X-14, UI-12) — no user-visible
 * English outside `t()` / `translate()` / `tKey()` / `tPlural()`.
 *
 * The i18n coverage test (`i18n-coverage.test.ts`) only sees strings that are
 * already passed to a translation function, so a bare English literal handed
 * to a progress callback or a toast slips past it: it renders in English in
 * every locale and nothing fails. This scans every file in `src/` with the
 * TypeScript parser for the places such text reaches the user:
 *
 *  - progress labels: every argument of a call to `onProgress`, `progress`,
 *    `stage`, `report` or `setStatusText` (however reached: `job.onProgress?.()`,
 *    `options?.onProgress?.()`, a local `stage()` helper …);
 *  - toasts: the title (second argument) of `notify(tone, title, options)`,
 *    and the `detail` and `action.label` of its options;
 *  - job labels: the `label` of `run({ label, scope })` (`useJob`), the first
 *    argument of `runImportJob(label, task)`, and the `label` of an object
 *    assigned to `activeJob.value`.
 *
 * An expression passes when every string it can produce comes from a
 * translation call; identifiers and other calls are opaque (their text is
 * checked where it is made). A string literal, or the literal part of a
 * template, containing a letter fails — through `? :`, `+`, `??`, `||`,
 * parentheses and `as` alike. Text with no letters (`' — '`, `' '`) is fine.
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'src');

const TRANSLATORS = new Set(['t', 'translate', 'tKey', 'tPlural']);
const PROGRESS_CALLEES = new Set([
  'onProgress',
  'progress',
  'stage',
  'report',
  'setStatusText',
  'setOcrMessage'
]);
/**
 * The developer-only component gallery: loaded behind `import.meta.env.DEV`
 * (`src/ui/AppRoot.tsx`), so it never ships, and its demo copy is English on purpose.
 */
const EXEMPT_DIRS = [path.join(SRC, 'ui/dev')];
const HAS_LETTER = /\p{L}/u;

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [full] : [];
  });
}

/** The name a call is made through: `stage` for `stage()`, `onProgress` for `job.onProgress?.()`. */
function calleeName(call: ts.CallExpression): string | undefined {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return undefined;
}

/** Every untranslated, lettered literal an expression can evaluate to. */
function untranslated(node: ts.Expression): ts.Node[] {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return HAS_LETTER.test(node.text) ? [node] : [];
  }
  if (ts.isTemplateExpression(node)) {
    const literalText = [node.head.text, ...node.templateSpans.map(span => span.literal.text)];
    if (literalText.some(text => HAS_LETTER.test(text))) return [node];
    return node.templateSpans.flatMap(span => untranslated(span.expression));
  }
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    return untranslated(node.expression);
  }
  if (ts.isConditionalExpression(node)) {
    return [...untranslated(node.whenTrue), ...untranslated(node.whenFalse)];
  }
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (
      op === ts.SyntaxKind.PlusToken ||
      op === ts.SyntaxKind.QuestionQuestionToken ||
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.AmpersandAmpersandToken
    ) {
      return [...untranslated(node.left), ...untranslated(node.right)];
    }
  }
  // A translation call is the goal; any other call, identifier or property
  // read is opaque here.
  return [];
}

function property(obj: ts.Expression | undefined, name: string): ts.Expression | undefined {
  if (!obj || !ts.isObjectLiteralExpression(obj)) return undefined;
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === name) {
      return prop.initializer;
    }
  }
  return undefined;
}

interface Finding {
  where: string;
  kind: string;
  text: string;
}

/** Scans one source text; exported shape kept small so the self-test can drive it. */
function scan(fileName: string, text: string): { findings: Finding[]; sites: number } {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const findings: Finding[] = [];
  let sites = 0;
  const check = (expr: ts.Expression | undefined, what: string) => {
    if (!expr) return;
    sites++;
    for (const bad of untranslated(expr)) {
      const line = sf.getLineAndCharacterOfPosition(bad.getStart(sf)).line + 1;
      findings.push({
        where: `${fileName}:${line}`,
        kind: what,
        text: bad.getText(sf).replace(/\s+/g, ' ').slice(0, 90)
      });
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name && TRANSLATORS.has(name)) {
        // Arguments of a translation call are keys or values, not UI text.
      } else if (name && PROGRESS_CALLEES.has(name)) {
        node.arguments.forEach(arg => check(arg, `${name}() label`));
      } else if (name === 'notify' && node.arguments.length >= 2) {
        check(node.arguments[1], 'notify() title');
        const options = node.arguments[2];
        check(property(options, 'detail'), 'notify() detail');
        check(property(property(options, 'action'), 'label'), 'notify() action label');
      } else if (name === 'run' && node.arguments.length > 0) {
        check(property(node.arguments[0], 'label'), 'run() job label');
      } else if (name === 'runImportJob' && node.arguments.length > 0) {
        check(node.arguments[0], 'runImportJob() job label');
      }
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      node.left.getText(sf) === 'activeJob.value'
    ) {
      check(property(node.right, 'label'), 'activeJob label');
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { findings, sites };
}

describe('user-visible labels go through translate() (HRD-60, pattern 9)', () => {
  it('the scanner flags what it should and passes what it should', () => {
    const { findings } = scan(
      'probe.ts',
      `
      job.onProgress?.(0.5, 'Saving');
      options?.onProgress?.(0.5, \`Page \${n}\`);
      stage(0.1, cond ? translate('Ok') : 'Bad arm');
      notify('info', 'Done', { detail: 'More', action: { label: 'Undo', run } });
      run({ label: 'Working', scope: 'x' }, task);
      runImportJob('Adding', task);
      activeJob.value = { label: 'Busy', progress: null };
      job.onProgress?.(0.5, translate('Saving'));
      notify('info', translate('Done'), { detail: \`\${translate('a')} — \${tPlural('b', n)}\` });
      notify('info', file.name, { detail: err.message });
      run({ label: t(tool.commitLabel), scope: 'commit.x' }, task);
      setStatusText(t('Indexing…'));
      job.onProgress?.(0.5, label || '');
      `
    );
    expect(findings.map(f => `${f.kind}: ${f.text}`)).toEqual([
      "onProgress() label: 'Saving'",
      'onProgress() label: `Page ${n}`',
      "stage() label: 'Bad arm'",
      "notify() title: 'Done'",
      "notify() detail: 'More'",
      "notify() action label: 'Undo'",
      "run() job label: 'Working'",
      "runImportJob() job label: 'Adding'",
      "activeJob label: 'Busy'"
    ]);
  });

  it('finds no hard-coded English progress, toast or job label anywhere in src/', () => {
    const findings: Finding[] = [];
    let sites = 0;
    for (const file of sourceFiles(SRC)) {
      if (EXEMPT_DIRS.some(dir => file.startsWith(dir + path.sep))) continue;
      const result = scan(path.relative(ROOT, file), fs.readFileSync(file, 'utf8'));
      findings.push(...result.findings);
      sites += result.sites;
    }
    // The scanner really reached the code (several hundred labelled call sites).
    expect(sites).toBeGreaterThan(400);
    expect(findings.map(f => `${f.where}  ${f.kind}: ${f.text}`)).toEqual([]);
  });
});
