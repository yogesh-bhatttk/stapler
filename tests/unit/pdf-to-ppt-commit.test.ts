/**
 * CNV-12 — the save handler's own refusal, exercised rather than asserted.
 *
 * `commit-gate.ts` says outright that "a disabled button is a courtesy; the
 * handler's check is the guarantee", and CNV-08's audit finding 3 was that its
 * guarantee had no test that ever executed it. So this file drives the real
 * `commitTool('pdf-to-ppt', …)` — the same entry point the action bar calls —
 * with the platform's `saveFileAs` replaced by a recorder, and asserts that a
 * stale, foreign or absent preview writes **nothing**.
 *
 * It lives in its own file, the way CNV-09's and CNV-10's do, because it needs
 * `platform/current` mocked and the round-trip file must not be.
 *
 * Seven tests, five of them refusal cases, and those five are also the
 * *falsification* evidence for the gate. Both numbers below were measured by
 * making the change, running this file, and restoring it — not reasoned about:
 *
 *  • Weakening the handler's check from `!preview || pdfToPptPreviewIsStale
 *    (doc.id)` to `if (!preview)` — i.e. trusting the disabled button —
 *    fails **four** of the seven: the last four of the five refusals (a foreign
 *    document's preview, an edit after the preview, a preview that finished
 *    after its own input changed, and a preview held with no revision at all).
 *    The first refusal still passes, because "no preview" is the one case the
 *    weakened check still covers.
 *  • Removing the check altogether — both conditions, so the handler reaches
 *    `preview.bytes` unguarded — fails **all five**.
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
const state = await import('../../src/ui/tools/convert/pdf-to-ppt-state');
const store = await import('../../src/core/store');
const { historyVersion } = await import('../../src/core/history');

/** A recognisable ZIP local-file header — a `.pptx` is a ZIP. */
const PPTX_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);

function previewResult() {
  return {
    bytes: PPTX_BYTES,
    pageCount: 2,
    slideCount: 2,
    imageCount: 1,
    textBoxCount: 9,
    slideWidth: 612,
    slideHeight: 792,
    outline: [],
    notes: []
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

describe('CNV-12 — the commit handler refuses without a valid preview', () => {
  beforeEach(() => {
    saved.length = 0;
    state.resetPdfToPptPreview();
  });

  it('writes nothing when no preview has been produced', async () => {
    openDocument('doc-a', 'review.pdf');
    await commitTool('pdf-to-ppt', {});
    expect(saved).toEqual([]);
  });

  it('writes nothing when the preview belongs to a different document', async () => {
    openDocument('doc-a', 'review.pdf');
    state.setPdfToPptPreview(previewResult(), 'doc-b', historyVersion.value);
    await commitTool('pdf-to-ppt', {});
    expect(saved).toEqual([]);
  });

  it('writes nothing when the document was edited after the preview ran', async () => {
    // The staleness rule, proven here by running a *real* store mutator rather
    // than by bumping a counter.
    const doc = openDocument('doc-a', 'review.pdf');
    state.setPdfToPptPreview(previewResult(), doc.id, historyVersion.value);
    store.rotatePages(doc.id, [doc.pages[0].key], 90);

    await commitTool('pdf-to-ppt', {});
    expect(saved).toEqual([]);
  });

  it('writes nothing when the conversion finished after its own input changed', async () => {
    const doc = openDocument('doc-a', 'review.pdf');
    const captured = historyVersion.value;
    store.rotatePages(doc.id, [doc.pages[0].key], 90);
    // The late result installs itself with the revision it captured before the
    // edit, which no longer matches.
    state.setPdfToPptPreview(previewResult(), doc.id, captured);

    await commitTool('pdf-to-ppt', {});
    expect(saved).toEqual([]);
  });

  it('writes nothing when a preview is held with no revision recorded at all', async () => {
    const doc = openDocument('doc-a', 'review.pdf');
    // A caller that forgets to record one: refusing is the safe side of that.
    state.setPdfToPptPreview(previewResult(), doc.id);
    await commitTool('pdf-to-ppt', {});
    expect(saved).toEqual([]);
  });

  it('writes exactly the previewed bytes, named after the PDF, when the preview is valid', async () => {
    const doc = openDocument('doc-a', 'review.pdf');
    state.setPdfToPptPreview(previewResult(), doc.id, historyVersion.value);

    await commitTool('pdf-to-ppt', {});
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toBe('review.pptx');
    // The very bytes the preview described — not a re-run of the conversion.
    expect([...saved[0].bytes]).toEqual([...PPTX_BYTES]);
  });

  it('does not run the .pptx through the PDF encryption step', async () => {
    // `applyProtection` encrypts a *PDF*; running an OOXML package through it
    // would produce an unopenable file. The proof is that the bytes on disk are
    // byte-identical to the previewed ones even with RED-06's protection armed.
    const { protection } = await import('../../src/ui/tools/protect/state');
    const doc = openDocument('doc-a', 'review.pdf');
    const before = protection.value;
    protection.value = { ...before, enabled: true, userPassword: 'hunter2' };
    try {
      state.setPdfToPptPreview(previewResult(), doc.id, historyVersion.value);
      await commitTool('pdf-to-ppt', {});
      expect(saved).toHaveLength(1);
      expect([...saved[0].bytes]).toEqual([...PPTX_BYTES]);
    } finally {
      protection.value = before;
    }
  });
});
