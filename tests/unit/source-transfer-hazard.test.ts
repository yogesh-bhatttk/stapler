/**
 * AUDIT-FINDINGS §4 — "buffers are cloned into the process worker on every
 * inbound call".
 *
 * The tempting fix is to add `bytesForPages(...)`'s arrays to the `postMessage`
 * transfer list. This file exists to make the reason that is *wrong* executable
 * rather than a comment.
 *
 * The store is a workspace view: `pages: PageRef[]` point into
 * `sources[sourceDocId].bytes`, and one source's byte array is shared by every
 * page that references it, across every open document. Transferring it detaches
 * the underlying `ArrayBuffer` for everyone — the open document in the other tab
 * goes blank with no error, which is the silent corruption CLAUDE.md forbids.
 *
 * Three things are proved below:
 *
 *  1. compose, applyRedactions and rebuildCompressed all leave a *shared* source's
 *     bytes intact, and the other document that shares them still exports.
 *  2. The test has teeth: performing the naive transfer by hand (via
 *     `structuredClone`'s transfer list, which is exactly what `postMessage`
 *     does) destroys the other document — so 1 would fail if the transfer were
 *     added.
 *  3. `canTransferSourceBytes` refuses this configuration, and the three call
 *     sites in `operations.ts` do not route store bytes through `handOver`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';

vi.mock('comlink', () => ({
  expose: vi.fn(),
  transfer: vi.fn((value: unknown) => value),
  proxy: vi.fn((value: unknown) => value)
}));

import { processWorkerImpl, type RedactionRegion } from '../../src/core/workers/process.worker';
import { silentJob } from '../../src/core/workers/protocol';
import {
  activeDocId,
  addDocument,
  bytesForPages,
  canTransferSourceBytes,
  documents,
  makePageRefs,
  registerSource,
  selectedPageKeys,
  sourceDocRefCount,
  sources,
  transferableSourceIds,
  type StaplerDoc
} from '../../src/core/store';
import { resetHistory } from '../../src/core/history';

const SHARED = 'shared-source';

async function twoPagePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const label of ['Alpha page', 'Beta page']) {
    const page = doc.addPage([595, 842]);
    page.drawText(label, { x: 50, y: 750, size: 14 });
  }
  return doc.save();
}

function openDoc(id: string, sourceId: string, pageCount: number): StaplerDoc {
  const doc: StaplerDoc = {
    id,
    name: `${id}.pdf`,
    pages: makePageRefs(sourceId, pageCount),
    annotations: [],
    dirty: false
  };
  addDocument(doc);
  return doc;
}

/** The export path, called exactly as `composeDocument` calls it. */
function compose(doc: StaplerDoc) {
  return processWorkerImpl.compose(
    doc.pages,
    bytesForPages(doc.pages),
    [],
    undefined,
    undefined,
    null,
    null,
    undefined,
    silentJob
  );
}

/** A document is "intact" if it still re-parses with the pages it should have. */
async function stillExports(doc: StaplerDoc, expectedPages: number) {
  const bytes = await compose(doc);
  const parsed = await PDFDocument.load(bytes);
  expect(parsed.getPageCount()).toBe(expectedPages);
  return bytes;
}

describe('a source shared by two open documents survives a terminal operation', () => {
  let original: Uint8Array;

  beforeEach(async () => {
    documents.value = [];
    sources.value = {};
    activeDocId.value = null;
    selectedPageKeys.value = new Set();
    resetHistory();

    original = await twoPagePdf();
    registerSource({
      id: SHARED,
      name: 'shared.pdf',
      bytes: original,
      pageCount: 2,
      pageSizes: [
        { width: 595, height: 842 },
        { width: 595, height: 842 }
      ]
    });
  });

  it('sets up the hazardous configuration the fix must not break', () => {
    openDoc('doc-1', SHARED, 2);
    openDoc('doc-2', SHARED, 2);
    expect(sourceDocRefCount(SHARED)).toBe(2);
    // The identity that makes this dangerous: what goes to the worker *is* the
    // store's array, not a copy of it.
    expect(bytesForPages(documents.value[0].pages)[SHARED]).toBe(sources.value[SHARED].bytes);
  });

  it('compose on one document leaves the other, and the source, intact', async () => {
    const first = openDoc('doc-1', SHARED, 2);
    const second = openDoc('doc-2', SHARED, 2);

    await compose(first);

    expect(sources.value[SHARED].bytes.byteLength).toBe(original.byteLength);
    expect(sources.value[SHARED].bytes).toEqual(original);
    await stillExports(second, 2);
  });

  it('applyRedactions on one document leaves the other, and the source, intact', async () => {
    const first = openDoc('doc-1', SHARED, 2);
    const second = openDoc('doc-2', SHARED, 2);

    // Redaction runs on composed bytes in production; the hazard is that those
    // bytes *are* the store's array whenever `currentDocumentBytes` takes its
    // untouched fast path, so that is what is passed here.
    const input = bytesForPages(first.pages)[SHARED];
    const regions: RedactionRegion[] = [
      { pageIndex: 0, x: 40, y: 740, width: 200, height: 30, text: 'Alpha page' }
    ];
    const redacted = await processWorkerImpl.applyRedactions(input, regions, undefined, silentJob);
    expect(redacted.byteLength).toBeGreaterThan(0);

    expect(sources.value[SHARED].bytes.byteLength).toBe(original.byteLength);
    expect(sources.value[SHARED].bytes).toEqual(original);
    await stillExports(second, 2);
  });

  it('rebuildCompressed on one document leaves the other, and the source, intact', async () => {
    const first = openDoc('doc-1', SHARED, 2);
    const second = openDoc('doc-2', SHARED, 2);

    const input = bytesForPages(first.pages)[SHARED];
    const result = await processWorkerImpl.rebuildCompressed(input, {}, {}, silentJob);
    // An empty plan keeps the original — the point here is the *input* buffer,
    // not the output.
    expect(result.bytes.byteLength).toBeGreaterThan(0);

    expect(sources.value[SHARED].bytes.byteLength).toBe(original.byteLength);
    expect(sources.value[SHARED].bytes).toEqual(original);
    await stillExports(second, 2);
  });

  /**
   * The teeth. `structuredClone(buffer, { transfer: [buffer] })` detaches the
   * original exactly as `postMessage(..., [buffer])` does, so this is the real
   * consequence of adding `bytesForPages`'s arrays to a transfer list — not an
   * approximation of it.
   */
  it('would corrupt the other document if the bytes were transferred instead of cloned', async () => {
    openDoc('doc-1', SHARED, 2);
    const second = openDoc('doc-2', SHARED, 2);

    const payload = bytesForPages(documents.value[0].pages);
    const buffer = payload[SHARED].buffer as ArrayBuffer;
    structuredClone(buffer, { transfer: [buffer] });

    // The store still holds a Uint8Array that looks present and is empty.
    expect(sources.value[SHARED].bytes.byteLength).toBe(0);
    expect(buffer.byteLength).toBe(0);
    // And the *other* open document can no longer be exported at all.
    await expect(stillExports(second, 2)).rejects.toBeTruthy();
  });

  it('the ownership gate refuses this configuration', () => {
    const first = openDoc('doc-1', SHARED, 2);
    openDoc('doc-2', SHARED, 2);
    expect(canTransferSourceBytes(SHARED, first.id)).toBe(false);
    expect(transferableSourceIds(first.pages, first.id)).toEqual([]);
  });

  /**
   * A structural guard on the three call sites this finding is about. `handOver`
   * is correct for worker output (`flattenDocument`, the redaction-internal
   * `scrubMetadata`) and unsafe for store bytes; the difference is invisible at
   * the call site, so it is asserted here rather than left to review.
   */
  it('operations.ts does not hand store bytes over to the worker', () => {
    const src = readFileSync('src/core/operations.ts', 'utf8');
    for (const call of ['api.compose(', 'api.composeSplit(', 'api.rebuildCompressed(']) {
      const at = src.indexOf(call);
      expect(at, `${call} not found — update this guard`).toBeGreaterThan(-1);
      const body = src.slice(at, src.indexOf(')', at) + 1);
      expect(body).not.toContain('handOver(');
    }
    // `applyRedactions` reads its `bytes` three times (plan, image pixels,
    // rebuild), so no read of it can be the last one.
    const redact = src.slice(src.indexOf('export async function applyRedactions'));
    const end = redact.indexOf('\n}\n');
    expect(redact.slice(0, end)).not.toContain('handOver(bytes)');
  });
});
