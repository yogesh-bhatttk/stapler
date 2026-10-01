/**
 * Audit 2026-10-01 PLT-2 — which URLs a Stapler worker may request.
 *
 * The CSP (`scripts/csp.mjs`) is the runtime backstop for zero-network
 * (CLAUDE.md invariant #1), but on the website it is a `<meta>` tag, and a
 * meta-tag policy governs only its own document — not the dedicated workers
 * that document starts (a worker gets its policy from its own response
 * headers, and GitHub Pages sends none). `network-guard.ts` closes that gap
 * by wrapping the network APIs inside every worker; this file is the pure
 * rule it applies, kept apart so it is unit-tested and analysed by the
 * zero-network guard like any other source file.
 *
 * The rule is the CSP's `connect-src` *minus* its one remote source: the
 * worker's own origin, `blob:` and `data:`. The pinned OCR model directories
 * are left out on purpose — the model is downloaded on the main thread
 * (`ocr/download.ts`, called from `runOcr.ts`) and handed to tesseract
 * through its cache; the OCR worker is configured so it cannot fetch one
 * itself (`NO_NETWORK_LANG_PATH`). So no worker has any reason to reach
 * another origin, and a stricter policy than the CSP is allowed
 * (`cspFindings` only forbids a looser one). `remoteAllowlist` exists for
 * tests and for a future worker that genuinely needs a pinned source, which
 * would then have to be one of `OCR_MODEL_CONNECT_SOURCES`.
 */

/** Remote URL prefixes a worker may request: none. */
export const WORKER_REMOTE_ALLOWLIST: readonly string[] = [];

/** True when a worker running at `base` may request `target`. */
export function isWorkerRequestAllowed(
  target: string | URL,
  base: string,
  remoteAllowlist: readonly string[] = WORKER_REMOTE_ALLOWLIST
): boolean {
  let url: URL;
  let own: URL;
  try {
    own = new URL(base);
    url = new URL(String(target), own);
  } catch {
    // Unparseable: whatever it is, it is not provably allowed.
    return false;
  }
  if (url.protocol === 'blob:' || url.protocol === 'data:') return true;
  // Same origin, compared by scheme and host:port because an extension
  // origin (`chrome-extension://…`) may serialize as `'null'` in some engines.
  if (url.protocol === own.protocol && url.host === own.host && url.host !== '') return true;
  if (url.protocol !== 'https:') return false;
  // A prefix of the *normalized* URL, so `..` segments cannot climb out of a
  // pinned directory (`new URL` has already resolved them).
  return remoteAllowlist.some(prefix => url.href.startsWith(prefix));
}
