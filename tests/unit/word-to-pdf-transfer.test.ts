/**
 * CNV-09 — the block model's image bytes really are *transferred* into the
 * `process` worker, not structured-cloned. The mirror of
 * `pdf-to-word-transfer.test.ts`, and it exists for the same reason: this is a
 * claim about `postMessage`, and reading the code cannot settle it. CNV-08's
 * audit found the equivalent claim false as first written, because Comlink reads
 * its transfer list off each **top-level argument** only and never recurses into
 * a plain object's properties — so a marker on a nested value is silently
 * dropped and every image byte is copied.
 *
 * `convertDocxToPdf` therefore passes `blocks` as argument 0 of
 * `layoutBlocksToPdf`. The proof used here is the only unambiguous one: a
 * transferred `ArrayBuffer` is **detached** in the sending realm, so its
 * `byteLength` becomes 0, while a cloned one is untouched. Nothing about Comlink
 * is mocked — a real `MessageChannel` carries a real `Comlink.wrap`/`expose`
 * pair, so what is measured is `postMessage`'s own behaviour.
 *
 * `comlink` is consequently *not* `vi.mock`ed in this file, which is why the test
 * lives here rather than in `word-to-pdf.test.ts`: that file has to stub it so
 * the worker modules (each calls `Comlink.expose` at import time) can load in
 * Node. Everything here talks to `operations.ts` through the mocked
 * `core/workers` module, and `operations.ts` imports the worker modules for their
 * *types* only, so none of them is loaded.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Comlink from 'comlink';
import type { LayoutBlock } from '../../src/core/convert/html-to-pdf-blocks';
import type { DocxBlocksResult } from '../../src/core/workers/convert.worker';
import type { PdfLayoutOptions, PdfLayoutResult } from '../../src/core/convert/pdf-block-layout';

/** What `docxToBlocks` is stubbed to hand back on the next conversion. */
let read: DocxBlocksResult = { blocks: [], notes: [], warnings: [] };

/** What the far side of the channel actually received. */
const received: { blocks: number; imageBytes: number; sample: number[] }[] = [];

const { port1, port2 } = new MessageChannel();

/** A stand-in for the `process` worker's `layoutBlocksToPdf`. */
const endpoint = {
  async layoutBlocksToPdf(
    blocks: LayoutBlock[],
    options: PdfLayoutOptions
  ): Promise<PdfLayoutResult> {
    expect(options.pageSize).toBe('a4');
    const image = blocks.find(block => block.kind === 'image');
    received.push({
      blocks: blocks.length,
      imageBytes: image?.kind === 'image' ? image.data.byteLength : -1,
      sample: image?.kind === 'image' ? [...image.data.subarray(0, 4)] : []
    });
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
    return Comlink.transfer(
      {
        bytes,
        pageCount: 1,
        imageCount: image ? 1 : 0,
        outline: [],
        notes: ['An image could not be embedded and was left out (unreadable image data).'],
        hadUnsupportedCharacters: false
      },
      [bytes.buffer]
    );
  }
};
Comlink.expose(endpoint, port2 as unknown as Comlink.Endpoint);
const processApi = Comlink.wrap<typeof endpoint>(port1 as unknown as Comlink.Endpoint);

vi.mock('../../src/core/workers', async () => {
  const leaseOn =
    <T>(target: T) =>
    (fn: (api: T) => Promise<unknown>) =>
      fn(target);
  const renderApi = {};
  return {
    renderWorker: {
      lease: leaseOn(renderApi),
      pin: () => ({ lease: leaseOn(renderApi), release: () => {} })
    },
    // The read side stays local: the boundary under test is the *second* hop,
    // where the block model (and the image bytes inside it) crosses into the
    // worker that owns pdf-lib.
    processWorker: { lease: leaseOn(processApi) },
    cvWorker: { lease: leaseOn({}) },
    ocrWorker: { lease: leaseOn({}) },
    convertWorker: { lease: leaseOn({ docxToBlocks: async () => read }) }
  };
});

const { convertDocxToPdf } = await import('../../src/core/operations');

/** Enough of a `.docx` to reach the (stubbed) reader — nothing parses it here. */
const DOCX = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);

function imageBlock(data: Uint8Array): LayoutBlock {
  return { kind: 'image', data, format: 'png', altText: 'Fixture image' };
}

const TEXT_BLOCK: LayoutBlock = {
  kind: 'paragraph',
  runs: [{ text: 'Body.', bold: false, italic: false }]
};

afterAll(() => {
  port1.close();
  port2.close();
});

beforeEach(() => {
  received.length = 0;
});

describe('CNV-09 — the block model’s image bytes are transferred, not copied', () => {
  it('detaches the image buffer, which only a real transfer does', async () => {
    const image = new Uint8Array(1024);
    image.set([0x89, 0x50, 0x4e, 0x47]);
    const buffer = image.buffer;
    read = { blocks: [TEXT_BLOCK, imageBlock(image)], notes: [], warnings: [] };
    expect(buffer.byteLength).toBe(1024);

    const result = await convertDocxToPdf(DOCX.slice(), { pageSize: 'a4' });

    // The sending realm's buffer is gone: `postMessage` moved it. A structured
    // clone — which is what a marker nested inside an options object produces,
    // per CNV-08's audit finding 1 — would leave this at 1024.
    expect(buffer.byteLength).toBe(0);
    expect(image.byteLength).toBe(0);

    // …and it arrived intact on the other side, so this is a transfer and not a
    // buffer that was simply thrown away.
    expect(received).toHaveLength(1);
    expect(received[0].blocks).toBe(2);
    expect(received[0].imageBytes).toBe(1024);
    expect(received[0].sample).toEqual([0x89, 0x50, 0x4e, 0x47]);

    expect([...result.bytes]).toEqual([0x25, 0x50, 0x44, 0x46, 0x2d]);
  }, 20_000);

  it('survives two blocks that share one buffer, which a repeated transferable would not', async () => {
    // `imageBuffersOf` de-duplicates by `ArrayBuffer` identity. Without that,
    // one image reused on two pages would list the same transferable twice and
    // `postMessage` would throw a `DataCloneError` — the conversion failing on a
    // document that is perfectly ordinary.
    const shared = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    read = {
      blocks: [
        imageBlock(new Uint8Array(shared.buffer, 0, 4)),
        imageBlock(new Uint8Array(shared.buffer, 4, 4))
      ],
      notes: [],
      warnings: []
    };

    await expect(convertDocxToPdf(DOCX.slice(), { pageSize: 'a4' })).resolves.toBeDefined();
    expect(shared.byteLength).toBe(0);
    expect(received[0].blocks).toBe(2);
  }, 20_000);
});

describe('CNV-09 — mammoth’s warnings are not reported as dropped content', () => {
  it('keeps the reader’s warnings out of the “left out of the PDF” list', async () => {
    // A mammoth warning usually means "an unrecognised style fell back to a
    // default", not "this content is missing". Merging the two (which this used
    // to do) made the panel and the save toast claim the conversion had dropped
    // things it had not.
    read = {
      blocks: [TEXT_BLOCK],
      notes: ['An image inside a table cell was left out: cells hold text only.'],
      warnings: ['Unrecognised paragraph style: Quote (Style ID: Quote)']
    };

    const result = await convertDocxToPdf(DOCX.slice(), { pageSize: 'a4' });

    expect(result.warnings).toEqual(['Unrecognised paragraph style: Quote (Style ID: Quote)']);
    expect(result.notes).toEqual([
      'An image inside a table cell was left out: cells hold text only.',
      // The layout stage's own note still belongs in this list — it really is
      // content that is not in the PDF.
      'An image could not be embedded and was left out (unreadable image data).'
    ]);
    expect(result.notes.join(' ')).not.toContain('Unrecognised paragraph style');
  }, 20_000);
});
