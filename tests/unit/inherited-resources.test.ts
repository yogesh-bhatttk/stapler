import { describe, it, expect } from 'vitest';
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';

/**
 * `/Resources` is one of the PDF attributes a page is allowed to omit and
 * inherit from its nearest `/Pages` ancestor instead (PDF 32000-1 §7.7.3.4).
 * pdf-lib's high-level API always writes `/Resources` directly onto the page
 * it creates, so this fixture moves it up to the tree's root `/Pages` node by
 * hand — the one shape that exercises the inherited-lookup path at all.
 */
async function pdfWithInheritedResources(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([200, 200]);
  const png = await doc.embedPng(
    // A trivial 1x1 red PNG, embedded just to give the page an /XObject entry.
    Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
      ),
      c => c.charCodeAt(0)
    )
  );
  // Covers the page's bottom 80% (PDF space, origin bottom-left) — large
  // enough that a small mark at the very top of the page overlaps only its
  // edge, not the whole image.
  page.drawImage(png, { x: 0, y: 0, width: 200, height: 160 });

  const resourcesRef = page.node.get(PDFName.of('Resources'));
  expect(resourcesRef).toBeDefined();
  page.node.delete(PDFName.of('Resources'));

  const pagesNode = doc.catalog.Pages();
  pagesNode.set(PDFName.of('Resources'), resourcesRef!);

  // Confirms the fixture is what it claims: no /Resources on the page itself.
  expect(page.node.get(PDFName.of('Resources'))).toBeUndefined();
  expect(page.node.Resources()).toBeInstanceOf(PDFDict);

  return doc.save();
}

describe('pageXObjectDictOf resolves inherited /Resources (RED-02/RED-08 shared fix)', () => {
  it('planPageImages finds an image on a page with no /Resources of its own', async () => {
    const { processWorkerImpl } = await import('../../src/core/workers/process.worker');
    const bytes = await pdfWithInheritedResources();

    const plan = await processWorkerImpl.planPageImages(bytes, [0]);

    expect(plan.unaddressablePages).toEqual([]);
    expect(plan.images).toHaveLength(1);
    expect(plan.images[0].pageIndex).toBe(0);
  });

  it('planImageRedactions finds the same image for a mark placed over it', async () => {
    const { processWorkerImpl } = await import('../../src/core/workers/process.worker');
    const bytes = await pdfWithInheritedResources();

    // Only *partial* image coverage reaches `pageXObjectDictOf` here — a mark
    // that fully covers an image needs no pixel-level surgery, since the
    // opaque rectangle drawn over it already hides everything. Normalised
    // page-fraction space, origin top-left: the image covers y in [0.2, 1.0]
    // (PDF space, bottom 80%), so a mark over the page's very top (y in
    // [0, 0.3]) overlaps only its edge.
    const requests = await processWorkerImpl.planImageRedactions(bytes, [
      { pageIndex: 0, x: 0, y: 0, width: 0.3, height: 0.3 }
    ]);

    expect(requests.length).toBeGreaterThan(0);
  });
});
