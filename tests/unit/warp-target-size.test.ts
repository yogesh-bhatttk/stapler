import { describe, expect, it } from 'vitest';
import {
  estimateQuadAspectRatio,
  isDegenerateQuad,
  isFrameQuad,
  warpPerspective,
  warpTargetSize,
  type Quad
} from '../../src/core/cv/imageUtils';

/**
 * SCN-01 — "corrected output has straight edges and correct aspect".
 *
 * `warpTargetSize` decides the shape of every de-warped page, and it had no tests
 * at all. It used to take the longer of each pair of opposing edges as the output
 * dimension, which measures how close an edge was to the lens rather than how long
 * it is on paper: an 8.5×11 page came out 27% too wide at a 30° tilt and 127% too
 * wide at 60°. The numbers each case asserts are recorded in `MEASURED` below.
 *
 * Ground truth here is a real pinhole projection, not a hand-placed quad — the
 * corners are computed from a page of known size, at a known pose, through a
 * camera of known focal length, so "the right answer" is arithmetic rather than
 * eyeballing.
 */

/** US Letter, portrait. The aspect ratio every tilt case below has to recover. */
const LETTER = 8.5 / 11; // 0.772727…

interface Pose {
  /** Rotation about the horizontal axis: the page leaning away from the camera. */
  tilt: number;
  /** Rotation about the vertical axis. Zero is the degenerate case — see below. */
  pan?: number;
  /** Rotation in the page's own plane. */
  roll?: number;
  /**
   * Camera distance, in page heights. The default puts the page's corners where
   * the audited defect was measured, so the `before` column of {@link MEASURED}
   * reproduces the numbers that were reported.
   */
  distance?: number;
  /**
   * Focal length, as a multiple of the frame diagonal. The default is a 31mm
   * equivalent — deliberately *not* the 0.6 the implementation assumes when it
   * cannot solve for the lens, so the degenerate cases below are graded on a
   * camera the code guessed wrong about.
   */
  focal?: number;
}

/**
 * Projects a `aspect`-shaped page at `pose` into a `frame`-sized image.
 *
 * A plain pinhole camera: rotate the page in space, divide by depth, scale by the
 * focal length, offset to the principal point. This is the same projection a phone
 * performs, so a quad it produces is one the detector could really see.
 */
function photograph(aspect: number, frame: { width: number; height: number }, pose: Pose): Quad {
  const { tilt, pan = 0, roll = 0, distance = 2.3636, focal = 0.72 } = pose;
  const t = (tilt * Math.PI) / 180;
  const p = (pan * Math.PI) / 180;
  const r = (roll * Math.PI) / 180;
  const f = focal * Math.hypot(frame.width, frame.height);
  // Page in its own plane, height 1, centred on the origin, corners tl→tr→br→bl.
  const corners: [number, number][] = [
    [-aspect / 2, -0.5],
    [aspect / 2, -0.5],
    [aspect / 2, 0.5],
    [-aspect / 2, 0.5]
  ];

  const projected = corners.map(([x, y]) => {
    // roll, in plane
    const rx = x * Math.cos(r) - y * Math.sin(r);
    const ry = x * Math.sin(r) + y * Math.cos(r);
    // tilt, about the horizontal axis
    const ty = ry * Math.cos(t);
    const tz = ry * Math.sin(t);
    // pan, about the vertical axis
    const px = rx * Math.cos(p) + tz * Math.sin(p);
    const pz = -rx * Math.sin(p) + tz * Math.cos(p);
    const depth = pz + distance;
    return {
      x: frame.width / 2 + (f * px) / depth,
      y: frame.height / 2 + (f * ty) / depth
    };
  });

  return { tl: projected[0], tr: projected[1], br: projected[2], bl: projected[3] };
}

/** What the old implementation returned: the longer of each pair of edges. */
function projectedEdgeRatio(q: Quad): number {
  const top = Math.hypot(q.tr.x - q.tl.x, q.tr.y - q.tl.y);
  const bottom = Math.hypot(q.br.x - q.bl.x, q.br.y - q.bl.y);
  const left = Math.hypot(q.bl.x - q.tl.x, q.bl.y - q.tl.y);
  const right = Math.hypot(q.br.x - q.tr.x, q.br.y - q.tr.y);
  return Math.max(top, bottom) / Math.max(left, right);
}

const percentError = (got: number, want: number) => (Math.abs(got - want) / want) * 100;

const FRAME = { width: 1200, height: 1600 };

/**
 * Aspect-ratio error, per tilt angle, for the *degenerate* pose — the page tilted
 * about one axis only, which is the audit's scenario and the hardest one.
 *
 * There, the two horizontal edges stay parallel on screen, their vanishing point is
 * at infinity, and the perpendicularity equation that would give the focal length
 * loses its focal term. The aspect ratio is then genuinely ambiguous: a longer lens
 * further away photographs a differently-shaped page into the very same four
 * corners. So these cases measure how well an *assumed* phone lens does, on a
 * camera 20% away from the assumption.
 *
 * `before` is what the projected-edge implementation scored on the same quad, and
 * `after` what this one does. `tolerance` is `after` with a little headroom.
 */
const MEASURED: { tilt: number; before: number; after: number; tolerance: number }[] = [
  { tilt: 10, before: 5.23, after: 0.46, tolerance: 1 },
  { tilt: 20, before: 13.92, after: 1.84, tolerance: 2.5 },
  { tilt: 30, before: 27.12, after: 4.05, tolerance: 5 },
  { tilt: 40, before: 46.92, after: 6.98, tolerance: 8 },
  // Past ~40° the paper is nearly edge-on, the ambiguity above dominates, and a
  // document scanner is not expected to correct these at all. Still bounded, and
  // still far better than the 60% / 128% the projected edges gave.
  { tilt: 45, before: 60.45, after: 8.64, tolerance: 10 },
  { tilt: 60, before: 127.69, after: 13.9, tolerance: 15 }
];

describe('estimateQuadAspectRatio', () => {
  it('recovers the aspect ratio of a page tilted about one axis (degenerate pose)', () => {
    for (const { tilt, before, after: recorded, tolerance } of MEASURED) {
      const quad = photograph(LETTER, FRAME, { tilt });
      const { ratio, method, focalWeight } = estimateQuadAspectRatio(quad, FRAME);

      // No pan or roll means no horizontal vanishing point, so the focal length is
      // not there to be found and none of it may be used. A non-zero weight here
      // would mean the conditioning test had stopped working and it was solving
      // for a lens out of rounding error.
      expect(method, `tilt ${tilt}°`).toBe('assumed-focal');
      expect(focalWeight, `tilt ${tilt}°`).toBe(0);

      const measured = percentError(ratio, LETTER);
      const baseline = percentError(projectedEdgeRatio(quad), LETTER);
      // The recorded numbers are what this exact quad produced before and after.
      expect(baseline, `tilt ${tilt}° baseline`).toBeCloseTo(before, 0);
      expect(measured, `tilt ${tilt}° recorded`).toBeCloseTo(recorded, 1);
      expect(measured, `tilt ${tilt}°: ${measured.toFixed(2)}% > ${tolerance}%`).toBeLessThan(
        tolerance
      );
      expect(measured, `tilt ${tilt}° must beat the projected-edge ratio`).toBeLessThan(baseline);
    }
  });

  it('recovers the aspect ratio exactly when both vanishing points are visible', () => {
    // Any hand-held photo has some pan and roll, which puts the horizontal
    // vanishing point back in view and makes the focal length solvable. The closed
    // form is then near-exact at any tilt, and — the point of solving for it rather
    // than assuming it — independent of the lens that took the photo.
    for (const focal of [0.45, 0.6, 0.9, 1.2]) {
      for (const tilt of [10, 20, 30, 45, 60]) {
        const quad = photograph(LETTER, FRAME, { tilt, pan: 12, roll: 7, focal });
        const { ratio, method } = estimateQuadAspectRatio(quad, FRAME);
        expect(method, `tilt ${tilt}° focal ${focal}`).toBe('projective');
        expect(percentError(ratio, LETTER), `tilt ${tilt}° focal ${focal}`).toBeLessThan(0.5);
      }
    }
  });

  it('transposes with the corner labels rather than ignoring them', () => {
    // The width axis is tl→tr by definition. Relabelling the same four points one
    // corner round must therefore invert the ratio — this is what pins the
    // corner-to-rectangle correspondence the whole solve is built on.
    const quad = photograph(LETTER, FRAME, { tilt: 25, pan: 12, roll: 5 });
    const rotated: Quad = { tl: quad.tr, tr: quad.br, br: quad.bl, bl: quad.tl };
    const upright = estimateQuadAspectRatio(quad, FRAME).ratio;
    const sideways = estimateQuadAspectRatio(rotated, FRAME).ratio;
    expect(upright).toBeCloseTo(LETTER, 2);
    expect(sideways).toBeCloseTo(1 / LETTER, 1);
  });

  it('recovers landscape pages without transposing them', () => {
    const landscape = 11 / 8.5;
    for (const tilt of [10, 25, 40]) {
      const quad = photograph(landscape, FRAME, { tilt, pan: 10, roll: -6 });
      expect(estimateQuadAspectRatio(quad, FRAME).ratio).toBeCloseTo(landscape, 2);
    }
  });

  it('is exact for a page square to the lens, whatever the lens', () => {
    // Both vanishing points are at infinity here, but the focal length also
    // cancels out of the ratio, so an assumed one costs nothing.
    for (const focal of [0.4, 0.6, 1.5]) {
      const quad = photograph(LETTER, FRAME, { tilt: 0, focal });
      expect(estimateQuadAspectRatio(quad, FRAME).ratio).toBeCloseTo(LETTER, 6);
    }
  });

  it('falls back to the measured edges for a quad that is not a projected rectangle', () => {
    const collapsed: Quad = {
      tl: { x: 10, y: 10 },
      tr: { x: 10, y: 10 },
      br: { x: 10, y: 10 },
      bl: { x: 10, y: 10 }
    };
    const flat = estimateQuadAspectRatio(collapsed, FRAME);
    expect(flat.method).toBe('projected-edges');
    expect(Number.isFinite(flat.ratio)).toBe(true);

    // Three corners on one line: a real detector can emit this from a sliver of
    // contour, and it must not produce NaN.
    const collinear: Quad = {
      tl: { x: 0, y: 0 },
      tr: { x: 100, y: 0 },
      br: { x: 200, y: 0 },
      bl: { x: 0, y: 50 }
    };
    expect(Number.isFinite(estimateQuadAspectRatio(collinear, FRAME).ratio)).toBe(true);
  });

  it('tolerates a zero-sized frame rather than dividing by it', () => {
    const quad = photograph(LETTER, FRAME, { tilt: 20 });
    const estimate = estimateQuadAspectRatio(quad, { width: 0, height: 0 });
    expect(estimate.method).toBe('projected-edges');
    expect(Number.isFinite(estimate.ratio)).toBe(true);
  });
});

describe('warpTargetSize', () => {
  it('gives the de-warped page the true aspect ratio of the paper', () => {
    for (const { tilt, tolerance } of MEASURED) {
      const quad = photograph(LETTER, FRAME, { tilt });
      const { width, height } = warpTargetSize(quad, FRAME);
      expect(Number.isInteger(width) && Number.isInteger(height)).toBe(true);
      expect(percentError(width / height, LETTER), `tilt ${tilt}°`).toBeLessThan(tolerance);
    }
  });

  it('leaves an already-flat page at exactly its own size', () => {
    // The no-op path: a page that needs no correction must not be resampled to a
    // different size, or "clean up" would soften a page that was already square.
    const flat: Quad = {
      tl: { x: 100, y: 200 },
      tr: { x: 700, y: 200 },
      br: { x: 700, y: 1000 },
      bl: { x: 100, y: 1000 }
    };
    expect(warpTargetSize(flat, FRAME)).toEqual({ width: 600, height: 800 });
  });

  it('leaves a whole-frame quad at exactly the frame size', () => {
    // What `detectCorners` returns when it is not confident, and what the
    // "Use the whole page" button produces. `CleanupEditor.cornersFor` skips the
    // warp entirely for this quad (via `isFrameQuad`); this pins the sizing too,
    // so the fallback stays a true no-op if it is ever warped anyway.
    const frameQuad: Quad = {
      tl: { x: 0, y: 0 },
      tr: { x: FRAME.width, y: 0 },
      br: { x: FRAME.width, y: FRAME.height },
      bl: { x: 0, y: FRAME.height }
    };
    expect(isFrameQuad(frameQuad, FRAME.width, FRAME.height)).toBe(true);
    expect(warpTargetSize(frameQuad, FRAME)).toEqual({
      width: FRAME.width,
      height: FRAME.height
    });
  });

  it('keeps every axis at least as long as the longest edge measured along it', () => {
    // Correcting the shape must not resample the near edge of the page — the part
    // with the most detail — down below the resolution it was captured at.
    for (const tilt of [10, 20, 30]) {
      const quad = photograph(LETTER, FRAME, { tilt, pan: 8, roll: 4 });
      const { width, height } = warpTargetSize(quad, FRAME);
      const longestTop = Math.max(
        Math.hypot(quad.tr.x - quad.tl.x, quad.tr.y - quad.tl.y),
        Math.hypot(quad.br.x - quad.bl.x, quad.br.y - quad.bl.y)
      );
      const longestSide = Math.max(
        Math.hypot(quad.bl.x - quad.tl.x, quad.bl.y - quad.tl.y),
        Math.hypot(quad.br.x - quad.tr.x, quad.br.y - quad.tr.y)
      );
      expect(width + 1).toBeGreaterThanOrEqual(longestTop);
      expect(height + 1).toBeGreaterThanOrEqual(longestSide);
    }
  });

  it('never inflates the pixel count more than 2x, however grazing the angle', () => {
    // The correction factor is unbounded as the camera drops into the plane of the
    // page. A 12MP photo must not warp into a buffer that cannot be allocated.
    for (const tilt of [60, 70, 75, 80]) {
      const quad = photograph(LETTER, FRAME, { tilt, pan: 20, roll: 10 });
      const measured =
        Math.max(
          Math.hypot(quad.tr.x - quad.tl.x, quad.tr.y - quad.tl.y),
          Math.hypot(quad.br.x - quad.bl.x, quad.br.y - quad.bl.y)
        ) *
        Math.max(
          Math.hypot(quad.bl.x - quad.tl.x, quad.bl.y - quad.tl.y),
          Math.hypot(quad.br.x - quad.tr.x, quad.br.y - quad.tr.y)
        );
      const { width, height } = warpTargetSize(quad, FRAME);
      // `+ width + height` is the slack from rounding each axis to a whole pixel.
      expect(width * height, `tilt ${tilt}°`).toBeLessThanOrEqual(measured * 2 + width + height);
    }
  });

  /**
   * §4 — MAX_PIXEL_GROWTH is a *relative* bound: it protects a modest frame
   * from an unbounded correction factor, but a large enough frame can pass it
   * easily and still land a target past what a real canvas allocates. Measured
   * before this fix: a 10000×8000 frame with a tilted quad computed a
   * 16851×7999 target — comfortably inside 2× the base area, and ~539MB as an
   * RGBA buffer.
   */
  it('caps the output at a real canvas can allocate, even on a large source frame', () => {
    const bigFrame = { width: 10000, height: 8000 };
    const quad = photograph(LETTER, bigFrame, { tilt: 78, pan: 15, roll: 8 });
    const { width, height } = warpTargetSize(quad, bigFrame);

    expect(width).toBeLessThanOrEqual(8192);
    expect(height).toBeLessThanOrEqual(8192);
    expect(width * height).toBeLessThanOrEqual(48_000_000);
    // Still a real, non-degenerate warp target, not a fallback to nothing.
    expect(width).toBeGreaterThan(1000);
    expect(height).toBeGreaterThan(1000);
  });

  it('leaves an ordinary photo at its correctly-computed size, unaffected by the absolute cap', () => {
    const quad = photograph(LETTER, FRAME, { tilt: 40, pan: 10, roll: 5 });
    const uncapped = (() => {
      const top = Math.hypot(quad.tr.x - quad.tl.x, quad.tr.y - quad.tl.y);
      const bottom = Math.hypot(quad.br.x - quad.bl.x, quad.br.y - quad.bl.y);
      const left = Math.hypot(quad.bl.x - quad.tl.x, quad.bl.y - quad.tl.y);
      const right = Math.hypot(quad.br.x - quad.tr.x, quad.br.y - quad.tr.y);
      return Math.max(top, bottom) * Math.max(left, right);
    })();
    expect(uncapped).toBeLessThan(48_000_000); // sanity: this case does not need the cap at all
    const { width, height } = warpTargetSize(quad, FRAME);
    expect(width).toBeLessThanOrEqual(8192);
    expect(height).toBeLessThanOrEqual(8192);
  });

  it('returns a usable size for a degenerate quad instead of throwing', () => {
    const collapsed: Quad = {
      tl: { x: 5, y: 5 },
      tr: { x: 5, y: 5 },
      br: { x: 5, y: 5 },
      bl: { x: 5, y: 5 }
    };
    const size = warpTargetSize(collapsed, FRAME);
    expect(size.width).toBeGreaterThanOrEqual(1);
    expect(size.height).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(size.width) && Number.isInteger(size.height)).toBe(true);
  });
});

/**
 * Audit §2.7 — a degenerate crop quad blacking out or collapsing the page.
 *
 * `CleanupEditor`'s four handles have no minimum area, no convexity, and no
 * ordering, so three of them can be dragged onto one line or all four onto a
 * point. The homography such a quad asks for is rank-deficient but *not* exactly
 * singular, so the solver's `|pivot| < 1e-12` guard never fires: the elimination
 * completes and hands back a transform with a dead row.
 *
 * These tests push those quads through `warpPerspective` and assert on the pixels
 * that come out — which is exactly what the block above this one did not do: it
 * built the collinear quad and only checked `Number.isFinite` on an aspect ratio.
 */
describe('degenerate quads', () => {
  /**
   * A frame whose top row is black and whose body is white.
   *
   * This is the shape of the measured defect: the collinear quad's homography
   * maps *every* output row onto source row 0, so before the fix the entire
   * output came back solid black. Any page photographed against a dark desk, or
   * with a shadow along its top edge, is this image.
   */
  function frameWithDarkTopRow(width: number, height: number): ImageData {
    const image = new ImageData(width, height);
    image.data.fill(255);
    for (let x = 0; x < width; x++) {
      const i = x * 4;
      image.data[i] = 0;
      image.data[i + 1] = 0;
      image.data[i + 2] = 0;
      image.data[i + 3] = 255;
    }
    return image;
  }

  const fractionDarkerThan = (image: ImageData, level: number) => {
    let dark = 0;
    for (let i = 0; i < image.data.length; i += 4) if (image.data[i] < level) dark += 1;
    return dark / (image.width * image.height);
  };

  /** Three corners on the x axis, the audit's own example. */
  const COLLINEAR: Quad = {
    tl: { x: 0, y: 0 },
    tr: { x: 100, y: 0 },
    br: { x: 200, y: 0 },
    bl: { x: 0, y: 50 }
  };
  /** All four handles dragged onto one point. */
  const COINCIDENT: Quad = {
    tl: { x: 150, y: 200 },
    tr: { x: 150, y: 200 },
    br: { x: 150, y: 200 },
    bl: { x: 150, y: 200 }
  };
  /** Not exactly collinear — a real drag lands a pixel or so off the line. */
  const NEARLY_COLLINEAR: Quad = {
    tl: { x: 10, y: 10 },
    tr: { x: 200, y: 10.5 },
    br: { x: 290, y: 11 },
    bl: { x: 10, y: 390 }
  };
  /** Four healthy corners bounding almost nothing: the page shrunk to a speck. */
  const PINPOINT: Quad = {
    tl: { x: 150, y: 200 },
    tr: { x: 156, y: 200 },
    br: { x: 156, y: 208 },
    bl: { x: 150, y: 208 }
  };

  const SMALL = { width: 300, height: 400 };

  it('recognises every shape that is not a page', () => {
    expect(isDegenerateQuad(COLLINEAR, SMALL)).toBe(true);
    expect(isDegenerateQuad(COINCIDENT, SMALL)).toBe(true);
    expect(isDegenerateQuad(NEARLY_COLLINEAR, SMALL)).toBe(true);
    expect(isDegenerateQuad(PINPOINT, SMALL)).toBe(true);
  });

  it('returns the page unchanged for three collinear corners, not a black page', () => {
    const source = frameWithDarkTopRow(SMALL.width, SMALL.height);
    // 1 row of 400 is dark to begin with.
    expect(fractionDarkerThan(source, 110)).toBeCloseTo(1 / SMALL.height, 5);

    const { width, height } = warpTargetSize(COLLINEAR, SMALL);
    const out = warpPerspective(source, COLLINEAR, width, height);

    // Measured before the fix: 196×210 (a size read off a quad that has no shape)
    // and every pixel black. Now the frame comes back as it went in.
    expect(out.width).toBe(SMALL.width);
    expect(out.height).toBe(SMALL.height);
    expect(fractionDarkerThan(out, 110)).toBeCloseTo(1 / SMALL.height, 5);
    expect(Array.from(out.data)).toEqual(Array.from(source.data));
    // The same object, so no pixel was resampled at all — the convention `deskew`
    // already uses for "there was nothing safe to do here".
    expect(out).toBe(source);
  });

  it('returns the page unchanged for four coincident corners, not a 1x1 image', () => {
    const source = frameWithDarkTopRow(SMALL.width, SMALL.height);
    // Measured before the fix: `warpTargetSize` reads 1×1 off this quad and the
    // whole page became a single pixel.
    expect(warpTargetSize(COINCIDENT, SMALL)).toEqual({ width: 1, height: 1 });

    const out = warpPerspective(source, COINCIDENT, 1, 1);
    expect(out.width).toBe(SMALL.width);
    expect(out.height).toBe(SMALL.height);
    expect(out).toBe(source);
  });

  it('returns the page unchanged for a near-collinear or pinpoint quad', () => {
    const source = frameWithDarkTopRow(SMALL.width, SMALL.height);
    for (const quad of [NEARLY_COLLINEAR, PINPOINT]) {
      const { width, height } = warpTargetSize(quad, SMALL);
      const out = warpPerspective(source, quad, width, height);
      expect(out).toBe(source);
      expect(fractionDarkerThan(out, 110)).toBeCloseTo(1 / SMALL.height, 5);
    }
  });

  /**
   * The other half of the contract, and the one that decides whether this guard is
   * usable: a real page that merely *looks* extreme must still be de-warped.
   */
  it('still warps a genuinely thin page photographed at a sharp angle', () => {
    // A 2.5"×11" till receipt — the thinnest thing anyone scans — tilted, panned
    // and rolled hard enough that its projection is a long, narrow sliver.
    const receipt = 2.5 / 11;
    for (const pose of [
      { tilt: 45, pan: 25, roll: 12 },
      { tilt: 60, pan: 30, roll: -18 },
      { tilt: 70, pan: 15, roll: 5 }
    ]) {
      const quad = photograph(receipt, FRAME, pose);
      expect(isDegenerateQuad(quad, FRAME), JSON.stringify(pose)).toBe(false);

      const source = frameWithDarkTopRow(FRAME.width, FRAME.height);
      const { width, height } = warpTargetSize(quad, FRAME);
      const out = warpPerspective(source, quad, width, height);
      // Really warped: the requested size, and a new buffer rather than the input.
      expect(out).not.toBe(source);
      expect(out.width).toBe(width);
      expect(out.height).toBe(height);
    }
  });

  it('still warps every pose the aspect-ratio suite measures', () => {
    for (const { tilt } of MEASURED) {
      expect(isDegenerateQuad(photograph(LETTER, FRAME, { tilt }), FRAME), `tilt ${tilt}°`).toBe(
        false
      );
    }
    for (const pose of [
      { tilt: 20, pan: 12, roll: 6 },
      { tilt: 35, pan: 10, roll: -8 },
      { tilt: 80, pan: 20, roll: 10 }
    ]) {
      expect(isDegenerateQuad(photograph(LETTER, FRAME, pose), FRAME)).toBe(false);
    }
    // And the two shapes the editor produces deliberately.
    const whole: Quad = {
      tl: { x: 0, y: 0 },
      tr: { x: FRAME.width, y: 0 },
      br: { x: FRAME.width, y: FRAME.height },
      bl: { x: 0, y: FRAME.height }
    };
    expect(isDegenerateQuad(whole, FRAME)).toBe(false);
    const inset: Quad = {
      tl: { x: 100, y: 200 },
      tr: { x: 700, y: 200 },
      br: { x: 700, y: 1000 },
      bl: { x: 100, y: 1000 }
    };
    expect(isDegenerateQuad(inset, FRAME)).toBe(false);
  });
});

describe('de-warp end to end', () => {
  /**
   * Proves the correction on the *output pixels*, not on the reported size.
   *
   * A square is painted on the page before it is photographed. Perspective turns
   * it into a trapezoid; a correct de-warp has to turn it back into a square. Its
   * measured width÷height in the output is therefore a direct read of whether the
   * aspect correction worked, taken from the bytes `warpPerspective` produced.
   */
  function photographPageWithSquare(
    frame: { width: number; height: number },
    pose: Pose
  ): ImageData {
    const quad = photograph(LETTER, frame, pose);
    const image = new ImageData(frame.width, frame.height);
    const data = image.data;
    // Mid grey desk, so the page reads as lighter and the marker as darker.
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 90;
      data[i + 1] = 90;
      data[i + 2] = 90;
      data[i + 3] = 255;
    }

    // Page space → image space, so each pixel can be asked "what is under you".
    const toImage = (u: number, v: number) => {
      const top = {
        x: quad.tl.x + (quad.tr.x - quad.tl.x) * u,
        y: quad.tl.y + (quad.tr.y - quad.tl.y) * u
      };
      const bottom = {
        x: quad.bl.x + (quad.br.x - quad.bl.x) * u,
        y: quad.bl.y + (quad.br.y - quad.bl.y) * u
      };
      return { x: top.x + (bottom.x - top.x) * v, y: top.y + (bottom.y - top.y) * v };
    };

    // Rasterise the page as a fine grid of samples: paper white, with a square
    // marker whose side is 0.6 of the page *width* in both directions. Large,
    // because the measurement below is a bounding box and a bigger box quantises
    // to a smaller fraction of itself.
    const side = 0.6;
    const halfU = side / 2;
    const halfV = (side * LETTER) / 2; // same physical length, in page-height units
    const steps = 2400;
    for (let iy = 0; iy <= steps; iy++) {
      for (let ix = 0; ix <= steps; ix++) {
        const u = ix / steps;
        const v = iy / steps;
        const inMarker = Math.abs(u - 0.5) <= halfU && Math.abs(v - 0.5) <= halfV;
        const { x, y } = toImage(u, v);
        const px = Math.round(x);
        const py = Math.round(y);
        if (px < 0 || py < 0 || px >= frame.width || py >= frame.height) continue;
        const i = (py * frame.width + px) * 4;
        const value = inMarker ? 20 : 245;
        data[i] = value;
        data[i + 1] = value;
        data[i + 2] = value;
        data[i + 3] = 255;
      }
    }
    return image;
  }

  /** Bounding box of the dark marker in a de-warped page. */
  function markerBox(image: ImageData) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        if (image.data[(y * image.width + x) * 4] < 110) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    return { width: maxX - minX + 1, height: maxY - minY + 1 };
  }

  it('turns a square on a tilted page back into a square', () => {
    const frame = { width: 1200, height: 1600 };
    for (const pose of [
      { tilt: 20, pan: 12, roll: 6 },
      { tilt: 30, pan: 12, roll: 6 },
      { tilt: 35, pan: 10, roll: -8 }
    ]) {
      const photo = photographPageWithSquare(frame, pose);
      const quad = photograph(LETTER, frame, pose);
      const { width, height } = warpTargetSize(quad, frame);
      const corrected = warpPerspective(photo, quad, width, height);

      const box = markerBox(corrected);
      // A square marker, de-warped, is square: the tolerance is two pixels of
      // bounding-box quantisation on a ~300px marker.
      expect(box.width / box.height, `${JSON.stringify(pose)}`).toBeCloseTo(1, 1);
      expect(percentError(box.width / box.height, 1)).toBeLessThan(2);
    }
  });

  it('the old sizing would have failed the same square', () => {
    // Pins the defect itself: with the projected-edge size, the marker comes out
    // measurably non-square, so the assertion above is testing something real.
    const frame = { width: 1200, height: 1600 };
    const pose = { tilt: 30, pan: 12, roll: 6 };
    const photo = photographPageWithSquare(frame, pose);
    const quad = photograph(LETTER, frame, pose);
    const oldWidth = Math.round(
      Math.max(
        Math.hypot(quad.tr.x - quad.tl.x, quad.tr.y - quad.tl.y),
        Math.hypot(quad.br.x - quad.bl.x, quad.br.y - quad.bl.y)
      )
    );
    const oldHeight = Math.round(
      Math.max(
        Math.hypot(quad.bl.x - quad.tl.x, quad.bl.y - quad.tl.y),
        Math.hypot(quad.br.x - quad.tr.x, quad.br.y - quad.tr.y)
      )
    );
    const box = markerBox(warpPerspective(photo, quad, oldWidth, oldHeight));
    expect(percentError(box.width / box.height, 1)).toBeGreaterThan(15);
  });
});
