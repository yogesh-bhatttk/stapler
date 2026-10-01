/**
 * GAP-12 — the confirmed "Clear all local data" action and the cheaper
 * per-category clears the trust panel offers.
 *
 * Clear-all is refused while a job runs (its output would land in a cleared
 * workspace) and while another Stapler tab is open (that tab's documents share
 * the same OPFS, and its autosave would write its session straight back). The
 * confirmation names every category that will be deleted and, when documents
 * are open, says they will be closed and unsaved changes lost. After the clear
 * the page reloads, so every in-memory signal (workspace, undo history,
 * signature list, tool state) starts from nothing; the next startup finds no
 * recovery record and nothing to sweep.
 */
import { activeJob, confirmAction, notify, notifyError } from '../core/notify';
import { tKey, tPlural, translate } from '../core/i18n';
import { documents } from '../core/store';
import { suspendAutosave } from '../core/session-recovery';
import {
  clearAllLocalData,
  gatherLocalDataReport,
  isPartialClear,
  type LocalDataReport
} from '../core/local-data';
import { otherStaplerTabsOpen, clearStaplerFiles } from '../core/opfs';
import { clearStaplerStores, clearSearchIndexStore } from '../core/db';
import { clearSignatureLibrary } from '../core/signatures';
import { removeAllOcrModels } from '../core/ocr/modelState';
import { clearCachedModels } from '../core/ocr/tesseractCache';
import { formatStorageBytes } from '../core/storage-persistence';

function refuseWhileBusy(): boolean {
  const job = activeJob.value;
  if (!job) return false;
  notify('info', translate('Wait for the current operation to finish.'), {
    detail: translate('"{label}" is still running.', { label: job.label })
  });
  return true;
}

/** The confirmation's bullet list: what exists and will be deleted. */
export function describeClearAll(report: LocalDataReport, openDocuments: number): string[] {
  const lines: string[] = [];
  if (openDocuments > 0) {
    lines.push(
      tPlural(
        '{count} open documents will be closed — unsaved changes are lost. Export anything you need first.',
        openDocuments
      )
    );
  }
  lines.push(
    report.documents.files > 0
      ? tPlural(
          'Session-recovery data: {count} stored document files ({size})',
          report.documents.files,
          { size: formatStorageBytes(report.documents.bytes) }
        )
      : translate('Session-recovery data')
  );
  if (report.ocrModels.langs.length > 0) {
    lines.push(
      translate('OCR language models: {langs} ({size})', {
        langs: report.ocrModels.langs.join(', '),
        size: formatStorageBytes(report.ocrModels.bytes)
      })
    );
  }
  const db = report.db;
  if (db && db.signatures.count > 0) {
    lines.push(tPlural('{count} saved signatures and initials', db.signatures.count));
  }
  if (db && db.recents > 0) lines.push(tPlural('{count} recent files', db.recents));
  if (db && db.presets + db.recipes > 0) {
    lines.push(tPlural('{count} presets and saved recipes', db.presets + db.recipes));
  }
  if (db && db.indexedFiles > 0) {
    lines.push(tPlural('Folder-search index for {count} files', db.indexedFiles));
  }
  lines.push(translate('Settings: theme, language, keyboard shortcuts, the welcome screen'));
  return lines;
}

let clearing = false;

/** Refuses (with the reason) while another Stapler tab shares this storage. */
async function refuseWhileOtherTabsOpen(): Promise<boolean> {
  if ((await otherStaplerTabsOpen()) !== true) return false;
  notify('warning', translate('Close Stapler’s other tabs first.'), {
    detail: translate(
      'Another Stapler tab is open. Its documents share this storage, and it would save its session again straight away.'
    )
  });
  return true;
}

/**
 * Asks, then deletes everything Stapler stored and reloads the page. Returns
 * false when refused or cancelled (the reload means a `true` is rarely seen).
 */
export async function confirmAndClearAllLocalData(
  reload: () => void = () => location.reload()
): Promise<boolean> {
  if (clearing || refuseWhileBusy()) return false;
  clearing = true;
  try {
    if (await refuseWhileOtherTabsOpen()) return false;
    const report = await gatherLocalDataReport();
    const open = documents.value.length;
    const ok = await confirmAction({
      title: translate('Clear all local data?'),
      body: translate(
        'This permanently deletes everything Stapler keeps in this browser, then reloads the page. Files you exported or saved to disk are not touched.'
      ),
      details: describeClearAll(report, open),
      confirmLabel: translate('Clear all local data'),
      tone: 'danger'
    });
    if (!ok || refuseWhileBusy()) return false;
    // AUDIT-2026-10-01 RT-4 — asked again: a tab opened while the dialog was
    // up would save its session straight back, and its documents' bytes would
    // be deleted from under it.
    if (await refuseWhileOtherTabsOpen()) return false;
    suspendAutosave();
    const result = await clearAllLocalData();
    // RT-3 — a file that could not be deleted (locked by another tab) is
    // reported, never counted as cleared.
    if (isPartialClear(result)) {
      notify('warning', translate('Some local data could not be cleared.'), {
        detail:
          result.filesFailed > 0
            ? translate(
                'Stored files that could not be deleted: {count}. Close every other Stapler tab and try again, or use your browser’s “Clear site data”.',
                { count: result.filesFailed }
              )
            : translate(
                'Browser storage did not respond. Use your browser’s “Clear site data” to remove the rest.'
              )
      });
    }
    // Nothing left to protect: skip the "leave page?" prompt on the reload.
    documents.value = documents.value.map(doc => (doc.dirty ? { ...doc, dirty: false } : doc));
    reload();
    return true;
  } catch (err) {
    notifyError('Clear local data', err);
    return false;
  } finally {
    clearing = false;
  }
}

export type ClearCategory = 'signatures' | 'recents' | 'searchIndex' | 'ocrModels';

const CATEGORY_COPY: Record<ClearCategory, { title: string; body: string; done: string }> = {
  signatures: {
    title: tKey('Delete saved signatures?'),
    body: tKey(
      'Every saved signature and set of initials is deleted from this browser. Signatures already placed on open documents stay until you remove them.'
    ),
    done: tKey('Saved signatures deleted.')
  },
  recents: {
    title: tKey('Clear recent files?'),
    body: tKey(
      'The Recents list is cleared. Stapler only remembered how to reopen each file — the files themselves are not touched.'
    ),
    done: tKey('Recent files cleared.')
  },
  searchIndex: {
    title: tKey('Clear the folder-search index?'),
    body: tKey(
      'The text index built by folder search is deleted. Search a folder again to rebuild it.'
    ),
    done: tKey('Folder-search index cleared.')
  },
  ocrModels: {
    title: tKey('Remove stored OCR language models?'),
    body: tKey('The next OCR run will ask before downloading a model again.'),
    done: tKey('Stored OCR language models removed.')
  }
};

async function clearCategory(category: ClearCategory): Promise<boolean> {
  switch (category) {
    case 'signatures':
      return clearSignatureLibrary();
    case 'recents':
      return clearStaplerStores(['handles']);
    case 'searchIndex':
      return clearSearchIndexStore();
    case 'ocrModels': {
      await removeAllOcrModels();
      const cacheCleared = await clearCachedModels().then(
        () => true,
        () => false
      );
      const { failed } = await clearStaplerFiles(['ocr-model']);
      return cacheCleared && failed === 0;
    }
  }
}

/** Asks, then clears one category. Resolves true when it was cleared. */
export async function confirmAndClearCategory(category: ClearCategory): Promise<boolean> {
  if (refuseWhileBusy()) return false;
  const copy = CATEGORY_COPY[category];
  const ok = await confirmAction({
    title: translate(copy.title),
    body: translate(copy.body),
    confirmLabel: translate('Delete'),
    tone: 'danger'
  });
  if (!ok || refuseWhileBusy()) return false;
  try {
    if (!(await clearCategory(category))) {
      notify('warning', translate('Some local data could not be cleared.'), {
        detail: translate(
          'Browser storage did not respond. Use your browser’s “Clear site data” to remove the rest.'
        )
      });
      return false;
    }
    notify('success', translate(copy.done));
    return true;
  } catch (err) {
    notifyError('Clear local data', err);
    return false;
  }
}
