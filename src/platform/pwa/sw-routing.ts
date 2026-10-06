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

/**
 * Audit 2026-10-01 PLT-4 — written into a precache cache when its worker
 * activates (`{ at: <ms> }`), so the next version can tell which older cache
 * the open tabs were actually running from.
 */
export const ACTIVATED_KEY = '__stapler-activated.json';

/**
 * Audit 2026-10-01 PLT-4 — written into the current cache when an update
 * activates while tabs loaded by the previous version are still open
 * (`RetiredRecord`). Those tabs keep their old code in memory and may still
 * lazy-load a chunk of it, so that version's cache is kept, and its files
 * served, until every one of those tabs has reloaded or closed.
 */
export const RETIRED_KEY = '__stapler-retired.json';

/** Message a page posts to its controlling worker once it has loaded (PLT-4 cleanup). */
export const CLIENT_READY_MESSAGE = 'stapler:client-ready';

/**
 * Name prefix of the scratch caches for a one-off request whose response is
 * served but not kept (PLT-6). Each request gets its own
 * (`TRANSIENT_CACHE + '-' + uuid`), deleted after use; any a stopped worker
 * left behind are deleted on activation.
 */
export const TRANSIENT_CACHE = 'stapler-transient';

/**
 * Audit 2026-10-01 PLT-6 — how long a page waits for the network before
 * giving up. Pages are served from the worker's own cache (PLT-1); the
 * network is only the last resort for a page missing from it.
 */
export const PAGE_NETWORK_TIMEOUT_MS = 3000;

export function cacheName(version: string): string {
  return CACHE_PREFIX + version;
}

export type Route =
  /** Not ours: no `respondWith`, the browser handles it as if there were no worker. */
  | { kind: 'ignore' }
  /** The OS share sheet posting files (manifest `share_target`). */
  | { kind: 'share-target' }
  /**
   * An HTML entry page: from the controlling worker's own cache, so a page
   * and its scripts always come from the same build (audit 2026-10-01 PLT-1).
   */
  | { kind: 'page'; key: string }
  /** A build file: the cached copy first, the network only on a miss. */
  | { kind: 'asset'; key: string }
  /**
   * A file of the previous version, still needed by a tab that loaded it
   * before this version took over (PLT-4): served from that version's cache.
   */
  | { kind: 'retired'; key: string }
  /**
   * PLT-4 — the worker has just (re)started and is still reading back which
   * previous-version cache it keeps (`RouteTable.retiredLoading`). A request
   * that could be one of that cache's files is held until it knows, then
   * served from the kept cache or, if it is not there, forwarded to the
   * network unchanged (`passthrough.ts`) — exactly as if it had been `ignore`.
   */
  | { kind: 'retired-pending'; key: string };

export interface RouteInput {
  url: string;
  method: string;
  /** `Request.mode`; a navigation is never a retired file. */
  mode?: string;
}

/** Precomputed lookups, so the fetch handler doesn't rebuild sets per request. */
export interface RouteTable {
  scopeOrigin: string;
  scopePath: string;
  pages: Set<string>;
  assets: Set<string>;
  /** Files of the retired previous version's cache, while it is kept (PLT-4). */
  retired?: Set<string>;
  /**
   * PLT-4 — true from the worker's start until it has read the kept cache's
   * record back from Cache Storage. A service worker is stopped when idle and
   * restarted for the next event, so this in-memory table starts empty every
   * time; while it does, `routeRequest` holds every possible retired file
   * (`retired-pending`) instead of letting it go to the network unanswered.
   */
  retiredLoading?: boolean;
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
  // Never a page: an old tab that navigates gets this version's page.
  if (rel.startsWith('__') || request.mode === 'navigate') return { kind: 'ignore' };
  if (table.retired?.has(rel)) return { kind: 'retired', key: rel };
  if (table.retiredLoading && rel !== '' && !rel.endsWith('/')) {
    return { kind: 'retired-pending', key: rel };
  }
  return { kind: 'ignore' };
}

/** The scope-relative path of a cache key under `scope`, or `null` if it is outside it. */
export function scopeRelative(url: string, scope: string): string | null {
  try {
    const target = new URL(url);
    const base = new URL(scope);
    if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname)) return null;
    return decodeURIComponent(target.pathname.slice(base.pathname.length));
  } catch {
    return null;
  }
}

/** One older precache cache, as `pickRetiredCache` sees it. */
export interface CacheCandidate {
  name: string;
  /** `ACTIVATED_KEY`'s timestamp, or `null` for a cache that never recorded one. */
  activatedAt: number | null;
  /** Holds `REVISIONS_KEY`, i.e. its install finished. */
  complete: boolean;
}

/**
 * Of the older caches, the one the open tabs were loaded from: the most
 * recently activated complete cache. A cache written before activation was
 * recorded (`activatedAt: null`) only counts when no recorded one exists.
 * A version that installed but never activated is never chosen over one that
 * did. `null` when no complete cache exists.
 */
export function pickRetiredCache(candidates: readonly CacheCandidate[]): string | null {
  let best: CacheCandidate | null = null;
  for (const candidate of candidates) {
    if (!candidate.complete) continue;
    if (!best || (candidate.activatedAt ?? -1) > (best.activatedAt ?? -1)) best = candidate;
  }
  return best ? best.name : null;
}

/** Recorded under `RETIRED_KEY`: the kept cache and the tabs still running its code. */
export interface RetiredRecord {
  cache: string;
  clients: string[];
}

/** A `RETIRED_KEY` body, validated; `null` for anything malformed. */
export function parseRetiredRecord(value: unknown): RetiredRecord | null {
  if (!value || typeof value !== 'object') return null;
  const { cache, clients } = value as { cache?: unknown; clients?: unknown };
  if (typeof cache !== 'string' || !cache.startsWith(CACHE_PREFIX)) return null;
  if (!Array.isArray(clients) || !clients.every(id => typeof id === 'string')) return null;
  return { cache, clients: clients as string[] };
}

/**
 * Audit 2026-10-01 PLT-3 — what the worker knows about a POST to the share
 * target. Service workers do not see `Sec-Fetch-*` (the browser adds them
 * after the worker; probed in Chromium 151), but they do see `Origin`, the
 * referrer, and the client that started the navigation.
 */
export interface ShareRequestInput {
  /** The `Origin` header: a serialized origin, `'null'`, or absent. */
  origin: string | null;
  /** `Sec-Fetch-Site`, should a browser ever expose it to the worker. */
  secFetchSite: string | null;
  /** `request.referrer`: `''` when none was sent. */
  referrer: string;
  /**
   * Who started the navigation: `'none'` — no client (the OS share sheet, the
   * browser itself); `'same-origin'` — one of this app's own pages; `'foreign'`
   * — a client the worker cannot see, i.e. a page of another origin.
   */
  initiator: 'none' | 'same-origin' | 'foreign';
}

/**
 * What the worker does with a share-target POST (audit 2026-10-01 PLT-3):
 *
 *  - `'reject'` — the request carries a sign of another origin: a
 *    `cross-site`/`same-site` fetch site, an `Origin` or referrer of another
 *    origin, or a navigation started by a page of another origin. Nothing is
 *    stored.
 *  - `'verified'` — positively this app's own origin: an `Origin` header or a
 *    referrer of this origin, or an initiating client that is one of this
 *    app's pages (and no foreign sign at all). The app imports it at once.
 *  - `'unverified'` — no sign either way: `Origin` absent or `null`, no
 *    referrer, no client the worker can see. That is what the OS share sheet
 *    sends (a browser-initiated navigation), but it is also what a foreign page
 *    sends when it opens the POST in a *new window* with `no-referrer`
 *    (probed). The worker cannot tell the two apart, so the files are stored
 *    marked unverified and the app asks before opening them
 *    (`src/ui/pwa.ts`, "Open N shared files?").
 */
export type ShareVerdict = 'reject' | 'verified' | 'unverified';

export function classifyShareRequest(input: ShareRequestInput, scopeOrigin: string): ShareVerdict {
  const site = input.secFetchSite?.toLowerCase();
  if (site === 'cross-site' || site === 'same-site') return 'reject';
  let sameOrigin = false;
  if (input.origin !== null && input.origin !== 'null') {
    if (input.origin !== scopeOrigin) return 'reject';
    sameOrigin = true;
  }
  if (input.referrer) {
    let referrerOrigin: string;
    try {
      referrerOrigin = new URL(input.referrer).origin;
    } catch {
      return 'reject';
    }
    if (referrerOrigin !== scopeOrigin) return 'reject';
    sameOrigin = true;
  }
  if (input.initiator === 'foreign') return 'reject';
  if (input.initiator === 'same-origin' || site === 'same-origin') sameOrigin = true;
  return sameOrigin ? 'verified' : 'unverified';
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
