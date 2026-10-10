import { describe, expect, it } from 'vitest';
import {
  fontSourceUrls,
  installNetworkGuard,
  type GuardScope
} from '../../src/core/workers/network-guard';

/**
 * Audit 2026-10-10 S3 — the worker network guard checked one URL and
 * forwarded another, and several request APIs were not wrapped at all.
 *
 * The fake scope's APIs record exactly what they were handed, the way the
 * real ones would interpret it (`toString()` for a non-Request, the internal
 * URL for a Request), so each test asserts what would actually have gone out.
 */
const WEB = 'https://stapler.app/assets/ocr.worker-abc.js';
const EVIL = 'https://evil.example/beacon';

/** What the real API would request for `input`. */
function realUrl(input: unknown): string {
  return input instanceof Request ? input.url : String(input);
}

function fakeScope() {
  const sent: string[] = [];
  class XMLHttpRequest {
    open(_method: string, url: unknown) {
      sent.push(`xhr ${realUrl(url)}`);
    }
  }
  class Worker {
    url: string;
    constructor(url: unknown) {
      this.url = String(url);
      sent.push(`worker ${this.url}`);
    }
  }
  class Cache {
    add(request: unknown) {
      sent.push(`cache ${realUrl(request)}`);
      return Promise.resolve();
    }
    addAll(requests: unknown[]) {
      for (const request of requests) sent.push(`cache ${realUrl(request)}`);
      return Promise.resolve();
    }
  }
  class FontFace {
    constructor(
      public family: string,
      public source: unknown
    ) {
      sent.push(`font ${typeof source === 'string' ? source : 'binary'}`);
    }
  }
  const scope: GuardScope = {
    location: { href: WEB },
    Request,
    fetch: (input: unknown) => {
      sent.push(`fetch ${realUrl(input)}`);
      return Promise.resolve('ok');
    },
    importScripts: (...urls: unknown[]) => {
      for (const url of urls) sent.push(`import ${String(url)}`);
    },
    XMLHttpRequest,
    Worker,
    Cache,
    FontFace
  };
  installNetworkGuard(scope);
  return { scope, sent, Cache };
}

/** An object whose `.url` looks same-origin but which stringifies remote. */
const liar = () => ({ url: '/same-origin', toString: () => EVIL });

describe('audit 2026-10-10 S3: check and forward the same normalised value', () => {
  it('fetch: a toString() liar is judged by what it stringifies to', async () => {
    const { scope, sent } = fakeScope();
    const fetch = scope.fetch as (input: unknown) => Promise<unknown>;
    await expect(fetch(liar())).rejects.toThrow(/blocked/);
    expect(sent).toEqual([]);

    // And the reverse liar is forwarded as its string, not as the object.
    const sameOrigin = { url: EVIL, toString: () => '/pdfjs/cmaps/x.bcmap' };
    await expect(fetch(sameOrigin)).resolves.toBe('ok');
    expect(sent).toEqual(['fetch /pdfjs/cmaps/x.bcmap']);
  });

  it('fetch: a real Request is passed through and judged by its real URL', async () => {
    const { scope, sent } = fakeScope();
    const fetch = scope.fetch as (input: unknown) => Promise<unknown>;
    await expect(fetch(new Request('https://stapler.app/ocr/x.wasm'))).resolves.toBe('ok');
    await expect(fetch(new Request(EVIL))).rejects.toThrow(/blocked/);

    // A subclass overriding `url` cannot lie: the original getter is used.
    class Lying extends Request {
      override get url() {
        return 'https://stapler.app/fine';
      }
    }
    await expect(fetch(new Lying(EVIL))).rejects.toThrow(/blocked/);
    // An object merely inheriting Request.prototype is refused.
    await expect(fetch(Object.create(Request.prototype))).rejects.toThrow(/blocked/);
    expect(sent).toEqual(['fetch https://stapler.app/ocr/x.wasm']);
  });

  it('XMLHttpRequest#open: toString() liars and the prototype-chain escape are both blocked', () => {
    const { scope, sent } = fakeScope();
    const Xhr = scope.XMLHttpRequest as new () => { open(m: string, u: unknown): void };
    expect(() => new Xhr().open('GET', liar())).toThrow(/blocked/);

    // The old wrapper was a subclass; its parent was the unguarded original.
    const Parent = Object.getPrototypeOf(Xhr) as unknown;
    if (typeof Parent === 'function' && Parent !== Function.prototype) {
      const Raw = Parent as new () => { open(m: string, u: unknown): void };
      expect(() => new Raw().open('GET', EVIL)).toThrow(/blocked/);
    }
    // However the instance was made, `open` is the guarded one.
    const bare = Object.create(Xhr.prototype) as { open(m: string, u: unknown): void };
    expect(() => bare.open('GET', EVIL)).toThrow(/blocked/);

    new Xhr().open('GET', { toString: () => '/pdfjs/iccs/x.icc' });
    expect(sent).toEqual(['xhr /pdfjs/iccs/x.icc']);

    // And it cannot be put back.
    expect(() => {
      (Xhr.prototype as { open: unknown }).open = () => {};
    }).toThrow(TypeError);
  });

  it('importScripts forwards the checked strings', () => {
    const { scope, sent } = fakeScope();
    const importScripts = scope.importScripts as (...urls: unknown[]) => void;
    expect(() => importScripts(liar())).toThrow(/blocked/);
    importScripts({ toString: () => '/ocr/worker.min.js' });
    expect(sent).toEqual(['import /ocr/worker.min.js']);
  });
});

describe('audit 2026-10-10 S3: request APIs that were not wrapped', () => {
  it('nested Worker: same-origin only, no blob:/data:, and no way back to the native one', () => {
    const { scope, sent } = fakeScope();
    const Worker = scope.Worker as new (url: unknown) => { url: string };
    const ok = new Worker('/ocr/worker.min.js');
    expect(ok.url).toBe('/ocr/worker.min.js');
    expect(ok).toBeInstanceOf(Worker);
    expect(() => new Worker(EVIL)).toThrow(/blocked/);
    expect(() => new Worker(liar())).toThrow(/blocked/);
    expect(() => new Worker('blob:https://stapler.app/1234')).toThrow(/blocked/);
    expect(() => new Worker('data:text/javascript,fetch(1)')).toThrow(/blocked/);
    expect(Object.getPrototypeOf(Worker)).toBe(Function.prototype);
    expect(sent).toEqual(['worker /ocr/worker.min.js']);
  });

  it('nested Worker: a subclass of the guarded constructor (as ocr.worker.ts makes) still works', () => {
    const { scope, sent } = fakeScope();
    const Guarded = scope.Worker as new (url: unknown) => { url: string };
    const spawned: object[] = [];
    class Captured extends Guarded {
      constructor(url: unknown) {
        super(url);
        spawned.push(this);
      }
    }
    // ocr.worker.ts assigns self.Worker for the duration of tesseract's start.
    scope.Worker = Captured;
    const w = new (scope.Worker as typeof Captured)('/ocr/worker.min.js');
    expect(w).toBeInstanceOf(Captured);
    expect(spawned).toEqual([w]);
    expect(() => new Captured(EVIL)).toThrow(/blocked/);
    scope.Worker = Guarded;
    expect(sent).toEqual(['worker /ocr/worker.min.js']);
  });

  it('Cache#add / Cache#addAll: remote entries are refused, the whole batch with them', async () => {
    const { sent, Cache } = fakeScope();
    const cache = new Cache();
    await expect(cache.add(EVIL)).rejects.toThrow(/blocked/);
    await expect(cache.add(liar())).rejects.toThrow(/blocked/);
    await expect(cache.addAll(['/a.js', new Request(EVIL)])).rejects.toThrow(/blocked/);
    expect(sent).toEqual([]);
    await cache.add('/sw-kept.js');
    await cache.addAll(['/a.js', new Request('https://stapler.app/b.js')]);
    expect(sent).toEqual(['cache /sw-kept.js', 'cache /a.js', 'cache https://stapler.app/b.js']);
  });

  it('FontFace: a remote url() source is refused; local and binary sources pass', () => {
    const { scope, sent } = fakeScope();
    const FontFace = scope.FontFace as new (family: string, source: unknown) => object;
    expect(() => new FontFace('X', `url(${EVIL})`)).toThrow(/blocked/);
    expect(() => new FontFace('X', `local(Arial), url("${EVIL}") format("woff2")`)).toThrow(
      /blocked/
    );
    expect(() => new FontFace('X', `src('${EVIL}')`)).toThrow(/blocked/);
    // A CSS escape could spell url( another way: refused, not guessed at.
    expect(() => new FontFace('X', `\\75rl(${EVIL})`)).toThrow(/blocked/);
    expect(() => new FontFace('X', { toString: () => `url(${EVIL})` })).toThrow(/blocked/);

    new FontFace('X', 'url(/fonts/NotoSansDevanagari.ttf)');
    new FontFace('X', new Uint8Array([0, 1, 0, 0]));
    expect(sent).toEqual(['font url(/fonts/NotoSansDevanagari.ttf)', 'font binary']);
  });
});

describe('fontSourceUrls', () => {
  it('reads quoted and bare url()/src() and refuses what it cannot read', () => {
    expect(fontSourceUrls('local(Arial)')).toEqual([]);
    expect(fontSourceUrls('url(a.woff) format("woff"), url("b.ttf"), src(\'c\')')).toEqual([
      'a.woff',
      'b.ttf',
      'c'
    ]);
    expect(fontSourceUrls('url(a b)')).toBeNull();
    expect(fontSourceUrls('URL(x)')).toEqual(['x']);
    expect(fontSourceUrls('u\\72l(x)')).toBeNull();
  });
});
