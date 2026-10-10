/**
 * The tab title follows the route (AUDIT-2026-10-10 UI24). It never changed
 * before, so every Stapler tab — and every history entry — read the same
 * "Stapler — Offline PDF Tools", whatever tool it was on.
 *
 * A tool route is titled "<translated tool name> — Stapler" and re-titled when
 * the locale changes; every other route keeps the page's own initial title
 * (editor.html's, or a landing page's server-rendered one).
 */
import { useEffect } from 'preact/hooks';
import { useLocation } from 'wouter-preact';
import { currentLocale, dictionaryVersion, translate } from '../core/i18n';
import { findTool, toolRoute, type ToolId } from '../core/tools';

const TOOL_ROUTE = /^\/tool\/([^/?#]+)/;

let initialTitle: string | null = null;
/** A route that keeps the page's static title — a landing page's own tool. */
let pinnedRoute: string | null = null;

/**
 * Landing pages call this: their static `<title>` ("Compress PDF to 100 KB —
 * Stapler") already names the tool better than the generic one would, so the
 * page's own tool route keeps it.
 */
export function keepInitialTitleFor(toolId: ToolId): void {
  pinnedRoute = toolRoute(toolId);
}

/** The title for a route. `fallback` is the page's initial title. */
export function documentTitleFor(location: string, fallback: string): string {
  const path = location.split('?')[0];
  if (pinnedRoute !== null && path === pinnedRoute) return fallback;
  if (path === '/whats-new') return translate('What’s new in Stapler');
  const tool = findTool(path.match(TOOL_ROUTE)?.[1]);
  if (tool) return `${translate(tool.title)} — Stapler`;
  return fallback;
}

/** Keeps `document.title` in step with the route and the locale. */
export function useDocumentTitle(): void {
  const [location] = useLocation();
  // Read so a locale switch, or a dictionary finishing its load, re-titles.
  const locale = currentLocale.value;
  const version = dictionaryVersion.value;
  useEffect(() => {
    if (initialTitle === null) initialTitle = document.title;
    document.title = documentTitleFor(location, initialTitle);
  }, [location, locale, version]);
}
