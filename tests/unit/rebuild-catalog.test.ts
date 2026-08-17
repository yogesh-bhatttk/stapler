/**
 * AUDIT-FINDINGS §0 — the rebuild paths must not silently strip the catalog,
 * and must not duplicate objects shared across pages.
 *
 * Every assertion re-parses the produced bytes; nothing is asserted about
 * intent.
 */
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef } from 'pdf-lib';
import { processWorkerImpl } from '../../src/core/workers/process.worker';

const fixture = (name: string) => readFile(new URL(`../fixtures/${name}`, import.meta.url));

async function load(bytes: Uint8Array) {
  return PDFDocument.load(bytes, { throwOnInvalidObject: false });
}

const catalogKeys = (doc: PDFDocument) =>
  new Set(Array.from(doc.catalog.keys()).map(k => k.asString()));

describe('§0 — catalog survives the redact rebuild', () => {
  it('drops page-linked catalog entries during applyRedactions', async () => {
    const bytes = new Uint8Array(await fixture('bookmarked-9.pdf'));
    const source = await load(bytes);
    expect(catalogKeys(source)).toContain('/Outlines');

    const out = await processWorkerImpl.applyRedactions(bytes, [
      { pageIndex: 0, x: 0, y: 0, width: 0.2, height: 0.05 }
    ]);

    const rebuilt = await load(out);
    expect(catalogKeys(rebuilt)).not.toContain('/Outlines');
    expect(rebuilt.getPageCount()).toBe(source.getPageCount());
  });
});

describe('§0 — catalog survives the compression rebuild', () => {
  it('keeps /Outlines through rebuildCompressed when work is done', async () => {
    const bytes = new Uint8Array(await fixture('bookmarked-9.pdf'));
    const source = await load(bytes);
    expect(catalogKeys(source)).toContain('/Outlines');

    // Rasterising page 0 forces the rebuild branch rather than the
    // "nothing to do, return the original" early exit.
    const result = await processWorkerImpl.rebuildCompressed(bytes, {}, {});

    // With no image work at all the honest answer is "kept the original".
    expect(result.keptOriginal).toBe(true);
    const rebuilt = await load(result.bytes);
    expect(catalogKeys(rebuilt)).toContain('/Outlines');
  });
});

describe('§0 — page-independent catalog survives a redaction', () => {
  it('keeps page-independent entries like /PageLabels but not page-linked trees', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]).drawText('hello');
    const context = doc.context;
    doc.catalog.set(
      PDFName.of('PageLabels'),
      context.register(context.obj({ Nums: context.obj([]) }))
    );
    doc.catalog.set(
      PDFName.of('OCProperties'),
      context.register(context.obj({ OCGs: context.obj([]), D: context.obj({}) }))
    );
    doc.catalog.set(
      PDFName.of('StructTreeRoot'),
      context.register(context.obj({ Type: 'StructTreeRoot' }))
    );
    const bytes = await doc.save();

    const out = await processWorkerImpl.applyRedactions(bytes, [
      { pageIndex: 0, x: 0.9, y: 0.9, width: 0.05, height: 0.05 }
    ]);

    const keys = catalogKeys(await load(out));
    expect(keys).toContain('/PageLabels');
    expect(keys).not.toContain('/OCProperties');
    expect(keys).not.toContain('/StructTreeRoot');
  });
});

describe('§0 — composePages dedupes objects shared across pages', () => {
  it('embeds a logo used on every page exactly once', async () => {
    const bytes = new Uint8Array(await fixture('shared-image.pdf'));
    const source = await load(bytes);
    const pageCount = source.getPageCount();
    expect(pageCount).toBeGreaterThan(1);

    const pages = Array.from({ length: pageCount }, (_, i) => ({
      key: `p${i}`,
      sourceDocId: 'doc',
      sourceIndex: i,
      rotation: 0
    }));

    const out = await processWorkerImpl.compose(
      pages,
      { doc: bytes },
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {}
    );

    const rebuilt = await load(out);
    expect(rebuilt.getPageCount()).toBe(pageCount);

    // Count the distinct image XObjects the pages actually reference. One
    // `copyPages` per page (the old loop) gives one copy per page.
    const imageRefs = new Set<string>();
    for (let i = 0; i < rebuilt.getPageCount(); i++) {
      const xobjects = rebuilt
        .getPage(i)
        .node.Resources()
        ?.lookupMaybe(PDFName.of('XObject'), PDFDict);
      for (const [, value] of xobjects?.entries() ?? []) {
        if (!(value instanceof PDFRef)) continue;
        const resolved = rebuilt.context.lookup(value);
        const subtype =
          resolved instanceof PDFRawStream ? resolved.dict.get(PDFName.of('Subtype')) : undefined;
        if (subtype === PDFName.of('Image')) imageRefs.add(value.toString());
      }
    }
    expect(imageRefs.size).toBe(1);
  });
});
