/**
 * Audit 2026-10-01 PLT-4 follow-up — the one place the web build's service
 * worker hands a request to the network itself.
 *
 * After a restart the worker briefly holds same-origin GETs that could be a
 * file of the previous version it keeps for open tabs (`retired-pending` in
 * `sw-routing.ts`). Once it knows a held request is *not* such a file, it
 * must behave as if it had never intercepted it: same URL with its query,
 * same method, headers (`Range`…), credentials, referrer and cache mode, the
 * real status (a 404 stays a 404), no timeout. The Cache API cannot do that
 * (`cache.add` turns every non-2xx into a failure, keys on the URL, and drops
 * request headers), so this forwards the browser's own `Request` object,
 * unchanged, with `fetch` — the request the browser was about to make.
 *
 * This file is in `NETWORK_ALLOWED_FILES` (`scripts/network-guard.mjs`), the
 * analyzer's whole-file exemption, because no static check can prove a
 * `Request` received at run time is same-origin. The proof is here instead,
 * and is all this file does: only a GET to the worker's own origin is ever
 * forwarded; anything else is refused with a network error. It never builds a
 * URL, never adds a header, and never stores the response.
 */

/** `true` for the only requests {@link passThrough} forwards. */
export function isPassThroughAllowed(
  request: { url: string; method: string },
  scopeOrigin: string
): boolean {
  if (request.method.toUpperCase() !== 'GET') return false;
  try {
    return new URL(request.url).origin === scopeOrigin;
  } catch {
    return false;
  }
}

/**
 * The network's answer to `request`, exactly as the browser would have got
 * it without a worker — for a same-origin GET only.
 */
export function passThrough(request: Request, scopeOrigin: string): Promise<Response> {
  if (!isPassThroughAllowed(request, scopeOrigin)) return Promise.resolve(Response.error());
  // eslint-disable-next-line no-restricted-globals -- same-origin GET passthrough, checked above; see the file comment.
  return fetch(request);
}
