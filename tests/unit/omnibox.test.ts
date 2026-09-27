import { describe, expect, test } from 'vitest';
import { TOOLS } from '../../src/core/tools';
import {
  isInternalRoute,
  matchOmniboxTools,
  omniboxRoute,
  omniboxText
} from '../../src/core/omnibox';
import { isNavigateMessage, NAVIGATE_MESSAGE } from '../../src/core/navigate-message';

/** GAP-7 — the `pdf` omnibox keyword's matching, against the real registry. */
describe('omnibox matching', () => {
  test.each([
    ['merge', 'merge'],
    ['compress', 'compress'],
    ['Compress', 'compress'],
    ['  sign  ', 'sign'],
    ['redact', 'redact'],
    ['cmprs', 'compress'],
    ['compr', 'compress'],
    ['split & extract', 'split'],
    ['pdf to word', 'pdf-to-word'],
    ['word to pdf', 'word-to-pdf'],
    ['ocr', 'ocr']
  ])('"%s" opens %s first', (text, id) => {
    expect(matchOmniboxTools(text, TOOLS)[0]?.id).toBe(id);
    expect(omniboxRoute(text, TOOLS)).toBe(`/tool/${id}`);
  });

  test('an exact tool id always wins, even with a hyphen typed as a space', () => {
    expect(matchOmniboxTools('remove blanks', TOOLS)[0]?.id).toBe('remove-blanks');
    expect(matchOmniboxTools('remove-blanks', TOOLS)[0]?.id).toBe('remove-blanks');
  });

  test('the summary is searchable, so a verb finds the tool that does it', () => {
    expect(matchOmniboxTools('rotate', TOOLS).map(tool => tool.id)).toContain('organize');
  });

  test('returns at most `limit` distinct tools', () => {
    const matches = matchOmniboxTools('pdf', TOOLS, 5);
    expect(matches.length).toBeLessThanOrEqual(5);
    expect(new Set(matches.map(tool => tool.id)).size).toBe(matches.length);
  });

  test('empty or unmatched input goes Home rather than doing nothing', () => {
    expect(matchOmniboxTools('', TOOLS)).toEqual([]);
    expect(matchOmniboxTools('   ', TOOLS)).toEqual([]);
    expect(omniboxRoute('', TOOLS)).toBe('/');
    expect(omniboxRoute('zzzzqqqq', TOOLS)).toBe('/');
  });

  test('every route it can produce is one the editor accepts', () => {
    for (const tool of TOOLS) expect(isInternalRoute(`/tool/${tool.id}`)).toBe(true);
    expect(isInternalRoute('/')).toBe(true);
    expect(isInternalRoute('/whats-new')).toBe(true);
  });
});

describe('omnibox descriptions', () => {
  test('are XML-escaped for Chrome, which parses them', () => {
    expect(omniboxText('Split & extract <b>"x"</b>', true)).toBe(
      'Split &amp; extract &lt;b&gt;&quot;x&quot;&lt;/b&gt;'
    );
  });

  test('are left as plain text for Firefox, which shows them verbatim', () => {
    expect(omniboxText('Split & extract', false)).toBe('Split & extract');
  });
});

describe('navigate message', () => {
  test('accepts only an internal route with a tab id', () => {
    expect(isNavigateMessage({ type: NAVIGATE_MESSAGE, route: '/tool/merge', tabId: 3 })).toBe(
      true
    );
    expect(isNavigateMessage({ type: NAVIGATE_MESSAGE, route: '/tool/merge' })).toBe(false);
    expect(isNavigateMessage({ type: 'other', route: '/tool/merge', tabId: 3 })).toBe(false);
    expect(
      isNavigateMessage({ type: NAVIGATE_MESSAGE, route: 'https://example.com/', tabId: 3 })
    ).toBe(false);
    expect(
      isNavigateMessage({ type: NAVIGATE_MESSAGE, route: '/tool/merge?x=javascript:', tabId: 3 })
    ).toBe(false);
    expect(isNavigateMessage(null)).toBe(false);
  });
});
