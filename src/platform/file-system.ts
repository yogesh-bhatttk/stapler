/**
 * The File System Access implementation of the platform adapter, shared by both
 * targets.
 *
 * There is no meaningful difference between the extension and a modern browser tab
 * here — the API is the same and needs no permission either way, which is exactly
 * why PLAN §2.5 chose it over the `downloads` permission. `extension.ts` and
 * `web.ts` differ only in their fallbacks.
 */
import {
  ensureReadPermission,
  ensureWritePermission,
  hasDirectoryPicker,
  hasFileSystemAccess,
  isAbort,
  pickerTypes,
  showDirectoryPicker,
  showOpenFilePicker,
  showSaveFilePicker,
  type FsaFileHandle
} from './fsa';
import type { OpenOptions, OpenedFile, OutputDirectory, RecentEntry } from './index';
import { deleteHandle, listHandles, readHandle, writeHandle } from '../core/db';

/** Handles from this session, so `saveOver` can find the one a file came from. */
const session = new Map<string, FsaFileHandle>();

function wrap(handle: FsaFileHandle): OpenedFile {
  const id = crypto.randomUUID();
  session.set(id, handle);
  return {
    id,
    name: handle.name,
    getFile: () => handle.getFile(),
    persistable: true,
    writable: true
  };
}

export async function openFilesViaPicker(options?: OpenOptions): Promise<OpenedFile[]> {
  try {
    const handles = await showOpenFilePicker({
      multiple: options?.multiple,
      types: pickerTypes(options?.accept, 'PDFs and images')
    });
    return handles.map(wrap);
  } catch (err) {
    if (isAbort(err)) return [];
    throw err;
  }
}

export async function openDirectoryViaPicker(): Promise<OutputDirectory | null> {
  if (!hasDirectoryPicker()) return null;
  try {
    const directory = await showDirectoryPicker({ mode: 'readwrite' });
    if (!(await ensureWritePermission(directory))) return null;
    return {
      name: directory.name,
      write: async (fileName, bytes) => {
        const file = await directory.getFileHandle(fileName, { create: true });
        const writable = await file.createWritable();
        try {
          await writable.write(bytes);
          await writable.close();
        } catch (err) {
          // abort() discards the partial write atomically; ignore its own error.
          await (writable as unknown as { abort(): Promise<void> }).abort().catch(() => {});
          throw err;
        }
      }
    };
  } catch (err) {
    if (isAbort(err)) return null;
    throw err;
  }
}

export async function saveViaPicker(bytes: Uint8Array, suggestedName: string): Promise<boolean> {
  const extension = suggestedName.match(/\.[^.]+$/)?.[0] ?? '.pdf';
  const mime =
    extension === '.zip'
      ? 'application/zip'
      : extension === '.pdf'
        ? 'application/pdf'
        : 'text/plain';
  try {
    const handle = await showSaveFilePicker({
      suggestedName,
      types: pickerTypes({ [mime]: [extension] }, 'Saved file')
    });
    const writable = await handle.createWritable();
    try {
      await writable.write(bytes);
      await writable.close();
    } catch (err) {
      await (writable as unknown as { abort(): Promise<void> }).abort().catch(() => {});
      throw err;
    }
    return true;
  } catch (err) {
    if (isAbort(err)) return false;
    throw err;
  }
}

export async function saveOverHandle(fileId: string, bytes: Uint8Array): Promise<boolean> {
  const handle = session.get(fileId) ?? (await readHandle(fileId));
  if (!handle) return false;
  if (!(await ensureWritePermission(handle))) return false;
  const writable = await handle.createWritable();
  try {
    await writable.write(bytes);
    await writable.close();
  } catch (err) {
    await (writable as unknown as { abort(): Promise<void> }).abort().catch(() => {});
    throw err;
  }
  return true;
}

/** DS-05 Recents: handles survive a reload; permission is re-requested on reopen. */
export async function persistFileHandle(file: OpenedFile): Promise<void> {
  const handle = session.get(file.id);
  if (!handle) return;
  await writeHandle(file.id, file.name, handle);
}

export async function listRecent(): Promise<RecentEntry[]> {
  return listHandles();
}

export async function reopenPersisted(id: string): Promise<OpenedFile | null> {
  const handle = await readHandle(id);
  if (!handle) return null;
  // Chrome drops permission between sessions, so a Recents click has to be allowed
  // to re-prompt rather than failing silently.
  if (!(await ensureReadPermission(handle))) return null;
  session.set(id, handle);

  let writable = false;
  if (hasFileSystemAccess()) {
    try {
      writable = (await handle.queryPermission({ mode: 'readwrite' })) === 'granted';
    } catch {
      // Ignore if queryPermission fails
    }
  }

  return {
    id,
    name: handle.name,
    getFile: () => handle.getFile(),
    persistable: true,
    writable
  };
}

export async function revokePersisted(id: string): Promise<void> {
  session.delete(id);
  await deleteHandle(id);
}

/** Fallback: `<input type=file>`, for browsers without the picker (Firefox). */
export function openFilesViaInput(options?: OpenOptions): Promise<OpenedFile[]> {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    if (options?.multiple) input.multiple = true;
    if (options?.accept) {
      input.accept = Object.entries(options.accept)
        .flatMap(([mime, extensions]) => [mime, ...extensions])
        .join(',');
    }

    // A dismissed picker fires no `change` event in most browsers, so without this
    // the promise never settles and the calling job hangs forever.
    const settle = (files: FileList | null) => {
      resolve(
        Array.from(files ?? []).map(file => ({
          id: crypto.randomUUID(),
          name: file.name,
          getFile: async () => file,
          persistable: false,
          writable: false
        }))
      );
    };

    input.addEventListener('change', () => settle(input.files), { once: true });
    input.addEventListener('cancel', () => settle(null), { once: true });
    input.click();
  });
}

/** Fallback: anchor download, for saving without the picker. */
export function saveViaDownload(bytes: Uint8Array, suggestedName: string): boolean {
  // Copy into a fresh buffer: a transferred Uint8Array may be a view on a larger
  // ArrayBuffer, and Blob would then write the whole thing.
  const blob = new Blob([bytes.slice()], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = suggestedName;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}

export { hasFileSystemAccess };
