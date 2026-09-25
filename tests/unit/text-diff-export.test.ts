import { describe, expect, it, vi, beforeEach } from 'vitest';
import { PDFDocument, PDFArray, PDFName } from 'pdf-lib';

/** Swappable per test: what each side's page text extracts as. */
const texts = vi.hoisted(() => ({ base: 'hello world', compare: 'hello brave new world' }));

vi.mock('../../src/core/workers', () => ({
  // CONV-14: the diff runs in the cv worker; here, the real implementation.
  cvWorker: {
    lease: async (fn: (api: unknown) => Promise<unknown>) => {
      const { diffText } = await import('../../src/core/diff');
      return fn({ diffText });
    }
  },
  renderWorker: {
    lease: vi.fn(async (fn: (api: any) => Promise<unknown>) =>
      fn({
        loadDocument: vi.fn(async (bytes: Uint8Array) => ({
          handle: bytes[0] === 1 ? 'base-handle' : 'compare-handle'
        })),
        extractText: vi.fn(async (handle: string) =>
          handle === 'base-handle' ? texts.base : texts.compare
        ),
        closeDocument: vi.fn(async () => {})
      })
    )
  }
}));

vi.mock('../../src/core/operations', () => ({
  composeDocument: vi.fn(async (req: any) => {
    return new Uint8Array([req.pages[0].sourceDocId === 'base' ? 1 : 2]);
  })
}));

import { exportTextDiff } from '../../src/core/text-diff-export';
import { sources } from '../../src/core/store';
import { writeSourceBytes } from '../../src/core/opfs';

async function decodeContentText(doc: PDFDocument, pageIndex: number): Promise<string> {
  const { decodeStream } = await import('../../src/core/pdf/interpreter');
  const page = doc.getPage(pageIndex);
  const contents = page.node.Contents();
  if (!contents) return '';
  const streams =
    contents instanceof PDFArray
      ? contents.asArray().map(ref => doc.context.lookup(ref))
      : [contents];

  let text = '';
  for (const stream of streams as any[]) {
    const raw: Uint8Array = stream.getContents();
    const isFlate = String(stream.dict?.get(PDFName.of('Filter'))) === '/FlateDecode';
    text += new TextDecoder('latin1').decode(isFlate ? await decodeStream(raw) : raw);
  }

  return text + decodeHexLiterals(text);
}

function decodeHexLiterals(content: string): string {
  let out = '';
  for (const match of content.matchAll(/<([0-9A-Fa-f\s]+)>/g)) {
    const hex = match[1].replace(/\s+/g, '');
    for (const width of [2, 4]) {
      if (hex.length % width !== 0) continue;
      let decoded = '';
      for (let i = 0; i < hex.length; i += width) {
        decoded += String.fromCharCode(parseInt(hex.slice(i, i + width), 16));
      }
      out += `\n${decoded}`;
    }
  }
  return out;
}

describe('exportTextDiff', () => {
  beforeEach(async () => {
    texts.base = 'hello world';
    texts.compare = 'hello brave new world';
    sources.value = {
      base: {
        id: 'base',
        name: 'base.pdf',
        pageCount: 1,
        pageSizes: [{ width: 612, height: 792 }]
      },
      compare: {
        id: 'compare',
        name: 'compare.pdf',
        pageCount: 1,
        pageSizes: [{ width: 612, height: 792 }]
      }
    };
    await writeSourceBytes('base', new Uint8Array([1]));
    await writeSourceBytes('compare', new Uint8Array([2]));
  });

  it('embeds the text diff chunks into a PDF report', async () => {
    const docAPages = [{ key: 'a1', sourceDocId: 'base', sourceIndex: 0, rotation: 0 }];
    const docA = {
      id: 'doc-a',
      name: 'base.pdf',
      pages: docAPages,
      baseline: docAPages,
      annotations: [],
      dirty: false
    };
    const docBPages = [{ key: 'b1', sourceDocId: 'compare', sourceIndex: 0, rotation: 0 }];
    const docB = {
      id: 'doc-b',
      name: 'compare.pdf',
      pages: docBPages,
      baseline: docBPages,
      annotations: [],
      dirty: false
    };

    const bytes = await exportTextDiff(docA, docB);
    const pdf = await PDFDocument.load(bytes);

    expect(pdf.getPageCount()).toBe(1);
    const content = await decodeContentText(pdf, 0);
    expect(content).toContain('hello');
    expect(content).toContain('brave');
    expect(content).toContain('new');
    expect(content).toContain('world');
  });

  it('warns (CONV-13) when non-Latin text had to be replaced, and only then', async () => {
    const doc = (id: string, name: string, src: string) => {
      const pages = [{ key: id, sourceDocId: src, sourceIndex: 0, rotation: 0 }];
      return { id, name, pages, baseline: pages, annotations: [], dirty: false };
    };
    const clean: string[] = [];
    await exportTextDiff(doc('a', 'base.pdf', 'base'), doc('b', 'compare.pdf', 'compare'), {
      onWarning: m => clean.push(m)
    });
    expect(clean).toEqual([]);

    texts.base = '\u041f\u0440\u0438\u0432\u0435\u0442 world';
    texts.compare = '\u041f\u0440\u0438\u0432\u0435\u0442 brave world';
    const warnings: string[] = [];
    const bytes = await exportTextDiff(
      doc('a', '\u65e5\u672c.pdf', 'base'),
      doc('b', 'compare.pdf', 'compare'),
      { onWarning: m => warnings.push(m) }
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/replaced with "\?"/);
    const content = await decodeContentText(await PDFDocument.load(bytes), 0);
    expect(content).toContain('??????');
    expect(content).toContain('brave');
  });
});
