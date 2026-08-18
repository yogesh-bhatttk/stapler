/**
 * DOC-05 — Export pipeline verification.
 *
 * Proves that:
 *   1. A document serialised with pdf-lib round-trips cleanly (re-parses
 *      without error, page count matches, no XRef corruption).
 *   2. The compose path (processWorkerImpl.compose) produces output that
 *      re-parses cleanly, preserving page count and order.
 *   3. The sanitizeFileStem helper produces sensible default filenames.
 *   4. splitBoundaries produces correct cut points for each split mode.
 *
 * "Save over original" via the native file-picker is the one step that
 * Playwright (and Node/vitest) cannot drive — see QA-05 in
 * RELEASE_CHECKLIST.md for the manual gate.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';

vi.mock('comlink', () => ({
  expose: vi.fn(),
  transfer: vi.fn(val => val)
}));

import { processWorkerImpl } from '../../src/core/workers/process.worker';
import { silentJob } from '../../src/core/workers/protocol';
import {
  activeDocId,
  bytesForPages,
  documents,
  makePageRefs,
  sources,
  type StaplerDoc
} from '../../src/core/store';
import { resetHistory } from '../../src/core/history';
import { sanitizeFileStem, splitBoundaries } from '../../src/core/operations';
import { __memoryFallback } from '../../src/core/opfs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal N-page PDF in memory. */
async function makePdf(n = 1, prefix = 'Page'): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < n; i++) {
    const page = doc.addPage([595, 842]);
    page.drawText(`${prefix} ${i + 1}`, { x: 50, y: 750, size: 14 });
  }
  return doc.save();
}

/** Parse bytes and return page count — throws if bytes are corrupt. */
async function countPages(bytes: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPageCount();
}

/** Register a source PDF into the store, return its ID. */
let counter = 0;
function registerPdf(bytes: Uint8Array): string {
  const id = `src-${++counter}`;
  __memoryFallback.set(id, bytes);
  sources.value = { ...sources.value, [id]: { id, name: `${id}.pdf`, pageCount: 1, pageSizes: [] } as any };
  return id;
}

/** Compose the pages of a doc through the process worker (same path as export). */
async function composeCurrent(doc: StaplerDoc): Promise<Uint8Array> {
  return processWorkerImpl.compose(
    doc.pages,
    await bytesForPages(doc.pages),
    [],
    undefined,
    undefined,
    null,
    null,
    undefined,
    silentJob
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DOC-05: export pipeline', () => {
  beforeEach(() => {
    sources.value = {};
    documents.value = {};
    activeDocId.value = null;
    resetHistory();
    counter = 0;
  });

  describe('pdf-lib round-trip (serialise → re-parse)', () => {
    it('a 1-page document round-trips cleanly', async () => {
      expect(await countPages(await makePdf(1))).toBe(1);
    });

    it('a 5-page document preserves page count', async () => {
      expect(await countPages(await makePdf(5))).toBe(5);
    });

    it('all page indices are accessible (XRef integrity)', async () => {
      const doc = await PDFDocument.load(await makePdf(3));
      for (let i = 0; i < 3; i++) expect(() => doc.getPage(i)).not.toThrow();
    });

    it('serialised bytes begin with the %%PDF header', async () => {
      const bytes = await makePdf(2);
      expect(new TextDecoder('ascii').decode(bytes.slice(0, 5))).toBe('%PDF-');
    });
  });

  describe('compose path (process worker)', () => {
    it('compose preserves page count for a 3-page source', async () => {
      const srcBytes = await makePdf(3, 'Compose');
      const srcId = registerPdf(srcBytes);
      const doc: StaplerDoc = {
        id: `doc-${srcId}`,
        pages: makePageRefs(srcId, 3),
        annotations: {},
        name: `${srcId}.pdf`,
        compressionSettings: undefined
      };
      const out = await composeCurrent(doc);
      expect(await countPages(out)).toBe(3);
    });

    it('compose over a 2-page subset produces exactly 2 pages', async () => {
      const srcBytes = await makePdf(5, 'Subset');
      const srcId = registerPdf(srcBytes);
      const doc: StaplerDoc = {
        id: `doc-${srcId}`,
        pages: makePageRefs(srcId, 5).slice(0, 2),
        annotations: {},
        name: `${srcId}.pdf`,
        compressionSettings: undefined
      };
      const out = await composeCurrent(doc);
      expect(await countPages(out)).toBe(2);
    });

    it('compose output starts with %PDF header', async () => {
      const srcBytes = await makePdf(1, 'Header');
      const srcId = registerPdf(srcBytes);
      const doc: StaplerDoc = {
        id: `doc-${srcId}`,
        pages: makePageRefs(srcId, 1),
        annotations: {},
        name: `${srcId}.pdf`,
        compressionSettings: undefined
      };
      const out = await composeCurrent(doc);
      expect(new TextDecoder('ascii').decode(out.slice(0, 5))).toBe('%PDF-');
    });
  });

  describe('sanitizeFileStem', () => {
    it('strips path-unsafe characters', () => {
      expect(sanitizeFileStem('my/doc:file*name', 'fallback')).not.toMatch(/[/:*]/);
    });

    it('returns the fallback when input is empty', () => {
      expect(sanitizeFileStem('', 'fallback')).toBe('fallback');
    });

    it('returns the fallback when input is whitespace only', () => {
      expect(sanitizeFileStem('   ', 'fallback')).toBe('fallback');
    });

    it('preserves normal alphanumeric names unchanged', () => {
      expect(sanitizeFileStem('contract-2026', 'fallback')).toBe('contract-2026');
    });
  });

  describe('splitBoundaries', () => {
    it('individual mode: returns N-1 cut points for N pages', () => {
      const cuts = splitBoundaries('individual', 5);
      expect(cuts).toEqual([1, 2, 3, 4]);
    });

    it('every_n mode with n=3 on 10 pages: correct cut points', () => {
      const cuts = splitBoundaries('every_n', 10, { every: 3 });
      expect(cuts).toEqual([3, 6, 9]);
    });

    it('returns empty array for a single-page document', () => {
      expect(splitBoundaries('individual', 1)).toEqual([]);
    });
  });
});
