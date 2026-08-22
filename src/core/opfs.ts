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
  if (!navigator.storage?.getDirectory) {
    __memoryFallback.set(fileName, bytes);
    return;
  }
  const root = await navigator.storage.getDirectory();
  const fileHandle = await root.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(bytes);
  await writable.close();
}

export async function readFaceModelFile(name: string): Promise<Uint8Array | null> {
  const fileName = faceModelFileName(name);
  if (!navigator.storage?.getDirectory) {
    return __memoryFallback.get(fileName) ?? null;
  }
  try {
    const root = await navigator.storage.getDirectory();
    const fileHandle = await root.getFileHandle(fileName);
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
