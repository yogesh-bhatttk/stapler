/**
 * OCR-01 — the *only* place in this feature that touches the network.
 *
 * `model.ts` resolves URLs and holds the pinned hashes and sizes, and cannot
 * fetch; the OCR worker recognises pages and
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
import { recordDisclosedDownload } from '../disclosedDownloads';
import { MODEL_BYTES, expectedModelHash, maxModelDownloadBytes, resolveModelUrl } from './model';

export interface ModelDownloadOptions {
  signal?: AbortSignal;
  /** Bytes received so far and the expected total, as the body streams in. */
  onProgress?: (received: number, total: number) => void;
}

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
export async function fetchVerifiedModel(
  lang: string,
  options: ModelDownloadOptions = {}
): Promise<Uint8Array> {
  const { signal } = options;
  const url = resolveModelUrl(lang);
  const maxBytes = maxModelDownloadBytes(lang);

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

  const bytes = await readCapped(response, lang, maxBytes, options);

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

  recordDisclosedDownload();
  return bytes;
}

function tooLarge(lang: string, size: number, maxBytes: number) {
  return internal(
    `The "${lang}" OCR language model download was refused: the server sent ${size} bytes or ` +
      `more, but the pinned file is about ${Math.round(maxBytes / 2)} bytes. Nothing was saved.`,
    { lang, size, maxBytes }
  );
}

/**
 * Audit 2026-09-25 CNV-16 — streams the body instead of `arrayBuffer()`, so
 * the progress bar moves during a slow download and a response past
 * `maxBytes` (twice the pinned file's size) is cut off as soon as it crosses
 * the line rather than buffered in full first. A declared `Content-Length`
 * over the cap is refused before a single body byte is read.
 */
async function readCapped(
  response: Response,
  lang: string,
  maxBytes: number,
  options: ModelDownloadOptions
): Promise<Uint8Array> {
  const declared = Number(response.headers?.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge(lang, declared, maxBytes);
  const total = Number.isFinite(declared) && declared > 0 ? declared : (MODEL_BYTES[lang] ?? 0);

  const reader = response.body?.getReader();
  if (!reader) {
    // No streaming body (some test doubles, very old engines): fall back to a
    // whole-body read, still size-checked before it is used.
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw tooLarge(lang, bytes.byteLength, maxBytes);
    options.onProgress?.(bytes.byteLength, total || bytes.byteLength);
    return bytes;
  }

  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (options.signal?.aborted) throw cancelled();
      received += value.byteLength;
      if (received > maxBytes) throw tooLarge(lang, received, maxBytes);
      chunks.push(value);
      options.onProgress?.(received, Math.max(total, received));
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    if (options.signal?.aborted) throw cancelled();
    throw err;
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
