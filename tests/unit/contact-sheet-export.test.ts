import { describe, expect, it, vi } from 'vitest';

const { bitmapToJpeg, renderApi, processApi, thumbnailCache } = vi.hoisted(() => {
  const bitmapToJpeg = vi.fn(async (bitmap: { tag: string }) =>
    new Uint8Array([bitmap.tag === 'cached' ? 11 : 22])
  );

  const renderApi = {
    loadDocument: vi.fn(),
    renderPage: vi.fn(),
    closeDocument: vi.fn()
  };

  const processApi = {
    contactSheetExport: vi.fn()
  };

  const thumbnailCache = {
    get: vi.fn(),
    set: vi.fn(),
    retain: vi.fn(),
    release: vi.fn()
  };

  return { bitmapToJpeg, renderApi, processApi, thumbnailCache };
});

vi.mock('../../src/core/workers', () => ({
  renderWorker: {
    lease: vi.fn(async (fn: (api: typeof renderApi) => Promise<unknown>) => fn(renderApi))
  },
  processWorker: {
    lease: vi.fn(async (fn: (api: typeof processApi) => Promise<unknown>) => fn(processApi))
  },
  cvWorker: {
    lease: vi.fn()
  }
}));

vi.mock('../../src/core/render-cache', () => ({
  bitmapKey: (sourceId: string, pageIndex: number, scale: number) =>
    `${sourceId}:${pageIndex}:${scale.toFixed(2)}`,
  thumbnailCache
}));

vi.mock('../../src/core/image', () => ({
  bitmapToJpeg
}));

import { exportContactSheet } from '../../src/core/operations';

describe('DOC-09: contact sheet export cache reuse', () => {
  it('reuses cached thumbnails and only renders uncached pages', async () => {
    const sourceId = 'doc-1';
    const scale = 150 / 72;
    const cachedKey = `${sourceId}:0:${scale.toFixed(2)}`;
    const uncachedKey = `${sourceId}:1:${scale.toFixed(2)}`;
    const cachedBitmap = { tag: 'cached', width: 100, height: 100 };
    const renderedBitmap = { tag: 'rendered', width: 100, height: 100 };

    renderApi.loadDocument.mockResolvedValue({ handle: 'handle-1', pageCount: 2 });
    renderApi.renderPage.mockResolvedValue(renderedBitmap);
    renderApi.closeDocument.mockResolvedValue(undefined);

    thumbnailCache.get.mockImplementation((key: string) =>
      key === cachedKey ? cachedBitmap : undefined
    );
    processApi.contactSheetExport.mockImplementation(async (jpegs: Uint8Array[], cols: number) =>
      new Uint8Array([cols, ...jpegs.map(bytes => bytes[0])])
    );

    const out = await exportContactSheet(sourceId, new Uint8Array([1, 2, 3]), 4);

    expect(out).toEqual(new Uint8Array([4, 11, 22]));
    expect(thumbnailCache.get).toHaveBeenCalledWith(cachedKey);
    expect(thumbnailCache.get).toHaveBeenCalledWith(uncachedKey);
    expect(thumbnailCache.retain).toHaveBeenCalledWith(cachedKey);
    expect(thumbnailCache.release).toHaveBeenCalledWith(cachedKey);
    expect(thumbnailCache.set).toHaveBeenCalledWith(uncachedKey, renderedBitmap);
    expect(renderApi.renderPage).toHaveBeenCalledTimes(1);
    expect(renderApi.renderPage).toHaveBeenCalledWith('handle-1', 1, scale);
    expect(bitmapToJpeg).toHaveBeenCalledTimes(2);
    expect(processApi.contactSheetExport).toHaveBeenCalledWith(
      [new Uint8Array([11]), new Uint8Array([22])],
      4,
      expect.any(Object)
    );
  });
});
