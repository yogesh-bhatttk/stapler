/**
 * AUDIT-2026-10-10 — names, folders, Recents and OPFS files.
 *
 *  • L4 — a directory export never overwrites: a taken name (by the
 *    filesystem's own case rule) gets " (n)"; split's ZIP names dedupe
 *    case-insensitively; bookmark-title stems avoid Windows' reserved device
 *    names and stay within a byte budget.
 *  • L5 — opening the same file again replaces its Recents row (by
 *    `isSameEntry`), and Recents is capped.
 *  • L6 — a failed OPFS write removes the file it created, and an import whose
 *    write fails leaves no file behind.
 *  • S7 — Chrome's `*.crswap` swap files are Stapler's (document- or
 *    model-class) for clearing and sweeping — except the swap file of a write
 *    this tab still has open.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* ---------------- Recents fake (`core/db.ts`) ---------------- */
const recents = new Map<string, { id: string; name: string; handle: unknown; openedAt: number }>();
let clock = 0;
vi.mock('../../src/core/db', () => ({
  writeHandle: vi.fn(async (id: string, name: string, handle: unknown) => {
    recents.set(id, { id, name, handle, openedAt: ++clock });
  }),
  readHandle: vi.fn(async (id: string) => recents.get(id)?.handle ?? null),
  listHandles: vi.fn(async () =>
    [...recents.values()]
      .sort((a, b) => a.openedAt - b.openedAt)
      .map(({ id, name, openedAt }) => ({ id, name, openedAt }))
      .reverse()
  ),
  deleteHandle: vi.fn(async (id: string) => void recents.delete(id))
}));

const { sanitizeFileStem } = await import('../../src/core/operations');
const { uniqueName } = await import('../../src/core/workers/process.worker');
const fileSystem = await import('../../src/platform/file-system');
const opfs = await import('../../src/core/opfs');

function notFound(): DOMException {
  return new DOMException('missing', 'NotFoundError');
}

/* ---------------- L4 ---------------- */

describe('L4 — sanitizeFileStem', () => {
  it('suffixes Windows reserved device names, with or without an extension', () => {
    for (const name of ['CON', 'prn', 'Aux', 'NUL', 'COM1', 'lpt9', 'con.backup']) {
      expect(sanitizeFileStem(name, 'x')).toBe(`${name}_`);
    }
    expect(sanitizeFileStem('Console', 'x')).toBe('Console');
    expect(sanitizeFileStem('COM10', 'x')).toBe('COM10');
  });

  it('removes trailing dots and spaces left by the length cut', () => {
    const title = `${'a'.repeat(79)}.tail`;
    expect(sanitizeFileStem(title, 'x')).toBe('a'.repeat(79));
    expect(sanitizeFileStem('Summary. . .', 'x')).toBe('Summary');
  });

  it('caps UTF-8 bytes and never splits a surrogate pair', () => {
    const cjk = sanitizeFileStem('漢'.repeat(200), 'x');
    expect(new TextEncoder().encode(cjk).byteLength).toBeLessThanOrEqual(180);
    expect(cjk).toBe('漢'.repeat(60));
    const emoji = sanitizeFileStem('😀'.repeat(100), 'x');
    expect(emoji).toBe('😀'.repeat(45)); // 4 bytes each
    expect(emoji.length % 2).toBe(0);
  });
});

describe('L4 — uniqueName (split ZIP names) is case-insensitive', () => {
  it('"Summary" and "SUMMARY" do not share a file name', () => {
    const used = new Set<string>();
    expect(uniqueName(used, 'Summary', 'part')).toBe('Summary.pdf');
    expect(uniqueName(used, 'SUMMARY', 'part')).toBe('SUMMARY-2.pdf');
    expect(uniqueName(used, 'summary', 'part')).toBe('summary-3.pdf');
  });
});

/** A folder on a case-insensitive filesystem (Windows, macOS). */
function caseInsensitiveDir(initial: Record<string, Uint8Array>) {
  const files = new Map(Object.entries(initial).map(([k, v]) => [k.toLowerCase(), { name: k, v }]));
  return {
    files,
    name: 'out',
    getFileHandle: async (name: string, options?: { create?: boolean }) => {
      const key = name.toLowerCase();
      if (!files.has(key)) {
        if (!options?.create) throw notFound();
        files.set(key, { name, v: new Uint8Array() });
      }
      return {
        createWritable: async () => ({
          write: async (bytes: Uint8Array) => {
            files.get(key)!.v = bytes;
          },
          close: async () => {}
        })
      } as never;
    }
  };
}

describe('L4 — directory output never overwrites', () => {
  it('uniquifies against existing files (case-insensitively) and against its own writes', async () => {
    const original = new Uint8Array([1]);
    const dir = caseInsensitiveDir({
      'summary.pdf': original,
      'Report (1).pdf': new Uint8Array([2])
    });
    const out = fileSystem.directoryOutput(dir);
    expect(await out.write('Summary.pdf', new Uint8Array([9]))).toBe('Summary (1).pdf');
    expect(await out.write('SUMMARY.pdf', new Uint8Array([8]))).toBe('SUMMARY (2).pdf');
    expect(await out.write('Report.pdf', new Uint8Array([7]))).toBe('Report.pdf');
    expect(await out.write('report.pdf', new Uint8Array([6]))).toBe('report (2).pdf');
    // The pre-existing files are byte-for-byte untouched.
    expect(dir.files.get('summary.pdf')!.v).toBe(original);
    expect(dir.files.get('report (1).pdf')!.v).toEqual(new Uint8Array([2]));
    expect(dir.files.get('summary (1).pdf')!.v).toEqual(new Uint8Array([9]));
  });

  it('numbers before the extension, and after a name with none', () => {
    expect(fileSystem.numberedName('page-01.png', 3)).toBe('page-01 (3).png');
    expect(fileSystem.numberedName('README', 1)).toBe('README (1)');
  });
});

/* ---------------- L5 ---------------- */

function fakeFileHandle(path: string) {
  return {
    kind: 'file' as const,
    name: path.split('/').pop()!,
    path,
    getFile: async () => new File([], path),
    createWritable: async () => ({ write: async () => {}, close: async () => {} }),
    queryPermission: async () => 'granted' as PermissionState,
    requestPermission: async () => 'granted' as PermissionState,
    isSameEntry: async (other: unknown) => (other as { path?: string }).path === path
  };
}

describe('L5 — Recents dedupe and cap', () => {
  beforeEach(() => {
    recents.clear();
    clock = 0;
  });

  it('opening the same file again replaces its row instead of adding one', async () => {
    const a1 = fileSystem.wrapFileHandle(fakeFileHandle('/docs/a.pdf'));
    await fileSystem.persistFileHandle(a1);
    const b = fileSystem.wrapFileHandle(fakeFileHandle('/docs/b.pdf'));
    await fileSystem.persistFileHandle(b);
    const a2 = fileSystem.wrapFileHandle(fakeFileHandle('/docs/a.pdf'));
    await fileSystem.persistFileHandle(a2);

    const list = await fileSystem.listRecent();
    expect(list.map(e => e.id)).toEqual([a2.id, b.id]);
    expect(list.map(e => e.name)).toEqual(['a.pdf', 'b.pdf']);
  });

  it(`keeps at most ${50} entries, dropping the oldest`, async () => {
    const ids: string[] = [];
    for (let i = 0; i < fileSystem.MAX_RECENT_HANDLES + 5; i++) {
      const file = fileSystem.wrapFileHandle(fakeFileHandle(`/docs/${i}.pdf`));
      ids.push(file.id);
      await fileSystem.persistFileHandle(file);
    }
    const list = await fileSystem.listRecent();
    expect(list).toHaveLength(fileSystem.MAX_RECENT_HANDLES);
    expect(list[0].id).toBe(ids.at(-1));
    expect(list.map(e => e.id)).not.toContain(ids[4]);
    expect(list.map(e => e.id)).toContain(ids[5]);
  });
});

/* ---------------- L6 / S7 — a fake OPFS that behaves like Chrome's ---------------- */

interface FakeOpfsOptions {
  failWrite?: () => DOMException | null;
  /** Resolves when a pending write may proceed. */
  holdWrite?: Promise<void>;
}

function chromeLikeOpfs(options: FakeOpfsOptions = {}) {
  const entries = new Map<string, Uint8Array>();
  const root = {
    async *entries() {
      for (const name of [...entries.keys()]) {
        yield [
          name,
          {
            kind: 'file',
            getFile: async () => ({ size: entries.get(name)?.byteLength ?? 0 })
          } as unknown as FileSystemHandle
        ] as const;
      }
    },
    async removeEntry(name: string) {
      if (!entries.has(name)) throw notFound();
      entries.delete(name);
    },
    async getFileHandle(name: string, opts?: { create?: boolean }) {
      if (!entries.has(name)) {
        if (!opts?.create) throw notFound();
        entries.set(name, new Uint8Array()); // created empty, like the real API
      }
      return {
        createWritable: async () => {
          // Chrome stages the write in a swap file until close().
          entries.set(`${name}.crswap`, new Uint8Array());
          let staged = new Uint8Array();
          return {
            write: async (bytes: Uint8Array) => {
              await options.holdWrite;
              const err = options.failWrite?.();
              if (err) throw err;
              staged = bytes;
            },
            close: async () => {
              entries.set(name, staged);
              entries.delete(`${name}.crswap`);
            },
            abort: async () => {
              entries.delete(`${name}.crswap`);
            }
          };
        }
      };
    }
  };
  return { root, entries };
}

const nav = navigator as unknown as { storage?: unknown };
const originalStorage = nav.storage;

function install(fake: ReturnType<typeof chromeLikeOpfs>) {
  nav.storage = { getDirectory: async () => fake.root };
  opfs.__resetOpfsProbeForTests();
}

afterEach(() => {
  nav.storage = originalStorage;
  opfs.__resetOpfsProbeForTests();
  opfs.__memoryFallback.clear();
});

describe('L6 — a failed OPFS write leaves no empty file behind', () => {
  it('quota on write: the new <id>.pdf is removed, the error is the clear one', async () => {
    const fake = chromeLikeOpfs({
      failWrite: () => new DOMException('Quota exceeded', 'QuotaExceededError')
    });
    install(fake);
    await expect(opfs.writeSourceBytes('s1', new Uint8Array([1, 2]))).rejects.toThrow(
      /local storage is full/i
    );
    expect([...fake.entries.keys()]).toEqual([]);
  });

  it('a failed overwrite of an existing file keeps that file', async () => {
    let fail = false;
    const fake = chromeLikeOpfs({
      failWrite: () => (fail ? new DOMException('Quota exceeded', 'QuotaExceededError') : null)
    });
    install(fake);
    await opfs.writeSourceBytes('s2', new Uint8Array([5, 5]));
    fail = true;
    await expect(opfs.writeSourceBytes('s2', new Uint8Array([6]))).rejects.toThrow();
    expect(fake.entries.get('s2.pdf')).toEqual(new Uint8Array([5, 5]));
  });
});

describe('S7 — *.crswap swap files', () => {
  it('classifies a swap file as its base file’s kind, and nothing else as Stapler’s', () => {
    expect(opfs.classifyStoredFile('abc.pdf.crswap')).toBe('document');
    expect(opfs.classifyStoredFile('eng.traineddata.gz.crswap')).toBe('ocr-model');
    expect(opfs.classifyStoredFile('someone-else.txt.crswap')).toBeNull();
    expect(opfs.classifyStoredFile('x.crswap.crswap')).toBeNull();
  });

  it('Clear-all removes a leftover swap file (a partial document copy)', async () => {
    const fake = chromeLikeOpfs();
    install(fake);
    fake.entries.set('old.pdf', new Uint8Array([1]));
    fake.entries.set('old.pdf.crswap', new Uint8Array([1]));
    fake.entries.set('unrelated.bin.crswap', new Uint8Array([1]));
    const result = await opfs.clearStaplerFiles();
    expect(result).toEqual({ removed: 2, failed: 0 });
    expect([...fake.entries.keys()]).toEqual(['unrelated.bin.crswap']);
  });

  it('the sweep removes an orphan’s swap file and keeps a live source’s', async () => {
    const fake = chromeLikeOpfs();
    install(fake);
    fake.entries.set('dead.pdf.crswap', new Uint8Array([1]));
    fake.entries.set('live.pdf', new Uint8Array([1]));
    fake.entries.set('live.pdf.crswap', new Uint8Array([1]));
    const removed = await opfs.sweepOrphanedSourceBytes(id => id === 'live');
    expect(removed).toBe(1);
    expect([...fake.entries.keys()].sort()).toEqual(['live.pdf', 'live.pdf.crswap']);
  });

  it('never deletes the swap file of a write this tab still has open', async () => {
    let release!: () => void;
    const fake = chromeLikeOpfs({ holdWrite: new Promise<void>(r => (release = r)) });
    install(fake);
    const writing = opfs.writeSourceBytes('busy', new Uint8Array([4, 2]));
    for (let i = 0; i < 20 && !fake.entries.has('busy.pdf.crswap'); i++) {
      await new Promise(r => setTimeout(r, 1));
    }
    expect(fake.entries.has('busy.pdf.crswap')).toBe(true);
    await opfs.sweepOrphanedSourceBytes(() => true);
    await opfs.clearStaplerFiles(['ocr-model']);
    // A full clear would take `busy.pdf` (a document) but not the open swap.
    await opfs.clearStaplerFiles();
    expect(fake.entries.has('busy.pdf.crswap')).toBe(true);
    release();
    await writing;
    expect(fake.entries.has('busy.pdf.crswap')).toBe(false);
  });
});
