/**
 * Shared bootstrap for the per-tool landing pages (DIST-03: `/merge-pdf`,
 * `/compress-pdf`, `/sign-pdf`, `/scan-cleanup`, `/redact-pdf`, and the six
 * CNV-08..13 converters: `/pdf-to-word`, `/word-to-pdf`, `/pdf-to-excel`,
 * `/excel-to-pdf`, `/pdf-to-ppt`, `/ppt-to-pdf`).
 *
 * Each landing page is a real static HTML file (see the `*.entry.ts` files in
 * `src/ui/landing/` and the matching `.html` files at the repo root, wired into
 * `vite.config.ts`'s web-only `rollupOptions.input`) with real hero/feature/CTA
 * markup that renders before any script runs — that is what makes the route
 * "server-rendered static" rather than a client-routed SPA path that 404s on a
 * direct hit. Below that static hero, this mounts the *same* `App` tree the
 * extension uses, pre-navigated to the one tool the page is about, so the tool is
 * both "preloaded" and fully usable without the extension installed — no
 * reimplementation of merge/compress/sign/cleanup/redact for the marketing site.
 */
import { render } from 'preact';
import { App } from './AppRoot';
import { installErrorHooks } from './errorHooks';
import { initTheme } from './theme';
import { initLocale } from '../core/i18n';
import { toolRoute, type ToolId } from '../core/tools';
import { startWebApp } from './pwa';
import './styles/tokens.css';
import './styles/marketing.css';

/**
 * `query` (GAP-4) pre-fills the tool the same way a shared link does, e.g.
 * `target=100KB` for the "compress PDF to 100 KB" page; `ui/deepLink.ts`
 * applies it and then strips it from the address.
 */
export function mountLanding(toolId: ToolId, query?: string): void {
  // Only force the route on a bare load. A reload after the visitor has already
  // navigated elsewhere in the embedded app (e.g. back to Home) should not snap
  // them back to the landing page's tool.
  // A reload that lands back on the bare tool route re-applies `query` too:
  // tool settings live in memory, so the reload has already reset them, and a
  // "compress to 100 KB" page that came back in quality mode would be wrong.
  const route = `#${toolRoute(toolId)}`;
  if (!window.location.hash || (query && window.location.hash === route)) {
    window.location.hash = `${route}${query ? `?${query}` : ''}`;
  }

  // The hero's "Use it now" and skip links point at `#tool`, the heading above
  // the embedded app. This page's router also lives in the hash, so following
  // them literally navigated the app to `/tool` — its "Nothing here" route —
  // and away from the very tool the page is about. Scroll and focus instead.
  document.addEventListener('click', event => {
    const link = event.target instanceof Element ? event.target.closest('a[href="#tool"]') : null;
    if (!link) return;
    event.preventDefault();
    const heading = document.getElementById('tool');
    if (!heading) return;
    heading.tabIndex = -1;
    heading.scrollIntoView({ block: 'start' });
    heading.focus({ preventScroll: true });
  });

  const root = document.getElementById('app');
  if (!root) throw new Error('The #app mount point is missing from the landing page');

  initTheme();
  installErrorHooks();
  // Awaited before the first render, same as `app.tsx` — otherwise a
  // non-English visitor's first paint is English/raw keys until the
  // dictionary (a bundled asset, not a network fetch) resolves and forces a
  // re-render.
  void (async () => {
    await initLocale();
    render(<App />, root);
    startWebApp(); // GAP-2: offline service worker, "Open with", share target
  })();
}
