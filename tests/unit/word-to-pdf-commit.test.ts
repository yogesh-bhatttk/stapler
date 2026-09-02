/**
 * CNV-09 — the save handler's own refusal, exercised rather than asserted.
 *
 * `commit-gate.ts` says outright that "a disabled button is a courtesy; the
 * handler's check is the guarantee", and CNV-08's audit finding 3 was that its
 * guarantee had no test that ever executed it. So this file drives the real
 * `commitTool('word-to-pdf', …)` — the same entry point the action bar calls —
 * with the platform's `saveFileAs` replaced by a recorder, and asserts that a
 * stale or absent preview writes **nothing**.
 *
 * It lives in its own file, the way `pdf-to-word-transfer.test.ts` does, because
 * it needs `platform/current` mocked and the round-trip file must not be.
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
const state = await import('../../src/ui/tools/convert/word-to-pdf-state');

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);

function previewResult() {
  return {
    bytes: PDF_BYTES,
    pageCount: 2,
    imageCount: 0,
    outline: [],
    notes: [],
    warnings: [],
    hadUnsupportedCharacters: false
  };
}

function docxFile(name = 'quarterly.docx') {
  return new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], name);
}

describe('CNV-09 — the commit handler refuses without a valid preview', () => {
  beforeEach(() => {
    saved.length = 0;
    state.setWordToPdfSource(null);
  });

  it('writes nothing when no preview has been produced', async () => {
    state.setWordToPdfSource(docxFile());
    await commitTool('word-to-pdf', {});
    expect(saved).toEqual([]);
  });

  it('writes nothing when no file is chosen at all', async () => {
    await commitTool('word-to-pdf', {});
    expect(saved).toEqual([]);
  });

  it('writes nothing when the preview belongs to a file that has since been replaced', async () => {
    const first = docxFile();
    state.setWordToPdfSource(first);
    state.setWordToPdfPreview(previewResult(), first, state.wordToPdfInputRevision.value);

    // Re-pick, which is what makes the held bytes stale.
    state.setWordToPdfSource(docxFile());
    await commitTool('word-to-pdf', {});
    expect(saved).toEqual([]);
  });

  it('writes nothing when the preview finished after its own input changed', async () => {
    const file = docxFile();
    state.setWordToPdfSource(file);
    const captured = state.wordToPdfInputRevision.value;
    state.setWordToPdfOptions({ pageSize: 'letter' });
    // The late result installs itself with a revision that no longer matches.
    state.setWordToPdfPreview(previewResult(), file, captured);

    await commitTool('word-to-pdf', {});
    expect(saved).toEqual([]);
    state.setWordToPdfOptions({ pageSize: 'a4' });
  });

  it('writes exactly the previewed bytes, named after the .docx, when the preview is valid', async () => {
    const file = docxFile('quarterly.docx');
    state.setWordToPdfSource(file);
    state.setWordToPdfPreview(previewResult(), file, state.wordToPdfInputRevision.value);

    await commitTool('word-to-pdf', {});
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toBe('quarterly.pdf');
    // The very bytes the preview described — not a re-run of the conversion.
    expect([...saved[0].bytes]).toEqual([...PDF_BYTES]);
  });
});
