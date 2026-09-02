/**
 * CNV-10 — the save handler's own refusal, exercised rather than asserted.
 *
 * `commit-gate.ts` says outright that "a disabled button is a courtesy; the
 * handler's check is the guarantee", and CNV-08's audit finding 3 was that its
 * guarantee had no test that ever executed it. So this file drives the real
 * `commitTool('pdf-to-excel', …)` — the same entry point the action bar calls —
 * with the platform's `saveFileAs` replaced by a recorder, and asserts that a
 * stale, foreign or absent preview writes **nothing**.
 *
 * It lives in its own file, the way CNV-09's `word-to-pdf-commit.test.ts` does,
 * because it needs `platform/current` mocked and the round-trip file must not be.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const saved: { name: string; bytes: Uint8Array }[] = [];

vi.mock('comlink', () => ({
  expose: vi.fn(),
  transfer: vi.fn(value => value),
  proxy: vi.fn(v => v)
}));
vi.mock('../../src/platform/current', () => ({
  platform: {
    kind: 'web',
    supportsFileSystemAccess: false,
    saveFileAs: async (bytes: Uint8Array, name: string) => {
      saved.push({ name, bytes });
      return true;
    },
    openFiles: async () => [],
    openDirectory: async () => null,
    saveOver: async () => false,
    persistHandle: async () => {},
    restoreHandles: async () => [],
    reopenHandle: async () => null,
    revokeHandle: async () => {},
    readClipboardImage: async () => null
  }
}));

const { commitTool } = await import('../../src/ui/tools/commit');
const state = await import('../../src/ui/tools/convert/pdf-to-excel-state');
const store = await import('../../src/core/store');
const { historyVersion } = await import('../../src/core/history');

/** A recognisable ZIP local-file header — an `.xlsx` is a ZIP. */
const XLSX_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);

function previewResult() {
  return {
    bytes: XLSX_BYTES,
    pageCount: 2,
    sheetCount: 3,
    tableCount: 1,
    outline: [],
    skipped: []
  };
}

function openDocument(id: string, name: string) {
  const doc = {
    id,
    name,
    pages: [{ key: `${id}-p1`, sourceDocId: 'src-1', sourceIndex: 0, rotation: 0 }],
    annotations: [],
    dirty: false
  };
  store.documents.value = [doc];
  store.activeDocId.value = id;
  return doc;
}

describe('CNV-10 — the commit handler refuses without a valid preview', () => {
  beforeEach(() => {
    saved.length = 0;
    state.resetPdfToExcelPreview();
  });

  it('writes nothing when no preview has been produced', async () => {
    openDocument('doc-a', 'quarterly.pdf');
    await commitTool('pdf-to-excel', {});
    expect(saved).toEqual([]);
  });

  it('writes nothing when the preview belongs to a different document', async () => {
    openDocument('doc-a', 'quarterly.pdf');
    state.setPdfToExcelPreview(previewResult(), 'doc-b', historyVersion.value);
    await commitTool('pdf-to-excel', {});
    expect(saved).toEqual([]);
  });

  it('writes nothing when the document was edited after the preview ran', async () => {
    // The staleness rule that CNV-08's audit had to add later, proven here by
    // running a *real* store mutator rather than by bumping a counter.
    const doc = openDocument('doc-a', 'quarterly.pdf');
    state.setPdfToExcelPreview(previewResult(), doc.id, historyVersion.value);
    store.rotatePages(doc.id, [doc.pages[0].key], 90);

    await commitTool('pdf-to-excel', {});
    expect(saved).toEqual([]);
  });

  it('writes nothing when the conversion finished after its own input changed', async () => {
    const doc = openDocument('doc-a', 'quarterly.pdf');
    const captured = historyVersion.value;
    store.rotatePages(doc.id, [doc.pages[0].key], 90);
    // The late result installs itself with the revision it captured before the
    // edit, which no longer matches.
    state.setPdfToExcelPreview(previewResult(), doc.id, captured);

    await commitTool('pdf-to-excel', {});
    expect(saved).toEqual([]);
  });

  it('writes exactly the previewed bytes, named after the PDF, when the preview is valid', async () => {
    const doc = openDocument('doc-a', 'quarterly.pdf');
    state.setPdfToExcelPreview(previewResult(), doc.id, historyVersion.value);

    await commitTool('pdf-to-excel', {});
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toBe('quarterly.xlsx');
    // The very bytes the preview described — not a re-run of the conversion.
    expect([...saved[0].bytes]).toEqual([...XLSX_BYTES]);
  });
});
