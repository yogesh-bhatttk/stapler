/**
 * AUDIT UI-8 — plural selection via Intl.PluralRules instead of the old
 * `{plural}` → `'s'` hack, which produced wrong grammar in every language
 * with more (Russian, Arabic) or fewer (Japanese) forms than English.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { currentLocale, registerDictionary, tPlural } from '../../src/core/i18n';

beforeAll(() => {
  registerDictionary('en', {
    '{count} pages_one': '{count} page',
    '{count} pages_other': '{count} pages',
    'Removed {count} files from {folder}_one': 'Removed one file from {folder}',
    'Removed {count} files from {folder}_other': 'Removed {count} files from {folder}'
  });
  registerDictionary('ru', {
    '{count} pages_one': '{count} страница',
    '{count} pages_few': '{count} страницы',
    '{count} pages_many': '{count} страниц',
    '{count} pages_other': '{count} страницы'
  });
  registerDictionary('ar', {
    '{count} pages_zero': 'لا صفحات',
    '{count} pages_one': 'صفحة واحدة',
    '{count} pages_two': 'صفحتان',
    '{count} pages_few': '{count} صفحات',
    '{count} pages_many': '{count} صفحة',
    '{count} pages_other': '{count} صفحة'
  });
  registerDictionary('ja', { '{count} pages_other': '{count} ページ' });
  registerDictionary('de', {});
});

afterEach(() => {
  currentLocale.value = 'en';
});

describe('tPlural', () => {
  it('picks one/other in English', () => {
    expect(tPlural('{count} pages', 1)).toBe('1 page');
    expect(tPlural('{count} pages', 0)).toBe('0 pages');
    expect(tPlural('{count} pages', 2)).toBe('2 pages');
  });

  it('uses all three Russian forms', () => {
    currentLocale.value = 'ru';
    expect(tPlural('{count} pages', 1)).toBe('1 страница');
    expect(tPlural('{count} pages', 21)).toBe('21 страница');
    expect(tPlural('{count} pages', 3)).toBe('3 страницы');
    expect(tPlural('{count} pages', 5)).toBe('5 страниц');
    expect(tPlural('{count} pages', 11)).toBe('11 страниц');
  });

  it('uses the Arabic zero, two, few and many forms', () => {
    currentLocale.value = 'ar';
    expect(tPlural('{count} pages', 0)).toBe('لا صفحات');
    expect(tPlural('{count} pages', 1)).toBe('صفحة واحدة');
    expect(tPlural('{count} pages', 2)).toBe('صفحتان');
    expect(tPlural('{count} pages', 7)).toBe('7 صفحات');
    expect(tPlural('{count} pages', 11)).toBe('11 صفحة');
  });

  it('uses the single form of a language without plurals', () => {
    currentLocale.value = 'ja';
    expect(tPlural('{count} pages', 1)).toBe('1 ページ');
    expect(tPlural('{count} pages', 9)).toBe('9 ページ');
  });

  it('falls back to English (with English rules) when the locale lacks the key', () => {
    currentLocale.value = 'de';
    expect(tPlural('{count} pages', 1)).toBe('1 page');
    expect(tPlural('{count} pages', 4)).toBe('4 pages');
  });

  it('falls back to the key itself when no dictionary has it', () => {
    expect(tPlural('{count} widgets', 3)).toBe('3 widgets');
  });

  it('substitutes extra params alongside count', () => {
    expect(tPlural('Removed {count} files from {folder}', 1, { folder: 'Scans' })).toBe(
      'Removed one file from Scans'
    );
    expect(tPlural('Removed {count} files from {folder}', 4, { folder: 'Scans' })).toBe(
      'Removed 4 files from Scans'
    );
  });
});
