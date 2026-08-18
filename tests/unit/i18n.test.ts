import { beforeEach, describe, expect, it } from 'vitest';
import { currentLocale, translate, useTranslation } from '../../src/core/i18n';

/**
 * NFR-04 — `translate()` interpolation.
 *
 * A prior pass wrapped call sites like `notify('success', translate(\`Saved
 * ${doc.name}\`))` — the template literal is evaluated before `translate` ever
 * sees it, so the dictionary lookup key is a different string on every call
 * and can never match a translation entry. Every one of those notifications
 * was English-only in every locale, regardless of the wrapping. `translate`
 * now takes a stable key plus a `params` object and substitutes into
 * whichever string resolves (current locale, English fallback, or the raw
 * key), so a dictionary entry for the key is at least reachable.
 */
describe('translate params substitution', () => {
  beforeEach(() => {
    currentLocale.value = 'en';
  });

  it('substitutes a param into the raw key when no dictionary entry exists', () => {
    expect(translate('Saved {name}', { name: 'contract.pdf' })).toBe('Saved contract.pdf');
  });

  it('substitutes multiple params', () => {
    expect(
      translate('Inserted {count} page(s) at position {position}.', { count: 3, position: 5 })
    ).toBe('Inserted 3 page(s) at position 5.');
  });

  it('leaves an unmatched placeholder untouched rather than throwing', () => {
    expect(translate('Saved {name}', {})).toBe('Saved {name}');
  });

  it('returns the key verbatim when called with no params', () => {
    expect(translate('Plain text with no placeholders')).toBe('Plain text with no placeholders');
  });

  it('does not treat two calls with different data as two different translatable strings', () => {
    // This is the actual bug: with the old `` translate(`Saved ${x}`) `` shape,
    // these would have been two entirely different dictionary keys.
    const a = translate('Saved {name}', { name: 'a.pdf' });
    const b = translate('Saved {name}', { name: 'b.pdf' });
    expect(a).toBe('Saved a.pdf');
    expect(b).toBe('Saved b.pdf');
  });

  it('useTranslation()’s t() also accepts params', () => {
    const t = useTranslation();
    expect(t('Reduced by {percent}%', { percent: 42 })).toBe('Reduced by 42%');
  });
});
