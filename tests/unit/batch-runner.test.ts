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

const planCompression = vi.fn<(...args: unknown[]) => Promise<{ alreadyOptimized: boolean }>>(
  async () => ({ alreadyOptimized: true })
);
const compressDocument = vi.fn(async (bytes: Uint8Array) => ({ bytes, keptOriginal: false }));

vi.mock('../../src/core/operations', () => ({
  planCompression: (...args: unknown[]) => planCompression(...args),
  compressDocument: (...args: unknown[]) => compressDocument(...(args as unknown as [Uint8Array]))
}));

// RED-09: each byte array's own single byte stands in for "this file's own
// metadata" — readMetadata reports an author only for the file whose marker
// byte is 1, so a test can prove file B's scrub decision never leaks from
// file A's findings.
const readMetadata = vi.fn(async (bytes: Uint8Array) => ({
  author: bytes[0] === 1 ? 'Leaked Name' : undefined,
  hasXmp: false,
  hasEmbeddedJavaScript: false,
  hasOpenAction: false,
  hasAdditionalActions: false,
  hasEmbeddedFiles: false,
  hasPageThumbnails: false,
  hasOptionalContent: false,
  hasCustomInfo: false,
  customInfo: [],
  filesystemPaths: []
}));
const scrubMetadata = vi.fn(async (bytes: Uint8Array) => new Uint8Array([...bytes, 0xff]));

/**
 * The second byte stands in for "this file arrived permission-restricted": a
 * 9 means an `/Encrypt` dictionary with `/P -3904` (Acrobat's view-only), the
 * way `permission-no-print.pdf` is built. `permission-restrictions.test.ts`
 * proves the real flags survive a real export; what is in question here is
 * only whether the batch runner asks for them at all, and for which files.
 */
const restrictDocument = vi.fn<(bytes: Uint8Array, ...rest: unknown[]) => Promise<Uint8Array>>(
  async bytes => new Uint8Array([...bytes, 0xee])
);

vi.mock('../../src/core/workers', () => ({
  processWorker: {
    lease: <T>(fn: (api: unknown) => Promise<T>) =>
      fn({
        inspect: async (bytes: Uint8Array) => ({
          pageCount: 1,
          permissionRestrictions: bytes[1] === 9 ? -3904 : null
        }),
        // §4: appends a marker byte when a watermark is actually passed, so a
        // test can tell "watermark ran and changed the bytes" apart from
        // "watermark ran and was a no-op" — the same way `scrubMetadata`'s
        // `0xff` and `restrictDocument`'s `0xee` stand in for their own effects.
        compose: async (
          _pages: unknown,
          sources: Record<string, Uint8Array>,
          _extraSources: unknown,
          watermarkData: unknown
        ) => {
          const base = Object.values(sources)[0];
          return watermarkData ? new Uint8Array([...base, 0x77]) : base;
        },
        readMetadata: (...args: unknown[]) => readMetadata(...(args as [Uint8Array])),
        scrubMetadata: (...args: unknown[]) => scrubMetadata(...(args as [Uint8Array])),
        restrictDocument: (...args: unknown[]) =>
          restrictDocument(...(args as [Uint8Array, ...unknown[]]))
      })
  },
  // §1.8's validation gate pins a render-worker client to parse each file before
  // any tool runs. Stubbed to always report one page, since real pdf.js parsing
  // is out of scope for this test — the "§1.8" describe block below exercises
  // the gate's own reject/accept behaviour, which only depends on the raw bytes
  // and never reaches this stub.
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
const { compressSettings } = await import('../../src/ui/tools/compress/state');
const { watermarkSettings } = await import('../../src/ui/tools/watermark/state');
const { toasts } = await import('../../src/core/notify');

interface Written {
  name: string;
  bytes: Uint8Array;
}

// §1.8's validation gate (runner.ts) rejects anything that doesn't contain a
// `%PDF` header, so every fixture below carries one — appended after the
// marker bytes the rest of this file reads by position (bytes[0]/bytes[1]),
// so their meaning is unchanged.
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46]; // %PDF

function fileHandle(
  name: string,
  options: { fails?: boolean; marker?: number; restricted?: boolean } = {}
) {
  return {
    kind: 'file' as const,
    name,
    getFile: async () => {
      if (options.fails) throw new Error(`cannot read ${name}`);
      return new File(
        [new Uint8Array([options.marker ?? 0, options.restricted ? 9 : 2, 3, ...PDF_MAGIC])],
        name,
        {
          type: 'application/pdf'
        }
      );
    }
  };
}

/** A file handle whose bytes are exactly what the test passes, for validation-gate tests. */
function rawFileHandle(name: string, bytes: Uint8Array) {
  return {
    kind: 'file' as const,
    name,
    getFile: async () => new File([bytes], name, { type: 'application/pdf' })
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
  readMetadata.mockClear();
  scrubMetadata.mockClear();
  restrictDocument.mockClear();
  state.activeRecipeId.value = null;
  state.savedRecipes.value = [];
  state.outputPattern.value = '{basename}';
  state.scrubMetadataInBatch.value = false;
  watermarkSettings.value = { ...watermarkSettings.value, kind: 'text', text: '' } as never;
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

/**
 * §2.1 — `runBatch` used to have no reentrancy guard at all: only the "Run
 * Batch" button's `disabled` prop stopped a second click, and that prop does
 * not flip true until React re-renders after `batchProgress.value.isProcessing`
 * is set — which itself happens only after this function's first `await`. A
 * fast double-click/double-Enter before that render could start two
 * concurrent runs, both mutating `batchProgress` and both writing to the same
 * output. The fix is a plain module-level flag checked and set synchronously,
 * before `runBatch`'s first `await`, so nothing can interleave between the
 * check and the set.
 */
describe('§2.1: a second concurrent runBatch() call is a no-op', () => {
  it('only the first call actually processes files', async () => {
    const { inDir, outDir, written } = dirs([fileHandle('a.pdf'), fileHandle('b.pdf')]);
    state.inputDirHandle.value = inDir as never;
    state.outputDirHandle.value = outDir as never;

    // Called back-to-back with no `await` between them — the second call
    // lands inside the synchronous prefix of the first, before its first
    // `await` yields control back to this test.
    const first = runBatch();
    const second = runBatch();
    await Promise.all([first, second]);

    // Exactly one run's worth of output — not zero, and not double-written.
    expect(written.map(w => w.name).sort()).toEqual(['a.pdf', 'b.pdf']);
    expect(state.batchProgress.value.completed).toBe(2);
  });

  it('a run started after the first one finishes is not blocked', async () => {
    const { inDir, outDir, written } = dirs([fileHandle('a.pdf')]);
    state.inputDirHandle.value = inDir as never;
    state.outputDirHandle.value = outDir as never;

    await runBatch();
    expect(written.map(w => w.name)).toEqual(['a.pdf']);

    const { inDir: inDir2, outDir: outDir2, written: written2 } = dirs([fileHandle('c.pdf')]);
    state.inputDirHandle.value = inDir2 as never;
    state.outputDirHandle.value = outDir2 as never;
    await runBatch();

    expect(written2.map(w => w.name)).toEqual(['c.pdf']);
  });
});

/**
 * §1.8 (AUDIT-EDGE-CASES-2026-09-15, EPIC-19 in docs/TICKETS.md) — batch had no equivalent of
 * importPdf()'s validation gate, so a non-PDF or corrupt file in a batch
 * folder either threw a raw internal error or silently produced wrong output.
 * It must fail the same clear, classified way "Add PDF" would.
 */
describe('§1.8: a bad file in a batch folder fails cleanly', () => {
  it('rejects a file with no PDF header instead of crashing or silently mis-processing it', async () => {
    const { inDir, outDir, written } = dirs([
      rawFileHandle('good.pdf', new Uint8Array([0, 2, 3, ...PDF_MAGIC])),
      rawFileHandle('not-a-pdf.pdf', new Uint8Array([1, 2, 3, 4, 5]))
    ]);
    state.inputDirHandle.value = inDir as never;
    state.outputDirHandle.value = outDir as never;

    await runBatch();

    // The good file still processes; the bad one fails, not the whole batch.
    expect(written.map(w => w.name)).toEqual(['good.pdf']);
    expect(state.batchProgress.value.completed).toBe(1);
    expect(state.batchProgress.value.failed).toBe(1);
    const note = state.batchProgress.value.notes.find(n => n.file === 'not-a-pdf.pdf');
    expect(note?.kind).toBe('failed');
    expect(note?.detail).toMatch(/pdf header/i);
  });

  it('rejects an empty file cleanly', async () => {
    const { inDir, outDir } = dirs([rawFileHandle('empty.pdf', new Uint8Array([]))]);
    state.inputDirHandle.value = inDir as never;
    state.outputDirHandle.value = outDir as never;

    await runBatch();

    expect(state.batchProgress.value.failed).toBe(1);
    const note = state.batchProgress.value.notes.find(n => n.file === 'empty.pdf');
    expect(note?.detail).toMatch(/empty/i);
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

    const saved = { dpi: 120, quality: 0.6 };
    state.savedRecipes.value = [
      {
        id: 'r2',
        name: 'Balanced',
        tools: ['compress'],
        settings: { compress: saved }
      }
    ];
    state.activeRecipeId.value = 'r2';
    compressSettings.value = { ...compressSettings.value, preset: 'smallest' } as never;

    await runBatch();

    expect(planCompression).toHaveBeenCalledTimes(1);
    expect(planCompression.mock.calls[0][1]).toEqual(saved);
  });
});

describe('X-15: a malformed stored recipe stops the run with a clear message', () => {
  it('refuses to run, names the bad fields, and writes nothing', async () => {
    const { inDir, outDir, written } = dirs([fileHandle('a.pdf')]);
    state.inputDirHandle.value = inDir as never;
    state.outputDirHandle.value = outDir as never;
    toasts.value = [];
    // What an older build or a hand-edited import could leave in IndexedDB:
    // a numeric field stored as a string and a watermark with no position.
    state.savedRecipes.value = [
      {
        id: 'bad',
        name: 'Broken',
        tools: ['compress', 'watermark'],
        settings: {
          compress: { dpi: '150', quality: 0.75 },
          watermark: { ...watermarkSettings.value, text: 'DRAFT', position: undefined }
        }
      }
    ];
    state.activeRecipeId.value = 'bad';

    await runBatch();

    expect(planCompression).not.toHaveBeenCalled();
    expect(written).toEqual([]);
    expect(state.batchProgress.value.isProcessing).toBe(false);
    const toast = toasts.value.find(t => t.tone === 'danger');
    expect(toast?.title).toBe('Recipe settings could not be read');
    expect(toast?.detail).toContain('"Broken"');
    expect(toast?.detail).toContain('compress.dpi');
    expect(toast?.detail).toContain('watermark.position');
  });

  it('refuses a recipe whose tools are not a list of tool ids', async () => {
    const { inDir, outDir, written } = dirs([fileHandle('a.pdf')]);
    state.inputDirHandle.value = inDir as never;
    state.outputDirHandle.value = outDir as never;
    toasts.value = [];
    state.savedRecipes.value = [{ id: 'bad', name: 'Broken', tools: 'compress', settings: {} }];
    state.activeRecipeId.value = 'bad';

    await runBatch();

    expect(written).toEqual([]);
    expect(toasts.value.find(t => t.tone === 'danger')?.detail).toContain('tools');
  });

  it('still runs a recipe an older build saved with null for untouched tools', async () => {
    const { inDir, outDir, written } = dirs([fileHandle('a.pdf')]);
    state.inputDirHandle.value = inDir as never;
    state.outputDirHandle.value = outDir as never;
    state.savedRecipes.value = [
      {
        id: 'old',
        name: 'Old',
        tools: ['compress'],
        settings: { compress: { dpi: 150, quality: 0.75 }, nup: null, normalize: null }
      }
    ];
    state.activeRecipeId.value = 'old';

    await runBatch();

    expect(planCompression).toHaveBeenCalledTimes(1);
    expect(planCompression.mock.calls[0][1]).toEqual({ dpi: 150, quality: 0.75 });
    expect(written.map(w => w.name)).toEqual(['a.pdf']);
  });
});

describe('RED-09: batch metadata scrub', () => {
  it('is a no-op when the option is off', async () => {
    const { inDir, outDir } = dirs([fileHandle('a.pdf', { marker: 1 })]);
    state.inputDirHandle.value = inDir as never;
    state.outputDirHandle.value = outDir as never;
    state.scrubMetadataInBatch.value = false;

    await runBatch();

    expect(readMetadata).not.toHaveBeenCalled();
    expect(scrubMetadata).not.toHaveBeenCalled();
  });

  it("decides each file from its own findings, not the first file's", async () => {
    const { inDir, outDir, written } = dirs([
      fileHandle('has-author.pdf', { marker: 1 }),
      fileHandle('clean.pdf', { marker: 0 })
    ]);
    state.inputDirHandle.value = inDir as never;
    state.outputDirHandle.value = outDir as never;
    state.scrubMetadataInBatch.value = true;

    await runBatch();

    expect(readMetadata).toHaveBeenCalledTimes(2);
    // Only the file whose own findings reported an author was scrubbed.
    expect(scrubMetadata).toHaveBeenCalledTimes(1);
    expect(scrubMetadata.mock.calls[0][0][0]).toBe(1);

    const scrubbedNote = state.batchProgress.value.notes.find(
      n => n.file === 'has-author.pdf' && n.kind === 'metadata-scrubbed'
    );
    expect(scrubbedNote).toBeDefined();
    expect(
      state.batchProgress.value.notes.some(
        n => n.file === 'clean.pdf' && n.kind === 'metadata-scrubbed'
      )
    ).toBe(false);

    // The scrubbed file's written bytes reflect the scrub call's output;
    // the clean file's bytes are untouched.
    expect(written.find(w => w.name === 'has-author.pdf')!.bytes).toEqual(
      new Uint8Array([1, 2, 3, ...PDF_MAGIC, 0xff])
    );
    expect(written.find(w => w.name === 'clean.pdf')!.bytes).toEqual(
      new Uint8Array([0, 2, 3, ...PDF_MAGIC])
    );
  });
});

/**
 * The batch runner writes its own output rather than going through
 * `commit.ts`'s `save()`, so the rule that an import-restricted document may
 * not leave unrestricted has to hold here on its own.
 */
describe('permission restrictions survive a batch run', () => {
  it('re-applies the input\u2019s own /P to a file a tool rewrote', async () => {
    const { inDir, outDir, written } = dirs([
      fileHandle('locked.pdf', { marker: 1, restricted: true })
    ]);
    state.inputDirHandle.value = inDir as never;
    state.outputDirHandle.value = outDir as never;
    // Any tool that actually rewrites the bytes will do; the metadata scrub is
    // the one already wired up in this file.
    state.scrubMetadataInBatch.value = true;

    await runBatch();

    expect(restrictDocument).toHaveBeenCalledTimes(1);
    expect(restrictDocument.mock.calls[0][1]).toBe(-3904);
    // The scrubbed bytes, then the restriction pass over them \u2014 in that
    // order, so the flags are applied to what is actually written.
    expect(written[0].bytes).toEqual(new Uint8Array([1, 9, 3, ...PDF_MAGIC, 0xff, 0xee]));
  });

  it('leaves an unrestricted file alone', async () => {
    const { inDir, outDir } = dirs([fileHandle('plain.pdf', { marker: 1 })]);
    state.inputDirHandle.value = inDir as never;
    state.outputDirHandle.value = outDir as never;
    state.scrubMetadataInBatch.value = true;

    await runBatch();

    expect(restrictDocument).not.toHaveBeenCalled();
  });

  it('does not re-encrypt a file no tool touched', async () => {
    // Nothing rewrote it, so the bytes written *are* the input bytes \u2014
    // `/Encrypt` dictionary included. Re-encrypting would be a second parse
    // and a second AES pass for no change at all.
    const { inDir, outDir, written } = dirs([fileHandle('locked.pdf', { restricted: true })]);
    state.inputDirHandle.value = inDir as never;
    state.outputDirHandle.value = outDir as never;
    state.scrubMetadataInBatch.value = false;

    await runBatch();

    expect(restrictDocument).not.toHaveBeenCalled();
    expect(written[0].bytes).toEqual(new Uint8Array([0, 9, 3, ...PDF_MAGIC]));
  });
});

/**
 * CLAUDE.md: "Never emit output larger than the input on a 'compress'
 * operation \u2014 fall back and say so." `compressDocument`'s own `keptOriginal`
 * check only sees the bytes it was handed; it cannot see that restriction
 * reapplication (a fresh `/Encrypt` dictionary, hex-string ciphertext, and
 * `useObjectStreams: false`) is about to add bytes back afterwards. Batch
 * writes its own output rather than going through `commit.ts`'s `save()`
 * (whose own `growthGuard` only covers that path), so this guarantee has to
 * hold here on its own too.
 */
describe("compress's never-grow guarantee survives restriction reapplication", () => {
  it('discards a compressed result once reapplying restrictions regrows it past the original', async () => {
    const { inDir, outDir, written } = dirs([
      // bytes: [1, 9, 3, ...PDF_MAGIC] \u2014 marker 1, restricted (byte[1] === 9).
      fileHandle('locked.pdf', { marker: 1, restricted: true })
    ]);
    state.inputDirHandle.value = inDir as never;
    state.outputDirHandle.value = outDir as never;

    planCompression.mockResolvedValueOnce({ alreadyOptimized: false });
    // A "compression" that does not actually shrink anything (a real codec can
    // legitimately land here on already-incompressible content) \u2014 on its own
    // this looks harmless (same size, not larger), but restrictDocument's
    // mock adds one byte back, which would land the final file one byte
    // *larger* than the original.
    compressDocument.mockImplementationOnce(async (bytes: Uint8Array) => ({
      bytes: new Uint8Array(bytes),
      keptOriginal: false
    }));

    await runBatch();

    // Reverted to the untouched original \u2014 already correctly restricted, so
    // no second restriction pass was needed once compression was discarded.
    expect(written[0].bytes).toEqual(new Uint8Array([1, 9, 3, ...PDF_MAGIC]));
    expect(
      state.batchProgress.value.notes.some(
        n => n.file === 'locked.pdf' && n.kind === 'kept-original'
      )
    ).toBe(true);
  });

  it('keeps a compressed result that is still smaller once restrictions are reapplied', async () => {
    const { inDir, outDir, written } = dirs([
      fileHandle('locked.pdf', { marker: 1, restricted: true })
    ]);
    state.inputDirHandle.value = inDir as never;
    state.outputDirHandle.value = outDir as never;

    planCompression.mockResolvedValueOnce({ alreadyOptimized: false });
    // Shrinks by two bytes \u2014 still smaller than the original even after
    // restrictDocument's mock adds one byte back.
    compressDocument.mockImplementationOnce(async (bytes: Uint8Array) => ({
      bytes: bytes.slice(0, bytes.length - 2),
      keptOriginal: false
    }));

    await runBatch();

    expect(written[0].bytes).toEqual(new Uint8Array([1, 9, 3, 0x25, 0x50, 0xee]));
    expect(
      state.batchProgress.value.notes.some(
        n => n.file === 'locked.pdf' && n.kind === 'kept-original'
      )
    ).toBe(false);
  });

  /**
   * §4 — for a non-default recipe order where 'compress' does not run last,
   * discarding a compressed result used to fall all the way back to the
   * pre-compress, pre-*every-later-tool* bytes — silently discarding whatever
   * ran after compress too, not just the compression. It also has to reapply
   * restrictions to that rebuilt result: a downstream tool's `compose` rebuilds
   * the document from scratch and does not carry the source's real `/Encrypt`
   * forward the way leaving the untouched original bytes alone does.
   */
  it('discarding compression does not also discard a tool that ran after it, and still restricts the result', async () => {
    const { inDir, outDir, written } = dirs([
      fileHandle('locked.pdf', { marker: 1, restricted: true })
    ]);
    state.inputDirHandle.value = inDir as never;
    state.outputDirHandle.value = outDir as never;
    // A recipe replays its own settings snapshot, never the live signals (see
    // BAT-01 above) — so, unlike the other tests in this file, both tools'
    // settings have to be embedded in the recipe itself, or neither runs.
    state.savedRecipes.value = [
      {
        id: 'r1',
        name: 'Compress then watermark',
        tools: ['compress', 'watermark'],
        settings: {
          compress: { ...compressSettings.value } as never,
          watermark: { ...watermarkSettings.value, kind: 'text', text: 'CONFIDENTIAL' } as never
        }
      }
    ];
    state.activeRecipeId.value = 'r1';

    planCompression.mockResolvedValueOnce({ alreadyOptimized: false });
    // Grows by one byte — enough that, once the watermark and the restriction
    // pass are added on top, the compressed path ends up larger than skipping
    // compression would have.
    compressDocument.mockImplementationOnce(async (bytes: Uint8Array) => ({
      bytes: new Uint8Array([...bytes, 0xcc]),
      keptOriginal: false
    }));

    await runBatch();

    // The watermark marker (0x77) survives the rollback, and the restriction
    // marker (0xee) is still there — reapplied to the rebuilt result, not
    // skipped because the bytes were no longer the untouched original once the
    // watermark ran on top of them. Only compression's own marker (0xcc) is
    // gone.
    expect(written[0].bytes).toEqual(new Uint8Array([1, 9, 3, 0x25, 0x50, 0x44, 0x46, 0x77, 0xee]));
    const note = state.batchProgress.value.notes.find(
      n => n.file === 'locked.pdf' && n.kind === 'kept-original'
    );
    expect(note).toBeDefined();
    expect(note?.detail).toMatch(/later steps were reapplied/);
  });
});
