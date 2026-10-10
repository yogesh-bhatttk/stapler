// signals-core, not `@preact/signals`: every worker imports this module for
// `translate()`, and `@preact/signals` pulls the whole Preact renderer into each
// worker bundle (AMO review flagged its innerHTML sink in all six). It is the
// same `signal` — `@preact/signals` re-exports it from signals-core — so
// components that read these still re-render as before.
import { signal } from '@preact/signals-core';

export { tKey } from './key';

export const locales = [
  'en',
  'es',
  'pt-BR',
  'de',
  'fr',
  'hi',
  'id',
  'ja',
  'ru',
  'zh-CN',
  'ar'
] as const;
export type Locale = (typeof locales)[number];

const dictionaries: Record<string, Record<string, string>> = {};

/** The dictionaries a worker realm is handed with a locale message. */
export type LocaleDictionaries = Partial<Record<Locale, Record<string, string>>>;

export const currentLocale = signal<Locale>('en');
/**
 * Bumped every time a dictionary import resolves, independent of whether
 * `currentLocale.value` actually changed. `initLocale`'s default target is
 * 'en' — the same value `currentLocale` is already initialised to — so
 * `currentLocale.value = 'en'` is a no-op assignment that never notifies
 * subscribers. Any component that called `useTranslation()` and rendered
 * before the dictionary's dynamic import resolved would render with an empty
 * dictionary (falling back to the raw key) and then never re-render, since
 * nothing it read had "changed". `useTranslation` also subscribes to this
 * counter so a dictionary becoming available always triggers a re-render.
 */
export const dictionaryVersion = signal(0);

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (locales as readonly string[]).includes(value);
}

/** The loaded dictionary for `locale`, if any. */
export function getDictionary(locale: Locale): Record<string, string> | undefined {
  return dictionaries[locale];
}

/**
 * The worker-realm counterpart of `setLocale` (`./load.ts`, AUDIT UI-8):
 * installs the dictionaries the page sent and makes `locale` current for
 * `translate` / `tPlural`, without the `document` / `localStorage` side
 * effects a worker does not have.
 *
 * This module deliberately imports no dictionary itself — every worker bundles
 * it, and a dictionary `import()` here put a second copy of every locale into
 * the package. The page loads them (`./load.ts`) and sends `locale`'s and
 * English (the `tPlural` fallback) with the message; a dictionary sent once
 * stays installed, so a later message may omit it. Resolves false (leaving the
 * current locale in place) for an unknown locale or one whose dictionary was
 * neither sent now nor earlier.
 */
export async function loadLocale(locale: string, sent: LocaleDictionaries = {}): Promise<boolean> {
  if (!isLocale(locale)) return false;
  for (const name of locales) {
    const dict = sent[name];
    if (dict) dictionaries[name] = dict;
  }
  if (!dictionaries[locale]) return false;
  currentLocale.value = locale;
  dictionaryVersion.value++;
  return true;
}

/** The writing direction of a locale's script. */
export function localeDirection(locale: Locale): 'rtl' | 'ltr' {
  return locale === 'ar' ? 'rtl' : 'ltr';
}

export type TranslationParams = Record<string, string | number>;

export function useTranslation() {
  const locale = currentLocale.value;
  void locale;
  // Read (not just referenced) so a dictionary finishing its async load always
  // schedules a re-render, even on the 'en' default where `currentLocale`
  // itself never changes value — see the comment on `dictionaryVersion`.
  void dictionaryVersion.value;

  return function t(key: string, params?: TranslationParams): string {
    return translate(key, params);
  };
}

/**
 * Non-reactive translation for use outside of React components.
 * Returns the translation for the current locale immediately.
 *
 * `key` must be a static string — a stable dictionary lookup key, never a
 * template literal built from user data (`` `Saved ${doc.name}` ``). An
 * interpolated key can never match a dictionary entry (each call produces a
 * different string), so it silently falls straight through to whatever
 * English text the interpolation happened to produce, in every locale. Pass
 * variable data through `params` instead — `translate('Saved {name}', {
 * name: doc.name })` — and it's substituted into whichever string resolves
 * (current locale, English fallback, or the raw key), so translation is at
 * least *possible* once a dictionary entry for the key exists.
 */
export function translate(key: string, params?: TranslationParams): string {
  const locale = currentLocale.value;
  const dict = dictionaries[locale];
  const resolved = dict && key in dict ? dict[key] : dictionaries['en']?.[key];
  return interpolate(resolved ?? key, params);
}

const pluralRulesCache = new Map<string, Intl.PluralRules>();

function pluralCategory(locale: string, count: number): Intl.LDMLPluralRule {
  let rules = pluralRulesCache.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(locale);
    pluralRulesCache.set(locale, rules);
  }
  return rules.select(count);
}

/**
 * Count-dependent translation (AUDIT UI-8). Replaces the old
 * `{plural}` → `'s'` hack, which only ever worked for English: Russian needs
 * three forms, Arabic six, Japanese one.
 *
 * `key` is the English "other" form (`'{count} pages'`). Dictionaries hold one
 * entry per CLDR plural category the language uses, suffixed with the
 * category — `'{count} pages_one'`, `'{count} pages_other'`, and in `ru.json`
 * also `_few` / `_many`, in `ar.json` `_zero` / `_two` / `_few` / `_many`. The
 * category is chosen with `Intl.PluralRules` for the active locale; a missing
 * category falls back to `_other`, then to English, then to the key itself.
 * `{count}` is always available to the template.
 */
export function tPlural(key: string, count: number, params?: TranslationParams): string {
  const locale = currentLocale.value;
  const values: TranslationParams = { count, ...params };
  const lookups: [string, Record<string, string> | undefined][] = [
    [locale, dictionaries[locale]],
    ['en', dictionaries['en']]
  ];
  for (const [lang, dict] of lookups) {
    if (!dict) continue;
    const hit = dict[`${key}_${pluralCategory(lang, count)}`] ?? dict[`${key}_other`];
    if (hit !== undefined) return interpolate(hit, values);
  }
  return interpolate(key, values);
}

/** Test seam: install a dictionary without going through the dynamic import. */
export function registerDictionary(locale: string, dict: Record<string, string>): void {
  dictionaries[locale] = dict;
}

function interpolate(text: string, params?: TranslationParams): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (match, name) =>
    name in params ? String(params[name]) : match
  );
}
