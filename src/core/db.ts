import { translate } from './i18n';
/**
 * F-06 — the IndexedDB layer.
 *
 * Stores file handles, signatures, presets, and settings, with a versioned schema
 * and migration hooks. Quota exhaustion is handled rather than thrown at the user
 * as a raw DOMException.
 *
 * The `documents` store the previous version added is gone: it held whole document
 * byte arrays and was written on every page reorder. Documents are session state,
 * not saved state — the plan persists *handles* so Recents can reopen the real file.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { logEvent } from './errors';
import { notify } from './notify';
import type { FsaFileHandle } from '../platform/fsa';

const DB_NAME = 'stapler';
const DB_VERSION = 3;

export interface IndexOccurrence {
  fileId: string;
  fileName: string;
  pageIndex: number;
  textSnippet: string;
}

export interface SearchIndexRecord {
  id: string;
  type: 'token' | 'doc' | 'meta';
  token?: string;
  occurrences?: IndexOccurrence[];
  fileId?: string;
  fileName?: string;
  lastModified?: number;
  size?: number;
  handle?: FsaFileHandle;
  indexedAt?: number;
}

/**
 * A batch recipe as it sits in the `recipes` store. `id` and `name` are what
 * this build writes; `tools` and `settings` are typed `unknown` because the
 * record may have been written by an older build or imported from a JSON file,
 * so storage cannot vouch for their shape. `settings` holds one snapshot per
 * tool (`compress`, `watermark`, …) in that tool's settings type; the batch
 * runner checks it with `ui/tools/batch/recipe-settings.ts` before use
 * (AUDIT-2026-10-01 X-15). The stored shape is unchanged from earlier builds.
 */
export interface Recipe {
  id: string;
  name: string;
  tools: unknown;
  settings: unknown;
}

interface StaplerSchema extends DBSchema {
  handles: {
    key: string;
    value: { id: string; name: string; handle: FsaFileHandle; openedAt: number };
    indexes: { 'by-openedAt': number };
  };
  signatures: {
    key: string;
    value: {
      id: string;
      kind: 'draw' | 'type' | 'image';
      /** PNG with real alpha (SGN-01). */
      png: Uint8Array;
      width: number;
      height: number;
      purpose?: 'signature' | 'initials';
      createdAt: number;
    };
    indexes: { 'by-createdAt': number };
  };
  presets: {
    key: string;
    value: { id: string; name: string; toolId: string; settings: unknown; createdAt: number };
  };
  settings: {
    key: string;
    value: unknown;
  };
  searchIndex: {
    key: string;
    value: SearchIndexRecord;
    indexes: {
      'by-token': string;
      'by-type': string;
      'by-fileId': string;
    };
  };
  recipes: {
    key: string;
    value: Recipe;
  };
}

let dbPromise: Promise<IDBPDatabase<StaplerSchema>> | null = null;
const memorySearchIndexStore = new Map<string, SearchIndexRecord>();
// This is the fallback used only when IndexedDB itself is unavailable — but
// folder search (`ocr/folder-index.ts`) can still index a large folder, and
// nothing evicted from this Map before, so it grew for the rest of the tab's
// life with no bound. A `Map` iterates in insertion order, so the oldest
// entry is always first; capped like `BitmapCache` (`render-cache.ts`) rather
// than refusing new records outright, since losing the oldest indexed file
// first is a better failure mode than folder search just stopping partway.
const MAX_MEMORY_SEARCH_INDEX_RECORDS = 20_000;

function setMemorySearchIndexRecord(rec: SearchIndexRecord): void {
  if (
    !memorySearchIndexStore.has(rec.id) &&
    memorySearchIndexStore.size >= MAX_MEMORY_SEARCH_INDEX_RECORDS
  ) {
    const oldest = memorySearchIndexStore.keys().next().value;
    if (oldest !== undefined) memorySearchIndexStore.delete(oldest);
  }
  memorySearchIndexStore.set(rec.id, rec);
}

/**
 * RT-11 — how long a call waits for the connection before giving up and
 * taking the same degraded path as any other storage failure. An upgrade
 * blocked by an older tab that never closes its connection used to leave
 * `openDB` pending forever, and with it every storage call: the recovery
 * check (so autosave never armed), shortcuts, signatures, recents, presets.
 */
export const DB_OPEN_TIMEOUT_MS = 4000;

function open(): Promise<IDBPDatabase<StaplerSchema>> {
  if (typeof globalThis.indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB unavailable in this environment'));
  }
  if (!dbPromise) {
    const opening: Promise<IDBPDatabase<StaplerSchema>> = openDB<StaplerSchema>(
      DB_NAME,
      DB_VERSION,
      {
        upgrade(db, oldVersion) {
          // Each version's migration is additive and independent, so a user on any
          // past version lands on the same schema.
          if (oldVersion < 1) {
            if (!db.objectStoreNames.contains('handles')) {
              const handles = db.createObjectStore('handles', { keyPath: 'id' });
              handles.createIndex('by-openedAt', 'openedAt');
            }
            if (!db.objectStoreNames.contains('signatures')) {
              const signatures = db.createObjectStore('signatures', { keyPath: 'id' });
              signatures.createIndex('by-createdAt', 'createdAt');
            }
            if (!db.objectStoreNames.contains('presets')) {
              db.createObjectStore('presets', { keyPath: 'id' });
            }
            if (!db.objectStoreNames.contains('settings')) {
              db.createObjectStore('settings');
            }
          }
          if (oldVersion < 2) {
            if (!db.objectStoreNames.contains('searchIndex')) {
              const searchIndex = db.createObjectStore('searchIndex', { keyPath: 'id' });
              searchIndex.createIndex('by-token', 'token');
              searchIndex.createIndex('by-type', 'type');
              searchIndex.createIndex('by-fileId', 'fileId');
            }
          }
          if (oldVersion < 3) {
            if (!db.objectStoreNames.contains('recipes')) {
              db.createObjectStore('recipes', { keyPath: 'id' });
            }
          }
        },
        blocked() {
          logEvent('warn', 'db', 'Upgrade blocked by another tab');
        },
        blocking() {
          // RT-11 — a newer tab wants to upgrade the schema, and this tab's open
          // connection is what blocks it. Close it (and forget it, so the next
          // call here reopens — at which point this older tab will itself be
          // the one refused, which is the correct outcome) instead of making
          // the new tab wait until this one is closed.
          logEvent('warn', 'db', 'Closing connection so another tab can upgrade');
          void opening.then(db => db.close()).catch(() => {});
          if (dbPromise === opening) dbPromise = null;
        },
        terminated() {
          // The connection can be killed by the browser; drop the cached promise so
          // the next call reopens instead of using a dead handle forever.
          logEvent('warn', 'db', 'Connection terminated; will reopen on next use');
          if (dbPromise === opening) dbPromise = null;
        }
      }
    ).catch(err => {
      if (dbPromise === opening) dbPromise = null;
      throw err;
    });
    dbPromise = opening;
  }
  return dbPromise;
}

/**
 * {@link open}, bounded by {@link DB_OPEN_TIMEOUT_MS}. The pending open itself
 * is kept (not restarted per call), so once whatever blocked it goes away,
 * later calls get the real connection.
 */
function openBounded(): Promise<IDBPDatabase<StaplerSchema>> {
  const opening = open();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('Timed out opening IndexedDB (upgrade blocked by another tab?)')),
      DB_OPEN_TIMEOUT_MS
    );
  });
  return Promise.race([opening, timeout]).finally(() => clearTimeout(timer));
}

function isQuotaError(err: unknown): boolean {
  return err instanceof DOMException && (err.name === 'QuotaExceededError' || err.code === 22);
}

/**
 * Runs a database operation, converting quota exhaustion into a message and a
 * `false` return rather than a crash (F-06 acceptance criterion).
 */
/**
 * RT-21 — the quota toast is shown at most once per this window. Session
 * autosave writes on every edit (debounced 500ms), so with storage full each
 * edit stacked another identical warning.
 */
export const QUOTA_TOAST_INTERVAL_MS = 60_000;
let lastQuotaToastAt = -Infinity;

/** Test hook: forget when the quota toast was last shown. */
export function __resetQuotaToastForTests(): void {
  lastQuotaToastAt = -Infinity;
}

async function guard<T>(scope: string, fn: (db: IDBPDatabase<StaplerSchema>) => Promise<T>) {
  try {
    return { ok: true as const, value: await fn(await openBounded()) };
  } catch (err) {
    if (isQuotaError(err)) {
      logEvent('error', scope, 'Storage quota exceeded');
      const now = Date.now();
      if (now - lastQuotaToastAt >= QUOTA_TOAST_INTERVAL_MS) {
        lastQuotaToastAt = now;
        notify('warning', translate('Local storage is full.'), {
          detail: translate(
            'Stapler could not save to browser storage. Your document is unaffected. Open the privacy panel from the top bar to see what is stored and free space.'
          )
        });
      }
      return { ok: false as const, value: undefined };
    }
    logEvent('error', scope, err instanceof Error ? err.message : String(err));
    return { ok: false as const, value: undefined };
  }
}

/* ---------------- handles (Recents) ---------------- */

export async function writeHandle(id: string, name: string, handle: FsaFileHandle) {
  await guard('db.writeHandle', db =>
    db.put('handles', { id, name, handle, openedAt: Date.now() })
  );
}

export async function readHandle(id: string): Promise<FsaFileHandle | null> {
  const result = await guard('db.readHandle', db => db.get('handles', id));
  return result.value?.handle ?? null;
}

export async function listHandles() {
  const result = await guard('db.listHandles', db => db.getAllFromIndex('handles', 'by-openedAt'));
  return (result.value ?? []).map(({ id, name, openedAt }) => ({ id, name, openedAt })).reverse();
}

export async function deleteHandle(id: string) {
  await guard('db.deleteHandle', db => db.delete('handles', id));
}

/* ---------------- signatures ---------------- */

export type StoredSignature = StaplerSchema['signatures']['value'];

export async function putSignature(signature: StoredSignature): Promise<boolean> {
  return (await guard('db.putSignature', db => db.put('signatures', signature))).ok;
}

export async function getStoredSignature(id: string): Promise<StoredSignature | null> {
  return (await guard('db.getSignature', db => db.get('signatures', id))).value ?? null;
}

export async function listSignatures(): Promise<StoredSignature[]> {
  const result = await guard('db.listSignatures', db =>
    db.getAllFromIndex('signatures', 'by-createdAt')
  );
  return (result.value ?? []).reverse();
}

export async function deleteStoredSignature(id: string) {
  await guard('db.deleteSignature', db => db.delete('signatures', id));
}

/* ---------------- settings ---------------- */

/**
 * A setting read that says whether storage answered at all. `readSetting`
 * folds "storage unavailable or timed out" into `undefined`, which a caller
 * that must not act on a missing record — session recovery — cannot tell
 * apart from "no such record" (regression review R-RT-4).
 */
export async function readSettingResult<T>(
  key: string
): Promise<{ ok: boolean; value: T | undefined }> {
  const result = await guard('db.readSetting', db => db.get('settings', key));
  return { ok: result.ok, value: result.value as T | undefined };
}

export async function readSetting<T>(key: string): Promise<T | undefined> {
  return (await guard('db.readSetting', db => db.get('settings', key))).value as T | undefined;
}

/** Resolves `false` when storage refused the write (quota, unavailable), `true` otherwise. */
export async function writeSetting(key: string, value: unknown): Promise<boolean> {
  return (await guard('db.writeSetting', db => db.put('settings', value, key))).ok;
}

/* ---------------- searchIndex ---------------- */

export async function putSearchIndexRecordsBatch(records: SearchIndexRecord[]): Promise<boolean> {
  if (typeof globalThis.indexedDB === 'undefined') {
    for (const rec of records) {
      setMemorySearchIndexRecord(rec);
    }
    return true;
  }
  const result = await guard('db.putSearchIndexRecordsBatch', async db => {
    const tx = db.transaction('searchIndex', 'readwrite');
    await Promise.all(records.map(rec => tx.store.put(rec)));
    await tx.done;
  });
  return result.ok;
}

export async function getSearchIndexRecord(id: string): Promise<SearchIndexRecord | null> {
  if (typeof globalThis.indexedDB === 'undefined') {
    return memorySearchIndexStore.get(id) ?? null;
  }
  const result = await guard('db.getSearchIndexRecord', db => db.get('searchIndex', id));
  return result.value ?? null;
}

export async function getSearchIndexRecordsByToken(token: string): Promise<SearchIndexRecord[]> {
  if (typeof globalThis.indexedDB === 'undefined') {
    const out: SearchIndexRecord[] = [];
    for (const rec of memorySearchIndexStore.values()) {
      if (rec.type === 'token' && rec.token === token) {
        out.push(rec);
      }
    }
    return out;
  }
  const result = await guard('db.getSearchIndexRecordsByToken', db =>
    db.getAllFromIndex('searchIndex', 'by-token', token)
  );
  return result.value ?? [];
}

export async function getSearchIndexRecordsByType(
  type: 'token' | 'doc' | 'meta'
): Promise<SearchIndexRecord[]> {
  if (typeof globalThis.indexedDB === 'undefined') {
    const out: SearchIndexRecord[] = [];
    for (const rec of memorySearchIndexStore.values()) {
      if (rec.type === type) {
        out.push(rec);
      }
    }
    return out;
  }
  const result = await guard('db.getSearchIndexRecordsByType', db =>
    db.getAllFromIndex('searchIndex', 'by-type', type)
  );
  return result.value ?? [];
}

export async function clearSearchIndexStore(): Promise<boolean> {
  if (typeof globalThis.indexedDB === 'undefined') {
    memorySearchIndexStore.clear();
    return true;
  }
  const result = await guard('db.clearSearchIndexStore', db => db.clear('searchIndex'));
  return result.ok;
}

export async function deleteSearchIndexRecordsByFileId(fileId: string): Promise<boolean> {
  if (typeof globalThis.indexedDB === 'undefined') {
    for (const [id, rec] of memorySearchIndexStore.entries()) {
      if (
        rec.fileId === fileId ||
        (rec.type === 'token' && rec.occurrences?.some(o => o.fileId === fileId))
      ) {
        if (rec.type === 'doc' && rec.fileId === fileId) {
          memorySearchIndexStore.delete(id);
        } else if (rec.type === 'token' && rec.occurrences) {
          const filtered = rec.occurrences.filter(o => o.fileId !== fileId);
          if (filtered.length === 0) {
            memorySearchIndexStore.delete(id);
          } else {
            memorySearchIndexStore.set(id, { ...rec, occurrences: filtered });
          }
        }
      }
    }
    return true;
  }
  const result = await guard('db.deleteSearchIndexRecordsByFileId', async db => {
    const records = await db.getAllFromIndex('searchIndex', 'by-fileId', fileId);
    const tx = db.transaction('searchIndex', 'readwrite');
    const deletePromises = records.map(rec => tx.store.delete(rec.id));
    // Instead of loading ALL token records, use a cursor to walk only
    // the 'token' type and update/delete only those referencing fileId.
    const index = tx.store.index('by-type');
    let cursor = await index.openCursor('token');
    const cursorOps: Promise<void>[] = [];
    while (cursor) {
      const rec = cursor.value;
      if (rec.occurrences?.some((o: { fileId: string }) => o.fileId === fileId)) {
        const filtered = rec.occurrences.filter((o: { fileId: string }) => o.fileId !== fileId);
        if (filtered.length === 0) {
          cursorOps.push(cursor.delete().then(() => {}));
        } else {
          cursorOps.push(cursor.update({ ...rec, occurrences: filtered }).then(() => {}));
        }
      }
      cursor = await cursor.continue();
    }
    await Promise.all([...deletePromises, ...cursorOps]);
    await tx.done;
  });
  return result.ok;
}

/* ---------------- recipes ---------------- */

export async function putRecipe(recipe: Recipe): Promise<boolean> {
  return (await guard('db.putRecipe', db => db.put('recipes', recipe))).ok;
}

export async function getRecipe(id: string): Promise<Recipe | null> {
  return (await guard('db.getRecipe', db => db.get('recipes', id))).value ?? null;
}

export async function listRecipes(): Promise<Recipe[]> {
  const result = await guard('db.listRecipes', db => db.getAll('recipes'));
  return result.value ?? [];
}

export async function deleteRecipe(id: string) {
  await guard('db.deleteRecipe', db => db.delete('recipes', id));
}

/* ---------------- GAP-12: what is stored, and clearing it ---------------- */

/** Every object store in the `stapler` database. */
export const STAPLER_STORES = [
  'handles',
  'signatures',
  'presets',
  'settings',
  'searchIndex',
  'recipes'
] as const;
export type StaplerStore = (typeof STAPLER_STORES)[number];

export interface StaplerDbStats {
  signatures: { count: number; bytes: number };
  recents: number;
  presets: number;
  recipes: number;
  /** Files the folder-search index covers (its `doc` records). */
  indexedFiles: number;
  settings: number;
}

/**
 * GAP-12 — counts for the trust panel's "Stored on this device" list. `null`
 * when IndexedDB could not be read at all (the panel then says so instead of
 * claiming nothing is stored).
 */
export async function readStaplerDbStats(): Promise<StaplerDbStats | null> {
  const result = await guard('db.stats', async db => {
    const signatures = await db.getAll('signatures');
    return {
      signatures: {
        count: signatures.length,
        bytes: signatures.reduce((sum, s) => sum + (s.png?.byteLength ?? 0), 0)
      },
      recents: await db.count('handles'),
      presets: await db.count('presets'),
      recipes: await db.count('recipes'),
      indexedFiles: await db.countFromIndex('searchIndex', 'by-type', 'doc'),
      settings: await db.count('settings')
    };
  });
  return result.ok ? result.value : null;
}

/**
 * GAP-12 — empties the named stores in one transaction. The database itself is
 * kept (deleting it would block on this tab's own open connection); an empty
 * store holds nothing. Returns whether the clear committed.
 */
export async function clearStaplerStores(stores: readonly StaplerStore[]): Promise<boolean> {
  if (stores.includes('searchIndex')) memorySearchIndexStore.clear();
  const result = await guard('db.clearStores', async db => {
    const tx = db.transaction([...stores], 'readwrite');
    await Promise.all(stores.map(name => tx.objectStore(name).clear()));
    await tx.done;
  });
  return result.ok;
}
