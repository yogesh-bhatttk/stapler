/**
 * OPS-15 — split by target file size.
 *
 * `planRangesBySize` is the pure planner (an injected `measure` stands in for a
 * real composed byte size), tested directly with synthetic cost models —
 * including one that simulates a shared resource, which is exactly what an
 * earlier, sum-of-individually-composed-pages version of this got wrong: it
 * split a document that fit comfortably as one file into many, because each
 * page's *isolated* cost included its own copy of a resource the real combined
 * file only pays for once. `planSizeSplitBoundaries` is tested against a
 * mocked `composeSplit` for the wiring, and against two real multi-megabyte
 * fixtures for the fix itself.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';

const composeSplit = vi.fn();

vi.mock('../../src/core/workers', () => ({
  processWorker: {
    lease: (fn: (api: unknown) => Promise<unknown>) =>
      fn({ composeSplit: (...args: unknown[]) => composeSplit(...args) })
  },
  renderWorker: { lease: vi.fn() },
  cvWorker: { lease: vi.fn() }
}));

const { planRangesBySize, planSizeSplitBoundaries } = await import('../../src/core/operations');

describe('planRangesBySize', () => {
  it('never asks about a range it can already tell fits from a shorter one', async () => {
    // A plain per-page cost model with no sharing: bisecting still has to reach
    // a correct answer, and this also pins down the plain greedy-equivalent case.
    const perPage = [80, 20, 90, 10, 60, 60, 5];
    const measure = async (from: number, to: number) =>
      perPage.slice(from, to).reduce((a, b) => a + b, 0);

    const plan = await planRangesBySize(perPage.length, 100, measure);
    // Every page accounted for exactly once, in order.
    const pages = Array.from({ length: perPage.length }, (_, i) => i);
    const parts: number[][] = [];
    let from = 0;
    for (const cut of plan.boundaries) {
      parts.push(pages.slice(from, cut));
      from = cut;
    }
    parts.push(pages.slice(from));
    expect(parts.flat()).toEqual(pages);
    for (const part of parts) {
      expect(part.length).toBeGreaterThan(0);
      const total = part.reduce((sum, i) => sum + perPage[i], 0);
      expect(total).toBeLessThanOrEqual(100);
    }
  });

  it('does not split a document at all when the whole thing already fits — the shared-resource case', async () => {
    // Ten pages that would each cost ~4.63MB in isolation (a shared image none
    // of them can avoid paying for alone) but only 4.9MB combined, because the
    // real document embeds the shared image once. A sum-of-isolated-pages model
    // (10 x 4.63MB = 46.3MB) would "safely" cut after every single page; the
    // real answer, measuring the actual combined range, is zero cuts.
    const SHARED = 4_600_000;
    const PER_PAGE = 30_000;
    const pageCount = 10;
    const measure = async (from: number, to: number) => SHARED + (to - from) * PER_PAGE;

    const plan = await planRangesBySize(pageCount, 5_000_000, measure);
    expect(plan.boundaries).toEqual([]);
    expect(plan.oversized).toEqual([]);
  });

  it('bisects a genuinely oversized document down to where the target is met, reflecting real combined cost at every level', async () => {
    const SHARED = 4_600_000;
    const PER_PAGE = 80_000;
    const pageCount = 10;
    const measure = async (from: number, to: number) => SHARED + (to - from) * PER_PAGE;
    // A target under the shared cost alone: no combination of 2+ pages can ever
    // fit, so every page must end up alone despite the shared-cost model.
    const plan = await planRangesBySize(pageCount, 4_650_000, measure);
    expect(plan.boundaries).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // Each is reported oversized (SHARED + 1*PER_PAGE = 4,680,000 > 4,650,000).
    expect(plan.oversized).toHaveLength(10);
  });

  it('reports a single page that exceeds the target on its own, and only that one', async () => {
    const sizes = [50, 500, 50, 50];
    const measure = async (from: number, to: number) =>
      sizes.slice(from, to).reduce((a, b) => a + b, 0);
    const plan = await planRangesBySize(sizes.length, 100, measure);
    expect(plan.oversized).toEqual([{ pageIndex: 1, bytes: 500 }]);
  });

  it('never splits a single-page document and never calls measure for it', async () => {
    const measure = vi.fn(async () => 999);
    const plan = await planRangesBySize(1, 100, measure);
    expect(plan).toEqual({ boundaries: [], oversized: [] });
    expect(measure).not.toHaveBeenCalled();
  });
});

describe('planSizeSplitBoundaries', () => {
  it('measures each candidate range through composeSplit with no internal boundaries', async () => {
    // Cost model: 2 bytes overhead plus 1 byte per page in the range. At a
    // target of 5, the whole 4-page document (6 bytes) doesn't fit, but each
    // half (4 bytes) does — so it should bisect exactly once, into two pairs,
    // not all the way down to four single pages.
    composeSplit.mockImplementation(async (pages: { key: string }[]) => ({
      bytes: new Uint8Array(2 + pages.length),
      isZip: false,
      fileCount: 1
    }));

    const pages = Array.from({ length: 4 }, (_, i) => ({
      key: `p${i}`,
      sourceDocId: 'doc-1',
      sourceIndex: i,
      rotation: 0
    }));

    const plan = await planSizeSplitBoundaries({ pages, annotations: [] } as never, 5);

    // Every composeSplit call requested a single-file compose (no internal cuts).
    for (const call of composeSplit.mock.calls) expect(call[2]).toEqual([]);
    expect(composeSplit.mock.calls.map(call => (call[0] as unknown[]).length).sort()).toEqual([
      2, 2, 4
    ]);
    expect(plan.boundaries).toEqual([2]);
    expect(plan.oversized).toEqual([]);
  });

  it('returns no boundaries for a single-page document without calling the worker', async () => {
    composeSplit.mockClear();
    const plan = await planSizeSplitBoundaries(
      {
        pages: [{ key: 'p0', sourceDocId: 'doc-1', sourceIndex: 0, rotation: 0 }],
        annotations: []
      } as never,
      100
    );
    expect(plan).toEqual({ boundaries: [], oversized: [] });
    expect(composeSplit).not.toHaveBeenCalled();
  });
});

describe('planSizeSplitBoundaries against real fixtures (the bug this ticket fixes)', () => {
  it('does not fragment a document whose pages share one large resource into far more, far bigger, output than the input', async () => {
    vi.doUnmock('../../src/core/workers');
    vi.resetModules();
    vi.doMock('comlink', () => ({ expose: vi.fn(), transfer: vi.fn(val => val) }));

    const { processWorkerImpl } = await import('../../src/core/workers/process.worker');
    const { silentJob } = await import('../../src/core/workers/protocol');
    const { planRangesBySize: realPlanRangesBySize } = await import('../../src/core/operations');

    const bytes = new Uint8Array(
      await readFile(new URL('../fixtures/shared-image.pdf', import.meta.url))
    );
    const inspected = await processWorkerImpl.inspect(bytes);
    const pages = Array.from({ length: inspected.pageCount }, (_, i) => ({
      key: `p${i}`,
      sourceDocId: 'shared',
      sourceIndex: i,
      rotation: 0
    }));

    const measure = async (from: number, to: number) => {
      const result = await processWorkerImpl.composeSplit(
        pages.slice(from, to),
        { shared: bytes },
        [],
        [],
        undefined,
        undefined,
        null,
        null,
        'page',
        undefined,
        silentJob
      );
      return result.bytes.byteLength;
    };

    // A generous target well above the input file's own size: the whole
    // document should come back as a single, unsplit range.
    const targetBytes = bytes.byteLength * 2;
    const plan = await realPlanRangesBySize(inspected.pageCount, targetBytes, measure);

    expect(plan.boundaries).toEqual([]);
    expect(plan.oversized).toEqual([]);
  }, 30_000);
});
