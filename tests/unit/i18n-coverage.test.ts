/**
 * AUDIT-2026-09-25 UI-8 — every translation key the code uses exists in every
 * locale, and every locale says the same thing with the same placeholders.
 *
 * NFR-04 was marked Done while 383 of the keys passed to `t()` existed in no
 * locale file at all: `translate()` falls back to the raw key, which is
 * English, so a missing key never breaks anything visibly in English and
 * nothing failed. This test extracts keys statically from `src/` with the
 * TypeScript parser — every string literal (including `'a' + 'b'`
 * concatenations and both arms of a `cond ? 'a' : 'b'`) passed as the first
 * argument to `t`, `translate`, `tKey` or `tPlural` — and checks them against
 * the dictionaries.
 *
 * Keys that only reach `t()` through a variable (`t(option.label)`) are
 * covered by marking them with `tKey('…')` where they are defined.
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { locales } from '../../src/core/i18n';

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'src');
const LOCALE_DIR = path.join(SRC, 'core/i18n/locales');
const KEY_FUNCTIONS = new Set(['t', 'translate', 'tKey', 'tPlural']);
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;
/**
 * Spanish, French and Portuguese report a `many` category, but CLDR uses it
 * only for compact exact millions ("1 million de pages"); `tPlural` falls back
 * to `_other` for it, which is the correct text there.
 */
const OPTIONAL_CATEGORIES: Record<string, string[]> = {
  es: ['many'],
  fr: ['many'],
  'pt-BR': ['many']
};

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [full] : [];
  });
}

/** Every string an expression can statically evaluate to, or null if any arm is dynamic. */
function resolveStrings(node: ts.Expression): string[] | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isParenthesizedExpression(node)) return resolveStrings(node.expression);
  if (ts.isConditionalExpression(node)) {
    const whenTrue = resolveStrings(node.whenTrue);
    const whenFalse = resolveStrings(node.whenFalse);
    return whenTrue && whenFalse ? [...whenTrue, ...whenFalse] : null;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = resolveStrings(node.left);
    const right = resolveStrings(node.right);
    return left && right ? left.flatMap(a => right.map(b => a + b)) : null;
  }
  return null;
}

interface Extracted {
  /** Plain keys → first place each is used. */
  keys: Map<string, string>;
  /** Plural base keys → first place each is used. */
  plurals: Map<string, string>;
  /** Calls whose key is a template literal with substitutions — never translatable. */
  interpolatedKeys: string[];
}

function extractKeys(): Extracted {
  const keys = new Map<string, string>();
  const plurals = new Map<string, string>();
  const interpolatedKeys: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const text = fs.readFileSync(file, 'utf8');
    const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
    const where = (node: ts.Node) =>
      `${path.relative(ROOT, file)}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        KEY_FUNCTIONS.has(node.expression.text) &&
        node.arguments.length > 0
      ) {
        const arg = node.arguments[0];
        const resolved = resolveStrings(arg);
        if (resolved) {
          const target = node.expression.text === 'tPlural' ? plurals : keys;
          for (const key of resolved) if (!target.has(key)) target.set(key, where(node));
        } else if (ts.isTemplateExpression(arg)) {
          interpolatedKeys.push(`${where(node)} ${arg.getText().slice(0, 80)}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { keys, plurals, interpolatedKeys };
}

function loadLocale(locale: string): Record<string, string> {
  return JSON.parse(fs.readFileSync(path.join(LOCALE_DIR, `${locale}.json`), 'utf8')) as Record<
    string,
    string
  >;
}

function placeholders(text: string): string[] {
  return [...new Set([...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]))].sort();
}

const extracted = extractKeys();
const dictionaries = Object.fromEntries(locales.map(locale => [locale, loadLocale(locale)]));
const en = dictionaries.en;

/** The keys every locale must have: plain keys, plus `_one`/`_other` per plural. */
function requiredKeys(dict: Record<string, string>): string[] {
  return Object.keys(dict).filter(key => {
    const match = PLURAL_SUFFIX.exec(key);
    if (!match) return true;
    return match[1] === 'one' || match[1] === 'other';
  });
}

describe('i18n key coverage (UI-8)', () => {
  it('finds a plausible number of keys (the extractor itself works)', () => {
    expect(extracted.keys.size).toBeGreaterThan(500);
    expect(extracted.plurals.size).toBeGreaterThan(5);
  });

  it('never builds a key from a template literal with substitutions', () => {
    expect(extracted.interpolatedKeys).toEqual([]);
  });

  it('has every key used in src/ in en.json', () => {
    const missing = [...extracted.keys].filter(([key]) => !(key in en));
    expect(missing.map(([key, where]) => `${where}  ${key}`)).toEqual([]);
  });

  it('has _one and _other forms in en.json for every tPlural key', () => {
    const missing = [...extracted.plurals].flatMap(([key, where]) =>
      ['one', 'other'].filter(cat => !(`${key}_${cat}` in en)).map(cat => `${where}  ${key}_${cat}`)
    );
    expect(missing).toEqual([]);
  });

  it('keeps plural keys out of the plain-key namespace and vice versa', () => {
    const clash = [...extracted.plurals.keys()].filter(key => extracted.keys.has(key));
    expect(clash).toEqual([]);
  });

  for (const locale of locales.filter(l => l !== 'en')) {
    describe(locale, () => {
      const dict = dictionaries[locale];

      it('has exactly the same base key set as en.json', () => {
        const enKeys = new Set(requiredKeys(en));
        const localeKeys = new Set(requiredKeys(dict));
        expect([...enKeys].filter(key => !localeKeys.has(key)).sort()).toEqual([]);
        expect([...localeKeys].filter(key => !enKeys.has(key)).sort()).toEqual([]);
      });

      it('has every plural category its language needs, and no others', () => {
        const categories = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
        const optional = OPTIONAL_CATEGORIES[locale] ?? [];
        const problems: string[] = [];
        for (const base of extracted.plurals.keys()) {
          for (const cat of categories) {
            if (!optional.includes(cat) && !(`${base}_${cat}` in dict)) {
              problems.push(`missing ${base}_${cat}`);
            }
          }
        }
        for (const key of Object.keys(dict)) {
          const match = PLURAL_SUFFIX.exec(key);
          if (!match || match[1] === 'one' || match[1] === 'other') continue;
          const base = key.slice(0, match.index);
          if (!categories.includes(match[1] as Intl.LDMLPluralRule)) {
            problems.push(`unused category ${key}`);
          } else if (!(`${base}_other` in dict)) {
            problems.push(`${key} without ${base}_other`);
          }
        }
        expect(problems).toEqual([]);
      });

      it('keeps the {placeholders} of every string', () => {
        const mismatched: string[] = [];
        for (const [key, value] of Object.entries(dict)) {
          const match = PLURAL_SUFFIX.exec(key);
          if (match) {
            // A plural form may drop {count} ("no pages" for Arabic zero), but
            // must not invent a placeholder the English template lacks.
            const reference = en[`${key.slice(0, match.index)}_other`];
            if (reference === undefined) continue;
            const allowed = new Set(placeholders(reference));
            const extra = placeholders(value).filter(name => !allowed.has(name));
            const lost = placeholders(reference).filter(
              name => name !== 'count' && !placeholders(value).includes(name)
            );
            if (extra.length || lost.length) mismatched.push(`${key}: ${value}`);
          } else if (key in en) {
            const expected = placeholders(en[key]);
            if (JSON.stringify(placeholders(value)) !== JSON.stringify(expected)) {
              mismatched.push(`${key}: ${value}`);
            }
          }
        }
        expect(mismatched).toEqual([]);
      });

      it('has no empty strings', () => {
        expect(Object.keys(dict).filter(key => !dict[key].trim())).toEqual([]);
      });
    });
  }

  it('keeps en.json placeholders identical to the key for English-text keys', () => {
    const mismatched = Object.entries(en).filter(([key, value]) => {
      if (PLURAL_SUFFIX.test(key) || !/\s/.test(key)) return false; // symbolic or plural key
      return JSON.stringify(placeholders(key)) !== JSON.stringify(placeholders(value));
    });
    expect(mismatched).toEqual([]);
  });
});
