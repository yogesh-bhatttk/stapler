/**
 * CNV-11 — the workbook bytes really are *transferred* into the convert worker,
 * not structured-cloned.
 *
 * The third of these files, and it exists because CNV-08's audit found the
 * equivalent claim **false as first written**: Comlink reads its transfer list
 * off each *top-level argument* only (`toWireValue` looks the value up in
 * `transferCache` and never recurses into a plain object's properties), so a
 * marker on a nested value is silently dropped and every byte is copied. The
 * comment in `operations.ts` above `xlsxToBlocks(handOver(bytes), …)` cites that
 * finding by name — which is precisely why it needs a test rather than a citation.
 * `pdf-to-word-transfer.test.ts` (CNV-08) and `word-to-pdf-transfer.test.ts`
 * (CNV-09) prove their own hops; the second review pass's finding 5 was that this
 * one had the same shape and none.
 *
 * The proof used here is the only unambiguous one: a transferred `ArrayBuffer` is
 * **detached** in the sending realm, so its `byteLength` becomes 0, while a cloned
 * one is untouched. Nothing about Comlink is mocked — a real `MessageChannel`
 * carries a real `Comlink.wrap`/`Comlink.expose` pair, so what is measured is
 * `postMessage`'s own behaviour and not a stub's opinion of it.
 *
 * `comlink` is consequently *not* `vi.mock`ed in this file, which is why the test
 * lives here rather than in `excel-to-pdf.test.ts`: that file has to stub it so
 * the worker modules (each calls `Comlink.expose` at import time) can load in
 * Node. Everything here talks to `operations.ts` through the mocked
 * `core/workers` module, and `operations.ts` imports the worker modules for their
 * *types* only, so none of them is loaded.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Comlink from 'comlink';
import type { LayoutBlock } from '../../src/core/convert/html-to-pdf-blocks';
import type { XlsxBlocksResult } from '../../src/core/workers/convert.worker';
import type { JobHandle } from '../../src/core/workers/protocol';
import type { PdfLayoutOptions, PdfLayoutResult } from '../../src/core/convert/pdf-block-layout';

/** What the far side of the channel actually received for the workbook. */
const received: { byteLength: number; sample: number[]; label: string }[] = [];

/** What the read side is stubbed to hand back. */
const BLOCKS: LayoutBlock[] = [
  { kind: 'heading', level: 2, runs: [{ text: 'Summary', bold: true, italic: false }] },
  {
    kind: 'table',
    rows: [[[{ text: 'North', bold: false, italic: false }]]],
    columnWidths: [64]
  }
];

const { port1, port2 } = new MessageChannel();

/**
 * A stand-in for the convert worker's `xlsxToBlocks`. It only reports what
 * crossed the boundary; the real reader is graded against output bytes in
 * `excel-to-pdf.test.ts`.
 */
const endpoint = {
  async xlsxToBlocks(bytes: Uint8Array, job?: JobHandle): Promise<XlsxBlocksResult> {
    received.push({
      byteLength: bytes.byteLength,
      sample: [...bytes.subarray(0, 4)],
      // The job handle has to have survived as a working proxy too, or progress
      // and cancellation are decorative. Calling it proves the round trip.
      label: (await job?.cancelled()) === false ? 'job proxy live' : 'job proxy dead'
    });
    return {
      blocks: BLOCKS,
      notes: [],
      sheets: [{ name: 'Summary', rows: 1, columns: 1, bands: 1, empty: false, unreadable: false }]
    };
  }
};
Comlink.expose(endpoint, port2 as unknown as Comlink.Endpoint);
const convertApi = Comlink.wrap<typeof endpoint>(port1 as unknown as Comlink.Endpoint);

vi.mock('../../src/core/workers', async () => {
  const leaseOn =
    <T>(target: T) =>
    (fn: (api: T) => Promise<unknown>) =>
      fn(target);
  const renderApi = {};
  // The layout side stays local: the boundary under test is the *first* hop,
  // where the workbook's own bytes cross into the worker that owns SheetJS.
  const processApi = {
    async layoutBlocksToPdf(
      blocks: LayoutBlock[],
      options: PdfLayoutOptions
    ): Promise<PdfLayoutResult> {
      expect(options.pageSize).toBe('a4');
      expect(blocks).toHaveLength(2);
      const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
      return {
        bytes,
        pageCount: 1,
        imageCount: 0,
        outline: [],
        notes: [],
        hadUnsupportedCharacters: false
      };
    }
  };
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

const { convertXlsxToPdf } = await import('../../src/core/operations');

/** A `PK\x03\x04` header and a kilobyte of body — nothing parses it here. */
function workbookBytes(size = 1024): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x50, 0x4b, 0x03, 0x04]);
  return bytes;
}

afterAll(() => {
  port1.close();
  port2.close();
});

beforeEach(() => {
  received.length = 0;
});

describe('CNV-11 — the workbook bytes are transferred into the convert worker', () => {
  it('detaches the workbook buffer, which only a real transfer does', async () => {
    const bytes = workbookBytes();
    const buffer = bytes.buffer;
    expect(buffer.byteLength).toBe(1024);

    const result = await convertXlsxToPdf(bytes, { pageSize: 'a4' });

    // The sending realm's buffer is gone: `postMessage` moved it. A structured
    // clone — which is what a marker nested inside an options object produces,
    // per CNV-08's audit finding 1 — would leave this at 1024.
    expect(buffer.byteLength).toBe(0);
    expect(bytes.byteLength).toBe(0);

    // …and it arrived intact on the other side, so this is a transfer and not a
    // buffer that was simply thrown away.
    expect(received).toHaveLength(1);
    expect(received[0].byteLength).toBe(1024);
    expect(received[0].sample).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(received[0].label).toBe('job proxy live');

    expect([...result.bytes]).toEqual([0x25, 0x50, 0x44, 0x46, 0x2d]);
    expect(result.sheets.map(sheet => sheet.name)).toEqual(['Summary']);
  }, 20_000);

  it('documents the regression: a marker nested in an object is silently dropped', async () => {
    // Comlink's behaviour, not Stapler's — pinned here so the reason
    // `xlsxToBlocks` takes the bytes as argument 0, rather than inside an
    // options bag, cannot be "tidied away" without a test going red.
    const channel = new MessageChannel();
    const seen: number[] = [];
    Comlink.expose(
      {
        top: (bytes: Uint8Array) => seen.push(bytes.byteLength),
        nested: (wrapper: { workbook: Uint8Array }) => seen.push(wrapper.workbook.byteLength)
      },
      channel.port2 as unknown as Comlink.Endpoint
    );
    const api = Comlink.wrap<{
      top(bytes: Uint8Array): Promise<number>;
      nested(wrapper: { workbook: Uint8Array }): Promise<number>;
    }>(channel.port1 as unknown as Comlink.Endpoint);

    const asArgument = workbookBytes(8);
    await api.top(Comlink.transfer(asArgument, [asArgument.buffer]));
    expect(asArgument.byteLength).toBe(0); // transferred

    const asProperty = workbookBytes(8);
    await api.nested({ workbook: Comlink.transfer(asProperty, [asProperty.buffer]) });
    expect(asProperty.byteLength).toBe(8); // cloned — the marker never applied

    expect(seen).toEqual([8, 8]);
    channel.port1.close();
    channel.port2.close();
  }, 20_000);
});
