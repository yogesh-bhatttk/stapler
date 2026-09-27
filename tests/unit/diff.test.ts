import { describe, it, expect } from 'vitest';
import { coarseDiff, diffText, type DiffChunk } from '../../src/core/diff';
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

/**
 * CONV-14 — the word diff is Myers O((N+M)·D) now, not an (n+1)×(m+1) table.
 * These pin down that it is still a *minimal* diff (checked against a brute
 * LCS on random inputs), that it reconstructs both sides exactly, and that
 * large near-identical documents — which the old cap sent to the coarse
 * fallback — now get a precise diff quickly.
 */
describe('Text Diff — Myers (CONV-14)', () => {
  const lcsLength = (a: string[], b: string[]) => {
    const row = new Array(b.length + 1).fill(0);
    for (let i = 1; i <= a.length; i++) {
      let diag = 0;
      for (let j = 1; j <= b.length; j++) {
        const up = row[j];
        row[j] = a[i - 1] === b[j - 1] ? diag + 1 : Math.max(row[j], row[j - 1]);
        diag = up;
      }
    }
    return row[b.length];
  };
  const rebuild = (chunks: DiffChunk[], side: 'old' | 'new') =>
    chunks
      .filter(c => c.op === 'equal' || c.op === (side === 'old' ? 'delete' : 'insert'))
      .map(c => c.text);

  it('is minimal and reconstructs both sides on random inputs', () => {
    let seed = 12345;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let t = 0; t < 200; t++) {
      const vocab = 1 + Math.floor(rand() * 6);
      const word = () => `w${Math.floor(rand() * vocab)}`;
      const a = Array.from({ length: Math.floor(rand() * 30) }, word);
      const b = Array.from({ length: Math.floor(rand() * 30) }, word);
      const chunks = diffText(a.join(' '), b.join(' '));
      expect(rebuild(chunks, 'old')).toEqual(a);
      expect(rebuild(chunks, 'new')).toEqual(b);
      expect(chunks.filter(c => c.op === 'equal')).toHaveLength(lcsLength(a, b));
    }
  });

  it('diffs 50,000-word near-identical documents precisely and fast', () => {
    const words = Array.from({ length: 50_000 }, (_, i) => `w${i % 997}x${i}`);
    const edited = [...words];
    edited[10_000] = 'CHANGED';
    edited.splice(30_000, 0, 'ADDED');
    edited.splice(45_000, 1);
    const t = performance.now();
    const chunks = diffText(words.join(' '), edited.join(' '));
    expect(performance.now() - t).toBeLessThan(1500);
    const changes = chunks.filter(c => c.op !== 'equal');
    expect(changes).toEqual([
      { op: 'insert', text: 'CHANGED' },
      { op: 'delete', text: words[10_000] },
      { op: 'insert', text: 'ADDED' },
      { op: 'delete', text: words[44_999] }
    ]);
  });

  it('falls back to the coarse diff when the texts differ too much, still exact', () => {
    const a = Array.from({ length: 6000 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 6000 }, (_, i) => `b${i}`);
    const t = performance.now();
    const chunks = diffText(a.join(' '), b.join(' '));
    expect(performance.now() - t).toBeLessThan(1500);
    expect(rebuild(chunks, 'old')).toEqual(a);
    expect(rebuild(chunks, 'new')).toEqual(b);
    expect(chunks).toEqual(coarseDiff(a, b));
  });

  it('handles empty sides', () => {
    expect(diffText('', '')).toEqual([]);
    expect(diffText('', 'a b')).toEqual([
      { op: 'insert', text: 'a' },
      { op: 'insert', text: 'b' }
    ]);
    expect(diffText('a', '')).toEqual([{ op: 'delete', text: 'a' }]);
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
