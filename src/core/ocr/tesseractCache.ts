/**
 * OCR-01 — a direct line to tesseract.js's own browser cache.
 *
 * tesseract.js's browser worker-script (`node_modules/tesseract.js/src/
 * worker-script/browser/cache.js`) caches `<lang>.traineddata` in a plain
 * `idb-keyval` store: one IndexedDB database (`keyval-store`), one object store
 * (`keyval`), keyed by the exact path `loadAndGunzipFile` builds —
 * `${cachePath || '.'}/${lang}.traineddata`. Stapler never sets `cachePath`, so
 * the key is always `./<lang>.traineddata`.
 *
 * This file talks to that store with the raw `indexedDB` API rather than
 * depending on the `idb-keyval` package — which is a transitive dependency of
 * tesseract.js, not one Stapler declares for itself — so two OCR-01 defects can
 * be fixed against the *real* cache tesseract reads from, not a proxy for it:
 *
 *  - "Already downloaded" must mean the bytes are actually still here, not just
 *    that a boolean setting was once set. `hasCachedModel` is that byte-presence
 *    probe: if the browser evicted this database under storage pressure, this
 *    returns `false` and `runOcr.ts` re-shows the consent dialog instead of
 *    silently trusting a stale flag (and, was a stale flag trusted, tesseract's
 *    own internal loader would then re-fetch with no dialog at all).
 *  - A manually uploaded model has to land in the exact place tesseract's own
 *    loader reads from, so the OCR worker can call `createWorker` with a plain
 *    language string — the only shape tesseract.js 7.0.0 initializes correctly
 *    (see `src/core/workers/ocr.worker.ts`). `writeCachedModel` is how both a
 *    verified download (`download.ts`) and a manual upload (`runOcr.ts`, from
 *    the bytes `OcrConsentDialog` already wrote to OPFS) land there.
 */

const DB_NAME = 'keyval-store';
const STORE_NAME = 'keyval';

function cacheKey(lang: string): string {
  return `./${lang}.traineddata`;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** True only when `lang`'s traineddata bytes are actually sitting in tesseract's own cache right now. */
export async function hasCachedModel(lang: string): Promise<boolean> {
  if (typeof indexedDB === 'undefined') return false;
  try {
    const db = await openDb();
    try {
      return await new Promise<boolean>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const request = tx.objectStore(STORE_NAME).get(cacheKey(lang));
        request.onsuccess = () => resolve(request.result !== undefined);
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  } catch {
    // Treated as "not cached" rather than propagated: a probe that can throw
    // is not a safe thing to gate a consent decision on, and "ask again" is
    // always the safe failure direction here — it never fetches on its own.
    return false;
  }
}

/**
 * Seeds tesseract's own cache directly, in the exact shape its loader reads
 * back (see the module doc above). After this resolves, tesseract's normal
 * cache-hit path uses these bytes with no network request of its own —
 * whether they came from a verified CDN download or a manual upload.
 */
export async function writeCachedModel(lang: string, bytes: Uint8Array): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(bytes, cacheKey(lang));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
