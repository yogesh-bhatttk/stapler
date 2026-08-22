import { describe, expect, it } from 'vitest';
import {
  detectPatterns,
  luhn,
  ibanChecksumValid,
  icaoCheckDigit,
  type PatternCategory
} from '../../src/core/patterns';

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
  'and its v6 address is 2001:0db8:85a3:0000:0000:8a2e:0370:7334 today.',
  'Wire the deposit to GB29 NWBK 6016 1331 9268 19 before Friday.',
  'Her National Insurance number is AB123456C for payroll.',
  'Passport AB12345671 was scanned at the gate.'
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
  'Meeting moved to 9:30 and the retro to 14:00 in room 4.',
  'GB30 NWBK 6016 1331 9268 19 was rejected by the bank (bad checksum).',
  'Reference code GB123456C matched no record (a reserved NINO prefix).',
  'Container ID AB12345670 was flagged for inspection (wrong check digit).'
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
      ['ip', '2001:0db8:85a3:0000:0000:8a2e:0370:7334'],
      ['iban', 'GB29 NWBK 6016 1331 9268 19'],
      ['uk-nino', 'AB123456C'],
      ['passport', 'AB12345671']
    ]);
  });

  it('claims the whole IBAN span before the credit-card matcher can see its digit groups', () => {
    // Without IBAN ordered first, "6016 1331 9268 19" inside this IBAN is
    // shaped exactly like a spaced-out card number and would be up for grabs.
    expect(categories('Wire to GB29 NWBK 6016 1331 9268 19 today.')).toEqual(['iban']);
  });

  it('reports no matches at all in structured-looking prose', () => {
    expect(detectPatterns(PROSE)).toEqual([]);
  });

  it('finds nothing in the two documents concatenated beyond the sensitive ones', () => {
    expect(categories(`${PROSE}\n${SENSITIVE}\n${PROSE}`)).toEqual([
      'credit-card',
      'email',
      'iban',
      'ip',
      'ip',
      'passport',
      'phone',
      'ssn',
      'uk-nino'
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

  it('validates IBANs by the real ISO 7064 mod-97 checksum, not just their shape', () => {
    // Textbook example IBANs, independently known-valid.
    expect(ibanChecksumValid('GB29NWBK60161331926819')).toBe(true);
    expect(ibanChecksumValid('DE89370400440532013000')).toBe(true);
    expect(ibanChecksumValid('FR1420041010050500013M02606')).toBe(true);
    // One digit changed in the check-digit position.
    expect(ibanChecksumValid('GB30NWBK60161331926819')).toBe(false);
    // Right shape, wrong length for a real IBAN.
    expect(ibanChecksumValid('GB29NWBK6')).toBe(false);
  });

  it('rejects an IBAN-shaped string that fails the checksum, and a NINO with a reserved prefix', () => {
    expect(categories('Account GB30 NWBK 6016 1331 9268 19 was rejected.')).toEqual([]);
    expect(categories('Code GB123456C matched nothing.')).toEqual([]);
  });

  it('computes the ICAO 9303 check digit used by passport document numbers', () => {
    // The worked example from the ICAO 9303 specification itself: document
    // number "L898902C<" (the MRZ field, padded to 9 characters) checks to 3.
    expect(icaoCheckDigit('L898902C<')).toBe(3);
    expect(icaoCheckDigit('AB1234567')).toBe(1);
  });

  it('rejects a passport-shaped number whose trailing digit is not its real check digit', () => {
    expect(categories('Container ID AB12345670 was flagged.')).toEqual([]);
    // The correct check digit for AB1234567 is 1, not 0.
    expect(categories('Passport AB12345671 was scanned.')).toEqual(['passport']);
  });

  it('does not report a UK NINO for one of the six administratively reserved prefixes', () => {
    for (const prefix of ['BG', 'GB', 'NK', 'KN', 'TN', 'ZZ']) {
      expect(categories(`Number ${prefix}123456C on file.`)).toEqual([]);
    }
  });
});
