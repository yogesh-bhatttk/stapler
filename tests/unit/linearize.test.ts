/**
 * DOC-08 — first-page-first object ordering.
 *
 * The point of this file is to keep the module's claims honest. It asserts what the
 * reordering *does* (page 1's objects precede later pages' on the plain-xref save
 * path, output re-parses unchanged, it can be switched off) and equally what it does
 * *not* do (no `/Linearized` dictionary, no ordering guarantee once pdf-lib diverts
 * objects into object streams). Before this file, zero tests referenced linearization
 * anywhere, and the UI copy claimed "fast web view".
 */
import { describe, expect, it } from 'vitest';
import {
  PDFDocument,
  PDFArray,
  PDFName,
  PDFRawStream,
  PDFRef,
  StandardFonts,
  decodePDFRawStream
} from 'pdf-lib';
import {
  isFastWebViewOrderingEnabled,
  pseudoLinearize,
  setFastWebViewOrdering
} from '../../src/core/pdf/linearize';

const MARKERS = ['MARKER-ALPHA-ONE', 'MARKER-BETA-TWO', 'MARKER-GAMMA-THREE'];

async function buildDoc() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const marker of MARKERS) {
    const page = doc.addPage([300, 300]);
    page.drawText(marker, { x: 20, y: 150, size: 12, font });
  }
  return doc;
}

/**
 * Byte offset of `<num> 0 obj` in the saved file. Content streams come out flate
 * compressed, so the markers themselves are not greppable in the bytes — the object
 * headers are, and object numbers are preserved across `save()`.
 */
function objOffset(bytes: Uint8Array, objectNumber: number) {
  const text = Buffer.from(bytes).toString('latin1');
  return text.search(new RegExp(`(?:^|[\\r\\n])${objectNumber} 0 obj\\b`));
}

/** Every content-stream ref of a page — `/Contents` may be one ref or an array. */
function pageContentRefs(doc: PDFDocument, index: number): PDFRef[] {
  const contents = doc.getPage(index).node.get(PDFName.of('Contents'));
  const resolved = contents instanceof PDFRef ? doc.context.lookup(contents) : contents;
  if (contents instanceof PDFRef && !(resolved instanceof PDFArray)) return [contents];
  if (resolved instanceof PDFArray) {
    return resolved.asArray().filter((r): r is PDFRef => r instanceof PDFRef);
  }
  throw new Error('expected content stream refs');
}

/** The object number of each page's first content stream, in page order. */
function contentRefs(doc: PDFDocument) {
  return doc.getPages().map((_, i) => pageContentRefs(doc, i)[0].objectNumber);
}

/** Decoded content stream text for each page of a re-parsed document. */
function decodedContents(doc: PDFDocument) {
  return doc.getPages().map((_, i) =>
    pageContentRefs(doc, i)
      .map(ref => {
        const stream = doc.context.lookup(ref);
        if (!(stream instanceof PDFRawStream)) throw new Error('expected a raw content stream');
        return Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
      })
      .join('\n')
  );
}

describe('pseudoLinearize', () => {
  it('emits the first page content stream before later pages on a plain-xref save', async () => {
    const doc = await buildDoc();
    const bytes = await pseudoLinearize(doc).save({ useObjectStreams: false });

    const offsets = contentRefs(doc).map(num => objOffset(bytes, num));
    expect(offsets.every(o => o >= 0)).toBe(true);
    expect(offsets[0]).toBeLessThan(offsets[1]);
    expect(offsets[0]).toBeLessThan(offsets[2]);
  });

  it('is a pure permutation: page count, order and text survive', async () => {
    const doc = await buildDoc();
    const bytes = await pseudoLinearize(doc).save({ useObjectStreams: false });

    const reparsed = await PDFDocument.load(bytes);
    expect(reparsed.getPageCount()).toBe(3);
    const sizes = reparsed.getPages().map(p => [p.getWidth(), p.getHeight()]);
    expect(sizes).toEqual([
      [300, 300],
      [300, 300],
      [300, 300]
    ]);
    // Page order is unchanged: each page still carries its own marker, in order.
    // pdf-lib writes the string as a hex literal, so compare against that form.
    const contents = decodedContents(reparsed);
    MARKERS.forEach((marker, i) =>
      expect(contents[i].toUpperCase()).toContain(
        Buffer.from(marker, 'latin1').toString('hex').toUpperCase()
      )
    );
  });

  it('does not claim to be ISO 32000 linearization', async () => {
    const doc = await buildDoc();
    const bytes = await pseudoLinearize(doc).save({ useObjectStreams: false });
    const text = Buffer.from(bytes).toString('latin1');
    // No /Linearized parameter dict and no /H hint table are written, and none are
    // faked. A viewer that checks will correctly report "not linearized".
    expect(text).not.toContain('/Linearized');
  });

  it('can be switched off per document and process-wide', async () => {
    const off = await buildDoc();
    const before = off.context.enumerateIndirectObjects;
    pseudoLinearize(off, false);
    expect(off.context.enumerateIndirectObjects).toBe(before);

    expect(isFastWebViewOrderingEnabled()).toBe(true);
    setFastWebViewOrdering(false);
    try {
      const globallyOff = await buildDoc();
      const original = globallyOff.context.enumerateIndirectObjects;
      pseudoLinearize(globallyOff);
      expect(globallyOff.context.enumerateIndirectObjects).toBe(original);
    } finally {
      setFastWebViewOrdering(true);
    }
    expect(isFastWebViewOrderingEnabled()).toBe(true);
  });

  it('documents the object-stream caveat: output is valid, ordering is not guaranteed', async () => {
    const doc = await buildDoc();
    const bytes = await pseudoLinearize(doc).save({ useObjectStreams: true });

    // Still a valid, unchanged document — that part is not negotiable.
    const reparsed = await PDFDocument.load(bytes);
    expect(reparsed.getPageCount()).toBe(3);

    // But pdf-lib diverted the non-stream objects (catalog, page tree, page dicts)
    // into an object stream appended near the end, whatever order we handed it.
    const text = Buffer.from(bytes).toString('latin1');
    expect(text).toContain('/ObjStm');
  });

  it('is idempotent — applying twice does not double-wrap the enumerator', async () => {
    const doc = await buildDoc();
    pseudoLinearize(doc);
    const wrapped = doc.context.enumerateIndirectObjects;
    pseudoLinearize(doc);
    expect(doc.context.enumerateIndirectObjects).toBe(wrapped);
  });
});
