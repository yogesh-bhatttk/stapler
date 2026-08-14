import { describe, expect, it } from 'vitest';
import { detectPatterns, luhn, type PatternCategory } from '../../src/core/patterns';

/**
 * RED-05's acceptance criterion, in string form: one instance of each pattern is
 * found and categorised, and the prose around it produces nothing. The PDF-level
 * half of the same criterion lives in `redact-patterns.test.ts`, which runs this
 * matcher over text pdf.js actually extracted from a generated fixture.
 */
const SENSITIVE = [
  'Contact Jane Doe at jane.doe@example.com for anything urgent.',
  'Her direct line is (555) 010-9999 during office hours.',
  'Social Security Number: 123-45-6789 (do not disclose).',
  'Corporate card 4111 1111 1111 1111 expires next year.',
  'The gateway sits at 192.168.10.42 on the internal network.',
  'and its v6 address is 2001:0db8:85a3:0000:0000:8a2e:0370:7334 today.'
].join('\n');

/**
 * Text that looks numeric and structured but contains nothing sensitive. Every
 * line here caught an earlier draft of one of the matchers.
 */
const PROSE = [
  'Invoice dated 2024-11-03, revised at 12:00:00 by the billing team.',
  'Applies to schema version 3.14.15 and to build 2.0.1 of the reader.',
  'Reference 000-00-0000 is the placeholder row and means "not supplied".',
  'Part number 4111-1111-1111-1112 failed inspection; see clause 8.',
  'Serial 12345678901234567890 shipped with lot 5551234 in November.',
  'Meeting moved to 9:30 and the retro to 14:00 in room 4.'
].join('\n');

function categories(text: string): PatternCategory[] {
  return detectPatterns(text)
    .map(hit => hit.category)
    .sort();
}

describe('detectPatterns', () => {
  it('finds exactly one of each category in a document containing one of each', () => {
    const hits = detectPatterns(SENSITIVE);
    expect(hits.map(hit => [hit.category, hit.text])).toEqual([
      ['email', 'jane.doe@example.com'],
      ['phone', '(555) 010-9999'],
      ['ssn', '123-45-6789'],
      ['credit-card', '4111 1111 1111 1111'],
      ['ip', '192.168.10.42'],
      ['ip', '2001:0db8:85a3:0000:0000:8a2e:0370:7334']
    ]);
  });

  it('reports no matches at all in structured-looking prose', () => {
    expect(detectPatterns(PROSE)).toEqual([]);
  });

  it('finds nothing in the two documents concatenated beyond the sensitive ones', () => {
    expect(categories(`${PROSE}\n${SENSITIVE}\n${PROSE}`)).toEqual([
      'credit-card',
      'email',
      'ip',
      'ip',
      'phone',
      'ssn'
    ]);
  });

  it('rejects card-shaped digit runs that fail Luhn', () => {
    expect(categories('Card 4111 1111 1111 1112 declined.')).toEqual([]);
    expect(luhn('4111111111111111')).toBe(true);
    expect(luhn('4111111111111112')).toBe(false);
    expect(luhn('0000000000000000')).toBe(false);
  });

  it('categorises an SSN as an SSN rather than a phone number', () => {
    expect(categories('SSN 123-45-6789')).toEqual(['ssn']);
  });

  it('recognises compressed IPv6 but not a clock time', () => {
    expect(detectPatterns('host 2001:db8::1 responded').map(h => h.text)).toEqual(['2001:db8::1']);
    expect(detectPatterns('at 12:00:00 sharp')).toEqual([]);
  });

  it('reports offsets that slice the match back out of the source', () => {
    const [hit] = detectPatterns('write to ops@stapler.test now');
    expect('write to ops@stapler.test now'.slice(hit.start, hit.end)).toBe(hit.text);
  });
});
