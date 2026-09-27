/**
 * AUDIT-2026-09-25 RT-9 / RT-13 — the render worker must always destroy a
 * pdf.js loading task it will never hand out again.
 *
 *  - RT-9: `closeDocument` ran `cleanup()` then `destroy()`. `cleanup()` throws
 *    while a page is rendering, so `destroy()` never ran and the document (and
 *    its bytes) leaked for the tab's lifetime.
 *  - RT-13: a load that rejected (encrypted, corrupt) never destroyed its task.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('comlink', () => ({
  expose: vi.fn(),
  transfer: vi.fn(value => value),
  proxy: vi.fn(value => value)
}));

const fake = {
  destroy: vi.fn(async () => {}),
  cleanup: vi.fn(async () => {}),
  // pdf.js's exceptions (e.g. `InvalidPDFException`) are not typed as `Error`.
  reject: null as unknown
};

vi.mock('../../src/core/workers/pdfjs-setup', async () => {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return {
    pdfjsLib,
    openDocument: () => {
      const doc = {
        numPages: 1,
        isPureXfa: false,
        fingerprints: ['fp'],
        cleanup: fake.cleanup,
        getPage: async () => ({
          getViewport: () => ({ width: 100, height: 200 }),
          cleanup: () => {}
        })
      };
      return {
        promise: fake.reject ? Promise.reject(fake.reject) : Promise.resolve(doc),
        destroy: fake.destroy
      };
    }
  };
});

const { renderWorkerImpl } = await import('../../src/core/workers/render.worker');
const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');

beforeEach(() => {
  fake.destroy.mockClear();
  fake.cleanup.mockReset();
  fake.cleanup.mockImplementation(async () => {});
  fake.reject = null;
});

describe('render worker document lifecycle', () => {
  it('destroys the task on close even when cleanup throws mid-render (RT-9)', async () => {
    const info = await renderWorkerImpl.loadDocument(new Uint8Array([1]));
    fake.cleanup.mockImplementation(async () => {
      throw new Error('startCleanup: Page 1 is currently rendering.');
    });

    await renderWorkerImpl.closeDocument(info.handle);
    expect(fake.destroy).toHaveBeenCalledTimes(1);
  });

  it('destroys the task when the load itself fails (RT-13)', async () => {
    fake.reject = new pdfjsLib.InvalidPDFException('bad');
    await expect(renderWorkerImpl.loadDocument(new Uint8Array([1]))).rejects.toThrow();
    expect(fake.destroy).toHaveBeenCalledTimes(1);
  });
});
