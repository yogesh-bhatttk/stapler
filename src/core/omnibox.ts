/**
 * GAP-7 — the `pdf` omnibox keyword: typed text → a tool route.
 *
 * Pure, so the service worker (which owns `chrome.omnibox`) stays a thin
 * adapter and the matching is unit-tested without a browser. It reuses the
 * palette's subsequence scorer, so "pdf cmp" finds Compress the same way ⌘K
 * does.
 */
import { fuzzyRank } from './fuzzy';

/** The slice of a registry entry the omnibox needs. */
export interface OmniboxTool {
  id: string;
  title: string;
  group: string;
  summary: string;
}

/** Editor routes another extension context may ask an editor tab to open. */
const INTERNAL_ROUTE = /^\/(?:tool\/[a-z0-9-]+|whats-new)?$/;

/**
 * True for a hash route the editor accepts from outside its own page (the
 * service worker's navigate message). Anything else is ignored, so a message
 * can never smuggle an arbitrary URL into `location`.
 */
export function isInternalRoute(route: unknown): route is string {
  return typeof route === 'string' && INTERNAL_ROUTE.test(route);
}

function normalise(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Tools ranked for the omnibox text, best first, at most `limit`.
 *
 * An exact id or title ("merge", "split & extract") always ranks first, then
 * the fuzzy ranking over id, title, group and summary — the summary is what
 * lets "rotate" find Organize.
 */
export function matchOmniboxTools<T extends OmniboxTool>(
  text: string,
  tools: readonly T[],
  limit = 5
): T[] {
  const query = normalise(text);
  if (!query) return [];

  const exact = tools.filter(
    tool => tool.id === query.replace(/ /g, '-') || normalise(tool.title) === query
  );
  const ranked = fuzzyRank(tools, query, tool => [
    tool.id.replace(/-/g, ' '),
    tool.title,
    `${tool.title} ${tool.group}`,
    `${tool.title} ${tool.summary}`
  ]);
  const seen = new Set<string>();
  const result: T[] = [];
  for (const tool of [...exact, ...ranked]) {
    if (seen.has(tool.id)) continue;
    seen.add(tool.id);
    result.push(tool);
    if (result.length >= limit) break;
  }
  return result;
}

/**
 * The editor route for what the user entered: the best-matching tool, or
 * Home when nothing matches (so Enter never does nothing).
 */
export function omniboxRoute(text: string, tools: readonly OmniboxTool[]): string {
  const [best] = matchOmniboxTools(text, tools, 1);
  return best ? `/tool/${best.id}` : '/';
}

/**
 * Chrome parses suggestion descriptions as XML, so a title such as
 * "Split & extract" throws unless escaped. Firefox shows the description as
 * plain text, where the escape would be visible — callers pass `xml: false`.
 */
export function omniboxText(text: string, xml: boolean): string {
  if (!xml) return text;
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
