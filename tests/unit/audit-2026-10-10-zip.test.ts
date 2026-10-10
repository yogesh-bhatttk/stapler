/**
 * AUDIT-2026-10-10 M5/M6 — ZIP archives off the main thread, and a cancelled
 * batch that writes nothing.
 *
 *  • `buildZip` (what `zip.worker.ts` runs) stores already-compressed members
 *    (PDF, JPEG, PNG) and deflates the rest, checks for cancellation between
 *    members, and produces an archive fflate reads back byte-for-byte.
 *  • `listZip` reads names and sizes without inflating anything.
 *  • The batch runner, cancelled mid-run with ZIP output, never opens the
 *    chosen file for writing (that truncated it) and says "cancelled", not
 *    "complete"; a finished run builds its archive through the zip worker.
 *
 * The zip worker's real API runs in-process; the PDF pipeline is stubbed as
 * in `batch-runner.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { unzipSync, zipSync } from 'fflate';

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

const zipCalls: string[][] = [];
vi.mock('../../src/core/workers', async () => {
  const { zipWorkerImpl } = await import('../../src/core/workers/zip.worker');
  return {
    processWorker: {
      lease: <T>(fn: (api: unknown) => Promise<T>) =>
        fn({
          inspect: async () => ({ pageCount: 1, permissionRestrictions: null }),
          compose: async (_p: unknown, sources: Record<string, Uint8Array>) =>
            Object.values(sources)[0],
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
    },
    zipWorker: {
      lease: <T>(fn: (api: typeof zipWorkerImpl) => Promise<T>) =>
        fn({
          ...zipWorkerImpl,
          zip: (entries, job) => {
            zipCalls.push(Object.keys(entries));
            return zipWorkerImpl.zip(entries, job);
          }
        })
    }
  };
});

const { buildZip, listZip, zipLevelFor, openZip } = await import('../../src/core/zip-archive');
const { runBatch } = await import('../../src/ui/tools/batch/runner');
const state = await import('../../src/ui/tools/batch/state');
const { watermarkSettings } = await import('../../src/ui/tools/watermark/state');
const { toasts } = await import('../../src/core/notify');

const PDF = (marker: number) => new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, marker, 10]);

describe('M5/M6 — buildZip / listZip', () => {
  it('stores compressed formats, deflates the rest, and round-trips exactly', async () => {
    const text = new TextEncoder().encode('a'.repeat(5000));
    const pdf = new Uint8Array(5000).fill(7);
    const archive = await buildZip({ 'a.pdf': pdf, 'b.jpg': pdf, 'notes.txt': text });
    const methods = new Map<string, number>();
    unzipSync(archive, {
      filter: f => {
        methods.set(f.name, f.compression);
        return false;
      }
    });
    expect(methods.get('a.pdf')).toBe(0);
    expect(methods.get('b.jpg')).toBe(0);
    expect(methods.get('notes.txt')).toBe(8);
    const back = unzipSync(archive);
    expect(back['a.pdf']).toEqual(pdf);
    expect(back['notes.txt']).toEqual(text);
    expect(zipLevelFor('X.PDF')).toBe(0);
    expect(zipLevelFor('data.csv')).toBe(6);
  });

  it('throws UserCancelled rather than returning a partial archive', async () => {
    let asked = 0;
    const job = {
      progress: () => {},
      cancelled: () => ++asked > 1 // cancelled after the first member
    };
    await expect(
      buildZip({ 'a.pdf': PDF(1), 'b.pdf': PDF(2), 'c.pdf': PDF(3) }, job)
    ).rejects.toMatchObject({ kind: 'UserCancelled' });
  });

  it('lists members from the central directory without inflating them', () => {
    const big = new Uint8Array(200_000).fill(1);
    const archive = zipSync({ 'one.pdf': big, 'two.png': new Uint8Array(3) }, { level: 6 });
    expect(listZip(archive)).toEqual([
      { name: 'one.pdf', size: 200_000 },
      { name: 'two.png', size: 3 }
    ]);
  });

  it('openZip reports an unreadable archive as corrupt', async () => {
    await expect(openZip(new Uint8Array([1, 2, 3]))).rejects.toMatchObject({
      kind: 'CorruptDocument'
    });
  });
});

function inputDir(names: string[], onRead?: (name: string) => void) {
  return {
    name: 'in',
    isSameEntry: async () => false,
    values: async function* () {
      for (const [i, name] of names.entries()) {
        yield {
          kind: 'file' as const,
          name,
          getFile: async () => {
            onRead?.(name);
            return new File([PDF(i)], name, { type: 'application/pdf' });
          }
        };
      }
    }
  };
}

/**
 * An output folder on a case-insensitive filesystem holding `existing`
 * (lower-cased name → bytes). `written` records names in write order.
 */
function folder(existing: Map<string, Uint8Array>, written: string[]) {
  return {
    name: 'out',
    getFileHandle: async (name: string, options?: { create?: boolean }) => {
      const key = name.toLowerCase();
      if (!existing.has(key)) {
        if (!options?.create) throw new DOMException('missing', 'NotFoundError');
        existing.set(key, new Uint8Array());
      }
      return {
        createWritable: async () => ({
          write: async (bytes: Uint8Array) => {
            written.push(name);
            existing.set(key, bytes);
          },
          close: async () => {},
          abort: async () => {}
        })
      };
    }
  };
}

function zipTarget() {
  const writes: Uint8Array[] = [];
  let opened = 0;
  const handle = {
    name: 'out.zip',
    createWritable: async () => {
      opened += 1;
      return {
        write: async (bytes: Uint8Array) => void writes.push(bytes),
        close: async () => {},
        abort: async () => {}
      };
    }
  };
  return { handle, writes, opened: () => opened };
}

beforeEach(() => {
  toasts.value = [];
  zipCalls.length = 0;
  state.activeRecipeId.value = null;
  state.savedRecipes.value = [];
  state.outputPattern.value = '{basename}';
  state.scrubMetadataInBatch.value = false;
  watermarkSettings.value = { ...watermarkSettings.value, kind: 'text', text: '' } as never;
});

describe('M5 — batch ZIP output', () => {
  it('cancelled mid-run: the chosen ZIP is never opened for writing, and the toast says so', async () => {
    const controller = new AbortController();
    const target = zipTarget();
    state.inputDirHandle.value = inputDir(['a.pdf', 'b.pdf', 'c.pdf'], name => {
      if (name === 'b.pdf') controller.abort();
    }) as never;
    state.outputFormat.value = 'zip';
    state.outputZipHandle.value = target.handle as never;

    await runBatch(controller.signal);

    expect(target.opened()).toBe(0);
    expect(target.writes).toEqual([]);
    expect(zipCalls).toEqual([]);
    const titles = toasts.value.map(t => t.title);
    expect(titles).toContain('Batch Cancelled');
    expect(titles).not.toContain('Batch Processing Complete');
    expect(toasts.value.find(t => t.title === 'Batch Cancelled')?.detail).toContain(
      'No ZIP archive was written.'
    );
    expect(state.batchProgress.value.isProcessing).toBe(false);
  });

  it('a finished run builds the archive in the zip worker, members stored', async () => {
    const target = zipTarget();
    state.inputDirHandle.value = inputDir(['a.pdf', 'b.pdf']) as never;
    state.outputFormat.value = 'zip';
    state.outputZipHandle.value = target.handle as never;

    await runBatch(new AbortController().signal);

    expect(zipCalls).toEqual([['a.pdf', 'b.pdf']]);
    expect(target.writes).toHaveLength(1);
    const files = unzipSync(target.writes[0]);
    expect(files['a.pdf']).toEqual(PDF(0));
    expect(files['b.pdf']).toEqual(PDF(1));
    expect(toasts.value.map(t => t.title)).toContain('Batch Processing Complete');
  });

  it('directory output cancelled: says how many were already written, not "complete"', async () => {
    const controller = new AbortController();
    const written: string[] = [];
    state.inputDirHandle.value = inputDir(['a.pdf', 'b.pdf', 'c.pdf'], name => {
      if (name === 'b.pdf') controller.abort();
    }) as never;
    state.outputFormat.value = 'directory';
    state.outputDirHandle.value = folder(new Map(), written) as never;

    await runBatch(controller.signal);

    // b.pdf was mid-flight when Cancel landed, so it finished; c.pdf never started.
    expect(written).toEqual(['a.pdf', 'b.pdf']);
    const cancelledToast = toasts.value.find(t => t.title === 'Batch Cancelled');
    expect(cancelledToast?.detail).toContain('2 files were already saved');
    expect(toasts.value.map(t => t.title)).not.toContain('Batch Processing Complete');
  });
});

describe('L4 — batch directory output never overwrites', () => {
  it('a name already in the output folder gets " (n)", the original is untouched, and the summary says so', async () => {
    const previous = new Uint8Array([42]);
    const existing = new Map([['a.pdf', previous]]);
    const written: string[] = [];
    state.inputDirHandle.value = inputDir(['A.pdf', 'b.pdf']) as never;
    state.outputFormat.value = 'directory';
    state.outputDirHandle.value = folder(existing, written) as never;

    await runBatch(new AbortController().signal);

    expect(written).toEqual(['A (1).pdf', 'b.pdf']);
    expect(existing.get('a.pdf')).toBe(previous);
    expect(existing.get('a (1).pdf')).toEqual(PDF(0));
    const note = state.batchProgress.value.notes.find(n => n.kind === 'renamed');
    expect(note).toMatchObject({ file: 'A.pdf' });
    expect(note?.detail).toContain('Saved as A (1).pdf');
    const summary = toasts.value.find(t => t.title === 'Batch Processing Complete');
    // The English one/other forms come from C2.json once merged; the fallback is the key.
    expect(summary?.detail).toMatch(/1 files? (was|were) saved with a number added/);
    expect(summary?.timeout).toBe(0);
  });
});
