/**
 * GAP-2 — the web build's precaching service worker (`sw.js`). Never part of
 * the extension build: `scripts/pwa.mjs` compiles it, with the precache
 * manifest inlined, only for `BUILD_TARGET=web`.
 *
 * What it does, and all it does:
 *  - install: puts every file in `precache` — this build's own HTML, JS, CSS,
 *    WASM, fonts and icons — into a cache named after the build's content hash,
 *    copying files unchanged since the previous version out of its cache
 *    instead of downloading them again;
 *  - fetch: answers only what `routeRequest` (`sw-routing.ts`) says is this
 *    build's own file at this origin — the entry pages network-first (so a new
 *    deploy is picked up) with the cached copy as the offline fallback, every
 *    other build file cache-first. Everything else — every cross-origin request,
 *    the pinned OCR model download included — gets no `respondWith` at all and
 *    reaches the browser exactly as if there were no worker;
 *  - receives files from the OS share sheet (`share_target`) into a same-origin
 *    cache for the app to open (`share-inbox.ts`);
 *  - activate: deletes older precache versions. It waits for the page to ask
 *    (`SKIP_WAITING_MESSAGE`) before replacing a running version, so a tab is
 *    never switched to new code under an open document.
 *
 * It makes no request of its own except for this origin's build files, and
 * only through the Cache API (`cache.add`/`addAll`) with a URL built from a
 * manifest path and the worker's own scope — never a URL taken from a request.
 * No telemetry, no remote code, no third-party origin.
 */
import {
  REVISIONS_KEY,
  SHARE_TARGET_PARAM,
  SKIP_WAITING_MESSAGE,
  buildRouteTable,
  cacheName,
  planInstall,
  routeRequest,
  staleCaches,
  type PrecacheManifest
} from './sw-routing';
import { storeSharedFiles } from './share-inbox';

/** Replaced with the real manifest by `scripts/pwa.mjs` when it compiles `sw.js`. */
declare const __STAPLER_PRECACHE__: PrecacheManifest;

/* The DOM lib is what this project compiles against; these are the few
 * service-worker global types used here (the WebWorker lib conflicts with it). */
interface ExtendableEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}
interface FetchEvent extends ExtendableEvent {
  readonly request: Request;
  respondWith(response: Promise<Response>): void;
}
interface ExtendableMessageEvent extends ExtendableEvent {
  readonly data: unknown;
}
interface ServiceWorkerScope {
  readonly registration: { readonly scope: string };
  skipWaiting(): Promise<void>;
  readonly clients: { claim(): Promise<void> };
  addEventListener(type: 'install' | 'activate', listener: (event: ExtendableEvent) => void): void;
  addEventListener(type: 'fetch', listener: (event: FetchEvent) => void): void;
  addEventListener(type: 'message', listener: (event: ExtendableMessageEvent) => void): void;
}

const sw = self as unknown as ServiceWorkerScope;
const MANIFEST = __STAPLER_PRECACHE__;
const SCOPE = sw.registration.scope;
const CURRENT = cacheName(MANIFEST.version);
const TABLE = buildRouteTable(SCOPE, MANIFEST);

/** Absolute URL of a scope-relative build path — the only URLs this worker requests. */
const urlOf = (path: string) => new URL(path, SCOPE).href;

/**
 * A redirected response cannot answer a navigation (the browser rejects it),
 * and a host that redirects `/page.html` → `/page` would leave one in the
 * cache. Re-wrap it as a plain response with the same body.
 */
async function servable(response: Response): Promise<Response> {
  if (!response.redirected) return response;
  return new Response(await response.blob(), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}

async function previousRevisions(): Promise<{ cache: Cache; revisions: Record<string, string> }[]> {
  const names = staleCaches(await caches.keys(), MANIFEST.version);
  const out: { cache: Cache; revisions: Record<string, string> }[] = [];
  for (const name of names) {
    const cache = await caches.open(name);
    const record = await cache.match(urlOf(REVISIONS_KEY));
    if (!record) continue;
    try {
      out.push({ cache, revisions: (await record.json()) as Record<string, string> });
    } catch {
      // An unreadable record just means nothing is reused from that cache.
    }
  }
  return out;
}

async function install(): Promise<void> {
  const cache = await caches.open(CURRENT);
  const reused = new Set<string>();
  for (const { cache: old, revisions } of await previousRevisions()) {
    const { copy } = planInstall(MANIFEST, revisions);
    for (const path of copy) {
      if (reused.has(path)) continue;
      const hit = await old.match(urlOf(path));
      if (!hit) continue;
      await cache.put(urlOf(path), hit);
      reused.add(path);
    }
  }
  const download = MANIFEST.precache.filter(path => !reused.has(path));
  // `no-cache` revalidates with the server, so an unhashed file (an HTML
  // page, a pdf.js font) is never installed from a stale HTTP cache entry.
  await cache.addAll(download.map(path => new Request(urlOf(path), { cache: 'no-cache' })));
  // Written last: a cache only advertises revisions once it holds all of them.
  await cache.put(
    urlOf(REVISIONS_KEY),
    new Response(JSON.stringify(MANIFEST.revisions), {
      headers: { 'content-type': 'application/json' }
    })
  );
}

async function activate(): Promise<void> {
  const stale = staleCaches(await caches.keys(), MANIFEST.version);
  await Promise.all(stale.map(name => caches.delete(name)));
  await sw.clients.claim();
}

/** Network first — a new deploy's page — falling back to the cached copy offline. */
async function page(key: string): Promise<Response> {
  const cache = await caches.open(CURRENT);
  const url = urlOf(key);
  try {
    // Replaces the cached copy only on success; offline or a server error
    // rejects and leaves the last good copy in place.
    await cache.add(new Request(url, { cache: 'no-cache' }));
  } catch {
    // Offline: serve what we have.
  }
  const hit = (await cache.match(url)) ?? (await cache.match(urlOf('index.html')));
  return hit ? servable(hit) : Response.error();
}

/** Cache first; a build file missing from the cache is fetched once and kept. */
async function asset(key: string): Promise<Response> {
  const cache = await caches.open(CURRENT);
  const url = urlOf(key);
  const hit = await cache.match(url);
  if (hit) return hit;
  try {
    await cache.add(new Request(url));
  } catch {
    return Response.error();
  }
  return (await cache.match(url)) ?? Response.error();
}

async function receiveShare(request: Request): Promise<Response> {
  let stored = 0;
  try {
    const form = await request.formData();
    const files = form.getAll('files').filter((value): value is File => typeof value !== 'string');
    stored = await storeSharedFiles(caches, SCOPE, files);
  } catch {
    // The app says "nothing was received" when the inbox is empty.
  }
  return Response.redirect(urlOf(`./?${SHARE_TARGET_PARAM}=${stored}`), 303);
}

sw.addEventListener('install', event => event.waitUntil(install()));
sw.addEventListener('activate', event => event.waitUntil(activate()));

sw.addEventListener('message', event => {
  const data = event.data as { type?: unknown } | null;
  if (data && data.type === SKIP_WAITING_MESSAGE) event.waitUntil(sw.skipWaiting());
});

sw.addEventListener('fetch', event => {
  const route = routeRequest(event.request, TABLE);
  switch (route.kind) {
    case 'ignore':
      return;
    case 'share-target':
      event.respondWith(receiveShare(event.request));
      return;
    case 'page':
      event.respondWith(page(route.key));
      return;
    case 'asset':
      event.respondWith(asset(route.key));
      return;
  }
});
