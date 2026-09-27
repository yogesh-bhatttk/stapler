/**
 * GAP-6 — duplex interleave: the page-order logic, and the store mutation that
 * applies it (one undo step, never a dropped or duplicated page).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { defaultFrontCount, interleaveDuplex } from '../../src/core/duplex';
import {
  activeDocId,
  addDocument,
  documents,
  makePageRefs,
  registerSource,
  reorderPages,
  selectedPageKeys,
  sources,
  type StaplerDoc
} from '../../src/core/store';
import { resetHistory, undo } from '../../src/core/history';
import { __memoryFallback } from '../../src/core/opfs';

const letters = (s: string) => s.split('');

describe('interleaveDuplex', () => {
  it('even count, backs reversed (what a feeder produces)', () => {
    // Fronts F1 F2 F3, backs scanned last-sheet-first: B3 B2 B1.
    const plan = interleaveDuplex(['F1', 'F2', 'F3', 'B3', 'B2', 'B1'], 3, true);
    expect(plan.pages).toEqual(['F1', 'B1', 'F2', 'B2', 'F3', 'B3']);
    expect(plan.fit).toBe('exact');
    expect(plan.unpaired).toBe(0);
  });

  it('even count, backs already in order', () => {
    const plan = interleaveDuplex(['F1', 'F2', 'B1', 'B2'], 2, false);
    expect(plan.pages).toEqual(['F1', 'B1', 'F2', 'B2']);
  });

  it('odd count: one more front than backs — the last sheet goes at the end', () => {
    const plan = interleaveDuplex(['F1', 'F2', 'F3', 'B2', 'B1'], 3, true);
    expect(plan.pages).toEqual(['F1', 'B1', 'F2', 'B2', 'F3']);
    expect(plan.fit).toBe('last-front-alone');
    expect(plan.unpaired).toBe(1);
  });

  it('unequal counts: pairs what exists, keeps every extra page, and says so', () => {
    const plan = interleaveDuplex(letters('abcdeXY'), 5, false);
    expect(plan.pages).toEqual(['a', 'X', 'b', 'Y', 'c', 'd', 'e']);
    expect(plan.fit).toBe('mismatch');
    expect(plan.unpaired).toBe(3);
    // Nothing lost, nothing duplicated.
    expect([...plan.pages].sort()).toEqual(letters('abcdeXY').sort());
  });

  it('more backs than fronts is a mismatch too, still lossless', () => {
    const plan = interleaveDuplex(letters('aWXYZ'), 1, true);
    expect(plan.fit).toBe('mismatch');
    expect(plan.pages).toEqual(['a', 'Z', 'Y', 'X', 'W']);
  });

  it('clamps an out-of-range split', () => {
    expect(interleaveDuplex(letters('ab'), 99, true).pages).toEqual(['a', 'b']);
    expect(interleaveDuplex(letters('ab'), -3, true).pages).toEqual(['b', 'a']);
  });
});

describe('defaultFrontCount', () => {
  it('uses the boundary between two merged scans', () => {
    expect(defaultFrontCount(['a', 'a', 'a', 'b', 'b'])).toBe(3);
  });

  it('otherwise the first half, rounded up', () => {
    expect(defaultFrontCount(['a', 'a', 'a', 'a', 'a'])).toBe(3);
    expect(defaultFrontCount(['a', 'a', 'a', 'a'])).toBe(2);
    expect(defaultFrontCount(['a', 'b', 'a', 'b'])).toBe(2);
  });
});

describe('reorderPages (store)', () => {
  function seed(): StaplerDoc {
    for (const [id, count] of [
      ['fronts', 3],
      ['backs', 3]
    ] as const) {
      __memoryFallback.set(id, new Uint8Array([1]));
      registerSource({
        id,
        name: `${id}.pdf`,
        pageCount: count,
        pageSizes: Array.from({ length: count }, () => ({ width: 612, height: 792 }))
      });
    }
    const pages = [...makePageRefs('fronts', 3), ...makePageRefs('backs', 3)];
    const doc: StaplerDoc = {
      id: 'doc-1',
      name: 'scan.pdf',
      pages,
      baseline: pages,
      annotations: [],
      dirty: false
    };
    addDocument(doc);
    return doc;
  }

  beforeEach(() => {
    documents.value = [];
    sources.value = {};
    activeDocId.value = null;
    selectedPageKeys.value = new Set();
    resetHistory();
  });

  const labels = () => documents.value[0].pages.map(p => `${p.sourceDocId[0]}${p.sourceIndex + 1}`);

  it('interleaves two merged scans as one undoable step', () => {
    const doc = seed();
    const split = defaultFrontCount(doc.pages.map(p => p.sourceDocId));
    expect(split).toBe(3);
    const plan = interleaveDuplex(doc.pages, split, true);
    expect(
      reorderPages(
        doc.id,
        plan.pages.map(p => p.key)
      )
    ).toBe(true);
    // backs.pdf page 3 is the back of sheet 1 (reversed feeder order).
    expect(labels()).toEqual(['f1', 'b3', 'f2', 'b2', 'f3', 'b1']);
    undo();
    expect(labels()).toEqual(['f1', 'f2', 'f3', 'b1', 'b2', 'b3']);
  });

  it('refuses anything that is not exactly a permutation', () => {
    const doc = seed();
    const keys = doc.pages.map(p => p.key);
    expect(reorderPages(doc.id, keys.slice(1))).toBe(false);
    expect(reorderPages(doc.id, [keys[0], ...keys.slice(0, -1)])).toBe(false);
    expect(reorderPages(doc.id, [...keys.slice(1), 'not-a-key'])).toBe(false);
    expect(labels()).toEqual(['f1', 'f2', 'f3', 'b1', 'b2', 'b3']);
  });
});
