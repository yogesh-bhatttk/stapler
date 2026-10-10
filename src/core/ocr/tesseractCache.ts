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
 *
 * Audit 2026-10-10 S6b — that store is idb-keyval's *default* database, which
 * any same-origin script (on the web twin, any page of a shared origin) can
 * read and rewrite, and a presence check never noticed bytes that changed
 * after the download's hash check. So:
 *  - the canonical copy lives in Stapler's own database, {@link MODEL_DB_NAME},
 *    with the SHA-256 it was verified at;
 *  - before every use (`hasCachedModel`, which `runOcr` calls before each run)
 *    the stored bytes are **hashed again** — against the pinned
 *    `MODEL_SHA256` for a downloaded model, or the hash recorded at upload for
 *    an uploaded one (whose OPFS copy must still exist). A mismatch discards
 *    the copy, so the run asks for consent again instead of using it;
 *  - only then are those verified bytes written into tesseract's
 *    `keyval-store` — which tesseract.js's worker script hard-codes and Stapler
 *    cannot rename — overwriting whatever was there. That store is a staging
 *    copy now, re-seeded from verified bytes before every run.
 * A model cached before this change (only in `keyval-store`) is migrated the
 * first time it is checked — if, and only if, it hashes to the pinned value.
 */

import { DB_OPEN_TIMEOUT_MS } from '../db';
import { logEvent } from '../errors';
import { hasModelBytes } from '../opfs';
import { expectedModelHash } from './model';

/** tesseract.js's own cache: idb-keyval's default database (not Stapler's to rename). */
const TESSERACT_DB_NAME = 'keyval-store';
const TESSERACT_STORE_NAME = 'keyval';

/** S6b — Stapler's own record of each verified model. */
export const MODEL_DB_NAME = 'stapler-ocr-models';
const MODEL_STORE_NAME = 'models';

/** One verified model, as Stapler keeps it. */
export interface StoredModelRecord {
  bytes: Uint8Array;
  /** Hex SHA-256 the bytes were verified at when stored. */
  sha256: string;
  /** `pinned`: matches `MODEL_SHA256`. `upload`: a user's own file (its OPFS copy is the source). */
  source: 'pinned' | 'upload';
}

function cacheKey(lang: string): string {
  return `./${lang}.traineddata`;
}

/** Hex-encoded SHA-256, the encoding `MODEL_SHA256` uses. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * AUDIT-2026-10-01 RT-5 — bounded like `db.ts`'s `openBounded`: an open
 * blocked by another tab's connection (or one the browser simply never
 * answers) rejects after `DB_OPEN_TIMEOUT_MS` instead of pending forever. Every
 * caller already treats a rejection as "storage unavailable"; Clear-all used to
 * hang on this open with autosave already suspended.
 */
function openDb(
  name: string,
  storeName: string,
  timeoutMs = DB_OPEN_TIMEOUT_MS
): Promise<IDBDatabase> {
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
      request = indexedDB.open(name);
    } catch (err) {
      finish(() => reject(err));
      return;
    }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(storeName)) {
        request.result.createObjectStore(storeName);
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

/** Test hook: the bounded open of tesseract's cache, with a short timeout. */
export const __openDbForTests = (timeoutMs?: number) =>
  openDb(TESSERACT_DB_NAME, TESSERACT_STORE_NAME, timeoutMs);

/** One key-value store: just the operations this module needs. */
export interface ModelKeyValueStore {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  /** Every key with its value. */
  entries(): Promise<[IDBValidKey, unknown][]>;
  /** Deletes the keys `match` accepts; returns how many. */
  deleteWhere(match: (key: IDBValidKey) => boolean): Promise<number>;
}

function indexedDbStore(name: string, storeName: string): ModelKeyValueStore {
  const run = async <T>(
    mode: IDBTransactionMode,
    body: (store: IDBObjectStore, done: (value: T) => void, fail: (err: unknown) => void) => void
  ): Promise<T> => {
    const db = await openDb(name, storeName);
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        let result: T;
        body(
          tx.objectStore(storeName),
          value => {
            result = value;
            if (mode === 'readonly') resolve(value);
          },
          reject
        );
        if (mode === 'readwrite') {
          tx.oncomplete = () => resolve(result);
          tx.onerror = () => reject(tx.error);
        }
      });
    } finally {
      db.close();
    }
  };
  return {
    get: key =>
      run('readonly', (store, done, fail) => {
        const request = store.get(key);
        request.onsuccess = () => done(request.result);
        request.onerror = () => fail(request.error);
      }),
    put: (key, value) =>
      run<void>('readwrite', (store, done) => {
        store.put(value, key);
        done(undefined);
      }),
    delete: key =>
      run<void>('readwrite', (store, done) => {
        store.delete(key);
        done(undefined);
      }),
    entries: () =>
      run('readonly', (store, done, fail) => {
        const out: [IDBValidKey, unknown][] = [];
        const request = store.openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return done(out);
          out.push([cursor.key, cursor.value]);
          cursor.continue();
        };
        request.onerror = () => fail(request.error);
      }),
    deleteWhere: match =>
      run('readwrite', (store, done, fail) => {
        let removed = 0;
        const request = store.openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return done(removed);
          if (match(cursor.key)) {
            cursor.delete();
            removed += 1;
          }
          cursor.continue();
        };
        request.onerror = () => fail(request.error);
      })
  };
}

let stores: { tesseract: ModelKeyValueStore; models: ModelKeyValueStore } | null = null;

function cacheStores() {
  stores ??= {
    tesseract: indexedDbStore(TESSERACT_DB_NAME, TESSERACT_STORE_NAME),
    models: indexedDbStore(MODEL_DB_NAME, MODEL_STORE_NAME)
  };
  return stores;
}

/** Test seam: in-memory stores in place of IndexedDB (`null` restores it). */
export function __setModelStoresForTests(
  next: { tesseract: ModelKeyValueStore; models: ModelKeyValueStore } | null
): void {
  stores = next;
}

function isRecord(value: unknown): value is StoredModelRecord {
  const r = value as Partial<StoredModelRecord> | undefined;
  return (
    !!r &&
    r.bytes instanceof Uint8Array &&
    typeof r.sha256 === 'string' &&
    (r.source === 'pinned' || r.source === 'upload')
  );
}

/** Whether `bytes`, hashing to `actual`, may be used as `lang`'s model. */
async function trusted(lang: string, record: StoredModelRecord, actual: string): Promise<boolean> {
  if (actual === expectedModelHash(lang)) return true;
  // An uploaded model has no pinned hash: it must still hash to what was
  // recorded when it was stored, and its OPFS original must still be there.
  return record.source === 'upload' && actual === record.sha256 && (await hasModelBytes(lang));
}

function storageAvailable(): boolean {
  return stores !== null || typeof indexedDB !== 'undefined';
}

/**
 * True only when a **verified** copy of `lang`'s model is stored right now —
 * its bytes re-hashed, not a flag trusted — and it has just been written into
 * tesseract's own cache for the engine to load. False (never a throw) when
 * there is none, it no longer matches its hash (it is then discarded and the
 * caller asks for consent again), or storage cannot be read.
 */
export async function hasCachedModel(lang: string): Promise<boolean> {
  if (!storageAvailable()) return false;
  const { tesseract, models } = cacheStores();
  try {
    let record: StoredModelRecord | null = null;
    const stored = await models.get(lang);
    if (isRecord(stored)) {
      record = stored;
    } else {
      // Migration: a model cached before S6b exists only in tesseract's store.
      const legacy = await tesseract.get(cacheKey(lang));
      if (legacy instanceof Uint8Array) {
        const actual = await sha256Hex(legacy);
        if (actual === expectedModelHash(lang)) {
          record = { bytes: legacy, sha256: actual, source: 'pinned' };
          await models.put(lang, record);
        } else {
          // Unverifiable. An uploaded model is re-seeded from its OPFS copy
          // by `runOcr`'s `isModelReady`; anything else is asked for again.
          await tesseract.delete(cacheKey(lang));
          return false;
        }
      }
    }
    if (!record) return false;

    const actual = await sha256Hex(record.bytes);
    if (!(await trusted(lang, record, actual))) {
      logEvent('warn', 'ocr.cache', `stored ${lang} model failed its hash check; discarded`);
      await models.delete(lang);
      await tesseract.delete(cacheKey(lang));
      return false;
    }
    // The verified bytes, over whatever tesseract's store holds now.
    await tesseract.put(cacheKey(lang), record.bytes);
    return true;
  } catch {
    // Treated as "not cached" rather than propagated: a probe that can throw
    // is not a safe thing to gate a consent decision on, and "ask again" is
    // always the safe failure direction here — it never fetches on its own.
    return false;
  }
}

/**
 * Stores `lang`'s model: the canonical, hashed copy in Stapler's database, and
 * the bytes in tesseract's own cache, in the exact shape its loader reads back
 * (see the module doc above). Bytes matching the pinned hash are recorded as
 * `pinned`; anything else — a manual upload — as `upload`, verified from then
 * on against the hash taken here.
 */
export async function writeCachedModel(lang: string, bytes: Uint8Array): Promise<void> {
  const { tesseract, models } = cacheStores();
  const sha256 = await sha256Hex(bytes);
  const source = sha256 === expectedModelHash(lang) ? 'pinned' : 'upload';
  await models.put(lang, { bytes, sha256, source } satisfies StoredModelRecord);
  await tesseract.put(cacheKey(lang), bytes);
}

function isModelKey(key: IDBValidKey): key is string {
  return typeof key === 'string' && key.endsWith('.traineddata');
}

function byteLength(value: unknown): number {
  const v = value as { byteLength?: number; length?: number } | undefined;
  return v?.byteLength ?? v?.length ?? 0;
}

/**
 * GAP-12 — the language models stored, and their sizes, for the trust panel:
 * Stapler's verified copies, plus any not-yet-migrated copy in tesseract's
 * store. Only `*.traineddata` keys are counted there: `keyval-store` is
 * idb-keyval's default name, so on a shared web origin another page could own
 * other keys in it. Never throws.
 */
export async function listCachedModels(): Promise<{ lang: string; bytes: number }[]> {
  if (!storageAvailable()) return [];
  const { tesseract, models } = cacheStores();
  const out = new Map<string, number>();
  try {
    for (const [key, value] of await models.entries()) {
      if (typeof key === 'string' && isRecord(value)) out.set(key, value.bytes.byteLength);
    }
  } catch {
    // Unreadable: reported as empty, like the rest of this panel.
  }
  try {
    for (const [key, value] of await tesseract.entries()) {
      if (!isModelKey(key)) continue;
      const lang = key.replace(/^.*\//, '').replace(/\.traineddata$/, '');
      if (!out.has(lang)) out.set(lang, byteLength(value));
    }
  } catch {
    // As above.
  }
  return [...out].map(([lang, bytes]) => ({ lang, bytes }));
}

/**
 * GAP-12 — removes every language model: Stapler's verified copies and
 * tesseract's cache entries (and nothing else in tesseract's store). Returns
 * how many entries were removed. Throws when either store cannot be cleared.
 */
export async function clearCachedModels(): Promise<number> {
  if (!storageAvailable()) return 0;
  const { tesseract, models } = cacheStores();
  const ours = await models.deleteWhere(() => true);
  const theirs = await tesseract.deleteWhere(isModelKey);
  return ours + theirs;
}

/**
 * Removes `lang`'s model from both stores. The OCR worker runs tesseract with
 * `cacheMethod: 'readOnly'` (audit 2026-09-25 CNV-2), so tesseract itself
 * never deletes a bad entry any more — this is the one place that does, when a
 * model fails its trial init or the user removes their downloaded models.
 */
export async function deleteCachedModel(lang: string): Promise<void> {
  if (!storageAvailable()) return;
  const { tesseract, models } = cacheStores();
  await models.delete(lang);
  await tesseract.delete(cacheKey(lang));
}
