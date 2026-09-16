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

/**
 * `navigator.storage.getDirectory()` existing is not proof it works: Firefox
 * Private Browsing, a restrictive iframe sandbox, or storage access revoked
 * mid-session can all make it throw a `SecurityError` even though the API is
 * present. OPFS holds every document's actual bytes, so treating that throw
 * as fatal instead of falling back to the in-memory map would make the whole
 * app non-functional in those environments. Every read/write below goes
 * through this instead of touching `navigator.storage` directly.
 */
async function tryGetOpfsRoot(): Promise<FileSystemDirectoryHandle | null> {
  if (!navigator.storage?.getDirectory) return null;
  try {
    return await navigator.storage.getDirectory();
  } catch {
    return null;
  }
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
 * RED-08 — the face-detector weight cache.
 *
 * A separate pair from `writeModelBytes`/`readModelBytes` rather than a
 * parameterised one, because those hard-code the `.traineddata.gz` suffix
 * tesseract's loader expects and this model is two files with names of its own.
 * The `faceblur-` prefix keeps a weight shard from ever colliding with a
 * document id (`<uuid>.pdf`) in the same flat OPFS root.
 */
function faceModelFileName(name: string): string {
  return `faceblur-${name}`;
}

export async function writeFaceModelFile(name: string, bytes: Uint8Array): Promise<void> {
  const fileName = faceModelFileName(name);
  const root = await tryGetOpfsRoot();
  if (!root) {
    __memoryFallback.set(fileName, bytes);
    return;
  }
  await writeOpfsFile(root, fileName, bytes);
}

export async function readFaceModelFile(name: string): Promise<Uint8Array | null> {
  const fileName = faceModelFileName(name);
  const root = await tryGetOpfsRoot();
  if (!root) {
    return __memoryFallback.get(fileName) ?? null;
  }
  try {
    const fileHandle = await root.getFileHandle(fileName);
    const file = await fileHandle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    return null;
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
