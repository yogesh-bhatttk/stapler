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

import { DB_OPEN_TIMEOUT_MS } from '../db';

const DB_NAME = 'keyval-store';
const STORE_NAME = 'keyval';

function cacheKey(lang: string): string {
  return `./${lang}.traineddata`;
}

/**
 * AUDIT-2026-10-01 RT-5 — bounded like `db.ts`'s `openBounded`: an open
 * blocked by another tab's connection (or one the browser simply never
 * answers) rejects after `DB_OPEN_TIMEOUT_MS` instead of pending forever. Every
 * caller already treats a rejection as "storage unavailable"; Clear-all used to
 * hang on this open with autosave already suspended.
 */
function openDb(timeoutMs = DB_OPEN_TIMEOUT_MS): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new Error('Timed out opening the OCR model cache (blocked by another tab?)'));
    }, timeoutMs);
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME);
    } catch (err) {
      finish(() => reject(err));
      return;
    }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => {
      // A connection that arrives after the timeout gave up is closed, not
      // leaked — a leaked one would block the next upgrade in turn.
      if (settled) request.result.close();
      else finish(() => resolve(request.result));
    };
    request.onerror = () => finish(() => reject(request.error));
    // Another tab holds a connection the open has to wait for. The open may
    // still go through once it closes, so this waits — but only until the
    // timeout above.
    request.onblocked = () => {};
  });
}

/** Test hook: the bounded open, with a short timeout. */
export const __openDbForTests = openDb;

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

function isModelKey(key: IDBValidKey): key is string {
  return typeof key === 'string' && key.endsWith('.traineddata');
}

/**
 * GAP-12 — the language models in tesseract's cache and their sizes, for the
 * trust panel. Only `*.traineddata` keys are counted: `keyval-store` is
 * idb-keyval's default name, so on a shared web origin another page could own
 * other keys in it. Never throws.
 */
export async function listCachedModels(): Promise<{ lang: string; bytes: number }[]> {
  if (typeof indexedDB === 'undefined') return [];
  try {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const out: { lang: string; bytes: number }[] = [];
        const tx = db.transaction(STORE_NAME, 'readonly');
        const request = tx.objectStore(STORE_NAME).openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return resolve(out);
          if (isModelKey(cursor.key)) {
            const value = cursor.value as { byteLength?: number; length?: number } | undefined;
            out.push({
              lang: cursor.key.replace(/^.*\//, '').replace(/\.traineddata$/, ''),
              bytes: value?.byteLength ?? value?.length ?? 0
            });
          }
          cursor.continue();
        };
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

/**
 * GAP-12 — removes every language model from tesseract's cache (and nothing
 * else in that store). Returns how many were removed.
 */
export async function clearCachedModels(): Promise<number> {
  if (typeof indexedDB === 'undefined') return 0;
  const db = await openDb();
  try {
    return await new Promise<number>((resolve, reject) => {
      let removed = 0;
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const request = tx.objectStore(STORE_NAME).openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        if (isModelKey(cursor.key)) {
          cursor.delete();
          removed += 1;
        }
        cursor.continue();
      };
      tx.oncomplete = () => resolve(removed);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/**
 * Removes `lang`'s bytes from tesseract's cache. The OCR worker runs tesseract
 * with `cacheMethod: 'readOnly'` (audit 2026-09-25 CNV-2), so tesseract itself
 * never deletes a bad entry any more — this is the one place that does, when a
 * model fails its trial init or the user removes their downloaded models.
 */
export async function deleteCachedModel(lang: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(cacheKey(lang));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
