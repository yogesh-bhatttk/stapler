/**
 * OPS-10 — the bookmark tree the user is editing, and the pure edits on it.
 *
 * The tree is held in workspace terms, not PDF terms: each entry points at a
 * *page key*, the same identity `core/store.ts` uses, so a bookmark keeps pointing
 * at the right page when pages are reordered or deleted before export. It is
 * resolved back to an output page index only at commit time.
 *
 * Every mutation here is a pure function over an immutable tree, so the panel's
 * buttons are one-liners and the behaviour is unit-testable without a DOM.
 */
import { signal } from '@preact/signals';
import type { OutlineNode } from '../../../core/workers/process.worker';

export interface OutlineEntry {
  /** Stable identity for keying rows and addressing edits. Not written to the PDF. */
  id: string;
  title: string;
  /** The page this bookmark opens, or null for a heading with no destination. */
  pageKey: string | null;
  children: OutlineEntry[];
}

/** The tree being edited, and which document it was loaded from. */
export const outlineTree = signal<OutlineEntry[]>([]);
export const outlineDocId = signal<string | null>(null);
export const outlineLoading = signal(false);
/**
 * Whether the user has actually changed anything.
 *
 * Export only overrides the document's outline when this is true. Merely opening the
 * panel must not narrow OPS-01's merge-time carry-through: this tree is read from the
 * *first* page's source document, so writing it back unedited would drop the bookmarks
 * a second merged-in document contributed.
 */
export const outlineEdited = signal(false);

/** Applies a tree edit and records that the outline is now the user's, not the file's. */
export function editTree(edit: (tree: OutlineEntry[]) => OutlineEntry[]): void {
  const next = edit(outlineTree.value);
  if (next === outlineTree.value) return;
  outlineTree.value = next;
  outlineEdited.value = true;
}
/**
 * How many source entries arrived with a destination this code does not resolve —
 * a named destination or a non-`GoTo` action, the limit OPS-01's `copyOutlines`
 * documents. They are kept in the tree (dropping them would silently flatten the
 * user's structure) but they export as plain headings, and the panel says so.
 */
export const outlineUnresolved = signal(0);

let counter = 0;
function nextId(): string {
  counter += 1;
  return `ol-${counter}`;
}

/**
 * Turns what the worker read into editable entries, resolving pages to page keys.
 *
 * `pageKeys` is indexed by *source* page index and may be sparse — a page the user
 * already deleted from the workspace has no key, and its bookmark becomes a
 * destination-less heading rather than silently pointing somewhere else.
 */
export function entriesFromNodes(
  nodes: OutlineNode[],
  pageKeys: readonly (string | undefined)[]
): OutlineEntry[] {
  return nodes.map(node => ({
    id: nextId(),
    title: node.title,
    pageKey: node.pageIndex >= 0 ? (pageKeys[node.pageIndex] ?? null) : null,
    children: entriesFromNodes(node.children, pageKeys)
  }));
}

/** Counts entries whose destination could not be resolved to a page. */
export function countUnresolved(nodes: OutlineNode[]): number {
  return nodes.reduce(
    (total, node) => total + (node.pageIndex < 0 ? 1 : 0) + countUnresolved(node.children),
    0
  );
}

/** Resolves the tree back to output page indexes for the worker. */
export function entriesToNodes(entries: OutlineEntry[], pageKeys: string[]): OutlineNode[] {
  const indexByKey = new Map(pageKeys.map((key, index) => [key, index]));
  const convert = (entry: OutlineEntry): OutlineNode => ({
    title: entry.title.trim() || 'Untitled',
    pageIndex: entry.pageKey === null ? -1 : (indexByKey.get(entry.pageKey) ?? -1),
    children: entry.children.map(convert)
  });
  return entries.map(convert);
}

export function newEntry(title: string, pageKey: string | null): OutlineEntry {
  return { id: nextId(), title, pageKey, children: [] };
}

/**
 * Rewrites the sibling list that contains `id`. `fn` returning the list it was given
 * means "no change", which keeps identity stable for unaffected branches.
 */
function transformSiblings(
  list: OutlineEntry[],
  id: string,
  fn: (siblings: OutlineEntry[], index: number) => OutlineEntry[]
): OutlineEntry[] {
  const index = list.findIndex(entry => entry.id === id);
  if (index >= 0) return fn(list, index);
  let changed = false;
  const next = list.map(entry => {
    const children = transformSiblings(entry.children, id, fn);
    if (children === entry.children) return entry;
    changed = true;
    return { ...entry, children };
  });
  return changed ? next : list;
}

export function renameEntry(tree: OutlineEntry[], id: string, title: string): OutlineEntry[] {
  return transformSiblings(tree, id, (siblings, index) => {
    const next = [...siblings];
    next[index] = { ...siblings[index], title };
    return next;
  });
}

export function setEntryPage(tree: OutlineEntry[], id: string, pageKey: string): OutlineEntry[] {
  return transformSiblings(tree, id, (siblings, index) => {
    const next = [...siblings];
    next[index] = { ...siblings[index], pageKey };
    return next;
  });
}

/** Deletes an entry and, with it, its children — the subtree moves as a unit. */
export function deleteEntry(tree: OutlineEntry[], id: string): OutlineEntry[] {
  return transformSiblings(tree, id, (siblings, index) =>
    siblings.filter((_, position) => position !== index)
  );
}

/** Swaps an entry with its previous or next sibling; a no-op at either end. */
export function moveEntry(
  tree: OutlineEntry[],
  id: string,
  direction: 'up' | 'down'
): OutlineEntry[] {
  return transformSiblings(tree, id, (siblings, index) => {
    const target = direction === 'up' ? index - 1 : index + 1;
    if (target < 0 || target >= siblings.length) return siblings;
    const next = [...siblings];
    next[index] = siblings[target];
    next[target] = siblings[index];
    return next;
  });
}

/** Makes an entry the last child of the sibling above it; a no-op for a first child. */
export function indentEntry(tree: OutlineEntry[], id: string): OutlineEntry[] {
  return transformSiblings(tree, id, (siblings, index) => {
    if (index === 0) return siblings;
    const moving = siblings[index];
    const parent = siblings[index - 1];
    const next = siblings.filter((_, position) => position !== index);
    next[index - 1] = { ...parent, children: [...parent.children, moving] };
    return next;
  });
}

/** Promotes an entry to sit just after its parent; a no-op at the top level. */
export function outdentEntry(tree: OutlineEntry[], id: string): OutlineEntry[] {
  const walk = (list: OutlineEntry[]): OutlineEntry[] => {
    let changed = false;
    const out: OutlineEntry[] = [];
    for (const entry of list) {
      const index = entry.children.findIndex(child => child.id === id);
      if (index >= 0) {
        const promoted = entry.children[index];
        out.push({
          ...entry,
          children: entry.children.filter((_, position) => position !== index)
        });
        out.push(promoted);
        changed = true;
        continue;
      }
      const children = walk(entry.children);
      if (children === entry.children) {
        out.push(entry);
      } else {
        changed = true;
        out.push({ ...entry, children });
      }
    }
    return changed ? out : list;
  };
  return walk(tree);
}

/** Appends an entry at the end of the top level. */
export function appendEntry(tree: OutlineEntry[], entry: OutlineEntry): OutlineEntry[] {
  return [...tree, entry];
}

/** One output file of an OPS-12 bookmark split: where it starts and what it is called. */
export interface BookmarkSlice {
  title: string;
  /** 0-based index into the document's pages. */
  pageIndex: number;
}

/**
 * The top-level bookmarks that can act as split boundaries (OPS-12).
 *
 * Entries with no resolvable page are skipped — they cannot start a file — and two
 * bookmarks landing on the same page collapse to one slice, since the alternative
 * is an empty output file. That collapsing matches `splitBoundaries`' own
 * de-duplication, which is what keeps the file count and the name list in step.
 */
export function topLevelSlices(tree: OutlineEntry[], pageKeys: string[]): BookmarkSlice[] {
  const indexByKey = new Map(pageKeys.map((key, index) => [key, index]));
  const titleByIndex = new Map<number, string>();
  for (const entry of tree) {
    const index = entry.pageKey === null ? undefined : indexByKey.get(entry.pageKey);
    if (index === undefined) continue;
    if (!titleByIndex.has(index)) titleByIndex.set(index, entry.title.trim() || 'Untitled');
  }
  return [...titleByIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([pageIndex, title]) => ({ title, pageIndex }));
}

/** Flat list of `[entry, depth]` pairs, in the order the panel renders rows. */
export function flattenEntries(
  tree: OutlineEntry[],
  depth = 0
): { entry: OutlineEntry; depth: number }[] {
  return tree.flatMap(entry => [{ entry, depth }, ...flattenEntries(entry.children, depth + 1)]);
}
