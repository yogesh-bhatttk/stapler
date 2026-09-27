import { signal } from '@preact/signals';

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

export const currentLocale = signal<Locale>('en');
const LOCALE_STORAGE_KEY = 'stapler.locale';
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

/**
 * Imports `locale`'s dictionary if it is not already loaded. Touches neither
 * the DOM nor storage, so it runs in a worker realm too (AUDIT UI-8).
 */
async function loadDictionary(locale: Locale): Promise<boolean> {
  if (dictionaries[locale]) return true;
  try {
    const dict = await import(`./locales/${locale}.json`);
    dictionaries[locale] = dict.default || dict;
    return true;
  } catch {
    console.warn(`Failed to load locale: ${locale}`);
    return false;
  }
}

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (locales as readonly string[]).includes(value);
}

/**
 * The worker-realm counterpart of {@link setLocale} (AUDIT UI-8): loads the
 * dictionary and makes it current for `translate` / `tPlural`, without the
 * `document` / `localStorage` side effects a worker does not have.
 *
 * English is loaded as well, whatever the target: `tPlural` falls back to the
 * English plural forms, and without them a count of one would read "1 pages".
 * Resolves false (leaving the current locale in place) for an unknown locale
 * or a dictionary that failed to load.
 */
export async function loadLocale(locale: string): Promise<boolean> {
  if (!isLocale(locale)) return false;
  const [loaded] = await Promise.all([
    loadDictionary(locale),
    locale === 'en' ? Promise.resolve(true) : loadDictionary('en')
  ]);
  if (!loaded) return false;
  currentLocale.value = locale;
  dictionaryVersion.value++;
  return true;
}

export async function setLocale(locale: Locale) {
  const loaded = await loadDictionary(locale);

  if (!loaded) {
    // Setting `currentLocale` here anyway would leave every `t()` call
    // rendering its raw key (no dictionary loaded) while everything *looks*
    // switched to `locale` — silently wrong, with nothing telling the caller
    // it failed. Leaving whatever locale was already in effect is the honest
    // answer when there is no dictionary to switch to.
    return;
  }

  currentLocale.value = locale;
  dictionaryVersion.value++;
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Safari private browsing (historically a 0-byte quota) and similar
    // hardened environments can throw here. The locale still applies for
    // this session; it just won't be remembered for the next one.
  }

  if (locale === 'ar') {
    document.documentElement.dir = 'rtl';
  } else {
    document.documentElement.dir = 'ltr';
  }
  // Screen readers pick their voice, and browsers their CJK glyph variants,
  // from `lang`; it stayed "en" for every locale (WCAG 3.1.1, AUDIT UI-21).
  document.documentElement.lang = locale;
}

export function initLocale(savedLocale?: string) {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    // Same hardened-environment throw `setLocale` guards against below.
  }
  const persisted = savedLocale ?? stored ?? undefined;
  let target = 'en';
  if (persisted && locales.includes(persisted as Locale)) {
    target = persisted;
  } else if (navigator.language) {
    const exactBrowserLocale = locales.find(
      locale => locale.toLowerCase() === navigator.language.toLowerCase()
    );
    const browserLang = navigator.language.split('-')[0].toLowerCase();
    if (exactBrowserLocale) {
      target = exactBrowserLocale;
    } else {
      const fallback = locales.find(locale => locale.toLowerCase().startsWith(browserLang));
      if (fallback) {
        target = fallback;
      }
    }
  }

  return setLocale(target as Locale);
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
