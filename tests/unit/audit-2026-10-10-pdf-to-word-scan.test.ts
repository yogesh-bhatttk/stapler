/**
 * Audit 2026-10-10 CV13 — PDF → Word on a scan.
 *
 * Images off: the writer threw an internal "no text or images" error.
 * Images on: a picture-only .docx was written with nothing said. Both now match
 * the Excel/PowerPoint policy: a clear refusal naming OCR, or a note.
 */
import { describe, expect, it, vi } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';

vi.mock('comlink', () => ({ expose: vi.fn(), transfer: vi.fn(v => v), proxy: vi.fn(v => v) }));

const { buildDocx, EMPTY_DOCX_MESSAGE, PICTURE_ONLY_DOCX_NOTE, isPictureOnly } =
  await import('../../src/core/convert/docx-writer');
const { convertWorkerImpl } = await import('../../src/core/workers/convert.worker');
const { encodePng } = await import('../../src/core/png');
const { StaplerError } = await import('../../src/core/errors');

const png = () =>
  encodePng({
    width: 2,
    height: 2,
    bitDepth: 8,
    colorType: 0,
    samples: new Uint8Array(4).fill(90)
  });

describe('CV13 — PDF → Word on a scanned PDF', () => {
  it('refuses an empty document with an actionable, non-internal message', async () => {
    const err = await buildDocx({
      title: 't',
      pages: [{ pageIndex: 0, blocks: [] }],
      skipped: []
    }).catch(e => e);
    expect(err).toBeInstanceOf(StaplerError);
    expect((err as InstanceType<typeof StaplerError>).kind).toBe('UnsupportedFeature');
    expect((err as Error).message).toBe(EMPTY_DOCX_MESSAGE);
    expect((err as Error).message).toMatch(/OCR/);
  });

  it('writes a picture-only document with a note saying so, first in the list', async () => {
    const model = {
      title: 'scan',
      pages: [
        {
          pageIndex: 0,
          blocks: [
            {
              kind: 'image' as const,
              data: png(),
              format: 'png' as const,
              width: 2,
              height: 2,
              altText: 'Page 1'
            }
          ]
        }
      ],
      skipped: []
    };
    expect(isPictureOnly(model)).toBe(true);
    const result = (await convertWorkerImpl.buildDocx(model as never, null, [])) as unknown as {
      bytes: Uint8Array;
      skipped: string[];
    };
    expect(result.skipped[0]).toBe(PICTURE_ONLY_DOCX_NOTE);
    // A real .docx with the picture in it.
    const files = unzipSync(result.bytes);
    expect(Object.keys(files).some(name => name.startsWith('word/media/'))).toBe(true);
    expect(strFromU8(files['word/document.xml'])).toContain('<w:drawing>');
  });

  it('adds no note to a document that has text', async () => {
    const model = {
      title: 'text',
      pages: [
        {
          pageIndex: 0,
          blocks: [
            { kind: 'paragraph' as const, runs: [{ text: 'Hello', bold: false, italic: false }] }
          ]
        }
      ],
      skipped: []
    };
    expect(isPictureOnly(model)).toBe(false);
    const result = (await convertWorkerImpl.buildDocx(model as never, null, [])) as unknown as {
      skipped: string[];
    };
    expect(result.skipped).toEqual([]);
  });
});
