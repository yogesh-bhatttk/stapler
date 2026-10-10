/**
 * AUDIT-2026-10-10 — render limits, render handles and undo history.
 *
 *  • M9 — `pageToImageBytes` (PDF → Images, compress's raster route) clamps
 *    its scale like every other render path, so a page too large for a
 *    browser canvas at the chosen DPI is rendered smaller instead of failing
 *    or coming back blank — and PDF → Images names those pages.
 *  • L9 — a render handle opened for a source closed meanwhile (its bytes
 *    still readable, since deletion is asynchronous) is closed and its pinned
 *    client released, never cached.
 *  • L1 — a snapshot dropped off the undo/redo stacks frees the sources only
 *    it could reach (the pre-redaction original, typically) — and never one
 *    a live document's baseline still needs.
 *
 * The real render worker runs in-process on pdf.js + node-canvas, as in
 * `cnv14-pdf-to-img.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { decodeToRgba, installCanvasShims } from './helpers/node-canvas-shims';

vi.setConfig({ testTimeout: 60_000 });

vi.mock('comlink', () => ({
  expose: vi.fn(),
  transfer: vi.fn(value => value),
  proxy: vi.fn(value => value),
  releaseProxy: Symbol('releaseProxy')
}));
vi.mock('../../src/core/workers/pdfjs-setup', async () => {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return {
    pdfjsLib,
    openDocument: ({ data, password }: { data: Uint8Array; password?: string }) =>
      pdfjsLib.getDocument({ data, password, disableFontFace: true, verbosity: 0 })
  };
});

const pins = { opened: 0, released: 0 };
const closed: string[] = [];
const loadHooks: { duringLoad: (() => void) | null } = { duringLoad: null };
vi.mock('../../src/core/workers', async () => {
  const { renderWorkerImpl } = await import('../../src/core/workers/render.worker');
  // `any`: stands in for the pool's `Comlink.Remote<T>` wrapper.
  const api: any = {
    ...renderWorkerImpl,
    loadDocument: async (bytes: Uint8Array) => {
      const info = await renderWorkerImpl.loadDocument(bytes);
      loadHooks.duringLoad?.();
      return info;
    },
    closeDocument: async (handle: string) => {
      closed.push(handle);
      return renderWorkerImpl.closeDocument(handle);
    }
  };
  return {
    renderWorker: {
      lease: (fn: (a: any) => unknown) => fn(api),
      pin: () => {
        pins.opened += 1;
        return {
          dead: false,
          lease: (fn: (a: any) => unknown) => fn(api),
          release: () => {
            pins.released += 1;
          }
        };
      }
    }
  };
});

installCanvasShims();

const { renderWorkerImpl } = await import('../../src/core/workers/render.worker');
const { pagesToImageArchive } = await import('../../src/core/operations');
const { MAX_RENDER_SIDE } = await import('../../src/core/render-limits');
const { renderHandleFor } = await import('../../src/core/render-cache');
const opfs = await import('../../src/core/opfs');
const store = await import('../../src/core/store');
const history = await import('../../src/core/history');
const { unzipSync } = await import('fflate');

/** One very wide page: 14 400 pt × 20 pt. At 150 DPI that is 30 000 px wide. */
async function widePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([14_400, 20]);
  doc.addPage([200, 200]);
  return doc.save();
}

describe('M9 — pageToImageBytes clamps, and PDF → Images says which pages', () => {
  it('renders an over-wide page within the canvas side limit', async () => {
    const bytes = await widePdf();
    const { handle } = await renderWorkerImpl.loadDocument(bytes);
    try {
      const png = await renderWorkerImpl.pageToImageBytes(handle, 0, 'png', 150);
      const { width, height } = await decodeToRgba(png);
      expect(width).toBeLessThanOrEqual(MAX_RENDER_SIDE);
      expect(width).toBeGreaterThan(MAX_RENDER_SIDE - 100);
      expect(height).toBeGreaterThan(0);
      // A page that fits is rendered at exactly the DPI asked for.
      const small = await decodeToRgba(
        await renderWorkerImpl.pageToImageBytes(handle, 1, 'png', 150)
      );
      expect(small.width).toBe(Math.ceil((200 * 150) / 72));
    } finally {
      await renderWorkerImpl.closeDocument(handle);
    }
  });

  it('pagesToImageArchive reports the reduced pages, 1-based', async () => {
    const reduced: number[][] = [];
    const archive = await pagesToImageArchive(await widePdf(), [0, 1], 'jpeg', 150, {
      onReducedDetail: pages => reduced.push(pages)
    });
    expect(reduced).toEqual([[1]]);
    expect(Object.keys(unzipSync(archive)).sort()).toEqual(['page-01.jpg', 'page-02.jpg']);
  });
});

describe('L9 — no render handle is cached for a source closed meanwhile', () => {
  beforeEach(() => {
    pins.opened = 0;
    pins.released = 0;
    closed.length = 0;
    opfs.__memoryFallback.clear();
    store.sources.value = {};
  });

  it('releases the pin, loading nothing, when the source is already gone', async () => {
    // The bytes are still readable — deletion is asynchronous — but the
    // source is no longer registered.
    await opfs.writeSourceBytes('gone', await widePdf());
    await expect(renderHandleFor('gone')).rejects.toMatchObject({ kind: 'UserCancelled' });
    expect(pins).toEqual({ opened: 1, released: 1 });
    // Not cached: a second ask opens (and refuses) afresh.
    await expect(renderHandleFor('gone')).rejects.toMatchObject({ kind: 'UserCancelled' });
    expect(pins).toEqual({ opened: 2, released: 2 });
  });

  it('closes the loaded document and releases the pin when the source closes mid-load', async () => {
    await opfs.writeSourceBytes('closing', await widePdf());
    store.registerSource({ id: 'closing', name: 'c.pdf', pageCount: 2, pageSizes: [] });
    loadHooks.duringLoad = () => {
      store.sources.value = {};
    };
    try {
      await expect(renderHandleFor('closing')).rejects.toMatchObject({ kind: 'UserCancelled' });
    } finally {
      loadHooks.duringLoad = null;
    }
    expect(closed).toHaveLength(1);
    expect(pins).toEqual({ opened: 1, released: 1 });
  });

  it('a registered source still gets its cached handle', async () => {
    await opfs.writeSourceBytes('live', await widePdf());
    store.registerSource({
      id: 'live',
      name: 'live.pdf',
      pageCount: 2,
      pageSizes: [
        { width: 14_400, height: 20 },
        { width: 200, height: 200 }
      ]
    });
    const first = await renderHandleFor('live');
    const second = await renderHandleFor('live');
    expect(second.handle).toBe(first.handle);
    expect(pins).toEqual({ opened: 1, released: 0 });
  });
});

describe('L1 — dropped snapshots free the sources only they could reach', () => {
  const size = { width: 595, height: 842 };
  const flush = () => new Promise(resolve => setTimeout(resolve, 0));

  beforeEach(() => {
    history.resetHistory();
    store.documents.value = [];
    store.sources.value = {};
    store.activeDocId.value = null;
    opfs.__memoryFallback.clear();
  });

  async function seedRedacted() {
    for (const id of ['orig', 'redacted']) {
      store.registerSource({ id, name: `${id}.pdf`, pageCount: 2, pageSizes: [size, size] });
      await opfs.writeSourceBytes(id, new Uint8Array([1]));
    }
    const pages = store.makePageRefs('orig', 2);
    store.addDocument({ id: 'd', name: 'd.pdf', pages, annotations: [], dirty: false });
    // Redaction: the document now reads from `redacted`; only the undo
    // snapshot still reaches `orig`.
    store.replaceWithSource(
      'd',
      { id: 'redacted', name: 'redacted.pdf', pageCount: 2, pageSizes: [size, size] },
      { pageForPage: true }
    );
  }

  it('a new edit after Undo drops the redo step — and the redacted copy it held', async () => {
    await seedRedacted();
    history.undo();
    expect(store.documents.value[0].pages[0].sourceDocId).toBe('orig');
    store.rotatePages('d', [store.documents.value[0].pages[0].key], 90);
    await flush();
    expect('redacted' in store.sources.value).toBe(false);
    expect(opfs.__memoryFallback.has('redacted')).toBe(false);
    expect('orig' in store.sources.value).toBe(true);
  });

  it('the depth cap drops the oldest step — and the pre-redaction original, once saved', async () => {
    await seedRedacted();
    // A save re-anchors the baseline on the redacted pages (and every
    // snapshot's with it), so only the oldest undo step still reaches `orig`.
    store.refreshBaseline('d', store.documents.value[0].pages, []);
    const key = () => store.documents.value[0].pages[0].key;
    for (let i = 0; i < history.MAX_DEPTH; i++) store.rotatePages('d', [key()], 90);
    await flush();
    expect('orig' in store.sources.value).toBe(false);
    expect(opfs.__memoryFallback.has('orig')).toBe(false);
    expect('redacted' in store.sources.value).toBe(true);
  });

  it('unsaved, the original stays: the live baseline (what is on disk) still reads it', async () => {
    await seedRedacted();
    const key = () => store.documents.value[0].pages[0].key;
    for (let i = 0; i < history.MAX_DEPTH + 2; i++) store.rotatePages('d', [key()], 90);
    await flush();
    expect('orig' in store.sources.value).toBe(true);
  });

  it('keeps a source the live document’s baseline still needs', async () => {
    store.registerSource({ id: 'a', name: 'a.pdf', pageCount: 1, pageSizes: [size] });
    store.registerSource({ id: 'b', name: 'b.pdf', pageCount: 1, pageSizes: [size] });
    const pages = [...store.makePageRefs('a', 1), ...store.makePageRefs('b', 1)];
    store.addDocument({ id: 'd', name: 'd.pdf', pages, annotations: [], dirty: false });
    // Delete b's page: only the baseline (and the snapshot) still reach `b`.
    store.deletePages('d', [pages[1].key]);
    const key = () => store.documents.value[0].pages[0].key;
    for (let i = 0; i < history.MAX_DEPTH + 2; i++) store.rotatePages('d', [key()], 90);
    await flush();
    expect('b' in store.sources.value).toBe(true);
  });
});
