import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveViaPicker } from '../../src/platform/file-system';

/**
 * Regression coverage for a real bug found while investigating a user report:
 * every extension other than `.zip`/`.pdf` was offered to the save picker as
 * `text/plain`, a mismatch the File System Access API itself never checks (it
 * doesn't affect what bytes get written), but which is exactly the kind of
 * malformed input that gives a desktop file picker no reason to trust the
 * declared extension and a plausible excuse to fall back to a name of its own.
 */
describe('saveViaPicker', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).showSaveFilePicker;
  });

  function stubPicker() {
    const write = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const handle = {
      kind: 'file' as const,
      name: 'out',
      getFile: vi.fn(),
      createWritable: vi.fn().mockResolvedValue({ write, close }),
      queryPermission: vi.fn(),
      requestPermission: vi.fn(),
      isSameEntry: vi.fn()
    };
    const showSaveFilePicker = vi.fn().mockResolvedValue(handle);
    (globalThis as Record<string, unknown>).showSaveFilePicker = showSaveFilePicker;
    return showSaveFilePicker;
  }

  it.each([
    ['out.pdf', 'application/pdf'],
    ['out.zip', 'application/zip'],
    ['out.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['out.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['out.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    ['out.png', 'image/png'],
    ['out.csv', 'text/csv'],
    ['out.txt', 'text/plain']
  ])('offers %s to the picker as %s, not text/plain', async (name, mime) => {
    const picker = stubPicker();
    await saveViaPicker(new Uint8Array([1, 2, 3]), name);

    const [{ types }] = picker.mock.calls[0];
    expect(types).toEqual([
      { description: 'Saved file', accept: { [mime]: [`.${name.split('.')[1]}`] } }
    ]);
  });

  it('falls back to a generic binary type for an extension it does not know, never text/plain', async () => {
    const picker = stubPicker();
    await saveViaPicker(new Uint8Array([1, 2, 3]), 'out.xyz');

    const [{ types }] = picker.mock.calls[0];
    expect(Object.keys(types[0].accept)).toEqual(['application/octet-stream']);
  });
});
