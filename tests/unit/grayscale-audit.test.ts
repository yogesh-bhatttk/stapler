/**
 * GAP-6 greyscale — audit 2026-10-01 regressions (PDF-2, PDF-5, PDF-6, PDF-7,
 * PDF-9), run end to end against the real process and render worker
 * implementations and graded on the output bytes and rendered pixels.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef, PDFStream, rgb } from 'pdf-lib';
import { canvasLib, decodeToRgba, installCanvasShims } from './helpers/node-canvas-shims';

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
const { grayscaleDocument } = await import('../../src/core/operations');
const { renderWorkerImpl } = await import('../../src/core/workers/render.worker');
const { processWorkerImpl } = await import('../../src/core/workers/process.worker');

afterEach(() => {
  vi.restoreAllMocks();
});

/** Largest |R−G|, |G−B| over every page, rendered *with* annotations. */
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

function colourJpeg(seed: number, size = 32): Uint8Array {
  const canvas = canvasLib.createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = `rgb(${(seed * 37) % 255}, ${(seed * 91) % 255}, 200)`;
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = 'rgb(255, 0, 0)';
  ctx.fillRect(4, 4, size / 2, size / 2);
  return new Uint8Array(canvas.toBuffer('image/jpeg', 0.9));
}

/** A page whose only colour is an annotation appearance that cannot be converted. */
async function annotationWithInlineImage(hidden = false): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([200, 200]);
  const ctx = doc.context;
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream('0 0 1 rg 10 10 50 50 re f')));
  const ap = ctx.register(
    ctx.stream(
      Buffer.from(
        'q 80 0 0 80 0 0 cm BI /W 2 /H 1 /CS /RGB /BPC 8 ID \xff\x00\x00\x00\xff\x00 EI Q',
        'latin1'
      ),
      { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 80, 80] }
    )
  );
  const annot = ctx.register(
    ctx.obj({
      Type: 'Annot',
      Subtype: 'Square',
      Rect: [100, 100, 180, 180],
      AP: { N: ap },
      ...(hidden ? { F: 2 } : {})
    })
  );
  page.node.set(PDFName.of('Annots'), ctx.obj([annot]));
  return doc.save({ useObjectStreams: false });
}

describe('PDF-2 — annotations on a rasterised page', () => {
  it('renders an unconvertible annotation into the raster, hides the original, leaves R=G=B', async () => {
    const input = await annotationWithInlineImage();
    expect((await maxChroma(input))[0]).toBeGreaterThan(200); // the premise

    const result = await grayscaleDocument(input, [0], 1, { mode: 'gray', rasterDpi: 72 });
    expect(result.pages[0].route).toBe('raster');
    expect(result.pages[0].reasons.join(' ')).toMatch(/flattened into the page image/);
    expect(result.colourLeft).toEqual([]);
    // Rendered the way a viewer shows it — annotations included.
    expect((await maxChroma(result.bytes))[0]).toBeLessThanOrEqual(2);

    // The annotation is still there (nothing referencing it is orphaned) but
    // hidden, and the raster really contains its (grey) drawing.
    const out = await PDFDocument.load(result.bytes);
    const annots = out.getPage(0).node.Annots()!;
    expect(annots.size()).toBe(1);
    const annot = out.context.lookup(annots.get(0)) as PDFDict;
    expect((annot.lookup(PDFName.of('F')) as PDFNumber).asNumber() & 2).toBe(2);
  });

  it('an appearance that also sets a colour is flattened and passes, not blocked as colour left', async () => {
    // `1 0 0 rg` is read and counted, then a mesh gradient with per-point
    // colour gives the reason. Once the annotation is drawn into the raster
    // and hidden, its colour operators draw nothing, so they must not count
    // as colour left and block the save.
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);
    const ctx = doc.context;
    page.node.set(
      PDFName.of('Contents'),
      ctx.register(ctx.flateStream('0 0 1 rg 10 10 50 50 re f'))
    );
    const mesh = ctx.register(
      ctx.stream(new Uint8Array(0), {
        ShadingType: 4,
        ColorSpace: 'DeviceRGB',
        BitsPerCoordinate: 8,
        BitsPerComponent: 8,
        BitsPerFlag: 8,
        Decode: [0, 80, 0, 80, 0, 1, 0, 1, 0, 1]
      })
    );
    const ap = ctx.register(
      ctx.stream('1 0 0 rg 0 0 40 40 re f /Sh0 sh', {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 80, 80],
        Resources: { Shading: { Sh0: mesh } }
      })
    );
    const annot = ctx.register(
      ctx.obj({ Type: 'Annot', Subtype: 'Square', Rect: [100, 100, 180, 180], AP: { N: ap } })
    );
    page.node.set(PDFName.of('Annots'), ctx.obj([annot]));
    const input = await doc.save({ useObjectStreams: false });

    const result = await grayscaleDocument(input, [0], 1, { mode: 'gray', rasterDpi: 72 });
    expect(result.pages[0].route).toBe('raster');
    expect(result.colourLeft).toEqual([]);
  });

  it('a hidden annotation with an unconvertible appearance does not force a raster', async () => {
    const result = await grayscaleDocument(await annotationWithInlineImage(true), [0], 1, {
      mode: 'gray',
      rasterDpi: 72
    });
    expect(result.pages[0].route).toBe('vector');
    expect(result.colourLeft).toEqual([]);
    expect((await maxChroma(result.bytes))[0]).toBeLessThanOrEqual(2);
  });

  it('colour the verification still finds on a converted page is reported, not passed', async () => {
    const real = processWorkerImpl.grayscaleApply.bind(processWorkerImpl);
    vi.spyOn(processWorkerImpl, 'grayscaleApply').mockImplementation(async (...args) => {
      const applied = await real(...args);
      return {
        ...applied,
        verification: applied.verification.map(v => ({
          ...v,
          rasterReasons: ['contains an inline image']
        }))
      };
    });
    const result = await grayscaleDocument(await annotationWithInlineImage(), [0], 1, {
      mode: 'gray',
      rasterDpi: 72
    });
    expect(result.colourLeft).toEqual([0]);
  });
});

describe('PDF-5 — bounded memory', () => {
  it('decodes in page batches, once per shared image, and hands over encoded payloads only', async () => {
    const doc = await PDFDocument.create();
    const shared = await doc.embedJpg(colourJpeg(0));
    const PAGES = 20;
    for (let i = 0; i < PAGES; i++) {
      const page = doc.addPage([100, 100]);
      page.drawImage(await doc.embedJpg(colourJpeg(i + 1)), { x: 0, y: 0, width: 50, height: 50 });
      page.drawImage(shared, { x: 50, y: 50, width: 50, height: 50 });
    }
    // One page that has to be rasterised (an inline image).
    const raster = doc.addPage([100, 100]);
    raster.node.set(
      PDFName.of('Contents'),
      doc.context.register(
        doc.context.stream(
          Buffer.from(
            'q 40 0 0 40 0 0 cm BI /W 1 /H 1 /CS /RGB /BPC 8 ID \xff\x00\x00 EI Q',
            'latin1'
          )
        )
      )
    );
    const input = await doc.save({ useObjectStreams: false });

    const decode = vi.spyOn(renderWorkerImpl, 'decodeImagesGray');
    const apply = vi.spyOn(processWorkerImpl, 'grayscaleApply');
    const indices = Array.from({ length: PAGES + 1 }, (_, i) => i);
    const result = await grayscaleDocument(input, indices, PAGES + 1, {
      mode: 'gray',
      rasterDpi: 72
    });

    expect(decode.mock.calls.length).toBeGreaterThan(1);
    const asked: number[] = [];
    for (const [, requests] of decode.mock.calls) {
      expect(requests.length).toBeLessThanOrEqual(8);
      for (const r of requests) asked.push(...r.objectNumbers);
    }
    // Every image asked for exactly once, the shared one included.
    expect(asked.length).toBe(new Set(asked).size);
    expect(asked.length).toBe(PAGES + 1);

    const handed = apply.mock.calls[0][1];
    expect(handed.images.length).toBe(PAGES + 1);
    for (const item of [...handed.images, ...handed.rasters]) {
      expect(item.gray).toBeUndefined();
      expect(item.encoded?.data.length).toBeGreaterThan(0);
    }
    expect(handed.rasters.length).toBe(1);

    expect(result.colourLeft).toEqual([]);
    expect(result.pages.slice(0, PAGES).every(p => p.route === 'vector')).toBe(true);
    expect(result.pages[PAGES].route).toBe('raster');
    expect(Math.max(...(await maxChroma(result.bytes)))).toBeLessThanOrEqual(2);
    // Encode once: one grey copy of the shared image, used by every page.
    const out = await PDFDocument.load(result.bytes);
    const grayImages = new Set<string>();
    for (const [ref, obj] of out.context.enumerateIndirectObjects()) {
      if (obj instanceof PDFStream && String(obj.dict.get(PDFName.of('Subtype'))) === '/Image') {
        expect(String(obj.dict.get(PDFName.of('ColorSpace')))).toBe('/DeviceGray');
        grayImages.add(ref.toString());
      }
    }
    expect(grayImages.size).toBe(PAGES + 1 + 1); // per-page + shared + the page raster
  });
});

describe('PDF-6 — a resource-less Form XObject shared by pages', () => {
  it('is converted once, not once per page', async () => {
    const doc = await PDFDocument.create();
    const ctx = doc.context;
    const form = ctx.register(
      ctx.flateStream('1 0 0 rg 0 0 50 50 re f', {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 50, 50]
      })
    );
    for (let i = 0; i < 3; i++) {
      const p = doc.addPage([100, 100]);
      p.node.set(PDFName.of('Resources'), ctx.obj({ XObject: { Fm: form } }));
      p.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream('/Fm Do')));
    }
    const input = await doc.save({ useObjectStreams: false });
    const result = await grayscaleDocument(input, [0, 1, 2], 3, { mode: 'gray', rasterDpi: 72 });
    expect(result.pages.map(p => p.route)).toEqual(['vector', 'vector', 'vector']);

    const out = await PDFDocument.load(result.bytes);
    const forms: PDFRef[] = [];
    for (const [ref, obj] of out.context.enumerateIndirectObjects()) {
      if (obj instanceof PDFStream && String(obj.dict.get(PDFName.of('Subtype'))) === '/Form') {
        forms.push(ref);
      }
    }
    expect(forms.length).toBe(1);
    // Every page draws that one converted form.
    for (let i = 0; i < 3; i++) {
      const xobjects = out.getPage(i).node.Resources()!.lookup(PDFName.of('XObject'), PDFDict);
      const used = [...xobjects.entries()].map(([, v]) => (v as PDFRef).toString());
      expect(used).toContain(forms[0].toString());
    }
    expect(Math.max(...(await maxChroma(result.bytes)))).toBeLessThanOrEqual(2);
  });
});

describe('PDF-7 — a tint transform that fails at the colour used', () => {
  it('rasterises the page instead of painting a guessed grey', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([100, 100]);
    const ctx = doc.context;
    // Runs at the probe input (0.5) but underflows below 0.25.
    const tint = ctx.register(
      ctx.stream('{ dup 0.25 lt { pop mul } if 0 0 }', {
        FunctionType: 4,
        Domain: [0, 1],
        Range: [0, 1, 0, 1, 0, 1]
      })
    );
    const sep = ctx.obj([
      PDFName.of('Separation'),
      PDFName.of('Spot'),
      PDFName.of('DeviceRGB'),
      tint
    ]);
    page.node.set(PDFName.of('Resources'), ctx.obj({ ColorSpace: { CS1: sep } }));
    page.node.set(
      PDFName.of('Contents'),
      ctx.register(ctx.flateStream('/CS1 cs 0.1 sc 0 0 100 100 re f'))
    );
    const input = await doc.save({ useObjectStreams: false });
    const result = await grayscaleDocument(input, [0], 1, { mode: 'gray', rasterDpi: 72 });
    expect(result.pages[0].route).toBe('raster');
    expect(result.pages[0].reasons.join(' ')).toMatch(/colour space/);
  });
});

describe('PDF-9 — renderPageGray is cancellable', () => {
  it('stops when the job is cancelled', async () => {
    const doc = await PDFDocument.create();
    doc
      .addPage([100, 100])
      .drawRectangle({ x: 0, y: 0, width: 50, height: 50, color: rgb(1, 0, 0) });
    const { handle } = await renderWorkerImpl.loadDocument(await doc.save());
    try {
      const job = { cancelled: async () => true, progress: async () => {} };
      await expect(
        renderWorkerImpl.renderPageGray(handle, 0, 72, 'gray', false, job)
      ).rejects.toMatchObject({ kind: 'UserCancelled' });
    } finally {
      await renderWorkerImpl.closeDocument(handle);
    }
  });
});
