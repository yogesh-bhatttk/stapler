/**
 * The strong-direction rule the three PDF→Office writers (CNV-08 / CNV-10 /
 * CNV-12) share.
 *
 * This file grades the *decision* only. Whether each writer then puts the flag
 * in the right element of the right part is graded against real produced OOXML
 * in `pdf-to-word.test.ts`, `pdf-to-excel.test.ts` and `pdf-to-ppt.test.ts` —
 * a detector that answers correctly and a writer that drops the answer on the
 * floor are two different bugs, so they are two different tests.
 */
import { describe, expect, it } from 'vitest';
import { isRtlRunGroup, isRtlText } from '../../src/core/convert/text-direction';

/** Real words, not lone code points, so the ranges are exercised as text is. */
const ARABIC = 'مرحبا بالعالم';
const HEBREW = 'שלום עולם';
const FARSI = 'سلام دنیا';
const SYRIAC = 'ܫܠܡܐ';
const THAANA = 'ހެލޯ';
const NKO = 'ߒߞߏ';
const HEBREW_PRESENTATION = 'שׁוּ'; // Hebrew presentation forms
const ADLAM = '\u{1e921}\u{1e943}'; // Adlam, above the BMP — a surrogate pair each

describe('RTL detection — scripts that are right-to-left', () => {
  it('calls real RTL text right-to-left, across the scripts the ranges claim', () => {
    for (const text of [ARABIC, HEBREW, FARSI, SYRIAC, THAANA, NKO, HEBREW_PRESENTATION, ADLAM]) {
      expect(isRtlText(text), `${text} should be RTL`).toBe(true);
    }
  });

  it('calls left-to-right text left-to-right, including scripts that are neither Latin nor RTL', () => {
    for (const text of ['Hello world', 'Ελληνικά', 'Русский', '中文文本', 'こんにちは', 'ไทย']) {
      expect(isRtlText(text), `${text} should be LTR`).toBe(false);
    }
  });

  it('counts a code point above the BMP once, not twice', () => {
    // Adlam is a surrogate pair per letter. Iterating by UTF-16 unit would count
    // each letter twice *and* test the wrong numbers against the range table.
    expect(isRtlText(`${ADLAM}ab`)).toBe(true);
    expect([...ADLAM]).toHaveLength(2);
    expect(ADLAM.length).toBe(4);
  });
});

describe('RTL detection — what counts as a strong character', () => {
  it('ignores digits of both kinds: a table of figures does not flip direction', () => {
    // European digits are bidi class EN and Arabic-Indic digits are AN. Neither
    // is strong, and an Arabic invoice is mostly numbers.
    expect(isRtlText(`${ARABIC} 1,204.50`)).toBe(true);
    expect(isRtlText('١٢٣٤٥٦٧٨٩٠')).toBe(false);
    expect(isRtlText(`Total 1234 ${'٠١٢'}`)).toBe(false);
  });

  it('ignores marks, punctuation and whitespace', () => {
    // Arabic harakat are combining marks, not letters.
    expect(isRtlText('ًٌَ')).toBe(false);
    expect(isRtlText('… — ()[]')).toBe(false);
    expect(isRtlText('   \t\n')).toBe(false);
  });

  it('returns the caller’s fallback when there is no strong character at all', () => {
    // This is how a neutral run inherits the paragraph it sits in instead of
    // silently reverting to LTR mid-sentence.
    expect(isRtlText('123 — ', true)).toBe(true);
    expect(isRtlText('123 — ', false)).toBe(false);
    expect(isRtlText('')).toBe(false);
    expect(isRtlText('', true)).toBe(true);
  });

  it('never lets the fallback override a text that does have strong characters', () => {
    expect(isRtlText('Hello', true)).toBe(false);
    expect(isRtlText(ARABIC, false)).toBe(true);
  });
});

describe('RTL detection — mixed text', () => {
  it('follows the majority of strong letters', () => {
    // 11 Arabic letters against 3 Latin.
    expect(isRtlText(`${ARABIC} PDF`)).toBe(true);
    // The reverse: a single Arabic word inside an English sentence.
    expect(isRtlText(`The Arabic word for peace is ${'سلام'}`)).toBe(false);
  });

  it('breaks an exact tie with the first strong character (UAX #9 P2/P3)', () => {
    expect(isRtlText('אב ab')).toBe(true);
    expect(isRtlText('ab אב')).toBe(false);
    // Leading digits and punctuation are not strong, so they do not decide it.
    expect(isRtlText('12. אב ab')).toBe(true);
  });
});

describe('RTL detection — a group of runs is one decision', () => {
  it('decides over the joined text, so a long sentence is not outvoted by run count', () => {
    // Two runs of Latin against one long Arabic run: by run count the Latin
    // wins, by character count the Arabic does — and characters are what a
    // reader sees.
    expect(isRtlRunGroup([ARABIC, ' PDF', ' v2'])).toBe(true);
    expect(isRtlRunGroup(['Quarterly report ', 'for ', 'سنة'])).toBe(false);
  });

  it('is the same answer as concatenating the runs by hand', () => {
    const runs = [HEBREW, ' — ', 'Q3', ' ', ARABIC];
    expect(isRtlRunGroup(runs)).toBe(isRtlText(runs.join('')));
  });

  it('handles an empty group as having no direction of its own', () => {
    expect(isRtlRunGroup([])).toBe(false);
    expect(isRtlRunGroup(['', ''])).toBe(false);
  });
});
