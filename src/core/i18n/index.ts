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

  if (locale === 'ar') {
    document.documentElement.dir = 'rtl';
  } else {
    document.documentElement.dir = 'ltr';
  }
}

export function initLocale(savedLocale?: string) {
  let target = 'en';
  if (savedLocale && locales.includes(savedLocale as Locale)) {
    target = savedLocale;
  } else if (navigator.language) {
    const browserLang = navigator.language.split('-')[0];
    if (locales.includes(browserLang as Locale)) {
      target = browserLang;
    }
  }

  setLocale(target as Locale);
}

export function useTranslation() {
  const locale = currentLocale.value;

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
