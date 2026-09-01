/**
 * CNV-08 — the image archive really is *transferred* into the convert worker,
 * not structured-cloned.
 *
 * This is the one claim in the ticket that a reading of the code cannot settle
 * and that an audit found to be false as first written. `operations.ts` called
 *
 *     api.buildDocx(model, { archive: handOver(bytes), entries }, job)
 *
 * and Comlink reads its transfer list off each **top-level argument** only:
 * `toWireValue` looks the value up in `transferCache` and never recurses into a
 * plain object's properties (`node_modules/comlink/dist/esm/comlink.mjs`, the
 * final `return [{ type: 'RAW', value }, transferCache.get(value) || []]`). So
 * the marker on the nested array was dropped and every image byte was copied —
 * the exact cost the comment claimed to avoid.
 *
 * The proof used here is the only unambiguous one: a transferred `ArrayBuffer` is
 * **detached** in the sending realm, so its `byteLength` becomes 0. A cloned one
 * is untouched. Nothing is mocked about Comlink — a real `MessageChannel` carries
 * a real `Comlink.wrap`/`Comlink.expose` pair, so what is being measured is
 * postMessage's own behaviour, not a stub's opinion of it.
 *
 * `comlink` is therefore *not* `vi.mock`ed in this file, which is why the test
 * lives here rather than in `pdf-to-word.test.ts`: that file has to stub it so
 * the worker modules (which call `Comlink.expose` at import time) can load in
 * Node. Everything here talks to `operations.ts` through the mocked
 * `core/workers` module instead, and `operations.ts` imports the worker modules
 * for their *types* only, so none of them is loaded.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import * as Comlink from 'comlink';
import type { DocxBlock } from '../../src/core/convert/blocks';
import type { ConvertJob, DocxBuildResult } from '../../src/core/workers/convert.worker';
import type { ExtractedImageEntry } from '../../src/core/workers/process.worker';

/** One page of blocks, enough to get past the "nothing to write" refusal. */
const BLOCKS: DocxBlock[] = [
  { kind: 'heading', level: 1, runs: [{ text: 'Title', bold: false, italic: false }] },
  { kind: 'paragraph', runs: [{ text: 'Body.', bold: false, italic: false }] }
];

const ENTRIES: ExtractedImageEntry[] = [
  {
    pageIndex: 0,
    position: 1,
    name: 'Im1',
    objectNumber: 7,
    width: 10,
    height: 10,
    fileName: 'page-001-image-01.png',
    byteLength: 64,
    status: 'extracted'
  }
];

/** The archive `processWorker.extractImages` is stubbed to hand back. */
let archive = new Uint8Array(0);

/** What the far side of the channel actually received. */
const received: { byteLength: number; entries: number; sample: number[] }[] = [];

const { port1, port2 } = new MessageChannel();

/**
 * A stand-in for `convertWorkerImpl`, exposed over the channel. It only has to
 * report what crossed; the real writer's behaviour is graded in
 * `pdf-to-word.test.ts`.
 */
const endpoint: ConvertJob = {
  async buildDocx(_model, imageArchive, imageEntries): Promise<DocxBuildResult> {
    received.push({
      byteLength: imageArchive?.byteLength ?? -1,
      entries: imageEntries.length,
      sample: imageArchive ? [...imageArchive.subarray(0, 4)] : []
    });
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    return Comlink.transfer({ bytes, imageCount: 1, skipped: [], outline: [] }, [bytes.buffer]);
  }
};
Comlink.expose(endpoint, port2 as unknown as Comlink.Endpoint);
const convertApi = Comlink.wrap<ConvertJob>(port1 as unknown as Comlink.Endpoint);

vi.mock('../../src/core/workers', async () => {
  const renderApi = {
    loadDocument: async () => ({ handle: 'h', pageCount: 1, isXfa: false }),
    extractPageBlocks: async () => BLOCKS,
    closeDocument: async () => {}
  };
  const processApi = {
    // The identity of this array is the whole point: the app's real
    // `extractImages` result crosses a Comlink boundary and arrives as a fresh
    // buffer, so `convertPdfToDocx` is free to hand it on — and this test can
    // watch what happens to it.
    extractImages: async () => ({ bytes: archive, entries: ENTRIES })
  };
  const leaseOn =
    <T>(target: T) =>
    (fn: (api: T) => Promise<unknown>) =>
      fn(target);
  return {
    renderWorker: {
      lease: leaseOn(renderApi),
      pin: () => ({ lease: leaseOn(renderApi), release: () => {} })
    },
    processWorker: { lease: leaseOn(processApi) },
    cvWorker: { lease: leaseOn({}) },
    ocrWorker: { lease: leaseOn({}) },
    convertWorker: { lease: leaseOn(convertApi) }
  };
});

const { convertPdfToDocx } = await import('../../src/core/operations');

/** A minimal PDF header — enough that `hasXfaMarker` says no. */
const PDF = new TextEncoder().encode('%PDF-1.7\n% not an XFA form\n');

afterAll(() => {
  port1.close();
  port2.close();
});

describe('CNV-08 — the image archive is transferred, not copied', () => {
  it('detaches the archive buffer, which only a real transfer does', async () => {
    archive = new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Uint8Array(1020)]);
    const buffer = archive.buffer;
    expect(buffer.byteLength).toBe(1024);

    const result = await convertPdfToDocx(PDF, { includeImages: true });

    // The sending realm's buffer is gone: `postMessage` moved it. A structured
    // clone — which is what the nested-in-an-object version produced — would
    // leave this at 1024.
    expect(buffer.byteLength).toBe(0);
    expect(archive.byteLength).toBe(0);

    // …and it arrived intact on the other side, so this is a transfer and not a
    // buffer that was simply thrown away.
    expect(received).toHaveLength(1);
    expect(received[0].byteLength).toBe(1024);
    expect(received[0].sample).toEqual([0x50, 0x4b, 0x05, 0x06]);
    // The per-image report rides alongside as a normal (cheap) clone.
    expect(received[0].entries).toBe(1);

    expect([...result.bytes]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  }, 20_000);

  it('passes null rather than an empty archive when images are switched off', async () => {
    received.length = 0;
    archive = new Uint8Array([1, 2, 3]);
    await convertPdfToDocx(PDF, { includeImages: false });
    expect(received[0].byteLength).toBe(-1);
    expect(received[0].entries).toBe(0);
    // Nothing was extracted, so nothing was handed over either.
    expect(archive.byteLength).toBe(3);
  }, 20_000);

  it('documents the regression: a marker nested in an object is silently dropped', async () => {
    // This is Comlink's behaviour, not Stapler's — pinned here so the reason the
    // signature keeps the `Uint8Array` at the top level cannot be "tidied away"
    // back into a wrapper object without a test going red.
    const channel = new MessageChannel();
    const seen: number[] = [];
    Comlink.expose(
      {
        top: (bytes: Uint8Array) => seen.push(bytes.byteLength),
        nested: (wrapper: { archive: Uint8Array }) => seen.push(wrapper.archive.byteLength)
      },
      channel.port2 as unknown as Comlink.Endpoint
    );
    const api = Comlink.wrap<{
      top(bytes: Uint8Array): Promise<number>;
      nested(wrapper: { archive: Uint8Array }): Promise<number>;
    }>(channel.port1 as unknown as Comlink.Endpoint);

    const asArgument = new Uint8Array([1, 2, 3, 4]);
    await api.top(Comlink.transfer(asArgument, [asArgument.buffer]));
    expect(asArgument.byteLength).toBe(0); // transferred

    const asProperty = new Uint8Array([1, 2, 3, 4]);
    await api.nested({ archive: Comlink.transfer(asProperty, [asProperty.buffer]) });
    expect(asProperty.byteLength).toBe(4); // cloned — the marker never applied

    expect(seen).toEqual([4, 4]);
    channel.port1.close();
    channel.port2.close();
  }, 20_000);
});
