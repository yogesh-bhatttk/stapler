/**
 * CMP-02 — what the raster compression route does to a page it replaces.
 *
 * Two regressions live here, both measured against the real output bytes rather
 * than against intent:
 *
 *  1. **Double rotation.** `pageToImageBytes` renders through a pdf.js viewport
 *     whose rotation defaults to the page's `/Rotate`, so the JPEG handed to
 *     `rebuildCompressed` is already the right way up and already landscape for
 *     a `/Rotate 90` page. The rebuild drew it square into the unrotated media
 *     box and re-declared `/Rotate`, rotating it a second time and squashing it
 *     to the wrong aspect ratio — every landscape phone scan, which is the most
 *     common input this route will ever see.
 *  2. **Annotations dropped.** The replacement page was built from scratch and
 *     nothing carried `/Annots` across, so links, comments, stamps and form
 *     widgets vanished silently.
 *
 * The rotation assertions work on the placement matrix in the produced content
 * stream: they map the image's own unit square through it and check where the
 * four corners land in user space. That is the transform a viewer actually
 * applies, so it catches a wrong scale, a wrong anchor and a mirrored axis
 * alike — none of which a "the page is still 612×792" assertion would.
 */
import { describe, expect, it, vi } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef, PDFString } from 'pdf-lib';

vi.mock('comlink', () => ({
  expose: vi.fn(),
  transfer: vi.fn(value => value),
  proxy: vi.fn(value => value)
}));

const { processWorkerImpl } = await import('../../src/core/workers/process.worker');
const { silentJob } = await import('../../src/core/workers/protocol');
const { decodeStream } = await import('../../src/core/pdf/interpreter');

/**
 * A baseline JPEG whose SOF0 declares `width` × `height`.
 *
 * pdf-lib's embedder reads the header and nothing else, so this is enough for a
 * real `embedJpg` with real declared dimensions — which is what the aspect-ratio
 * assertions need.
 */
function jpegOfSize(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x10,
    0x4a,
    0x46,
    0x49,
    0x46,
    0x00,
    0x01,
    0x01,
    0x00,
    0x00,
    0x01,
    0x00,
    0x01,
    0x00,
    0x00,
    // SOF0: length 11, 8-bit, height, width, 1 component
    0xff,
    0xc0,
    0x00,
    0x0b,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x01,
    0x01,
    0x11,
    0x00,
    0xff,
    0xd9
  ]);
}

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;

/**
 * A one-page document with a deliberately fat content stream, so the rasterised
 * rebuild is comfortably smaller than the input and CMP-04's never-grow gate
 * does not hand the original bytes back before any of this can be asserted.
 */
async function scannedPage(options: {
  rotate?: number;
  annotations?: (doc: PDFDocument) => PDFRef[];
}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  if (options.rotate !== undefined) {
    page.node.set(PDFName.of('Rotate'), doc.context.obj(options.rotate));
  }
  page.node.set(
    PDFName.of('Contents'),
    doc.context.register(doc.context.stream(`q 1 0 0 1 0 0 cm Q\n% ${'padding '.repeat(20000)}\n`))
  );
  if (options.annotations) {
    const refs = options.annotations(doc);
    page.node.set(PDFName.of('Annots'), doc.context.obj(refs));
  }
  return doc.save({ useObjectStreams: false });
}

/** A `/Link` whose action is a URI, the archetypal "just an annotation" case. */
function linkAnnotation(uri: string, rect: [number, number, number, number]) {
  return (doc: PDFDocument): PDFRef[] => {
    const link = doc.context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: rect,
      Border: [0, 0, 0],
      A: doc.context.obj({ Type: 'Action', S: 'URI', URI: PDFString.of(uri) })
    });
    return [doc.context.register(link)];
  };
}

/** Every `cm` matrix in the page's content stream, in order. */
async function contentMatrices(bytes: Uint8Array): Promise<number[][]> {
  const doc = await PDFDocument.load(bytes);
  const contents = doc.getPage(0).node.Contents();
  if (!contents) return [];
  const streams =
    contents instanceof PDFArray
      ? contents.asArray().map(ref => doc.context.lookup(ref))
      : [contents];

  let text = '';
  for (const stream of streams) {
    const raw: Uint8Array = (stream as any).getContents();
    const filter = String((stream as any).dict?.get(PDFName.of('Filter')));
    text += new TextDecoder('latin1').decode(
      filter === '/FlateDecode' ? await decodeStream(raw) : raw
    );
  }

  const out: number[][] = [];
  for (const match of text.matchAll(
    /(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+cm/g
  )) {
    out.push(match.slice(1, 7).map(Number));
  }
  return out;
}

/** Where the image's own unit square lands in unrotated user space. */
function corners(matrix: number[]): { x: number; y: number }[] {
  const [a, b, c, d, e, f] = matrix;
  return [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1]
  ].map(([u, v]) => ({ x: a * u + c * v + e, y: b * u + d * v + f }));
}

function boxOf(points: { x: number; y: number }[]) {
  const xs = points.map(p => p.x);
  const ys = points.map(p => p.y);
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys)
  };
}

describe('the raster route does not rotate a page twice (§1.2)', () => {
  it('fills the media box exactly for an unrotated page', async () => {
    const bytes = await scannedPage({});
    const result = await processWorkerImpl.rebuildCompressed(
      bytes,
      { 0: jpegOfSize(PAGE_WIDTH * 2, PAGE_HEIGHT * 2) },
      {},
      silentJob
    );
    expect(result.keptOriginal).toBe(false);

    const matrices = await contentMatrices(result.bytes);
    expect(matrices).toHaveLength(1);
    expect(boxOf(corners(matrices[0]))).toEqual({
      x: 0,
      y: 0,
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT
    });
  });

  for (const rotate of [90, 270] as const) {
    it(`places the already-rotated raster upright on a /Rotate ${rotate} page`, async () => {
      // What pdf.js hands back for this page: the *displayed* size, landscape.
      const raster = jpegOfSize(PAGE_HEIGHT * 2, PAGE_WIDTH * 2);
      const bytes = await scannedPage({ rotate });
      const result = await processWorkerImpl.rebuildCompressed(bytes, { 0: raster }, {}, silentJob);
      expect(result.keptOriginal).toBe(false);

      const out = await PDFDocument.load(result.bytes);
      const page = out.getPage(0);
      // The box and /Rotate are untouched: annotation rectangles on this page
      // are stated in unrotated user space, so moving the box would move them.
      expect(page.getSize()).toEqual({ width: PAGE_WIDTH, height: PAGE_HEIGHT });
      expect(page.getRotation().angle).toBe(rotate);

      const matrices = await contentMatrices(result.bytes);
      expect(matrices).toHaveLength(1);
      const placed = corners(matrices[0]);

      // It still covers the whole box…
      expect(boxOf(placed)).toEqual({ x: 0, y: 0, width: PAGE_WIDTH, height: PAGE_HEIGHT });

      // …and it is turned by exactly the quarter turn that /Rotate will undo.
      // The image's bottom edge (its own +x axis) must run along the page's
      // y axis, not its x axis — the bug drew it along x, so the 792-wide
      // raster was squeezed into 612 points.
      const bottomEdge = { x: placed[1].x - placed[0].x, y: placed[1].y - placed[0].y };
      expect(Math.abs(bottomEdge.x)).toBe(0);
      expect(Math.abs(bottomEdge.y)).toBe(PAGE_HEIGHT);

      // Image bottom-left must land where the viewer's bottom-left is: for
      // /Rotate 90 the display maps user (x, y) to (y, W − x), for /Rotate 270
      // to (H − y, x).
      const displayed =
        rotate === 90
          ? { u: placed[0].y, v: PAGE_WIDTH - placed[0].x }
          : { u: PAGE_HEIGHT - placed[0].y, v: placed[0].x };
      expect(displayed).toEqual({ u: 0, v: 0 });
    });
  }

  it('turns a /Rotate 180 page exactly once', async () => {
    const bytes = await scannedPage({ rotate: 180 });
    const result = await processWorkerImpl.rebuildCompressed(
      bytes,
      { 0: jpegOfSize(PAGE_WIDTH * 2, PAGE_HEIGHT * 2) },
      {},
      silentJob
    );
    const matrices = await contentMatrices(result.bytes);
    const placed = corners(matrices[0]);
    expect(boxOf(placed)).toEqual({ x: 0, y: 0, width: PAGE_WIDTH, height: PAGE_HEIGHT });
    // Bottom-left of the image at top-right of the box: a half turn.
    expect(placed[0]).toEqual({ x: PAGE_WIDTH, y: PAGE_HEIGHT });
  });
});

describe('the raster route carries annotations forward (§1.3)', () => {
  it('keeps a link and its URI action on the rasterised page', async () => {
    const bytes = await scannedPage({
      annotations: linkAnnotation('https://example.invalid/case-7', [72, 700, 300, 720])
    });
    const result = await processWorkerImpl.rebuildCompressed(
      bytes,
      { 0: jpegOfSize(PAGE_WIDTH * 2, PAGE_HEIGHT * 2) },
      {},
      silentJob
    );
    expect(result.keptOriginal).toBe(false);

    const out = await PDFDocument.load(result.bytes);
    const page = out.getPage(0);
    const annots = page.node.lookup(PDFName.of('Annots'), PDFArray);
    expect(annots?.size()).toBe(1);

    const annot = out.context.lookup(annots!.get(0), PDFDict)!;
    expect(String(annot.get(PDFName.of('Subtype')))).toBe('/Link');
    // The /Rect survives unchanged: the page box and /Rotate did not move.
    expect(annot.lookup(PDFName.of('Rect'), PDFArray)!.asArray().map(String)).toEqual([
      '72',
      '700',
      '300',
      '720'
    ]);
    const action = annot.lookup(PDFName.of('A'), PDFDict)!;
    expect((action.get(PDFName.of('URI')) as any).decodeText()).toBe(
      'https://example.invalid/case-7'
    );
    // /P has to point at the *new* page, not at the source document's leaf.
    expect(annot.get(PDFName.of('P'))).toBe(page.ref);
  });

  it('carries annotations on a rotated page without disturbing their geometry', async () => {
    const bytes = await scannedPage({
      rotate: 90,
      annotations: linkAnnotation('https://example.invalid/rotated', [10, 20, 110, 60])
    });
    const result = await processWorkerImpl.rebuildCompressed(
      bytes,
      { 0: jpegOfSize(PAGE_HEIGHT * 2, PAGE_WIDTH * 2) },
      {},
      silentJob
    );
    const out = await PDFDocument.load(result.bytes);
    const annots = out.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
    const annot = out.context.lookup(annots!.get(0), PDFDict)!;
    expect(annot.lookup(PDFName.of('Rect'), PDFArray)!.asArray().map(String)).toEqual([
      '10',
      '20',
      '110',
      '60'
    ]);
  });

  it('does not drag the replaced page into the output along with its annotation', async () => {
    // The annotation's `/P` points back at the source page. Copied verbatim it
    // would pull that page's content stream — the very bytes this route
    // replaces — into the output as an orphan, so the "compressed" file would
    // still carry the original page.
    const bytes = await scannedPage({
      annotations: linkAnnotation('https://example.invalid/p-chase', [0, 0, 10, 10])
    });
    const result = await processWorkerImpl.rebuildCompressed(
      bytes,
      { 0: jpegOfSize(PAGE_WIDTH * 2, PAGE_HEIGHT * 2) },
      {},
      silentJob
    );
    expect(result.keptOriginal).toBe(false);
    expect(result.bytes.byteLength).toBeLessThan(bytes.byteLength / 10);
    expect(new TextDecoder('latin1').decode(result.bytes)).not.toContain('padding padding');
  });

  it('leaves a page that had no annotations with none', async () => {
    const bytes = await scannedPage({});
    const result = await processWorkerImpl.rebuildCompressed(
      bytes,
      { 0: jpegOfSize(PAGE_WIDTH * 2, PAGE_HEIGHT * 2) },
      {},
      silentJob
    );
    const out = await PDFDocument.load(result.bytes);
    // pdf-lib's `addPage` seeds an empty `/Annots`; the point is that nothing
    // was invented for a page that had nothing to carry.
    const annots = out.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    expect(annots?.size() ?? 0).toBe(0);
  });
});
