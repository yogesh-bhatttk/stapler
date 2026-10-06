/**
 * GAP-12 — what Stapler keeps on this device, and clearing it.
 *
 * The trust panel says "nothing is uploaded"; this is the other half of that
 * claim — an honest list of what *is* kept locally, and one way to delete all
 * of it. Every place the app writes lives here:
 *
 *  • OPFS — open/recoverable documents (`<uuid>.pdf`) and uploaded OCR models
 *    (`<lang>.traineddata.gz`), plus probe scratch files (`opfs.ts`).
 *  • IndexedDB `stapler` — signatures, Recents file handles, presets, saved
 *    recipes, the folder-search index, and settings (theme, shortcuts, welcome
 *    flag, the session-recovery record, OCR consent flags, the persistence
 *    outcome) (`db.ts`).
 *  • IndexedDB `keyval-store` — tesseract's own language-model cache
 *    (`ocr/tesseractCache.ts`).
 *  • IndexedDB `stapler-meta` — the version "What's new" was last shown for
 *    (`background/whats-new-store.ts`). Deleted whole by Clear-all (RT-8): it
 *    only stops the same version's page opening twice, and "What's new" is
 *    only ever shown on an extension *update*, so the cost of wiping it is at
 *    most that page appearing once on the next update — which it would anyway.
 *  • Cache Storage `stapler-share-inbox` — files shared to the installed web
 *    app, held until the page picks them up (`platform/pwa/share-inbox.ts`).
 *    Deleted by Clear-all (PLT-5).
 *  • localStorage — the language, a mirror of the custom shortcuts, and the
 *    batch tool's filename pattern and scrub toggle.
 *
 * Only Stapler's own entries are touched: the web twin's origin can be shared
 * (a GitHub Pages user site), so nothing is wiped by origin.
 *
 * The in-session "disclosed downloads" count is not storage — it counts
 * requests this page made — and resets with the reload that follows a clear.
 */
import {
  clearStaplerStores,
  DB_OPEN_TIMEOUT_MS,
  readStaplerDbStats,
  STAPLER_STORES,
  type StaplerDbStats
} from './db';
import { SHARE_INBOX_CACHE } from '../platform/pwa/share-inbox';
import { clearStaplerFiles, listStoredFiles } from './opfs';
import { clearCachedModels, listCachedModels } from './ocr/tesseractCache';
import {
  isStoragePersisted,
  readStorageEstimate,
  type StorageEstimate
} from './storage-persistence';
import { logEvent } from './errors';

/** localStorage keys Stapler writes that do not carry a `stapler` prefix. */
const UNPREFIXED_LOCAL_KEYS = ['custom_shortcuts'];

function isStaplerLocalKey(key: string): boolean {
  return (
    key.startsWith('stapler.') || key.startsWith('stapler:') || UNPREFIXED_LOCAL_KEYS.includes(key)
  );
}

function localStorageLike(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Stapler's own localStorage keys that are currently set. */
export function staplerLocalStorageKeys(): string[] {
  const storage = localStorageLike();
  if (!storage) return [];
  const keys: string[] = [];
  try {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key !== null && isStaplerLocalKey(key)) keys.push(key);
    }
  } catch {
    // Hardened contexts can throw on access; nothing listable.
  }
  return keys;
}

export interface LocalDataReport {
  /** Whole-origin figures from the browser, or null when it will not say. */
  estimate: StorageEstimate | null;
  /** `persisted()`: true, false, or null when unsupported. */
  persisted: boolean | null;
  documents: { files: number; bytes: number };
  ocrModels: { langs: string[]; bytes: number };
  /** Everything from the `stapler` database, or null when it could not be read. */
  db: StaplerDbStats | null;
  localStorageKeys: number;
  otherFiles: { files: number; bytes: number };
}

/**
 * Gathers the "Stored on this device" breakdown. Never throws; each part that
 * cannot be read reports empty or null rather than failing the whole report.
 */
export async function gatherLocalDataReport(): Promise<LocalDataReport> {
  const [estimate, persisted, files, cached, db] = await Promise.all([
    readStorageEstimate(),
    isStoragePersisted(),
    listStoredFiles(),
    listCachedModels(),
    readStaplerDbStats().catch(() => null)
  ]);
  const docs = files.filter(f => f.kind === 'document');
  const uploaded = files.filter(f => f.kind === 'ocr-model');
  const other = files.filter(f => f.kind === 'scratch');
  const langs = new Set<string>(cached.map(m => m.lang));
  for (const f of uploaded) {
    langs.add(f.name.replace(/^model_/, '').replace(/\.traineddata(\.gz)?$/, ''));
  }
  const sum = (list: { bytes: number }[]) => list.reduce((total, f) => total + f.bytes, 0);
  return {
    estimate,
    persisted,
    documents: { files: docs.length, bytes: sum(docs) },
    ocrModels: { langs: [...langs].sort(), bytes: sum(uploaded) + sum(cached) },
    db,
    localStorageKeys: staplerLocalStorageKeys().length,
    otherFiles: { files: other.length, bytes: sum(other) }
  };
}

/** True when the report found nothing Stapler stored (a fresh profile). */
export function isReportEmpty(report: LocalDataReport): boolean {
  const db = report.db;
  return (
    report.documents.files === 0 &&
    report.ocrModels.langs.length === 0 &&
    report.otherFiles.files === 0 &&
    report.localStorageKeys === 0 &&
    db !== null &&
    db.signatures.count + db.recents + db.presets + db.recipes + db.indexedFiles + db.settings === 0
  );
}

export interface ClearResult {
  files: number;
  /**
   * AUDIT-2026-10-01 RT-3 — Stapler files still in OPFS after the clear
   * (locked elsewhere, or the directory could not be listed).
   */
  filesFailed: number;
  ocrCacheEntries: number;
  /** False when tesseract's model cache could not be cleared. */
  ocrCacheCleared: boolean;
  localStorageKeys: number;
  /** False when IndexedDB refused the clear (unavailable, timed out). */
  databaseCleared: boolean;
  /** RT-8 — false when the `stapler-meta` database could not be deleted. */
  metaCleared: boolean;
  /** PLT-5 — false when the share-inbox cache could not be deleted. */
  shareInboxCleared: boolean;
}

/** True when some part of {@link clearAllLocalData} left data behind. */
export function isPartialClear(result: ClearResult): boolean {
  return (
    result.filesFailed > 0 ||
    !result.databaseCleared ||
    !result.ocrCacheCleared ||
    !result.metaCleared ||
    !result.shareInboxCleared
  );
}

/**
 * `background/whats-new-store.ts`'s database. Named here rather than imported:
 * that module is the service worker's, and nothing else in it belongs in the
 * page bundle.
 */
export const META_DB_NAME = 'stapler-meta';

/**
 * RT-8 — deletes the `stapler-meta` database. `deleteDatabase` waits for every
 * open connection to close (the service worker holds one only for the
 * duration of a read or write), so it is bounded like every other open here.
 * Resolves true when the database is gone (or IndexedDB does not exist).
 */
export function deleteMetaDatabase(timeoutMs = DB_OPEN_TIMEOUT_MS): Promise<boolean> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(true);
  return new Promise(resolve => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      const request = indexedDB.deleteDatabase(META_DB_NAME);
      request.onsuccess = () => finish(true);
      request.onerror = () => finish(false);
      // Blocked: a connection is still open. The delete goes through as soon
      // as it closes, so keep waiting — up to the timeout.
      request.onblocked = () => {};
    } catch {
      finish(false);
    }
  });
}

/**
 * PLT-5 — deletes the share-inbox cache. `caches` exists on extension pages
 * and in every browser the web twin supports, but is guarded anyway (an
 * insecure-context web page has none). Resolves true when nothing is left.
 */
export async function deleteShareInbox(): Promise<boolean> {
  const storage = (globalThis as { caches?: CacheStorage }).caches;
  if (!storage) return true;
  try {
    await storage.delete(SHARE_INBOX_CACHE);
    return true;
  } catch (err) {
    logEvent('warn', 'local-data', `share-inbox clear failed: ${String(err)}`);
    return false;
  }
}

/**
 * Deletes everything Stapler stored. The caller is responsible for the
 * workspace (autosave must be suspended first, and the page reloaded after, so
 * no in-memory state writes anything back). Never throws; whatever could not
 * be deleted is reported in the result ({@link isPartialClear}).
 */
export async function clearAllLocalData(): Promise<ClearResult> {
  const databaseCleared = await clearStaplerStores(STAPLER_STORES).catch(() => false);
  const { removed: files, failed: filesFailed } = await clearStaplerFiles();
  let ocrCacheEntries = 0;
  let ocrCacheCleared = true;
  try {
    ocrCacheEntries = await clearCachedModels();
  } catch (err) {
    ocrCacheCleared = false;
    logEvent('warn', 'local-data', `tesseract cache clear failed: ${String(err)}`);
  }
  const metaCleared = await deleteMetaDatabase();
  const shareInboxCleared = await deleteShareInbox();
  let localStorageKeys = 0;
  const storage = localStorageLike();
  for (const key of staplerLocalStorageKeys()) {
    try {
      storage?.removeItem(key);
      localStorageKeys += 1;
    } catch {
      // Left behind; harmless conveniences (language, batch pattern).
    }
  }
  logEvent(
    'info',
    'local-data',
    `Cleared local data: ${files} files (${filesFailed} left), ${ocrCacheEntries} cached models, ${localStorageKeys} keys`
  );
  return {
    files,
    filesFailed,
    ocrCacheEntries,
    ocrCacheCleared,
    localStorageKeys,
    databaseCleared,
    metaCleared,
    shareInboxCleared
  };
}
