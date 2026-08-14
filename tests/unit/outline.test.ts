/**
 * OPS-10 / OPS-11 / OPS-12 — the parts that can be judged on real output bytes in
 * Node: the outline read/write round trip, the Bates stamp's sequence, and the
 * filenames a bookmark split produces.
 *
 * Everything here drives `process.worker.ts` itself and re-parses what it emitted,
 * the same way `golden.test.ts` does; the tree edits are pure functions and are
 * asserted directly.
 */
import { describe, expect, it, vi } from 'vitest';
import { PDFDocument, PDFName, PDFDict, PDFString, PDFNumber, StandardFonts } from 'pdf-lib';
import { unzipSync } from 'fflate';

vi.mock('comlink', () => ({
  expose: vi.fn(),
  transfer: vi.fn(val => val)
}));

import { processWorkerImpl } from '../../src/core/workers/process.worker';
import type { OutlineNode } from '../../src/core/workers/process.worker';
import { silentJob } from '../../src/core/workers/protocol';
import { batesLabel } from '../../src/core/bates';
import { sanitizeFileStem, splitBoundaries } from '../../src/core/operations';
import {
  appendEntry,
  deleteEntry,
  entriesFromNodes,
  entriesToNodes,
  indentEntry,
  moveEntry,
  newEntry,
  editTree,
  outdentEntry,
  outlineEdited,
  outlineTree,
  renameEntry,
  topLevelSlices,
  type OutlineEntry
} from '../../src/ui/tools/outline/state';

/** A document of `pageCount` pages, each carrying its own number as visible text. */
async function numberedPdf(pageCount: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pageCount; i++) {
    const page = doc.addPage([595.28, 841.89]);
    page.drawText(`body page ${i + 1}`, { x: 56, y: 780, size: 14, font });
  }
  return doc.save();
}

/**
 * The same document, plus a real `/Outlines` tree: `titles[i]` points at the page
 * index `titles[i].page`, with optional children one level down.
 */
async function outlinedPdf(
  pageCount: number,
  entries: { title: string; page: number; children?: { title: string; page: number }[] }[]
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(await numberedPdf(pageCount));
  const ctx = doc.context;
  const pages = doc.getPages();
  const outlines = ctx.obj({ Type: 'Outlines' });
  const outlinesRef = ctx.register(outlines);

  const register = (
    list: { title: string; page: number; children?: { title: string; page: number }[] }[],
    parentRef: ReturnType<typeof ctx.register>
  ) => {
    let firstRef: ReturnType<typeof ctx.register> | undefined;
    let prevRef: ReturnType<typeof ctx.register> | undefined;
    let lastRef: ReturnType<typeof ctx.register> | undefined;
    for (const item of list) {
      const dict = ctx.obj({
        Title: PDFString.of(item.title),
        Parent: parentRef,
        Dest: [pages[item.page].ref, PDFName.of('Fit')]
      });
      const ref = ctx.register(dict);
      if (!firstRef) firstRef = ref;
      if (prevRef) {
        ctx.lookup(prevRef, PDFDict).set(PDFName.of('Next'), ref);
        dict.set(PDFName.of('Prev'), prevRef);
      }
      prevRef = ref;
      lastRef = ref;
      if (item.children?.length) {
        const kids = register(item.children, ref);
        dict.set(PDFName.of('First'), kids.firstRef!);
        dict.set(PDFName.of('Last'), kids.lastRef!);
        dict.set(PDFName.of('Count'), PDFNumber.of(item.children.length));
      }
    }
    return { firstRef, lastRef };
  };

  const top = register(entries, outlinesRef);
  outlines.set(PDFName.of('First'), top.firstRef!);
  outlines.set(PDFName.of('Last'), top.lastRef!);
  outlines.set(PDFName.of('Count'), PDFNumber.of(entries.length));
  doc.catalog.set(PDFName.of('Outlines'), outlinesRef);
  return doc.save();
}

/** Page refs for a whole source document, as the store would build them. */
function pageRefs(sourceDocId: string, pageCount: number) {
  return Array.from({ length: pageCount }, (_, i) => ({
    key: `${sourceDocId}:${i}`,
    sourceDocId,
    sourceIndex: i,
    rotation: 0
  }));
}

/** Every page's drawn text, decoded from the raw content streams. */
async function drawnText(bytes: Uint8Array): Promise<string[]> {
  const { decodeStream } = await import('../../src/core/pdf/interpreter');
  const { PDFArray } = await import('pdf-lib');
  const doc = await PDFDocument.load(bytes);
  const out: string[] = [];
  for (let i = 0; i < doc.getPageCount(); i++) {
    const contents = doc.getPage(i).node.Contents();
    const streams =
      contents instanceof PDFArray
        ? contents.asArray().map(ref => doc.context.lookup(ref))
        : contents
          ? [contents]
          : [];
    let text = '';
    for (const stream of streams) {
      // Only raw streams carry bytes; anything else is not page content.
      const raw = (stream as { getContents(): Uint8Array }).getContents();
      const filter = String(
        (stream as { dict?: { get(name: PDFName): unknown } }).dict?.get(PDFName.of('Filter'))
      );
      text += new TextDecoder('latin1').decode(
        filter === '/FlateDecode' ? await decodeStream(raw) : raw
      );
    }
    // pdf-lib writes show-text operands as hex when the font is embedded, so decode
    // `<...> Tj` too — otherwise every assertion here would pass vacuously.
    for (const match of text.matchAll(/<([0-9A-Fa-f]+)>/g)) {
      const hex = match[1];
      if (hex.length % 2 !== 0) continue;
      let decoded = '';
      for (let at = 0; at < hex.length; at += 2) {
        decoded += String.fromCharCode(parseInt(hex.slice(at, at + 2), 16));
      }
      text += `\n${decoded}`;
    }
    out.push(text);
  }
  return out;
}

describe('OPS-10: outline read/write', () => {
  it('reads an existing outline as a tree, nesting and all', async () => {
    const bytes = await outlinedPdf(6, [
      { title: 'One', page: 0, children: [{ title: 'One.a', page: 1 }] },
      { title: 'Two', page: 3 }
    ]);
    const tree = await processWorkerImpl.readOutline(bytes);
    expect(tree).toEqual([
      { title: 'One', pageIndex: 0, children: [{ title: 'One.a', pageIndex: 1, children: [] }] },
      { title: 'Two', pageIndex: 3, children: [] }
    ]);
  });

  it('reports an unresolvable destination rather than dropping or guessing it', async () => {
    const doc = await PDFDocument.load(await numberedPdf(2));
    const ctx = doc.context;
    const outlines = ctx.obj({ Type: 'Outlines' });
    const outlinesRef = ctx.register(outlines);
    // A named destination: a name-tree lookup this codebase does not do.
    const item = ctx.obj({
      Title: PDFString.of('Named'),
      Parent: outlinesRef,
      Dest: PDFName.of('chapter.one')
    });
    const ref = ctx.register(item);
    outlines.set(PDFName.of('First'), ref);
    outlines.set(PDFName.of('Last'), ref);
    doc.catalog.set(PDFName.of('Outlines'), outlinesRef);

    const tree = await processWorkerImpl.readOutline(await doc.save());
    expect(tree).toEqual([{ title: 'Named', pageIndex: -1, children: [] }]);
  });

  /** The acceptance criterion: add + rename + delete survives export and re-import. */
  it('round-trips an edited tree through export and re-import, exactly as left', async () => {
    const source = await outlinedPdf(5, [
      { title: 'Chapter 1', page: 0, children: [{ title: 'Section 1.1', page: 1 }] },
      { title: 'Chapter 2', page: 2 },
      { title: 'Chapter 3 (doomed)', page: 4 }
    ]);
    const pages = pageRefs('src', 5);
    const keys = pages.map(page => page.key);

    // Load into the editor's model exactly as the panel does…
    let tree = entriesFromNodes(await processWorkerImpl.readOutline(source), keys);
    // …then rename, delete, add, reorder, and reindent.
    tree = renameEntry(tree, tree[0].id, 'Preface');
    tree = deleteEntry(tree, tree[2].id);
    tree = appendEntry(tree, newEntry('Appendix', keys[3]));
    tree = moveEntry(tree, tree[1].id, 'down');
    const appendix = tree[2];
    tree = indentEntry(tree, appendix.id);

    const exported = await processWorkerImpl.compose(
      pages,
      { src: source },
      [],
      undefined,
      undefined,
      null,
      null,
      undefined,
      silentJob,
      { outline: entriesToNodes(tree, keys) }
    );

    const reread = await processWorkerImpl.readOutline(exported);
    expect(reread).toEqual([
      {
        title: 'Preface',
        pageIndex: 0,
        children: [{ title: 'Section 1.1', pageIndex: 1, children: [] }]
      },
      {
        title: 'Appendix',
        pageIndex: 3,
        children: [{ title: 'Chapter 2', pageIndex: 2, children: [] }]
      }
    ]);
    expect((await PDFDocument.load(exported)).getPageCount()).toBe(5);
  });

  it('an emptied tree exports a document with no outline at all', async () => {
    const source = await outlinedPdf(2, [{ title: 'Only', page: 0 }]);
    const exported = await processWorkerImpl.compose(
      pageRefs('src', 2),
      { src: source },
      [],
      undefined,
      undefined,
      null,
      null,
      undefined,
      silentJob,
      { outline: [] }
    );
    expect(await processWorkerImpl.readOutline(exported)).toEqual([]);
    const out = await PDFDocument.load(exported);
    expect(out.catalog.lookupMaybe(PDFName.of('Outlines'), PDFDict)).toBeUndefined();
  });

  it('writes a title that would break a literal PDF string', async () => {
    const source = await numberedPdf(1);
    const outline: OutlineNode[] = [
      { title: 'Costs (2024) \\ Ünïcode )(', pageIndex: 0, children: [] }
    ];
    const exported = await processWorkerImpl.compose(
      pageRefs('src', 1),
      { src: source },
      [],
      undefined,
      undefined,
      null,
      null,
      undefined,
      silentJob,
      { outline }
    );
    expect(await processWorkerImpl.readOutline(exported)).toEqual(outline);
  });
});

describe('OPS-10: tree edits', () => {
  const tree: OutlineEntry[] = [
    { id: 'a', title: 'A', pageKey: 'p0', children: [] },
    {
      id: 'b',
      title: 'B',
      pageKey: 'p1',
      children: [{ id: 'b1', title: 'B1', pageKey: 'p2', children: [] }]
    }
  ];

  it('indents into the previous sibling and outdents back out again', () => {
    const indented = indentEntry(tree, 'b');
    expect(indented).toHaveLength(1);
    expect(indented[0].children.map(c => c.id)).toEqual(['b']);
    // The subtree travels with it.
    expect(indented[0].children[0].children.map(c => c.id)).toEqual(['b1']);
    expect(outdentEntry(indented, 'b').map(entry => entry.id)).toEqual(['a', 'b']);
  });

  it('leaves a first child and a top-level entry alone', () => {
    expect(indentEntry(tree, 'a')).toBe(tree);
    expect(outdentEntry(tree, 'a')).toBe(tree);
    expect(moveEntry(tree, 'a', 'up')).toBe(tree);
    expect(moveEntry(tree, 'b', 'down')).toBe(tree);
  });

  it('promotes a nested entry to just after its parent', () => {
    expect(outdentEntry(tree, 'b1').map(entry => entry.id)).toEqual(['a', 'b', 'b1']);
  });

  it("marks the tree as the user's only on a real change", () => {
    outlineTree.value = tree;
    outlineEdited.value = false;

    // A no-op edit (indenting a first child) must not claim the outline, or merely
    // opening the panel would drop a merged-in document's carried-through bookmarks.
    editTree(current => indentEntry(current, 'a'));
    expect(outlineEdited.value).toBe(false);

    editTree(current => renameEntry(current, 'a', 'Renamed'));
    expect(outlineEdited.value).toBe(true);
    expect(outlineTree.value[0].title).toBe('Renamed');
  });

  it('resolves page keys to output indexes, and a deleted page to no destination', () => {
    expect(entriesToNodes(tree, ['p0', 'p1', 'p2'])).toEqual([
      { title: 'A', pageIndex: 0, children: [] },
      { title: 'B', pageIndex: 1, children: [{ title: 'B1', pageIndex: 2, children: [] }] }
    ]);
    expect(entriesToNodes(tree, ['p0'])[1].pageIndex).toBe(-1);
  });
});

describe('OPS-11: Bates numbering', () => {
  it('pads and increments, and never truncates a number wider than the field', () => {
    expect(batesLabel({ prefix: 'ACME-', digits: 6, start: 1 }, 0)).toBe('ACME-000001');
    expect(batesLabel({ prefix: '', digits: 6, start: 1 }, 19)).toBe('000020');
    expect(batesLabel({ prefix: '', digits: 2, start: 999 }, 0)).toBe('999');
    expect(batesLabel({ prefix: 'X', digits: 0, start: 0 }, 0)).toBe('X0');
  });

  /** The acceptance criterion, read back off the exported bytes. */
  it('stamps 20 pages strictly sequentially from 000001', async () => {
    const source = await numberedPdf(20);
    const exported = await processWorkerImpl.compose(
      pageRefs('src', 20),
      { src: source },
      [],
      undefined,
      undefined,
      null,
      null,
      undefined,
      silentJob,
      { bates: { prefix: '', digits: 6, start: 1, position: 'bottom-right', fontSize: 10 } }
    );

    const texts = await drawnText(exported);
    expect(texts).toHaveLength(20);
    texts.forEach((text, index) => {
      expect(text).toContain(String(index + 1).padStart(6, '0'));
      // The page's own content is still there — the stamp is additive.
      expect(text).toContain(`body page ${index + 1}`);
    });
  });

  it('is independent of the header/footer page-number stamp', async () => {
    const source = await numberedPdf(3);
    const exported = await processWorkerImpl.compose(
      pageRefs('src', 3),
      { src: source },
      [],
      undefined,
      {
        headerText: '',
        headerAlign: 'center',
        footerText: 'Page {n} of {total}',
        footerAlign: 'center',
        fontSize: 10,
        pageRange: 'all'
      },
      null,
      null,
      undefined,
      silentJob,
      { bates: { prefix: 'BATES', digits: 4, start: 500, position: 'bottom-right', fontSize: 9 } }
    );

    const texts = await drawnText(exported);
    expect(texts[0]).toContain('BATES0500');
    expect(texts[0]).toContain('Page 1 of 3');
    expect(texts[2]).toContain('BATES0502');
    expect(texts[2]).toContain('Page 3 of 3');
  });

  it('keeps numbering continuous across the files of a split', async () => {
    const source = await numberedPdf(4);
    const result = await processWorkerImpl.composeSplit(
      pageRefs('src', 4),
      { src: source },
      [2],
      [],
      undefined,
      undefined,
      null,
      null,
      'doc',
      undefined,
      silentJob,
      { bates: { prefix: '', digits: 3, start: 1, position: 'bottom-left', fontSize: 10 } }
    );
    const files = unzipSync(result.bytes);
    const names = Object.keys(files).sort();
    expect(names).toHaveLength(2);
    expect(await drawnText(files[names[0]])).toEqual([
      expect.stringContaining('001'),
      expect.stringContaining('002')
    ]);
    expect(await drawnText(files[names[1]])).toEqual([
      expect.stringContaining('003'),
      expect.stringContaining('004')
    ]);
  });
});

describe('OPS-12: split by bookmarks', () => {
  it('derives boundaries from top-level bookmark starts, folding front matter in', () => {
    // Bookmarks on pages 0, 4, 7 of a 10-page document → cuts at 4 and 7.
    expect(splitBoundaries('bookmarks', 10, { bookmarkStarts: [0, 4, 7] })).toEqual([4, 7]);
    // A cover before the first bookmark belongs to the first file, not a fourth one.
    expect(splitBoundaries('bookmarks', 10, { bookmarkStarts: [2, 5] })).toEqual([5]);
    // Junk, duplicates, and out-of-range starts cannot produce an empty file.
    expect(splitBoundaries('bookmarks', 10, { bookmarkStarts: [0, 0, 4, 4, 99, -1] })).toEqual([4]);
    expect(splitBoundaries('bookmarks', 10, { bookmarkStarts: [] })).toEqual([]);
  });

  it('preserves every page exactly once, like the other modes', () => {
    const pageCount = 60;
    const starts = [0, 1, 7, 30, 31, 59];
    const boundaries = splitBoundaries('bookmarks', pageCount, { bookmarkStarts: starts });
    const slices: number[][] = [];
    let from = 0;
    for (const cut of boundaries) {
      slices.push(Array.from({ length: cut - from }, (_, i) => from + i));
      from = cut;
    }
    slices.push(Array.from({ length: pageCount - from }, (_, i) => from + i));

    expect(slices.flat()).toEqual(Array.from({ length: pageCount }, (_, i) => i));
    expect(slices).toHaveLength(starts.length); // exactly N files for N bookmarks
    for (const slice of slices) expect(slice.length).toBeGreaterThan(0);
  });

  it('collapses two bookmarks on one page to a single slice, keeping names in step', () => {
    const tree = [
      { id: '1', title: 'Intro', pageKey: 'p0', children: [] },
      { id: '2', title: 'Also intro', pageKey: 'p0', children: [] },
      { id: '3', title: 'Body', pageKey: 'p2', children: [] }
    ];
    const slices = topLevelSlices(tree, ['p0', 'p1', 'p2']);
    expect(slices).toEqual([
      { title: 'Intro', pageIndex: 0 },
      { title: 'Body', pageIndex: 2 }
    ]);
    expect(
      splitBoundaries('bookmarks', 3, { bookmarkStarts: slices.map(s => s.pageIndex) })
    ).toHaveLength(slices.length - 1);
  });

  it('sanitizes a bookmark title into a filename without collapsing distinct titles', () => {
    expect(sanitizeFileStem('Chapter 1: Beginnings', 'x')).toBe('Chapter 1- Beginnings');
    expect(sanitizeFileStem('a/b', 'x')).toBe('a-b');
    expect(sanitizeFileStem('a\\b', 'x')).toBe('a-b');
    expect(sanitizeFileStem('  ', 'fallback')).toBe('fallback');
    // Nothing that could escape the archive's directory or hide the file.
    const traversal = sanitizeFileStem('../../etc/passwd', 'x');
    expect(traversal).not.toContain('/');
    expect(traversal.startsWith('.')).toBe(false);
    expect(sanitizeFileStem('x'.repeat(200), 'y')).toHaveLength(80);
  });

  /** The acceptance criterion, on real output: N bookmarks → N named files. */
  it('produces exactly one named file per top-level bookmark, covering every page', async () => {
    const source = await outlinedPdf(9, [
      { title: 'Cover', page: 0 },
      { title: 'Chapter 2: Costs', page: 3, children: [{ title: 'Ignored child', page: 4 }] },
      { title: 'Appendix', page: 6 }
    ]);
    const pages = pageRefs('src', 9);
    const keys = pages.map(page => page.key);
    const tree = entriesFromNodes(await processWorkerImpl.readOutline(source), keys);
    const slices = topLevelSlices(tree, keys);
    expect(slices).toHaveLength(3);

    const boundaries = splitBoundaries('bookmarks', 9, {
      bookmarkStarts: slices.map(slice => slice.pageIndex)
    });
    const result = await processWorkerImpl.composeSplit(
      pages,
      { src: source },
      boundaries,
      [],
      undefined,
      undefined,
      null,
      null,
      'doc',
      undefined,
      silentJob,
      { fileNames: slices.map(slice => sanitizeFileStem(slice.title, 'part')) }
    );

    const files = unzipSync(result.bytes);
    expect(Object.keys(files).sort()).toEqual([
      'Appendix.pdf',
      'Chapter 2- Costs.pdf',
      'Cover.pdf'
    ]);

    // Page counts union to the input with no overlap, and the text proves which
    // pages landed where.
    const counts: Record<string, number> = {};
    for (const [name, bytes] of Object.entries(files)) {
      counts[name] = (await PDFDocument.load(bytes)).getPageCount();
    }
    expect(counts).toEqual({ 'Cover.pdf': 3, 'Chapter 2- Costs.pdf': 3, 'Appendix.pdf': 3 });
    expect((await drawnText(files['Appendix.pdf']))[0]).toContain('body page 7');
  });

  it('does not lose a file when two bookmarks share a title', async () => {
    const source = await outlinedPdf(4, [
      { title: 'Appendix', page: 0 },
      { title: 'Appendix', page: 2 }
    ]);
    const pages = pageRefs('src', 4);
    const result = await processWorkerImpl.composeSplit(
      pages,
      { src: source },
      [2],
      [],
      undefined,
      undefined,
      null,
      null,
      'doc',
      undefined,
      silentJob,
      { fileNames: ['Appendix', 'Appendix'] }
    );
    expect(Object.keys(unzipSync(result.bytes)).sort()).toEqual(['Appendix-2.pdf', 'Appendix.pdf']);
  });
});
