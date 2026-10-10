/**
 * AUDIT-2026-10-10 M7 — Merge's and Insert's "add files" now follow the
 * canonical open path (`core/open-document.ts`):
 *
 *  • Cancel during the import adds nothing, says nothing about success, and
 *    frees the sources the finished files had already stored (HRD-45 RT-7);
 *  • refused while a job runs or under the restore prompt, before the picker;
 *  • the document ceiling counts only the documents the add creates (none for
 *    Insert; one for Merge with nothing open), not one per file.
 *
 * `importFiles` is stubbed to register real sources the way the import
 * pipeline does (registered + pending, bytes stored); everything after it is
 * the real store.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

let abortAfter: number | null = null;
let controllerToAbort: AbortController | null = null;
vi.mock('../../src/core/import', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/core/import')>();
  const store = await import('../../src/core/store');
  const opfs = await import('../../src/core/opfs');
  return {
    ...actual,
    importFiles: vi.fn(async (files: File[]) => {
      const imported = [];
      for (const [i, file] of files.entries()) {
        const id = `src-${file.name}`;
        store.markSourcePending(id);
        await opfs.writeSourceBytes(id, new Uint8Array([i]));
        const source = {
          id,
          name: file.name,
          pageCount: 1,
          pageSizes: [{ width: 595, height: 842 }]
        };
        store.registerSource(source);
        imported.push({
          originalFile: file,
          source,
          pages: store.makePageRefs(id, 1),
          warnings: []
        });
        if (abortAfter !== null && i + 1 >= abortAfter) controllerToAbort?.abort();
        if (controllerToAbort?.signal.aborted) break;
      }
      return { imported, failures: [] };
    })
  };
});

const store = await import('../../src/core/store');
const opfs = await import('../../src/core/opfs');
const { toasts, activeJob } = await import('../../src/core/notify');
const recovery = await import('../../src/core/session-recovery');
const { resetHistory } = await import('../../src/core/history');
const { importIntoDocument, mayPickFilesToAdd, prepareFilesToAdd, notifyMerged } =
  await import('../../src/ui/tools/organize/import-into-document');
const { MAX_OPEN_DOCUMENTS } = await import('../../src/core/workspace-limits');

const pdf = (name: string) =>
  new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], name, {
    type: 'application/pdf'
  });

function seedDoc(id = 'd1') {
  store.registerSource({
    id: `base-${id}`,
    name: 'base.pdf',
    pageCount: 2,
    pageSizes: [
      { width: 595, height: 842 },
      { width: 595, height: 842 }
    ]
  });
  const pages = store.makePageRefs(`base-${id}`, 2);
  store.addDocument({ id, name: `${id}.pdf`, pages, annotations: [], dirty: false });
}

beforeEach(() => {
  abortAfter = null;
  controllerToAbort = null;
  toasts.value = [];
  activeJob.value = null;
  resetHistory();
  store.documents.value = [];
  store.sources.value = {};
  store.activeDocId.value = null;
  opfs.__memoryFallback.clear();
  recovery.sessionRecoveryChecked.value = true;
  recovery.sessionRecoveryPrompting.value = false;
});

describe('M7 — a cancelled add adds nothing', () => {
  it('Insert: Cancel after the first of three files — no pages, no success, sources freed', async () => {
    seedDoc();
    controllerToAbort = new AbortController();
    abortAfter = 1;
    const result = await importIntoDocument(
      [pdf('a.pdf'), pdf('b.pdf'), pdf('c.pdf')],
      { signal: controllerToAbort.signal },
      undefined,
      { docId: 'd1', at: 1, createIfMissing: false }
    );
    expect(result).toBeNull();
    expect(store.documents.value[0].pages.map(p => p.sourceDocId)).toEqual(['base-d1', 'base-d1']);
    expect('src-a.pdf' in store.sources.value).toBe(false);
    expect(opfs.__memoryFallback.has('src-a.pdf')).toBe(false);
    expect(toasts.value.some(t => t.tone === 'success')).toBe(false);
  });

  it('Merge with nothing open: Cancel creates no document', async () => {
    controllerToAbort = new AbortController();
    abortAfter = 1;
    const result = await importIntoDocument(
      [pdf('a.pdf'), pdf('b.pdf')],
      { signal: controllerToAbort.signal },
      undefined,
      { docId: null, createIfMissing: true }
    );
    expect(result).toBeNull();
    expect(store.documents.value).toEqual([]);
    expect(store.sources.value).toEqual({});
  });

  it('uncancelled: Insert places pages at the position, in order', async () => {
    seedDoc();
    const result = await importIntoDocument([pdf('a.pdf'), pdf('b.pdf')], {}, undefined, {
      docId: 'd1',
      at: 1,
      createIfMissing: false
    });
    expect(result?.files).toBe(2);
    expect(store.documents.value[0].pages.map(p => p.sourceDocId)).toEqual([
      'base-d1',
      'src-a.pdf',
      'src-b.pdf',
      'base-d1'
    ]);
  });

  it('uncancelled: Merge with nothing open makes one document of every file', async () => {
    const result = await importIntoDocument([pdf('a.pdf'), pdf('b.pdf')], {}, undefined, {
      docId: null,
      createIfMissing: true
    });
    expect(store.documents.value).toHaveLength(1);
    expect(store.documents.value[0].pages.map(p => p.sourceDocId)).toEqual([
      'src-a.pdf',
      'src-b.pdf'
    ]);
    notifyMerged(result!.files);
    expect(toasts.value.at(-1)?.title).toBe('Added 2 documents.');
  });

  it('Insert into a document closed during the import frees what was imported', async () => {
    const result = await importIntoDocument([pdf('a.pdf')], {}, undefined, {
      docId: 'missing',
      at: 0,
      createIfMissing: false
    });
    expect(result).toBeNull();
    expect('src-a.pdf' in store.sources.value).toBe(false);
  });
});

describe('M7 — the pre-checks', () => {
  it('no picker while a job runs', async () => {
    activeJob.value = { label: 'Compress', progress: 0, cancel: () => {} };
    expect(await mayPickFilesToAdd()).toBe(false);
    expect(toasts.value.at(-1)?.title).toBe('Finish or cancel the current operation first.');
  });

  it('no picker under the restore prompt', async () => {
    recovery.sessionRecoveryChecked.value = false;
    recovery.sessionRecoveryPrompting.value = true;
    expect(await mayPickFilesToAdd()).toBe(false);
    expect(toasts.value.at(-1)?.title).toBe('Answer the restore prompt first.');
  });

  it('at the document ceiling, Insert (no new document) is allowed and Merge-from-nothing is not', async () => {
    for (let i = 0; i < MAX_OPEN_DOCUMENTS; i++) seedDoc(`d${i}`);
    const files = [pdf('a.pdf'), pdf('b.pdf')];
    const requestOptions = vi.fn(async () => undefined);
    expect(await prepareFilesToAdd(files, 0, requestOptions)).toEqual({ imageOptions: undefined });
    expect(await prepareFilesToAdd(files, 1, requestOptions)).toBeNull();
    expect(toasts.value.at(-1)?.title).toBe('Too many documents are open.');
    expect(requestOptions).not.toHaveBeenCalled();
  });

  it('an image asks for options; declining them cancels the add', async () => {
    const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'p.png', {
      type: 'image/png'
    });
    const requestOptions = vi.fn(async () => undefined);
    expect(await prepareFilesToAdd([png], 0, requestOptions)).toBeNull();
    expect(requestOptions).toHaveBeenCalledWith([png]);
  });
});
