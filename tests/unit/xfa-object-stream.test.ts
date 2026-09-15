/**
 * SGN-03 / §1.7 — an XFA payload must never be discarded quietly.
 *
 * The compose guard rested on `hasXfaMarker` alone, a linear scan for the
 * literal bytes `/XFA` over the original file. That works for a form written
 * with a plain cross-reference table and fails completely for one saved with
 * object streams — where the catalog, the `/AcroForm` and its `/XFA` entry all
 * live inside a Flate-compressed object stream and the key simply is not in the
 * bytes. Real Adobe LiveCycle output is written that way.
 *
 * So the guard is now the raw scan *plus* a parsed read of `/AcroForm /XFA`
 * straight off the catalog. The parsed half has its own trap: pdf-lib deletes
 * that entry as a side effect of `getForm()` unless the document was loaded
 * with `preserveXFA`, so a check written the obvious way runs after the thing
 * it is looking for has been destroyed. `core/pdf/load.ts` now sets it.
 *
 * The fixture is built here rather than committed because the point is the
 * *encoding*: the same document is saved both ways and the two are compared.
 */
import { describe, expect, it, vi } from 'vitest';
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';

vi.mock('comlink', () => ({
  expose: vi.fn(),
  transfer: vi.fn(value => value),
  proxy: vi.fn(value => value)
}));

const { processWorkerImpl } = await import('../../src/core/workers/process.worker');
const { silentJob } = await import('../../src/core/workers/protocol');
const { hasXfaMarker, documentHasXfa } = await import('../../src/core/pdf/xfa');
const { loadPdfDocument } = await import('../../src/core/pdf/load');

/** A hybrid XFA form: an `/AcroForm` with both `/Fields` and an `/XFA` payload. */
async function xfaForm(useObjectStreams: boolean): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([300, 300]);
  const payload = doc.context.register(
    doc.context.flateStream(
      new TextEncoder().encode(
        '<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/"><template/></xdp:xdp>'
      )
    )
  );
  const acroForm = doc.context.obj({ Fields: [] }) as PDFDict;
  acroForm.set(PDFName.of('XFA'), doc.context.obj(['template', payload]));
  doc.catalog.set(PDFName.of('AcroForm'), doc.context.register(acroForm));
  return doc.save({ useObjectStreams });
}

function composeOnePage(bytes: Uint8Array) {
  return processWorkerImpl.compose(
    [{ key: 'p0', sourceDocId: 'doc1', sourceIndex: 0, rotation: 0 }],
    { doc1: bytes },
    [],
    null,
    undefined,
    null,
    null,
    undefined,
    silentJob
  );
}

describe('an object-stream-encoded XFA form is still detected (§1.7)', () => {
  it('is exactly the case the raw byte scan cannot see', async () => {
    // The premise, asserted rather than assumed: same document, two encodings,
    // two different answers from the scan.
    expect(hasXfaMarker(await xfaForm(false))).toBe(true);
    expect(hasXfaMarker(await xfaForm(true))).toBe(false);
  });

  it('is seen by the parsed catalog check in both encodings', async () => {
    for (const useObjectStreams of [false, true]) {
      const doc = await loadPdfDocument(await xfaForm(useObjectStreams));
      expect(documentHasXfa(doc), `useObjectStreams: ${useObjectStreams}`).toBe(true);
    }
  });

  it('survives pdf-lib’s getForm(), which strips /XFA without preserveXFA', async () => {
    // The trap the fix works around: `getForm()` calls `deleteXFA()` unless the
    // load asked to keep it. Without `preserveXFA` this assertion fails and
    // every `form.hasXFA()` check in the codebase is dead code.
    const doc = await loadPdfDocument(await xfaForm(true));
    expect(doc.getForm().hasXFA()).toBe(true);
    expect(documentHasXfa(doc)).toBe(true);
  });

  it('refuses to compose it instead of silently discarding the payload', async () => {
    for (const useObjectStreams of [false, true]) {
      await expect(
        composeOnePage(await xfaForm(useObjectStreams)),
        `useObjectStreams: ${useObjectStreams}`
      ).rejects.toThrow(/XFA form/);
    }
  });

  it('reports it at import, so the user is told before anything is attempted', async () => {
    const facts = await processWorkerImpl.inspect(await xfaForm(true));
    expect(facts.isXfa).toBe(true);
    expect(facts.hasAcroForm).toBe(false);
    expect(await processWorkerImpl.getFormFields(await xfaForm(true))).toEqual({
      isXfa: true,
      fields: []
    });
  });

  it('refuses to fill or flatten it', async () => {
    await expect(
      processWorkerImpl.fillFormFields(await xfaForm(true), { any: 'value' }, false)
    ).rejects.toThrow(/XFA form/);
    await expect(processWorkerImpl.flattenDocument(await xfaForm(true))).rejects.toThrow(
      /XFA form/
    );
  });

  it('still composes an ordinary AcroForm', async () => {
    const { acroformPdf } = await import('../e2e/fixtures');
    const bytes = await acroformPdf();
    expect(documentHasXfa(await loadPdfDocument(bytes))).toBe(false);
    const composed = await composeOnePage(bytes);
    expect((await PDFDocument.load(composed)).getPageCount()).toBe(1);
  });

  it('does not fire on a document with no /AcroForm at all', async () => {
    const plain = await PDFDocument.create();
    plain.addPage([100, 100]);
    const bytes = await plain.save();
    const doc = await loadPdfDocument(bytes);
    expect(documentHasXfa(doc)).toBe(false);
    // And the read-only check did not invent an /AcroForm on the way past.
    expect(doc.catalog.get(PDFName.of('AcroForm'))).toBeUndefined();
  });
});
