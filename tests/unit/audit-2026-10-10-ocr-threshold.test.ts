/**
 * Audit 2026-10-10 CV10 — OCR cleanup's adaptive threshold hollowed big grey
 * headings. Reproduced on a synthetic 300 DPI page: a 60 pt bold heading's
 * strokes are ~37 px thick, wider than the 25 px window, so their insides
 * compared with themselves and turned white. Fixed by the stroke fill, which
 * must not turn a lighting shadow black.
 */
import { describe, expect, it } from 'vitest';
import { applyAdaptiveThreshold, OCR_STROKE_FILL } from '../../src/core/cv/enhance';

const W = 900;
const H = 500;
const GREY = 128;
const SHADOW = 150;

/** White page; a grey "H" with 40 px strokes; a 450 px-wide shadow on the right, hard-edged. */
function page(): ImageData {
  const image = new ImageData(W, H);
  const d = image.data;
  const set = (x: number, y: number, v: number) => {
    const i = (y * W + x) * 4;
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) set(x, y, x >= 450 ? SHADOW : 255);
  const rect = (x0: number, y0: number, w: number, h: number, v: number) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) set(x, y, v);
  };
  // "H": verticals at x 60..100 and 220..260, crossbar y 230..270, height 250.
  rect(60, 120, 40, 250, GREY);
  rect(220, 120, 40, 250, GREY);
  rect(100, 230, 120, 40, GREY);
  // Body text in the shadow: 3 px black strokes.
  for (let k = 0; k < 6; k++) rect(500 + k * 30, 300, 3, 30, 0);
  return image;
}

const black = (img: ImageData, x: number, y: number) => img.data[(y * W + x) * 4] === 0;

describe('CV10 — large grey headings survive OCR cleanup', () => {
  it('premise: the 25 px window alone hollows a 40 px grey stroke', () => {
    const out = applyAdaptiveThreshold(page(), 25, 10);
    expect(black(out, 80, 200)).toBe(false); // the middle of the left stroke
    expect(black(out, 61, 200)).toBe(true); // only its edge is kept
  });

  it('keeps the stroke solid with the stroke fill, and leaves paper and shadow white', () => {
    const out = applyAdaptiveThreshold(page(), 25, 10, OCR_STROKE_FILL);
    // Inside every stroke of the H.
    for (const [x, y] of [
      [80, 200],
      [240, 300],
      [160, 250],
      [80, 140]
    ]) {
      expect(black(out, x, y)).toBe(true);
    }
    let hollow = 0;
    for (let y = 125; y < 365; y++) for (let x = 65; x < 95; x++) if (!black(out, x, y)) hollow++;
    expect(hollow).toBe(0);
    // The paper inside the H's counters stays white.
    expect(black(out, 160, 160)).toBe(false);
    expect(black(out, 160, 330)).toBe(false);
    // The shadow's interior is not ink, and the text inside it still is.
    expect(black(out, 700, 100)).toBe(false);
    expect(black(out, 800, 450)).toBe(false);
    expect(black(out, 501, 310)).toBe(true);
    // Away from its edge, no band of the shadow was filled.
    let filled = 0;
    for (let y = 0; y < H; y++) for (let x = 480; x < W; x++) if (black(out, x, y)) filled++;
    expect(filled).toBeLessThan(6 * 3 * 30 * 2);
  });
});
