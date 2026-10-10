/**
 * AUDIT 2026-10-10 P4/P6 follow-up — a batch run collects what each file's
 * rebuild had to change or leave out as that file's note in the run summary,
 * not as one toast per file. The worker is stubbed: the compose stub reports a
 * notice through the job handle it is given, exactly as the real worker does.
 */
import { describe, expect, it, vi } from 'vitest';

const memory = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => memory.get(k) ?? null,
    setItem: (k: string, v: string) => void memory.set(k, v),
    removeItem: (k: string) => void memory.delete(k),
    clear: () => memory.clear(),
    key: (i: number) => Array.from(memory.keys())[i] ?? null,
    get length() {
      return memory.size;
    }
  }
});

vi.mock('../../src/core/operations', () => ({
  planCompression: async () => ({ alreadyOptimized: true }),
  compressDocument: async (bytes: Uint8Array) => ({ bytes, keptOriginal: false })
}));

type Port = { notice?: (message: string) => unknown };

vi.mock('../../src/core/workers', () => ({
  processWorker: {
    lease: <T>(fn: (api: unknown) => Promise<T>) =>
      fn({
        inspect: async () => ({ pageCount: 1, permissionRestrictions: null }),
        compose: async (
          _pages: unknown,
          sources: Record<string, Uint8Array>,
          _stamps: unknown,
          _watermark: unknown,
          _headerFooter: unknown,
          _normalize: unknown,
          _nup: unknown,
          _annotations: unknown,
          job: Port | undefined
        ) => {
          // Reported twice: one note per file and message, not per report.
          await job?.notice?.('Not carried into the result: page labels.');
          await job?.notice?.('Not carried into the result: page labels.');
          return new Uint8Array([...Object.values(sources)[0], 0x77]);
        },
        readMetadata: async () => ({ customInfo: [], filesystemPaths: [] }),
        scrubMetadata: async (bytes: Uint8Array) => bytes,
        restrictDocument: async (bytes: Uint8Array) => bytes
      })
  },
  renderWorker: {
    pin: () => ({
      lease: <T>(fn: (api: unknown) => Promise<T>) =>
        fn({
          loadDocument: async () => ({ pageCount: 1, handle: 0 }),
          closeDocument: async () => {}
        }),
      release: () => {}
    })
  }
}));

const { runBatch } = await import('../../src/ui/tools/batch/runner');
const state = await import('../../src/ui/tools/batch/state');
const { watermarkSettings } = await import('../../src/ui/tools/watermark/state');
const { toasts } = await import('../../src/core/notify');

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46];

function fileHandle(name: string) {
  return {
    kind: 'file' as const,
    name,
    getFile: async () =>
      new File([new Uint8Array([0, 2, 3, ...PDF_MAGIC])], name, { type: 'application/pdf' })
  };
}

describe('batch — rebuild notices land in the run summary', () => {
  it('one note per file and message, and one summary line naming the files', async () => {
    const handles = [fileHandle('a.pdf'), fileHandle('b.pdf')];
    state.inputDirHandle.value = {
      name: 'in',
      isSameEntry: async () => false,
      values: async function* () {
        for (const h of handles) yield h;
      }
    } as never;
    state.outputDirHandle.value = {
      name: 'out',
      // Absent until created, as a real directory is (the writer probes for a
      // free name first).
      getFileHandle: async (_name: string, options?: { create?: boolean }) => {
        if (!options?.create) throw Object.assign(new Error('absent'), { name: 'NotFoundError' });
        return {
          createWritable: async () => ({ write: async () => {}, close: async () => {} })
        };
      }
    } as never;
    state.outputPattern.value = '{basename}';
    state.activeRecipeId.value = null;
    state.savedRecipes.value = [];
    watermarkSettings.value = { ...watermarkSettings.value, kind: 'text', text: 'DRAFT' } as never;
    const toastsBefore = toasts.value.length;

    await runBatch();

    const changed = state.batchProgress.value.notes.filter(n => n.kind === 'changed');
    expect(changed).toEqual([
      { file: 'a.pdf', kind: 'changed', detail: 'Not carried into the result: page labels.' },
      { file: 'b.pdf', kind: 'changed', detail: 'Not carried into the result: page labels.' }
    ]);
    // No per-file toast: only the run's own completion summary was added.
    const added = toasts.value.slice(toastsBefore);
    expect(added.map(t => t.title)).toEqual(['Batch Processing Complete']);
    expect(added[0].detail).toContain('a.pdf, b.pdf');
  });
});
