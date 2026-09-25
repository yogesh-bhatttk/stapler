/**
 * M2 — one display frame for every placement path (audit 2026-09-25: PDF-8,
 * PDF-9, PDF-10).
 *
 * Every page in this file is the hard case at once: a MediaBox that does not
 * start at the origin (`[100 100 712 892]`), a CropBox inset inside it, and
 * `/Rotate 90` or `/Rotate 270`. On such a page the raw MediaBox from (0, 0) that
 * pdf-lib's `getSize()` reports and the page pdf.js shows the user share almost
 * no coordinates, which is exactly how signatures landed outside the visible
 * page, whiteout covered the wrong corner and raster compression stretched a
 * cropped scan.
 *
 * The reference is **the real pdf.js**, not a transcription and not the helper
 * under test: every assertion takes a coordinate out of the produced bytes,
 * pushes it through `page.getViewport({ scale: 1 })` of the installed pdfjs-dist
 * — the very viewport the UI overlays are drawn against — and compares it with
 * where the user put the mark.
 */
import { describe, expect, it, vi } from 'vitest';
import { inflateSync } from 'node:zlib';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFString,
  degrees
} from 'pdf-lib';

vi.mock('comlink', () => ({
  expose: vi.fn(),
  transfer: vi.fn(value => value),
  proxy: vi.fn(value => value)
}));

const { processWorkerImpl } = await import('../../src/core/workers/process.worker');
const { silentJob } = await import('../../src/core/workers/protocol');
const { pageDisplayFrame, visiblePageBox } = await import('../../src/core/pdf/display-frame');
const { displayPointToPage } = await import('../../src/core/rotation');
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
const { encodePng } = await import('../../src/core/png');

type Pt = { x: number; y: number };
type Box = [number, number, number, number];

const MEDIA: Box = [100, 100, 712, 892];
const CROP: Box = [150, 130, 650, 850]; // 500 × 720, inset inside the MediaBox
const VISIBLE_W = 500;
const VISIBLE_H = 720;

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

async function offsetPage(
  rotation: number,
  options: { media?: Box; crop?: Box | null; pad?: boolean; annots?: Box[] } = {}
): Promise<Uint8Array> {
  const media = options.media ?? MEDIA;
  const crop = options.crop === undefined ? CROP : options.crop;
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  page.node.set(PDFName.of('MediaBox'), doc.context.obj(media));
  if (crop) page.node.set(PDFName.of('CropBox'), doc.context.obj(crop));
  if (rotation) page.setRotation(degrees(rotation));
  if (options.pad) {
    // A fat content stream, so a raster rebuild is smaller than the input and
    // CMP-04's never-grow gate does not hand the original back untested.
    page.node.set(
      PDFName.of('Contents'),
      doc.context.register(doc.context.stream(`q Q\n% ${'padding '.repeat(20000)}\n`))
    );
  }
  if (options.annots) {
    const refs = options.annots.map(rect =>
      doc.context.register(
        doc.context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: rect,
          Border: [0, 0, 0],
          A: doc.context.obj({ Type: 'Action', S: 'URI', URI: PDFString.of('https://x.invalid') })
        })
      )
    );
    page.node.set(PDFName.of('Annots'), doc.context.obj(refs));
  }
  return doc.save({ useObjectStreams: false });
}

/** The real pdf.js viewport of page 1, at scale 1 — the frame the UI draws in. */
async function viewportOf(bytes: Uint8Array) {
  const task = pdfjs.getDocument({ data: bytes.slice(), disableFontFace: true });
  const pdf = await task.promise;
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 1 });
  return {
    width: viewport.width,
    height: viewport.height,
    view: page.view,
    toDisplay: (p: Pt): Pt => {
      const [x, y] = viewport.convertToViewportPoint(p.x, p.y);
      return { x, y };
    },
    toPdf: (p: Pt): Pt => {
      const [x, y] = viewport.convertToPdfPoint(p.x, p.y);
      return { x, y };
    },
    destroy: () => task.destroy()
  };
}

/* ------------------------------------------------------------------ *
 * A small content-stream interpreter: CTM tracking over q/Q/cm, and the
 * geometry of the drawing operators pdf-lib emits.
 * ------------------------------------------------------------------ */

type M = [number, number, number, number, number, number];
const IDENTITY: M = [1, 0, 0, 1, 0, 0];
/** `m` then `ctm`, i.e. `m` applied first — PDF's `cm` pre-multiplies. */
const mul = (m: M, ctm: M): M => [
  m[0] * ctm[0] + m[1] * ctm[2],
  m[0] * ctm[1] + m[1] * ctm[3],
  m[2] * ctm[0] + m[3] * ctm[2],
  m[2] * ctm[1] + m[3] * ctm[3],
  m[4] * ctm[0] + m[5] * ctm[2] + ctm[4],
  m[4] * ctm[1] + m[5] * ctm[3] + ctm[5]
];
const apply = (m: M, x: number, y: number): Pt => ({
  x: m[0] * x + m[2] * y + m[4],
  y: m[1] * x + m[3] * y + m[5]
});

interface Drawn {
  images: M[];
  rects: Pt[][]; // four transformed corners of every `re`
  paths: Pt[][]; // every subpath's points (m, l, c), transformed
  texts: M[]; // text matrix × CTM at every Tm
}

async function pageContent(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  const contents = doc.getPage(0).node.Contents();
  if (!contents) return '';
  const streams =
    contents instanceof PDFArray
      ? contents.asArray().map(ref => doc.context.lookup(ref))
      : [contents];
  let text = '';
  for (const stream of streams) {
    if (!(stream instanceof PDFRawStream)) continue;
    const isFlate = String(stream.dict.get(PDFName.of('Filter'))) === '/FlateDecode';
    const raw = Buffer.from(stream.contents);
    text += `\n${(isFlate ? inflateSync(raw) : raw).toString('latin1')}`;
  }
  return text;
}

function interpret(content: string): Drawn {
  const drawn: Drawn = { images: [], rects: [], paths: [], texts: [] };
  const tokens = content
    .replace(/%[^\n]*/g, ' ')
    .replace(/<[0-9A-Fa-f\s]*>/g, ' <hex> ')
    .replace(/\([^)]*\)/g, ' <str> ')
    .split(/\s+/)
    .filter(Boolean);
  let ctm: M = IDENTITY;
  const stack: M[] = [];
  let operands: string[] = [];
  let path: Pt[] = [];
  const nums = (n: number) => operands.slice(-n).map(Number);
  for (const token of tokens) {
    if (/^[-+]?(\d+\.?\d*|\.\d+)$/.test(token) || token.startsWith('/') || token === '<hex>') {
      operands.push(token);
      continue;
    }
    switch (token) {
      case 'q':
        stack.push(ctm);
        break;
      case 'Q':
        ctm = stack.pop() ?? IDENTITY;
        break;
      case 'cm':
        ctm = mul(nums(6) as M, ctm);
        break;
      case 'Do':
        drawn.images.push(ctm);
        break;
      case 're': {
        const [x, y, w, h] = nums(4);
        drawn.rects.push([
          apply(ctm, x, y),
          apply(ctm, x + w, y),
          apply(ctm, x + w, y + h),
          apply(ctm, x, y + h)
        ]);
        break;
      }
      case 'm':
        // pdf-lib's drawLine repeats its `m`; a lone moveto is not a subpath.
        if (path.length > 1) drawn.paths.push(path);
        path = [apply(ctm, ...(nums(2) as [number, number]))];
        break;
      case 'l':
        path.push(apply(ctm, ...(nums(2) as [number, number])));
        break;
      case 'c': {
        const [x1, y1, x2, y2, x3, y3] = nums(6);
        path.push(apply(ctm, x1, y1), apply(ctm, x2, y2), apply(ctm, x3, y3));
        break;
      }
      case 'S':
      case 'f':
      case 'B':
      case 'b':
      case 's':
      case 'n':
        if (path.length > 1) drawn.paths.push(path);
        path = [];
        break;
      case 'Tm':
        drawn.texts.push(mul(nums(6) as M, ctm));
        break;
    }
    operands = [];
  }
  if (path.length > 1) drawn.paths.push(path);
  return drawn;
}

function bbox(points: Pt[]) {
  const xs = points.map(p => p.x);
  const ys = points.map(p => p.y);
  return {
    left: Math.min(...xs),
    top: Math.min(...ys),
    right: Math.max(...xs),
    bottom: Math.max(...ys)
  };
}

function expectBox(actual: ReturnType<typeof bbox>, expected: ReturnType<typeof bbox>, digits = 2) {
  expect(actual.left).toBeCloseTo(expected.left, digits);
  expect(actual.top).toBeCloseTo(expected.top, digits);
  expect(actual.right).toBeCloseTo(expected.right, digits);
  expect(actual.bottom).toBeCloseTo(expected.bottom, digits);
}

const ROTATIONS = [0, 90, 180, 270] as const;

function composeOne(
  source: Uint8Array,
  opts: {
    cropBox?: PageSourceCrop;
    stamps?: Parameters<typeof processWorkerImpl.compose>[2];
    annotations?: Parameters<typeof processWorkerImpl.compose>[7];
  } = {}
) {
  return processWorkerImpl.compose(
    [
      {
        key: 'p0',
        sourceDocId: 's',
        sourceIndex: 0,
        rotation: 0,
        ...(opts.cropBox ? { cropBox: opts.cropBox } : {})
      }
    ],
    { s: source },
    opts.stamps ?? [],
    undefined,
    undefined,
    null,
    null,
    opts.annotations,
    silentJob
  );
}
type PageSourceCrop = { x: number; y: number; width: number; height: number };

/* ------------------------------------------------------------------ *
 * The helper itself, against pdf.js
 * ------------------------------------------------------------------ */

describe('pageDisplayFrame reproduces the pdf.js viewport exactly', () => {
  const cases: { name: string; media: Box; crop: Box | null }[] = [
    { name: 'offset MediaBox + inset CropBox', media: MEDIA, crop: CROP },
    { name: 'offset MediaBox, no CropBox', media: MEDIA, crop: null },
    // pdf.js intersects: the part of the CropBox outside the MediaBox is not shown.
    { name: 'CropBox overhanging the MediaBox', media: MEDIA, crop: [50, 40, 400, 500] },
    // Corners written in the "wrong" order are normalised by pdf.js.
    { name: 'CropBox with swapped corners', media: MEDIA, crop: [650, 850, 150, 130] },
    // No overlap at all: pdf.js falls back to the MediaBox.
    { name: 'CropBox disjoint from the MediaBox', media: MEDIA, crop: [0, 0, 50, 50] }
  ];
  for (const c of cases) {
    for (const rotation of ROTATIONS) {
      it(`${c.name}, /Rotate ${rotation}`, async () => {
        const bytes = await offsetPage(rotation, { media: c.media, crop: c.crop });
        const vp = await viewportOf(bytes);
        try {
          const page = (await PDFDocument.load(bytes)).getPage(0);
          const frame = pageDisplayFrame(page);
          const box = visiblePageBox(page);
          expect([box.x, box.y, box.x + box.width, box.y + box.height]).toEqual(vp.view);
          expect(frame.displayWidth).toBeCloseTo(vp.width, 6);
          expect(frame.displayHeight).toBeCloseTo(vp.height, 6);
          for (const [fx, fy] of [
            [0, 0],
            [1, 0],
            [0, 1],
            [1, 1],
            [0.23, 0.71]
          ]) {
            const d = { x: fx * vp.width, y: fy * vp.height };
            const ours = displayPointToPage(frame, d.x, d.y);
            const theirs = vp.toPdf(d);
            expect(ours.x).toBeCloseTo(theirs.x, 6);
            expect(ours.y).toBeCloseTo(theirs.y, 6);
          }
        } finally {
          await vp.destroy();
        }
      });
    }
  }
});

/* ------------------------------------------------------------------ *
 * PDF-9 — signatures and the crop tool
 * ------------------------------------------------------------------ */

const PNG = encodePng({
  width: 2,
  height: 2,
  bitDepth: 8,
  colorType: 2,
  samples: new Uint8Array([0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255])
});

describe('PDF-9: a signature lands where it was placed on a rotated, cropped, offset page', () => {
  for (const rotation of ROTATIONS) {
    it(`/Rotate ${rotation}`, async () => {
      const source = await offsetPage(rotation);
      const stamp = { x: 0.05, y: 0.04, width: 0.3, height: 0.1 };
      const out = await composeOne(source, {
        stamps: [{ pageKey: 'p0', type: 'signature', imagePng: PNG, ...stamp }]
      });
      const vp = await viewportOf(out);
      try {
        const drawn = interpret(await pageContent(out));
        expect(drawn.images).toHaveLength(1);
        const m = drawn.images[0];
        const corners = [apply(m, 0, 0), apply(m, 1, 0), apply(m, 1, 1), apply(m, 0, 1)];
        // Inside the visible page, not the MediaBox corner the old code used.
        for (const c of corners) {
          expect(c.x).toBeGreaterThanOrEqual(CROP[0] - 1e-6);
          expect(c.x).toBeLessThanOrEqual(CROP[2] + 1e-6);
          expect(c.y).toBeGreaterThanOrEqual(CROP[1] - 1e-6);
          expect(c.y).toBeLessThanOrEqual(CROP[3] + 1e-6);
        }
        const shown = corners.map(vp.toDisplay);
        expectBox(bbox(shown), {
          left: stamp.x * vp.width,
          top: stamp.y * vp.height,
          right: (stamp.x + stamp.width) * vp.width,
          bottom: (stamp.y + stamp.height) * vp.height
        });
        // Upright: the image's own +x runs left-to-right on screen, its +y up.
        expect(shown[1].x - shown[0].x).toBeGreaterThan(0);
        expect(shown[1].y - shown[0].y).toBeCloseTo(0, 4);
        expect(shown[3].y - shown[0].y).toBeLessThan(0);
      } finally {
        await vp.destroy();
      }
    });
  }
});

describe('PDF-9: the crop tool crops the region the user drew', () => {
  for (const rotation of ROTATIONS) {
    it(`/Rotate ${rotation}`, async () => {
      const source = await offsetPage(rotation);
      const cropBox = { x: 0.1, y: 0.2, width: 0.5, height: 0.4 };
      const out = await composeOne(source, { cropBox });
      const written = (await PDFDocument.load(out)).getPage(0).getCropBox();
      const vp = await viewportOf(source); // the page the user drew on
      try {
        const shown = [
          vp.toDisplay({ x: written.x, y: written.y }),
          vp.toDisplay({ x: written.x + written.width, y: written.y + written.height })
        ];
        expectBox(bbox(shown), {
          left: cropBox.x * vp.width,
          top: cropBox.y * vp.height,
          right: (cropBox.x + cropBox.width) * vp.width,
          bottom: (cropBox.y + cropBox.height) * vp.height
        });
      } finally {
        await vp.destroy();
      }
    });
  }
});

/* ------------------------------------------------------------------ *
 * PDF-10 — annotate drawings
 * ------------------------------------------------------------------ */

describe('PDF-10: annotate drawings honour /Rotate, the CropBox and its origin', () => {
  for (const rotation of ROTATIONS) {
    describe(`/Rotate ${rotation}`, () => {
      const draw = async (annotation: Parameters<typeof processWorkerImpl.compose>[7]) => {
        const source = await offsetPage(rotation);
        const out = await composeOne(source, { annotations: annotation });
        const vp = await viewportOf(out);
        const drawn = interpret(await pageContent(out));
        return { vp, drawn };
      };

      it('whiteout covers the displayed rectangle it was drawn over', async () => {
        const rect = { x: 0.05, y: 0.05, width: 0.3, height: 0.2 };
        const { vp, drawn } = await draw([
          { pageKey: 'p0', type: 'whiteout', color: '#ffffff', strokeWidth: 0, rect }
        ]);
        try {
          // pdf-lib draws rectangles as SVG paths (m / l / h), not `re`.
          expect(drawn.paths).toHaveLength(1);
          expectBox(bbox(drawn.paths[0].map(vp.toDisplay)), {
            left: rect.x * vp.width,
            top: rect.y * vp.height,
            right: (rect.x + rect.width) * vp.width,
            bottom: (rect.y + rect.height) * vp.height
          });
        } finally {
          await vp.destroy();
        }
      });

      it('rectangle outline matches the drawn box', async () => {
        const rect = { x: 0.5, y: 0.6, width: 0.2, height: 0.1 };
        const { vp, drawn } = await draw([
          { pageKey: 'p0', type: 'rectangle', color: '#ff0000', strokeWidth: 0.005, rect }
        ]);
        try {
          // pdf-lib draws rectangles as SVG paths (m / l / h), not `re`.
          expect(drawn.paths).toHaveLength(1);
          expectBox(bbox(drawn.paths[0].map(vp.toDisplay)), {
            left: rect.x * vp.width,
            top: rect.y * vp.height,
            right: (rect.x + rect.width) * vp.width,
            bottom: (rect.y + rect.height) * vp.height
          });
        } finally {
          await vp.destroy();
        }
      });

      it('ellipse is inscribed in the drawn box', async () => {
        const rect = { x: 0.2, y: 0.3, width: 0.4, height: 0.1 };
        const { vp, drawn } = await draw([
          { pageKey: 'p0', type: 'ellipse', color: '#ff0000', strokeWidth: 0.005, rect }
        ]);
        try {
          const points = drawn.paths.flat();
          expect(points.length).toBeGreaterThan(4);
          expectBox(bbox(points.map(vp.toDisplay)), {
            left: rect.x * vp.width,
            top: rect.y * vp.height,
            right: (rect.x + rect.width) * vp.width,
            bottom: (rect.y + rect.height) * vp.height
          });
        } finally {
          await vp.destroy();
        }
      });

      it('freehand and highlight strokes pass through the drawn points', async () => {
        const points = [
          { x: 0.1, y: 0.1 },
          { x: 0.4, y: 0.3 },
          { x: 0.7, y: 0.2 }
        ];
        for (const type of ['freehand', 'highlight'] as const) {
          const { vp, drawn } = await draw([
            { pageKey: 'p0', type, color: '#0000ff', strokeWidth: 0.01, points }
          ]);
          try {
            expect(drawn.paths).toHaveLength(1);
            const shown = drawn.paths[0].map(vp.toDisplay);
            expect(shown).toHaveLength(points.length);
            shown.forEach((p, i) => {
              expect(p.x).toBeCloseTo(points[i].x * vp.width, 2);
              expect(p.y).toBeCloseTo(points[i].y * vp.height, 2);
            });
          } finally {
            await vp.destroy();
          }
        }
      });

      it('arrow runs from start to end with its head at the end', async () => {
        const points = [
          { x: 0.2, y: 0.8 },
          { x: 0.6, y: 0.4 }
        ];
        const { vp, drawn } = await draw([
          { pageKey: 'p0', type: 'arrow', color: '#0000ff', strokeWidth: 0.005, points }
        ]);
        try {
          const segments = drawn.paths.map(path => path.map(vp.toDisplay));
          // The shaft, then the two head strokes, each starting at the tip.
          expect(segments.length).toBe(3);
          const tip = { x: points[1].x * vp.width, y: points[1].y * vp.height };
          expect(segments[0][0].x).toBeCloseTo(points[0].x * vp.width, 2);
          expect(segments[0][0].y).toBeCloseTo(points[0].y * vp.height, 2);
          for (const seg of segments) {
            const end = seg === segments[0] ? seg[1] : seg[0];
            expect(end.x).toBeCloseTo(tip.x, 2);
            expect(end.y).toBeCloseTo(tip.y, 2);
          }
          // The barbs trail back toward the start, on screen.
          for (const seg of segments.slice(1)) {
            expect(
              Math.hypot(seg[1].x - points[0].x * vp.width, seg[1].y - points[0].y * vp.height)
            ).toBeLessThan(
              Math.hypot(tip.x - points[0].x * vp.width, tip.y - points[0].y * vp.height)
            );
          }
        } finally {
          await vp.destroy();
        }
      });

      it('text sits at the drawn spot and reads upright', async () => {
        const rect = { x: 0.2, y: 0.1, width: 0.3, height: 0.05 };
        const { vp, drawn } = await draw([
          {
            pageKey: 'p0',
            type: 'text',
            color: '#000000',
            strokeWidth: 0,
            rect,
            text: 'Hi',
            fontSize: 16
          }
        ]);
        try {
          expect(drawn.texts).toHaveLength(1);
          const m = drawn.texts[0];
          const anchor = vp.toDisplay(apply(m, 0, 0));
          expect(anchor.x).toBeCloseTo(rect.x * vp.width, 2);
          // Baseline one font size below the top of the box, as the canvas draws it.
          expect(anchor.y).toBeCloseTo(rect.y * vp.height + 16, 2);
          const along = vp.toDisplay(apply(m, 1, 0));
          expect(along.x - anchor.x).toBeGreaterThan(0);
          expect(along.y - anchor.y).toBeCloseTo(0, 4);
        } finally {
          await vp.destroy();
        }
      });

      it('sticky note box and its text sit where it was drawn', async () => {
        const rect = { x: 0.6, y: 0.1, width: 0.3, height: 0.2 };
        const { vp, drawn } = await draw([
          {
            pageKey: 'p0',
            type: 'sticky',
            color: '#ffee88',
            strokeWidth: 0,
            rect,
            text: 'note',
            fontSize: 12
          }
        ]);
        try {
          // pdf-lib draws rectangles as SVG paths (m / l / h), not `re`.
          expect(drawn.paths).toHaveLength(1);
          const box = {
            left: rect.x * vp.width,
            top: rect.y * vp.height,
            right: (rect.x + rect.width) * vp.width,
            bottom: (rect.y + rect.height) * vp.height
          };
          expectBox(bbox(drawn.paths[0].map(vp.toDisplay)), box);
          expect(drawn.texts).toHaveLength(1);
          const anchor = vp.toDisplay(apply(drawn.texts[0], 0, 0));
          expect(anchor.x).toBeCloseTo(box.left + 6, 2);
          expect(anchor.y).toBeCloseTo(box.top + 12 + 4, 2);
          const along = vp.toDisplay(apply(drawn.texts[0], 1, 0));
          expect(along.x - anchor.x).toBeGreaterThan(0);
        } finally {
          await vp.destroy();
        }
      });
    });
  }

  it('refuses non-Latin annotation text with a clear message, not a raw pdf-lib throw', async () => {
    const source = await offsetPage(90);
    for (const type of ['text', 'sticky'] as const) {
      await expect(
        composeOne(source, {
          annotations: [
            {
              pageKey: 'p0',
              type,
              color: '#000000',
              strokeWidth: 0,
              rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.1 },
              text: 'Привет 你好'
            }
          ]
        })
      ).rejects.toThrow(/built-in PDF font cannot write/);
    }
  });

  it('keeps an unrotated, uncropped, origin page exactly where it was', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    const source = await doc.save();
    const out = await composeOne(source, {
      annotations: [
        {
          pageKey: 'p0',
          type: 'whiteout',
          color: '#ffffff',
          strokeWidth: 0,
          rect: { x: 0.1, y: 0.1, width: 0.5, height: 0.25 }
        }
      ]
    });
    const drawn = interpret(await pageContent(out));
    // Raw PDF space: x = 61.2, y = 792 − 79.2 − 198 = 514.8.
    expectBox(bbox(drawn.paths[0]), { left: 61.2, top: 514.8, right: 367.2, bottom: 712.8 });
  });
});

/* ------------------------------------------------------------------ *
 * PDF-8 — raster compression
 * ------------------------------------------------------------------ */

/** A baseline JPEG whose SOF0 declares `width` × `height` (header only). */
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

function boxOf(dict: PDFDict, key: string): number[] {
  const array = dict.lookup(PDFName.of(key), PDFArray);
  return array.asArray().map(n => (n as PDFNumber).asNumber());
}

describe('PDF-8: raster compression keeps the crop, its origin and the annotations', () => {
  for (const rotation of ROTATIONS) {
    it(`/Rotate ${rotation}`, async () => {
      const LINK: Box = [200, 300, 400, 350];
      const source = await offsetPage(rotation, { pad: true, annots: [LINK] });
      const quarter = rotation === 90 || rotation === 270;
      // What pdf.js hands the raster route: the visible box, as displayed.
      const raster = quarter
        ? jpegOfSize(VISIBLE_H * 2, VISIBLE_W * 2)
        : jpegOfSize(VISIBLE_W * 2, VISIBLE_H * 2);
      const result = await processWorkerImpl.rebuildCompressed(
        source,
        { 0: raster },
        {},
        silentJob
      );
      expect(result.keptOriginal).toBe(false);

      const out = await PDFDocument.load(result.bytes);
      expect(out.getPageCount()).toBe(1);
      const page = out.getPage(0);
      // The page *is* the visible box, in the original user space.
      expect(boxOf(page.node, 'MediaBox')).toEqual(CROP);
      expect(boxOf(page.node, 'CropBox')).toEqual(CROP);
      expect(page.getRotation().angle).toBe(rotation);

      // Annotation /Rect untouched — same user space, so it still sits on the
      // same content.
      const annots = page.node.lookup(PDFName.of('Annots'), PDFArray);
      expect(annots.size()).toBe(1);
      const annot = out.context.lookup(annots.get(0) as PDFRef, PDFDict);
      expect(boxOf(annot, 'Rect')).toEqual(LINK);

      // The raster fills exactly what the user saw — no stretch over the cut
      // margins — and reads upright.
      const vp = await viewportOf(result.bytes);
      const sourceVp = await viewportOf(source);
      try {
        expect(vp.width).toBeCloseTo(sourceVp.width, 6);
        expect(vp.height).toBeCloseTo(sourceVp.height, 6);
        const drawn = interpret(await pageContent(result.bytes));
        expect(drawn.images).toHaveLength(1);
        const m = drawn.images[0];
        const shown = [apply(m, 0, 0), apply(m, 1, 0), apply(m, 1, 1), apply(m, 0, 1)].map(
          vp.toDisplay
        );
        expectBox(bbox(shown), { left: 0, top: 0, right: vp.width, bottom: vp.height }, 4);
        // Image bottom-left at the displayed bottom-left; +x along display +x.
        expect(shown[0].x).toBeCloseTo(0, 4);
        expect(shown[0].y).toBeCloseTo(vp.height, 4);
        expect(shown[1].x).toBeCloseTo(vp.width, 4);
        expect(shown[1].y).toBeCloseTo(vp.height, 4);

        // The link maps to the same displayed spot on the source and the output.
        for (const corner of [
          { x: LINK[0], y: LINK[1] },
          { x: LINK[2], y: LINK[3] }
        ]) {
          const before = sourceVp.toDisplay(corner);
          const after = vp.toDisplay(corner);
          expect(after.x).toBeCloseTo(before.x, 6);
          expect(after.y).toBeCloseTo(before.y, 6);
        }
      } finally {
        await vp.destroy();
        await sourceVp.destroy();
      }
    });
  }

  it('an offset MediaBox with no CropBox keeps its origin', async () => {
    const source = await offsetPage(0, { crop: null, pad: true });
    const result = await processWorkerImpl.rebuildCompressed(
      source,
      { 0: jpegOfSize(612 * 2, 792 * 2) },
      {},
      silentJob
    );
    expect(result.keptOriginal).toBe(false);
    const page = (await PDFDocument.load(result.bytes)).getPage(0);
    expect(boxOf(page.node, 'MediaBox')).toEqual(MEDIA);
    const m = interpret(await pageContent(result.bytes)).images[0];
    expect(apply(m, 0, 0)).toEqual({ x: 100, y: 100 });
    expect(apply(m, 1, 1)).toEqual({ x: 712, y: 892 });
  });
});
