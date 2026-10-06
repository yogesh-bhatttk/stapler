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
 *  - `WebSocket`, `EventSource`, `WebTransport`, `RTCPeerConnection`: refused
 *    outright — Stapler has no use for any of them.
 *
 * The replacements are installed non-writable and non-configurable, so a
 * library cannot quietly put the originals back.
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

function lock(scope: GuardScope, name: string, value: unknown): void {
  try {
    Object.defineProperty(scope, name, {
      value,
      writable: false,
      configurable: false,
      enumerable: false
    });
  } catch {
    // Already locked by a previous install: nothing to do.
  }
}

function urlOfInput(input: unknown): string {
  if (input && typeof input === 'object' && 'url' in input) {
    return String((input as { url: unknown }).url);
  }
  return String(input);
}

const REFUSED_CONSTRUCTORS = ['WebSocket', 'EventSource', 'WebTransport', 'RTCPeerConnection'];

export function installNetworkGuard(scope: GuardScope = globalThis as unknown as GuardScope): void {
  if (scope[INSTALLED as unknown as string]) return;
  lock(scope, INSTALLED as unknown as string, true);

  const allowed = (url: string) => isWorkerRequestAllowed(url, scope.location?.href ?? '');

  const realFetch = scope.fetch;
  if (typeof realFetch === 'function') {
    const original = realFetch as (input: unknown, init?: unknown) => Promise<unknown>;
    lock(scope, 'fetch', function guardedFetch(input: unknown, init?: unknown) {
      const url = urlOfInput(input);
      if (!allowed(url)) return Promise.reject(blockedRequestError(url));
      return original.call(scope, input, init);
    });
  }

  const RealXhr = scope.XMLHttpRequest;
  if (typeof RealXhr === 'function') {
    const Base = RealXhr as new () => { open(...args: unknown[]): void };
    class GuardedXMLHttpRequest extends Base {
      open(...args: unknown[]): void {
        const url = urlOfInput(args[1]);
        if (!allowed(url)) throw blockedRequestError(url);
        super.open(...args);
      }
    }
    lock(scope, 'XMLHttpRequest', GuardedXMLHttpRequest);
  }

  const realImportScripts = scope.importScripts;
  if (typeof realImportScripts === 'function') {
    const original = realImportScripts as (...urls: unknown[]) => void;
    lock(scope, 'importScripts', function guardedImportScripts(...urls: unknown[]) {
      for (const url of urls) {
        if (!allowed(urlOfInput(url))) throw blockedRequestError(urlOfInput(url));
      }
      original.apply(scope, urls);
    });
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
