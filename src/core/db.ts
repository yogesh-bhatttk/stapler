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
const DB_VERSION = 2;

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
}

let dbPromise: Promise<IDBPDatabase<StaplerSchema>> | null = null;
const memorySearchIndexStore = new Map<string, SearchIndexRecord>();

function open(): Promise<IDBPDatabase<StaplerSchema>> {
  if (typeof globalThis.indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB unavailable in this environment'));
  }
  if (!dbPromise) {
    dbPromise = openDB<StaplerSchema>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        // Each version's migration is additive and independent, so a user on any
        // past version lands on the same schema.
        if (oldVersion < 1) {
          const handles = db.createObjectStore('handles', { keyPath: 'id' });
          handles.createIndex('by-openedAt', 'openedAt');
          const signatures = db.createObjectStore('signatures', { keyPath: 'id' });
          signatures.createIndex('by-createdAt', 'createdAt');
          db.createObjectStore('presets', { keyPath: 'id' });
          db.createObjectStore('settings');
        }
        if (oldVersion < 2) {
          if (!db.objectStoreNames.contains('searchIndex')) {
            const searchIndex = db.createObjectStore('searchIndex', { keyPath: 'id' });
            searchIndex.createIndex('by-token', 'token');
            searchIndex.createIndex('by-type', 'type');
            searchIndex.createIndex('by-fileId', 'fileId');
          }
        }
      },
      blocked() {
        logEvent('warn', 'db', 'Upgrade blocked by another tab');
      },
      terminated() {
        // The connection can be killed by the browser; drop the cached promise so
        // the next call reopens instead of using a dead handle forever.
        logEvent('warn', 'db', 'Connection terminated; will reopen on next use');
        dbPromise = null;
      }
    }).catch(err => {
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

function isQuotaError(err: unknown): boolean {
  return err instanceof DOMException && (err.name === 'QuotaExceededError' || err.code === 22);
}

/**
 * Runs a database operation, converting quota exhaustion into a message and a
 * `false` return rather than a crash (F-06 acceptance criterion).
 */
async function guard<T>(scope: string, fn: (db: IDBPDatabase<StaplerSchema>) => Promise<T>) {
  try {
    return { ok: true as const, value: await fn(await open()) };
  } catch (err) {
    if (isQuotaError(err)) {
      logEvent('error', scope, 'Storage quota exceeded');
      notify('warning', 'Local storage is full.', {
        detail:
          'Stapler could not save to browser storage. Your document is unaffected — delete ' +
          'saved signatures or clear site data to free space.'
      });
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

export async function readSetting<T>(key: string): Promise<T | undefined> {
  return (await guard('db.readSetting', db => db.get('settings', key))).value as T | undefined;
}

export async function writeSetting(key: string, value: unknown) {
  await guard('db.writeSetting', db => db.put('settings', value, key));
}

/* ---------------- searchIndex ---------------- */

export async function putSearchIndexRecordsBatch(records: SearchIndexRecord[]): Promise<boolean> {
  if (typeof globalThis.indexedDB === 'undefined') {
    for (const rec of records) {
      memorySearchIndexStore.set(rec.id, rec);
    }
    return true;
  }
  const result = await guard('db.putSearchIndexRecordsBatch', async db => {
    const tx = db.transaction('searchIndex', 'readwrite');
    for (const rec of records) {
      await tx.store.put(rec);
    }
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
    for (const rec of records) {
      await tx.store.delete(rec.id);
    }
    await tx.done;
  });
  return result.ok;
}
