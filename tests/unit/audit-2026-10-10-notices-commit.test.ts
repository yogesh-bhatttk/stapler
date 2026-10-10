/**
 * AUDIT 2026-10-10 P2/P4 follow-up — every commit path, not only the merge
 * export, tells the user what a compose had to change. Driven through the real
 * `commitTool` with the real process worker; only saving and the review dialog
 * are replaced.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

async function pageText(bytes: Uint8Array, pageNumber: number): Promise<string> {
  const pdf = await getDocument({ data: bytes.slice() }).promise;
  const content = await (await pdf.getPage(pageNumber)).getTextContent();
  return (content.items as { str: string }[]).map(i => i.str).join(' ');
}

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
  // `any`: stands in for the pool's `Comlink.Remote<T>` wrapper (as in
  // export-fast-web-view.test.ts, which this mirrors).

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
  return { ...actual, requestExportReview: async () => true, confirmAction: async () => true };
});

const { commitTool } = await import('../../src/ui/tools/commit');
const store = await import('../../src/core/store');
const { resetHistory } = await import('../../src/core/history');
const { __memoryFallback } = await import('../../src/core/opfs');
const { toasts } = await import('../../src/core/notify');

async function filledForm(value: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const field = doc.getForm().createTextField('Name');
  field.setText(value);
  field.addToPage(doc.addPage([612, 792]), { x: 50, y: 700, width: 200, height: 20 });
  return doc.save();
}

/** One open document whose pages come from two filled copies of the same form. */
async function openMergedForms() {
  for (const [id, value] of [
    ['a', 'Alice'],
    ['b', 'Bob']
  ] as const) {
    __memoryFallback.set(id, await filledForm(value));
    store.registerSource({
      id,
      name: `${id}.pdf`,
      pageCount: 1,
      pageSizes: [{ width: 612, height: 792 }]
    });
  }
  const pages = [...store.makePageRefs('a', 1), ...store.makePageRefs('b', 1)];
  const doc = {
    id: 'merged-doc',
    name: 'merged.pdf',
    pages,
    baseline: pages,
    annotations: [],
    dirty: false
  };
  store.addDocument(doc);
  store.activeDocId.value = doc.id;
}

const noticeToasts = () =>
  toasts.value.filter(t => t.title === 'The export changed or left out part of the document.');

beforeEach(() => {
  saved.length = 0;
  toasts.value = [];
  store.documents.value = [];
  store.sources.value = {};
  store.activeDocId.value = null;
  resetHistory();
});

describe('compose notices reach the user on every commit path', () => {
  for (const tool of ['organize', 'annotate', 'cleanup'] as const) {
    it(`${tool}: one warning toast naming the renamed field, before saving`, async () => {
      await openMergedForms();
      await commitTool(tool, {});

      const shown = noticeToasts();
      // Once, although annotate composes a review "before" that reports it too.
      expect(shown).toHaveLength(1);
      expect(shown[0].tone).toBe('warning');
      expect(shown[0].detail).toContain('"Name" → "Name_2"');

      expect(saved).toHaveLength(1);
      const out = await PDFDocument.load(saved[0].bytes);
      const names = out
        .getForm()
        .getFields()
        .map(f => f.getName())
        .sort();
      if (tool === 'annotate') {
        // Annotate flattens the form on export: both values are page ink now.
        expect(names).toEqual([]);
        expect(await pageText(saved[0].bytes, 1)).toContain('Alice');
        expect(await pageText(saved[0].bytes, 2)).toContain('Bob');
      } else {
        expect(names).toEqual(['Name', 'Name_2']);
      }
    });
  }
});
