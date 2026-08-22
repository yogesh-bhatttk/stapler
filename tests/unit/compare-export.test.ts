import { describe, expect, it, vi } from 'vitest';

const { exportTextDiff, exportVisualDiff, exportRedlinePdf } = vi.hoisted(() => ({
  exportTextDiff: vi.fn(async () => new Uint8Array([1, 2, 3])),
  exportVisualDiff: vi.fn(async () => new Uint8Array([4, 5, 6])),
  exportRedlinePdf: vi.fn(async () => new Uint8Array([7, 8, 9]))
}));

vi.mock('../../src/core/text-diff-export', () => ({
  exportTextDiff
}));

vi.mock('../../src/core/visual-diff-export', () => ({
  exportVisualDiff
}));

vi.mock('../../src/core/redline-export', () => ({
  exportRedlinePdf
}));

import { exportComparePdf } from '../../src/core/compare-export';

describe('exportComparePdf', () => {
  const docA = {
    id: 'doc-a',
    name: 'base.pdf',
    pages: [],
    annotations: [],
    dirty: false
  };
  const docB = {
    id: 'doc-b',
    name: 'compare.pdf',
    pages: [],
    annotations: [],
    dirty: false
  };

  it('routes text mode to the text diff exporter', async () => {
    const out = await exportComparePdf(docA, docB, { diffMode: 'text', sensitivity: 42 });
    expect(out).toEqual(new Uint8Array([1, 2, 3]));
    expect(exportTextDiff).toHaveBeenCalledWith(docA, docB);
    expect(exportVisualDiff).not.toHaveBeenCalled();
  });

  it('routes visual mode to the visual diff exporter', async () => {
    const out = await exportComparePdf(docA, docB, { diffMode: 'visual', sensitivity: 42 });
    expect(out).toEqual(new Uint8Array([4, 5, 6]));
    expect(exportVisualDiff).toHaveBeenCalledWith(docA, docB, undefined, {
      diffMode: 'visual',
      sensitivity: 42
    });
  });

  it('routes redline mode to the redline exporter', async () => {
    const out = await exportComparePdf(docA, docB, {
      diffMode: 'redline',
      sensitivity: 42,
      unchangedPages: 'skip'
    });
    expect(out).toEqual(new Uint8Array([7, 8, 9]));
    expect(exportRedlinePdf).toHaveBeenCalledWith(docA, docB, {
      diffMode: 'redline',
      sensitivity: 42,
      unchangedPages: 'skip'
    });
  });
});
