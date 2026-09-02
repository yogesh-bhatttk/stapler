/**
 * CNV-11 — the save handler's own refusal, exercised rather than asserted.
 *
 * `commit-gate.ts` says outright that "a disabled button is a courtesy; the
 * handler's check is the guarantee", and CNV-08's audit finding 3 was that its
 * guarantee had no test that ever executed it. So this file drives the real
 * `commitTool('excel-to-pdf', …)` — the same entry point the action bar calls —
 * with the platform's `saveFileAs` replaced by a recorder, and asserts that a
 * stale or absent preview writes **nothing**.
 *
 * It lives in its own file, the way CNV-09's `word-to-pdf-commit.test.ts` does,
 * because it needs `platform/current` mocked and the round-trip file must not be.
 *
 * Each case here is a *mutation test* of the guard in `commit.ts`, and both
 * mutations were run: weaken the condition from
 * `!preview || !source || excelToPdfPreviewIsStale()` to `!preview` and the two
 * revision cases fail; remove the guard altogether and all five refusal cases
 * fail. A guard with no test that executes it is what CNV-08 shipped.
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
const state = await import('../../src/ui/tools/convert/excel-to-pdf-state');

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);

function previewResult() {
  return {
    bytes: PDF_BYTES,
    pageCount: 3,
    outline: [],
    sheets: [{ name: 'Summary', rows: 4, columns: 4, bands: 1, empty: false, unreadable: false }],
    notes: [],
    hadUnsupportedCharacters: false
  };
}

function xlsxFile(name = 'quarterly.xlsx') {
  return new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], name);
}

describe('CNV-11 — the commit handler refuses without a valid preview', () => {
  beforeEach(() => {
    saved.length = 0;
    state.setExcelToPdfSource(null);
  });

  it('writes nothing when no preview has been produced', async () => {
    state.setExcelToPdfSource(xlsxFile());
    await commitTool('excel-to-pdf', {});
    expect(saved).toEqual([]);
  });

  it('writes nothing when no file is chosen at all', async () => {
    await commitTool('excel-to-pdf', {});
    expect(saved).toEqual([]);
  });

  it('writes nothing when the preview belongs to a file that has since been replaced', async () => {
    const first = xlsxFile();
    state.setExcelToPdfSource(first);
    state.setExcelToPdfPreview(previewResult(), first, state.excelToPdfInputRevision.value);

    // Re-pick, which is what makes the held bytes stale — the same file name and
    // the same bytes, but a different `File`, so it is not the input any more.
    state.setExcelToPdfSource(xlsxFile());
    await commitTool('excel-to-pdf', {});
    expect(saved).toEqual([]);
  });

  it('writes nothing when the preview finished after its own input changed', async () => {
    const file = xlsxFile();
    state.setExcelToPdfSource(file);
    const captured = state.excelToPdfInputRevision.value;
    state.setExcelToPdfOptions({ pageSize: 'letter' });
    // The late result installs itself with a revision that no longer matches.
    state.setExcelToPdfPreview(previewResult(), file, captured);

    await commitTool('excel-to-pdf', {});
    expect(saved).toEqual([]);
    state.setExcelToPdfOptions({ pageSize: 'a4' });
  });

  it('writes nothing when a preview is held with no revision recorded at all', async () => {
    // The safe side of a caller's mistake: a held preview whose revision was
    // never captured cannot be shown to describe the current input, so it does
    // not unlock the save.
    const file = xlsxFile();
    state.setExcelToPdfSource(file);
    state.setExcelToPdfPreview(previewResult(), file, null);

    expect(state.excelToPdfPreviewIsStale()).toBe(true);
    await commitTool('excel-to-pdf', {});
    expect(saved).toEqual([]);
  });

  it('writes exactly the previewed bytes, named after the .xlsx, when the preview is valid', async () => {
    const file = xlsxFile('quarterly.xlsx');
    state.setExcelToPdfSource(file);
    state.setExcelToPdfPreview(previewResult(), file, state.excelToPdfInputRevision.value);

    await commitTool('excel-to-pdf', {});
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toBe('quarterly.pdf');
    // The very bytes the preview described — not a re-run of the conversion.
    expect([...saved[0].bytes]).toEqual([...PDF_BYTES]);
  });
});
