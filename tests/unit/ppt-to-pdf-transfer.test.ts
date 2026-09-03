/**
 * CNV-13 — the bytes really are *transferred* across both worker hops.
 *
 * The fourth of these files, and it exists because CNV-08's audit found the
 * equivalent claim **false as first written**: Comlink reads its transfer list
 * off each *top-level argument* only (`toWireValue` looks the value up in
 * `transferCache` and never recurses into a plain object's properties), so a
 * marker on a nested value is silently dropped and every byte is copied.
 *
 * This tool has a hazard the other five do not, which is why it gets its own
 * file rather than a line in theirs. Its image bytes cross **two** boundaries,
 * and on the second one they are nested two levels deep — inside a `canvas`
 * block, inside its `items` array. `operations.ts`'s `imageBuffersOf` walks the
 * model to build the transfer list, and it was written for CNV-09, where an
 * image is a top-level block. A canvas's pictures are invisible to that walk
 * unless it is taught about them, and nothing about the resulting silent copy
 * of a deck's worth of photographs would show up in any other test.
 *
 * The proof used here is the only unambiguous one: a transferred `ArrayBuffer`
 * is **detached** in the sending realm, so its `byteLength` becomes 0, while a
 * cloned one is untouched. Nothing about Comlink is mocked — real
 * `MessageChannel`s carry real `Comlink.wrap`/`Comlink.expose` pairs, so what is
 * measured is `postMessage`'s own behaviour and not a stub's opinion of it.
 *
 * Each hop needs the *other* side to be local, so the buffer under observation
 * is one this realm holds a reference to. `WIRED` selects which.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Comlink from 'comlink';
import type { LayoutBlock } from '../../src/core/convert/html-to-pdf-blocks';
import type { PptxBlocksResult } from '../../src/core/workers/convert.worker';
import type { JobHandle } from '../../src/core/workers/protocol';
import type { PdfLayoutOptions, PdfLayoutResult } from '../../src/core/convert/pdf-block-layout';

/** Which hop is carried by a real `MessageChannel` in the current test. */
let WIRED: 'read' | 'layout' = 'read';

/** What the far side of the read channel received for the deck. */
const deckSeen: { byteLength: number; sample: number[]; label: string }[] = [];
/** What the far side of the layout channel received for the model. */
const layoutSeen: {
  images: number;
  distinctBuffers: number;
  byteLength: number;
  sample: number[];
}[] = [];

/** The picture the local read stub hands back, held here so it can be watched. */
let localPicture = new Uint8Array(0);

/** A stub result whose canvas holds one image, nested two levels down. */
function blocksResult(data: Uint8Array): PptxBlocksResult {
  const blocks: LayoutBlock[] = [
    {
      kind: 'canvas',
      width: 720,
      height: 540,
      label: 'Slide 1',
      text: 'Quarterly review',
      items: [
        {
          kind: 'text',
          x: 40,
          y: 30,
          width: 400,
          height: 40,
          fontSize: 32,
          align: 'left',
          runs: [{ text: 'Quarterly review', bold: true, italic: false }]
        },
        {
          kind: 'image',
          x: 40,
          y: 100,
          width: 300,
          height: 200,
          data,
          format: 'png',
          id: 'ppt/media/image1.png',
          altText: 'Picture from slide 1'
        }
      ]
    }
  ];
  return {
    blocks,
    notes: [],
    slides: [{ number: 1, textBoxes: 1, images: 1, tables: 0, empty: false }],
    slideWidth: 720,
    slideHeight: 540
  };
}

const readChannel = new MessageChannel();
const layoutChannel = new MessageChannel();

/** The far side of the read hop: it only reports what crossed the boundary. */
Comlink.expose(
  {
    async pptxToBlocks(bytes: Uint8Array, job?: JobHandle): Promise<PptxBlocksResult> {
      deckSeen.push({
        byteLength: bytes.byteLength,
        sample: [...bytes.subarray(0, 4)],
        // The job handle has to have survived as a working proxy too, or
        // progress and cancellation are decorative. Calling it proves it.
        label: (await job?.cancelled()) === false ? 'job proxy live' : 'job proxy dead'
      });
      return blocksResult(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));
    }
  },
  readChannel.port2 as unknown as Comlink.Endpoint
);

/** The far side of the layout hop. */
Comlink.expose(
  {
    async layoutBlocksToPdf(
      blocks: LayoutBlock[],
      options: PdfLayoutOptions
    ): Promise<PdfLayoutResult> {
      const images = blocks.flatMap(block =>
        block.kind === 'canvas' ? block.items.filter(item => item.kind === 'image') : []
      );
      layoutSeen.push({
        images: images.length,
        // Structured clone preserves the object graph, so two canvases that
        // shared one `Uint8Array` still share one `ArrayBuffer` here.
        distinctBuffers: new Set(
          images.map(item => (item.kind === 'image' ? item.data.buffer : null))
        ).size,
        byteLength: images[0]?.kind === 'image' ? images[0].data.byteLength : -1,
        sample: images[0]?.kind === 'image' ? [...images[0].data.subarray(0, 4)] : []
      });
      expect(options.pageBox).toEqual({ width: 720, height: 540 });
      return {
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
        pageCount: blocks.length,
        imageCount: images.length,
        outline: [],
        notes: [],
        hadUnsupportedCharacters: false
      };
    }
  },
  layoutChannel.port2 as unknown as Comlink.Endpoint
);

const wiredRead = Comlink.wrap<{
  pptxToBlocks(bytes: Uint8Array, job?: JobHandle): Promise<PptxBlocksResult>;
}>(readChannel.port1 as unknown as Comlink.Endpoint);
const wiredLayout = Comlink.wrap<{
  layoutBlocksToPdf(blocks: LayoutBlock[], options: PdfLayoutOptions): Promise<PdfLayoutResult>;
}>(layoutChannel.port1 as unknown as Comlink.Endpoint);

vi.mock('../../src/core/workers', async () => {
  const leaseOn =
    <T>(target: T) =>
    (fn: (api: T) => Promise<unknown>) =>
      fn(target);
  return {
    renderWorker: {
      lease: leaseOn({}),
      pin: () => ({ lease: leaseOn({}), release: () => {} })
    },
    // Both leases dispatch at call time, so one mock serves both configurations.
    processWorker: {
      lease: (fn: (api: unknown) => Promise<unknown>) =>
        fn(WIRED === 'layout' ? wiredLayout : localLayout)
    },
    cvWorker: { lease: leaseOn({}) },
    ocrWorker: { lease: leaseOn({}) },
    convertWorker: {
      lease: (fn: (api: unknown) => Promise<unknown>) =>
        fn(WIRED === 'read' ? wiredRead : localRead)
    }
  };
});

/** The local stands-in, used for whichever hop is not under test. */
const localRead = {
  async pptxToBlocks(): Promise<PptxBlocksResult> {
    return blocksResult(localPicture);
  }
};
const localLayout = {
  async layoutBlocksToPdf(blocks: LayoutBlock[]): Promise<PdfLayoutResult> {
    return {
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
      pageCount: blocks.length,
      imageCount: 0,
      outline: [],
      notes: [],
      hadUnsupportedCharacters: false
    };
  }
};

const { convertPptxToPdf } = await import('../../src/core/operations');

/** A `PK\x03\x04` header and a kilobyte of body — nothing parses it here. */
function deckBytes(size = 1024): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x50, 0x4b, 0x03, 0x04]);
  return bytes;
}

afterAll(() => {
  readChannel.port1.close();
  readChannel.port2.close();
  layoutChannel.port1.close();
  layoutChannel.port2.close();
});

beforeEach(() => {
  deckSeen.length = 0;
  layoutSeen.length = 0;
});

describe('CNV-13 — the deck’s bytes are transferred into the convert worker', () => {
  it('detaches the deck buffer, which only a real transfer does', async () => {
    WIRED = 'read';
    const bytes = deckBytes();
    const buffer = bytes.buffer;
    expect(buffer.byteLength).toBe(1024);

    const result = await convertPptxToPdf(bytes, { pageSize: 'slide' });

    // The sending realm's buffer is gone: `postMessage` moved it. A structured
    // clone — which is what a marker nested inside an options object produces,
    // per CNV-08's audit finding 1 — would leave this at 1024.
    expect(buffer.byteLength).toBe(0);
    expect(bytes.byteLength).toBe(0);

    // …and it arrived intact on the other side, so this is a transfer and not a
    // buffer that was simply thrown away.
    expect(deckSeen).toHaveLength(1);
    expect(deckSeen[0].byteLength).toBe(1024);
    expect(deckSeen[0].sample).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(deckSeen[0].label).toBe('job proxy live');

    expect([...result.bytes]).toEqual([0x25, 0x50, 0x44, 0x46, 0x2d]);
    expect(result.slideCount).toBe(1);
  }, 20_000);
});

describe('CNV-13 — a canvas’s pictures are transferred on to the layout worker', () => {
  it('detaches an image buffer nested inside a canvas block', async () => {
    WIRED = 'layout';
    localPicture = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 5, 6, 7, 8]);
    const pictureBuffer = localPicture.buffer;
    expect(pictureBuffer.byteLength).toBe(8);

    await convertPptxToPdf(deckBytes(), { pageSize: 'slide' });

    // This is the assertion the whole file exists for: `imageBuffersOf` has to
    // descend into `canvas.items`. Written for CNV-09's top-level image blocks
    // only, it returns an empty list here and this stays at 8 — a silent
    // structured clone of every picture in the deck.
    expect(pictureBuffer.byteLength).toBe(0);

    expect(layoutSeen).toHaveLength(1);
    expect(layoutSeen[0].images).toBe(1);
    expect(layoutSeen[0].distinctBuffers).toBe(1);
    expect(layoutSeen[0].byteLength).toBe(8);
    expect(layoutSeen[0].sample).toEqual([0x89, 0x50, 0x4e, 0x47]);
  }, 20_000);

  it('sends one buffer per distinct picture, however many canvases show it', async () => {
    WIRED = 'layout';
    // The real reader hands the *same instance* to every slide that references
    // one media part, and `postMessage` throws on a repeated transferable — so
    // a transfer list that did not deduplicate would make this call reject.
    localPicture = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9, 9, 9]);
    const shared = localPicture;
    const twice = {
      async pptxToBlocks(): Promise<PptxBlocksResult> {
        const first = blocksResult(shared);
        const second = blocksResult(shared);
        return { ...first, blocks: [...first.blocks, ...second.blocks] };
      }
    };
    const previous = localRead.pptxToBlocks;
    localRead.pptxToBlocks = twice.pptxToBlocks;
    try {
      const result = await convertPptxToPdf(deckBytes(), { pageSize: 'slide' });
      expect(result.pageCount).toBe(2);
      expect(shared.byteLength).toBe(0);
      // Two placements, one buffer: the list was deduplicated, so `postMessage`
      // was never handed the same transferable twice.
      expect(layoutSeen[0].images).toBe(2);
      expect(layoutSeen[0].distinctBuffers).toBe(1);
    } finally {
      localRead.pptxToBlocks = previous;
    }
  }, 20_000);
});
