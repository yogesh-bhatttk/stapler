/**
 * ANN-03 — the conversion from found text to highlight annotations.
 *
 * The search half is `findTextRegions` (RED's find-and-mark call, unchanged), so
 * what is worth testing here is the part ANN-03 actually adds: which page key a
 * match lands on, and whether the highlight covers the box the search reported.
 * The end-to-end count and placement against real pdf.js output is the e2e test
 * "annotate: search highlights every match (ANN-03)".
 */
import { describe, expect, it } from 'vitest';
import { highlightsForRegions, type HighlightPage } from '../../src/core/highlight';
import type { TextRegion } from '../../src/core/workers/render.worker';

const A4: HighlightPage[] = [
  { key: 'p-1', aspect: 841.89 / 595.28 },
  { key: 'p-2', aspect: 841.89 / 595.28 },
  { key: 'p-3', aspect: 841.89 / 595.28 }
];

function region(pageIndex: number, over: Partial<TextRegion> = {}): TextRegion {
  return {
    pageIndex,
    x: 0.094,
    y: 0.14,
    width: 0.25,
    height: 0.013,
    text: 'Invoice',
    ...over
  };
}

let counter = 0;
const ids = () => `id-${++counter}`;

describe('ANN-03 · search and highlight', () => {
  it('makes one highlight annotation per match, on the match’s own page', () => {
    const regions = [region(0), region(1), region(2), region(2)];
    const { highlights, unplaced } = highlightsForRegions(regions, A4, '#FFEB3B', ids);

    expect(highlights).toHaveLength(4);
    expect(unplaced).toBe(0);
    expect(highlights.map(h => h.pageKey)).toEqual(['p-1', 'p-2', 'p-3', 'p-3']);
    expect(highlights.every(h => h.annotation.type === 'highlight')).toBe(true);
    // Ids are distinct, so removing or moving one never touches another.
    expect(new Set(highlights.map(h => h.annotation.id)).size).toBe(4);
  });

  it('covers the located box: full width, centred, as thick as the text', () => {
    const found = region(0, { x: 0.1, y: 0.2, width: 0.3, height: 0.02 });
    const [{ annotation }] = highlightsForRegions([found], A4, '#FFEB3B', ids).highlights;

    const points = annotation.points ?? [];
    expect(points).toHaveLength(2);
    expect(points[0].x).toBeCloseTo(0.1, 6);
    expect(points[1].x).toBeCloseTo(0.4, 6);
    // Both ends sit on the vertical centre of the located box.
    expect(points[0].y).toBeCloseTo(0.21, 6);
    expect(points[1].y).toBeCloseTo(0.21, 6);

    // `strokeWidth` is a fraction of page *width* in both the canvas overlay and
    // the PDF export, while the box height is a fraction of page *height*: on A4
    // the stroke must therefore be ~1.414x the raw height, or the highlight is
    // 30% too thin. In page units it is exactly the height of the text box.
    const pageWidth = 595.28;
    const pageHeight = 841.89;
    expect(annotation.strokeWidth * pageWidth).toBeCloseTo(0.02 * pageHeight, 6);
  });

  it('uses the picked colour, so the panel swatch means something here too', () => {
    const { highlights } = highlightsForRegions([region(0)], A4, '#4CAF50', ids);
    expect(highlights[0].annotation.color).toBe('#4CAF50');
  });

  it('reports matches with no page rather than dropping them silently', () => {
    const { highlights, unplaced } = highlightsForRegions(
      [region(0), region(7)],
      A4,
      '#FFEB3B',
      ids
    );
    expect(highlights).toHaveLength(1);
    expect(unplaced).toBe(1);
  });

  it('never produces a zero-width stroke, which would draw nothing at all', () => {
    const { highlights } = highlightsForRegions([region(0, { height: 0 })], A4, '#FFEB3B', ids);
    expect(highlights[0].annotation.strokeWidth).toBeGreaterThan(0);
  });

  it('has nothing to add when the search found nothing', () => {
    expect(highlightsForRegions([], A4, '#FFEB3B', ids)).toEqual({ highlights: [], unplaced: 0 });
  });
});
