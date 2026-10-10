/**
 * Main-thread dictionary loading: the only module that imports
 * `./locales/*.json`.
 *
 * Kept apart from `./index.ts` on purpose. Every worker imports `./index.ts`
 * (for `translate`), and each worker graph is a separate Rollup build: when the
 * dictionary `import()` lived there, every locale was emitted twice — once
 * for the page graph and once for the workers, under different hashes — 3.6 MB
 * of duplicate JSON in the package. Workers now receive the dictionaries they
 * need from the page with the locale message (`workers/client.ts` →
 * `loadLocale(locale, dictionaries)`), so no worker bundle carries a
 * translation. `tests/unit/audit-2026-10-10-bundle.test.ts` fails if a worker
 * entry can reach this module again.
 */
import {
  currentLocale,
  dictionaryVersion,
  getDictionary,
  localeDirection,
  locales,
  registerDictionary,
  type Locale,
  type LocaleDictionaries
} from './index';

const LOCALE_STORAGE_KEY = 'stapler.locale';

/**
 * Imports `locale`'s dictionary if it is not already loaded. Resolves false
 * (after a console warning) when the import fails.
 */
async function loadDictionary(locale: Locale): Promise<boolean> {
  if (getDictionary(locale)) return true;
  try {
    const dict = (await import(`./locales/${locale}.json`)) as {
      default?: Record<string, string>;
    } & Record<string, string>;
    registerDictionary(locale, (dict.default ?? dict) as Record<string, string>);
    return true;
  } catch {
    console.warn(`Failed to load locale: ${locale}`);
    return false;
  }
}

/**
 * The dictionaries a worker needs to speak `locale`: its own and English
 * (`tPlural` falls back to the English plural forms, and without them a count
 * of one would read "1 pages"). Loads whichever are missing. Resolves null
 * when `locale`'s own dictionary cannot be loaded.
 */
export async function localeDictionaries(locale: Locale): Promise<LocaleDictionaries | null> {
  const wanted: Locale[] = locale === 'en' ? ['en'] : [locale, 'en'];
  const loaded = await Promise.all(wanted.map(loadDictionary));
  if (!loaded[0]) return null;
  const out: LocaleDictionaries = {};
  for (const name of wanted) {
    const dict = getDictionary(name);
    if (dict) out[name] = dict;
  }
  return out;
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

  const root = localeRoot ?? document.documentElement;
  root.dir = localeDirection(locale);
  // Screen readers pick their voice, and browsers their CJK glyph variants,
  // from `lang`; it stayed "en" for every locale (WCAG 3.1.1, AUDIT UI-21).
  root.lang = locale;
}

/**
 * The element whose `lang`/`dir` follow the app locale. `null` (the default) is
 * `<html>`. A landing page's hero, title and description are static English
 * HTML, so marking the whole document Arabic/RTL there mislabelled them; the
 * landing bootstrap scopes the locale to the app's mount point instead
 * (AUDIT-2026-10-10 UI14).
 */
let localeRoot: HTMLElement | null = null;

export function setLocaleRoot(element: HTMLElement | null): void {
  localeRoot = element;
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
