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
const DB_VERSION = 1;

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
}

let dbPromise: Promise<IDBPDatabase<StaplerSchema>> | null = null;

function open(): Promise<IDBPDatabase<StaplerSchema>> {
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
