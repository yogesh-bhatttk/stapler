/**
 * Each language's name in that language (AUDIT-2026-10-10 UI28). The picker
 * listed raw codes — "PT-BR", "AR" — which name nothing to someone who does not
 * already know them, and a language picker must be readable by a person who
 * cannot read the current UI language. Fixed rather than `Intl.DisplayNames`,
 * whose autonyms vary by engine ("Indonesia", "中文（中国）").
 */
import type { Locale } from '../core/i18n';

export const LOCALE_AUTONYMS: Readonly<Record<Locale, string>> = {
  en: 'English',
  es: 'Español',
  'pt-BR': 'Português (Brasil)',
  de: 'Deutsch',
  fr: 'Français',
  hi: 'हिन्दी',
  id: 'Bahasa Indonesia',
  ja: '日本語',
  ru: 'Русский',
  'zh-CN': '简体中文',
  ar: 'العربية'
};
