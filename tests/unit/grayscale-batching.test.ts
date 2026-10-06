/**
 * PDF-5 — greyscale applies in page batches. Run end to end against the real
 * process and render worker implementations (in-process), graded on the
 * output bytes: batched output against a single batch, shared images and
 * forms across batch boundaries written once, and the payload each apply call
 * receives measured, not assumed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PDFDict, PDFDocument, PDFName, PDFRef, PDFStream, StandardFonts, rgb } from 'pdf-lib';
import { canvasLib, decodeToRgba, installCanvasShims } from './helpers/node-canvas-shims';

// Real pdf.js / worker work on generated documents: give each test room on a
// busy machine instead of vitest's 5 s default (as other real-worker suites do).
vi.setConfig({ testTimeout: 60_000 });

vi.mock('comlink', () => ({
  expose: vi.fn(),
  transfer: vi.fn(value => value),
  proxy: vi.fn(value => value),
  releaseProxy: Symbol('releaseProxy')
}));

vi.mock('../../src/core/workers/pdfjs-setup', async () => {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return {
    pdfjsLib,
    openDocument: ({ data, password }: { data: Uint8Array; password?: string }) =>
      pdfjsLib.getDocument({ data, password, disableFontFace: true, verbosity: 0 })
  };
});

vi.mock('../../src/core/workers', async () => {
  const { processWorkerImpl } = await import('../../src/core/workers/process.worker');
  const { renderWorkerImpl } = await import('../../src/core/workers/render.worker');
  const lease =
    <A>(api: A) =>
    <T>(fn: (a: A) => Promise<T>) =>
      fn(api);
  return {
    processWorker: { lease: lease(processWorkerImpl) },
    renderWorker: {
      lease: lease(renderWorkerImpl),
      pin: () => ({ lease: lease(renderWorkerImpl), release: () => {} })
    },
    cvWorker: { lease: vi.fn() },
    convertWorker: { lease: vi.fn() }
  };
});

installCanvasShims();
const { grayscaleDocument, scheduleGrayBatches, GRAY_PAGES_PER_BATCH } =
  await import('../../src/core/operations');
const { renderWorkerImpl } = await import('../../src/core/workers/render.worker');
const { processWorkerImpl } = await import('../../src/core/workers/process.worker');

afterEach(() => {
  vi.restoreAllMocks();
});

function colourJpeg(seed: number, w = 32, h = 32): Uint8Array {
  const canvas = canvasLib.createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = `rgb(${(seed * 37) % 255}, ${(seed * 91) % 255}, 200)`;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = 'rgb(255, 0, 0)';
  ctx.fillRect(2, 2, w / 2, h / 2);
  return new Uint8Array(canvas.toBuffer('image/jpeg', 0.9));
}

/** Largest |R−G|, |G−B| per page, rendered with annotations. */
async function maxChroma(bytes: Uint8Array): Promise<number[]> {
  const { handle, pageCount } = await renderWorkerImpl.loadDocument(bytes.slice());
  const out: number[] = [];
  try {
    for (let i = 0; i < pageCount; i++) {
      const png = await renderWorkerImpl.pageToImageBytes(handle, i, 'png', 50);
      const { data } = await decodeToRgba(png);
      let m = 0;
      for (let p = 0; p < data.length; p += 4) {
        m = Math.max(m, Math.abs(data[p] - data[p + 1]), Math.abs(data[p + 1] - data[p + 2]));
      }
      out.push(m);
    }
  } finally {
    await renderWorkerImpl.closeDocument(handle);
  }
  return out;
}

async function pageTexts(bytes: Uint8Array): Promise<string[]> {
  const { handle, pageCount } = await renderWorkerImpl.loadDocument(bytes.slice());
  try {
    const out: string[] = [];
    for (let i = 0; i < pageCount; i++)
      out.push(await renderWorkerImpl.extractText(handle, i, 'text'));
    return out;
  } finally {
    await renderWorkerImpl.closeDocument(handle);
  }
}

function imageStreams(doc: PDFDocument): { ref: PDFRef; stream: PDFStream }[] {
  const out: { ref: PDFRef; stream: PDFStream }[] = [];
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFStream && String(obj.dict.get(PDFName.of('Subtype'))) === '/Image') {
      out.push({ ref, stream: obj });
    }
  }
  return out;
}

const PAGES = 30;
const RASTER_PAGE = 10;
const ANNOT_RASTER_PAGE = 2;
const SHARED_A_PAGES = [0, 9, 17, 29];
const FORM_PAGES = [3, 12, 25];
const LATE_USER_OF_D = 20;

/**
 * 30 pages (four batches of 8): each with its own colour JPEG and text; image
 * A on pages 0, 9, 17, 29 (four batches); image B on every page; a Form
 * XObject with colour vectors and image C on pages 3, 12, 25; page 10
 * rasterised (inline image); page 2 rasterised too, with a convertible
 * annotation whose appearance draws image D — which the vector page 20, in a
 * later batch, also draws. D must reach the converter by page 2.
 */
async function mixedDocument(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const sharedA = await doc.embedJpg(colourJpeg(100));
  const sharedB = await doc.embedJpg(colourJpeg(101));
  const imageC = await doc.embedJpg(colourJpeg(102));
  const imageD = await doc.embedJpg(colourJpeg(103));
  const form = ctx.register(
    ctx.flateStream('0 1 0 rg 0 0 20 20 re f q 20 0 0 20 20 20 cm /ImC Do Q', {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 50, 50],
      Resources: { XObject: { ImC: imageC.ref } }
    })
  );
  for (let i = 0; i < PAGES; i++) {
    const page = doc.addPage([200, 200]);
    page.drawText(`Batch page ${i + 1}`, { x: 10, y: 180, size: 12, font, color: rgb(0.8, 0, 0) });
    if (i === RASTER_PAGE) {
      // An inline image: the page is rasterised.
      const raw = ctx.register(
        ctx.stream(
          Buffer.from(
            'q 40 0 0 40 0 0 cm BI /W 1 /H 1 /CS /RGB /BPC 8 ID \xff\x00\x00 EI Q',
            'latin1'
          )
        )
      );
      page.node.addContentStream(raw);
      continue;
    }
    page.drawImage(await doc.embedJpg(colourJpeg(i + 1)), { x: 0, y: 0, width: 50, height: 50 });
    page.drawImage(sharedB, { x: 150, y: 0, width: 40, height: 40 });
    if (SHARED_A_PAGES.includes(i))
      page.drawImage(sharedA, { x: 50, y: 50, width: 50, height: 50 });
    if (i === LATE_USER_OF_D) page.drawImage(imageD, { x: 100, y: 100, width: 40, height: 40 });
    if (FORM_PAGES.includes(i)) {
      page.node.Resources()!.lookup(PDFName.of('XObject'), PDFDict).set(PDFName.of('Fm0'), form);
      page.node.addContentStream(ctx.register(ctx.flateStream('q 1 0 0 1 100 0 cm /Fm0 Do Q')));
    }
    if (i === ANNOT_RASTER_PAGE) {
      const inline = ctx.register(
        ctx.stream(
          Buffer.from(
            'q 10 0 0 10 120 120 cm BI /W 1 /H 1 /CS /RGB /BPC 8 ID \x00\xff\x00 EI Q',
            'latin1'
          )
        )
      );
      page.node.addContentStream(inline);
      const ap = ctx.register(
        ctx.flateStream('q 40 0 0 40 0 0 cm /ImD Do Q', {
          Type: 'XObject',
          Subtype: 'Form',
          BBox: [0, 0, 40, 40],
          Resources: { XObject: { ImD: imageD.ref } }
        })
      );
      const annot = ctx.register(
        ctx.obj({ Type: 'Annot', Subtype: 'Square', Rect: [150, 150, 190, 190], AP: { N: ap } })
      );
      page.node.set(PDFName.of('Annots'), ctx.obj([annot]));
    }
  }
  return doc.save({ useObjectStreams: false });
}

describe('PDF-5 — greyscale applied in page batches', () => {
  it('batched output is byte-identical to a single batch, and valid', async () => {
    const input = await mixedDocument();
    const indices = Array.from({ length: PAGES }, (_, i) => i);
    const apply = vi.spyOn(processWorkerImpl, 'grayscaleApplyBatch');
    const batched = await grayscaleDocument(input, indices, PAGES, { mode: 'gray', rasterDpi: 72 });
    expect(apply.mock.calls.length).toBe(Math.ceil(PAGES / GRAY_PAGES_PER_BATCH));
    apply.mockClear();
    const single = await grayscaleDocument(input, indices, PAGES, {
      mode: 'gray',
      rasterDpi: 72,
      pagesPerBatch: PAGES
    });
    expect(apply.mock.calls.length).toBe(1);

    // Same objects, same order, same encodings: the bytes are identical.
    expect(Buffer.from(batched.bytes).equals(Buffer.from(single.bytes))).toBe(true);
    expect(batched.bytes.byteLength).toBeLessThanOrEqual(single.bytes.byteLength);
    expect(batched.pages).toEqual(single.pages);

    // And valid on its own: page count, routes, R=G=B, text kept, nothing left.
    expect(batched.colourLeft).toEqual([]);
    const out = await PDFDocument.load(batched.bytes);
    expect(out.getPageCount()).toBe(PAGES);
    expect(batched.pages[RASTER_PAGE].route).toBe('raster');
    expect(batched.pages[ANNOT_RASTER_PAGE].route).toBe('raster');
    for (const p of batched.pages) {
      if (p.pageIndex !== RASTER_PAGE && p.pageIndex !== ANNOT_RASTER_PAGE) {
        expect(p.route).toBe('vector');
      }
    }
    expect(Math.max(...(await maxChroma(batched.bytes)))).toBeLessThanOrEqual(2);
    const texts = await pageTexts(batched.bytes);
    for (let i = 0; i < PAGES; i++) {
      if (i === RASTER_PAGE || i === ANNOT_RASTER_PAGE) continue; // a raster has no text layer
      expect(texts[i]).toContain(`Batch page ${i + 1}`);
    }
  });

  it('writes images and forms shared across batch boundaries once', async () => {
    const input = await mixedDocument();
    const indices = Array.from({ length: PAGES }, (_, i) => i);
    const decode = vi.spyOn(renderWorkerImpl, 'decodeImagesGray');
    const result = await grayscaleDocument(input, indices, PAGES, { mode: 'gray', rasterDpi: 72 });
    expect(result.colourLeft).toEqual([]);

    const asked = decode.mock.calls.flatMap(([, requests]) =>
      requests.flatMap(r => r.objectNumbers)
    );
    expect(asked.length).toBe(new Set(asked).size); // each image decoded once

    const out = await PDFDocument.load(result.bytes);
    const images = imageStreams(out);
    for (const { stream } of images) {
      expect(String(stream.dict.get(PDFName.of('ColorSpace')))).toBe('/DeviceGray');
    }
    // 28 per-page images + A + B + C + D + 2 page rasters — no duplicates.
    expect(images.length).toBe(PAGES - 2 + 4 + 2);

    const xobjectOn = (page: number, name: RegExp) => {
      const xobjects = out.getPage(page).node.Resources()!.lookup(PDFName.of('XObject'), PDFDict);
      return [...xobjects.entries()]
        .filter(([k]) => name.test(k.toString()))
        .map(([, v]) => (v as PDFRef).toString());
    };
    // Every vector page draws the *same* grey B (one ref common to all of
    // them, across all four batches), and every A page the same grey A too.
    const intersect = (pages: number[]) =>
      pages
        .map(p => new Set(xobjectOn(p, /Image/)))
        .reduce((acc, set) => new Set([...acc].filter(r => set.has(r))));
    const vectorPages = Array.from({ length: PAGES }, (_, i) => i).filter(
      i => i !== RASTER_PAGE && i !== ANNOT_RASTER_PAGE
    );
    expect(intersect(vectorPages).size).toBe(1); // B
    expect(intersect(SHARED_A_PAGES).size).toBe(2); // A and B
    // One form object, used by all three pages, in batches 0, 1 and 3.
    const forms = [...out.context.enumerateIndirectObjects()].filter(
      ([, o]) =>
        o instanceof PDFStream &&
        String(o.dict.get(PDFName.of('Subtype'))) === '/Form' &&
        o.dict.get(PDFName.of('BBox'))?.toString() === '[ 0 0 50 50 ]'
    );
    expect(forms.length).toBe(1);
    for (const p of FORM_PAGES) expect(xobjectOn(p, /Fm0/)).toEqual([forms[0][0].toString()]);

    // D: decoded via page 20 (its first vector user), delivered in batch 0
    // because the rasterised page 2's annotation draws it, and written once.
    const first = decode.mock.calls[0][1];
    expect(first.some(r => r.pageIndex === LATE_USER_OF_D)).toBe(true);
    const annot = out.context.lookup(
      out.getPage(ANNOT_RASTER_PAGE).node.Annots()!.get(0)
    ) as PDFDict;
    const ap = annot.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N'), PDFStream);
    const dOnAnnot = (
      ap.dict
        .lookup(PDFName.of('Resources'), PDFDict)
        .lookup(PDFName.of('XObject'), PDFDict)
        .get(PDFName.of('ImD')) as PDFRef
    ).toString();
    const onPage20 = xobjectOn(LATE_USER_OF_D, /Image/);
    expect(onPage20).toContain(dOnAnnot);
  });

  it('bounds the payload each apply call receives by a batch (300-page scan)', async () => {
    // A 300-page "scan": one full-page colour JPEG per page, all the same size.
    const SCAN_PAGES = 300;
    const doc = await PDFDocument.create();
    for (let i = 0; i < SCAN_PAGES; i++) {
      const page = doc.addPage([200, 260]);
      page.drawImage(await doc.embedJpg(colourJpeg(i, 100, 130)), {
        x: 0,
        y: 0,
        width: 200,
        height: 260
      });
    }
    const input = await doc.save({ useObjectStreams: false });

    const apply = vi.spyOn(processWorkerImpl, 'grayscaleApplyBatch');
    const progress: (number | null)[] = [];
    const result = await grayscaleDocument(
      input,
      Array.from({ length: SCAN_PAGES }, (_, i) => i),
      SCAN_PAGES,
      { mode: 'gray', rasterDpi: 72 },
      { onProgress: f => progress.push(f) }
    );
    expect(result.colourLeft).toEqual([]);
    expect((await PDFDocument.load(result.bytes)).getPageCount()).toBe(SCAN_PAGES);

    // Measured by the worker on what it received, per call.
    const received = await Promise.all(apply.mock.results.map(r => r.value));
    const perCall = received.map(r => r.payloadBytes);
    const total = perCall.reduce((a, b) => a + b, 0);
    const peak = Math.max(...perCall);
    const pagesPerCall = apply.mock.calls.map(([, batch]) => batch.pageIndices.length);
    expect(apply.mock.calls.length).toBe(Math.ceil(SCAN_PAGES / GRAY_PAGES_PER_BATCH));
    expect(Math.max(...pagesPerCall)).toBeLessThanOrEqual(GRAY_PAGES_PER_BATCH);
    // Nothing decoded is left over between batches: each was written and let go.
    for (const r of received) expect(r.heldImages).toBe(0);
    // The peak call holds a batch's share of the payload, not the document's.
    const perPage = total / SCAN_PAGES;
    expect(peak).toBeLessThanOrEqual(perPage * GRAY_PAGES_PER_BATCH * 1.5);
    expect(peak).toBeLessThan(total / 10);
    console.info(
      `PDF-5 bound: ${apply.mock.calls.length} apply calls, peak ${peak} B per call, ` +
        `total ${total} B, ${(total / peak).toFixed(1)}x reduction`
    );

    // Determinate, monotonic progress to the end.
    expect(progress.every(f => f !== null)).toBe(true);
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i]!).toBeGreaterThanOrEqual(progress[i - 1]! - 1e-9);
    }
    expect(progress[progress.length - 1]!).toBeGreaterThan(0.99);
  }, 120_000);

  it('cancels between batches and discards the open session', async () => {
    const input = await mixedDocument();
    const controller = new AbortController();
    const real = processWorkerImpl.grayscaleApplyBatch.bind(processWorkerImpl);
    vi.spyOn(processWorkerImpl, 'grayscaleApplyBatch').mockImplementation(async (...args) => {
      const out = await real(...args);
      controller.abort(); // after the first batch
      return out;
    });
    const discard = vi.spyOn(processWorkerImpl, 'grayscaleDiscard');
    const finish = vi.spyOn(processWorkerImpl, 'grayscaleFinish');
    await expect(
      grayscaleDocument(
        input,
        Array.from({ length: PAGES }, (_, i) => i),
        PAGES,
        { mode: 'gray', rasterDpi: 72 },
        { signal: controller.signal }
      )
    ).rejects.toMatchObject({ kind: 'UserCancelled' });
    expect(processWorkerImpl.grayscaleApplyBatch).toHaveBeenCalledTimes(1);
    expect(finish).not.toHaveBeenCalled();
    expect(discard).toHaveBeenCalledTimes(1);
    // The session is gone: using it again fails.
    const session = discard.mock.calls[0][0];
    await expect(
      processWorkerImpl.grayscaleApplyBatch(session, { pageIndices: [], images: [], rasters: [] })
    ).rejects.toThrow(/unknown greyscale session/);
  });

  it('schedules each image with the batch of the first page that references it', () => {
    const plan = (pageIndex: number, images: number[], raster = false) => ({
      pageIndex,
      rasterReasons: raster ? ['x'] : [],
      images,
      undecodable: [],
      lossy: [],
      flattenAnnotations: false,
      colourConstructs: images.length,
      chromaticConstructs: images.length
    });
    const plans = [
      plan(0, [1, 2]),
      plan(1, [9], true), // rasterised; 9 is first decoded on page 4
      plan(2, [2, 3]),
      plan(3, [7], true), // only raster pages use 7: never decoded
      plan(4, [9, 1, 4]),
      plan(5, [3])
    ];
    const { batches, requests } = scheduleGrayBatches(plans, new Set([1, 3]), 2);
    expect(batches.map(b => b.map(p => p.pageIndex))).toEqual([
      [0, 1],
      [2, 3],
      [4, 5]
    ]);
    expect(requests).toEqual([
      [
        { pageIndex: 0, objectNumbers: [1, 2] },
        { pageIndex: 4, objectNumbers: [9] }
      ],
      [{ pageIndex: 2, objectNumbers: [3] }],
      [{ pageIndex: 4, objectNumbers: [4] }]
    ]);
  });
});
