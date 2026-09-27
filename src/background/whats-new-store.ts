/**
 * GAP-7 — remembers which version "What's new" was last opened for.
 *
 * `chrome.storage` would need the `storage` permission, and Stapler ships with
 * none (CLAUDE.md invariant 2), so this is plain IndexedDB, which the service
 * worker (and Firefox's event page) share with the extension's own pages.
 *
 * Its own tiny database rather than the app's `stapler` one: opening that from
 * here without its schema version would create it at version 1 with no
 * stores, and the editor's later upgrade would then skip creating them.
 *
 * Every failure resolves quietly — at worst the page opens once more, which is
 * better than a service worker that throws during `onInstalled`.
 */
const DB_NAME = 'stapler-meta';
const STORE = 'kv';
const KEY = 'whatsNewShownVersion';

function open(): Promise<IDBDatabase | null> {
  return new Promise(resolve => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    try {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) {
          request.result.createObjectStore(STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function readShownVersion(): Promise<string | undefined> {
  const db = await open();
  if (!db) return undefined;
  return new Promise(resolve => {
    try {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
      request.onsuccess = () => {
        db.close();
        resolve(typeof request.result === 'string' ? request.result : undefined);
      };
      request.onerror = () => {
        db.close();
        resolve(undefined);
      };
    } catch {
      db.close();
      resolve(undefined);
    }
  });
}

export async function writeShownVersion(version: string): Promise<void> {
  const db = await open();
  if (!db) return;
  await new Promise<void>(resolve => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(version, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
  db.close();
}
