import { describe, it, expect } from 'vitest';
import { diffText } from '../../src/core/diff';
import { pixelDiff } from '../../src/core/pixel-diff';

describe('diffText', () => {
  it('identifies equal, inserted, and deleted words', () => {
    const oldText = 'hello world this is a test';
    const newText = 'hello brave new world this is a wonderful test';

    const chunks = diffText(oldText, newText);
    expect(chunks).toEqual([
      { op: 'equal', text: 'hello' },
      { op: 'insert', text: 'brave' },
      { op: 'insert', text: 'new' },
      { op: 'equal', text: 'world' },
      { op: 'equal', text: 'this' },
      { op: 'equal', text: 'is' },
      { op: 'equal', text: 'a' },
      { op: 'insert', text: 'wonderful' },
      { op: 'equal', text: 'test' }
    ]);
  });

  it('handles completely different text', () => {
    const chunks = diffText('one two', 'three four');
    expect(chunks).toEqual([
      { op: 'insert', text: 'three' },
      { op: 'insert', text: 'four' },
      { op: 'delete', text: 'one' },
      { op: 'delete', text: 'two' }
    ]);
  });

  it('handles completely identical text', () => {
    const chunks = diffText('one two', 'one two');
    expect(chunks).toEqual([
      { op: 'equal', text: 'one' },
      { op: 'equal', text: 'two' }
    ]);
  });
});

describe('pixelDiff', () => {
  it('flags pixels exceeding threshold sensitivity', () => {
    const img1 = new ImageData(
      new Uint8ClampedArray([
        255,
        255,
        255,
        255, // white
        0,
        0,
        0,
        255, // black
        100,
        100,
        100,
        255, // gray
        255,
        0,
        0,
        255 // red
      ]),
      2,
      2
    );

    const img2 = new ImageData(
      new Uint8ClampedArray([
        255,
        255,
        255,
        255, // white (match)
        10,
        10,
        10,
        255, // near black (should pass if sensitivity > threshold)
        200,
        200,
        200,
        255, // light gray (should fail)
        0,
        255,
        0,
        255 // green (fail)
      ]),
      2,
      2
    );

    // sensitivity 50% => threshold 765 * 0.5 = 382.5
    // pixel 0 diff = 0
    // pixel 1 diff = 30 < 382.5 -> match
    // pixel 2 diff = 300 < 382.5 -> match
    // pixel 3 diff = 255 + 255 = 510 > 382.5 -> fail
    const diff50 = pixelDiff(img1, img2, 50);
    expect(Array.from(diff50.data)).toEqual([
      0,
      0,
      0,
      0, // match -> transparent
      0,
      0,
      0,
      0, // match -> transparent
      0,
      0,
      0,
      0, // match -> transparent
      255,
      0,
      0,
      255 // fail -> red
    ]);

    // sensitivity 0% => threshold 765, so this intentionally hides all
    // differences; raising sensitivity makes the comparison stricter.
    const diff0 = pixelDiff(img1, img2, 0);
    expect(Array.from(diff0.data)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

    const diff100 = pixelDiff(img1, img2, 100);
    expect(Array.from(diff100.data)).toEqual([
      0, 0, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255
    ]);
  });

  it('rejects images with different dimensions', () => {
    expect(() => pixelDiff(new ImageData(2, 2), new ImageData(1, 4), 50)).toThrow(
      'different dimensions'
    );
  });
});
