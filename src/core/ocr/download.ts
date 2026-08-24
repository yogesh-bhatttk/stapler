/**
 * OCR-01 — the *only* place in this feature that touches the network.
 *
 * Mirrors `faceblur/download.ts` on purpose: `model.ts` resolves URLs and holds
 * the pinned hashes, and cannot fetch; the OCR worker recognises pages and
 * cannot fetch; `runOcr.ts` sequences consent and caching and cannot fetch;
 * this file fetches one pinned URL, verifies it, and does nothing else.
 * Auditing "what can OCR request?" means reading this file and `model.ts`.
 *
 * Before OCR-01's fix, tesseract.js's own internal loader did this fetch
 * itself — which meant Stapler's code never saw the downloaded bytes and could
 * not verify them. Every model download now comes through here instead: the
 * result is written into tesseract's own cache (`tesseractCache.ts`) *before*
 * tesseract is ever asked to initialize, so tesseract's internal loader always
 * finds a cache hit and never makes a request of its own.
 */
import { cancelled, internal } from '../errors';
import { expectedModelHash, resolveModelUrl } from './model';

/** Hex-encoded SHA-256, the same encoding `MODEL_SHA256` in `model.ts` uses. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Downloads `lang`'s traineddata from the pinned URL and verifies it against
 * the hardcoded hash before returning it. Throws rather than returning
 * unverified bytes: a subresource-integrity check that can be silently
 * skipped is not a check.
 */
export async function fetchVerifiedModel(lang: string, signal?: AbortSignal): Promise<Uint8Array> {
  const url = resolveModelUrl(lang);

  let response: Response;
  try {
    response = await fetch(url, { signal });
  } catch (err) {
    if (signal?.aborted) throw cancelled();
    throw internal(
      `The ${lang} OCR language model could not be downloaded: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      { lang, url }
    );
  }
  if (signal?.aborted) throw cancelled();
  if (!response.ok) {
    throw internal(
      `The ${lang} OCR language model could not be downloaded ` +
        `(${response.status} ${response.statusText}).`,
      { lang, url, status: response.status }
    );
  }

  const bytes = new Uint8Array(await response.arrayBuffer());

  const expected = expectedModelHash(lang);
  if (!expected) {
    // No pinned language ships without an entry in `MODEL_SHA256` — reaching
    // this means a language was added to the catalogue without pinning its
    // hash, which is a build-time mistake, not something to paper over by
    // trusting the bytes anyway.
    throw internal(
      `No pinned integrity hash is registered for the "${lang}" OCR language model; ` +
        `refusing to use an unverified download.`,
      { lang, url }
    );
  }

  const actual = await sha256Hex(bytes);
  if (actual !== expected) {
    throw internal(
      `The downloaded "${lang}" OCR language model failed integrity verification and was ` +
        `discarded (expected sha256:${expected}, got sha256:${actual}). The file may be ` +
        `corrupt or the CDN may be serving something other than what was pinned. Try again, ` +
        `or use "Upload offline model" with a copy you trust.`,
      { lang, url, expectedHash: expected, actualHash: actual }
    );
  }

  return bytes;
}
