/**
 * AUDIT-2026-10-10 — document state and export semantics (fix agent C1):
 *
 *  • H1 — redaction marks follow their page (by key) through delete / move /
 *    rotate; the bytes handed to `applyRedactions` are checked.
 *  • UI#29 — "Mark every occurrence" merges with the live marks, deduped.
 *  • H2 — crop boxes and Annotate marks make the document dirty; undo back to
 *    the saved state clears it.
 *  • M2 — redaction never bakes the global overlays (no doubled watermark on
 *    the next export) and keeps crop boxes / Annotate marks on the same pages.
 *  • M3 — Cleanup and Metadata exports carry every pending edit.
 *  • M8 — N-up never offers "Save over original" nor marks the document clean.
 *  • L3 — a download fallback does not mark the document clean.
 *  • L2 — the redaction report holds no bytes.
 *  • L7 — image extraction reads the page content, not the watermarked export.
 *  • UI#12 — alt text follows its page through a reorder; an empty export says so.
 *
 * Driven through the real store, history and `commitTool`, with the platform's
 * writes recorded and the process worker run in-process.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument, PDFRawStream, decodePDFRawStream, PDFArray, PDFName } from 'pdf-lib';

const saved: { name: string; bytes: Uint8Array }[] = [];
const savedOver: string[] = [];
const confirmations: { title: string }[] = [];
const platformState = { supportsFileSystemAccess: true };

vi.mock('comlink', () => ({
  expose: vi.fn(),
  transfer: vi.fn(value => value),
  proxy: vi.fn(v => v)
}));
vi.mock('../../src/platform/current', () => ({
  platform: {
    kind: 'web',
    get supportsFileSystemAccess() {
      return platformState.supportsFileSystemAccess;
    },
    saveFileAs: async (bytes: Uint8Array, name: string) => {
      saved.push({ name, bytes });
      return true;
    },
    saveOver: async (fileId: string) => {
      savedOver.push(fileId);
      return true;
    },
    openFiles: async () => [],
    openDirectory: async () => null,
    persistHandle: async () => {},
    restoreHandles: async () => [],
    reopenHandle: async () => null,
    revokeHandle: async () => {},
    readClipboardImage: async () => null
  }
}));
vi.mock('../../src/core/workers', async () => {
  const { processWorkerImpl } = await import('../../src/core/workers/process.worker');
  const { PDFDocument: Pdf } = await import('pdf-lib');
  // Geometry only: what the redact handler reads back from its rebuilt bytes.
  const render = {
    loadDocument: async (bytes: Uint8Array) => {
      const pdf = await Pdf.load(bytes);
      return {
        handle: 'h',
        pageCount: pdf.getPageCount(),
        pageSizes: pdf.getPages().map(page => page.getSize())
      };
    },
    closeDocument: async () => {}
  };
  // `any`: stands in for the pool's `Comlink.Remote<T>` wrapper, as in
  // size-honesty-commit.test.ts.
  const client = (impl: any) => ({
    lease: (fn: (api: any) => unknown) => fn(impl),
    pin: () => ({ lease: (fn: (api: any) => unknown) => fn(impl), release: () => {} })
  });
  const unavailable = new Proxy(
    {},
    {
      get: () => () => {
        throw new Error('This test does not run that worker');
      }
    }
  );
  return {
    processWorker: client(processWorkerImpl),
    renderWorker: client(render),
    cvWorker: client(unavailable),
    ocrWorker: client(unavailable),
    convertWorker: client(unavailable),
    imageWorker: client(unavailable)
  };
});
vi.mock('../../src/core/notify', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/core/notify')>();
  return {
    ...actual,
    requestExportReview: async () => true,
    confirmAction: async (options: { title: string }) => {
      confirmations.push({ title: options.title });
      return true;
    }
  };
});
vi.mock('../../src/core/operations', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/core/operations')>();
  return {
    ...actual,
    composeDocument: vi.fn(actual.composeDocument),
    applyRedactions: vi.fn(),
    extractEmbeddedImages: vi.fn()
  };
});

const { commitTool } = await import('../../src/ui/tools/commit');
const store = await import('../../src/core/store');
const { resetHistory, undo, redo } = await import('../../src/core/history');
const { __memoryFallback } = await import('../../src/core/opfs');
const { toasts } = await import('../../src/core/notify');
const ops = await import('../../src/core/operations');
const { cropBoxes } = await import('../../src/ui/tools/crop/state');
const { pageAnnotations } = await import('../../src/ui/tools/annotate/state');
const { watermarkSettings } = await import('../../src/ui/tools/watermark/state');
const { nupSettings } = await import('../../src/ui/tools/nup/state');
const { altTextMap, altTextForExport, altTextKey } = await import('../../src/ui/tools/acc/state');
const { documentContentBytes, exportDocumentBytes } =
  await import('../../src/ui/tools/export-compose');
const { ANNOTATION_COLORS } = await import('../../src/core/doc-colors');
const redact = await import('../../src/ui/tools/redact/state');

const WATERMARK = 'CONFIDENTIAL';
const SIZES = [
  { width: 200, height: 300 },
  { width: 210, height: 310 },
  { width: 220, height: 320 }
];

async function threePagePdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  for (const size of SIZES) pdf.addPage([size.width, size.height]);
  return pdf.save();
}

async function openDoc(id = 'S', bytes?: Uint8Array) {
  const source = bytes ?? (await threePagePdf());
  __memoryFallback.set(id, source);
  store.registerSource({ id, name: `${id}.pdf`, pageCount: SIZES.length, pageSizes: SIZES });
  const pages = store.makePageRefs(id, SIZES.length);
  store.addDocument({ id: `${id}-doc`, name: `${id}.pdf`, pages, annotations: [], dirty: false });
  return live(`${id}-doc`);
}

function live(docId: string) {
  const doc = store.documents.value.find(d => d.id === docId);
  if (!doc) throw new Error(`no document ${docId}`);
  return doc;
}

/** Every content stream of every page, decoded, one string per page. */
async function pageContents(bytes: Uint8Array): Promise<string[]> {
  const pdf = await PDFDocument.load(bytes);
  return pdf.getPages().map(page => {
    const contents = page.node.get(PDFName.of('Contents'));
    const refs = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
    return refs
      .map(ref => {
        const stream = pdf.context.lookup(ref);
        return stream instanceof PDFRawStream
          ? new TextDecoder('latin1').decode(decodePDFRawStream(stream).decode())
          : '';
      })
      .join('\n');
  });
}

const hex = (text: string) =>
  [...text].map(c => c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')).join('');

/** Watermark text-show operations on one page's content. */
function watermarkDraws(content: string): number {
  const literal = content.split(`(${WATERMARK})`).length - 1;
  const encoded = content.toUpperCase().split(`<${hex(WATERMARK)}>`).length - 1;
  return literal + encoded;
}

function mark(page: Parameters<typeof redact.markOnPage>[1], pageIndex: number) {
  return redact.markOnPage({ pageIndex, x: 0.1, y: 0.1, width: 0.2, height: 0.1 }, page);
}

beforeEach(() => {
  saved.length = 0;
  savedOver.length = 0;
  confirmations.length = 0;
  platformState.supportsFileSystemAccess = true;
  toasts.value = [];
  store.documents.value = [];
  store.sources.value = {};
  store.activeDocId.value = null;
  store.selectedPageKeys.value = new Set();
  cropBoxes.value = {};
  pageAnnotations.value = {};
  watermarkSettings.value = { ...watermarkSettings.value, text: '' };
  nupSettings.value = null;
  altTextMap.value = new Map();
  redact.pendingRedactions.value = [];
  resetHistory();
  __memoryFallback.clear();
  vi.mocked(ops.applyRedactions).mockReset();
  vi.mocked(ops.extractEmbeddedImages).mockReset();
});

/* ------------------------------------------------------------------ */

describe('H1 — a redaction mark follows its page', () => {
  it('re-indexes a mark on page 3 when page 1 is deleted, and redacts that page', async () => {
    const doc = await openDoc();
    const target = doc.pages[2];
    redact.pendingRedactions.value = [mark(target, 2)];

    store.deletePages(doc.id, [doc.pages[0].key]);
    expect(redact.pendingRedactions.value).toHaveLength(1);
    expect(redact.pendingRedactions.value[0].pageIndex).toBe(1);
    expect(redact.pendingRedactions.value[0].pageKey).toBe(target.key);

    vi.mocked(ops.applyRedactions).mockImplementation(async (bytes, regions) => ({
      bytes,
      verdicts: regions.map(() => ({ pass: true }) as never),
      verified: true
    }));
    await commitTool('redact', {});
    const [bytes, regions] = vi.mocked(ops.applyRedactions).mock.calls[0];
    // The region the worker gets is page index 1 of the bytes it gets, and
    // that page is the one that was marked (its size is unique to it).
    expect(regions).toEqual([{ pageIndex: 1, x: 0.1, y: 0.1, width: 0.2, height: 0.1 }]);
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(2);
    expect(pdf.getPage(1).getSize()).toEqual(SIZES[2]);
    // L2 — the report held in the signal carries no bytes.
    expect(redact.redactionReport.value).not.toBeNull();
    expect('bytes' in (redact.redactionReport.value as object)).toBe(false);
    expect(redact.pendingRedactions.value).toEqual([]);
  });

  it('follows a move, and a mark whose page is deleted is withdrawn out loud', async () => {
    const doc = await openDoc();
    redact.pendingRedactions.value = [mark(doc.pages[0], 0), mark(doc.pages[1], 1)];
    store.movePages(doc.id, [doc.pages[0].key], 3);
    expect(redact.pendingRedactions.value.map(m => m.pageIndex)).toEqual([2, 0]);

    store.deletePages(doc.id, [doc.pages[1].key]);
    expect(redact.pendingRedactions.value.map(m => m.pageKey)).toEqual([doc.pages[0].key]);
    expect(
      toasts.value.some(
        t => t.tone === 'warning' && /redaction marks? (was|were) removed/.test(t.title)
      )
    ).toBe(true);
  });

  it('withdraws a mark whose page is rotated after it was drawn', async () => {
    const doc = await openDoc();
    redact.pendingRedactions.value = [mark(doc.pages[1], 1)];
    store.rotatePages(doc.id, [doc.pages[1].key], 90);
    expect(redact.pendingRedactions.value).toEqual([]);
    expect(toasts.value.some(t => /redaction marks? (was|were) removed/.test(t.title))).toBe(true);
  });

  it('UI#29 — merges search results into the live marks without duplicates', async () => {
    const doc = await openDoc();
    const drawnDuringSearch = mark(doc.pages[0], 0);
    const found = redact.marksForPages(
      [
        { pageIndex: 1, x: 0.5, y: 0.5, width: 0.1, height: 0.05, text: 'secret' },
        { pageIndex: 7, x: 0, y: 0, width: 0.1, height: 0.1 }
      ],
      doc.pages
    );
    expect(found).toHaveLength(1); // the out-of-range one belongs to no page
    const first = redact.mergeMarks([drawnDuringSearch], found);
    expect(first.marks).toHaveLength(2);
    expect(first.added).toBe(1);
    const again = redact.mergeMarks(first.marks, found);
    expect(again.marks).toHaveLength(2);
    expect(again.added).toBe(0);
  });
});

/* ------------------------------------------------------------------ */

describe('M2 — redaction bakes no overlay and keeps per-page state', () => {
  it('does not double the watermark on the next export; crop and marks survive', async () => {
    const doc = await openDoc();
    watermarkSettings.value = { ...watermarkSettings.value, kind: 'text', text: WATERMARK };
    const page = doc.pages[1];
    cropBoxes.value = { [page.key]: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 } };
    pageAnnotations.value = {
      [page.key]: [
        {
          id: 'n1',
          type: 'rectangle',
          color: ANNOTATION_COLORS[0],
          strokeWidth: 2,
          rect: { x: 0.6, y: 0.6, width: 0.2, height: 0.2 }
        }
      ]
    };
    redact.pendingRedactions.value = [mark(page, 1)];
    vi.mocked(ops.applyRedactions).mockImplementation(async (bytes, regions) => ({
      bytes,
      verdicts: regions.map(() => ({ pass: true }) as never),
      verified: true
    }));
    await commitTool('redact', {});

    const [input] = vi.mocked(ops.applyRedactions).mock.calls[0];
    // What was redacted (and becomes the document's pages) has no overlay and
    // no crop box baked in.
    for (const content of await pageContents(input)) expect(watermarkDraws(content)).toBe(0);
    const redacted = await PDFDocument.load(input);
    expect(redacted.getPage(1).getCropBox()).toEqual(redacted.getPage(1).getMediaBox());

    const after = live(doc.id);
    expect(after.pages.map(p => p.key)).toEqual(doc.pages.map(p => p.key));
    expect(after.pages.every(p => p.sourceDocId !== 'S')).toBe(true);
    expect(cropBoxes.value[page.key]).toBeDefined();
    expect(pageAnnotations.value[page.key]).toHaveLength(1);

    // The next export draws the watermark exactly once per page.
    await commitTool('watermark', {});
    expect(saved).toHaveLength(1);
    const contents = await pageContents(saved[0].bytes);
    expect(contents.map(watermarkDraws)).toEqual([1, 1, 1]);
    const out = await PDFDocument.load(saved[0].bytes);
    // …with the crop applied once (half of each side), not twice.
    expect(out.getPage(1).getCropBox().width).toBeCloseTo(SIZES[1].width * 0.5, 0);
  });

  it('documentContentBytes leaves out crop, watermark and marks', async () => {
    const doc = await openDoc();
    store.rotatePages(doc.id, [doc.pages[0].key], 90); // edited: not the raw-file path
    watermarkSettings.value = { ...watermarkSettings.value, kind: 'text', text: WATERMARK };
    cropBoxes.value = { [doc.pages[0].key]: { x: 0, y: 0, width: 0.5, height: 0.5 } };
    const bytes = await documentContentBytes({}, { stamps: false });
    for (const content of await pageContents(bytes)) expect(watermarkDraws(content)).toBe(0);
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPage(0).getCropBox()).toEqual(pdf.getPage(0).getMediaBox());
    // The exported bytes, by contrast, carry both.
    const exported = await exportDocumentBytes({});
    expect((await pageContents(exported)).map(watermarkDraws)).toEqual([1, 1, 1]);
  });

  it('replaceWithSource keeps keys only for a page-for-page rewrite; keepStamps keeps stamps', async () => {
    const doc = await openDoc();
    store.addAnnotation(doc.id, {
      id: 'st',
      pageKey: doc.pages[0].key,
      type: 'text',
      x: 0,
      y: 0,
      width: 0.1,
      height: 0.1,
      data: 'hi'
    });
    const source = { id: 'R', name: 'r.pdf', pageCount: 3, pageSizes: SIZES };
    store.replaceWithSource(doc.id, source, { pageForPage: true, keepStamps: true });
    expect(live(doc.id).pages.map(p => p.key)).toEqual(doc.pages.map(p => p.key));
    expect(live(doc.id).annotations).toHaveLength(1);
    store.replaceWithSource(doc.id, { ...source, id: 'R2' });
    expect(live(doc.id).pages.some(p => doc.pages.some(o => o.key === p.key))).toBe(false);
    expect(live(doc.id).annotations).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */

describe('H2 — crop boxes and Annotate marks are unsaved changes', () => {
  it('a crop makes the document dirty; undo clears it; redo restores it', async () => {
    const doc = await openDoc();
    const { commit } = await import('../../src/core/history');
    commit(doc.id);
    cropBoxes.value = { [doc.pages[0].key]: { x: 0, y: 0, width: 0.5, height: 0.5 } };
    expect(live(doc.id).dirty).toBe(true);
    undo();
    expect(live(doc.id).dirty).toBe(false);
    redo();
    expect(live(doc.id).dirty).toBe(true);
  });

  it('an Annotate mark makes it dirty; a save clears it; undo past the save is dirty', async () => {
    const doc = await openDoc();
    const { commit } = await import('../../src/core/history');
    commit(doc.id);
    const { addAnnotation } = await import('../../src/ui/tools/annotate/state');
    addAnnotation(doc.pages[0].key, {
      id: 'a',
      type: 'rectangle',
      color: ANNOTATION_COLORS[0],
      strokeWidth: 1,
      rect: { x: 0, y: 0, width: 0.1, height: 0.1 }
    });
    expect(live(doc.id).dirty).toBe(true);

    await commitTool('annotate', {});
    expect(saved).toHaveLength(1);
    expect(live(doc.id).dirty).toBe(false);
    undo();
    expect(live(doc.id).dirty).toBe(true);
  });

  it("a crop on another document's page does not dirty this one", async () => {
    const a = await openDoc('A');
    const b = await openDoc('B');
    cropBoxes.value = { [b.pages[0].key]: { x: 0, y: 0, width: 0.5, height: 0.5 } };
    expect(live(a.id).dirty).toBe(false);
    expect(live(b.id).dirty).toBe(true);
  });
});

/* ------------------------------------------------------------------ */

describe('M3 — every PDF export carries every pending edit', () => {
  it('Cleanup and Metadata exports include the crop, the watermark and the marks', async () => {
    for (const tool of ['cleanup', 'metadata'] as const) {
      store.documents.value = [];
      saved.length = 0;
      const doc = await openDoc(`M-${tool}`);
      watermarkSettings.value = { ...watermarkSettings.value, kind: 'text', text: WATERMARK };
      cropBoxes.value = { [doc.pages[0].key]: { x: 0, y: 0, width: 0.5, height: 0.5 } };
      pageAnnotations.value = {
        [doc.pages[0].key]: [
          {
            id: 'm',
            type: 'rectangle',
            color: ANNOTATION_COLORS[0],
            strokeWidth: 1,
            rect: { x: 0, y: 0, width: 0.1, height: 0.1 }
          }
        ]
      };
      vi.mocked(ops.composeDocument).mockClear();
      await commitTool(tool, {});
      expect(saved).toHaveLength(1);
      const out = await PDFDocument.load(saved[0].bytes);
      expect(out.getPage(0).getCropBox().width).toBeCloseTo(SIZES[0].width / 2, 0);
      expect((await pageContents(saved[0].bytes)).map(watermarkDraws)).toEqual([1, 1, 1]);
      const requests = vi.mocked(ops.composeDocument).mock.calls.map(call => call[0]);
      expect(requests.some(r => (r.layerAnnotations?.length ?? 0) === 1)).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ */

describe('M8 / L3 — which saves count as "the document, saved"', () => {
  it('M8 — an N-up export neither offers Save over original nor marks the document clean', async () => {
    const doc = await openDoc();
    store.documents.value = store.documents.value.map(d =>
      d.id === doc.id ? { ...d, sourceHandle: { fileId: 'f', writable: true } } : d
    );
    store.rotatePages(doc.id, [doc.pages[0].key], 90);
    nupSettings.value = { layout: '2-up', margin: 10, gutter: 10, drawBorders: false };
    await commitTool('nup', {});
    expect(saved).toHaveLength(1);
    expect(savedOver).toEqual([]);
    expect(confirmations.some(c => /Save changes/.test(c.title))).toBe(false);
    expect(live(doc.id).dirty).toBe(true);
    expect(live(doc.id).baseline).toBe(doc.pages);
  });

  it('L3 — a download fallback says "Download started" and keeps the document dirty', async () => {
    platformState.supportsFileSystemAccess = false;
    const doc = await openDoc();
    store.rotatePages(doc.id, [doc.pages[0].key], 90);
    await commitTool('organize', {});
    expect(saved).toHaveLength(1);
    expect(live(doc.id).dirty).toBe(true);
    expect(toasts.value.some(t => /^Download started/.test(t.title))).toBe(true);
    expect(toasts.value.some(t => /^Saved /.test(t.title))).toBe(false);
  });

  it('L3 — a picker save does mark it clean', async () => {
    const doc = await openDoc();
    store.rotatePages(doc.id, [doc.pages[0].key], 90);
    await commitTool('organize', {});
    expect(live(doc.id).dirty).toBe(false);
  });
});

/* ------------------------------------------------------------------ */

describe('L7 — image extraction reads the document, not the watermarked export', () => {
  it('hands the extractor the file itself when nothing has been edited', async () => {
    const source = await threePagePdf();
    await openDoc('X', source);
    watermarkSettings.value = { ...watermarkSettings.value, kind: 'text', text: WATERMARK };
    vi.mocked(ops.extractEmbeddedImages).mockResolvedValue({
      bytes: new Uint8Array(),
      entries: []
    } as never);
    await commitTool('extract-img', {});
    const [bytes] = vi.mocked(ops.extractEmbeddedImages).mock.calls[0];
    expect(bytes).toEqual(source);
  });
});

/* ------------------------------------------------------------------ */

describe('UI#12 — alt text', () => {
  it('follows its page through a reorder', async () => {
    const doc = await openDoc();
    altTextMap.value = new Map([[altTextKey(doc.pages[1], 'Im0'), 'A chart']]);
    store.movePages(doc.id, [doc.pages[1].key], 0);
    expect(altTextForExport(altTextMap.value, live(doc.id).pages)).toEqual({ '0:Im0': 'A chart' });
    store.deletePages(doc.id, [doc.pages[1].key]);
    expect(altTextForExport(altTextMap.value, live(doc.id).pages)).toEqual({});
  });

  it('an Accessibility export with no alt text says so instead of doing nothing', async () => {
    await openDoc();
    await commitTool('acc', {});
    expect(saved).toEqual([]);
    expect(toasts.value.some(t => t.title === 'No alt text has been entered.')).toBe(true);
  });
});

/* ------------------------------------------------------------------ */

describe('content rewrites keep pages and keep the document honestly dirty', () => {
  it('a whole-source flatten rewrite keeps each page’s key, source index and rotation', async () => {
    const doc = await openDoc();
    // Reordered, rotated, with a stamp and a crop: all must survive.
    store.movePages(doc.id, [doc.pages[2].key], 0);
    store.rotatePages(doc.id, [doc.pages[1].key], 90);
    const before = live(doc.id).pages;
    cropBoxes.value = { [before[0].key]: { x: 0, y: 0, width: 0.5, height: 0.5 } };
    store.addAnnotation(doc.id, {
      id: 'st',
      pageKey: before[1].key,
      type: 'text',
      x: 0,
      y: 0,
      width: 0.1,
      height: 0.1,
      data: 'hi'
    });
    store.replaceWithSource(
      doc.id,
      { id: 'F', name: 'f.pdf', pageCount: 3, pageSizes: SIZES },
      { sameSourceLayout: true, keepStamps: true }
    );
    const after = live(doc.id).pages;
    expect(after.map(p => [p.key, p.sourceIndex, p.rotation])).toEqual(
      before.map(p => [p.key, p.sourceIndex, p.rotation])
    );
    expect(after.every(p => p.sourceDocId === 'F')).toBe(true);
    expect(live(doc.id).annotations).toHaveLength(1);
    expect(cropBoxes.value[before[0].key]).toBeDefined();
  });

  it('redact, then edit, then undo the edit: still dirty; undo the rewrite: clean', async () => {
    const doc = await openDoc();
    store.replaceWithSource(
      doc.id,
      { id: 'R', name: 'r.pdf', pageCount: 3, pageSizes: SIZES },
      { pageForPage: true }
    );
    expect(live(doc.id).baseline).toBe(doc.baseline);
    expect(live(doc.id).dirty).toBe(true);
    store.rotatePages(doc.id, [doc.pages[0].key], 90);
    undo();
    // Used to read clean here: the rewrite had moved the baseline onto itself.
    expect(live(doc.id).dirty).toBe(true);
    expect(live(doc.id).pages.every(p => p.sourceDocId === 'R')).toBe(true);
    undo();
    expect(live(doc.id).dirty).toBe(false);
  });
});
