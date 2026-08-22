import { describe, expect, it, vi } from 'vitest';

const { renderApi } = vi.hoisted(() => ({
  renderApi: {
    loadDocument: vi.fn(),
    decodePageBarcodes: vi.fn(),
    closeDocument: vi.fn()
  }
}));

vi.mock('../../src/core/workers', () => ({
  renderWorker: {
    lease: vi.fn(async (fn: (api: typeof renderApi) => Promise<unknown>) => fn(renderApi))
  }
}));

import { scanDocumentBarcodes } from '../../src/core/operations';

describe('scanDocumentBarcodes (SCN-04)', () => {
  it('reports an empty array for a page with none, not an absent entry', async () => {
    renderApi.loadDocument.mockResolvedValue({ handle: 'h1' });
    renderApi.closeDocument.mockResolvedValue(undefined);
    renderApi.decodePageBarcodes.mockImplementation(async (_handle: string, pageIndex: number) =>
      pageIndex === 1 ? [{ text: 'DOC-9', format: 'QRCode' }] : []
    );

    const result = await scanDocumentBarcodes(new Uint8Array([1]), [0, 1, 2]);

    expect(result).toEqual([
      { pageIndex: 0, barcodes: [] },
      { pageIndex: 1, barcodes: [{ text: 'DOC-9', format: 'QRCode' }] },
      { pageIndex: 2, barcodes: [] }
    ]);
    // Every requested page is checked, not just the ones that turn out to
    // have something — "checked, found nothing" must come from actually
    // looking, not from skipping.
    expect(renderApi.decodePageBarcodes).toHaveBeenCalledTimes(3);
  });

  it('reports progress across the requested pages and closes the document', async () => {
    renderApi.loadDocument.mockResolvedValue({ handle: 'h2' });
    renderApi.closeDocument.mockResolvedValue(undefined);
    renderApi.decodePageBarcodes.mockResolvedValue([]);

    const progress: number[] = [];
    await scanDocumentBarcodes(new Uint8Array([1]), [0, 1], {
      onProgress: fraction => progress.push(fraction)
    });

    expect(progress).toEqual([0, 0.5]);
    expect(renderApi.closeDocument).toHaveBeenCalledWith('h2');
  });

  it('reports one page as unscannable rather than aborting the whole scan', async () => {
    renderApi.loadDocument.mockResolvedValue({ handle: 'h4' });
    renderApi.closeDocument.mockResolvedValue(undefined);
    renderApi.decodePageBarcodes.mockClear();
    renderApi.decodePageBarcodes.mockImplementation(async (_handle: string, pageIndex: number) => {
      if (pageIndex === 1) throw new Error('canvas too large');
      return pageIndex === 2 ? [{ text: 'AFTER-THE-FAILURE', format: 'QRCode' }] : [];
    });

    const result = await scanDocumentBarcodes(new Uint8Array([1]), [0, 1, 2]);

    expect(result[0]).toEqual({ pageIndex: 0, barcodes: [] });
    expect(result[1].barcodes).toEqual([]);
    expect(result[1].reason).toMatch(/canvas too large/);
    // The page after the failure is still scanned — one bad page does not
    // take the rest of the document down with it.
    expect(result[2]).toEqual({
      pageIndex: 2,
      barcodes: [{ text: 'AFTER-THE-FAILURE', format: 'QRCode' }]
    });
    expect(renderApi.closeDocument).toHaveBeenCalledWith('h4');
  });

  it('propagates cancellation before scanning the next page', async () => {
    renderApi.loadDocument.mockResolvedValue({ handle: 'h3' });
    renderApi.closeDocument.mockResolvedValue(undefined);
    renderApi.decodePageBarcodes.mockClear();
    renderApi.decodePageBarcodes.mockResolvedValue([]);

    const controller = new AbortController();
    controller.abort();

    await expect(
      scanDocumentBarcodes(new Uint8Array([1]), [0, 1], { signal: controller.signal })
    ).rejects.toThrow();
    expect(renderApi.decodePageBarcodes).not.toHaveBeenCalled();
  });
});
