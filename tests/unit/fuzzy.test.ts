import { describe, expect, it } from 'vitest';
import { fuzzyRank, fuzzyScore } from '../../src/core/fuzzy';
import { TOOLS } from '../../src/core/tools';

describe('fuzzyScore', () => {
  it('matches an empty needle against anything', () => {
    expect(fuzzyScore('Compress', '')).toBe(1);
  });

  it('returns zero when a character is missing', () => {
    expect(fuzzyScore('Compress', 'zzz')).toBe(0);
    expect(fuzzyScore('Merge', 'merger')).toBe(0);
  });

  it('matches a subsequence, not just a substring', () => {
    expect(fuzzyScore('Compress', 'cmp')).toBeGreaterThan(0);
    expect(fuzzyScore('Split & extract', 'sxt')).toBeGreaterThan(0);
  });

  it('scores a prefix above a scattered match', () => {
    expect(fuzzyScore('Compress', 'comp')).toBeGreaterThan(fuzzyScore('Compress', 'ces'));
  });

  // Same needle, same haystack length, so only the word-boundary bonus differs.
  it('scores a word beginning above a mid-word hit', () => {
    expect(fuzzyScore('xx cxx', 'c')).toBeGreaterThan(fuzzyScore('xxcxxx', 'c'));
  });

  // The bug the length normalisation fixes: an unnormalised sum let a long string
  // out-score a short one that matches better.
  it('scores a short precise match above the same letters buried in a sentence', () => {
    expect(fuzzyScore('Compress', 'compress')).toBeGreaterThan(
      fuzzyScore('Combine several PDFs and images into one document', 'compress')
    );
  });
});

describe('ranking tool searches', () => {
  const label = (tool: (typeof TOOLS)[number]) => `${tool.title} ${tool.group}`;

  /*
   * The regression this pins. Scores were an unnormalised sum, so a long label could
   * out-score the tool actually named in the query: typing "compress" and pressing Enter
   * navigated to Redact.
   */
  it.each([
    ['compress', 'compress'],
    ['merge', 'merge'],
    ['redact', 'redact'],
    ['split', 'split'],
    ['sign', 'sign'],
    ['metadata', 'metadata'],
    ['extract text', 'extract'],
    ['scan', 'cleanup']
  ])('ranks %s first for its own name', (query, expectedId) => {
    const ranked = fuzzyRank(TOOLS, query, label);
    expect(ranked[0]?.id).toBe(expectedId);
  });

  it('finds a tool from an abbreviation', () => {
    expect(fuzzyRank(TOOLS, 'cmprs', label)[0]?.id).toBe('compress');
  });

  it('returns nothing for a query no tool matches', () => {
    expect(fuzzyRank(TOOLS, 'xylophone', label)).toEqual([]);
  });

  it('returns every tool for an empty query, in declaration order', () => {
    const ranked = fuzzyRank(TOOLS, '', label);
    expect(ranked.map(t => t.id)).toEqual(TOOLS.map(t => t.id));
  });
});
