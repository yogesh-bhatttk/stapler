/**
 * Sticky-note text reaching find-and-mark and the verifier — AUDIT §3, second
 * bullet.
 *
 * `render.worker.ts` read `annotation.contents` at both of the places that scan
 * annotations. pdf.js has not had that field since v3: the body of a markup
 * annotation arrives as `contentsObj` (`{ str, dir }`), assigned by
 * `Annotation.setContents` in the worker. So both reads were `undefined` on the
 * pinned 6.2.108, and a comment's text was invisible to search-and-redact and
 * to the whole-document text the redaction verifier compares against — dead
 * code that looked like a feature.
 *
 * The shape is pinned directly against the installed pdf.js first, so this
 * cannot start passing for the wrong reason if the field ever moves again, and
 * then through both worker entry points on a real one-page file.
 */
import { describe, expect, it, vi } from 'vitest';
import { PDFDict, PDFDocument, PDFName, PDFString } from 'pdf-lib';

vi.mock('comlink', () => ({
  expose: vi.fn(),
  transfer: vi.fn(value => value),
  proxy: vi.fn(value => value)
}));

vi.mock('../../src/core/workers/pdfjs-setup', async () => {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return {
    pdfjsLib,
    openDocument: ({ data, password }: { data: Uint8Array; password?: string }) =>
      pdfjsLib.getDocument({ data, password, disableFontFace: true })
  };
});

const { renderWorkerImpl } = await import('../../src/core/workers/render.worker');

const NOTE = 'Sticky note about Mallory Quill';

/** One page, one sticky note, no page text at all. */
async function stickyNoteDocument(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 300]);
  const annot = doc.context.obj({
    Type: 'Annot',
    Subtype: 'Text',
    Rect: [40, 200, 70, 230],
    Contents: PDFString.of(NOTE)
  }) as PDFDict;
  page.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(annot)]));
  return doc.save({ useObjectStreams: false });
}

async function withHandle<T>(bytes: Uint8Array, fn: (handle: string) => Promise<T>): Promise<T> {
  const { handle } = await renderWorkerImpl.loadDocument(bytes);
  try {
    return await fn(handle);
  } finally {
    await renderWorkerImpl.closeDocument(handle);
  }
}

describe('pdf.js exposes annotation text as contentsObj, not contents (§3)', () => {
  it('is what the installed pdf.js actually returns', async () => {
    const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = pdfjsLib.getDocument({ data: await stickyNoteDocument(), disableFontFace: true });
    const doc = await task.promise;
    try {
      const page = await doc.getPage(1);
      const [annot] = (await page.getAnnotations()) as {
        contents?: string;
        contentsObj?: { str?: string };
      }[];
      expect(annot.contents).toBeUndefined();
      expect(annot.contentsObj?.str).toBe(NOTE);
    } finally {
      await task.destroy();
    }
  });

  it('documentText includes the note, so the verifier can see it', async () => {
    const pages = await withHandle(await stickyNoteDocument(), handle =>
      renderWorkerImpl.documentText(handle)
    );
    expect(pages.join('\n')).toContain(NOTE);
  });

  it('findText marks the note, so search-and-redact can reach it', async () => {
    const regions = await withHandle(await stickyNoteDocument(), handle =>
      renderWorkerImpl.findText(handle, 'Mallory Quill', false)
    );
    expect(regions).toHaveLength(1);
    expect(regions[0].pageIndex).toBe(0);
    expect(regions[0].text).toBe('Mallory Quill');
    // The mark is the annotation's own rectangle, normalised against the page.
    // (pdf.js gives a `/Text` note a fixed icon size, so only the origin is
    // the rect the file declares.)
    expect(regions[0].x).toBeCloseTo(40 / 300, 3);
    expect(regions[0].width).toBeGreaterThan(0);
  });

  it('still reads a form field value alongside it', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 300]);
    const form = doc.getForm();
    const field = form.createTextField('who');
    field.setText('Mallory Quill');
    field.addToPage(page, { x: 20, y: 20, width: 120, height: 20 });

    const regions = await withHandle(await doc.save({ useObjectStreams: false }), handle =>
      renderWorkerImpl.findText(handle, 'Mallory Quill', false)
    );
    expect(regions.length).toBeGreaterThanOrEqual(1);
  });
});
