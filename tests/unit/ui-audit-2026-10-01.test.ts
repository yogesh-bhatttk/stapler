import { describe, expect, it } from 'vitest';
import { MAX_UTTERANCE_CHARS, splitSentences } from '../../src/ui/tools/read-aloud/sentences';
import { pickLocalVoice, preferredVoiceMissing } from '../../src/ui/tools/read-aloud/voices';
import {
  fitZoomFor,
  isDifferentDocument,
  zoomContextKey
} from '../../src/ui/shell/single-page-zoom';
import { pageIndexInRange, parsePageRange, rangeSelectsNothing } from '../../src/core/page-range';
import { pageInRange } from '../../src/ui/tools/watermark/state';

/** AUDIT-2026-10-01 — UI findings with pure, testable cores. */

const slice = (text: string) => splitSentences(text, 'en').map(r => text.slice(r.start, r.end));

describe('UI-4 — sentence splitting for read-aloud', () => {
  it('does not split after titles, initials and mid-sentence abbreviations', () => {
    expect(slice('Dr. Smith met Mr. Jones at 3 p.m. on Jan. 5. It went well.')).toEqual([
      'Dr. Smith met Mr. Jones at 3 p.m. on Jan. 5.',
      'It went well.'
    ]);
    expect(slice('J. R. R. Tolkien wrote it. Mrs. Dalloway, e.g. the novel, too.')).toEqual([
      'J. R. R. Tolkien wrote it.',
      'Mrs. Dalloway, e.g. the novel, too.'
    ]);
  });

  it('still ends a sentence at "p.m." or "etc." when a new sentence starts', () => {
    expect(slice('It ends at 5 p.m. Then we go home.')).toEqual([
      'It ends at 5 p.m.',
      'Then we go home.'
    ]);
    expect(slice('Pens, paper, etc. Bring them.')).toEqual(['Pens, paper, etc.', 'Bring them.']);
  });

  it('caps every utterance, breaking at whitespace or a comma', () => {
    const table = 'Cell value '.repeat(80).trim();
    const pieces = splitSentences(table, 'en');
    expect(pieces.length).toBeGreaterThan(1);
    for (const r of pieces) {
      expect(r.end - r.start).toBeLessThanOrEqual(MAX_UTTERANCE_CHARS);
      // Never mid-word.
      expect(/\s/.test(table[r.start - 1] ?? ' ')).toBe(true);
      expect(/\s/.test(table[r.end] ?? ' ')).toBe(true);
    }
    // Nothing lost: the pieces cover every word.
    expect(pieces.map(r => table.slice(r.start, r.end)).join(' ')).toBe(table);

    const commas = Array.from({ length: 60 }, (_, i) => `item${i}`).join(', ');
    for (const r of splitSentences(commas, 'en')) {
      expect(r.end - r.start).toBeLessThanOrEqual(MAX_UTTERANCE_CHARS);
    }
  });

  it('keeps CJK and RTL text working, and caps text with no spaces at all', () => {
    const zh = '這是第一句。這是第二句！第三句？';
    expect(splitSentences(zh, 'zh').map(r => zh.slice(r.start, r.end))).toEqual([
      '這是第一句。',
      '這是第二句！',
      '第三句？'
    ]);
    const ar = 'مرحبا بك. كيف حالك؟ أنا بخير.';
    expect(splitSentences(ar, 'ar')).toHaveLength(3);
    const long = '字'.repeat(600);
    const pieces = splitSentences(long, 'zh');
    expect(pieces.every(r => r.end - r.start <= MAX_UTTERANCE_CHARS)).toBe(true);
    expect(pieces.reduce((n, r) => n + (r.end - r.start), 0)).toBe(600);
  });

  it('never splits a surrogate pair at a hard cut', () => {
    const emoji = '😀'.repeat(300);
    for (const r of splitSentences(emoji, 'en')) {
      const code = emoji.charCodeAt(r.start);
      expect(code >= 0xdc00 && code <= 0xdfff).toBe(false);
    }
  });
});

describe('ACC-04 — a remembered voice that is no longer installed', () => {
  const voice = (voiceURI: string, extra: Partial<SpeechSynthesisVoice> = {}) =>
    ({
      voiceURI,
      name: voiceURI,
      lang: 'en-US',
      localService: true,
      default: false,
      ...extra
    }) as SpeechSynthesisVoice;

  it('is reported, and the fallback voice is still picked', () => {
    const voices = [voice('a'), voice('b', { default: true })];
    expect(preferredVoiceMissing(voices, 'gone')).toBe(true);
    expect(pickLocalVoice(voices, 'gone', 'en')?.voiceURI).toBe('b');
  });

  it('is not reported for an installed voice, no saved voice, or before voices load', () => {
    const voices = [voice('a')];
    expect(preferredVoiceMissing(voices, 'a')).toBe(false);
    expect(preferredVoiceMissing(voices, null)).toBe(false);
    expect(preferredVoiceMissing([], 'a')).toBe(false);
  });

  it('counts a saved voice that is now a network voice as missing', () => {
    expect(preferredVoiceMissing([voice('a'), voice('net', { localService: false })], 'net')).toBe(
      true
    );
  });
});

describe('UI-6/UI-7 — single-page zoom rules', () => {
  it('fits the page and floors to a whole percent, so a drag yields few distinct zooms', () => {
    expect(fitZoomFor({ width: 600, height: 800 }, 612, 792)).toBe(0.98);
    const zooms = new Set<number>();
    for (let w = 600; w < 606; w++) zooms.add(fitZoomFor({ width: w, height: 2000 }, 612, 792));
    expect(zooms.size).toBeLessThanOrEqual(2);
    expect(fitZoomFor({ width: 0, height: 0 }, 612, 792)).toBe(1);
  });

  it('treats an edited page list as the same document, a disjoint one as another', () => {
    const a = [{ key: '1' }, { key: '2' }, { key: '3' }];
    expect(isDifferentDocument(a, a)).toBe(false);
    expect(isDifferentDocument(a, [a[2], a[0]])).toBe(false);
    expect(isDifferentDocument(a, [{ key: 'x' }])).toBe(true);
    expect(isDifferentDocument([], a)).toBe(true);
  });

  it('keys a manual zoom on document, displayed size and rotation', () => {
    const base = zoomContextKey(0, 612, 792, 0);
    expect(zoomContextKey(0, 612, 792, 0)).toBe(base);
    expect(zoomContextKey(1, 612, 792, 0)).not.toBe(base);
    expect(zoomContextKey(0, 792, 612, 90)).not.toBe(base);
    expect(zoomContextKey(0, 612, 792, 180)).not.toBe(base);
  });
});

describe('X-7 — one page-range parser for preview and export', () => {
  const N = 5;
  const preview = (range: string) =>
    Array.from({ length: N }, (_, i) => i).filter(i => pageInRange(range, i));
  const exported = (range: string) => {
    const set = parsePageRange(range, N);
    return set === null ? [0, 1, 2, 3, 4] : [...set].sort((x, y) => x - y);
  };

  it.each([
    '',
    ' ',
    '  ',
    'all',
    'ALL',
    '1-3, 5',
    '3-1',
    '0',
    '-',
    '1-3,',
    ',',
    '9',
    '4-99',
    '1–3',
    ' 2 ',
    '1;2',
    'x'
  ])('preview and export agree for %j', range => {
    expect(preview(range)).toEqual(exported(range));
  });

  it('treats a whitespace-only range as every page', () => {
    expect(parsePageRange(' ', N)).toBeNull();
  });

  it('accepts an en dash and semicolons', () => {
    expect(exported('1–2; 4')).toEqual([0, 1, 3]);
  });

  it('flags a non-empty range that selects nothing', () => {
    expect(rangeSelectsNothing('0', N)).toBe(true);
    expect(rangeSelectsNothing('9-12', N)).toBe(true);
    expect(rangeSelectsNothing('abc', N)).toBe(true);
    expect(rangeSelectsNothing(' ', N)).toBe(false);
    expect(rangeSelectsNothing('all', N)).toBe(false);
    expect(rangeSelectsNothing('2', N)).toBe(false);
    expect(pageIndexInRange('2', 1, N)).toBe(true);
  });
});

describe('UI-8 — duplex interleave cannot be applied twice in a row', async () => {
  const { isProducedOrder } = await import('../../src/ui/tools/organize/DuplexSection');
  const { interleaveDuplex } = await import('../../src/core/duplex');
  const pages = ['f1', 'f2', 'b2', 'b1'].map(key => ({
    key,
    sourceDocId: 's',
    sourceIndex: 0,
    rotation: 0
  }));

  it('remembers the produced order until the page order changes', () => {
    const plan = interleaveDuplex(pages, 2, true);
    const produced = { docId: 'd', order: plan.pages.map(p => p.key).join('\n') };
    expect(plan.pages.map(p => p.key)).toEqual(['f1', 'b1', 'f2', 'b2']);
    // Right after interleaving: disabled.
    expect(isProducedOrder(produced, 'd', plan.pages)).toBe(true);
    // A second interleave of that order would scramble it — which is why.
    expect(interleaveDuplex(plan.pages, 2, true).pages.map(p => p.key)).not.toEqual(
      plan.pages.map(p => p.key)
    );
    // Undo (or any move) changes the order: enabled again.
    expect(isProducedOrder(produced, 'd', pages)).toBe(false);
    // Another document with the same keys is not affected.
    expect(isProducedOrder(produced, 'other', plan.pages)).toBe(false);
    expect(isProducedOrder(null, 'd', plan.pages)).toBe(false);
  });
});
