import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * AUDIT-2026-09-25 GAP-10 — read-aloud basics: sentence/word ranges for
 * highlighting (mapped from `boundary` charIndex), and the remembered voice
 * and rate, persisted through the app's own settings store (`core/db.ts`).
 */
const settings = new Map<string, unknown>();
vi.mock('../../src/core/db', () => ({
  readSetting: vi.fn(async (key: string) => settings.get(key)),
  writeSetting: vi.fn(async (key: string, value: unknown) => {
    settings.set(key, value);
  })
}));

const { splitSentences, wordRangeAt, clampSentence } =
  await import('../../src/ui/tools/read-aloud/sentences');
const state = await import('../../src/ui/tools/read-aloud/state');

const slice = (text: string, r: { start: number; end: number }) => text.slice(r.start, r.end);

describe('splitSentences', () => {
  it('splits on sentence punctuation and trims each range', () => {
    const text = 'First sentence. Second one?  Third!';
    expect(splitSentences(text, 'en').map(r => slice(text, r))).toEqual([
      'First sentence.',
      'Second one?',
      'Third!'
    ]);
  });

  it('keeps a trailing fragment without punctuation', () => {
    const text = 'One. And then some';
    expect(splitSentences(text, 'en').map(r => slice(text, r))).toEqual(['One.', 'And then some']);
  });

  it('handles CJK full stops', () => {
    const text = '最初の文です。二番目の文です。';
    expect(splitSentences(text, 'ja')).toHaveLength(2);
  });

  it('returns nothing for empty or whitespace-only text', () => {
    expect(splitSentences('', 'en')).toEqual([]);
    expect(splitSentences('   ', 'en')).toEqual([]);
  });

  it('works without Intl.Segmenter (the punctuation fallback)', () => {
    const original = Intl.Segmenter;
    // Simulates a runtime without Intl.Segmenter.
    Object.defineProperty(Intl, 'Segmenter', { value: undefined, configurable: true });
    try {
      const text = 'Alpha beta. Gamma!  Delta';
      expect(splitSentences(text).map(r => slice(text, r))).toEqual([
        'Alpha beta.',
        'Gamma!',
        'Delta'
      ]);
    } finally {
      Object.defineProperty(Intl, 'Segmenter', { value: original, configurable: true });
    }
  });

  it('never produces overlapping or out-of-bounds ranges', () => {
    const text = 'A. B. C? D! E';
    const ranges = splitSentences(text, 'en');
    for (let i = 0; i < ranges.length; i++) {
      expect(ranges[i].start).toBeGreaterThanOrEqual(0);
      expect(ranges[i].end).toBeLessThanOrEqual(text.length);
      if (i > 0) expect(ranges[i].start).toBeGreaterThanOrEqual(ranges[i - 1].end);
    }
  });
});

describe('wordRangeAt — mapping a boundary charIndex into the page text', () => {
  const text = 'Hello there. General Kenobi speaks.';
  const [, second] = splitSentences(text, 'en');

  it('offsets by the sentence start and uses charLength when given', () => {
    // The utterance text is the second sentence; "Kenobi" is at 8 in it.
    const range = wordRangeAt(text, second, 8, 6)!;
    expect(slice(text, range)).toBe('Kenobi');
  });

  it('falls back to the next whitespace without charLength (Firefox, Safari)', () => {
    expect(slice(text, wordRangeAt(text, second, 0)!)).toBe('General');
    expect(slice(text, wordRangeAt(text, second, 15)!)).toBe('speaks.');
  });

  it('clamps charLength to the sentence and rejects indexes outside it', () => {
    expect(wordRangeAt(text, second, 15, 999)!.end).toBe(second.end);
    expect(wordRangeAt(text, second, 999)).toBeNull();
    expect(wordRangeAt(text, second, -1)).toBeNull();
    expect(wordRangeAt(text, second, Number.NaN)).toBeNull();
  });

  it('clampSentence keeps an index in range', () => {
    expect(clampSentence(5, 3)).toBe(2);
    expect(clampSentence(-1, 3)).toBe(0);
    expect(clampSentence(2, 0)).toBe(0);
  });
});

describe('remembered voice and rate', () => {
  beforeEach(() => {
    settings.clear();
    state.__resetReadAloudPreferencesForTests();
    vi.useRealTimers();
  });

  it('loads a saved rate and voice', async () => {
    settings.set('readAloud.rate', 1.5);
    settings.set('readAloud.voiceUri', 'uri:eSpeak English');
    await state.loadReadAloudPreferences();
    expect(state.readAloudRate.value).toBe(1.5);
    expect(state.readAloudVoiceUri.value).toBe('uri:eSpeak English');
  });

  it('clamps a stored rate into 0.5–2 and ignores junk', async () => {
    settings.set('readAloud.rate', 9);
    settings.set('readAloud.voiceUri', 42);
    await state.loadReadAloudPreferences();
    expect(state.readAloudRate.value).toBe(2);
    expect(state.readAloudVoiceUri.value).toBeNull();
  });

  it('persists the voice at once and the rate once the slider settles', async () => {
    vi.useFakeTimers();
    state.setReadAloudVoice('uri:x');
    expect(settings.get('readAloud.voiceUri')).toBe('uri:x');
    state.setReadAloudRate(1.2);
    state.setReadAloudRate(1.25);
    state.setReadAloudRate(1.3);
    expect(state.readAloudRate.value).toBe(1.3);
    expect(settings.has('readAloud.rate')).toBe(false);
    await vi.advanceTimersByTimeAsync(400);
    expect(settings.get('readAloud.rate')).toBe(1.3);
  });

  it('a choice made before the saved preferences load is not overwritten', async () => {
    settings.set('readAloud.voiceUri', 'uri:old');
    state.setReadAloudVoice('uri:new');
    await state.loadReadAloudPreferences();
    expect(state.readAloudVoiceUri.value).toBe('uri:new');
  });

  it('never touches chrome.storage', () => {
    const source = String(state.loadReadAloudPreferences) + String(state.setReadAloudRate);
    expect(source).not.toMatch(/chrome\./);
  });
});
