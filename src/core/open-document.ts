/**
 * UX-01 — the shared "open files into new documents" sequence, factored out of
 * DropZone so every "open a document" affordance (the drop zone itself, the
 * empty-state prompt on tool panels, Recents, a window-level drop) runs the
 * same flow without duplicating it.
 */
import { platform } from '../platform/current';
import { PDF_AND_IMAGES, type OpenedFile } from '../platform/index';
import { importFiles, isPdfFile, type ImportOutcome } from './import';
import { isSupportedImage } from './image';
import {
  addDocument,
  OPEN_DOCUMENT_LABEL,
  releasePendingSources,
  releaseSourceIfUnused
} from './store';
import { beginTransaction } from './history';
import { activeJob, notify, notifyError, type JobStatus } from './notify';
import { translate } from './i18n';
import { isCancellation } from './errors';
import { waitForImportReadiness } from './session-recovery';
import type { ImagesToPdfOptions } from './operations';
import type { JobOptions } from './workers/protocol';

export interface ImportFilesDeps {
  handles?: OpenedFile[];
  requestImageOptions: (files: File[]) => Promise<ImagesToPdfOptions | undefined>;
  /** Fires once the user has cleared any image-options prompt and import is actually starting. */
  onImportStart?: () => void;
  onProgress?: (value: number | null, label: string) => void;
}

export interface ImportFilesResult {
  imported: number;
  /** True when the user cancelled the open; nothing was added. */
  cancelled?: boolean;
}

/**
 * RT-14 — every "open files" entry point asks this first. Waits out the
 * startup recovery check, or refuses (with a message) while the "Restore your
 * previous session?" prompt is showing: restoring replaces the workspace
 * wholesale — documents *and* undo history — so a file opened underneath it
 * would silently vanish. Refusing rather than queueing, because a queued open
 * landing on top of a restored session is not what either choice promised.
 */
export async function ensureImportsAllowed(): Promise<boolean> {
  if ((await waitForImportReadiness()) === 'ready') return true;
  notify('info', translate('Answer the restore prompt first.'), {
    detail: translate('Choose Restore or Start fresh, then open your files again.')
  });
  return false;
}

/**
 * RT-7 — runs an import as *the* app job: sets `activeJob` (so the action bar
 * shows progress with a working Cancel, undo/redo and tab switching lock, and
 * every other job refuses to start on top of it) and hands the task an
 * `AbortSignal` wired to that Cancel.
 *
 * The open-files paths used to call `importFiles` with no signal and outside
 * the job model, so a 500 MB drop could not be stopped and nothing stopped an
 * edit (or a second import) from landing mid-import. Returns `undefined`,
 * after saying why, if another job already holds the slot.
 */
export async function runImportJob<T>(
  label: string,
  task: (job: JobOptions) => Promise<T>,
  onProgress?: (value: number | null, label: string) => void
): Promise<T | undefined> {
  if (activeJob.value !== null) {
    notify('info', translate('Finish or cancel the current operation first.'), {
      detail: translate('"{label}" is still running.', { label: activeJob.value.label })
    });
    return undefined;
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  let current: JobStatus = { label, progress: null, cancel };
  activeJob.value = current;
  try {
    return await task({
      signal: controller.signal,
      onProgress: (fraction, progressLabel) => {
        onProgress?.(fraction, progressLabel);
        // Only while this job still owns the slot — a late report must not
        // resurrect the progress bar over someone else's job.
        if (activeJob.value !== current) return;
        current = { label: progressLabel || label, progress: fraction, cancel };
        activeJob.value = current;
      }
    });
  } finally {
    if (activeJob.value === current) activeJob.value = null;
  }
}

/**
 * RT-7 — what a cancelled import leaves behind: sources already written for
 * the files that finished before Cancel. Nothing references them and nothing
 * will, so they are freed now rather than left in OPFS until the next close.
 */
export function discardImported(outcome: ImportOutcome): void {
  const ids = outcome.imported.map(item => item.source.id);
  releasePendingSources(ids);
  for (const id of ids) releaseSourceIfUnused(id);
}

/**
 * Adds one document per imported file — as a single undo step (RT-6) — and
 * reports every warning and failure. Shared by every open path (the drop zone,
 * Recents, a paste with nothing open), so they all add documents the same way.
 */
export function addImportedDocuments(
  outcome: ImportOutcome,
  files: File[],
  handles?: OpenedFile[]
): void {
  const tx =
    outcome.imported.length > 1 ? beginTransaction('open-documents', OPEN_DOCUMENT_LABEL) : null;
  try {
    for (const imported of outcome.imported) {
      let handle: OpenedFile | undefined;
      if (handles) {
        const index = files.indexOf(imported.originalFile);
        if (index !== -1) handle = handles[index];
      }
      addDocument({
        id: crypto.randomUUID(),
        name: imported.source.name,
        // `importFiles` already built these (same source id, same page count)
        // — regenerating a second set here just produced a different set of
        // page-key UUIDs than the ones `imported.pages` actually carries.
        pages: imported.pages,
        annotations: [],
        dirty: false,
        sourceHandle: handle?.writable ? { fileId: handle.id, writable: true } : undefined
      });
      for (const warning of imported.warnings) {
        notify('warning', imported.source.name, { detail: warning });
      }
    }
  } finally {
    tx?.end();
  }
  for (const failure of outcome.failures) {
    notify('danger', translate('Could not open {name}', { name: failure.name }), {
      detail: failure.message
    });
  }
}

/**
 * Imports `files` as new documents: one per PDF, one for all the images.
 *
 * Cancellable through the app's job Cancel (RT-7). A cancelled open adds
 * nothing — the files that had already finished are discarded rather than
 * half the batch opened. Opening is one undo step (RT-6): Ctrl+Z removes every
 * document this call added, and no other document's history is touched.
 */
export async function importFilesAsDocuments(
  files: File[],
  deps: ImportFilesDeps
): Promise<ImportFilesResult> {
  if (files.length === 0) return { imported: 0 };
  if (!(await ensureImportsAllowed())) return { imported: 0 };

  try {
    let imageOptions: ImagesToPdfOptions | undefined;
    const hasImages = files.some(f => !isPdfFile(f) && isSupportedImage(f));
    if (hasImages) {
      const options = await deps.requestImageOptions(files);
      if (!options) return { imported: 0 }; // user cancelled
      imageOptions = options;
    }

    const result = await runImportJob<ImportFilesResult>(
      translate('Opening files'),
      async job => {
        deps.onImportStart?.();
        const outcome = await importFiles(files, job, imageOptions);
        if (job.signal?.aborted) {
          discardImported(outcome);
          return { imported: 0, cancelled: true };
        }
        addImportedDocuments(outcome, files, deps.handles);
        return { imported: outcome.imported.length };
      },
      deps.onProgress
    );
    return result ?? { imported: 0 };
  } catch (err) {
    if (isCancellation(err)) return { imported: 0, cancelled: true };
    notifyError('import', err);
    return { imported: 0 };
  }
}

export async function pickAndImportFiles(
  deps: Omit<ImportFilesDeps, 'handles'>
): Promise<ImportFilesResult> {
  try {
    if (!(await ensureImportsAllowed())) return { imported: 0 };
    // Refused before the picker opens, not after the user has chosen files
    // (UI-20) — `runImportJob` would otherwise refuse and drop the choice.
    if (activeJob.value !== null) {
      notify('info', translate('Finish or cancel the current operation first.'));
      return { imported: 0 };
    }
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
