/**
 * OPFS management for document byte storage.
 * Keeps memory overhead low by offloading the raw Uint8Arrays
 * of documents to the Origin Private File System (OPFS).
 */

export const __memoryFallback = new Map<string, Uint8Array>();

export async function writeSourceBytes(id: string, bytes: Uint8Array): Promise<void> {
  if (!navigator.storage?.getDirectory) {
    __memoryFallback.set(id, bytes);
    return;
  }
  const root = await navigator.storage.getDirectory();
  const fileHandle = await root.getFileHandle(`${id}.pdf`, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(bytes);
  await writable.close();
}

export async function readSourceBytes(id: string): Promise<Uint8Array> {
  if (!navigator.storage?.getDirectory) {
    const bytes = __memoryFallback.get(id);
    if (!bytes) throw new Error(`Source not found in fallback: ${id}`);
    return bytes;
  }
  const root = await navigator.storage.getDirectory();
  const fileHandle = await root.getFileHandle(`${id}.pdf`);
  const file = await fileHandle.getFile();
  return new Uint8Array(await file.arrayBuffer());
}

export async function deleteSourceBytes(id: string): Promise<void> {
  if (!navigator.storage?.getDirectory) {
    __memoryFallback.delete(id);
    return;
  }
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(`${id}.pdf`);
  } catch {
    // Harmless if the file does not exist.
  }
}

export async function writeModelBytes(lang: string, bytes: Uint8Array): Promise<void> {
  if (!navigator.storage?.getDirectory) {
    __memoryFallback.set(`model_${lang}`, bytes);
    return;
  }
  const root = await navigator.storage.getDirectory();
  const fileHandle = await root.getFileHandle(`${lang}.traineddata.gz`, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(bytes);
  await writable.close();
}

export async function readModelBytes(lang: string): Promise<Uint8Array | null> {
  if (!navigator.storage?.getDirectory) {
    return __memoryFallback.get(`model_${lang}`) ?? null;
  }
  try {
    const root = await navigator.storage.getDirectory();
    const fileHandle = await root.getFileHandle(`${lang}.traineddata.gz`);
    const file = await fileHandle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    return null;
  }
}

export async function hasModelBytes(lang: string): Promise<boolean> {
  if (!navigator.storage?.getDirectory) {
    return __memoryFallback.has(`model_${lang}`);
  }
  try {
    const root = await navigator.storage.getDirectory();
    await root.getFileHandle(`${lang}.traineddata.gz`);
    return true;
  } catch {
    return false;
  }
}
