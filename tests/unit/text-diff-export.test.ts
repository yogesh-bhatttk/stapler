import { describe, expect, it, vi, beforeEach } from 'vitest';
import { PDFDocument, PDFArray, PDFName } from 'pdf-lib';

vi.mock('../../src/core/workers', () => ({
  renderWorker: {
    lease: vi.fn(async (fn: (api: any) => Promise<unknown>) =>
      fn({
        loadDocument: vi.fn(async (bytes: Uint8Array) => ({
          handle: bytes[0] === 1 ? 'base-handle' : 'compare-handle'
        })),
        extractText: vi.fn(async (handle: string) =>
          handle === 'base-handle' ? 'hello world' : 'hello brave new world'
        ),
        closeDocument: vi.fn(async () => {})
      })
    )
  }
}));

import { exportTextDiff } from '../../src/core/text-diff-export';
import { sources } from '../../src/core/store';

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
  beforeEach(() => {
    sources.value = {
      base: {
        id: 'base',
        bytes: new Uint8Array([1]),
        name: 'base.pdf',
        pageCount: 1,
        pageSizes: [{ width: 612, height: 792 }]
      },
      compare: {
        id: 'compare',
        bytes: new Uint8Array([2]),
        name: 'compare.pdf',
        pageCount: 1,
        pageSizes: [{ width: 612, height: 792 }]
      }
    };
  });

  it('embeds the text diff chunks into a PDF report', async () => {
    const docA = {
      id: 'doc-a',
      name: 'base.pdf',
      pages: [{ key: 'a1', sourceDocId: 'base', sourceIndex: 0, rotation: 0 }],
      annotations: [],
      dirty: false
    };
    const docB = {
      id: 'doc-b',
      name: 'compare.pdf',
      pages: [{ key: 'b1', sourceDocId: 'compare', sourceIndex: 0, rotation: 0 }],
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
});
