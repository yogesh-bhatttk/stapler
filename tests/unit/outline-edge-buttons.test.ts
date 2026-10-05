/**
 * HRD-24 §12.10 (AUDIT-FINDINGS §12) — the bookmark editor's move, indent and
 * outdent buttons are unavailable exactly where their edit would do nothing:
 * no move up for a first sibling, no move down for a last one, no outdent at
 * the top level, and indent only under a previous sibling.
 *
 * `flattenEntries`' `moves` is checked against the edits themselves (a flag is
 * false iff the edit returns the tree unchanged), and `OutlineMoveButtons` is
 * called directly — it is hook-free — so the props it renders (aria, title,
 * focusability, click) are asserted, not inferred.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { VNode } from 'preact';
import {
  flattenEntries,
  indentEntry,
  moveEntry,
  outdentEntry,
  outlineTree,
  type EntryMoves,
  type OutlineEntry
} from '../../src/ui/tools/outline/state';
import { translate } from '../../src/core/i18n';

const { OutlineMoveButtons } = await import('../../src/ui/tools/outline/OutlinePanel');

function node(id: string, children: OutlineEntry[] = []): OutlineEntry {
  return { id, title: id, pageKey: null, children } as OutlineEntry;
}

/**
 *  A
 *  ├ A1
 *  │  └ A1a
 *  └ A2
 *  B
 *  C
 *  └ C1
 */
function sampleTree(): OutlineEntry[] {
  return [node('A', [node('A1', [node('A1a')]), node('A2')]), node('B'), node('C', [node('C1')])];
}

function movesById(tree: OutlineEntry[]): Record<string, EntryMoves> {
  return Object.fromEntries(flattenEntries(tree).map(row => [row.entry.id, row.moves]));
}

describe('outline edge buttons (HRD-24 §12.10)', () => {
  beforeEach(() => {
    outlineTree.value = [];
  });

  it('computes each row’s available edits from its place in the tree', () => {
    expect(movesById(sampleTree())).toEqual({
      // First top-level item: no up, no indent (nothing above), no outdent.
      A: { up: false, down: true, indent: false, outdent: false },
      // First child: no up, no indent; nested, so it can outdent.
      A1: { up: false, down: true, indent: false, outdent: true },
      // Only child: neither move, no indent.
      A1a: { up: false, down: false, indent: false, outdent: true },
      // Last child with a sibling above it.
      A2: { up: true, down: false, indent: true, outdent: true },
      // Middle top-level item.
      B: { up: true, down: true, indent: true, outdent: false },
      // Last top-level item.
      C: { up: true, down: false, indent: true, outdent: false },
      C1: { up: false, down: false, indent: false, outdent: true }
    });
    expect(movesById([node('solo')])).toEqual({
      solo: { up: false, down: false, indent: false, outdent: false }
    });
  });

  it('a flag is false exactly when its edit would leave the tree unchanged', () => {
    const tree = sampleTree();
    const edits: Record<keyof EntryMoves, (t: OutlineEntry[], id: string) => OutlineEntry[]> = {
      up: (t, id) => moveEntry(t, id, 'up'),
      down: (t, id) => moveEntry(t, id, 'down'),
      indent: indentEntry,
      outdent: outdentEntry
    };
    for (const { entry, moves } of flattenEntries(tree)) {
      for (const key of Object.keys(edits) as (keyof EntryMoves)[]) {
        const after = edits[key](tree, entry.id);
        expect({ id: entry.id, key, changes: after !== tree }).toEqual({
          id: entry.id,
          key,
          changes: moves[key]
        });
      }
    }
  });

  it('renders boundary buttons aria-disabled with a reason, still focusable, and inert', () => {
    const tree = sampleTree();
    outlineTree.value = tree;
    const row = flattenEntries(tree).find(r => r.entry.id === 'A')!;
    const fragment = OutlineMoveButtons({ entry: row.entry, moves: row.moves, t: translate });
    const buttons = (fragment as VNode<{ children: VNode<Record<string, unknown>>[] }>).props
      .children;
    const byKey = Object.fromEntries(buttons.map(b => [String(b.key), b.props]));

    expect(Object.keys(byKey)).toEqual(['up', 'down', 'indent', 'outdent']);
    for (const key of ['up', 'indent', 'outdent']) {
      const props = byKey[key]!;
      expect(props['aria-disabled']).toBe('true');
      expect(typeof props.title).toBe('string');
      expect((props.title as string).length).toBeGreaterThan(0);
      // Not the native attribute: the button stays in the tab order, so
      // focus is not lost when an edit moves a row to an edge.
      expect(props.disabled).toBeUndefined();
      // Enter/Space on a <button> fire click; an unavailable one does nothing.
      (props.onClick as () => void)();
      expect(outlineTree.value).toBe(tree);
    }
    expect(byKey.up!.title).toBe('Already the first bookmark at this level.');
    expect(byKey.indent!.title).toBe('Indenting needs a bookmark above it at the same level.');
    expect(byKey.outdent!.title).toBe('Already at the top level.');
    expect(byKey.up!['aria-label']).toBe('Move up: A');

    const down = byKey.down!;
    expect(down['aria-disabled']).toBeUndefined();
    expect(down.title).toBeUndefined();
    (down.onClick as () => void)();
    expect(outlineTree.value.map(e => e.id)).toEqual(['B', 'A', 'C']);
  });

  it('the last row cannot move down and says why; the moved row’s buttons follow it', () => {
    let tree = sampleTree();
    outlineTree.value = tree;
    const render = (id: string) => {
      const row = flattenEntries(tree).find(r => r.entry.id === id)!;
      const fragment = OutlineMoveButtons({ entry: row.entry, moves: row.moves, t: translate });
      return Object.fromEntries(
        (fragment as VNode<{ children: VNode<Record<string, unknown>>[] }>).props.children.map(
          b => [String(b.key), b.props]
        )
      );
    };
    expect(render('C').down!['aria-disabled']).toBe('true');
    expect(render('C').down!.title).toBe('Already the last bookmark at this level.');

    // Move B up to the top: once there, its own "up" turns unavailable.
    (render('B').up!.onClick as () => void)();
    tree = outlineTree.value;
    expect(tree.map(e => e.id)).toEqual(['B', 'A', 'C']);
    expect(render('B').up!['aria-disabled']).toBe('true');
    expect(render('A').up!['aria-disabled']).toBeUndefined();
  });
});
