import { signal } from '@preact/signals';

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

export async function setLocale(locale: Locale) {
  let loaded = Boolean(dictionaries[locale]);
  if (!loaded) {
    try {
      const dict = await import(`./locales/${locale}.json`);
      dictionaries[locale] = dict.default || dict;
      loaded = true;
    } catch {
      console.warn(`Failed to load locale: ${locale}`);
    }
  }

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

function interpolate(text: string, params?: TranslationParams): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (match, name) =>
    name in params ? String(params[name]) : match
  );
}
