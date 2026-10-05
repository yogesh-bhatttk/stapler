/**
 * AUDIT-FINDINGS §4.1 (HRD-14) — transferring a source buffer to a worker must
 * never detach the store's copy.
 *
 * Restored from commit 6d0e9fc's parent and adapted to today's code. When it
 * was written, `bytesForPages` returned `sources[id].bytes` itself, so the
 * rule was "never transfer". Since then, source bytes live in OPFS (or, where
 * OPFS is unavailable — as in Node — in `opfs.ts`'s in-memory map), and
 * `compose`/`composeSplit` *do* transfer what `bytesForPages` returns
 * (`transferSourceBytes`, PLT-18). That is safe only because
 * `readSourceBytes` hands out a fresh buffer every time: from OPFS a new
 * `arrayBuffer()`, from memory `bytes.slice()`. That copy is the protection
 * this file guards.
 *
 * The worker is not mocked in the way that matters: a real `MessageChannel`
 * carries a real `Comlink.wrap`/`Comlink.expose` pair around the real
 * `processWorkerImpl`, so a transfer list in `operations.ts` really detaches
 * the sender's buffer, exactly as `postMessage` to a Worker does. Proved below:
 *
 *  1. Two open documents share one source. Composing one of them really
 *     transfers its source bytes (the sender's buffer is detached afterwards),
 *     and yet the stored bytes are intact and the other document still exports.
 *  2. The same holds for `currentDocumentBytes`'s untouched fast path, which
 *     hands its result to `applyRedactions` and `rebuildCompressed`: those run
 *     here through the channel with their input transferred anyway.
 *  3. The test has teeth: transferring the stored array itself (what returning
 *     it uncopied would amount to) empties it and breaks the other document.
 *     Removing `.slice()` from `readSourceBytes` makes test 1 fail
 *     (checked by hand when this file was restored, HRD-14).
 *  4. Structurally, `applyRedactions` and `rebuildCompressed` in
 *     `operations.ts` still do not `handOver` their input: `applyRedactions`
 *     reads it three times, so no read of it can be the last.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import * as Comlink from 'comlink';

/** Top-level arguments of each worker call, as the *sender* holds them after the call. */
const sent = vi.hoisted(() => ({ calls: [] as { method: string; args: unknown[] }[] }));

vi.mock('../../src/core/workers', async () => {
  const Comlink = await import('comlink');
  const { processWorkerImpl } = await import('../../src/core/workers/process.worker');
  const { port1, port2 } = new MessageChannel();
  Comlink.expose(processWorkerImpl, port2 as unknown as Comlink.Endpoint);
  const remote = Comlink.wrap<typeof processWorkerImpl>(port1 as unknown as Comlink.Endpoint);
  const recording = new Proxy(remote, {
    get(target, prop) {
      const method = Reflect.get(target, prop) as (...a: unknown[]) => Promise<unknown>;
      return (...args: unknown[]) => {
        sent.calls.push({ method: String(prop), args });
        return method(...args);
      };
    }
  });
  const unavailable = {
    lease: () => Promise.reject(new Error('not used in this test')),
    terminate() {},
    pin() {
      throw new Error('not used in this test');
    }
  };
  return {
    processWorker: {
      ...unavailable,
      lease: <R>(fn: (api: typeof remote) => Promise<R>) => fn(recording)
    },
    renderWorker: unavailable,
    cvWorker: unavailable,
    convertWorker: unavailable,
    imageWorker: unavailable,
    ocrWorker: unavailable
  };
});

const { __memoryFallback, __resetOpfsProbeForTests, writeSourceBytes, readSourceBytes } =
  await import('../../src/core/opfs');
const store = await import('../../src/core/store');
const { composeDocument, currentDocumentBytes } = await import('../../src/core/operations');
const { resetHistory } = await import('../../src/core/history');
const { createJobHandle } = await import('../../src/core/workers/protocol');
const { processWorkerImpl } = await import('../../src/core/workers/process.worker');

const SHARED = 'shared-source';

async function twoPagePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const label of ['Alpha page', 'Beta page']) {
    const page = doc.addPage([595, 842]);
    page.drawText(label, { x: 50, y: 750, size: 14 });
  }
  return doc.save();
}

function openDoc(id: string, pageCount: number) {
  const doc = {
    id,
    name: `${id}.pdf`,
    pages: store.makePageRefs(SHARED, pageCount),
    annotations: [],
    dirty: false
  };
  expect(store.addDocument(doc)).toBe(true);
  return store.documents.value.find(d => d.id === id)!;
}

function compose(doc: { pages: import('../../src/core/store').PageRef[] }) {
  return composeDocument({ pages: doc.pages, annotations: [] });
}

/** A document is intact if it still composes, through the worker, into the pages it should have. */
async function stillExports(doc: { pages: import('../../src/core/store').PageRef[] }) {
  const parsed = await PDFDocument.load(await compose(doc));
  expect(parsed.getPageCount()).toBe(doc.pages.length);
}

/** What the store itself holds for the shared source (memory mode, as in Node). */
function stored(): Uint8Array {
  const bytes = __memoryFallback.get(SHARED);
  expect(bytes, 'source bytes missing from the store').toBeDefined();
  return bytes!;
}

describe('a source shared by two open documents survives a transfer to the worker', () => {
  let original: Uint8Array;

  beforeEach(async () => {
    sent.calls.length = 0;
    store.documents.value = [];
    store.sources.value = {};
    store.activeDocId.value = null;
    store.selectedPageKeys.value = new Set();
    resetHistory();
    __memoryFallback.clear();
    __resetOpfsProbeForTests();

    original = await twoPagePdf();
    // The store's copy is a separate array from `original`, so a detach of it
    // cannot also hide behind the reference compared against.
    await writeSourceBytes(SHARED, original.slice());
    store.registerSource({
      id: SHARED,
      name: 'shared.pdf',
      pageCount: 2,
      pageSizes: [
        { width: 595, height: 842 },
        { width: 595, height: 842 }
      ]
    });
  });

  it('sets up the configuration the protection exists for', async () => {
    openDoc('doc-1', 2);
    openDoc('doc-2', 2);
    expect(store.sourceDocRefCount(SHARED)).toBe(2);
    // What goes to the worker is never the store's own array.
    const handed = (await store.bytesForPages(store.documents.value[0]!.pages))[SHARED]!;
    expect(handed).not.toBe(stored());
    expect(handed.buffer).not.toBe(stored().buffer);
    expect(handed).toEqual(original);
  });

  it('compose transfers its source bytes, and the store and the other document are intact', async () => {
    const first = openDoc('doc-1', 2);
    const second = openDoc('doc-2', 2);

    await compose(first);

    // The transfer really happened: the sender's record of sources is detached.
    const call = sent.calls.find(c => c.method === 'compose');
    expect(call, 'compose never reached the worker').toBeDefined();
    const record = call!.args[1] as Record<string, Uint8Array>;
    expect(record[SHARED]!.byteLength).toBe(0);

    // …and it was a copy: the store and the other document are untouched.
    expect(stored().byteLength).toBe(original.byteLength);
    expect(stored()).toEqual(original);
    await stillExports(second);
    await stillExports(first);
  });

  it('currentDocumentBytes’s fast path is a copy, so applyRedactions and rebuildCompressed may consume it', async () => {
    const first = openDoc('doc-1', 2);
    const second = openDoc('doc-2', 2);
    store.activeDocId.value = first.id;

    const remote = await import('../../src/core/workers').then(m => m.processWorker);
    const job = () => createJobHandle();

    const forRedaction = await currentDocumentBytes();
    expect(forRedaction).not.toBe(stored());
    const redacted = await remote.lease(api =>
      api.applyRedactions(
        Comlink.transfer(forRedaction, [forRedaction.buffer as ArrayBuffer]),
        [{ pageIndex: 0, x: 0.05, y: 0.05, width: 0.4, height: 0.06, text: 'Alpha page' }],
        undefined,
        job()
      )
    );
    expect(forRedaction.byteLength).toBe(0); // transferred
    expect(redacted.byteLength).toBeGreaterThan(0);

    const forCompress = await currentDocumentBytes();
    const rebuilt = await remote.lease(api =>
      api.rebuildCompressed(
        Comlink.transfer(forCompress, [forCompress.buffer as ArrayBuffer]),
        {},
        {},
        job()
      )
    );
    expect(forCompress.byteLength).toBe(0); // transferred
    expect(rebuilt.bytes.byteLength).toBeGreaterThan(0);

    expect(stored()).toEqual(original);
    await stillExports(second);
  });

  /**
   * The teeth. `structuredClone(buffer, { transfer: [buffer] })` detaches
   * exactly as `postMessage(…, [buffer])` does — the consequence of handing a
   * worker the store's own array instead of a copy.
   */
  it('would corrupt the other document if the store’s own array were transferred', async () => {
    openDoc('doc-1', 2);
    const second = openDoc('doc-2', 2);

    const buffer = stored().buffer as ArrayBuffer;
    structuredClone(buffer, { transfer: [buffer] });

    // The store still holds a Uint8Array that looks present and is empty.
    expect(stored().byteLength).toBe(0);
    // Every later read of it fails.
    await expect(readSourceBytes(SHARED)).rejects.toBeTruthy();
    // And the *other* open document can no longer be exported at all.
    await expect(stillExports(second)).rejects.toBeTruthy();
  });

  it('the worker side never detaches anything it was only cloned', async () => {
    // A direct call, no channel: the worker reading its input must not
    // detach it either (it would, if it transferred its *input* back out).
    const input = original.slice();
    await processWorkerImpl.rebuildCompressed(input, {}, {}, undefined);
    expect(input).toEqual(original);
  });

  /**
   * `handOver` is right for worker output that dies at the call and wrong for
   * bytes that are read again. The difference is invisible at the call site,
   * so it is asserted here rather than left to review.
   */
  it('operations.ts does not hand applyRedactions or rebuildCompressed input over', () => {
    const src = readFileSync('src/core/operations.ts', 'utf8');
    for (const call of ['api.rebuildCompressed(', 'api.applyRedactions(']) {
      const at = src.indexOf(call);
      expect(at, `${call} not found — update this guard`).toBeGreaterThan(-1);
      const body = src.slice(at, src.indexOf(')', at) + 1);
      expect(body).not.toContain('handOver(');
    }
    // `applyRedactions` reads its `bytes` three times (plan, image pixels,
    // rebuild), so no read of it can be the last one.
    const redact = src.slice(src.indexOf('export async function applyRedactions'));
    expect(redact.slice(0, redact.indexOf('\n}\n'))).not.toContain('handOver(bytes)');
    // And the memory-mode read is a copy: the protection everything above relies on.
    const opfs = readFileSync('src/core/opfs.ts', 'utf8');
    const read = opfs.slice(opfs.indexOf('export async function readSourceBytes'));
    expect(read.slice(0, read.indexOf('\n}\n'))).toContain('return bytes.slice();');
  });
});
