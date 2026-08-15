import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
  exportAnnotationSummary,
  exportAnnotationSummaryText,
  type SummaryAnnotation
} from '../../src/core/annotation-summary';
import type { StaplerDoc } from '../../src/core/store';

describe('ANN-04: Export annotation summary', () => {
  const dummyDoc: StaplerDoc = {
    id: 'doc-1',
    name: 'test-contract.pdf',
    dirty: false,
    pages: [
      { key: 'page-key-1', sourceDocId: 'src-1', sourceIndex: 0, rotation: 0 },
      { key: 'page-key-2', sourceDocId: 'src-1', sourceIndex: 1, rotation: 0 },
      { key: 'page-key-3', sourceDocId: 'src-1', sourceIndex: 2, rotation: 0 }
    ],
    annotations: []
  };

  it('collects all N notes across multiple pages and attributes them correctly to page numbers', async () => {
    const annotations: SummaryAnnotation[] = [
      {
        id: 'ann-1',
        type: 'sticky',
        text: 'Review clause 4.2 regarding termination',
        author: 'Alice (Legal)',
        date: '2026-08-15',
        pageKey: 'page-key-1',
        rect: { x: 0.1, y: 0.2, width: 0.15, height: 0.1 }
      },
      {
        id: 'ann-2',
        type: 'text',
        text: 'Fix typo in heading',
        author: 'Bob (Editor)',
        date: '2026-08-15',
        pageKey: 'page-key-1',
        rect: { x: 0.5, y: 0.4, width: 0.2, height: 0.05 }
      },
      {
        id: 'ann-3',
        type: 'sticky',
        text: 'Verify indemnity cap amount with finance team',
        author: 'Carol (Finance)',
        date: '2026-08-16',
        pageKey: 'page-key-2',
        rect: { x: 0.25, y: 0.3, width: 0.15, height: 0.1 }
      },
      {
        id: 'ann-4',
        type: 'highlight',
        text: 'Confidentiality obligations extended to 5 years',
        author: 'Dave (Auditor)',
        date: '2026-08-16',
        pageKey: 'page-key-3',
        rect: { x: 0.15, y: 0.6, width: 0.7, height: 0.04 }
      },
      {
        id: 'ann-5',
        type: 'sticky',
        text: 'Signatures required from both parties',
        author: 'Eve (Ops)',
        date: '2026-08-16',
        pageKey: 'page-key-3',
        rect: { x: 0.4, y: 0.85, width: 0.15, height: 0.1 }
      }
    ];

    // 1. PDF Summary Export Test
    const pdfBytes = await exportAnnotationSummary(dummyDoc, annotations);
    expect(pdfBytes).toBeDefined();
    expect(pdfBytes.length).toBeGreaterThan(0);

    const pdf = await PDFDocument.load(pdfBytes);
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(1);

    // 2. Text Summary Export Test
    const textSummary = exportAnnotationSummaryText(dummyDoc, annotations);
    expect(textSummary).toContain('ANNOTATION SUMMARY: test-contract.pdf');
    expect(textSummary).toContain('Total Annotations: 5');

    // Assert all N=5 notes are present
    expect(textSummary).toContain('Review clause 4.2 regarding termination');
    expect(textSummary).toContain('Fix typo in heading');
    expect(textSummary).toContain('Verify indemnity cap amount with finance team');
    expect(textSummary).toContain('Confidentiality obligations extended to 5 years');
    expect(textSummary).toContain('Signatures required from both parties');

    // Assert correct page number attribution
    expect(textSummary).toContain('Page: 1');
    expect(textSummary).toContain('Page: 2');
    expect(textSummary).toContain('Page: 3');

    // Assert author & date details are present
    expect(textSummary).toContain('Author: Alice (Legal)');
    expect(textSummary).toContain('Author: Bob (Editor)');
    expect(textSummary).toContain('Author: Carol (Finance)');
    expect(textSummary).toContain('Author: Dave (Auditor)');
    expect(textSummary).toContain('Author: Eve (Ops)');
  });

  it('handles empty annotations gracefully', async () => {
    const pdfBytes = await exportAnnotationSummary(dummyDoc, []);
    expect(pdfBytes).toBeDefined();
    expect(pdfBytes.length).toBeGreaterThan(0);

    const pdf = await PDFDocument.load(pdfBytes);
    expect(pdf.getPageCount()).toBe(1);

    const textSummary = exportAnnotationSummaryText(dummyDoc, []);
    expect(textSummary).toContain('Total Annotations: 0');
  });

  it('correctly attributes page numbers using pageIndex when pageKey is missing', async () => {
    const annotations: SummaryAnnotation[] = [
      {
        type: 'sticky',
        text: 'Note on page 4',
        pageIndex: 3,
        rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }
      }
    ];

    const textSummary = exportAnnotationSummaryText(dummyDoc, annotations);
    expect(textSummary).toContain('Page: 4');
    expect(textSummary).toContain('Note on page 4');
  });
});
