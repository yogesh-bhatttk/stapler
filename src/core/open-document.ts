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
  releasePendingSources,
  releaseSourceIfUnused,
  workspaceOpenCapacity
} from './store';
import { MAX_OPEN_DOCUMENTS } from './workspace-limits';
import { activeJob, confirmAction, notify, notifyError, type JobStatus } from './notify';
import { translate } from './i18n';
import { isCancellation } from './errors';
import { waitForImportReadiness } from './session-recovery';
import { tryToRepairAction } from '../ui/tools/repair/state';
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

/** How many documents opening `files` would add: one per PDF, one for all the images. */
export function expectedDocumentCount(files: readonly File[]): number {
  const pdfs = files.filter(isPdfFile).length;
  const hasImages = files.some(f => !isPdfFile(f) && isSupportedImage(f));
  return pdfs + (hasImages ? 1 : 0);
}

function formatGigabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function notifyDocumentCeiling(openCount: number): void {
  notify('warning', translate('Too many documents are open.'), {
    detail: translate(
      'Stapler can keep up to {max} documents open at once (open now: {open}). Close some tabs, then open your files again.',
      { max: MAX_OPEN_DOCUMENTS, open: openCount }
    )
  });
}

/**
 * GAP-11b — asked by every open-files path before any work starts. Refuses
 * (with a message saying to close tabs) an open that would pass the document
 * ceiling, and asks first when it would take the workspace past the
 * memory-aware soft limit. Nothing is imported unless this returns true.
 */
export async function ensureRoomToOpen(files: readonly File[]): Promise<boolean> {
  const incoming = expectedDocumentCount(files);
  const bytes = files.reduce((sum, file) => sum + file.size, 0);
  const capacity = workspaceOpenCapacity(incoming, bytes);
  if (!capacity.ok) {
    notifyDocumentCeiling(capacity.openCount);
    return false;
  }
  if (capacity.overSoftLimit) {
    return confirmAction({
      title: translate('Open these files anyway?'),
      body: translate(
        'Open documents would add up to about {size}. Stapler may slow down, and if the browser runs out of memory it can close this tab, losing unsaved changes. Closing tabs you no longer need helps.',
        { size: formatGigabytes(capacity.projectedBytes) }
      ),
      confirmLabel: translate('Open anyway')
    });
  }
  return true;
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
 * Adds one document per imported file and reports every warning and failure.
 * Shared by every open path (the drop zone, Recents, a paste with nothing
 * open), so they all add documents the same way.
 *
 * Opening is not an undo step (GAP-11a): each new document starts with an
 * empty history of its own. A file that would pass the open-document ceiling
 * (GAP-11b — normally refused earlier, by `ensureRoomToOpen`) is not added;
 * its already-stored bytes are freed and the user is told.
 */
export function addImportedDocuments(
  outcome: ImportOutcome,
  files: File[],
  handles?: OpenedFile[]
): void {
  const refused: string[] = [];
  for (const imported of outcome.imported) {
    let handle: OpenedFile | undefined;
    if (handles) {
      const index = files.indexOf(imported.originalFile);
      if (index !== -1) handle = handles[index];
    }
    const added = addDocument({
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
    if (!added) {
      refused.push(imported.source.id);
      continue;
    }
    for (const warning of imported.warnings) {
      notify('warning', imported.source.name, { detail: warning });
    }
  }
  if (refused.length > 0) {
    releasePendingSources(refused);
    for (const id of refused) releaseSourceIfUnused(id);
    notify('warning', translate('Some files were not opened.'), {
      detail: translate(
        'The limit of {max} open documents was reached. Close some tabs, then open the remaining files again.',
        { max: MAX_OPEN_DOCUMENTS }
      )
    });
  }
  for (const failure of outcome.failures) {
    notify('danger', translate('Could not open {name}', { name: failure.name }), {
      detail: failure.message,
      ...(failure.repairable ? { action: tryToRepairAction(failure.repairable) } : {})
    });
  }
}

/**
 * Imports `files` as new documents: one per PDF, one for all the images.
 *
 * Cancellable through the app's job Cancel (RT-7). A cancelled open adds
 * nothing — the files that had already finished are discarded rather than
 * half the batch opened. Opening is not an undo step (GAP-11a): the new
 * documents start with empty histories and no other document's is touched.
 * Refused up front when it would pass the open-document ceiling (GAP-11b).
 */
export async function importFilesAsDocuments(
  files: File[],
  deps: ImportFilesDeps
): Promise<ImportFilesResult> {
  if (files.length === 0) return { imported: 0 };
  if (!(await ensureImportsAllowed())) return { imported: 0 };
  if (!(await ensureRoomToOpen(files))) return { imported: 0 };

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
