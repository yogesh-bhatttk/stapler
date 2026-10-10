/**
 * Audit 2026-10-10 T5 — DOC-06's redo half.
 *
 * `history.test.ts`'s 20-operation round trip mixes only rotate and delete,
 * and after the 20 redos asserts nothing but the page count. This mixes seven
 * operation types — rotate, delete, move, duplicate, insert (from a second
 * source), crop, and both annotation layers (SGN-02 stamps on the document,
 * ANN-01 overlay shapes) — and checks that 20 undos restore the initial model
 * and 20 redos restore the *exact* pre-undo model: pages, rotations, keys,
 * annotations, crop boxes, overlay annotations and selection, deep-equal. It
 * then composes both and compares the output page by page, so "the same
 * model" is also shown to mean "the same exported document".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFArray, PDFDocument, PDFName, type PDFRawStream } from 'pdf-lib';
import { inflateSync } from 'node:zlib';

vi.setConfig({ testTimeout: 60_000 });

vi.mock('comlink', () => ({
  expose: vi.fn(),
  transfer: vi.fn(value => value),
  proxy: vi.fn(value => value)
}));
vi.mock('../../src/core/workers', async () => {
  const { processWorkerImpl } = await import('../../src/core/workers/process.worker');
  // `any`: stands in for the pool's `Comlink.Remote<T>` wrapper.
  const run = (fn: (api: any) => unknown) => fn(processWorkerImpl);
  return { processWorker: { lease: run, pin: () => ({ lease: run, release: () => {} }) } };
});

const store = await import('../../src/core/store');
const history = await import('../../src/core/history');
const ops = await import('../../src/core/operations');
const { __memoryFallback } = await import('../../src/core/opfs');
const { cropBoxes } = await import('../../src/ui/tools/crop/state');
const overlay = await import('../../src/ui/tools/annotate/state');
const { textPdf } = await import('../e2e/fixtures');

const DOC = 'doc-r';

function registerPdf(id: string, pageCount: number, bytes: Uint8Array) {
  __memoryFallback.set(id, bytes);
  store.registerSource({
    id,
    name: `${id}.pdf`,
    pageCount,
    pageSizes: Array.from({ length: pageCount }, () => ({ width: 595.28, height: 841.89 }))
  } as Parameters<typeof store.registerSource>[0]);
}

function current() {
  return store.documents.value.find(d => d.id === DOC)!;
}

/** Everything an undo snapshot restores, as plain data. */
function model() {
  return structuredClone({
    documents: store.documents.value,
    selection: [...store.selectedPageKeys.value].sort(),
    cropBoxes: cropBoxes.value,
    pageAnnotations: overlay.pageAnnotations.value
  });
}

/**
 * Rotation, crop box and drawn text of every exported page — what the compose
 * actually wrote. Every page's content streams are concatenated and inflated,
 * so the stamp text and the source page's own heading both count.
 */
async function exported(): Promise<{ rotation: number; crop: string; text: string }[]> {
  const doc = current();
  const bytes = await ops.composeDocument({
    pages: doc.pages,
    annotations: doc.annotations,
    cropBoxes: cropBoxes.value
  });
  const out = await PDFDocument.load(bytes);
  return out.getPages().map(page => {
    const contents = page.node.Contents();
    const refs = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
    let text = '';
    for (const ref of refs) {
      const stream = out.context.lookup(ref) as PDFRawStream;
      const raw = Buffer.from(stream.getContents());
      const flate = String(stream.dict.get(PDFName.of('Filter'))) === '/FlateDecode';
      text += (flate ? inflateSync(raw) : raw).toString('latin1');
    }
    return {
      rotation: page.getRotation().angle,
      crop: JSON.stringify(page.getCropBox()),
      text
    };
  });
}

beforeEach(async () => {
  store.documents.value = [];
  store.sources.value = {};
  store.activeDocId.value = null;
  store.selectedPageKeys.value = new Set();
  cropBoxes.value = {};
  overlay.pageAnnotations.value = {};
  history.resetHistory();
  registerPdf('src-a', 12, await textPdf(12));
  registerPdf('src-b', 3, await textPdf(3));
  const pages = store.makePageRefs('src-a', 12);
  store.addDocument({ id: DOC, name: 'a.pdf', pages, annotations: [], dirty: false });
});

describe('DOC-06 — 20 mixed operations, 20 undos, 20 redos', () => {
  it('redo restores the exact pre-undo model, not merely the page count', async () => {
    const initial = model();
    const key = (i: number) => current().pages[i].key;

    const steps: (() => void)[] = [
      () => store.rotatePages(DOC, [key(0)], 90),
      () => store.deletePages(DOC, [key(11)]),
      () => store.movePages(DOC, [key(0)], 4),
      () => store.duplicatePages(DOC, [key(2)]),
      () => store.insertPages(DOC, store.makePageRefs('src-b', 2), 3),
      () => {
        history.commit(DOC, 'crop');
        cropBoxes.value = {
          ...cropBoxes.value,
          [key(1)]: { x: 0.1, y: 0.1, width: 0.6, height: 0.5 }
        };
      },
      () => {
        history.commit(DOC, 'annotate');
        overlay.addAnnotation(key(5), {
          id: 'shape-1',
          type: 'rectangle',
          color: '#ff0000',
          strokeWidth: 0.01,
          rect: { x: 0.2, y: 0.2, width: 0.3, height: 0.1 }
        });
      },
      () =>
        store.addAnnotation(DOC, {
          id: 'stamp-1',
          type: 'text',
          pageKey: key(6),
          x: 0.1,
          y: 0.8,
          width: 0.4,
          height: 0.05,
          data: 'Approved'
        }),
      () => store.rotatePages(DOC, [key(3), key(4)], 270),
      () => store.deletePages(DOC, [key(7)]),
      () => store.movePages(DOC, [key(8)], 0),
      () => store.duplicatePages(DOC, [key(0), key(1)]),
      () => {
        history.commit(DOC, 'crop');
        cropBoxes.value = { ...cropBoxes.value, [key(2)]: { x: 0, y: 0.5, width: 1, height: 0.5 } };
      },
      () => store.insertPages(DOC, store.makePageRefs('src-b', 1), 0),
      () => store.rotatePages(DOC, [key(9)], 180),
      () => {
        history.commit(DOC, 'annotate');
        overlay.updateAnnotation(
          Object.keys(overlay.pageAnnotations.value).find(
            k => overlay.pageAnnotations.value[k].length > 0
          )!,
          'shape-1',
          { color: '#0000ff' }
        );
      },
      () => store.deletePages(DOC, [key(1), key(2)]),
      () => store.movePages(DOC, [key(current().pages.length - 1)], 2),
      () => store.duplicatePages(DOC, [key(5)]),
      () => store.rotatePages(DOC, [key(0)], 90)
    ];
    expect(steps).toHaveLength(20);
    for (const step of steps) {
      store.setPageSelection([key(1)]);
      step();
    }

    const before = model();
    const exportedBefore = await exported();
    // Non-vacuous: the export really carries the stamp, a crop and the rotations.
    const approvedHex = Buffer.from('Approved', 'latin1').toString('hex').toUpperCase();
    expect(
      exportedBefore.some(
        p => p.text.includes('Approved') || p.text.toUpperCase().includes(approvedHex)
      )
    ).toBe(true);
    expect(new Set(exportedBefore.map(p => p.crop)).size).toBeGreaterThan(1);
    expect(new Set(exportedBefore.map(p => p.rotation)).size).toBeGreaterThan(1);
    expect(before).not.toEqual(initial);
    expect(history.operationLog(DOC)).toHaveLength(20);

    for (let i = 0; i < 20; i++) history.undo();
    expect(history.canUndo(DOC)).toBe(false);
    const undone = model();
    expect(undone.documents).toEqual(initial.documents);
    expect(undone.cropBoxes).toEqual({});
    // An undone overlay leaves at most empty per-page arrays behind.
    expect(Object.values(undone.pageAnnotations).flat()).toEqual([]);

    for (let i = 0; i < 20; i++) history.redo();
    expect(history.canRedo(DOC)).toBe(false);
    expect(model()).toEqual(before);
    expect(history.operationLog(DOC)).toHaveLength(20);

    // And the document that would be exported is the same one, page for page.
    expect(await exported()).toEqual(exportedBefore);
  });
});
