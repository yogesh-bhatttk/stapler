/**
 * HRD-23 — export claims checked against the written bytes, through the real
 * `commitTool` with only the platform's `saveFileAs` replaced by a recorder.
 *
 *  - §11.8 / DOC-08: with the "Fast web view" export option on, every object
 *    page 1 needs is written before any object only a later page needs, and no
 *    object stream is written — also after RED-06 encryption, which re-saves the
 *    file. With it off, the export keeps DOC-05's object streams, as before.
 *  - §11.9 / CMP-06: the compression report's size is the length of the bytes
 *    that were written, after Protect, not the size compression measured.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFStream,
  decodePDFRawStream
} from 'pdf-lib';
import type { PDFObject } from 'pdf-lib';

const saved: { name: string; bytes: Uint8Array }[] = [];

vi.mock('comlink', () => ({
  expose: vi.fn(),
  transfer: vi.fn(value => value),
  proxy: vi.fn(v => v)
}));
vi.mock('../../src/platform/current', () => ({
  platform: {
    kind: 'web',
    supportsFileSystemAccess: false,
    saveFileAs: async (bytes: Uint8Array, name: string) => {
      saved.push({ name, bytes });
      return true;
    },
    openFiles: async () => [],
    openDirectory: async () => null,
    saveOver: async () => false,
    persistHandle: async () => {},
    restoreHandles: async () => [],
    reopenHandle: async () => null,
    revokeHandle: async () => {},
    readClipboardImage: async () => null
  }
}));
vi.mock('../../src/core/workers', async () => {
  const { processWorkerImpl } = await import('../../src/core/workers/process.worker');
  // `any`: stands in for the pool's `Comlink.Remote<T>` wrapper (see
  // size-honesty-commit.test.ts, which this mirrors).
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
    renderWorker: client(unavailable),
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
    confirmAction: async () => true
  };
});
vi.mock('../../src/core/operations', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/core/operations')>();
  return {
    ...actual,
    // The render worker (pdf.js + OffscreenCanvas) does not run under Node, so
    // the compression run itself is stubbed; everything from `save()` on is real.
    planCompression: vi.fn(actual.planCompression),
    compressDocument: vi.fn(actual.compressDocument),
    // Spied, not stubbed: the growth-guard tests count encryption passes.
    protectDocument: vi.fn(actual.protectDocument),
    restrictDocument: vi.fn(actual.restrictDocument)
  };
});

const { commitTool } = await import('../../src/ui/tools/commit');
const store = await import('../../src/core/store');
const { resetHistory } = await import('../../src/core/history');
const { __memoryFallback } = await import('../../src/core/opfs');
const { toasts } = await import('../../src/core/notify');
const ops = await import('../../src/core/operations');
const { protection } = await import('../../src/ui/tools/protect/state');
const { compressColour, compressMode, lastCompressionResult } =
  await import('../../src/ui/tools/compress/state');
const { fastWebViewExport, __resetExportSettingsForTests } =
  await import('../../src/ui/tools/export-settings');
const { generateCompressionReportText, buildCompressionReportData } =
  await import('../../src/core/compress-report');
const { processWorkerImpl } = await import('../../src/core/workers/process.worker');

const fixture = (name: string) => new Uint8Array(readFileSync(`tests/fixtures/${name}`));

async function openPdf(id: string, bytes: Uint8Array) {
  __memoryFallback.set(id, bytes);
  const pdf = await PDFDocument.load(bytes);
  const count = pdf.getPageCount();
  store.registerSource({
    id,
    name: `${id}.pdf`,
    pageCount: count,
    pageSizes: Array.from({ length: count }, () => ({ width: 612, height: 792 }))
  });
  const pages = store.makePageRefs(id, count);
  const doc = {
    id: `${id}-doc`,
    name: `${id}.pdf`,
    pages,
    baseline: pages,
    annotations: [],
    dirty: false
  };
  store.addDocument(doc);
  store.activeDocId.value = doc.id;
  return doc;
}

function protectWith(password: string) {
  protection.value = {
    ...protection.value,
    enabled: true,
    userPassword: password,
    confirmPassword: password,
    ownerPassword: ''
  };
}

/** Byte offset of `<n> 0 obj` in the file; object headers stay in the clear when encrypted. */
function objOffset(bytes: Uint8Array, objectNumber: number): number {
  const text = Buffer.from(bytes).toString('latin1');
  return text.search(new RegExp(`(?:^|[\\r\\n])${objectNumber} 0 obj\\b`));
}

/** Every object number reachable from `root`, not following `/Parent` (the way back up the tree). */
function reachable(doc: PDFDocument, root: PDFRef): Set<number> {
  const found = new Set<number>();
  const walk = (value: PDFObject | undefined) => {
    if (value instanceof PDFRef) {
      if (found.has(value.objectNumber)) return;
      found.add(value.objectNumber);
      walk(doc.context.lookup(value));
    } else if (value instanceof PDFDict) {
      for (const [key, entry] of value.entries()) {
        if (key !== PDFName.of('Parent')) walk(entry);
      }
    } else if (value instanceof PDFArray) {
      value.asArray().forEach(walk);
    } else if (value instanceof PDFStream) {
      walk(value.dict);
    }
  };
  walk(root);
  return found;
}

/**
 * Page 1's objects (its dictionary, content, resources, fonts) by offset, and
 * the objects only a later page needs (each later page's own reachable set,
 * minus anything page 1 shares with it).
 */
/** Each page's decoded content streams, joined — what the page draws. */
async function pageContents(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return doc.getPages().map(page => {
    const contents = page.node.Contents();
    const streams =
      contents instanceof PDFArray
        ? contents.asArray().map(ref => doc.context.lookup(ref))
        : [contents];
    return streams
      .map(stream => {
        if (!(stream instanceof PDFRawStream)) throw new Error('expected a raw content stream');
        return Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
      })
      .join('\n');
  });
}

async function layout(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const pages = doc.getPages();
  const first = reachable(doc, pages[0].ref);
  const later = new Set<number>();
  for (const page of pages.slice(1)) {
    for (const n of reachable(doc, page.ref)) if (!first.has(n)) later.add(n);
  }
  const offsets = (set: Set<number>) => [...set].map(n => objOffset(bytes, n));
  return { pageCount: pages.length, first: offsets(first), later: offsets(later) };
}

beforeEach(() => {
  saved.length = 0;
  toasts.value = [];
  store.documents.value = [];
  store.sources.value = {};
  store.activeDocId.value = null;
  store.selectedPageKeys.value = new Set();
  compressMode.value = 'quality';
  compressColour.value = 'keep';
  lastCompressionResult.value = null;
  __resetExportSettingsForTests();
  resetHistory();
});

describe('HRD-23 §11.8 — fast web view reaches the written bytes', () => {
  it('off (the default): the export keeps object streams, as DOC-05 requires', async () => {
    await openPdf('fwv-off', fixture('text-3.pdf'));
    await commitTool('organize', {});

    expect(saved).toHaveLength(1);
    const text = Buffer.from(saved[0].bytes).toString('latin1');
    expect(text).toContain('/ObjStm');
  });

  it('on: page 1’s objects come first and there are no object streams', async () => {
    fastWebViewExport.value = true;
    await openPdf('fwv-on', fixture('text-3.pdf'));
    await commitTool('organize', {});

    expect(saved).toHaveLength(1);
    const bytes = saved[0].bytes;
    const text = Buffer.from(bytes).toString('latin1');
    expect(text).not.toContain('/ObjStm');
    expect(text).not.toMatch(/\/Type\s*\/XRef/);
    expect(text).toMatch(/[\r\n]xref[\r\n]/);

    const { pageCount, first, later } = await layout(bytes);
    expect(pageCount).toBe(3);
    expect(first.length).toBeGreaterThan(1);
    expect(later.length).toBeGreaterThan(1);
    expect([...first, ...later].every(offset => offset >= 0)).toBe(true);
    expect(Math.max(...first)).toBeLessThan(Math.min(...later));

    // Pure layout change: the same pages, in the same order, with the same text.
    expect(await pageContents(bytes)).toEqual(await pageContents(fixture('text-3.pdf')));
  });

  it('on: the ordering survives RED-06 encryption, which re-saves the file', async () => {
    fastWebViewExport.value = true;
    await openPdf('fwv-protected', fixture('text-3.pdf'));
    protectWith('secret');
    await commitTool('organize', {});

    expect(saved).toHaveLength(1);
    const bytes = saved[0].bytes;
    const text = Buffer.from(bytes).toString('latin1');
    expect(text).toContain('/Encrypt');
    expect(text).not.toContain('/ObjStm');

    const { first, later } = await layout(bytes);
    expect(Math.max(...first)).toBeLessThan(Math.min(...later));
  });

  it('the worker rewrite alone: same page count, plain xref, page 1 first', async () => {
    const out = await processWorkerImpl.saveForFastWebView(fixture('text-3.pdf'));
    expect(Buffer.from(out).toString('latin1')).not.toContain('/ObjStm');
    const { pageCount, first, later } = await layout(out);
    expect(pageCount).toBe(3);
    expect(Math.max(...first)).toBeLessThan(Math.min(...later));
  });
});

/**
 * A real, smaller PDF stands in for the compression output: the original
 * with its last page dropped. The plan says page 2 was rasterised, so the
 * report has a page breakdown to print.
 */
async function stubCompression(original: Uint8Array, originalBytes = original.byteLength) {
  const source = await PDFDocument.load(fixture('text-3.pdf'));
  const doc = await PDFDocument.create();
  for (const page of await doc.copyPages(source, [0, 1])) doc.addPage(page);
  const smaller = await doc.save({ useObjectStreams: true });
  expect(smaller.byteLength).toBeLessThan(original.byteLength);
  const plan = {
    pages: [0, 1, 2].map(pageIndex => ({
      pageIndex,
      route: pageIndex === 1 ? ('raster' as const) : ('already-optimized' as const),
      reason: pageIndex === 1 ? 'Scanned page' : 'Text-only page',
      reencode: [],
      actionableBytes: pageIndex === 1 ? 1000 : 0,
      targetPixels: 0,
      imagePixels: 0
    })),
    actionableBytes: 1000,
    skipped: []
  };
  vi.mocked(ops.planCompression).mockResolvedValueOnce({
    plan,
    originalBytes,
    estimatedBytes: smaller.byteLength,
    estimatedFraction: 1 - smaller.byteLength / original.byteLength,
    alreadyOptimized: false
  });
  vi.mocked(ops.compressDocument).mockResolvedValueOnce({
    bytes: smaller,
    originalBytes,
    keptOriginal: false,
    plan,
    imageStats: []
  });
  return { plan, smaller };
}

describe('HRD-23 §11.9 / CMP-06 — the report’s size is the size written to disk', () => {
  it.each([
    ['with Protect on', { protect: true, fastWebView: false }],
    ['with Protect and fast web view on', { protect: true, fastWebView: true }],
    ['with neither', { protect: false, fastWebView: false }]
  ])('%s', async (_label, { protect, fastWebView }) => {
    // A 20 KB content-stream comment on page 3 makes the input large enough
    // that encryption and a plain xref cannot push the output past it.
    const base = await PDFDocument.load(fixture('text-3.pdf'));
    const padding = base.context.register(base.context.stream(`%${'x'.repeat(20_000)}\n`));
    base.getPage(2).node.addContentStream(padding);
    const original = await base.save({ useObjectStreams: false });
    fastWebViewExport.value = fastWebView;
    const doc = await openPdf(`cmp06-${protect}-${fastWebView}`, original);
    if (protect) protectWith('secret');
    const { plan, smaller } = await stubCompression(original);

    await commitTool('compress', {});

    expect(saved).toHaveLength(1);
    const written = saved[0].bytes.byteLength;
    if (protect || fastWebView) expect(written).not.toBe(smaller.byteLength);
    expect(written).toBeLessThan(original.byteLength);
    if (fastWebView) {
      expect(Buffer.from(saved[0].bytes).toString('latin1')).not.toContain('/ObjStm');
    }

    const result = lastCompressionResult.value;
    expect(result?.documentId).toBe(doc.id);
    expect(result?.finalBytes).toBe(written);

    // The stats exactly as CompressPanel's "Export report" builds them.
    const stats = {
      originalBytes: result!.originalBytes,
      compressedBytes: result!.finalBytes ?? result!.compressedBytes,
      keptOriginal: result!.keptOriginal,
      imageStats: result!.imageStats
    };
    const data = buildCompressionReportData(result!.plan, stats);
    expect(data.summary.compressedBytes).toBe(written);
    expect(data.summary.savingsBytes).toBe(original.byteLength - written);
    expect(data.summary.estimated).toBe(false);
    expect(generateCompressionReportText(plan, stats)).toContain(
      `Compressed Size: ${written.toLocaleString()} bytes`
    );
  });
});

/**
 * The fast-web-view ceiling against Protect: fast web view answers for its own
 * share of the growth, measured on the unprotected bytes, and the file is
 * encrypted once. Before the fix `save()` encrypted the fast-web-view bytes,
 * found them over the ceiling, and ran a second full encryption pass over the
 * plain bytes — even with Protect on (`enforce: false`), where the result was
 * never going to be refused — then blamed fast web view for Protect's bytes.
 */
describe('fast web view vs the growth guard — one encryption pass, honest blame', () => {
  /** The compressed output, its fast-web-view rewrite, and a large-enough original. */
  async function sizes() {
    const source = await PDFDocument.load(fixture('text-3.pdf'));
    const doc = await PDFDocument.create();
    for (const page of await doc.copyPages(source, [0, 1])) doc.addPage(page);
    const smaller = await doc.save({ useObjectStreams: true });
    const fast = await processWorkerImpl.saveForFastWebView(smaller);
    // Without object streams the rewrite is larger: the share it answers for.
    expect(fast.byteLength).toBeGreaterThan(smaller.byteLength + 1);
    const base = await PDFDocument.load(fixture('text-3.pdf'));
    const padding = base.context.register(base.context.stream(`%${'x'.repeat(20_000)}\n`));
    base.getPage(2).node.addContentStream(padding);
    const original = await base.save({ useObjectStreams: false });
    return { smaller, fast, original };
  }

  const successDetail = () =>
    toasts.value
      .filter(t => t.tone === 'success')
      .map(t => t.detail ?? '')
      .join(' ');

  beforeEach(() => {
    vi.mocked(ops.protectDocument).mockClear();
    vi.mocked(ops.restrictDocument).mockClear();
  });

  it('Protect on, fast web view fits on its own: kept, encrypted once, not blamed', async () => {
    const { fast, original } = await sizes();
    fastWebViewExport.value = true;
    await openPdf('fwv-guard-fits', original);
    protectWith('secret');
    // The ceiling is exactly the fast-web-view file: it fits, and only
    // encryption (the user's own choice, `enforce: false`) takes it over.
    await stubCompression(original, fast.byteLength);

    await commitTool('compress', {});

    expect(saved).toHaveLength(1);
    expect(ops.protectDocument).toHaveBeenCalledTimes(1);
    const text = Buffer.from(saved[0].bytes).toString('latin1');
    expect(text).toContain('/Encrypt');
    expect(text).not.toContain('/ObjStm');
    expect(saved[0].bytes.byteLength).toBeGreaterThan(fast.byteLength);
    expect(lastCompressionResult.value?.finalBytes).toBe(saved[0].bytes.byteLength);
    expect(successDetail()).not.toContain('saved without fast web view');
  });

  it('Protect on, fast web view alone would pass the original: dropped before encrypting, once', async () => {
    const { smaller, fast, original } = await sizes();
    fastWebViewExport.value = true;
    await openPdf('fwv-guard-over', original);
    protectWith('secret');
    await stubCompression(original, fast.byteLength - 1);

    await commitTool('compress', {});

    expect(saved).toHaveLength(1);
    // One pass, over the plain bytes — never the fast-web-view ones.
    expect(ops.protectDocument).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ops.protectDocument).mock.calls[0][0].byteLength).toBe(smaller.byteLength);
    const text = Buffer.from(saved[0].bytes).toString('latin1');
    expect(text).toContain('/Encrypt');
    expect(successDetail()).toContain('saved without fast web view');
  });

  it('restrictions only (enforced): over the ceiling once encrypted is refused, not re-encrypted', async () => {
    const { fast, original } = await sizes();
    const restricted = (await ops.restrictDocument(fast, -3904, {})).byteLength;
    vi.mocked(ops.restrictDocument).mockClear();
    fastWebViewExport.value = true;
    __memoryFallback.set('fwv-guard-restricted', original);
    store.registerSource({
      id: 'fwv-guard-restricted',
      name: 'fwv-guard-restricted.pdf',
      pageCount: 3,
      pageSizes: Array.from({ length: 3 }, () => ({ width: 612, height: 792 })),
      restrictions: -3904
    });
    const pages = store.makePageRefs('fwv-guard-restricted', 3);
    store.addDocument({
      id: 'fwv-guard-restricted-doc',
      name: 'fwv-guard-restricted.pdf',
      pages,
      annotations: [],
      dirty: false
    });
    store.activeDocId.value = 'fwv-guard-restricted-doc';
    // The fast-web-view file fits unprotected; only the restriction pass takes
    // it over. That pass re-saves without object streams whatever it is given,
    // so the plain bytes would not have fit either: a second pass over them
    // (what `save()` used to do) costs a full encryption and changes nothing.
    await stubCompression(original, restricted - 1);

    await commitTool('compress', {});

    expect(saved).toHaveLength(0);
    expect(ops.restrictDocument).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ops.restrictDocument).mock.calls[0][0].byteLength).toBe(fast.byteLength);
    // Blamed on the restrictions, which is where the growth came from.
    const refusal = toasts.value.find(t => t.title === 'Kept the original file.');
    expect(refusal?.detail).toContain('Re-applying this document’s restrictions');
  });
});
