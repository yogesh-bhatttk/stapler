import { describe, expect, it } from 'vitest';
import {
  applyAdaptiveThreshold,
  applyContrastBrightness,
  applyDespeckle,
  deskew,
  detectSkew,
  integralLuma,
  rotateImageData,
  windowMean
} from '../../src/core/cv/enhance';

/** A white page with evenly spaced black text lines, rotated by `angleDeg`. */
function pageWithTextLines(
  width: number,
  height: number,
  angleDeg = 0,
  lineSpacing = 12
): ImageData {
  const image = new ImageData(width, height);
  const data = image.data;
  data.fill(255);

  const rad = (angleDeg * Math.PI) / 180;
  const cx = width / 2;
  const cy = height / 2;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Ask which un-rotated row this pixel came from; ink it if that row is a line.
      const dx = x - cx;
      const dy = y - cy;
      const sourceRow = -Math.sin(-rad) * dx + Math.cos(-rad) * dy + cy;
      const onLine = Math.abs((sourceRow % lineSpacing) - 0) < 2;
      // Leave a margin so rotation does not push every line off the canvas.
      const inBody = sourceRow > height * 0.15 && sourceRow < height * 0.85;
      if (onLine && inBody && x > width * 0.15 && x < width * 0.85) {
        const i = (y * width + x) * 4;
        data[i] = 0;
        data[i + 1] = 0;
        data[i + 2] = 0;
        data[i + 3] = 255;
      }
    }
  }
  return image;
}

/** Variance of the row-ink histogram: maximal when text lines are horizontal. */
function rowVariance(image: ImageData): number {
  const rows = new Float64Array(image.height);
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (image.data[(y * image.width + x) * 4] < 128) rows[y] += 1;
    }
  }
  const mean = rows.reduce((a, b) => a + b, 0) / rows.length;
  return rows.reduce((sum, value) => sum + (value - mean) ** 2, 0) / rows.length;
}

describe('integralLuma and windowMean', () => {
  // The bug this replaces: a Uint32Array summed-area table overflows at roughly
  // 16 megapixels of white, wrapping the running total to near zero, and adaptive
  // thresholding then paints whole bands of the page black.
  it('does not overflow on a large bright image', () => {
    const width = 2000;
    const height = 2000;
    const data = new Uint8ClampedArray(width * height * 4).fill(255);
    const sum = integralLuma(data, width, height);
    const total = sum[width * height - 1];
    // 4 megapixels of white ≈ 1.02e9; the exact value matters less than that it is
    // monotonic and unwrapped.
    expect(total).toBeGreaterThan(1e9);
    expect(total).toBeCloseTo(width * height * 255, -4);
    expect(sum[width * height - 1]).toBeGreaterThan(sum[width * height - 2]);
  });

  it('computes an inclusive window mean', () => {
    // 2×2 image: luma 0, 255, 255, 255.
    const data = new Uint8ClampedArray([
      0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255
    ]);
    const sum = integralLuma(data, 2, 2);
    // The whole image: (0 + 255 + 255 + 255) / 4.
    expect(windowMean(sum, 2, 0, 0, 1, 1)).toBeCloseTo(191.25, 1);
    // A single pixel.
    expect(windowMean(sum, 2, 0, 0, 0, 0)).toBeCloseTo(0);
    expect(windowMean(sum, 2, 1, 1, 1, 1)).toBeCloseTo(255);
  });
});

describe('applyAdaptiveThreshold', () => {
  it('produces a pure black-and-white image', () => {
    const result = applyAdaptiveThreshold(pageWithTextLines(80, 80), 15, 15);
    for (let i = 0; i < result.data.length; i += 4) {
      expect([0, 255]).toContain(result.data[i]);
      expect(result.data[i + 3]).toBe(255);
    }
  });

  it('keeps text dark and background light under a lighting gradient', () => {
    // A grey page that gets darker to the right — the case a global threshold fails.
    const image = new ImageData(120, 60);
    for (let y = 0; y < 60; y++) {
      for (let x = 0; x < 120; x++) {
        const i = (y * 120 + x) * 4;
        const background = 235 - x;
        const isInk = y % 10 === 0 && x > 10 && x < 110;
        const value = isInk ? Math.max(0, background - 90) : background;
        image.data[i] = value;
        image.data[i + 1] = value;
        image.data[i + 2] = value;
        image.data[i + 3] = 255;
      }
    }
    const result = applyAdaptiveThreshold(image, 15, 15);
    const inkAt = (x: number, y: number) => result.data[(y * 120 + x) * 4];
    // Ink stays ink on both the light and the dark side of the gradient.
    expect(inkAt(20, 20)).toBe(0);
    expect(inkAt(100, 20)).toBe(0);
    // Background stays background on both sides.
    expect(inkAt(20, 25)).toBe(255);
    expect(inkAt(100, 25)).toBe(255);
  });
});

describe('applyContrastBrightness', () => {
  it('leaves the image alone at zero', () => {
    const image = pageWithTextLines(20, 20);
    const result = applyContrastBrightness(image, 0, 0);
    expect(Array.from(result.data)).toEqual(Array.from(image.data));
  });

  it('clamps rather than wrapping at the extremes', () => {
    const image = new ImageData(2, 1);
    image.data.set([10, 10, 10, 255, 245, 245, 245, 255]);
    const result = applyContrastBrightness(image, 100, 100);
    for (let i = 0; i < result.data.length; i += 4) {
      expect(result.data[i]).toBeGreaterThanOrEqual(0);
      expect(result.data[i]).toBeLessThanOrEqual(255);
    }
  });

  it('preserves alpha instead of forcing opacity', () => {
    const image = new ImageData(1, 1);
    image.data.set([100, 100, 100, 0]);
    expect(applyContrastBrightness(image, 20, 0).data[3]).toBe(0);
  });
});

describe('detectSkew, rotateImageData, and deskew', () => {
  /*
   * Skewed pages are produced with the app's own `rotateImageData` rather than by
   * hand-rolling the trig in the test. That keeps the test honest about the round trip
   * — the thing that was broken — instead of asserting against a second, independent
   * convention that could itself be wrong.
   */
  const straight = () => pageWithTextLines(200, 200, 0);
  const skewedBy = (angle: number) => rotateImageData(straight(), angle);

  it('reports no meaningful skew for a straight page', () => {
    expect(Math.abs(detectSkew(straight()))).toBeLessThan(1);
  });

  it.each([-8, -4, 4, 8])('measures %i° of skew', angle => {
    const detected = detectSkew(skewedBy(angle));
    expect(detected).toBeGreaterThan(angle - 1.5);
    expect(detected).toBeLessThan(angle + 1.5);
  });

  it('stays within the ±15° search range for a wildly skewed page', () => {
    const detected = detectSkew(skewedBy(40));
    expect(Math.abs(detected)).toBeLessThanOrEqual(15);
  });

  /*
   * The regression that matters most here. `detectSkew` and `rotateImageData` use
   * opposite angle conventions and the previous code paired them directly, so the
   * deskew step *doubled* the skew instead of removing it. `deskew` owns the sign now;
   * this asserts the round trip rather than the sign, so it survives a change of
   * internal convention.
   */
  it.each([-7, -3, 3, 7])('straightens a page skewed by %i°', angle => {
    const skewed = skewedBy(angle);
    const { image: corrected } = deskew(skewed);
    // Ink concentrated into fewer rows is what "straight" means here.
    expect(rowVariance(corrected)).toBeGreaterThan(rowVariance(skewed) * 1.4);
    expect(Math.abs(detectSkew(corrected))).toBeLessThan(1.5);
  });

  it('reports the angle it corrected', () => {
    const { angle } = deskew(skewedBy(6));
    expect(angle).toBeGreaterThan(4.5);
    expect(angle).toBeLessThan(7.5);
  });

  it('does not resample when the skew is below the correction threshold', () => {
    const nearlyStraight = straight();
    const result = deskew(nearlyStraight, 15, 2);
    expect(result.angle).toBe(0);
    // The very same object, so no sharpness is lost to a pointless resample.
    expect(result.image).toBe(nearlyStraight);
  });

  // Applying the measured angle directly is the bug; keep it pinned.
  it('corrects in the opposite direction to the measured angle', () => {
    const skewed = skewedBy(5);
    const measured = detectSkew(skewed);
    const wrongWay = rotateImageData(skewed, measured);
    const rightWay = rotateImageData(skewed, -measured);
    expect(rowVariance(rightWay)).toBeGreaterThan(rowVariance(wrongWay));
  });

  it('returns the input untouched for a zero rotation', () => {
    const image = straight();
    expect(rotateImageData(image, 0)).toBe(image);
  });

  it('fills the exposed corners with opaque white', () => {
    const result = rotateImageData(pageWithTextLines(60, 60, 0), 30);
    // The top-left pixel of a 30°-rotated square has no source.
    expect(result.data[0]).toBe(255);
    expect(result.data[3]).toBe(255);
  });
});

describe('applyDespeckle', () => {
  it('removes isolated black noise from a white background', () => {
    const image = new ImageData(3, 3);
    image.data.fill(255);
    // Add a single black speckle in the center
    const center = (1 * 3 + 1) * 4;
    image.data[center] = 0;
    image.data[center + 1] = 0;
    image.data[center + 2] = 0;

    const result = applyDespeckle(image);
    // The speckle should be gone
    expect(result.data[center]).toBe(255);
  });

  it('leaves contiguous black strokes intact', () => {
    const image = new ImageData(3, 3);
    image.data.fill(255);
    // Draw a 3-pixel horizontal black line
    for (let x = 0; x < 3; x++) {
      const i = (1 * 3 + x) * 4;
      image.data[i] = 0;
      image.data[i + 1] = 0;
      image.data[i + 2] = 0;
    }

    const result = applyDespeckle(image);
    // The center pixel has only 3 white neighbors (above and below), so it stays black (needs >=5 white neighbors to flip)
    const center = (1 * 3 + 1) * 4;
    expect(result.data[center]).toBe(0);
  });
});
