import { describe, expect, it } from 'vitest';
import { paintRectsBlack } from '../../src/core/pdf/image-redaction';

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
