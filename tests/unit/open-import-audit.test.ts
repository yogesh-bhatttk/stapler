/**
 * Regression tests for the 2026-09-25 runtime audit's open/import findings,
 * driven through the real store, history, open-document, import and opfs
 * modules:
 *
 *  • GAP-11a — opening a file is not an undo step and never touches another
 *            document's history (supersedes RT-6's global-stack fix).
 *  • GAP-11b — the open-document ceiling and the memory-aware soft limit.
 *  • RT-7  — the open-files path runs as the app job: `activeJob` is set with
 *            a Cancel that aborts the import, and a cancelled open adds
 *            nothing and frees what it had already stored.
 *  • RT-16 — the `%PDF` sniff reads only the first KB; the pdf.js parse is
 *            closed before pdf-lib inspects; a failing close is guarded.
 *  • RT-22 — `registerSourceFromBytes` (FontEmbeddingSection's path) loads
 *            and closes on the same pinned render-worker instance.
 *
 * The workers are stubbed (pdf.js cannot run under node); every stub call is
 * logged with the pinned client it arrived on, so ordering and instance
 * affinity are asserted, not assumed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/db', () => ({
  readSetting: vi.fn(async () => undefined),
  readSettingResult: vi.fn(async () => ({ ok: true, value: undefined })),
  writeSetting: vi.fn(async () => {})
}));

/** Every worker call, tagged with the client it went through. */
const calls: string[] = [];
let pinSeq = 0;
let inspectGate: (() => Promise<void>) | null = null;
let closeFails = false;
let inspectFails = false;

vi.mock('../../src/core/workers', () => {
  const renderApi = (tag: string) => ({
    loadDocument: async () => {
      calls.push(`${tag}:load`);
      return {
        handle: `h-${tag}`,
        pageCount: 1,
        isXfa: false,
        fingerprint: 'f',
        pageSizes: [{ width: 612, height: 792 }]
      };
    },
    closeDocument: async (handle: string) => {
      calls.push(`${tag}:close:${handle}`);
      if (closeFails) throw new Error('worker died');
    }
  });
  const processApi = {
    inspect: async () => {
      calls.push('inspect');
      if (inspectGate) await inspectGate();
      if (inspectFails) throw new Error('inspection failed');
      return {
        hasAcroForm: false,
        fieldCount: 0,
        permissionRestrictions: null,
        permissionRestrictionsUnknown: false
      };
    }
  };
  return {
    renderWorker: {
      lease: <T>(fn: (api: ReturnType<typeof renderApi>) => Promise<T>) => fn(renderApi('pool')),
      pin: () => {
        pinSeq += 1;
        const tag = `pin${pinSeq}`;
        return {
          lease: <T>(fn: (api: ReturnType<typeof renderApi>) => Promise<T>) => fn(renderApi(tag)),
          release: () => {
            calls.push(`${tag}:release`);
          },
          dead: false
        };
      }
    },
    processWorker: {
      lease: <T>(fn: (api: typeof processApi) => Promise<T>) => fn(processApi)
    },
    cvWorker: { lease: <T>(fn: (api: object) => Promise<T>) => fn({}) }
  };
});

const store = await import('../../src/core/store');
const {
  addDocument,
  documents,
  sources,
  activeDocId,
  selectedPageKeys,
  makePageRefs,
  registerSource,
  renameDocument
} = store;
const { undo, redo, canUndo, resetHistory, operationLog } = await import('../../src/core/history');
const { writeSourceBytes, sourceBytesExist, __memoryFallback, __resetOpfsProbeForTests } =
  await import('../../src/core/opfs');
const { sessionRecoveryChecked, sessionRecoveryPrompting } =
  await import('../../src/core/session-recovery');
const { importFilesAsDocuments, addImportedDocuments, runImportJob } =
  await import('../../src/core/open-document');
const { importFiles, registerSourceFromBytes } = await import('../../src/core/import');
const { activeJob, toasts, confirmRequest } = await import('../../src/core/notify');
const {
  MAX_OPEN_DOCUMENTS,
  SOFT_WORKSPACE_BYTES,
  checkOpenCapacity,
  knownSourceBytes,
  recordSourceSize,
  __resetSourceSizesForTests
} = await import('../../src/core/workspace-limits');

const encoder = new TextEncoder();
const pdfFile = (name: string) =>
  new File([encoder.encode(`%PDF-1.7\n% ${name}\n1 0 obj << >> endobj\n%%EOF`)], name, {
    type: 'application/pdf'
  });
const noImages = { requestImageOptions: async () => undefined };
const settle = () => new Promise(resolve => setTimeout(resolve, 5));

function reset() {
  resetHistory();
  documents.value = [];
  sources.value = {};
  activeDocId.value = null;
  selectedPageKeys.value = new Set();
  __memoryFallback.clear();
  toasts.value = [];
  activeJob.value = null;
  calls.length = 0;
  pinSeq = 0;
  inspectGate = null;
  closeFails = false;
  inspectFails = false;
  sessionRecoveryChecked.value = true;
  sessionRecoveryPrompting.value = false;
  __resetSourceSizesForTests();
}

beforeEach(reset);
afterEach(reset);

async function openExisting(id: string) {
  await writeSourceBytes(`src-${id}`, new Uint8Array([1, 2, 3]));
  registerSource({
    id: `src-${id}`,
    name: `${id}.pdf`,
    pageCount: 1,
    pageSizes: [{ width: 1, height: 1 }]
  });
  addDocument({
    id,
    name: `${id}.pdf`,
    pages: makePageRefs(`src-${id}`, 1),
    annotations: [],
    dirty: false
  });
}

/**
 * GAP-11a supersedes RT-6's fix (opening as an undo step in one global stack,
 * which let Ctrl+Z empty the workspace — R-RT-6/7): each document now has its
 * own history, and opening is a workspace action, not an undo step.
 */
describe('GAP-11a — opening is not an undo step, and never touches another history', () => {
  it("opening a file keeps another document's undo, and Ctrl+Z never removes the new document", async () => {
    await openExisting('A');
    renameDocument('A', 'renamed.pdf');

    const result = await importFilesAsDocuments([pdfFile('b.pdf')], noImages);
    expect(result.imported).toBe(1);
    expect(documents.value.map(d => d.name)).toEqual(['renamed.pdf', 'b.pdf']);
    // The new document is active and has nothing to undo.
    expect(activeDocId.value).toBe(documents.value[1].id);
    expect(operationLog()).toEqual([]);
    expect(canUndo()).toBe(false);
    undo();
    expect(documents.value.map(d => d.name)).toEqual(['renamed.pdf', 'b.pdf']);

    // A's rename survived the open, in A's own history.
    expect(operationLog('A').map(e => e.label)).toEqual(['Edit']);
    store.switchDocument('A');
    undo();
    expect(documents.value.map(d => d.name)).toEqual(['A.pdf', 'b.pdf']);
    redo();
    expect(documents.value.map(d => d.name)).toEqual(['renamed.pdf', 'b.pdf']);
  });

  it('opening several files at once records nothing to undo', async () => {
    await importFilesAsDocuments([pdfFile('a.pdf'), pdfFile('b.pdf'), pdfFile('c.pdf')], noImages);
    expect(documents.value).toHaveLength(3);
    for (const doc of documents.value) expect(operationLog(doc.id)).toEqual([]);
    undo();
    expect(documents.value).toHaveLength(3);
  });

  it('addImportedDocuments (the Recents and paste path) leaves the other history intact', async () => {
    await openExisting('A');
    renameDocument('A', 'renamed.pdf');
    const file = pdfFile('pasted.pdf');
    const outcome = await importFiles([file]);
    addImportedDocuments(outcome, [file]);
    expect(documents.value.map(d => d.name)).toEqual(['renamed.pdf', 'pasted.pdf']);
    // Ctrl+Z on the pasted document does nothing; A still has its rename.
    undo();
    expect(documents.value.map(d => d.name)).toEqual(['renamed.pdf', 'pasted.pdf']);
    expect(canUndo('A')).toBe(true);
  });
});

describe('GAP-11b — the open-document ceiling', () => {
  it('refuses an open that would pass MAX_OPEN_DOCUMENTS, with a message, adding nothing', async () => {
    for (let i = 0; i < MAX_OPEN_DOCUMENTS - 1; i++) await openExisting(`D${i}`);
    toasts.value = [];
    calls.length = 0;
    const result = await importFilesAsDocuments([pdfFile('a.pdf'), pdfFile('b.pdf')], noImages);
    expect(result.imported).toBe(0);
    expect(documents.value).toHaveLength(MAX_OPEN_DOCUMENTS - 1);
    // Refused before any work: nothing was parsed or stored.
    expect(calls.filter(c => c.endsWith(':load'))).toEqual([]);
    const toast = toasts.value.find(t => t.title === 'Too many documents are open.');
    expect(toast?.detail).toContain(String(MAX_OPEN_DOCUMENTS));
    expect(toast?.detail).toMatch(/close some tabs/i);

    // One more still fits.
    expect((await importFilesAsDocuments([pdfFile('c.pdf')], noImages)).imported).toBe(1);
    expect(documents.value).toHaveLength(MAX_OPEN_DOCUMENTS);
  });

  it('addDocument is refused at the ceiling (the backstop for every open path)', async () => {
    for (let i = 0; i < MAX_OPEN_DOCUMENTS; i++) await openExisting(`D${i}`);
    const added = addDocument({
      id: 'over',
      name: 'over.pdf',
      pages: makePageRefs('src-D0', 1),
      annotations: [],
      dirty: false
    });
    expect(added).toBe(false);
    expect(documents.value).toHaveLength(MAX_OPEN_DOCUMENTS);
  });

  it('addImportedDocuments adds what fits, frees the rest and says so', async () => {
    for (let i = 0; i < MAX_OPEN_DOCUMENTS - 1; i++) await openExisting(`D${i}`);
    const files = [pdfFile('a.pdf'), pdfFile('b.pdf')];
    const outcome = await importFiles(files);
    toasts.value = [];
    addImportedDocuments(outcome, files);
    expect(documents.value).toHaveLength(MAX_OPEN_DOCUMENTS);
    expect(documents.value.at(-1)?.name).toBe('a.pdf');
    const refusedSource = outcome.imported[1].source.id;
    expect(refusedSource in sources.value).toBe(false);
    await settle();
    expect(await sourceBytesExist(refusedSource)).toBe(false);
    expect(toasts.value.some(t => t.title === 'Some files were not opened.')).toBe(true);
  });

  it('asks before passing the memory-aware soft limit, and opens nothing on Cancel', async () => {
    await openExisting('A');
    recordSourceSize('src-A', SOFT_WORKSPACE_BYTES);
    const answers: boolean[] = [false, true];
    const titles: string[] = [];
    const unsubscribe = confirmRequest.subscribe(request => {
      if (!request) return;
      titles.push(request.title);
      const answer = answers.shift() ?? true;
      queueMicrotask(() => request.resolve(answer));
    });
    try {
      const refused = await importFilesAsDocuments([pdfFile('big.pdf')], noImages);
      expect(refused.imported).toBe(0);
      expect(documents.value).toHaveLength(1);
      const accepted = await importFilesAsDocuments([pdfFile('big.pdf')], noImages);
      expect(accepted.imported).toBe(1);
      expect(titles).toEqual(['Open these files anyway?', 'Open these files anyway?']);
    } finally {
      unsubscribe();
    }
  });

  it('checkOpenCapacity: hard ceiling on count, soft limit on bytes', () => {
    expect(checkOpenCapacity(19, 1, 0, 0).ok).toBe(true);
    expect(checkOpenCapacity(20, 1, 0, 0)).toEqual({ ok: false, openCount: 20, max: 20 });
    expect(checkOpenCapacity(3, 2, 10, 5, 4)).toMatchObject({ ok: false });
    expect(checkOpenCapacity(1, 1, 90, 20, 20, 100)).toEqual({
      ok: true,
      overSoftLimit: true,
      projectedBytes: 110
    });
    expect(checkOpenCapacity(1, 1, 50, 20, 20, 100)).toEqual({ ok: true, overSoftLimit: false });
  });

  it('source sizes are learnt from OPFS writes and forgotten on delete', async () => {
    await writeSourceBytes('sized', new Uint8Array(1234));
    expect(knownSourceBytes(['sized'])).toBe(1234);
    const { deleteSourceBytes } = await import('../../src/core/opfs');
    await deleteSourceBytes('sized');
    expect(knownSourceBytes(['sized'])).toBe(0);
  });
});

describe('RT-7 — the open path is a cancellable job', () => {
  it('sets activeJob while importing and clears it after', async () => {
    let seen: string | null = null;
    inspectGate = async () => {
      seen = activeJob.value?.label ?? null;
    };
    await importFilesAsDocuments([pdfFile('a.pdf')], noImages);
    expect(seen).toBeTruthy();
    expect(activeJob.value).toBeNull();
    // Undo is locked while it runs (canUndo reads activeJob) and free after.
    renameDocument(documents.value[0].id, 'x.pdf');
    expect(canUndo()).toBe(true);
  });

  it('Cancel aborts mid-batch: nothing is added and stored bytes are freed', async () => {
    let release!: () => void;
    let inspections = 0;
    inspectGate = () => {
      inspections += 1;
      if (inspections < 2) return Promise.resolve();
      return new Promise<void>(resolve => {
        release = resolve;
      });
    };
    const pending = importFilesAsDocuments(
      [pdfFile('a.pdf'), pdfFile('b.pdf'), pdfFile('c.pdf')],
      noImages
    );
    await vi.waitFor(() => expect(inspections).toBe(2));
    expect(activeJob.value).not.toBeNull();
    activeJob.value!.cancel();
    release();

    const result = await pending;
    expect(result).toEqual({ imported: 0, cancelled: true });
    expect(documents.value).toHaveLength(0);
    expect(activeJob.value).toBeNull();
    expect(operationLog()).toHaveLength(0);
    // a.pdf finished before Cancel; its bytes must not linger unreferenced.
    await settle();
    expect(Object.keys(sources.value)).toEqual([]);
    expect([...__memoryFallback.keys()]).toEqual([]);
  });

  it('refuses, with a message, while another job holds the slot', async () => {
    activeJob.value = { label: 'Compressing', progress: 0.5, cancel: () => {} };
    const result = await importFilesAsDocuments([pdfFile('a.pdf')], noImages);
    expect(result.imported).toBe(0);
    expect(documents.value).toHaveLength(0);
    expect(toasts.value.some(t => /Finish or cancel/.test(t.title))).toBe(true);
    // The other job's slot is untouched.
    expect(activeJob.value?.label).toBe('Compressing');
  });

  it('still refuses during the restore prompt (RT-14)', async () => {
    sessionRecoveryChecked.value = false;
    sessionRecoveryPrompting.value = true;
    const result = await importFilesAsDocuments([pdfFile('a.pdf')], noImages);
    expect(result.imported).toBe(0);
    expect(activeJob.value).toBeNull();
    expect(calls).toEqual([]);
  });

  it('runImportJob reports progress into activeJob and leaves a newer job alone', async () => {
    const labels: string[] = [];
    await runImportJob('Opening', async job => {
      job.onProgress?.(0.5, 'Halfway');
      labels.push(activeJob.value!.label);
      expect(activeJob.value!.progress).toBe(0.5);
      // Another owner takes the slot (e.g. after this job's own cancel).
      activeJob.value = { label: 'Other', progress: null, cancel: () => {} };
      job.onProgress?.(0.9, 'Late');
    });
    expect(labels).toEqual(['Halfway']);
    expect(activeJob.value?.label).toBe('Other');
  });
});

describe('RT-16 — import reads, copies and closes carefully', () => {
  it('rejects a non-PDF from its first KB, without reading the whole file', async () => {
    const big = new File([new Uint8Array(4 * 1024 * 1024).fill(0x41)], 'movie.pdf', {
      type: 'application/pdf'
    });
    const whole = vi.spyOn(big, 'arrayBuffer');
    const sliced = vi.spyOn(big, 'slice');
    const outcome = await importFiles([big]);
    expect(outcome.imported).toHaveLength(0);
    expect(outcome.failures[0].message).toMatch(/PDF header/);
    expect(sliced).toHaveBeenCalledWith(0, 1024);
    expect(whole).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('an empty file is refused before anything is read', async () => {
    const empty = new File([], 'empty.pdf', { type: 'application/pdf' });
    const outcome = await importFiles([empty]);
    expect(outcome.failures[0].message).toMatch(/empty/i);
  });

  it('closes the pdf.js parse (same pinned instance) before pdf-lib inspects', async () => {
    await importFiles([pdfFile('a.pdf')]);
    expect(calls).toEqual(['pin1:load', 'pin1:close:h-pin1', 'pin1:release', 'inspect']);
  });

  it('a failing close neither fails the import nor leaks the pin', async () => {
    closeFails = true;
    const outcome = await importFiles([pdfFile('a.pdf')]);
    expect(outcome.failures).toEqual([]);
    expect(outcome.imported).toHaveLength(1);
    expect(calls).toContain('pin1:release');
  });

  it('an inspection failure deletes the bytes it had already stored', async () => {
    inspectFails = true;
    const outcome = await importFiles([pdfFile('a.pdf')]);
    expect(outcome.imported).toHaveLength(0);
    expect(outcome.failures[0].message).toMatch(/inspection failed/);
    expect(Object.keys(sources.value)).toEqual([]);
    expect([...__memoryFallback.keys()]).toEqual([]);
  });

  it('in memory-fallback mode the stored array is kept intact (never transferred)', async () => {
    const outcome = await importFiles([pdfFile('a.pdf')]);
    const id = outcome.imported[0].source.id;
    const stored = __memoryFallback.get(id)!;
    expect(stored.byteLength).toBeGreaterThan(0);
    expect(new TextDecoder().decode(stored.subarray(0, 5))).toBe('%PDF-');
  });

  describe('against an OPFS root', () => {
    const nav = navigator as unknown as { storage?: unknown };
    const original = nav.storage;
    const files = new Map<string, Uint8Array>();
    beforeEach(() => {
      files.clear();
      __resetOpfsProbeForTests();
      nav.storage = {
        getDirectory: async () => ({
          getFileHandle: async (name: string) => ({
            createWritable: async () => ({
              write: async (bytes: Uint8Array) => {
                files.set(name, bytes.slice());
              },
              close: async () => {}
            }),
            getFile: async () => new File([files.get(name) ?? new Uint8Array()], name)
          }),
          removeEntry: async (name: string) => {
            files.delete(name);
          }
        })
      };
    });
    afterEach(() => {
      nav.storage = original;
      __resetOpfsProbeForTests();
    });

    it('stores the bytes before inspecting, and removes them if inspection fails', async () => {
      const ok = await importFiles([pdfFile('a.pdf')]);
      const id = ok.imported[0].source.id;
      expect(files.has(`${id}.pdf`)).toBe(true);

      inspectFails = true;
      const bad = await importFiles([pdfFile('b.pdf')]);
      expect(bad.imported).toHaveLength(0);
      expect([...files.keys()]).toEqual([`${id}.pdf`]);
    });
  });
});

describe('RT-22 — registerSourceFromBytes pins one instance', () => {
  it('loads and closes on the same pinned client, then releases it', async () => {
    const source = await registerSourceFromBytes(encoder.encode('%PDF-1.7'), 'fixed.pdf');
    expect(calls).toEqual(['pin1:load', 'pin1:close:h-pin1', 'pin1:release']);
    expect(calls.some(c => c.startsWith('pool:'))).toBe(false);
    expect(sources.value[source.id]).toMatchObject({ name: 'fixed.pdf', pageCount: 1 });
    expect(await sourceBytesExist(source.id)).toBe(true);
  });

  it('a failing close still registers the source and releases the pin', async () => {
    closeFails = true;
    const source = await registerSourceFromBytes(encoder.encode('%PDF-1.7'), 'fixed.pdf');
    expect(source.id in sources.value).toBe(true);
    expect(calls).toContain('pin1:release');
  });
});
