/**
 * HRD-24 §12.11 (AUDIT-FINDINGS §12) — the annotation-summary export runs as a
 * `useJob` job like every other export: determinate progress, cancellable, and
 * a cancel produces no file.
 *
 * The PDF is built in the process worker (`workers/annotation-summary-pdf.ts`),
 * not on the main thread: `exportAnnotationSummary` only leases the worker and
 * hands it a job handle. Here the pool is replaced by the real worker
 * implementation called in-process (Comlink's proxy is the identity), so what
 * is graded is the real worker code driven through the real job protocol.
 * The card loop checks the job every 30 ms; `performance.now` is stepped so
 * every card crosses a slice boundary, which makes the progress sequence and
 * the cancel point deterministic.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import type { SummaryAnnotation } from '../../src/core/annotation-summary';

vi.mock('comlink', () => ({
  expose: vi.fn(),
  transfer: vi.fn(value => value),
  proxy: vi.fn(value => value)
}));
const lease = vi.fn();
vi.mock('../../src/core/workers', async () => {
  const { processWorkerImpl } = await import('../../src/core/workers/process.worker');
  // `any`: stands in for the pool's `Comlink.Remote<T>` wrapper.
  const run = (fn: (api: any) => unknown) => {
    lease();
    return fn(processWorkerImpl);
  };
  return { processWorker: { lease: run, pin: () => ({ lease: run, release: () => {} }) } };
});

const { exportAnnotationSummary } = await import('../../src/core/annotation-summary');
const { isCancellation } = await import('../../src/core/errors');

const doc = {
  name: 'contract.pdf',
  pages: [{ key: 'p1' }, { key: 'p2' }]
};

const notes: SummaryAnnotation[] = Array.from({ length: 40 }, (_, i) => ({
  id: `n${i}`,
  type: 'sticky',
  text: `Note ${i}: ${'lorem ipsum '.repeat(20)}`,
  pageKey: i % 2 === 0 ? 'p1' : 'p2',
  rect: { x: 0.1, y: i / 40, width: 0.1, height: 0.1 }
}));

/** Every call to `performance.now()` advances 31 ms: each card starts a new slice. */
function steppedClock() {
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => (now += 31));
}

describe('annotation summary export as a job (HRD-24 §12.11)', () => {
  it('reports determinate, monotonic progress from 0 to 1', async () => {
    steppedClock();
    const reports: (number | null)[] = [];
    const labels = new Set<string>();
    const bytes = await exportAnnotationSummary(doc, notes, {
      onProgress: (fraction, label) => {
        reports.push(fraction);
        labels.add(label);
      }
    });

    expect(reports.length).toBeGreaterThan(notes.length / 2);
    expect(reports.every(f => typeof f === 'number')).toBe(true);
    expect(reports[0]).toBe(0);
    expect(reports.at(-1)).toBe(1);
    for (let i = 1; i < reports.length; i++) {
      expect(reports[i]!).toBeGreaterThanOrEqual(reports[i - 1]!);
    }
    expect([...labels]).toContain('Laying out note 2 of 40');
    // The output is still the full summary.
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBeGreaterThan(1);
  });

  it('cancels mid-layout: throws a cancellation, no bytes, no further progress', async () => {
    steppedClock();
    const controller = new AbortController();
    const reports: (number | null)[] = [];
    const result = exportAnnotationSummary(doc, notes, {
      signal: controller.signal,
      onProgress: fraction => {
        reports.push(fraction);
        if (reports.length === 5) controller.abort();
      }
    });
    const error = await result.then(
      () => null,
      (err: unknown) => err
    );
    expect(error).not.toBeNull();
    expect(isCancellation(error)).toBe(true);
    // Stopped at the next check after the abort, well before the end.
    expect(reports).toHaveLength(5);
    expect(reports.at(-1)!).toBeLessThan(0.85);
  });

  it('an abort before it starts does no work at all', async () => {
    const controller = new AbortController();
    controller.abort();
    const onProgress = vi.fn();
    await expect(
      exportAnnotationSummary(doc, notes, { signal: controller.signal, onProgress })
    ).rejects.toSatisfy(isCancellation);
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('builds the PDF in the process worker, not on the main thread', async () => {
    lease.mockClear();
    const bytes = await exportAnnotationSummary(doc, notes.slice(0, 3));
    expect(lease).toHaveBeenCalledTimes(1);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);

    // The main-thread module carries no PDF building of its own.
    const main = readFileSync(
      new URL('../../src/core/annotation-summary.ts', import.meta.url),
      'utf8'
    );
    expect(main).not.toMatch(/from 'pdf-lib'/);
    const worker = readFileSync(
      new URL('../../src/core/workers/process.worker.ts', import.meta.url),
      'utf8'
    );
    expect(worker).toMatch(/\.\.\.annotationSummaryApi/);
  });

  it('AnnotatePanel runs it through useJob, passing the job on', () => {
    const source = readFileSync(
      new URL('../../src/ui/tools/annotate/AnnotatePanel.tsx', import.meta.url),
      'utf8'
    );
    const handler = source.slice(
      source.indexOf('const handleExportSummary'),
      source.indexOf('const highlightMatches')
    );
    expect(handler).toMatch(/return run\(\s*\{[^}]*scope: 'annotate\.summary'/);
    expect(handler).toMatch(/exportAnnotationSummary\(current, combined, job\)/);
    // No private try/catch: errors and cancellation are useJob's to report.
    expect(handler).not.toMatch(/\bcatch\b/);
  });
});
