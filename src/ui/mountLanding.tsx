/**
 * Shared bootstrap for the five per-tool landing pages (DIST-03: `/merge-pdf`,
 * `/compress-pdf`, `/sign-pdf`, `/scan-cleanup`, `/redact-pdf`).
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
import './styles/tokens.css';
import './styles/marketing.css';

export function mountLanding(toolId: ToolId): void {
  // Only force the route on a bare load. A reload after the visitor has already
  // navigated elsewhere in the embedded app (e.g. back to Home) should not snap
  // them back to the landing page's tool.
  if (!window.location.hash) {
    window.location.hash = `#${toolRoute(toolId)}`;
  }

  const root = document.getElementById('app');
  if (!root) throw new Error('The #app mount point is missing from the landing page');

  initTheme();
  void initLocale();
  installErrorHooks();
  render(<App />, root);
}
