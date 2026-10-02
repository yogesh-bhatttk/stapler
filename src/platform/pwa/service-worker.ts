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
 *    build's own file at this origin — the entry pages *and* every other build
 *    file from this worker's own versioned cache, so a page and the scripts it
 *    loads always come from one build (audit 2026-10-01 PLT-1: pages used to be
 *    network-first, so after a deploy the new HTML ran the old cached entry
 *    script, and the old worker wrote the new HTML into its own cache). A new
 *    deploy is picked up the standard way — the browser re-checks `sw.js` on
 *    navigation, the new worker installs its own complete cache and waits —
 *    and the network is only a last resort, with a timeout (PLT-6), for a
 *    page missing from the cache. Everything else — every cross-origin
 *    request, the pinned OCR model download included — gets no `respondWith`
 *    at all and reaches the browser exactly as if there were no worker;
 *  - receives files from the OS share sheet (`share_target`) into a same-origin
 *    cache for the app to open (`share-inbox.ts`) — never from a POST another
 *    website started (PLT-3, `classifyShareRequest`); a share it cannot
 *    trace to this origin is stored marked unverified, and the app asks
 *    before opening it;
 *  - activate: deletes older precache versions — except, while tabs loaded by
 *    the previous version are still open, that version's cache, whose files
 *    it keeps serving them until they have all reloaded or closed (PLT-4).
 *    It waits for the page to ask (`SKIP_WAITING_MESSAGE`) before replacing a
 *    running version, so a tab is never switched to new code under an open
 *    document; every other tab is then told by `controllerchange`
 *    (`register.ts`) and reloads, or asks first if it has unsaved changes.
 *
 * It makes no request of its own except for this origin's files, and only
 * through the Cache API (`cache.add`/`addAll`) with a URL built from a
 * manifest path and the worker's own scope. The one exception is a request it
 * held while reading back the kept cache after a restart (PLT-4) that turns
 * out not to be a kept file: that request — the browser's own same-origin GET
 * object, query, headers and all — is forwarded unchanged (`passthrough.ts`),
 * so it gets exactly the response it would have got with no worker at all.
 * Never another origin, never a URL as given.
 * A build file fetched on a cache miss is kept only if its bytes match this
 * build's recorded hash, so one version never stores another's file.
 * No telemetry, no remote code, no third-party origin.
 */
import {
  ACTIVATED_KEY,
  CLIENT_READY_MESSAGE,
  PAGE_NETWORK_TIMEOUT_MS,
  RETIRED_KEY,
  REVISIONS_KEY,
  SHARE_TARGET_PARAM,
  SKIP_WAITING_MESSAGE,
  TRANSIENT_CACHE,
  buildRouteTable,
  cacheName,
  classifyShareRequest,
  parseRetiredRecord,
  pickRetiredCache,
  planInstall,
  routeRequest,
  scopeRelative,
  staleCaches,
  type CacheCandidate,
  type PrecacheManifest,
  type RetiredRecord,
  type ShareRequestInput
} from './sw-routing';
import { storeSharedFiles } from './share-inbox';
import { passThrough } from './passthrough';

/** Replaced with the real manifest by `scripts/pwa.mjs` when it compiles `sw.js`. */
declare const __STAPLER_PRECACHE__: PrecacheManifest;

/* The DOM lib is what this project compiles against; these are the few
 * service-worker global types used here (the WebWorker lib conflicts with it). */
interface ExtendableEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}
interface FetchEvent extends ExtendableEvent {
  readonly request: Request;
  readonly clientId: string;
  respondWith(response: Promise<Response>): void;
}
interface ExtendableMessageEvent extends ExtendableEvent {
  readonly data: unknown;
}
interface ClientLike {
  readonly id: string;
  readonly url: string;
}
interface ServiceWorkerScope {
  readonly registration: { readonly scope: string };
  skipWaiting(): Promise<void>;
  readonly clients: {
    claim(): Promise<void>;
    get(id: string): Promise<ClientLike | undefined>;
    matchAll(options: { type: 'window'; includeUncontrolled: boolean }): Promise<ClientLike[]>;
  };
  addEventListener(type: 'install' | 'activate', listener: (event: ExtendableEvent) => void): void;
  addEventListener(type: 'fetch', listener: (event: FetchEvent) => void): void;
  addEventListener(type: 'message', listener: (event: ExtendableMessageEvent) => void): void;
}

const sw = self as unknown as ServiceWorkerScope;
const MANIFEST = __STAPLER_PRECACHE__;
const SCOPE = sw.registration.scope;
const SCOPE_ORIGIN = new URL(SCOPE).origin;
const CURRENT = cacheName(MANIFEST.version);
const TABLE = buildRouteTable(SCOPE, MANIFEST);

/** Absolute URL of a scope-relative build path — the only URLs this worker requests. */
const urlOf = (path: string) => new URL(path, SCOPE).href;

const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

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

async function sha256Hex(response: Response): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await response.arrayBuffer());
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * One request for a build file of this origin, through a scratch cache (the
 * Cache API is how this worker requests its own files), abandoned after
 * `timeoutMs`. Nothing is kept: the response is returned, not stored. Each
 * call has its own scratch cache, so two at once for one URL never share —
 * or delete — each other's entry.
 */
async function networkOnce(path: string, timeoutMs: number): Promise<Response | null> {
  const url = urlOf(path);
  const scratchName = `${TRANSIENT_CACHE}-${crypto.randomUUID()}`;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>(resolve => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, timeoutMs);
  });
  const attempt = (async () => {
    try {
      const scratch = await caches.open(scratchName);
      await scratch.add(new Request(url, { cache: 'no-cache', signal: controller.signal }));
      return (await scratch.match(url)) ?? null;
    } catch {
      return null;
    } finally {
      await caches.delete(scratchName);
    }
  })();
  try {
    return await Promise.race([attempt, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------------------------------------------------------- *
 * PLT-4 — the previous version's cache, kept for tabs still running it.
 * ---------------------------------------------------------------- */

let retired: RetiredRecord | null = null;
/** Bumped by every change of `retired`, so a slower, older read never overwrites a newer one. */
let retiredGeneration = 0;

async function useRetired(record: RetiredRecord | null): Promise<void> {
  const generation = ++retiredGeneration;
  let paths: Set<string> | undefined;
  if (record && (await caches.has(record.cache))) {
    paths = new Set<string>();
    for (const key of await (await caches.open(record.cache)).keys()) {
      const rel = scopeRelative(key.url, SCOPE);
      if (rel) paths.add(rel);
    }
  }
  if (generation !== retiredGeneration) return;
  // Assigned together, after every await: a request never sees half a change.
  retired = paths ? record : null;
  TABLE.retired = paths;
}

/**
 * PLT-4 — the kept cache is recorded in Cache Storage (`RETIRED_KEY`), and
 * read back on every start of this worker: it is stopped when idle and
 * restarted for the next event, with this module's state gone. Until the
 * read finishes, `TABLE.retiredLoading` makes `routeRequest` hold every
 * request that could be a kept file (`retired-pending`), so the first
 * request after a cold start is answered from the kept cache like any other
 * instead of going to the network.
 *
 * The hold is as short as it can be made. A service worker has no
 * synchronous storage, so whether a record exists is only known after one
 * Cache Storage lookup — but that one lookup is all a cold start without a
 * kept cache (the usual case) waits for: no record means `useRetired(null)`,
 * which finishes without another await, and the hold ends. Only while a
 * previous version really is kept does it also wait for that cache's key
 * list.
 */
async function loadRetired(): Promise<void> {
  const generation = retiredGeneration;
  try {
    const stored = await caches.match(urlOf(RETIRED_KEY), { cacheName: CURRENT });
    const record = stored ? parseRetiredRecord(await stored.json()) : null;
    // `activate` (or a prune) decided in the meantime: its state is newer.
    if (generation === retiredGeneration) await useRetired(record);
  } catch {
    // A missing or unreadable record: nothing is kept.
  }
}
TABLE.retiredLoading = true;
const retiredLoaded = loadRetired().finally(() => {
  TABLE.retiredLoading = false;
});

/**
 * A request that arrived while the kept cache was still being read back: the
 * kept cache's copy if it has one; otherwise the browser's own request,
 * forwarded unchanged — same URL and query, method, headers (`Range`…),
 * credentials and cache mode, the real status (a 404 stays a 404), and no
 * timeout — exactly what it would have got had this worker not intercepted it.
 */
async function heldRequest(request: Request, key: string): Promise<Response> {
  await retiredLoaded;
  if (TABLE.retired?.has(key)) return retiredFile(key);
  return passThrough(request, SCOPE_ORIGIN);
}

/** Deletes the kept cache once every tab that needed it has reloaded or closed. */
async function pruneRetired(): Promise<void> {
  const record = retired;
  if (!record) return;
  const alive = await Promise.all(record.clients.map(id => sw.clients.get(id)));
  if (alive.some(Boolean)) return;
  await caches.delete(record.cache);
  await (await caches.open(CURRENT)).delete(urlOf(RETIRED_KEY));
  if (retired === record) await useRetired(null);
}

async function retiredFile(key: string): Promise<Response> {
  const record = retired;
  if (!record) return Response.error();
  return (await caches.match(urlOf(key), { cacheName: record.cache })) ?? Response.error();
}

/* ---------------------------------------------------------------- */

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
  // PLT-1: if the server already holds a newer deploy, an unhashed file
  // (an HTML page, a pdf.js asset) would arrive as that deploy's bytes. Such
  // a mixed cache is never completed: the install fails and the browser
  // tries again with whichever `sw.js` the server now has. The same check
  // fails on a host that rewrites responses (HTML minification, injected
  // snippets): the site then works online but never installs offline, a
  // hosting requirement stated in RELEASE_CHECKLIST.md's website deploy step.
  for (const path of download) {
    const expected = MANIFEST.revisions[path];
    const stored = await cache.match(urlOf(path));
    if (expected !== undefined && (!stored || (await sha256Hex(stored)) !== expected)) {
      throw new Error(`stapler sw: ${path} does not match this build`);
    }
  }
  // Written last: a cache only advertises revisions once it holds all of them.
  await cache.put(urlOf(REVISIONS_KEY), json(MANIFEST.revisions));
}

async function describeCache(name: string): Promise<CacheCandidate> {
  const cache = await caches.open(name);
  let activatedAt: number | null = null;
  try {
    const record = await cache.match(urlOf(ACTIVATED_KEY));
    const at = record ? Number(((await record.json()) as { at?: unknown }).at) : NaN;
    if (Number.isFinite(at)) activatedAt = at;
  } catch {
    // Unreadable: treated as never recorded.
  }
  return { name, activatedAt, complete: Boolean(await cache.match(urlOf(REVISIONS_KEY))) };
}

async function activate(): Promise<void> {
  const names = await caches.keys();
  const stale = staleCaches(names, MANIFEST.version);
  // Every tab open right now was loaded by an older version: this one has
  // not served a page yet.
  const windows = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const keep =
    windows.length > 0 && stale.length > 0
      ? pickRetiredCache(await Promise.all(stale.map(describeCache)))
      : null;
  await Promise.all(stale.filter(name => name !== keep).map(name => caches.delete(name)));
  // Scratch caches a stopped worker left behind (`networkOnce`).
  await Promise.all(
    names.filter(name => name.startsWith(TRANSIENT_CACHE)).map(name => caches.delete(name))
  );

  const cache = await caches.open(CURRENT);
  await cache.put(urlOf(ACTIVATED_KEY), json({ at: Date.now() }));
  if (keep) {
    const record: RetiredRecord = { cache: keep, clients: windows.map(client => client.id) };
    await cache.put(urlOf(RETIRED_KEY), json(record));
    await useRetired(record);
  } else {
    await cache.delete(urlOf(RETIRED_KEY));
    await useRetired(null);
  }
  await sw.clients.claim();
}

/**
 * This worker's own copy of the page — never the network's, which after a
 * deploy is another version's HTML pointing at another version's scripts.
 */
async function page(key: string): Promise<Response> {
  const cache = await caches.open(CURRENT);
  const hit = (await cache.match(urlOf(key))) ?? (await cache.match(urlOf('index.html')));
  if (hit) return servable(hit);
  // Only reachable if the cache lost its pages; served, not stored.
  const fresh = await networkOnce(key, PAGE_NETWORK_TIMEOUT_MS);
  return fresh ? servable(fresh) : Response.error();
}

/**
 * Cache first; a build file missing from the cache is fetched once and kept
 * — but only if it is this build's file (its hash matches the manifest), so a
 * deploy that replaced an unhashed file can never put the new bytes in this
 * version's cache.
 */
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
  const fetched = await cache.match(url);
  if (!fetched) return Response.error();
  const expected = MANIFEST.revisions[key];
  if (expected !== undefined && (await sha256Hex(fetched.clone())) !== expected) {
    await cache.delete(url);
    return Response.error();
  }
  return fetched;
}

/** Who started a navigation, as far as this worker can tell. */
async function initiatorOf(clientId: string): Promise<ShareRequestInput['initiator']> {
  if (!clientId) return 'none';
  // `clients.get` only resolves clients of this origin.
  const client = await sw.clients.get(clientId);
  if (!client) return 'foreign';
  try {
    return new URL(client.url).origin === SCOPE_ORIGIN ? 'same-origin' : 'foreign';
  } catch {
    return 'foreign';
  }
}

async function receiveShare(event: FetchEvent): Promise<Response> {
  const { request } = event;
  const verdict = classifyShareRequest(
    {
      origin: request.headers.get('origin'),
      secFetchSite: request.headers.get('sec-fetch-site'),
      referrer: request.referrer,
      initiator: await initiatorOf(event.clientId)
    },
    SCOPE_ORIGIN
  );
  // PLT-3: a share another website posted is dropped unread — nothing is
  // stored, and the app opens as if it had been launched normally.
  if (verdict === 'reject') return Response.redirect(urlOf('./'), 303);
  let stored = 0;
  try {
    const form = await request.formData();
    const files = form.getAll('files').filter((value): value is File => typeof value !== 'string');
    // A share the worker could not positively trace to this origin (the OS
    // share sheet, or a foreign page posting from a new no-referrer window —
    // indistinguishable here) is stored marked unverified, and the app asks
    // before opening it (`src/ui/pwa.ts`).
    const now = Date.now();
    stored = await storeSharedFiles(caches, SCOPE, files, now, now, verdict === 'verified');
  } catch {
    // The app says "nothing was received" when the inbox is empty.
  }
  return Response.redirect(urlOf(`./?${SHARE_TARGET_PARAM}=${stored}`), 303);
}

sw.addEventListener('install', event => event.waitUntil(install()));
sw.addEventListener('activate', event => event.waitUntil(activate()));

sw.addEventListener('message', event => {
  const data = event.data as { type?: unknown } | null;
  if (!data) return;
  if (data.type === SKIP_WAITING_MESSAGE) event.waitUntil(sw.skipWaiting());
  // A page finished loading: an old tab that reloaded is gone by now.
  else if (data.type === CLIENT_READY_MESSAGE) event.waitUntil(pruneRetired());
});

sw.addEventListener('fetch', event => {
  const route = routeRequest(
    { url: event.request.url, method: event.request.method, mode: event.request.mode },
    TABLE
  );
  switch (route.kind) {
    case 'ignore':
      return;
    case 'share-target':
      event.respondWith(receiveShare(event));
      return;
    case 'page':
      event.respondWith(page(route.key));
      event.waitUntil(pruneRetired());
      return;
    case 'asset':
      event.respondWith(asset(route.key));
      return;
    case 'retired':
      event.respondWith(retiredFile(route.key));
      return;
    case 'retired-pending':
      event.respondWith(heldRequest(event.request, route.key));
      return;
  }
});
