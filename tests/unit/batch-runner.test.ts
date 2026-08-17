/**
 * BAT-01/BAT-03 — the two things a batch run must get right that no pure function
 * can be asked about: which output name each file gets when one of them fails, and
 * where a recipe's settings come from.
 *
 * The worker and the compression pipeline are stubbed; everything under test is
 * decided in `runner.ts` around those calls.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// `batch/state.ts` reads localStorage at module scope.
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

const planCompression = vi.fn(async () => ({ alreadyOptimized: true }));
const compressDocument = vi.fn(async (bytes: Uint8Array) => ({ bytes, keptOriginal: false }));

vi.mock('../../src/core/operations', () => ({
  planCompression: (...args: unknown[]) => planCompression(...(args as [])),
  compressDocument: (...args: unknown[]) => compressDocument(...(args as unknown as [Uint8Array]))
}));

vi.mock('../../src/core/workers', () => ({
  processWorker: {
    lease: <T>(fn: (api: unknown) => Promise<T>) =>
      fn({
        inspect: async () => ({ pageCount: 1 }),
        compose: async (_pages: unknown, sources: Record<string, Uint8Array>) =>
          Object.values(sources)[0]
      })
  }
}));

const { runBatch } = await import('../../src/ui/tools/batch/runner');
const state = await import('../../src/ui/tools/batch/state');
const { compressSettings } = await import('../../src/ui/tools/compress/state');

interface Written {
  name: string;
  bytes: Uint8Array;
}

function fileHandle(name: string, options: { fails?: boolean } = {}) {
  return {
    kind: 'file' as const,
    name,
    getFile: async () => {
      if (options.fails) throw new Error(`cannot read ${name}`);
      return new File([new Uint8Array([1, 2, 3])], name, { type: 'application/pdf' });
    }
  };
}

function dirs(handles: ReturnType<typeof fileHandle>[]) {
  const written: Written[] = [];
  const inDir = {
    name: 'in',
    isSameEntry: async () => false,
    values: async function* () {
      for (const h of handles) yield h;
    }
  };
  const outDir = {
    name: 'out',
    getFileHandle: async (name: string) => ({
      createWritable: async () => ({
        write: async (bytes: Uint8Array) => void written.push({ name, bytes }),
        close: async () => {},
        abort: async () => {}
      })
    })
  };
  return { inDir, outDir, written };
}

beforeEach(() => {
  planCompression.mockClear();
  compressDocument.mockClear();
  state.activeRecipeId.value = null;
  state.savedRecipes.value = [];
  state.outputPattern.value = '{basename}';
});

describe('BAT-03: output names are indexed by input position', () => {
  it("a file that fails does not shift every later file's output name", async () => {
    const { inDir, outDir, written } = dirs([
      fileHandle('a.pdf'),
      fileHandle('b.pdf', { fails: true }),
      fileHandle('c.pdf')
    ]);
    state.inputDirHandle.value = inDir as never;
    state.outputDirHandle.value = outDir as never;
    // A pattern that makes the desync visible: with a success counter, c.pdf
    // used to be written as "doc-2".
    state.outputPattern.value = 'doc-{index}';

    await runBatch();

    expect(written.map(w => w.name)).toEqual(['doc-1.pdf', 'doc-3.pdf']);
    expect(state.batchProgress.value.completed).toBe(2);
    expect(state.batchProgress.value.failed).toBe(1);
  });

  it('does not append a second .pdf when the pattern already ends in .pdf', async () => {
    const { inDir, outDir, written } = dirs([fileHandle('a.pdf')]);
    state.inputDirHandle.value = inDir as never;
    state.outputDirHandle.value = outDir as never;
    state.outputPattern.value = 'doc-{basename}.pdf';

    await runBatch();

    expect(written.map(w => w.name)).toEqual(['doc-a.pdf']);
  });
});

describe('BAT-01: a recipe replays its own snapshot', () => {
  it('does not fall through a missing setting to the live signal', async () => {
    const { inDir, outDir } = dirs([fileHandle('a.pdf')]);
    state.inputDirHandle.value = inDir as never;
    state.outputDirHandle.value = outDir as never;

    // The compress tool is open in another panel with real settings…
    compressSettings.value = { ...compressSettings.value, preset: 'smallest' } as never;
    // …but the active recipe never captured any.
    state.savedRecipes.value = [
      { id: 'r1', name: 'Watermark only', tools: ['compress'], settings: {} }
    ];
    state.activeRecipeId.value = 'r1';

    await runBatch();

    // The live signal is not consulted: nothing was compressed.
    expect(planCompression).not.toHaveBeenCalled();
    expect(compressDocument).not.toHaveBeenCalled();
  });

  it('uses the settings stored in the recipe, not the current ones', async () => {
    const { inDir, outDir } = dirs([fileHandle('a.pdf')]);
    state.inputDirHandle.value = inDir as never;
    state.outputDirHandle.value = outDir as never;

    const saved = { preset: 'balanced', imageQuality: 0.6 };
    state.savedRecipes.value = [
      {
        id: 'r2',
        name: 'Balanced',
        tools: ['compress'],
        settings: { compress: saved as never }
      }
    ];
    state.activeRecipeId.value = 'r2';
    compressSettings.value = { ...compressSettings.value, preset: 'smallest' } as never;

    await runBatch();

    expect(planCompression).toHaveBeenCalledTimes(1);
    expect(planCompression.mock.calls[0][1]).toEqual(saved);
  });
});
