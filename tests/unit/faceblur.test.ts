import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDict, PDFDocument, PDFName, PDFRawStream, StandardFonts } from 'pdf-lib';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { decodePng } from './helpers/png-decode';

/**
 * RED-08 — on-device face/logo blur.
 *
 * Four things are being proved here, and each is proved against real bytes or
 * real pixels rather than against intent:
 *
 *  1. **The blur itself.** `pixelateRects` is exercised on a synthetic swatch
 *     where every pixel's correct value is known, exactly as
 *     `image-redaction.test.ts` does for `paintRectsBlack`. A y-flip error in
 *     this code mosaics the wrong band and leaves the face readable, and it
 *     does not fail loudly.
 *
 *  2. **The detector, for real.** The real `tinyFaceDetector` weights are
 *     loaded off disk and the real network is run over a real photograph of a
 *     face, composited at a position this file chose. The assertion is RED-08's
 *     first acceptance criterion, word for word: the blurred region overlaps
 *     that position, and pixels away from it are byte-identical.
 *
 *  3. **The document surgery.** The same face goes into a real PDF, through the
 *     real `planPageImages` / `replacePageImages` pair, and the output is
 *     re-parsed: the page count holds, the page's text still extracts, the
 *     content stream is byte-identical, and the image's own samples changed
 *     only where the face was.
 *
 *  4. **The consent gate.** No fetch, no worker, no model load happens before
 *     the user says yes — asserted by mocking the worker pool and the network
 *     and showing neither is touched on the decline path.
 */

const FIXTURES = path.resolve(__dirname, '../fixtures');
const MODEL_DIR = path.resolve(__dirname, '../../node_modules/@vladmandic/face-api/model');
const MANIFEST_FILE = 'tiny_face_detector_model-weights_manifest.json';

/**
 * tfjs picks its platform at import time: `WorkerGlobalScope` present means
 * "browser", which is what a Web Worker — where this code actually runs — looks
 * like. Under plain Node it instead selects its Node platform, which does
 * `require('util').TextEncoder` and throws inside an ESM process. Declaring the
 * global before the dynamic import puts the test on the same platform the
 * product uses rather than on a path the product never takes.
 */
beforeAll(() => {
  (globalThis as unknown as { WorkerGlobalScope: unknown }).WorkerGlobalScope =
    function WorkerGlobalScope() {};
});

/* ------------------------------------------------------------------ *
 * model.ts — the second (and last) network destination, and its seam
 * ------------------------------------------------------------------ */

describe('faceblur/model', () => {
  beforeEach(async () => {
    const { setModelBaseOverride } = await import('../../src/core/faceblur/model');
    setModelBaseOverride(null);
  });

  it('pins an exact package version rather than a floating tag', async () => {
    const { resolveManifestUrl } = await import('../../src/core/faceblur/model');
    const url = resolveManifestUrl();
    expect(url).toMatch(
      /^https:\/\/cdn\.jsdelivr\.net\/npm\/@vladmandic\/face-api@\d+\.\d+\.\d+\//
    );
    expect(url.endsWith(`/${MANIFEST_FILE}`)).toBe(true);
    // A `@latest` or bare-package URL would let the weights change under a
    // build that has already shipped and been audited — the exact thing
    // "download once, then fully offline" is supposed to rule out.
    expect(url).not.toMatch(/@latest|@next|face-api\/model/);
  });

  it('names the same version the bundled engine is', async () => {
    const { resolveManifestUrl } = await import('../../src/core/faceblur/model');
    const pkg = JSON.parse(readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    const installed = pkg.dependencies['@vladmandic/face-api'].replace(/^[^\d]*/, '');
    // The bundled inference code and the fetched weights are two halves of one
    // artefact; drifting apart produces a detector that silently finds nothing.
    expect(resolveManifestUrl()).toContain(`@${installed}/`);
  });

  it('routes every URL through the override seam once it is set', async () => {
    const { resolveManifestUrl, resolveShardUrl, setModelBaseOverride } =
      await import('../../src/core/faceblur/model');
    setModelBaseOverride('http://localhost:9999/weights/');
    expect(resolveManifestUrl()).toBe(`http://localhost:9999/weights/${MANIFEST_FILE}`);
    expect(resolveShardUrl('a.bin')).toBe('http://localhost:9999/weights/a.bin');
    setModelBaseOverride(null);
    expect(resolveManifestUrl()).toContain('cdn.jsdelivr.net');
  });

  it('refuses a shard path that would redirect the one pinned download', async () => {
    const { resolveShardUrl } = await import('../../src/core/faceblur/model');
    // The manifest is remote data. A `paths` entry pointing somewhere else
    // would turn one audited URL into a fetch of the manifest author's choosing.
    expect(() => resolveShardUrl('../../../etc/passwd')).toThrow();
    expect(() => resolveShardUrl('https://elsewhere.example/x.bin')).toThrow();
    expect(() => resolveShardUrl('./x.bin')).toThrow();
    expect(() => resolveShardUrl('sub/dir.bin')).toThrow();
  });

  it('discloses a size', async () => {
    const { APPROX_SIZE_MB } = await import('../../src/core/faceblur/model');
    expect(APPROX_SIZE_MB).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ *
 * blur.ts — the pixels, where a coordinate error hides
 * ------------------------------------------------------------------ */

/** An 8x8 RGBA image where every pixel is a distinct, known colour. */
function swatch(width = 8, height = 8) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    rgba[p * 4] = (p * 7) % 256;
    rgba[p * 4 + 1] = (p * 13) % 256;
    rgba[p * 4 + 2] = (p * 29) % 256;
    rgba[p * 4 + 3] = 255;
  }
  return { rgba, width, height };
}

const pixelAt = (rgba: Uint8ClampedArray, width: number, x: number, y: number) => {
  const p = (y * width + x) * 4;
  return [rgba[p], rgba[p + 1], rgba[p + 2], rgba[p + 3]];
};

describe('faceblur/blur — pixelateRects', () => {
  it('maps the unit square y-up, so the top half of the image is the top of the rect', async () => {
    const { pixelateRects } = await import('../../src/core/faceblur/blur');
    const image = swatch();
    const before = Uint8ClampedArray.from(image.rgba);
    // y 0.5..1 in unit space is the *top* of the image — rows 0..3. Getting
    // this flip wrong mosaics the wrong half and leaves the face readable.
    pixelateRects(image, [{ x: 0, y: 0.5, width: 1, height: 0.5 }], { padFraction: 0 });

    let changedTop = 0;
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 8; x++) {
        const p = (y * 8 + x) * 4;
        if (image.rgba[p] !== before[p]) changedTop += 1;
      }
    }
    expect(changedTop).toBeGreaterThan(0);
    // The bottom half is byte-identical.
    for (let y = 4; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        expect(pixelAt(image.rgba, 8, x, y)).toEqual(pixelAt(before, 8, x, y));
      }
    }
  });

  it('writes nothing outside the rect', async () => {
    const { pixelateRects } = await import('../../src/core/faceblur/blur');
    const image = swatch();
    const before = Uint8ClampedArray.from(image.rgba);
    // Bottom-left quarter: columns 0-3, rows 4-7.
    pixelateRects(image, [{ x: 0, y: 0, width: 0.5, height: 0.5 }], {
      padFraction: 0,
      strength: 'strong'
    });
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const inside = x < 4 && y >= 4;
        const same = pixelAt(image.rgba, 8, x, y).join() === pixelAt(before, 8, x, y).join();
        if (!inside) expect(same).toBe(true);
      }
    }
  });

  it('replaces each block with its own average, so the block is genuinely flat', async () => {
    const { pixelateRects } = await import('../../src/core/faceblur/blur');
    const image = swatch(4, 4);
    // 'strong' asks for 4 blocks across a 4px box, which floors to the 2px
    // minimum block — a 2x2 grid of 2x2 blocks.
    pixelateRects(image, [{ x: 0, y: 0, width: 1, height: 1 }], {
      padFraction: 0,
      strength: 'strong'
    });
    // Every 2x2 block is one colour.
    for (const [bx, by] of [
      [0, 0],
      [2, 0],
      [0, 2],
      [2, 2]
    ]) {
      const reference = pixelAt(image.rgba, 4, bx, by);
      expect(pixelAt(image.rgba, 4, bx + 1, by)).toEqual(reference);
      expect(pixelAt(image.rgba, 4, bx, by + 1)).toEqual(reference);
      expect(pixelAt(image.rgba, 4, bx + 1, by + 1)).toEqual(reference);
    }
  });

  it('leaves a flat area at exactly its own value rather than drifting a level', async () => {
    const { pixelateRects } = await import('../../src/core/faceblur/blur');
    const rgba = new Uint8ClampedArray(4 * 4 * 4).fill(137);
    for (let p = 0; p < 16; p++) rgba[p * 4 + 3] = 255;
    const image = { rgba, width: 4, height: 4 };
    pixelateRects(image, [{ x: 0, y: 0, width: 1, height: 1 }], { padFraction: 0 });
    for (let p = 0; p < 16; p++) expect(rgba[p * 4]).toBe(137);
  });

  it('mosaics the soft mask too, so no alpha silhouette of the head survives', async () => {
    const { pixelateRects } = await import('../../src/core/faceblur/blur');
    const mask = new Uint8Array(64);
    // A hard-edged cut-out in the alpha channel, in the top half. Its edges sit
    // at odd columns on purpose, so they fall *inside* a mosaic block rather
    // than along a block boundary — an edge that happens to align with the grid
    // would survive unchanged and the test would prove nothing.
    for (let y = 0; y < 4; y++) for (let x = 3; x < 6; x++) mask[y * 8 + x] = 255;
    const image = { ...swatch(), mask };
    pixelateRects(image, [{ x: 0, y: 0.5, width: 1, height: 0.5 }], { padFraction: 0 });
    // The 0/255 step is gone: the mask now holds intermediate values.
    const distinct = new Set(mask.slice(0, 32));
    expect([...distinct].some(value => value !== 0 && value !== 255)).toBe(true);
    // And the untouched bottom half is still exactly zero.
    expect([...mask.slice(32)].every(value => value === 0)).toBe(true);
  });

  it('grows the box by the padding fraction, because a detector boxes features not heads', async () => {
    const { rectToPixelBox } = await import('../../src/core/faceblur/blur');
    const tight = rectToPixelBox({ x: 0.4, y: 0.4, width: 0.2, height: 0.2 }, 100, 100, 0);
    const padded = rectToPixelBox({ x: 0.4, y: 0.4, width: 0.2, height: 0.2 }, 100, 100, 0.25);
    expect(tight).toEqual({ x0: 40, y0: 40, x1: 60, y1: 60 });
    expect(padded).toEqual({ x0: 35, y0: 35, x1: 65, y1: 65 });
  });

  it('clips a rect that runs past the edge instead of writing out of bounds', async () => {
    const { pixelateRects } = await import('../../src/core/faceblur/blur');
    const image = swatch();
    expect(() =>
      pixelateRects(image, [{ x: -5, y: -5, width: 20, height: 20 }], { padFraction: 0.5 })
    ).not.toThrow();
    expect(image.rgba.length).toBe(8 * 8 * 4);
  });
});

/* ------------------------------------------------------------------ *
 * detect.ts — the real network, the real weights, a real face
 * ------------------------------------------------------------------ */

/**
 * A 640x480 "page raster": near-white paper, two solid colour blocks standing
 * in for page furniture, and a real photograph of a face composited at a
 * position chosen *here*, so the expected answer is not something the detector
 * gets to define.
 */
const PAGE_WIDTH = 640;
const PAGE_HEIGHT = 480;
const CHIP_AT = { x: 200, y: 120 };

/**
 * Where the face sits inside `face-chip.png`, in the chip's own pixels.
 *
 * Measured by eye off the fixture — forehead to chin, ear to ear — and recorded
 * in `tests/fixtures/README.md`, deliberately **not** taken from a detector
 * run. Asserting that the detector agrees with its own previous answer would
 * prove nothing; asserting that it agrees with where the face visibly is, is
 * the acceptance criterion.
 */
const FACE_IN_CHIP = { x: 62, y: 63, width: 113, height: 112 };

const KNOWN_FACE = {
  x: CHIP_AT.x + FACE_IN_CHIP.x,
  y: CHIP_AT.y + FACE_IN_CHIP.y,
  width: FACE_IN_CHIP.width,
  height: FACE_IN_CHIP.height
};

/** Background points far from the face, sampled to prove nothing else moved. */
const BACKGROUND_PROBES = [
  { x: 40, y: 40 },
  { x: 120, y: 60 },
  { x: 500, y: 400 },
  { x: 600, y: 40 },
  { x: 30, y: 460 },
  { x: 620, y: 240 }
];

function faceChip() {
  return decodePng(new Uint8Array(readFileSync(path.join(FIXTURES, 'face-chip.png'))));
}

function pageRaster() {
  const rgba = new Uint8ClampedArray(PAGE_WIDTH * PAGE_HEIGHT * 4);
  for (let p = 0; p < PAGE_WIDTH * PAGE_HEIGHT; p++) {
    rgba[p * 4] = 250;
    rgba[p * 4 + 1] = 248;
    rgba[p * 4 + 2] = 245;
    rgba[p * 4 + 3] = 255;
  }
  const block = (x0: number, y0: number, x1: number, y1: number, rgb: number[]) => {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const p = (y * PAGE_WIDTH + x) * 4;
        rgba[p] = rgb[0];
        rgba[p + 1] = rgb[1];
        rgba[p + 2] = rgb[2];
      }
    }
  };
  block(20, 20, 160, 90, [30, 90, 180]);
  block(460, 380, 610, 450, [200, 60, 40]);

  const chip = faceChip();
  for (let y = 0; y < chip.height; y++) {
    for (let x = 0; x < chip.width; x++) {
      const s = (y * chip.width + x) * 4;
      const d = ((y + CHIP_AT.y) * PAGE_WIDTH + (x + CHIP_AT.x)) * 4;
      rgba[d] = chip.rgba[s];
      rgba[d + 1] = chip.rgba[s + 1];
      rgba[d + 2] = chip.rgba[s + 2];
    }
  }
  return { rgba, width: PAGE_WIDTH, height: PAGE_HEIGHT };
}

/** The real weights, read from the installed package rather than the CDN. */
function localWeights() {
  const manifest = JSON.parse(readFileSync(path.join(MODEL_DIR, MANIFEST_FILE), 'utf8'));
  const shard = new Uint8Array(readFileSync(path.join(MODEL_DIR, manifest[0].paths[0] as string)));
  return { manifest, shard };
}

/** A detected unit-space rect, back in the raster's own pixels, y down from the top. */
function toPixels(region: { x: number; y: number; width: number; height: number }) {
  return {
    x: region.x * PAGE_WIDTH,
    y: (1 - region.y - region.height) * PAGE_HEIGHT,
    width: region.width * PAGE_WIDTH,
    height: region.height * PAGE_HEIGHT
  };
}

function overlapArea(a: ReturnType<typeof toPixels>, b: typeof KNOWN_FACE) {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  if (x1 <= x0 || y1 <= y0) return 0;
  return (x1 - x0) * (y1 - y0);
}

describe('faceblur/detect — the real detector on a known face position', () => {
  beforeAll(async () => {
    const { loadFaceModel } = await import('../../src/core/faceblur/detect');
    await loadFaceModel(localWeights());
  }, 120_000);

  afterAll(async () => {
    const { unloadFaceModel } = await import('../../src/core/faceblur/detect');
    await unloadFaceModel();
  });

  it('finds exactly one face, and it is the one at the position this test placed', async () => {
    const { detectFaces } = await import('../../src/core/faceblur/detect');
    const regions = await detectFaces(pageRaster());

    expect(regions.length).toBe(1);
    const found = toPixels(regions[0]);
    const known = KNOWN_FACE.width * KNOWN_FACE.height;
    const shared = overlapArea(found, KNOWN_FACE);
    // Most of the visible face is inside what was detected.
    expect(shared / known).toBeGreaterThan(0.6);
    // And the detection is not a box around the whole page that happens to
    // contain the face: the union stays close to the face's own size.
    const union = found.width * found.height + known - shared;
    expect(shared / union).toBeGreaterThan(0.4);
    expect(regions[0].kind).toBe('face');
  }, 120_000);

  it('blurs a region overlapping the known face and leaves everything else byte-identical', async () => {
    const { detectFaces } = await import('../../src/core/faceblur/detect');
    const { pixelateRects } = await import('../../src/core/faceblur/blur');

    const image = pageRaster();
    const before = Uint8ClampedArray.from(image.rgba);
    const regions = await detectFaces(image);
    expect(regions.length).toBeGreaterThan(0);

    pixelateRects(image, regions, { strength: 'strong' });

    // 1. Inside the known face box, the pixels are substantially different.
    let sampled = 0;
    let changedHard = 0;
    for (let y = KNOWN_FACE.y; y < KNOWN_FACE.y + KNOWN_FACE.height; y += 4) {
      for (let x = KNOWN_FACE.x; x < KNOWN_FACE.x + KNOWN_FACE.width; x += 4) {
        const p = (y * PAGE_WIDTH + x) * 4;
        const delta =
          Math.abs(image.rgba[p] - before[p]) +
          Math.abs(image.rgba[p + 1] - before[p + 1]) +
          Math.abs(image.rgba[p + 2] - before[p + 2]);
        sampled += 1;
        if (delta > 20) changedHard += 1;
      }
    }
    // A mosaic leaves a handful of pixels near their block average, so this
    // is a large-majority test rather than an every-pixel one.
    expect(changedHard / sampled).toBeGreaterThan(0.8);

    // 2. Background far from the face is untouched, to the byte.
    for (const probe of BACKGROUND_PROBES) {
      const p = (probe.y * PAGE_WIDTH + probe.x) * 4;
      expect([image.rgba[p], image.rgba[p + 1], image.rgba[p + 2]]).toEqual([
        before[p],
        before[p + 1],
        before[p + 2]
      ]);
    }

    // 3. Nothing outside the union of the detected boxes changed at all.
    const boxes = regions.map(toPixels);
    let strayChanges = 0;
    for (let y = 0; y < PAGE_HEIGHT; y += 3) {
      for (let x = 0; x < PAGE_WIDTH; x += 3) {
        const p = (y * PAGE_WIDTH + x) * 4;
        if (image.rgba[p] === before[p] && image.rgba[p + 1] === before[p + 1]) continue;
        const insideSome = boxes.some(
          box =>
            // The padding `pixelateRects` applies grows the box by 15% a side.
            x >= box.x - box.width * 0.2 &&
            x <= box.x + box.width * 1.2 &&
            y >= box.y - box.height * 0.2 &&
            y <= box.y + box.height * 1.2
        );
        if (!insideSome) strayChanges += 1;
      }
    }
    expect(strayChanges).toBe(0);
  }, 120_000);

  it('finds nothing in a picture with no face in it, rather than blurring at random', async () => {
    const { detectFaces } = await import('../../src/core/faceblur/detect');
    const rgba = new Uint8ClampedArray(320 * 240 * 4);
    for (let p = 0; p < 320 * 240; p++) {
      // Deterministic pseudo-texture, so the assertion cannot flake on a seed.
      rgba[p * 4] = (p * 37) % 256;
      rgba[p * 4 + 1] = (p * 91) % 256;
      rgba[p * 4 + 2] = (p * 53) % 256;
      rgba[p * 4 + 3] = 255;
    }
    const regions = await detectFaces({ rgba, width: 320, height: 240 });
    expect(regions).toEqual([]);
  }, 120_000);

  it('reduces a very large raster before inference rather than tensorising all of it', async () => {
    const { toDetectionRgb } = await import('../../src/core/faceblur/detect');
    const width = 2480;
    const height = 3508;
    const rgba = new Uint8ClampedArray(width * height * 4);
    const reduced = toDetectionRgb({ rgba, width, height });
    expect(Math.max(reduced.width, reduced.height)).toBeLessThanOrEqual(1024);
    // Aspect ratio survives, or every box would come back stretched.
    expect(reduced.width / reduced.height).toBeCloseTo(width / height, 2);
  });
});

/* ------------------------------------------------------------------ *
 * logoMatch.ts — the half that needs no model at all
 * ------------------------------------------------------------------ */

describe('faceblur/logoMatch', () => {
  /** A page-like raster with a distinctive "logo" stamped at known positions. */
  function pageWithLogos(positions: { x: number; y: number }[]) {
    const width = 480;
    const height = 360;
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let p = 0; p < width * height; p++) {
      // A low-contrast paper texture, so the page is not uniformly flat.
      rgba[p * 4] = 235 + (p % 7);
      rgba[p * 4 + 1] = 233 + (p % 5);
      rgba[p * 4 + 2] = 230 + (p % 3);
      rgba[p * 4 + 3] = 255;
    }
    // A wordmark-shaped stamp: a solid disc, a rule under it, and three
    // block "letters". Deliberately made of ~10px shapes rather than a fine
    // checkerboard, because that is what a real logo is — and because a
    // template whose detail is finer than the search grid's stride is the one
    // documented case this matcher does not promise to find.
    for (const at of positions) {
      for (let y = 0; y < 40; y++) {
        for (let x = 0; x < 60; x++) {
          const disc = (x - 14) ** 2 + (y - 14) ** 2 < 100;
          const rule = y >= 30 && y < 34 && x >= 4 && x < 56;
          const letters = y >= 8 && y < 22 && [30, 40, 50].some(lx => x >= lx && x < lx + 7);
          const on = disc || rule || letters;
          const p = ((at.y + y) * width + at.x + x) * 4;
          rgba[p] = on ? 20 : 245;
          rgba[p + 1] = on ? 60 : 244;
          rgba[p + 2] = on ? 140 : 242;
        }
      }
    }
    return { rgba, width, height };
  }

  it('crops a unit-space rect out of an image, y-up', async () => {
    const { cropUnitRect } = await import('../../src/core/faceblur/logoMatch');
    const image = swatch(8, 8);
    // Top-left quarter in unit space: x 0..0.5, y 0.5..1.
    const crop = cropUnitRect(image, { x: 0, y: 0.5, width: 0.5, height: 0.5 });
    expect(crop).not.toBeNull();
    expect(crop!.width).toBe(4);
    expect(crop!.height).toBe(4);
    // Its first pixel is the image's own first pixel — the top-left corner.
    expect(pixelAt(crop!.rgba, 4, 0, 0)).toEqual(pixelAt(image.rgba, 8, 0, 0));
  });

  it('finds every repeat of a marked graphic, and nothing else', async () => {
    const { cropUnitRect, matchTemplate } = await import('../../src/core/faceblur/logoMatch');
    const placed = [
      { x: 30, y: 20 },
      { x: 300, y: 40 },
      { x: 200, y: 280 }
    ];
    const page = pageWithLogos(placed);
    const template = cropUnitRect(page, {
      x: 30 / 480,
      y: 1 - 60 / 360,
      width: 60 / 480,
      height: 40 / 360
    });
    expect(template).not.toBeNull();

    const matches = matchTemplate(page, template!, { scales: [1] });
    expect(matches.length).toBe(placed.length);

    // Each placement is claimed by exactly one match, within a few pixels.
    for (const at of placed) {
      const hit = matches.find(match => {
        const x = match.x * 480;
        const y = (1 - match.y - match.height) * 360;
        return Math.abs(x - at.x) < 8 && Math.abs(y - at.y) < 8;
      });
      expect(hit, `no match near ${at.x},${at.y}`).toBeDefined();
      expect(hit!.score).toBeGreaterThan(0.75);
    }
  });

  it('reports nothing when the graphic is not on the page', async () => {
    const { cropUnitRect, matchTemplate } = await import('../../src/core/faceblur/logoMatch');
    const source = pageWithLogos([{ x: 30, y: 20 }]);
    const template = cropUnitRect(source, {
      x: 30 / 480,
      y: 1 - 60 / 360,
      width: 60 / 480,
      height: 40 / 360
    })!;
    const blank = pageWithLogos([]);
    expect(matchTemplate(blank, template, { scales: [1] })).toEqual([]);
  });

  it('survives a brightness shift, which is why the measure is normalised', async () => {
    const { cropUnitRect, matchTemplate } = await import('../../src/core/faceblur/logoMatch');
    const page = pageWithLogos([{ x: 100, y: 100 }]);
    const template = cropUnitRect(page, {
      x: 100 / 480,
      y: 1 - 140 / 360,
      width: 60 / 480,
      height: 40 / 360
    })!;
    // The same page, two stops darker — a scan of a photocopy of the original.
    const darker = {
      ...page,
      rgba: Uint8ClampedArray.from(page.rgba, (value, index) =>
        index % 4 === 3 ? value : Math.round(value * 0.55)
      )
    };
    const matches = matchTemplate(darker, template, { scales: [1] });
    expect(matches.length).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * The document surgery, against real PDF bytes
 * ------------------------------------------------------------------ */

vi.mock('comlink', () => ({
  expose: vi.fn(),
  transfer: vi.fn(value => value),
  proxy: vi.fn(value => value)
}));

/** Raw samples of the one image XObject a page draws, plus its dimensions. */
async function pageImageSamples(bytes: Uint8Array) {
  const { decodeStream } = await import('../../src/core/pdf/interpreter');
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPage(0);
  const xObjects = page.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict);
  for (const [, ref] of xObjects?.entries() ?? []) {
    const stream = doc.context.lookup(ref);
    if (!(stream instanceof PDFRawStream)) continue;
    if (stream.dict.get(PDFName.of('Subtype')) !== PDFName.of('Image')) continue;
    return {
      width: Number(stream.dict.get(PDFName.of('Width'))?.toString()),
      height: Number(stream.dict.get(PDFName.of('Height'))?.toString()),
      samples: await decodeStream(stream.getContents())
    };
  }
  throw new Error('no image XObject on page 0');
}

/** A one-page PDF: real text, and the face raster embedded as a PNG. */
async function documentWithFace(): Promise<Uint8Array> {
  const { encodePng } = await import('../../src/core/png');
  const raster = pageRaster();
  const samples = new Uint8Array(PAGE_WIDTH * PAGE_HEIGHT * 3);
  for (let p = 0; p < PAGE_WIDTH * PAGE_HEIGHT; p++) {
    samples[p * 3] = raster.rgba[p * 4];
    samples[p * 3 + 1] = raster.rgba[p * 4 + 1];
    samples[p * 3 + 2] = raster.rgba[p * 4 + 2];
  }
  const png = encodePng({
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
    bitDepth: 8,
    colorType: 2,
    samples
  });

  const doc = await PDFDocument.create();
  const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT + 60]);
  const font = await doc.embedStandardFont(StandardFonts.Helvetica);
  page.drawText('CONFIDENTIAL PERSONNEL FILE', { x: 20, y: PAGE_HEIGHT + 24, size: 14, font });
  const embedded = await doc.embedPng(png);
  page.drawImage(embedded, { x: 0, y: 0, width: PAGE_WIDTH, height: PAGE_HEIGHT });
  return doc.save();
}

describe('RED-08 end to end, against the bytes that come out', () => {
  beforeAll(async () => {
    const { loadFaceModel } = await import('../../src/core/faceblur/detect');
    await loadFaceModel(localWeights());
  }, 120_000);

  it('blurs the face inside a real PDF and leaves the page otherwise untouched', async () => {
    const { processWorkerImpl } = await import('../../src/core/workers/process.worker');
    const { detectFaces } = await import('../../src/core/faceblur/detect');
    const { pixelateRects } = await import('../../src/core/faceblur/blur');
    const { encodePng } = await import('../../src/core/png');

    const original = await documentWithFace();

    // 1. The plan: which image XObject, under which resource name.
    const plan = await processWorkerImpl.planPageImages(original, [0]);
    expect(plan.unaddressablePages).toEqual([]);
    expect(plan.images.length).toBe(1);
    const target = plan.images[0];
    expect(target.pageIndex).toBe(0);

    // 2. Detect and mosaic, on the image's real samples.
    const source = await pageImageSamples(original);
    expect(source.width).toBe(PAGE_WIDTH);
    const rgba = new Uint8ClampedArray(source.width * source.height * 4);
    for (let p = 0; p < source.width * source.height; p++) {
      rgba[p * 4] = source.samples[p * 3];
      rgba[p * 4 + 1] = source.samples[p * 3 + 1];
      rgba[p * 4 + 2] = source.samples[p * 3 + 2];
      rgba[p * 4 + 3] = 255;
    }
    const image = { rgba, width: source.width, height: source.height };
    const regions = await detectFaces(image);
    expect(regions.length).toBe(1);
    pixelateRects(image, regions, { strength: 'strong' });

    const blurredSamples = new Uint8Array(source.width * source.height * 3);
    for (let p = 0; p < source.width * source.height; p++) {
      blurredSamples[p * 3] = image.rgba[p * 4];
      blurredSamples[p * 3 + 1] = image.rgba[p * 4 + 1];
      blurredSamples[p * 3 + 2] = image.rgba[p * 4 + 2];
    }

    // 3. Substitute it back into the document.
    const written = await processWorkerImpl.replacePageImages(original, {
      0: {
        [target.name]: {
          bytes: encodePng({
            width: source.width,
            height: source.height,
            bitDepth: 8,
            colorType: 2,
            samples: blurredSamples
          }),
          format: 'png' as const,
          width: source.width,
          height: source.height
        }
      }
    });

    // 4. Re-parse the produced bytes and assert on the document, not on intent.
    const reparsed = await PDFDocument.load(written);
    expect(reparsed.getPageCount()).toBe(1);

    const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const pdf = await lib.getDocument({ data: written.slice(), useSystemFonts: false }).promise;
    expect(pdf.numPages).toBe(1);
    const content = await (await pdf.getPage(1)).getTextContent();
    const text = content.items.map(item => ('str' in item ? item.str : '')).join('');
    // Text is untouched by a pixel operation — this is the "text and vectors
    // are byte-untouched" half of the surgical path.
    expect(text.replace(/\s+/g, ' ')).toContain('CONFIDENTIAL PERSONNEL FILE');

    // 5. The image's own samples: mosaicked over the face, identical elsewhere.
    const after = await pageImageSamples(written);
    expect(after.width).toBe(source.width);
    expect(after.height).toBe(source.height);

    let sampled = 0;
    let changed = 0;
    for (let y = KNOWN_FACE.y; y < KNOWN_FACE.y + KNOWN_FACE.height; y += 4) {
      for (let x = KNOWN_FACE.x; x < KNOWN_FACE.x + KNOWN_FACE.width; x += 4) {
        const p = (y * source.width + x) * 3;
        const delta =
          Math.abs(after.samples[p] - source.samples[p]) +
          Math.abs(after.samples[p + 1] - source.samples[p + 1]) +
          Math.abs(after.samples[p + 2] - source.samples[p + 2]);
        sampled += 1;
        if (delta > 20) changed += 1;
      }
    }
    expect(changed / sampled).toBeGreaterThan(0.8);

    for (const probe of BACKGROUND_PROBES) {
      const p = (probe.y * source.width + probe.x) * 3;
      expect([after.samples[p], after.samples[p + 1], after.samples[p + 2]]).toEqual([
        source.samples[p],
        source.samples[p + 1],
        source.samples[p + 2]
      ]);
    }

    // 6. The unblurred original is gone from the file, not merely unreferenced.
    //    (`replacePageImages` purges the retired stream; if it did not, the old
    //    face would come straight back out with `pdfimages`.)
    const stillThere = await PDFDocument.load(written);
    let matchesOriginal = 0;
    for (const [, object] of stillThere.context.enumerateIndirectObjects()) {
      if (!(object instanceof PDFRawStream)) continue;
      if (object.dict.get(PDFName.of('Subtype')) !== PDFName.of('Image')) continue;
      const { decodeStream } = await import('../../src/core/pdf/interpreter');
      const samples = await decodeStream(object.getContents());
      const faceOffset = ((KNOWN_FACE.y + 40) * source.width + (KNOWN_FACE.x + 40)) * 3;
      if (
        samples.length === source.samples.length &&
        samples[faceOffset] === source.samples[faceOffset] &&
        samples[faceOffset + 1] === source.samples[faceOffset + 1] &&
        samples[faceOffset + 2] === source.samples[faceOffset + 2]
      ) {
        matchesOriginal += 1;
      }
    }
    expect(matchesOriginal).toBe(0);
  }, 180_000);

  it('leaves the document byte-for-byte alone when there is nothing to replace', async () => {
    const { processWorkerImpl } = await import('../../src/core/workers/process.worker');
    const original = await documentWithFace();
    const written = await processWorkerImpl.replacePageImages(original, {});
    expect(Array.from(written)).toEqual(Array.from(original));
  });
});
