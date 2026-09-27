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
 *  • localStorage — the language, a mirror of the custom shortcuts, and the
 *    batch tool's filename pattern and scrub toggle.
 *
 * Only Stapler's own entries are touched: the web twin's origin can be shared
 * (a GitHub Pages user site), so nothing is wiped by origin.
 *
 * The in-session "disclosed downloads" count is not storage — it counts
 * requests this page made — and resets with the reload that follows a clear.
 */
import { clearStaplerStores, readStaplerDbStats, STAPLER_STORES, type StaplerDbStats } from './db';
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
  ocrCacheEntries: number;
  localStorageKeys: number;
  /** False when IndexedDB refused the clear (unavailable, timed out). */
  databaseCleared: boolean;
}

/**
 * Deletes everything Stapler stored. The caller is responsible for the
 * workspace (autosave must be suspended first, and the page reloaded after, so
 * no in-memory state writes anything back). Never throws.
 */
export async function clearAllLocalData(): Promise<ClearResult> {
  const databaseCleared = await clearStaplerStores(STAPLER_STORES).catch(() => false);
  const files = await clearStaplerFiles();
  let ocrCacheEntries = 0;
  try {
    ocrCacheEntries = await clearCachedModels();
  } catch (err) {
    logEvent('warn', 'local-data', `tesseract cache clear failed: ${String(err)}`);
  }
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
    `Cleared local data: ${files} files, ${ocrCacheEntries} cached models, ${localStorageKeys} keys`
  );
  return { files, ocrCacheEntries, localStorageKeys, databaseCleared };
}
