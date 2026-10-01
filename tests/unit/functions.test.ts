/**
 * GAP-6 — PDF function evaluation (`pdf/functions.ts`), audit 2026-10-01
 * regressions: multilinear sampled functions (PDF-4) and PostScript programs
 * that fail at evaluation time (PDF-7).
 */
import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { parseFunction } from '../../src/core/pdf/functions';

async function context() {
  return (await PDFDocument.create()).context;
}

describe('Type 0 sampled functions', () => {
  it('PDF-4: interpolates a 2-input table bilinearly, not nearest-neighbour', async () => {
    const ctx = await context();
    // f(0,0)=0, f(1,0)=1, f(0,1)=1, f(1,1)=0 — first input varies fastest.
    const ref = ctx.register(
      ctx.stream(new Uint8Array([0, 255, 255, 0]), {
        FunctionType: 0,
        Domain: [0, 1, 0, 1],
        Range: [0, 1],
        Size: [2, 2],
        BitsPerSample: 8
      })
    );
    const fn = parseFunction(ref, ctx);
    expect(fn).not.toBeNull();
    expect(fn!.evaluate([0.5, 0.5])![0]).toBeCloseTo(0.5, 6);
    expect(fn!.evaluate([0.49, 0.49])![0]).toBeCloseTo(0.4998, 4);
    expect(fn!.evaluate([0.25, 0])![0]).toBeCloseTo(0.25, 6);
    expect(fn!.evaluate([0, 0.75])![0]).toBeCloseTo(0.75, 6);
    expect(fn!.evaluate([1, 1])![0]).toBeCloseTo(0, 6);
    // Smooth across the centre: no hard jump either side of (0.5, 0.5).
    const below = fn!.evaluate([0.499, 0.499])![0];
    const above = fn!.evaluate([0.501, 0.501])![0];
    expect(Math.abs(below - above)).toBeLessThan(0.01);
  });

  it('PDF-4: interpolates a 3-input, 2-output table trilinearly', async () => {
    const ctx = await context();
    // Output 0 = x (the first input), output 1 = z, on a 2×2×2 grid.
    const samples: number[] = [];
    for (let z = 0; z < 2; z++)
      for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) samples.push(x * 255, z * 255);
    const ref = ctx.register(
      ctx.stream(new Uint8Array(samples), {
        FunctionType: 0,
        Domain: [0, 1, 0, 1, 0, 1],
        Range: [0, 1, 0, 1],
        Size: [2, 2, 2],
        BitsPerSample: 8
      })
    );
    const out = parseFunction(ref, ctx)!.evaluate([0.3, 0.6, 0.8])!;
    expect(out[0]).toBeCloseTo(0.3, 6);
    expect(out[1]).toBeCloseTo(0.8, 6);
  });

  it('still interpolates a 1-input table linearly', async () => {
    const ctx = await context();
    const ref = ctx.register(
      ctx.stream(new Uint8Array([0, 255]), {
        FunctionType: 0,
        Domain: [0, 1],
        Range: [0, 1],
        Size: [2],
        BitsPerSample: 8
      })
    );
    expect(parseFunction(ref, ctx)!.evaluate([0.4])![0]).toBeCloseTo(0.4, 6);
  });
});

describe('Type 4 PostScript functions', () => {
  const ps = async (program: string, domain = [0, 1], range = [0, 1]) => {
    const ctx = await context();
    const ref = ctx.register(
      ctx.stream(program, { FunctionType: 4, Domain: domain, Range: range })
    );
    return parseFunction(ref, ctx);
  };

  it('PDF-7: a program that underflows its stack is refused, not evaluated to 0', async () => {
    expect(await ps('{ mul }')).toBeNull();
    expect(await ps('{ pop pop }')).toBeNull();
    expect(await ps('{ exch }')).toBeNull();
  });

  it('PDF-7: a program that underflows only for some inputs evaluates to null there', async () => {
    // At the probe (0.5) the `if` branch is skipped and the result is 0.5;
    // below 0.25 it runs `mul` on a one-element stack.
    const fn = await ps('{ dup 0.25 lt { pop mul } if }');
    expect(fn).not.toBeNull();
    expect(fn!.evaluate([0.5])).toEqual([0.5]);
    expect(fn!.evaluate([0.1])).toBeNull();
  });

  it('PDF-7: a non-finite result is null, not a clipped guess', async () => {
    const fn = await ps('{ 0.5 sub ln }');
    expect(fn).not.toBeNull(); // ln(0) at the probe is -Infinity… still parsed
    expect(fn!.evaluate([0.2])).toBeNull(); // ln of a negative is NaN
  });

  it('evaluates a well-formed tint transform', async () => {
    const fn = await ps('{ 1 exch sub }');
    expect(fn!.evaluate([0.25])![0]).toBeCloseTo(0.75, 6);
  });
});
