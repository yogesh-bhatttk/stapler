import { describe, it, expect } from 'vitest';
import { diffText } from '../../src/core/diff';
import { pixelDiff } from '../../src/core/pixel-diff';

describe('Text Diff', () => {
  it('identifies identical text', () => {
    const res = diffText('hello world', 'hello world');
    expect(res).toEqual([
      { op: 'equal', text: 'hello' },
      { op: 'equal', text: 'world' }
    ]);
  });

  it('identifies additions', () => {
    const res = diffText('hello', 'hello world');
    expect(res).toEqual([
      { op: 'equal', text: 'hello' },
      { op: 'insert', text: 'world' }
    ]);
  });

  it('identifies deletions', () => {
    const res = diffText('hello world', 'hello');
    expect(res).toEqual([
      { op: 'equal', text: 'hello' },
      { op: 'delete', text: 'world' }
    ]);
  });

  it('identifies changes', () => {
    const res = diffText('hello world', 'hello there');
    expect(res).toEqual([
      { op: 'equal', text: 'hello' },
      { op: 'insert', text: 'there' },
      { op: 'delete', text: 'world' }
    ]);
  });
});

describe('Pixel Diff', () => {
  it('highlights completely different pixels in red', () => {
    // 2x1 image
    const img1 = new ImageData(
      new Uint8ClampedArray([
        255,
        255,
        255,
        255, // white
        0,
        0,
        0,
        255 // black
      ]),
      2,
      1
    );

    const img2 = new ImageData(
      new Uint8ClampedArray([
        255,
        255,
        255,
        255, // white (match)
        255,
        255,
        255,
        255 // white (differs from black)
      ]),
      2,
      1
    );

    // sensitivity 10 => low threshold, small differences get flagged
    const out = pixelDiff(img1, img2, 10);

    // First pixel matches perfectly -> transparent
    expect(out.data[0]).toBe(0);
    expect(out.data[1]).toBe(0);
    expect(out.data[2]).toBe(0);
    expect(out.data[3]).toBe(0);

    // Second pixel differs -> red
    expect(out.data[4]).toBe(255);
    expect(out.data[5]).toBe(0);
    expect(out.data[6]).toBe(0);
    expect(out.data[7]).toBe(255);
  });
});
