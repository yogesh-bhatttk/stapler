/**
 * UX-01 — the shared "open files into new documents" sequence, factored out of
 * DropZone so any "open a document" affordance (the drop zone itself, and the
 * empty-state prompt on tool panels) can trigger the same flow without
 * duplicating it a third time.
 */
import { platform } from '../platform/current';
import { PDF_AND_IMAGES, type OpenedFile } from '../platform/index';
import { importFiles, isPdfFile } from './import';
import { isSupportedImage } from './image';
import { addDocument, makePageRefs } from './store';
import { resetHistory } from './history';
import { notify, notifyError } from './notify';
import { translate } from './i18n';
import type { ImagesToPdfOptions } from './operations';

export interface ImportFilesDeps {
  handles?: OpenedFile[];
  requestImageOptions: (files: File[]) => Promise<ImagesToPdfOptions | undefined>;
  /** Fires once the user has cleared any image-options prompt and import is actually starting. */
  onImportStart?: () => void;
  onProgress?: (value: number | null, label: string) => void;
}

export interface ImportFilesResult {
  imported: number;
}

export async function importFilesAsDocuments(
  files: File[],
  deps: ImportFilesDeps
): Promise<ImportFilesResult> {
  if (files.length === 0) return { imported: 0 };

  let imageOptions: ImagesToPdfOptions | undefined;
  const hasImages = files.some(f => !isPdfFile(f) && isSupportedImage(f));
  if (hasImages) {
    const options = await deps.requestImageOptions(files);
    if (!options) return { imported: 0 }; // user cancelled
    imageOptions = options;
  }

  deps.onImportStart?.();

  try {
    const outcome = await importFiles(
      files,
      { onProgress: (value, label) => deps.onProgress?.(value, label) },
      imageOptions
    );

    for (const imported of outcome.imported) {
      let handle: OpenedFile | undefined;
      if (deps.handles) {
        const index = files.indexOf(imported.originalFile);
        if (index !== -1) handle = deps.handles[index];
      }
      addDocument({
        id: crypto.randomUUID(),
        name: imported.source.name,
        pages: makePageRefs(imported.source.id, imported.source.pageCount),
        annotations: [],
        dirty: false,
        sourceHandle: handle?.writable ? { fileId: handle.id, writable: true } : undefined
      });
      for (const warning of imported.warnings) {
        notify('warning', imported.source.name, { detail: warning });
      }
    }
    for (const failure of outcome.failures) {
      notify('danger', translate('Could not open {name}', { name: failure.name }), {
        detail: failure.message
      });
    }

    if (outcome.imported.length > 0) resetHistory();
    return { imported: outcome.imported.length };
  } catch (err) {
    notifyError('import', err);
    return { imported: 0 };
  }
}

export async function pickAndImportFiles(
  deps: Omit<ImportFilesDeps, 'handles'>
): Promise<ImportFilesResult> {
  try {
    const opened = await platform.openFiles({ multiple: true, accept: PDF_AND_IMAGES });
    if (opened.length === 0) return { imported: 0 };
    for (const handle of opened) {
      if (handle.persistable) await platform.persistHandle(handle);
    }
    const files = await Promise.all(opened.map(handle => handle.getFile()));
    return await importFilesAsDocuments(files, { ...deps, handles: opened });
  } catch (err) {
    notifyError('import.browse', err);
    return { imported: 0 };
  }
}
