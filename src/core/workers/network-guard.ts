/**
 * Audit 2026-10-01 PLT-2 — the zero-network backstop *inside* every worker.
 *
 * Imported first by each `*.worker.ts` entry, so it runs before any library
 * in that worker is evaluated. It replaces the worker's network APIs with
 * versions that refuse anything `isWorkerRequestAllowed` (`network-policy.ts`)
 * does not allow — the CSP's `connect-src` without its remote source:
 *
 *  - `fetch` and `XMLHttpRequest#open`: refused (a rejected promise / a thrown
 *    `TypeError`, exactly what a CSP block looks like to the caller) unless
 *    same-origin, `blob:` or `data:` (no remote source: the OCR model is
 *    downloaded on the main thread, see `network-policy.ts`);
 *  - `importScripts`: the same rule, per URL (module workers cannot call it
 *    at all; this covers a classic worker should one ever be added);
 *  - `WebSocket`, `WebSocketStream`, `EventSource`, `WebTransport`,
 *    `RTCPeerConnection`: refused outright — Stapler has no use for any of them;
 *  - `new Worker`/`new SharedWorker` (a nested worker the guard would not be
 *    in): same-origin scripts only (audit 2026-10-10 S3);
 *  - `Cache#add`/`Cache#addAll`, which fetch: the same rule as `fetch`;
 *  - `new FontFace(family, 'url(…)')`: refused unless every `url()` is
 *    allowed (binary sources load nothing and pass).
 *
 * Every input is normalised exactly as the real API would (`toString()` for a
 * non-`Request`), and the normalised value is both what is checked and what
 * is forwarded (audit 2026-10-10 S3). The replacements are installed
 * non-writable and non-configurable (XHR's `open` and Cache's methods on the
 * prototype), so a library cannot quietly put the originals back; `Worker`
 * alone stays writable, see below.
 *
 * Why it exists: the extension's CSP covers its workers, but the website's
 * CSP is a `<meta>` tag, which only governs its own document (see
 * `scripts/csp.mjs`). This is a backstop against a dependency's stray
 * request, not a sandbox against hostile code already running in the worker;
 * what it does not cover is listed in `scripts/csp.mjs`.
 *
 * This file is exempt from the zero-network analyzer (`NETWORK_ALLOWED_FILES`
 * in `scripts/network-guard.mjs`) because it must hold a reference to the
 * real `fetch` to pass allowed requests through. It makes no request itself.
 */
import { isWorkerRequestAllowed } from './network-policy';

/** The slice of a worker global this touches, so tests can pass a fake. */
export type GuardScope = Record<string, unknown> & { location?: { href: string } };

const INSTALLED = Symbol.for('stapler.networkGuard');

/** The error a refused request fails with. */
export function blockedRequestError(what: string): TypeError {
  return new TypeError(`Stapler blocked a network request from a worker (${what})`);
}

function lock(scope: object, name: string, value: unknown, writable = false): void {
  try {
    Object.defineProperty(scope, name, {
      value,
      writable,
      configurable: false,
      enumerable: false
    });
  } catch {
    // Already locked by a previous install: nothing to do.
  }
}

/**
 * Audit 2026-10-10 S3 — what a request API is about to fetch, and the exact
 * value to hand it.
 *
 * The real `fetch`/`XMLHttpRequest#open`/`importScripts` turn anything that
 * is not a `Request` into a URL string with `toString()`. Reading an
 * object's `.url` instead (as the first version did) checked one URL and
 * forwarded another: `fetch({ url: '/same-origin', toString: () => 'https://evil' })`
 * passed the check and fetched `https://evil`. So the input is normalised
 * *once* here, the result is what gets checked, and the result — never the
 * original object — is what the real API receives.
 *
 * A genuine `Request` is passed through as itself (its body and init must
 * survive), and its URL is read through the *original* `Request.prototype.url`
 * getter, so a subclass overriding `url` cannot lie about where it goes; an
 * object that only pretends to be a `Request` makes that getter throw and is
 * refused.
 */
type Normalised = { target: unknown; url: string };

function makeNormaliser(scope: GuardScope): (input: unknown) => Normalised {
  const RequestCtor = (scope.Request ?? (globalThis as Record<string, unknown>).Request) as
    (abstract new (...args: never[]) => object) | undefined;
  const urlGetter =
    typeof RequestCtor === 'function'
      ? Object.getOwnPropertyDescriptor(RequestCtor.prototype, 'url')?.get
      : undefined;
  return input => {
    if (typeof RequestCtor === 'function' && urlGetter && input instanceof RequestCtor) {
      let url: string;
      try {
        url = String(Reflect.apply(urlGetter, input, []));
      } catch {
        throw blockedRequestError('an object posing as a Request');
      }
      return { target: input, url };
    }
    const url = String(input);
    return { target: url, url };
  };
}

/**
 * The URLs a `FontFace` source string would load, or `null` when it cannot be
 * read with confidence (a CSS escape could spell `url(` some other way).
 */
export function fontSourceUrls(source: string): string[] | null {
  if (source.includes('\\')) return null;
  const urls: string[] = [];
  const re = /\b(?:url|src)\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s"']*))\s*\)/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) urls.push(match[1] ?? match[2] ?? match[3] ?? '');
  // Every `url(`/`src(` must have parsed; a stray one means a shape we don't read.
  const opened = source.match(/\b(?:url|src)\(/gi)?.length ?? 0;
  return opened === urls.length ? urls : null;
}

/**
 * A real `ArrayBuffer` or view — what `FontFace` takes as binary data. Checked
 * with brand checks that cannot be spoofed (`isView`, the `byteLength`
 * getter), because anything else is stringified and parsed as CSS.
 */
function isBinary(value: unknown): boolean {
  if (ArrayBuffer.isView(value)) return true;
  const getter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')?.get;
  try {
    return !!getter && typeof value === 'object' && value !== null && (getter.call(value), true);
  } catch {
    return false;
  }
}

const REFUSED_CONSTRUCTORS = [
  'WebSocket',
  'WebSocketStream',
  'EventSource',
  'WebTransport',
  'RTCPeerConnection'
];

type Ctor = new (...args: unknown[]) => object;

/**
 * A replacement constructor that checks its arguments and then builds the
 * real object. A plain function, not `class extends Real`: a subclass would
 * hand the original back through `Object.getPrototypeOf(Guarded)` (the hole
 * audit 2026-10-10 S3 found in the first XHR wrapper). It still supports
 * `new` from a subclass (`ocr.worker.ts` extends `Worker`) and keeps
 * `instanceof` working through the shared `prototype`.
 */
function guardedConstructor(Real: Ctor, check: (args: unknown[]) => unknown[]): Ctor {
  const Guarded = function (this: unknown, ...args: unknown[]) {
    if (!new.target) throw new TypeError("Failed to construct: Please use the 'new' operator");
    return Reflect.construct(Real, check(args), new.target);
  } as unknown as Ctor;
  Object.defineProperty(Guarded, 'prototype', { value: Real.prototype, writable: false });
  Object.defineProperty(Guarded, 'name', { value: Real.name });
  return Guarded;
}

export function installNetworkGuard(scope: GuardScope = globalThis as unknown as GuardScope): void {
  if (scope[INSTALLED as unknown as string]) return;
  lock(scope, INSTALLED as unknown as string, true);

  const allowed = (url: string) => isWorkerRequestAllowed(url, scope.location?.href ?? '');
  const normalise = makeNormaliser(scope);
  /** Normalise, check, and return the value the real API must receive. */
  const checked = (input: unknown): unknown => {
    const { target, url } = normalise(input);
    if (!allowed(url)) throw blockedRequestError(url);
    return target;
  };

  const realFetch = scope.fetch;
  if (typeof realFetch === 'function') {
    const original = realFetch as (input: unknown, init?: unknown) => Promise<unknown>;
    lock(scope, 'fetch', function guardedFetch(input: unknown, init?: unknown) {
      let target: unknown;
      try {
        target = checked(input);
      } catch (err) {
        return Promise.reject(err);
      }
      return Reflect.apply(original, scope, [target, init]);
    });
  }

  // XMLHttpRequest: the *prototype's* `open` is replaced, so every instance is
  // guarded however it was constructed — `new (Object.getPrototypeOf(XMLHttpRequest))()`
  // defeated the old subclass wrapper, and there is now no subclass to see past.
  const RealXhr = scope.XMLHttpRequest;
  if (typeof RealXhr === 'function') {
    const proto = (RealXhr as Ctor).prototype as { open?: unknown };
    const realOpen = proto.open;
    if (typeof realOpen === 'function') {
      lock(proto, 'open', function guardedOpen(this: unknown, ...args: unknown[]) {
        const rest = args.slice(2);
        return Reflect.apply(realOpen, this, [args[0], checked(args[1]), ...rest]);
      });
    }
    lock(scope, 'XMLHttpRequest', RealXhr);
  }

  const realImportScripts = scope.importScripts;
  if (typeof realImportScripts === 'function') {
    const original = realImportScripts as (...urls: unknown[]) => void;
    lock(scope, 'importScripts', function guardedImportScripts(...urls: unknown[]) {
      const targets = urls.map(url => checked(String(url)));
      Reflect.apply(original, scope, targets);
    });
  }

  // A nested worker runs code this guard never sees, so only this build's own
  // scripts may start one: same-origin, not `blob:`/`data:` (the CSP's
  // `worker-src 'self'`). Writable, because `ocr.worker.ts` swaps
  // `self.Worker` for a capturing subclass while tesseract starts — of *this*
  // guarded constructor, so the native one is never reachable again.
  for (const name of ['Worker', 'SharedWorker']) {
    const Real = scope[name];
    if (typeof Real !== 'function') continue;
    const Guarded = guardedConstructor(Real as Ctor, ([url, ...rest]) => {
      const href = String(url);
      const own = isWorkerRequestAllowed(href, scope.location?.href ?? '');
      if (!own || /^\s*(blob|data):/i.test(href)) throw blockedRequestError(`${name} ${href}`);
      return [href, ...rest];
    });
    lock(scope, name, Guarded, true);
  }

  // `cache.add(x)` / `cache.addAll([...])` fetch their arguments.
  const RealCache = scope.Cache;
  if (typeof RealCache === 'function') {
    const proto = (RealCache as Ctor).prototype as { add?: unknown; addAll?: unknown };
    const realAdd = proto.add;
    if (typeof realAdd === 'function') {
      lock(proto, 'add', function guardedAdd(this: unknown, request: unknown) {
        try {
          return Reflect.apply(realAdd, this, [checked(request)]) as Promise<void>;
        } catch (err) {
          return Promise.reject(err);
        }
      });
    }
    const realAddAll = proto.addAll;
    if (typeof realAddAll === 'function') {
      lock(proto, 'addAll', function guardedAddAll(this: unknown, requests: Iterable<unknown>) {
        try {
          return Reflect.apply(realAddAll, this, [Array.from(requests, checked)]) as Promise<void>;
        } catch (err) {
          return Promise.reject(err);
        }
      });
    }
  }

  // `new FontFace(family, 'url(https://…)')` loads that URL. Binary sources
  // (ArrayBuffer / typed array) load nothing and pass straight through.
  const RealFontFace = scope.FontFace;
  if (typeof RealFontFace === 'function') {
    const Guarded = guardedConstructor(RealFontFace as Ctor, args => {
      const [family, source, ...rest] = args;
      if (isBinary(source)) return args;
      const text = String(source);
      const urls = fontSourceUrls(text);
      if (!urls) throw blockedRequestError(`FontFace ${text}`);
      for (const url of urls) {
        if (!allowed(url)) throw blockedRequestError(`FontFace ${url}`);
      }
      return [family, text, ...rest];
    });
    lock(scope, 'FontFace', Guarded);
  }

  for (const name of REFUSED_CONSTRUCTORS) {
    if (!(name in scope)) continue;
    lock(scope, name, function refused() {
      throw blockedRequestError(name);
    });
  }
}

// Only inside a real worker: importing this module elsewhere (a unit test,
// the main thread) must not change that realm's globals.
declare const WorkerGlobalScope: (abstract new () => unknown) | undefined;
if (typeof WorkerGlobalScope === 'function' && globalThis instanceof WorkerGlobalScope) {
  installNetworkGuard();
}
