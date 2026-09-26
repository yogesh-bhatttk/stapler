/**
 * OPFS management for document byte storage.
 * Keeps memory overhead low by offloading the raw Uint8Arrays
 * of documents to the Origin Private File System (OPFS).
 */
import { internal } from './errors';

export const __memoryFallback = new Map<string, Uint8Array>();

function isQuotaError(err: unknown): boolean {
  return err instanceof DOMException && (err.name === 'QuotaExceededError' || err.code === 22);
}

/** A scratch file the startup probe creates and removes; never a `*.pdf`, so no sweep sees it. */
// Unique per probe: with one fixed name, two tabs booting at once could
// remove each other's scratch file mid-probe and fall back to memory-only
// storage for the whole session (regression review R-RT-5).
const probeFileName = () => `.stapler-opfs-probe-${crypto.randomUUID()}`;

/**
 * `navigator.storage.getDirectory()` existing is not proof it works: Firefox
 * Private Browsing, a restrictive iframe sandbox, or revoked storage access
 * can all make it throw a `SecurityError` even though the API is present, and
 * older Safari hands out a root whose file handles have no `createWritable`
 * (writes there only work from a worker, through sync access handles). OPFS
 * holds every document's actual bytes, so either case falls back to the
 * in-memory map instead of making the whole app non-functional.
 *
 * RT-20 — decided **once** per session and memoised. It used to be re-decided
 * on every call, so a transient `getDirectory()` failure could send one write
 * to memory and the next read to OPFS (or the reverse) — bytes "saved"
 * somewhere no later read would look. A missing `createWritable` was not
 * detected at all: every write threw a TypeError. The probe exercises the
 * whole write path (create a handle, open a writable, close it) before OPFS
 * is trusted with anything. Every read/write below goes through this.
 */
async function probeOpfsRoot(): Promise<FileSystemDirectoryHandle | null> {
  if (!globalThis.navigator?.storage?.getDirectory) return null;
  try {
    const root = await navigator.storage.getDirectory();
    const probeFile = probeFileName();
    const handle = await root.getFileHandle(probeFile, { create: true });
    try {
      if (typeof (handle as Partial<FileSystemFileHandle>).createWritable !== 'function') {
        return null;
      }
      const writable = await handle.createWritable();
      await writable.close();
      return root;
    } finally {
      try {
        await root.removeEntry(probeFile);
      } catch {
        // Harmless: an empty scratch file, and not a `*.pdf` any sweep touches.
      }
    }
  } catch {
    return null;
  }
}

let opfsRoot: Promise<FileSystemDirectoryHandle | null> | null = null;

function tryGetOpfsRoot(): Promise<FileSystemDirectoryHandle | null> {
  opfsRoot ??= probeOpfsRoot();
  return opfsRoot;
}

/**
 * Whether this session keeps document bytes in memory rather than OPFS. In
 * memory mode `writeSourceBytes` stores the caller's array itself, so a caller
 * must not transfer (detach) an array it has just written.
 */
export async function usesMemoryFallback(): Promise<boolean> {
  return (await tryGetOpfsRoot()) === null;
}

/** Test hook: forget the memoised storage-mode decision (RT-20). */
export function __resetOpfsProbeForTests(): void {
  opfsRoot = null;
}

/**
 * Writes one file into the OPFS root, turning quota exhaustion into the same
 * clear, actionable message `core/db.ts`'s IndexedDB guard already gives for the
 * identical failure, instead of an uncaught `QuotaExceededError` that surfaces as
 * a generic "Something went wrong" (see AUDIT-EDGE-CASES-2026-09-15.md §1.9). OPFS
 * holds the actual document bytes — often the largest thing this app ever writes
 * to disk — so it is the storage path most likely to hit quota.
 */
async function writeOpfsFile(
  root: FileSystemDirectoryHandle,
  name: string,
  bytes: Uint8Array
): Promise<void> {
  const fileHandle = await root.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(bytes);
    await writable.close();
  } catch (err) {
    await (writable as unknown as { abort(): Promise<void> }).abort().catch(() => {});
    if (isQuotaError(err)) {
      throw internal(
        'Local storage is full. Stapler could not save this document to browser storage — ' +
          'delete saved signatures or clear site data to free space, then try again.'
      );
    }
    throw err;
  }
}

export async function writeSourceBytes(id: string, bytes: Uint8Array): Promise<void> {
  const root = await tryGetOpfsRoot();
  if (!root) {
    __memoryFallback.set(id, bytes);
    return;
  }
  await writeOpfsFile(root, `${id}.pdf`, bytes);
}

export async function readSourceBytes(id: string): Promise<Uint8Array> {
  const root = await tryGetOpfsRoot();
  if (!root) {
    const bytes = __memoryFallback.get(id);
    if (!bytes) throw new Error(`Source not found in fallback: ${id}`);
    // Return a copy — callers (composeDocument, splitDocument) may transfer the
    // buffer to a worker via Comlink.transfer, which detaches the ArrayBuffer.
    // Returning the canonical reference would permanently destroy the in-memory
    // document for all subsequent operations.
    return bytes.slice();
  }
  const fileHandle = await root.getFileHandle(`${id}.pdf`);
  const file = await fileHandle.getFile();
  return new Uint8Array(await file.arrayBuffer());
}

/**
 * Whether a source's bytes are actually retrievable, without reading them.
 *
 * Session recovery (`session-recovery.ts`) needs this to tell "OPFS still has
 * it" from "the pointer survived but the bytes did not" before it ever offers
 * a restore — reading the whole file just to prove it exists would work too,
 * but for a multi-document session that's real bytes copied out of OPFS for
 * nothing.
 */
export async function sourceBytesExist(id: string): Promise<boolean> {
  const root = await tryGetOpfsRoot();
  if (!root) return __memoryFallback.has(id);
  try {
    const handle = await root.getFileHandle(`${id}.pdf`);
    const file = await handle.getFile();
    return file.size > 0;
  } catch {
    return false;
  }
}

export async function deleteSourceBytes(id: string): Promise<void> {
  const root = await tryGetOpfsRoot();
  if (!root) {
    __memoryFallback.delete(id);
    return;
  }
  try {
    await root.removeEntry(`${id}.pdf`);
  } catch {
    // Harmless if the file does not exist.
  }
}

export async function writeModelBytes(lang: string, bytes: Uint8Array): Promise<void> {
  const root = await tryGetOpfsRoot();
  if (!root) {
    __memoryFallback.set(`model_${lang}`, bytes);
    return;
  }
  await writeOpfsFile(root, `${lang}.traineddata.gz`, bytes);
}

export async function readModelBytes(lang: string): Promise<Uint8Array | null> {
  const root = await tryGetOpfsRoot();
  if (!root) {
    return __memoryFallback.get(`model_${lang}`) ?? null;
  }
  try {
    const fileHandle = await root.getFileHandle(`${lang}.traineddata.gz`);
    const file = await fileHandle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Removes an uploaded OCR model (audit 2026-09-25 CNV-8): a file that failed
 * the trial engine init must not be re-seeded before every later run, and the
 * user needs a way to take back a model they no longer want kept.
 */
export async function deleteModelBytes(lang: string): Promise<void> {
  const root = await tryGetOpfsRoot();
  if (!root) {
    __memoryFallback.delete(`model_${lang}`);
    return;
  }
  try {
    await root.removeEntry(`${lang}.traineddata.gz`);
  } catch {
    // Harmless if the file does not exist.
  }
}

export async function hasModelBytes(lang: string): Promise<boolean> {
  const root = await tryGetOpfsRoot();
  if (!root) {
    return __memoryFallback.has(`model_${lang}`);
  }
  try {
    await root.getFileHandle(`${lang}.traineddata.gz`);
    return true;
  } catch {
    return false;
  }
}

/** The OPFS file name suffix every document source is stored under. */
const SOURCE_SUFFIX = '.pdf';

/** Model caches that share the flat OPFS root with document bytes and must survive a sweep. */
function isModelFile(name: string): boolean {
  return name.startsWith('faceblur-') || name.includes('.traineddata') || name.startsWith('model_');
}

/**
 * RT-4 — deletes every stored document source that nothing live refers to.
 *
 * The only removal path used to be `deleteSourceBytes(id)` from
 * `closeDocument`, so any session that ended without closing every tab — a
 * closed window, a crash, a reload followed by "Start fresh", a recovery
 * record that failed validation — left its `<uuid>.pdf` files in OPFS for
 * good. For a redaction tool that is a privacy problem, not just a quota one:
 * the pre-redaction original stayed on disk after the user redacted it,
 * exported it and chose "Start fresh".
 *
 * `isLive` is asked per file, at the moment of removal, rather than taken as
 * a snapshot up front, so a source an import registers (or marks pending)
 * while the sweep is enumerating is never deleted out from under it.
 *
 * Only `*.pdf` document files are candidates. The OCR language models
 * (`*.traineddata.gz`) and face-detector weights (`faceblur-*`) are never
 * touched. Never throws: an unavailable or failing OPFS just means nothing is
 * swept this time. Returns how many sources were removed.
 *
 * OPFS is shared by every tab of this origin, so call this through
 * {@link sweepOrphanedSourceBytesIfSoleTab}, never directly from the app: a
 * second tab's open documents are not "live" to this one.
 */
export async function sweepOrphanedSourceBytes(isLive: (id: string) => boolean): Promise<number> {
  let removed = 0;
  try {
    const root = await tryGetOpfsRoot();
    if (!root) {
      for (const key of [...__memoryFallback.keys()]) {
        if (isModelFile(key) || isLive(key)) continue;
        __memoryFallback.delete(key);
        removed += 1;
      }
      return removed;
    }
    const dir = root as unknown as {
      entries?: () => AsyncIterableIterator<[string, FileSystemHandle]>;
    };
    if (typeof dir.entries !== 'function') return 0;
    // Collected first: removing entries while iterating the directory is not
    // guaranteed to visit every remaining entry.
    const candidates: string[] = [];
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind !== 'file') continue;
      if (!name.endsWith(SOURCE_SUFFIX) || isModelFile(name)) continue;
      candidates.push(name);
    }
    for (const name of candidates) {
      const id = name.slice(0, -SOURCE_SUFFIX.length);
      if (isLive(id)) continue;
      try {
        await root.removeEntry(name);
        removed += 1;
      } catch {
        // Locked by a writable elsewhere, or already gone — skip it.
      }
    }
  } catch {
    // Enumeration itself failed (revoked storage access, etc.) — nothing to do.
  }
  return removed;
}

/**
 * Every Stapler tab holds this lock in shared mode for its lifetime, so a tab
 * that can take it *exclusively* knows no other tab of this origin is alive —
 * the only situation in which "not live here" means "not live anywhere".
 */
const WORKSPACE_LOCK = 'stapler.workspace';
const LOCK_WAIT_MS = 3000;
let tabLockHeld: Promise<void> | null = null;

interface LockManagerLike {
  request<T>(
    name: string,
    options: { mode?: 'shared' | 'exclusive'; ifAvailable?: boolean },
    callback: (lock: unknown) => Promise<T> | T
  ): Promise<T>;
  query?(): Promise<{
    held?: { name?: string }[];
    pending?: { name?: string }[];
  }>;
}

function lockManager(): LockManagerLike | null {
  const locks = (globalThis.navigator as { locks?: LockManagerLike } | undefined)?.locks;
  return locks && typeof locks.request === 'function' ? locks : null;
}

/**
 * Takes this tab's shared workspace lock (once) and resolves when it is
 * granted, or after a short wait if it is not — never rejects, never hangs.
 */
function holdTabLock(locks: LockManagerLike): Promise<void> {
  if (!tabLockHeld) {
    tabLockHeld = new Promise<void>(resolve => {
      const timer = setTimeout(resolve, LOCK_WAIT_MS);
      locks
        .request(WORKSPACE_LOCK, { mode: 'shared' }, () => {
          clearTimeout(timer);
          resolve();
          // Held until the tab goes away.
          return new Promise<never>(() => {});
        })
        .catch(() => {
          clearTimeout(timer);
          resolve();
        });
    });
  }
  return tabLockHeld;
}

/**
 * RT-4 — {@link sweepOrphanedSourceBytes}, but only when this is the only
 * Stapler tab alive, so one tab never deletes another tab's open documents.
 * Without the Web Locks API there is no way to know, so nothing is swept.
 *
 * Resolves once this tab holds its own shared lock, which keeps a concurrently
 * booting tab's sweep from running while this one starts importing. Returns
 * the number of sources removed, or `null` when the sweep was skipped.
 */
export async function sweepOrphanedSourceBytesIfSoleTab(
  isLive: (id: string) => boolean
): Promise<number | null> {
  const locks = lockManager();
  if (!locks || typeof locks.query !== 'function') return null;
  // This tab's own shared lock comes first (normally already taken by
  // `announceTab` at the very start of startup). Every other tab takes its
  // lock just as early, so one still deciding on its restore prompt is
  // visible here — it used to take the lock only after its decision, and a
  // second tab's "Start fresh" swept the bytes it was about to restore
  // (regression review R-RT-2).
  await holdTabLock(locks);
  try {
    const state = await locks.query();
    const holders = (state.held ?? []).filter(l => l.name === WORKSPACE_LOCK).length;
    const waiting = (state.pending ?? []).filter(l => l.name === WORKSPACE_LOCK).length;
    if (holders !== 1 || waiting !== 0) return null;
    return await sweepOrphanedSourceBytes(isLive);
  } catch {
    return null;
  }
}

/**
 * Takes this tab's shared workspace lock as early as possible in startup, so
 * other tabs see it before they consider sweeping. Never rejects or hangs.
 */
export async function announceTab(): Promise<void> {
  const locks = lockManager();
  if (locks) await holdTabLock(locks);
}

/** Test hook: forget that this module already holds the tab lock. */
export function __resetTabLockForTests(): void {
  tabLockHeld = null;
}
