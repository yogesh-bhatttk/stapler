/**
 * OPS-14 — heading-based outline detection.
 *
 * Pure and independent of pdf.js, matching `text-layout.test.ts`'s own reasoning
 * for why the reading-order heuristics are tested directly rather than through a
 * PDF: the heuristics are where the bugs hide, not the pdf.js call that supplies
 * the items.
 */
import { describe, expect, it } from 'vitest';
import {
  countCandidates,
  detectHeadingOutline,
  type HeadingItem,
  type HeadingPage
} from '../../src/core/outline-detect';

function line(text: string, y: number, height: number): HeadingItem {
  return { text, x: 0, y, width: text.length * height * 0.5, height };
}

describe('detectHeadingOutline', () => {
  it('nests three heading levels by font size, with correct target pages', () => {
    const pages: HeadingPage[] = [
      {
        pageIndex: 0,
        items: [
          line('Chapter 1', 0, 24),
          line('Intro body text.', 40, 12),
          line('Section 1.1', 60, 18),
          line('More body text.', 90, 12),
          line('Subsection 1.1.1', 110, 15),
          line('Even more body.', 140, 12)
        ]
      },
      {
        pageIndex: 1,
        items: [line('Chapter 2', 0, 24), line('Final body text.', 40, 12)]
      }
    ];

    const tree = detectHeadingOutline(pages);

    expect(tree).toEqual([
      {
        title: 'Chapter 1',
        level: 1,
        pageIndex: 0,
        children: [
          {
            title: 'Section 1.1',
            level: 2,
            pageIndex: 0,
            children: [{ title: 'Subsection 1.1.1', level: 3, pageIndex: 0, children: [] }]
          }
        ]
      },
      { title: 'Chapter 2', level: 1, pageIndex: 1, children: [] }
    ]);
  });

  it('finds nothing in a document with no font-size jump', () => {
    const pages: HeadingPage[] = [
      {
        pageIndex: 0,
        items: [line('Just body text.', 0, 12), line('More of the same.', 20, 12)]
      }
    ];
    expect(detectHeadingOutline(pages)).toEqual([]);
  });

  it('finds nothing on an empty document', () => {
    expect(detectHeadingOutline([])).toEqual([]);
    expect(detectHeadingOutline([{ pageIndex: 0, items: [] }])).toEqual([]);
  });

  it('joins a heading split across runs into one line, in reading order', () => {
    const pages: HeadingPage[] = [
      {
        pageIndex: 0,
        items: [
          { text: 'Chap', x: 0, y: 0, width: 40, height: 24 },
          { text: 'ter 1', x: 40, y: 0, width: 40, height: 24 },
          line('Body text here.', 30, 12),
          line('More body text.', 50, 12),
          line('Even more body.', 70, 12)
        ]
      }
    ];
    const tree = detectHeadingOutline(pages);
    expect(tree).toHaveLength(1);
    expect(tree[0].title).toBe('Chapter 1');
  });

  it('collapses heading sizes deeper than maxLevels into the deepest level', () => {
    const pages: HeadingPage[] = [
      {
        pageIndex: 0,
        items: [
          line('H1', 0, 30),
          line('body', 15, 12),
          line('H2', 30, 24),
          line('body', 45, 12),
          line('H3', 60, 20),
          line('body', 75, 12),
          line('H4', 90, 18),
          line('body', 105, 12)
        ]
      }
    ];
    const tree = detectHeadingOutline(pages, { maxLevels: 3 });
    // H1 > H2 > H3 > H4, but only 3 levels exist: H4 collapses to level 3
    // alongside H3 — a sibling under H2, the same as any other same-level
    // heading, rather than inventing a fourth level of nesting.
    expect(tree[0].level).toBe(1);
    expect(tree[0].title).toBe('H1');
    expect(tree[0].children[0].level).toBe(2);
    expect(tree[0].children[0].title).toBe('H2');
    expect(tree[0].children[0].children.map(n => [n.title, n.level])).toEqual([
      ['H3', 3],
      ['H4', 3]
    ]);
  });

  it('treats consecutive same-level headings as siblings, not nested', () => {
    const pages: HeadingPage[] = [
      {
        pageIndex: 0,
        items: [
          line('Chapter 1', 0, 24),
          line('body', 20, 12),
          line('body', 35, 12),
          line('Chapter 2', 50, 24),
          line('body', 70, 12),
          line('body', 85, 12),
          line('Chapter 3', 100, 24)
        ]
      }
    ];
    const tree = detectHeadingOutline(pages);
    expect(tree.map(n => n.title)).toEqual(['Chapter 1', 'Chapter 2', 'Chapter 3']);
    expect(tree.every(n => n.children.length === 0)).toBe(true);
  });
});

describe('countCandidates', () => {
  it('counts nested headings, not just the top level', () => {
    const pages: HeadingPage[] = [
      {
        pageIndex: 0,
        items: [
          line('Chapter 1', 0, 24),
          line('body', 20, 12),
          line('body', 35, 12),
          line('Section 1.1', 50, 18),
          line('body', 70, 12)
        ]
      }
    ];
    const tree = detectHeadingOutline(pages);
    // One top-level chapter with one nested section — two headings in total,
    // which is what a "Found N heading(s)" message should say, not one.
    expect(tree).toHaveLength(1);
    expect(countCandidates(tree)).toBe(2);
  });

  it('is zero for an empty tree', () => {
    expect(countCandidates([])).toBe(0);
  });
});
