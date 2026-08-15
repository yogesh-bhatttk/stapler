import { describe, it, expect } from 'vitest';
import {
  applyFilenamePattern,
  stripPdfExtension,
  deduplicateNames
} from '../../src/core/batch-filename';

const DATE = new Date('2025-03-15T00:00:00Z');

describe('applyFilenamePattern', () => {
  it('replaces {basename}', () => {
    expect(applyFilenamePattern('{basename}', 'report', 1, 3, DATE)).toBe('report');
  });

  it('replaces {index} with zero-padding matching total width', () => {
    // total=3 → 1 digit
    expect(applyFilenamePattern('{index}', 'f', 1, 3, DATE)).toBe('1');
    // total=10 → 2 digits
    expect(applyFilenamePattern('{index}', 'f', 1, 10, DATE)).toBe('01');
    expect(applyFilenamePattern('{index}', 'f', 10, 10, DATE)).toBe('10');
    // total=100 → 3 digits
    expect(applyFilenamePattern('{index}', 'f', 5, 100, DATE)).toBe('005');
  });

  it('replaces {date} with YYYY-MM-DD', () => {
    expect(applyFilenamePattern('{date}', 'f', 1, 1, DATE)).toBe('2025-03-15');
  });

  it('combines all three tokens', () => {
    expect(applyFilenamePattern('{basename}-{date}-{index}', 'invoice', 2, 10, DATE)).toBe(
      'invoice-2025-03-15-02'
    );
  });

  it('replaces multiple occurrences of the same token', () => {
    expect(applyFilenamePattern('{basename}_{basename}', 'doc', 1, 1, DATE)).toBe('doc_doc');
  });

  it('leaves unknown tokens as-is', () => {
    expect(applyFilenamePattern('{unknown}', 'f', 1, 1, DATE)).toBe('{unknown}');
  });
});

describe('stripPdfExtension', () => {
  it('strips .pdf', () => {
    expect(stripPdfExtension('report.pdf')).toBe('report');
  });
  it('strips .PDF (case-insensitive)', () => {
    expect(stripPdfExtension('REPORT.PDF')).toBe('REPORT');
  });
  it('leaves names without .pdf unchanged', () => {
    expect(stripPdfExtension('report')).toBe('report');
    expect(stripPdfExtension('report.docx')).toBe('report.docx');
  });
});

describe('deduplicateNames', () => {
  it('returns unchanged array when names are unique', () => {
    expect(deduplicateNames(['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('appends (2), (3) on collision', () => {
    const result = deduplicateNames(['doc', 'doc', 'doc']);
    expect(result[0]).toBe('doc');
    expect(result[1]).toBe('doc (2)');
    expect(result[2]).toBe('doc (3)');
  });

  it('handles collision where (2) is already a name', () => {
    const result = deduplicateNames(['doc', 'doc (2)', 'doc']);
    expect(result[0]).toBe('doc');
    expect(result[1]).toBe('doc (2)');
    // 'doc' appears again; (2) is taken, so (3) should be used
    expect(result[2]).toBe('doc (3)');
  });

  it('handles mixed unique and duplicate names', () => {
    const result = deduplicateNames(['a', 'b', 'a', 'c', 'b']);
    expect(result[0]).toBe('a');
    expect(result[1]).toBe('b');
    expect(result[2]).toBe('a (2)');
    expect(result[3]).toBe('c');
    expect(result[4]).toBe('b (2)');
  });
});
