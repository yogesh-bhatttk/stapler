import { afterEach, describe, expect, it, vi } from 'vitest';
import { isPassThroughAllowed, passThrough } from '../../src/platform/pwa/passthrough';
import {
  CACHE_PREFIX,
  RETIRED_KEY,
  SHARE_TARGET_PATH,
  buildRouteTable,
  cacheName,
  classifyShareRequest,
  pageFor,
  parseRetiredRecord,
  pickRetiredCache,
  planInstall,
  routeRequest,
  scopeRelative,
  staleCaches,
  type PrecacheManifest,
  type ShareRequestInput
} from '../../src/platform/pwa/sw-routing';

/**
 * GAP-2 — the web service worker does exactly what `routeRequest` decides,
 * so the rules that matter (never touch cross-origin, pages network-first,
 * build files cache-first, nothing else answered) are pinned here.
 */
const MANIFEST: PrecacheManifest = {
  version: 'v2',
  precache: [
    'index.html',
    'editor.html',
    'merge-pdf.html',
    'manifest.webmanifest',
    'assets/editor-abc.js',
    'pdfjs/cmaps/UniJIS-UCS2-H.bcmap'
  ],
  runtime: ['ocr/tesseract-core-simd-lstm.wasm'],
  pages: ['index.html', 'editor.html', 'merge-pdf.html'],
  revisions: {
    'index.html': 'h1',
    'editor.html': 'h2',
    'merge-pdf.html': 'h3',
    'manifest.webmanifest': 'h4',
    'assets/editor-abc.js': 'h5',
    'pdfjs/cmaps/UniJIS-UCS2-H.bcmap': 'h6'
  }
};

const ROOT = buildRouteTable('https://stapler.app/', MANIFEST);
const get = (url: string, table = ROOT) => routeRequest({ url, method: 'GET' }, table);

describe('routeRequest', () => {
  it('ignores every cross-origin request, the pinned OCR model download included', () => {
    expect(
      get(
        'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int/eng.traineddata.gz'
      )
    ).toEqual({ kind: 'ignore' });
    expect(get('https://evil.example/assets/editor-abc.js')).toEqual({ kind: 'ignore' });
    // Same host, different scheme or port is a different origin.
    expect(get('http://stapler.app/index.html')).toEqual({ kind: 'ignore' });
    expect(get('https://stapler.app:8443/index.html')).toEqual({ kind: 'ignore' });
    expect(
      routeRequest({ url: 'https://evil.example/share-target', method: 'POST' }, ROOT)
    ).toEqual({ kind: 'ignore' });
  });

  it('serves entry pages from the cache, including extension-less and root URLs', () => {
    expect(get('https://stapler.app/')).toEqual({ kind: 'page', key: 'index.html' });
    expect(get('https://stapler.app/?share-target=1#/merge')).toEqual({
      kind: 'page',
      key: 'index.html'
    });
    expect(get('https://stapler.app/editor.html')).toEqual({ kind: 'page', key: 'editor.html' });
    expect(get('https://stapler.app/merge-pdf')).toEqual({ kind: 'page', key: 'merge-pdf.html' });
    expect(get('https://stapler.app/merge-pdf.html')).toEqual({
      kind: 'page',
      key: 'merge-pdf.html'
    });
  });

  it('serves listed build files cache-first, precached or runtime', () => {
    expect(get('https://stapler.app/assets/editor-abc.js')).toEqual({
      kind: 'asset',
      key: 'assets/editor-abc.js'
    });
    expect(get('https://stapler.app/ocr/tesseract-core-simd-lstm.wasm')).toEqual({
      kind: 'asset',
      key: 'ocr/tesseract-core-simd-lstm.wasm'
    });
    expect(get('https://stapler.app/assets/editor-abc.js?v=1')).toEqual({
      kind: 'asset',
      key: 'assets/editor-abc.js'
    });
  });

  it('leaves unknown same-origin paths and non-GET methods to the network', () => {
    expect(get('https://stapler.app/assets/unknown.js')).toEqual({ kind: 'ignore' });
    expect(get('https://stapler.app/sw.js')).toEqual({ kind: 'ignore' });
    expect(get('https://stapler.app/nope')).toEqual({ kind: 'ignore' });
    expect(routeRequest({ url: 'https://stapler.app/index.html', method: 'POST' }, ROOT)).toEqual({
      kind: 'ignore'
    });
    expect(
      routeRequest({ url: 'https://stapler.app/assets/editor-abc.js', method: 'HEAD' }, ROOT)
    ).toEqual({ kind: 'ignore' });
  });

  it('routes only a same-origin POST to the share target', () => {
    expect(
      routeRequest({ url: `https://stapler.app/${SHARE_TARGET_PATH}`, method: 'POST' }, ROOT)
    ).toEqual({ kind: 'share-target' });
    expect(get(`https://stapler.app/${SHARE_TARGET_PATH}`)).toEqual({ kind: 'ignore' });
  });

  it('respects a sub-path scope (a project site)', () => {
    const table = buildRouteTable('https://user.github.io/stapler/', MANIFEST);
    expect(get('https://user.github.io/stapler/', table)).toEqual({
      kind: 'page',
      key: 'index.html'
    });
    expect(get('https://user.github.io/stapler/assets/editor-abc.js', table)).toEqual({
      kind: 'asset',
      key: 'assets/editor-abc.js'
    });
    // Outside the scope, even on the same origin.
    expect(get('https://user.github.io/other/index.html', table)).toEqual({ kind: 'ignore' });
    expect(get('https://user.github.io/index.html', table)).toEqual({ kind: 'ignore' });
  });

  it('ignores malformed URLs and percent-encoding it cannot decode', () => {
    expect(get('not a url')).toEqual({ kind: 'ignore' });
    expect(get('https://stapler.app/%E0%A4%A')).toEqual({ kind: 'ignore' });
  });
});

describe('pageFor', () => {
  const pages = new Set(['index.html', 'merge-pdf.html', 'docs/index.html']);
  it('maps directory and extension-less paths to their HTML file', () => {
    expect(pageFor('', pages)).toBe('index.html');
    expect(pageFor('docs/', pages)).toBe('docs/index.html');
    expect(pageFor('merge-pdf', pages)).toBe('merge-pdf.html');
    expect(pageFor('missing/', pages)).toBeNull();
    expect(pageFor('assets/x.js', pages)).toBeNull();
  });
});

describe('staleCaches', () => {
  it('deletes only older precache versions — never the share inbox or other caches', () => {
    expect(
      staleCaches(
        [
          cacheName('v1'),
          cacheName('v2'),
          'stapler-share-inbox',
          'someone-else',
          `${CACHE_PREFIX}v0`
        ],
        'v2'
      )
    ).toEqual([cacheName('v1'), `${CACHE_PREFIX}v0`]);
  });
});

describe('planInstall', () => {
  it('downloads everything on first install', () => {
    expect(planInstall(MANIFEST, null)).toEqual({ copy: [], download: MANIFEST.precache });
  });

  it('copies only files whose content hash is unchanged', () => {
    const previous = { ...MANIFEST.revisions, 'index.html': 'old', 'editor.html': 'h2' };
    delete (previous as Record<string, string>)['pdfjs/cmaps/UniJIS-UCS2-H.bcmap'];
    const plan = planInstall(MANIFEST, previous);
    expect(plan.download).toEqual(['index.html', 'pdfjs/cmaps/UniJIS-UCS2-H.bcmap']);
    expect(plan.copy).toEqual([
      'editor.html',
      'merge-pdf.html',
      'manifest.webmanifest',
      'assets/editor-abc.js'
    ]);
  });
});

describe('retired previous version (audit 2026-10-01 PLT-4)', () => {
  const withRetired = () => ({
    ...buildRouteTable('https://stapler.app/', MANIFEST),
    retired: new Set([
      'assets/editor-OLD.js',
      'assets/editor-abc.js',
      'index.html',
      'old-only.html',
      RETIRED_KEY
    ])
  });

  it('serves a file only the previous version had from its kept cache', () => {
    expect(get('https://stapler.app/assets/editor-OLD.js', withRetired())).toEqual({
      kind: 'retired',
      key: 'assets/editor-OLD.js'
    });
  });

  it('prefers the current version for every file both have, pages above all', () => {
    const table = withRetired();
    expect(get('https://stapler.app/assets/editor-abc.js', table)).toEqual({
      kind: 'asset',
      key: 'assets/editor-abc.js'
    });
    expect(get('https://stapler.app/', table)).toEqual({ kind: 'page', key: 'index.html' });
  });

  it('never serves the worker’s own bookkeeping keys, and ignores retired files cross-origin', () => {
    const table = withRetired();
    expect(get(`https://stapler.app/${RETIRED_KEY}`, table)).toEqual({ kind: 'ignore' });
    expect(get('https://evil.example/assets/editor-OLD.js', table)).toEqual({ kind: 'ignore' });
  });

  it('without a kept cache, an old file is left to the network as before', () => {
    expect(get('https://stapler.app/assets/editor-OLD.js')).toEqual({ kind: 'ignore' });
  });

  it('while a restarted worker is still reading the kept cache back, holds what could be in it', () => {
    const loading = { ...buildRouteTable('https://stapler.app/', MANIFEST), retiredLoading: true };
    expect(get('https://stapler.app/assets/editor-OLD.js', loading)).toEqual({
      kind: 'retired-pending',
      key: 'assets/editor-OLD.js'
    });
    // This version's own files and pages are never held.
    expect(get('https://stapler.app/assets/editor-abc.js', loading)).toEqual({
      kind: 'asset',
      key: 'assets/editor-abc.js'
    });
    expect(get('https://stapler.app/', loading)).toEqual({ kind: 'page', key: 'index.html' });
    // Nor a navigation, a directory, bookkeeping, another origin or a non-GET.
    expect(
      routeRequest(
        { url: 'https://stapler.app/old-only.html', method: 'GET', mode: 'navigate' },
        loading
      )
    ).toEqual({ kind: 'ignore' });
    expect(get('https://stapler.app/somewhere/', loading)).toEqual({ kind: 'ignore' });
    expect(get(`https://stapler.app/${RETIRED_KEY}`, loading)).toEqual({ kind: 'ignore' });
    expect(get('https://evil.example/assets/editor-OLD.js', loading)).toEqual({ kind: 'ignore' });
    expect(
      routeRequest({ url: 'https://stapler.app/assets/editor-OLD.js', method: 'PUT' }, loading)
    ).toEqual({ kind: 'ignore' });
  });

  it('once the kept cache is known, answers from it directly, and lets the rest through', () => {
    const loaded = { ...withRetired(), retiredLoading: false };
    expect(get('https://stapler.app/assets/editor-OLD.js', loaded)).toEqual({
      kind: 'retired',
      key: 'assets/editor-OLD.js'
    });
    expect(get('https://stapler.app/not-a-build-file.txt', loaded)).toEqual({ kind: 'ignore' });
  });

  it('never serves a retired file to a navigation', () => {
    expect(
      routeRequest(
        { url: 'https://stapler.app/assets/editor-OLD.js', method: 'GET', mode: 'navigate' },
        withRetired()
      )
    ).toEqual({ kind: 'ignore' });
  });

  it('keeps the most recently activated complete cache', () => {
    expect(
      pickRetiredCache([
        { name: 'a', activatedAt: 100, complete: true },
        { name: 'b', activatedAt: 300, complete: true },
        // Installed but never activated (a superseded waiting worker).
        { name: 'c', activatedAt: null, complete: true },
        // Newest, but its install never finished.
        { name: 'd', activatedAt: 400, complete: false }
      ])
    ).toBe('b');
    // A cache from before activation was recorded still counts if it is all there is.
    expect(pickRetiredCache([{ name: 'legacy', activatedAt: null, complete: true }])).toBe(
      'legacy'
    );
    expect(pickRetiredCache([{ name: 'x', activatedAt: 1, complete: false }])).toBeNull();
    expect(pickRetiredCache([])).toBeNull();
  });

  it('accepts only a well-formed retired record naming a precache cache', () => {
    const ok = { cache: cacheName('v1'), clients: ['a', 'b'] };
    expect(parseRetiredRecord(ok)).toEqual(ok);
    expect(parseRetiredRecord({ cache: 'stapler-share-inbox', clients: [] })).toBeNull();
    expect(parseRetiredRecord({ cache: cacheName('v1'), clients: [1] })).toBeNull();
    expect(parseRetiredRecord(null)).toBeNull();
    expect(parseRetiredRecord('x')).toBeNull();
  });

  it('maps cache keys back to scope-relative paths', () => {
    expect(scopeRelative('https://stapler.app/assets/a.js', 'https://stapler.app/')).toBe(
      'assets/a.js'
    );
    expect(
      scopeRelative('https://u.github.io/stapler/index.html', 'https://u.github.io/stapler/')
    ).toBe('index.html');
    expect(scopeRelative('https://u.github.io/other/x.js', 'https://u.github.io/stapler/')).toBe(
      null
    );
    expect(scopeRelative('https://evil.example/a.js', 'https://stapler.app/')).toBeNull();
  });
});

describe('classifyShareRequest: what may store files at all (audit 2026-10-01 PLT-3)', () => {
  const ORIGIN = 'https://stapler.app';
  const share = (over: Partial<ShareRequestInput>): ShareRequestInput => ({
    origin: null,
    secFetchSite: null,
    referrer: '',
    initiator: 'none',
    ...over
  });

  it('allows what an OS share sheet sends: no origin, referrer or initiating page', () => {
    // Stored, but marked unverified: the app asks before opening it.
    expect(classifyShareRequest(share({}), ORIGIN)).toBe('unverified');
    expect(classifyShareRequest(share({ origin: 'null' }), ORIGIN)).toBe('unverified');
    expect(classifyShareRequest(share({ secFetchSite: 'none' }), ORIGIN)).toBe('unverified');
  });

  it('allows the app’s own pages', () => {
    expect(
      classifyShareRequest(
        share({
          origin: ORIGIN,
          referrer: `${ORIGIN}/editor.html`,
          secFetchSite: 'same-origin',
          initiator: 'same-origin'
        }),
        ORIGIN
      )
    ).toBe('verified');
  });

  it('rejects a cross-site or same-site fetch site', () => {
    expect(classifyShareRequest(share({ secFetchSite: 'cross-site' }), ORIGIN)).toBe('reject');
    expect(classifyShareRequest(share({ secFetchSite: 'Same-Site' }), ORIGIN)).toBe('reject');
  });

  it('rejects a foreign Origin header, as a website auto-submitting a form sends (probed)', () => {
    expect(
      classifyShareRequest(
        share({ origin: 'https://evil.example', referrer: 'https://evil.example/' }),
        ORIGIN
      )
    ).toBe('reject');
    expect(classifyShareRequest(share({ origin: 'http://stapler.app' }), ORIGIN)).toBe('reject');
  });

  it('rejects a foreign or unparseable referrer even without an Origin', () => {
    expect(classifyShareRequest(share({ referrer: 'https://evil.example/x' }), ORIGIN)).toBe(
      'reject'
    );
    expect(classifyShareRequest(share({ referrer: 'not a url' }), ORIGIN)).toBe('reject');
  });

  it('rejects a no-referrer post started by a page of another origin (Origin: null + client)', () => {
    expect(classifyShareRequest(share({ origin: 'null', initiator: 'foreign' }), ORIGIN)).toBe(
      'reject'
    );
  });
});

describe('classifyShareRequest (audit 2026-10-01 PLT-3)', () => {
  const ORIGIN = 'https://stapler.app';
  const share = (over: Partial<ShareRequestInput>): ShareRequestInput => ({
    origin: null,
    secFetchSite: null,
    referrer: '',
    initiator: 'none',
    ...over
  });

  it('verifies a share that carries this origin, and nothing foreign', () => {
    expect(classifyShareRequest(share({ origin: ORIGIN }), ORIGIN)).toBe('verified');
    expect(classifyShareRequest(share({ referrer: `${ORIGIN}/editor.html` }), ORIGIN)).toBe(
      'verified'
    );
    expect(classifyShareRequest(share({ initiator: 'same-origin' }), ORIGIN)).toBe('verified');
    expect(classifyShareRequest(share({ secFetchSite: 'same-origin' }), ORIGIN)).toBe('verified');
  });

  it('cannot verify what an OS share sends — nor a foreign no-referrer new window, which is identical', () => {
    expect(classifyShareRequest(share({}), ORIGIN)).toBe('unverified');
    expect(classifyShareRequest(share({ origin: 'null' }), ORIGIN)).toBe('unverified');
    expect(classifyShareRequest(share({ secFetchSite: 'none' }), ORIGIN)).toBe('unverified');
  });

  it('rejects any foreign sign, even next to a same-origin one', () => {
    expect(classifyShareRequest(share({ origin: 'https://evil.example' }), ORIGIN)).toBe('reject');
    expect(
      classifyShareRequest(share({ origin: ORIGIN, referrer: 'https://evil.example/' }), ORIGIN)
    ).toBe('reject');
    expect(classifyShareRequest(share({ origin: ORIGIN, initiator: 'foreign' }), ORIGIN)).toBe(
      'reject'
    );
    expect(
      classifyShareRequest(share({ origin: ORIGIN, secFetchSite: 'cross-site' }), ORIGIN)
    ).toBe('reject');
    expect(classifyShareRequest(share({ referrer: 'not a url' }), ORIGIN)).toBe('reject');
  });
});

describe('held-request passthrough (audit 2026-10-01 PLT-4 follow-up)', () => {
  const ORIGIN = 'https://stapler.app';
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('forwards only a GET to the worker’s own origin', () => {
    expect(isPassThroughAllowed({ url: `${ORIGIN}/x.json?v=2`, method: 'GET' }, ORIGIN)).toBe(true);
    expect(isPassThroughAllowed({ url: `${ORIGIN}/x.json`, method: 'get' }, ORIGIN)).toBe(true);
    expect(
      isPassThroughAllowed({ url: 'https://evil.example/x.json', method: 'GET' }, ORIGIN)
    ).toBe(false);
    expect(isPassThroughAllowed({ url: 'http://stapler.app/x.json', method: 'GET' }, ORIGIN)).toBe(
      false
    );
    expect(isPassThroughAllowed({ url: `${ORIGIN}/x.json`, method: 'POST' }, ORIGIN)).toBe(false);
    expect(isPassThroughAllowed({ url: 'not a url', method: 'GET' }, ORIGIN)).toBe(false);
  });

  it('hands the browser’s own Request on unchanged — query, headers and real status kept', async () => {
    const network = vi.fn(async () => new Response('nope', { status: 404 }));
    vi.stubGlobal('fetch', network);
    const request = new Request(`${ORIGIN}/data/x.json?v=2`, {
      headers: { range: 'bytes=0-9', 'x-probe': '1' }
    });
    const response = await passThrough(request, ORIGIN);
    expect(network).toHaveBeenCalledTimes(1);
    // The very same object: nothing rebuilt from the path, nothing dropped.
    expect(network.mock.calls[0]).toEqual([request]);
    expect((network.mock.calls[0] as unknown[])[0]).toBe(request);
    expect(response.status).toBe(404);
  });

  it('gives each of two concurrent requests for one URL its own response', async () => {
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(`r${++n}`))
    );
    const url = `${ORIGIN}/same.txt`;
    const [a, b] = await Promise.all([
      passThrough(new Request(url), ORIGIN),
      passThrough(new Request(url), ORIGIN)
    ]);
    expect([await a.text(), await b.text()].sort()).toEqual(['r1', 'r2']);
  });

  it('refuses anything else without touching the network', async () => {
    const network = vi.fn(async () => new Response('x'));
    vi.stubGlobal('fetch', network);
    const foreign = await passThrough(new Request('https://evil.example/x.js'), ORIGIN);
    const post = await passThrough(
      new Request(`${ORIGIN}/x`, { method: 'POST', body: 'b' }),
      ORIGIN
    );
    expect(foreign.type).toBe('error');
    expect(post.type).toBe('error');
    expect(network).not.toHaveBeenCalled();
  });
});
