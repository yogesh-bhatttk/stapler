import { describe, expect, it } from 'vitest';
import {
  measureRectsBlacked,
  paintRectsBlack,
  BLACKOUT_LEVEL_TOLERANCE
} from '../../src/core/pdf/image-redaction';

/** A 4x4 RGBA image where every pixel is a distinct, non-black colour. */
function swatch(width = 4, height = 4) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    rgba[p * 4] = 10 + p;
    rgba[p * 4 + 1] = 100;
    rgba[p * 4 + 2] = 200;
    rgba[p * 4 + 3] = 255;
  }
  return { rgba, width, height };
}

const isBlack = (rgba: Uint8ClampedArray, p: number) =>
  rgba[p * 4] === 0 && rgba[p * 4 + 1] === 0 && rgba[p * 4 + 2] === 0 && rgba[p * 4 + 3] === 255;

describe('paintRectsBlack (RED-02)', () => {
  it('blacks out the top half for a rect in the upper half of the unit square', () => {
    // Unit space y runs *up* from the bottom, so y 0.5..1 is the top of the image
    // — rows 0 and 1. Getting this flip wrong destroys the wrong half and leaves
    // the marked content readable.
    const image = swatch();
    paintRectsBlack(image, [{ x: 0, y: 0.5, width: 1, height: 0.5 }]);
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 4; col++) {
        expect(isBlack(image.rgba, row * 4 + col)).toBe(row < 2);
      }
    }
  });

  it('blacks out a corner without touching the rest', () => {
    const image = swatch();
    // Left half, bottom half → rows 2-3, columns 0-1.
    paintRectsBlack(image, [{ x: 0, y: 0, width: 0.5, height: 0.5 }]);
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 4; col++) {
        expect(isBlack(image.rgba, row * 4 + col)).toBe(row >= 2 && col < 2);
      }
    }
  });

  it('rounds outwards, so a partly covered pixel is fully destroyed', () => {
    const image = swatch();
    // A sliver covering a tenth of the first column and the top tenth row.
    paintRectsBlack(image, [{ x: 0, y: 0.9, width: 0.1, height: 0.1 }]);
    expect(isBlack(image.rgba, 0)).toBe(true);
    expect(isBlack(image.rgba, 1)).toBe(false);
    expect(isBlack(image.rgba, 4)).toBe(false);
  });

  it('clips a rect that runs past the edge instead of writing out of bounds', () => {
    const image = swatch();
    paintRectsBlack(image, [{ x: -5, y: -5, width: 20, height: 20 }]);
    for (let p = 0; p < 16; p++) expect(isBlack(image.rgba, p)).toBe(true);
  });

  it('makes the soft mask opaque so the mark cannot be masked away again', () => {
    const image = { ...swatch(), mask: new Uint8Array(16) };
    paintRectsBlack(image, [{ x: 0, y: 0.5, width: 1, height: 0.5 }]);
    expect([...image.mask.slice(0, 8)]).toEqual(Array(8).fill(255));
    expect([...image.mask.slice(8)]).toEqual(Array(8).fill(0));
  });
});

/**
 * RED-03 — the same geometry read back, which is the only check in the
 * verification gate that can see *underneath* the cover rectangle.
 *
 * Grading the rendered page cannot: an intact image under an opaque black
 * rectangle renders as solid black and measures as perfectly clean. Grading the
 * text layer cannot either — a photograph has none. So for a redaction over an
 * image this measurement is the whole of the proof, which is why it is tested
 * against the painter it mirrors rather than on its own.
 */
describe('measureRectsBlacked (RED-03)', () => {
  /** A larger swatch, so the measurement's edge inset leaves something to grade. */
  function photo(width = 40, height = 40) {
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let p = 0; p < width * height; p++) {
      rgba[p * 4] = 200;
      rgba[p * 4 + 1] = 150;
      rgba[p * 4 + 2] = 100;
      rgba[p * 4 + 3] = 255;
    }
    return { rgba, width, height };
  }

  const RECT = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 };

  it('reports the covered area as clean once the painter has run', () => {
    const image = photo();
    paintRectsBlack(image, [RECT]);
    const residue = measureRectsBlacked(image, [RECT]);
    expect(residue.sampled).toBeGreaterThan(100);
    expect(residue.offBlack).toBe(0);
    expect(residue.fraction).toBe(0);
    expect(residue.maxLevel).toBe(0);
  });

  it('reports the whole covered area as content when the painter never ran', () => {
    // The failure this exists for: the page was covered by a rectangle and the
    // image left intact, so the render looks perfect and `pdfimages` gets the
    // original straight back out.
    const residue = measureRectsBlacked(photo(), [RECT]);
    expect(residue.sampled).toBeGreaterThan(100);
    expect(residue.offBlack).toBe(residue.sampled);
    expect(residue.fraction).toBe(1);
    expect(residue.maxLevel).toBe(200);
  });

  it('catches a blackout that covered only half of what the mark asked for', () => {
    const image = photo();
    paintRectsBlack(image, [{ ...RECT, width: RECT.width / 2 }]);
    const residue = measureRectsBlacked(image, [RECT]);
    expect(residue.fraction).toBeGreaterThan(0.4);
    expect(residue.fraction).toBeLessThan(0.6);
  });

  it('grades only the marked area, not the content the user kept', () => {
    // The whole image is bright except the marked square, which was painted. If
    // measurement sampled outside the mark this would read as a failure — and a
    // correct redaction would be refused, which is as harmful as passing a bad one.
    const image = photo();
    paintRectsBlack(image, [RECT]);
    expect(measureRectsBlacked(image, [RECT]).fraction).toBe(0);
  });

  it('rounds inwards, the opposite of the painter, so a boundary pixel is never graded', () => {
    // `paintRectsBlack` rounds outwards: its last painted row is only partly
    // inside the mark. Sampling that row would grade JPEG smear and kept content
    // as residue.
    const image = photo(40, 40);
    // A mark whose edges fall mid-pixel in both directions.
    const rect = { x: 0.2513, y: 0.2513, width: 0.4974, height: 0.4974 };
    paintRectsBlack(image, [rect]);
    expect(measureRectsBlacked(image, [rect]).fraction).toBe(0);
  });

  it('forgives JPEG ringing inside the painted area but not real content', () => {
    const image = photo();
    paintRectsBlack(image, [RECT]);
    // Ringing lifts the black off zero by a few levels.
    for (let p = 0; p < image.width * image.height; p++) {
      if (image.rgba[p * 4] === 0) image.rgba[p * 4] = BLACKOUT_LEVEL_TOLERANCE - 4;
    }
    expect(measureRectsBlacked(image, [RECT]).fraction).toBe(0);

    for (let p = 0; p < image.width * image.height; p++) {
      if (image.rgba[p * 4] === BLACKOUT_LEVEL_TOLERANCE - 4) image.rgba[p * 4] = 90;
    }
    expect(measureRectsBlacked(image, [RECT]).fraction).toBe(1);
  });

  it('reports nothing sampled for a rect too small to hold anything', () => {
    const residue = measureRectsBlacked(photo(), [{ x: 0, y: 0, width: 0.01, height: 0.01 }]);
    expect(residue.sampled).toBe(0);
    expect(residue.fraction).toBe(0);
  });

  it('counts a pixel covered by two overlapping marks once', () => {
    const image = photo();
    const a = { x: 0.1, y: 0.1, width: 0.5, height: 0.5 };
    const b = { x: 0.2, y: 0.2, width: 0.5, height: 0.5 };
    const both = measureRectsBlacked(image, [a, b]);
    const union = measureRectsBlacked(image, [a]).sampled + measureRectsBlacked(image, [b]).sampled;
    expect(both.sampled).toBeLessThan(union);
  });

  it('grades a shaped mark inside its shape, not its bounding box', () => {
    // RED-07: the corners of the box the polygon never covered hold content the
    // user kept, and grading them would fail a correct shaped redaction.
    const image = photo(60, 60);
    const shaped = {
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      polygon: [
        { x: 0.5, y: 0.95 },
        { x: 0.95, y: 0.5 },
        { x: 0.5, y: 0.05 },
        { x: 0.05, y: 0.5 }
      ]
    };
    paintRectsBlack(image, [shaped]);
    const residue = measureRectsBlacked(image, [shaped]);
    expect(residue.sampled).toBeGreaterThan(100);
    expect(residue.fraction).toBe(0);
  });
});
