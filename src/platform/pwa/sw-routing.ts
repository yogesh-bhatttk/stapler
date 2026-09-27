/**
 * GAP-2 — the web build's service-worker routing, as a pure function.
 *
 * `service-worker.ts` does nothing but carry out what {@link routeRequest}
 * decides, so every rule that matters — above all "never touch a cross-origin
 * request" — is unit-tested here (`tests/unit/pwa-sw-routing.test.ts`)
 * without a browser.
 *
 * Paths in a {@link PrecacheManifest} are relative to the worker's scope (the
 * site root the build is deployed at), with no leading slash: `index.html`,
 * `assets/editor-abc123.js`, `pdfjs/cmaps/UniJIS-UCS2-H.bcmap`.
 */

/** Generated at build time by `scripts/pwa.mjs` and inlined into `sw.js`. */
export interface PrecacheManifest {
  /** Content hash of every listed file; names the cache. */
  version: string;
  /** Build files cached on install (HTML pages included). */
  precache: string[];
  /** Build files cached the first time they are requested (the OCR engine). */
  runtime: string[];
  /** The HTML entry pages, a subset of `precache` (`index.html`, `merge-pdf.html`…). */
  pages: string[];
  /** Content hash of each `precache` file, so an update re-downloads only what changed. */
  revisions: Record<string, string>;
}

/** Every precache cache is named `CACHE_PREFIX + version`. */
export const CACHE_PREFIX = 'stapler-precache-';

/** The `share_target.action` path in `manifest.webmanifest`, relative to the scope. */
export const SHARE_TARGET_PATH = 'share-target';

/** Where the worker redirects after storing shared files — the app, told to look. */
export const SHARE_TARGET_PARAM = 'share-target';

/**
 * Cache key (relative to the scope) under which each precache cache records
 * the {@link PrecacheManifest.revisions} it was filled from. Never a real
 * build path: it starts with `__`, which no emitted file does.
 */
export const REVISIONS_KEY = '__stapler-revisions.json';

/** Message a page posts to a waiting worker to make it take over now. */
export const SKIP_WAITING_MESSAGE = 'stapler:skip-waiting';

export function cacheName(version: string): string {
  return CACHE_PREFIX + version;
}

export type Route =
  /** Not ours: no `respondWith`, the browser handles it as if there were no worker. */
  | { kind: 'ignore' }
  /** The OS share sheet posting files (manifest `share_target`). */
  | { kind: 'share-target' }
  /** An HTML entry page: network first, the cached copy when offline. */
  | { kind: 'page'; key: string }
  /** A build file: the cached copy first, the network only on a miss. */
  | { kind: 'asset'; key: string };

export interface RouteInput {
  url: string;
  method: string;
}

/** Precomputed lookups, so the fetch handler doesn't rebuild sets per request. */
export interface RouteTable {
  scopeOrigin: string;
  scopePath: string;
  pages: Set<string>;
  assets: Set<string>;
}

export function buildRouteTable(scope: string, manifest: PrecacheManifest): RouteTable {
  const url = new URL(scope);
  return {
    scopeOrigin: url.origin,
    scopePath: url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`,
    pages: new Set(manifest.pages),
    assets: new Set([...manifest.precache, ...manifest.runtime])
  };
}

/** The entry page a scope-relative path is served from, if any. */
export function pageFor(rel: string, pages: Set<string>): string | null {
  if (rel === '' || rel.endsWith('/')) {
    const index = `${rel}index.html`;
    return pages.has(index) ? index : null;
  }
  if (pages.has(rel)) return rel;
  // GitHub Pages (and `vite preview`) serve `/merge-pdf` from `merge-pdf.html`.
  if (pages.has(`${rel}.html`)) return `${rel}.html`;
  return null;
}

/**
 * What the worker does with one request. Anything not provably one of this
 * build's own files at this origin is `ignore` — in particular every
 * cross-origin request (the OCR model download included), which the worker
 * neither answers, caches nor re-issues.
 */
export function routeRequest(request: RouteInput, table: RouteTable): Route {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return { kind: 'ignore' };
  }
  if (url.origin !== table.scopeOrigin) return { kind: 'ignore' };
  if (!url.pathname.startsWith(table.scopePath)) return { kind: 'ignore' };

  let rel: string;
  try {
    rel = decodeURIComponent(url.pathname.slice(table.scopePath.length));
  } catch {
    return { kind: 'ignore' };
  }

  const method = request.method.toUpperCase();
  if (method === 'POST' && rel === SHARE_TARGET_PATH) return { kind: 'share-target' };
  if (method !== 'GET') return { kind: 'ignore' };

  const page = pageFor(rel, table.pages);
  if (page) return { kind: 'page', key: page };
  if (table.assets.has(rel)) return { kind: 'asset', key: rel };
  return { kind: 'ignore' };
}

/** Caches an activating worker deletes: older precache versions, nothing else. */
export function staleCaches(names: readonly string[], version: string): string[] {
  const current = cacheName(version);
  return names.filter(name => name.startsWith(CACHE_PREFIX) && name !== current);
}

/**
 * How an installing worker fills its cache: files whose content hash is
 * unchanged since the previous version are copied from that version's cache,
 * the rest are downloaded. Unhashed build files (`pdfjs/…`, the HTML pages,
 * icons) make a plain "same path" check unsafe, and re-downloading ~20 MB on
 * every deploy is what this avoids.
 */
export function planInstall(
  manifest: PrecacheManifest,
  previous: Record<string, string> | null
): { copy: string[]; download: string[] } {
  const copy: string[] = [];
  const download: string[] = [];
  for (const path of manifest.precache) {
    const revision = manifest.revisions[path];
    if (previous && revision !== undefined && previous[path] === revision) copy.push(path);
    else download.push(path);
  }
  return { copy, download };
}
