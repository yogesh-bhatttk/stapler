import { describe, expect, it } from 'vitest';
import { pagesForScope, type CropScope } from '../../src/ui/tools/crop/state';
import { resizeBox } from '../../src/ui/tools/crop/CropOverlay';
import type { PageRef } from '../../src/core/store';

function makePages(count: number): PageRef[] {
  return Array.from({ length: count }, (_, i) => ({
    key: `p${i}`,
    sourceDocId: 'doc',
    sourceIndex: i,
    rotation: 0
  }));
}

describe('pagesForScope', () => {
  const pages = makePages(5); // p0..p4 = pages 1..5

  it('current resolves to only the active page', () => {
    expect(pagesForScope(pages, 'current', 2).map(p => p.key)).toEqual(['p2']);
  });

  it('all resolves to every page', () => {
    expect(pagesForScope(pages, 'all', 0).map(p => p.key)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4']);
  });

  it('odd resolves to 1-indexed odd pages (index 0, 2, 4)', () => {
    expect(pagesForScope(pages, 'odd', 0).map(p => p.key)).toEqual(['p0', 'p2', 'p4']);
  });

  it('even resolves to 1-indexed even pages (index 1, 3)', () => {
    expect(pagesForScope(pages, 'even', 0).map(p => p.key)).toEqual(['p1', 'p3']);
  });

  it('current with an out-of-range index resolves to no pages', () => {
    expect(pagesForScope(pages, 'current' as CropScope, 99)).toEqual([]);
  });
});

describe('resizeBox', () => {
  const box = { x: 0.2, y: 0.2, width: 0.4, height: 0.4 };

  it('se handle grows width and height without moving the origin', () => {
    const result = resizeBox(box, 'se', 0.1, 0.05);
    expect(result).toEqual({ x: 0.2, y: 0.2, width: 0.5, height: 0.45 });
  });

  it('nw handle moves the origin and shrinks in the opposite direction', () => {
    const result = resizeBox(box, 'nw', 0.1, 0.05);
    expect(result.x).toBeCloseTo(0.3);
    expect(result.y).toBeCloseTo(0.25);
    expect(result.width).toBeCloseTo(0.3);
    expect(result.height).toBeCloseTo(0.35);
  });

  it('e handle only changes width', () => {
    const result = resizeBox(box, 'e', -0.1, 0.9 /* dy ignored for a pure-width handle */);
    expect(result.x).toBe(box.x);
    expect(result.y).toBe(box.y);
    expect(result.height).toBe(box.height);
    expect(result.width).toBeCloseTo(0.3);
  });

  it('clamps width so it never shrinks below MIN_SIZE', () => {
    const result = resizeBox(box, 'e', -10, 0);
    expect(result.width).toBeCloseTo(0.05);
  });

  it('clamps width so the box never extends past the page edge', () => {
    const result = resizeBox(box, 'e', 10, 0);
    expect(result.x + result.width).toBeCloseTo(1);
  });

  it('clamps the nw handle so the origin never goes negative', () => {
    const result = resizeBox(box, 'nw', -10, -10);
    expect(result.x).toBe(0);
    expect(result.y).toBe(0);
  });
});
