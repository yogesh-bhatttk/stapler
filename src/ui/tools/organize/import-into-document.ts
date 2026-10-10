/**
 * AUDIT-2026-10-10 M7 — the shared "add files to the open document" flow for
 * Merge (append) and Insert (at a position).
 *
 * Both panels had their own copy, and both had drifted from the canonical
 * open-files path (`core/open-document.ts`):
 *
 *  • no `ensureImportsAllowed` — files could be added under the "Restore your
 *    previous session?" prompt and then vanish when Restore replaced the
 *    workspace (RT-14);
 *  • no `ensureRoomToOpen` — no document ceiling, no memory soft-limit
 *    confirmation (GAP-11b);
 *  • no abort check after `importFiles` — Cancel stopped the import part-way
 *    and the files that had finished were still appended, under a success
 *    toast (HRD-45 RT-7). A cancelled add now adds nothing and frees what had
 *    been stored, exactly as a cancelled open does (`discardImported`).
 */
import { tPlural, translate } from '../../../core/i18n';
import { importFiles, isPdfFile, type ImportOutcome } from '../../../core/import';
import { isSupportedImage } from '../../../core/image';
import type { ImagesToPdfOptions } from '../../../core/operations';
import { addDocument, documents, insertPages, setPageSelection } from '../../../core/store';
import { activeJob, notify } from '../../../core/notify';
import {
  discardImported,
  ensureImportsAllowed,
  ensureRoomToOpen
} from '../../../core/open-document';
import type { JobOptions } from '../../../core/workers/protocol';
import { tryToRepairAction } from '../repair/state';

/**
 * Checked before the picker opens (UI-20): refused while a job runs, or while
 * the restore prompt is up. Resolves whether the picker may open.
 */
export async function mayPickFilesToAdd(): Promise<boolean> {
  if (activeJob.value !== null) {
    notify('info', translate('Finish or cancel the current operation first.'));
    return false;
  }
  return ensureImportsAllowed();
}

/**
 * After the picker: the workspace-capacity check, then the image options
 * dialog when any image was chosen. `incomingDocuments` is how many documents
 * the add creates — 0 when pages go into an open document, 1 when Merge
 * starts one. Resolves null when refused or cancelled.
 */
export async function prepareFilesToAdd(
  files: File[],
  incomingDocuments: number,
  requestOptions: (files: File[]) => Promise<ImagesToPdfOptions | undefined>
): Promise<{ imageOptions: ImagesToPdfOptions | undefined } | null> {
  if (!(await ensureRoomToOpen(files, incomingDocuments))) return null;
  if (!files.some(f => !isPdfFile(f) && isSupportedImage(f))) return { imageOptions: undefined };
  const imageOptions = await requestOptions(files);
  return imageOptions ? { imageOptions } : null;
}

function reportProblems(outcome: ImportOutcome): void {
  for (const imported of outcome.imported) {
    for (const warning of imported.warnings) {
      notify('warning', imported.source.name, { detail: warning });
    }
  }
  // A failure on one file never stops the others, and each says why.
  for (const failure of outcome.failures) {
    notify('danger', translate('Could not add {name}', { name: failure.name }), {
      detail: failure.message,
      ...(failure.repairable ? { action: tryToRepairAction(failure.repairable) } : {})
    });
  }
}

/**
 * Imports `files` and puts their pages into the document `docId`: appended
 * (`at` omitted) or inserted at `at`. With no target (Merge with nothing
 * open, or the target closed meanwhile), the first file becomes a new
 * document and the rest are appended to it. Resolves the inserted page keys
 * and how many files they came from; a cancelled job adds nothing and
 * resolves null.
 */
export async function importIntoDocument(
  files: File[],
  job: JobOptions,
  imageOptions: ImagesToPdfOptions | undefined,
  target: { docId: string | null; at?: number; createIfMissing: boolean }
): Promise<{ keys: string[]; files: number } | null> {
  const outcome = await importFiles(files, job, imageOptions);
  if (job.signal?.aborted) {
    discardImported(outcome);
    return null;
  }
  let docId =
    target.docId && documents.value.some(d => d.id === target.docId) ? target.docId : null;
  if (!docId && !target.createIfMissing) {
    // Insert's document was closed while its files were importing.
    discardImported(outcome);
    notify('warning', translate('The document was closed, so nothing was inserted.'));
    return null;
  }
  let at = target.at;
  const insertedKeys: string[] = [];
  const added: typeof outcome.imported = [];
  for (const imported of outcome.imported) {
    if (!docId) {
      const newDoc = {
        id: crypto.randomUUID(),
        name: imported.source.name,
        pages: imported.pages,
        annotations: [],
        dirty: false
      };
      if (!addDocument(newDoc)) break;
      docId = newDoc.id;
    } else {
      const doc = documents.value.find(d => d.id === docId);
      const position = at ?? doc?.pages.length ?? 0;
      insertPages(docId, imported.pages, position);
      if (at !== undefined) at += imported.pages.length;
    }
    insertedKeys.push(...imported.pages.map(p => p.key));
    added.push(imported);
  }
  // Refused by the document ceiling (backstop): free what was not placed.
  const unplaced = outcome.imported.filter(item => !added.includes(item));
  if (unplaced.length > 0) discardImported({ imported: unplaced, failures: [] });
  reportProblems({ imported: added, failures: outcome.failures });
  return { keys: insertedKeys, files: added.length };
}

/** Merge's success toast. */
export function notifyMerged(count: number): void {
  if (count > 0) notify('success', tPlural('Added {count} documents.', count));
}

/** Insert's success toast, and the inserted pages selected as the visible marker. */
export function notifyInserted(keys: string[], position: number): void {
  if (keys.length === 0) return;
  // Selecting the newly-inserted pages is the "visible insertion indicator"
  // for a non-drag insert: the grid highlights exactly where the pages
  // landed, the same way a drag's drop line does.
  setPageSelection(keys);
  notify(
    'success',
    tPlural('Inserted {count} pages at position {position}.', keys.length, {
      position: position + 1
    })
  );
}
