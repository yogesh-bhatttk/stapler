/**
 * HRD-40 — compose, extract, split and n-up must not grow a file just by
 * rebuilding it.
 *
 * Every one of them re-creates each page as a fresh `PDFPageLeaf`, which
 * `@cantoo/pdf-lib`'s writer puts outside the object streams in clear text
 * even with `useObjectStreams: true`. On a text-only file whose producer had
 * packed its page dictionaries, that alone grew the output well past the
 * input with nothing added. `compactStructuralObjects` is applied to each of
 * these rebuilds; every assertion here re-parses the produced bytes.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';

vi.mock('comlink', () => ({
  expose: vi.fn(),
  transfer: vi.fn(value => value),
  proxy: vi.fn(value => value)
}));

const { processWorkerImpl: W } = await import('../../src/core/workers/process.worker');
const { silentJob } = await import('../../src/core/workers/protocol');
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

const FIXTURE = new Uint8Array(readFileSync('tests/fixtures/100-page.pdf'));

async function pageTexts(bytes: Uint8Array): Promise<string[]> {
  const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 });
  const doc = await task.promise;
  const texts: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const content = await (await doc.getPage(n)).getTextContent();
    texts.push(content.items.map(item => ('str' in item ? item.str : '')).join(' '));
  }
  await task.destroy();
  return texts;
}

const pagesOf = (indices: number[]) =>
  indices.map(i => ({ key: `p${i}`, sourceDocId: 's', sourceIndex: i, rotation: 0 }));
const all = Array.from({ length: 100 }, (_, i) => i);

function compose(
  indices: number[],
  nup: Parameters<typeof W.compose>[6] = null
): Promise<Uint8Array> {
  return W.compose(
    pagesOf(indices),
    { s: FIXTURE.slice() },
    [],
    undefined,
    undefined,
    null,
    nup,
    undefined,
    silentJob
  );
}

/** No catalog, page-tree node or page leaf written in clear text. */
function expectStructureCompressed(bytes: Uint8Array) {
  const raw = Buffer.from(bytes).toString('latin1');
  expect(raw).not.toMatch(/\/Type\s*\/Pages?\b/);
  expect(raw).not.toMatch(/\/Type\s*\/Catalog\b/);
}

describe('rebuild output size on the 100-page fixture (HRD-40)', () => {
  // Measured on this 28.2 KB fixture: compose 46.7 KB → 27.9 KB, a five-page
  // extract 2.9 KB → 2.0 KB, once the rebuilt page leaves are compressed.
  it('compose (export of every page) is not materially larger than its input', async () => {
    const out = await compose(all);
    expect(out.length).toBeLessThanOrEqual(FIXTURE.length * 1.05);
    expectStructureCompressed(out);
    expect((await PDFDocument.load(out)).getPageCount()).toBe(100);
    const texts = await pageTexts(out);
    expect(texts).toHaveLength(100);
    texts.forEach((text, i) => expect(text).toContain(`Page ${i + 1}`));
  });

  it('extract (a subset) is smaller than its input', async () => {
    const wanted = [0, 9, 19, 49, 99];
    const out = await compose(wanted);
    expect(out.length).toBeLessThan(FIXTURE.length);
    expectStructureCompressed(out);
    const texts = await pageTexts(out);
    expect(texts).toHaveLength(wanted.length);
    wanted.forEach((page, i) => expect(texts[i]).toContain(`Page ${page + 1}`));
  });

  it('split writes every slice compactly', async () => {
    const result = await W.composeSplit(
      pagesOf(all),
      { s: FIXTURE.slice() },
      [50],
      [],
      undefined,
      undefined,
      null,
      null,
      'out',
      undefined,
      silentJob
    );
    expect(result.isZip).toBe(true);
    // Two slices of fifty pages each, zipped: together not materially more
    // than the one file they came from.
    expect(result.bytes.length).toBeLessThanOrEqual(FIXTURE.length * 1.1);
  });

  it('n-up (2-up) grows only by the per-page form wrapper it cannot avoid', async () => {
    const out = await compose(all, {
      layout: '2-up',
      margin: 18,
      gutter: 9,
      drawBorders: false
    });
    // N-up draws every source page as a Form XObject. A form is a *stream*, and
    // a stream's dictionary can never go into an object stream, so each page
    // costs one clear-text form dictionary plus its share of a sheet's content
    // stream — about 230 bytes here, against a fixture whose pages are ~280
    // bytes each. Measured on this fixture: 62.4 KB with the page leaves and
    // form resources written in clear text, 51.4 KB without. The bound is that
    // overhead, not a percentage of an unusually small input.
    expect(out.length).toBeLessThanOrEqual(FIXTURE.length + 100 * 250);
    expectStructureCompressed(out);
    expect((await PDFDocument.load(out)).getPageCount()).toBe(50);
    const texts = await pageTexts(out);
    expect(texts).toHaveLength(50);
    expect(texts[0]).toContain('Page 1');
    expect(texts[0]).toContain('Page 2');
    expect(texts[49]).toContain('Page 100');
  });
});
