/**
 * OPS-14 — proposes a bookmark tree from font-size jumps in the extracted text,
 * seeding OPS-10's editor rather than writing `/Outlines` directly (the user
 * still has to review the proposal and export for anything to be written).
 *
 * Pure and independent of pdf.js/worker types — it takes the same
 * `{text, x, y, width, height}` shape `extractPageTextItems` already returns —
 * so the heading-detection heuristic is testable without a PDF.
 */

export interface HeadingItem {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface HeadingPage {
  pageIndex: number;
  items: HeadingItem[];
}

export interface OutlineCandidate {
  title: string;
  /** 1 = the largest heading size seen, increasing = smaller/deeper. */
  level: number;
  pageIndex: number;
  children: OutlineCandidate[];
}

interface Line {
  text: string;
  height: number;
  pageIndex: number;
}

/** Groups a page's items into lines by vertical proximity, largest-first sort not required. */
function linesForPage(pageIndex: number, items: readonly HeadingItem[]): Line[] {
  if (items.length === 0) return [];
  const sorted = [...items].sort((a, b) => a.y - b.y);
  const groups: HeadingItem[][] = [];
  for (const item of sorted) {
    const currentGroup = groups[groups.length - 1];
    const tolerance = Math.max(2, item.height * 0.4);
    if (currentGroup && Math.abs(currentGroup[0].y - item.y) <= tolerance) {
      currentGroup.push(item);
    } else {
      groups.push([item]);
    }
  }
  const lines: Line[] = [];
  for (const group of groups) {
    const sorted = [...group].sort((a, b) => a.x - b.x);
    let text = '';
    for (let i = 0; i < sorted.length; i++) {
      const item = sorted[i];
      if (i > 0) {
        const prev = sorted[i - 1];
        // A gap wider than roughly a quarter of the type size means the
        // producer split the run instead of emitting a space character —
        // the same threshold `layoutText` uses for the same reason.
        const gap = item.x - (prev.x + prev.width);
        if (gap > item.height * 0.25) text += ' ';
      }
      text += item.text;
    }
    text = text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    lines.push({ text, height: Math.max(...group.map(i => i.height)), pageIndex });
  }
  return lines;
}

/** The height that covers the most lines — the document's ordinary body text size. */
function dominantHeight(lines: readonly Line[]): number {
  const weight = new Map<number, number>();
  for (const line of lines) {
    const rounded = Math.round(line.height);
    weight.set(rounded, (weight.get(rounded) ?? 0) + 1);
  }
  let best = lines[0]?.height ?? 12;
  let bestWeight = -1;
  for (const [size, count] of weight) {
    if (count > bestWeight) {
      bestWeight = count;
      best = size;
    }
  }
  return best;
}

export interface DetectHeadingsOptions {
  /** Distinct heading sizes deeper than this collapse into the deepest level. */
  maxLevels?: number;
  /** A line must be at least this many times the body size to count as a heading. */
  sizeThreshold?: number;
}

/** Total headings in a candidate tree, not just the top-level count. */
export function countCandidates(candidates: readonly OutlineCandidate[]): number {
  return candidates.reduce((total, node) => total + 1 + countCandidates(node.children), 0);
}

/**
 * Detects heading lines by font-size jump over the document's own body-text
 * size, then nests them into a tree by size — the largest distinct heading
 * size becomes level 1, and so on. A flat list is turned into a tree the same
 * way Markdown ATX headings are: a heading closes every open level at least as
 * deep as itself before attaching under whatever remains open above it.
 */
export function detectHeadingOutline(
  pages: readonly HeadingPage[],
  options: DetectHeadingsOptions = {}
): OutlineCandidate[] {
  const maxLevels = options.maxLevels ?? 3;
  const sizeThreshold = options.sizeThreshold ?? 1.15;

  const lines = pages.flatMap(page => linesForPage(page.pageIndex, page.items));
  if (lines.length === 0) return [];

  const bodySize = dominantHeight(lines);
  const headingLines = lines.filter(line => line.height >= bodySize * sizeThreshold);
  if (headingLines.length === 0) return [];

  const distinctSizes = [...new Set(headingLines.map(l => Math.round(l.height)))].sort(
    (a, b) => b - a
  );
  const levelForSize = new Map<number, number>();
  distinctSizes.forEach((size, i) => levelForSize.set(size, Math.min(i + 1, maxLevels)));

  const root: OutlineCandidate[] = [];
  const stack: { level: number; node: OutlineCandidate }[] = [];
  for (const line of headingLines) {
    const level = levelForSize.get(Math.round(line.height)) ?? maxLevels;
    const node: OutlineCandidate = {
      title: line.text,
      level,
      pageIndex: line.pageIndex,
      children: []
    };
    while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent) parent.node.children.push(node);
    else root.push(node);
    stack.push({ level, node });
  }
  return root;
}
