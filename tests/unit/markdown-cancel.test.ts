/**
 * CONV-12 remainder — Markdown→PDF is cancellable, reports determinate
 * progress, and the emphasis bomb no longer stalls the worker.
 *
 *  • `'*a '` × 10,000 (30 KB) used to take ~11.6 s inside one synchronous
 *    `marked.lexer` call (× 20,000: 47 s), during which nothing could cancel
 *    it. The inline pass is now per block with checkpoints between blocks, and
 *    a block with more than MAX_INLINE_EMPHASIS_DELIMITERS markers has them
 *    drawn literally — and says so.
 *  • The job handle is honoured: progress is monotonic 0 → 1, and an abort
 *    mid-conversion rejects with UserCancelled.
 */
import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
  literalEmphasisNote,
  markdownToPdfBytes,
  MAX_INLINE_EMPHASIS_DELIMITERS
} from '../../src/core/markdown-to-pdf';
import type { JobPort } from '../../src/core/workers/protocol';

function recordingJob(cancelAfter = Infinity): JobPort & { fractions: number[] } {
  const fractions: number[] = [];
  return {
    fractions,
    progress(fraction) {
      if (fraction !== null) fractions.push(fraction);
    },
    cancelled() {
      return fractions.length >= cancelAfter;
    }
  };
}

describe('CONV-12: Markdown→PDF emphasis bomb, cancel and progress', () => {
  it('converts the audit emphasis bomb quickly, with a note, into a real PDF', async () => {
    const t = performance.now();
    const result = await markdownToPdfBytes('*a '.repeat(10_000));
    expect(performance.now() - t).toBeLessThan(3000);
    expect(result.notes).toContain(literalEmphasisNote(1));
    const doc = await PDFDocument.load(result.bytes);
    expect(doc.getPageCount()).toBeGreaterThan(1);
  });

  it('handles the underscore and strikethrough variants the same way', async () => {
    for (const bomb of ['_a '.repeat(10_000), '~a '.repeat(10_000)]) {
      const t = performance.now();
      const { notes } = await markdownToPdfBytes(bomb);
      expect(performance.now() - t).toBeLessThan(3000);
      expect(notes).toContain(literalEmphasisNote(1));
    }
  });

  it('leaves ordinary emphasis alone, and counts only the offending blocks', async () => {
    const normal = 'Some *emphasis*, **strong** and ~~struck~~ text.\n\n';
    expect((await markdownToPdfBytes(normal.repeat(50))).notes).toEqual([]);
    const underLimit = '*a* '.repeat(MAX_INLINE_EMPHASIS_DELIMITERS / 2);
    expect((await markdownToPdfBytes(underLimit)).notes).toEqual([]);
    const mixed = `${normal}${'*a '.repeat(2000)}\n\n${normal}${'_b '.repeat(2000)}`;
    expect((await markdownToPdfBytes(mixed)).notes).toContain(literalEmphasisNote(2));
  });

  it('reports determinate, monotonic progress ending at 1', async () => {
    const job = recordingJob();
    await markdownToPdfBytes('# Title\n\nA paragraph.\n\n- one\n- two\n', job);
    expect(job.fractions[0]).toBe(0);
    expect(job.fractions.at(-1)).toBe(1);
    for (let i = 1; i < job.fractions.length; i++) {
      expect(job.fractions[i]).toBeGreaterThanOrEqual(job.fractions[i - 1]);
    }
  });

  it('cancels mid-conversion with UserCancelled', async () => {
    // Cancelled at the second checkpoint, i.e. after the conversion started.
    const job = recordingJob(1);
    await expect(markdownToPdfBytes('Paragraph.\n\n'.repeat(2000), job)).rejects.toMatchObject({
      kind: 'UserCancelled'
    });
  });

  it('cancels promptly while lexing a long document of many blocks', async () => {
    // ~40k inline runs: lexing alone takes well over one checkpoint interval,
    // so a cancel raised as soon as the first in-lexing checkpoint happens must
    // stop it there rather than after the whole document.
    let checks = 0;
    const job: JobPort = {
      progress() {},
      cancelled() {
        checks += 1;
        return checks >= 2;
      }
    };
    const src = '| a | *b* |\n| - | - |\n' + '| x | *y* **z** |\n'.repeat(20_000);
    const t = performance.now();
    await expect(markdownToPdfBytes(src, job)).rejects.toMatchObject({ kind: 'UserCancelled' });
    expect(performance.now() - t).toBeLessThan(5000);
  });
});
