import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { pixelDiff } from '../../src/core/pixel-diff';
import { exportVisualDiff, type PageDiffResult } from '../../src/core/visual-diff-export';
import { type StaplerDoc } from '../../src/core/store';

function createMockImageData(
  width: number,
  height: number,
  fillColor = [255, 255, 255, 255]
): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = fillColor[0];
    data[i + 1] = fillColor[1];
    data[i + 2] = fillColor[2];
    data[i + 3] = fillColor[3];
  }
  return new ImageData(data, width, height);
}

function setPixel(img: ImageData, x: number, y: number, color: [number, number, number, number]) {
  const idx = (y * img.width + x) * 4;
  img.data[idx] = color[0];
  img.data[idx + 1] = color[1];
  img.data[idx + 2] = color[2];
  img.data[idx + 3] = color[3];
}

describe('exportVisualDiff (ANN-05)', () => {
  const mockDocA: StaplerDoc = {
    id: 'docA-id',
    name: 'base.pdf',
    pages: [{ key: 'p1', sourceDocId: 'srcA', sourceIndex: 0, rotation: 0 }],
    annotations: [],
    dirty: false
  };

  const mockDocB: StaplerDoc = {
    id: 'docB-id',
    name: 'compare.pdf',
    pages: [{ key: 'p2', sourceDocId: 'srcB', sourceIndex: 0, rotation: 0 }],
    annotations: [],
    dirty: false
  };

  it('exports visual diff PDF for added-content fixture', async () => {
    const w = 4;
    const h = 4;
    const baseImg = createMockImageData(w, h, [255, 255, 255, 255]); // All white
    const compareImg = createMockImageData(w, h, [255, 255, 255, 255]);
    // Added content at (1, 1)
    setPixel(compareImg, 1, 1, [0, 0, 0, 255]);

    const diffImg = pixelDiff(baseImg, compareImg, 10);
    const diffResults: PageDiffResult[] = [
      {
        pageIndex: 0,
        diffImage: diffImg,
        baseImage: baseImg,
        compareImage: compareImg,
        hasChanges: true
      }
    ];

    const exportedBytes = await exportVisualDiff(mockDocA, mockDocB, diffResults);
    expect(exportedBytes).toBeInstanceOf(Uint8Array);
    expect(exportedBytes.byteLength).toBeGreaterThan(0);

    const pdf = await PDFDocument.load(exportedBytes);
    expect(pdf.getPageCount()).toBe(1);

    const page = pdf.getPage(0);
    expect(page.getWidth()).toBeGreaterThan(0);
    expect(page.getHeight()).toBeGreaterThan(0);
  });

  it('exports visual diff PDF for removed-content fixture', async () => {
    const w = 4;
    const h = 4;
    const baseImg = createMockImageData(w, h, [255, 255, 255, 255]);
    // Removed content at (2, 2) originally in baseImg
    setPixel(baseImg, 2, 2, [0, 0, 0, 255]);
    const compareImg = createMockImageData(w, h, [255, 255, 255, 255]); // Blank

    const diffImg = pixelDiff(baseImg, compareImg, 10);
    const diffResults: PageDiffResult[] = [
      {
        pageIndex: 0,
        diffImage: diffImg,
        baseImage: baseImg,
        compareImage: compareImg,
        hasChanges: true
      }
    ];

    const exportedBytes = await exportVisualDiff(mockDocA, mockDocB, diffResults);
    expect(exportedBytes).toBeInstanceOf(Uint8Array);

    const pdf = await PDFDocument.load(exportedBytes);
    expect(pdf.getPageCount()).toBe(1);
  });

  it('handles multi-page document diff exports', async () => {
    const multiDocA: StaplerDoc = {
      id: 'docA-multi',
      name: 'base-multi.pdf',
      pages: [
        { key: 'p1', sourceDocId: 'srcA', sourceIndex: 0, rotation: 0 },
        { key: 'p2', sourceDocId: 'srcA', sourceIndex: 1, rotation: 0 }
      ],
      annotations: [],
      dirty: false
    };

    const multiDocB: StaplerDoc = {
      id: 'docB-multi',
      name: 'compare-multi.pdf',
      pages: [
        { key: 'p1', sourceDocId: 'srcB', sourceIndex: 0, rotation: 0 },
        { key: 'p2', sourceDocId: 'srcB', sourceIndex: 1, rotation: 0 }
      ],
      annotations: [],
      dirty: false
    };

    const img1 = createMockImageData(2, 2);
    const diffResults: PageDiffResult[] = [
      { pageIndex: 0, diffImage: img1, hasChanges: false },
      { pageIndex: 1, diffImage: img1, hasChanges: true }
    ];

    const exportedBytes = await exportVisualDiff(multiDocA, multiDocB, diffResults);
    const pdf = await PDFDocument.load(exportedBytes);
    expect(pdf.getPageCount()).toBe(2);
  });

  it('throws an error when totalPages is zero', async () => {
    const emptyDoc: StaplerDoc = {
      id: 'empty',
      name: 'empty.pdf',
      pages: [],
      annotations: [],
      dirty: false
    };
    await expect(exportVisualDiff(emptyDoc, emptyDoc, [])).rejects.toThrow(
      'There are no pages to export.'
    );
  });
});
