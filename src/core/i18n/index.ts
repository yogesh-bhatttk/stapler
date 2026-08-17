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
  if (!dictionaries[locale]) {
    try {
      const dict = await import(`./locales/${locale}.json`);
      dictionaries[locale] = dict.default || dict;
    } catch {
      console.warn(`Failed to load locale: ${locale}`);
    }
  }

  currentLocale.value = locale;
  dictionaryVersion.value++;
  localStorage.setItem(LOCALE_STORAGE_KEY, locale);

  if (locale === 'ar') {
    document.documentElement.dir = 'rtl';
  } else {
    document.documentElement.dir = 'ltr';
  }
}

export function initLocale(savedLocale?: string) {
  const persisted = savedLocale ?? localStorage.getItem(LOCALE_STORAGE_KEY) ?? undefined;
  let target = 'en';
  if (persisted && locales.includes(persisted as Locale)) {
    target = persisted;
  } else if (navigator.language) {
    const exactBrowserLocale = locales.find(
      locale => locale.toLowerCase() === navigator.language.toLowerCase()
    );
    const browserLang = navigator.language.split('-')[0];
    if (exactBrowserLocale) {
      target = exactBrowserLocale;
    } else if (locales.includes(browserLang as Locale)) {
      target = browserLang;
    }
  }

  return setLocale(target as Locale);
}

export function useTranslation() {
  const locale = currentLocale.value;
  // Read (not just referenced) so a dictionary finishing its async load always
  // schedules a re-render, even on the 'en' default where `currentLocale`
  // itself never changes value — see the comment on `dictionaryVersion`.
  void dictionaryVersion.value;

  return function t(key: string): string {
    const dict = dictionaries[locale];
    if (dict && key in dict) {
      return dict[key];
    }

    if (dictionaries['en'] && key in dictionaries['en']) {
      return dictionaries['en'][key];
    }

    return key;
  };
}
