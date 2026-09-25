/**
 * DOC-11 — crash/reload session recovery.
 *
 * `store.ts`'s own header explains why a previous version of this exact idea
 * was removed: it persisted whole documents — bytes included — on every
 * mutation, structured-cloning every open file's content on a single page
 * reorder. This is not that feature revived. Since that removal, the
 * workspace model (`store.ts`) keeps document *bytes* in OPFS, addressed by
 * source id, entirely separate from the *pointer* state this module saves —
 * `documents`/`sources`/the undo stack are page lists, source ids, rotations,
 * annotations, and small metadata, never a byte array. Serialising all of it
 * on every commit costs about as much as serialising one document's page
 * list, because that is all it has ever contained.
 *
 * OPFS bytes for a source already survive a reload or crash on their own —
 * that is the point of OPFS over an in-memory buffer — so recovery only has
 * to restore the pointers that say which OPFS files matter and in what
 * arrangement; it never touches document bytes directly.
 */
import { effect, signal } from '@preact/signals';
import { documents, sources, activeDocId, selectedPageKeys, isSourcePending } from './store';
import { batch } from '@preact/signals';
import type { StaplerDoc, SourceDocument } from './store';
import { cropBoxes } from '../ui/tools/crop/state';
import type { CropBox } from '../ui/tools/crop/state';
import { pageAnnotations } from '../ui/tools/annotate/state';
import type { Annotation } from '../ui/tools/annotate/state';
import { serializeHistory, restoreHistoryFromRecord, type SerializedHistory } from './history';
import { readSetting, writeSetting } from './db';
import { logEvent } from './errors';
import { sourceBytesExist, sweepOrphanedSourceBytesIfSoleTab } from './opfs';

const SESSION_KEY = 'session.recovery';
const SAVE_DEBOUNCE_MS = 500;

export interface SessionRecord {
  documents: StaplerDoc[];
  sources: Record<string, SourceDocument>;
  activeDocId: string | null;
  selection: string[];
  cropBoxes: Record<string, CropBox>;
  pageAnnotations: Record<string, Annotation[]>;
  history: SerializedHistory;
  savedAt: number;
}

/**
 * True once the startup recovery check has resolved (accepted, declined, or
 * found nothing to offer). The autosave watcher in `AppShell` waits on this
 * before it starts: without the gate, its very first run — before the saved
 * record has even been read — would see the empty state a fresh boot starts
 * in and overwrite the record before the user was ever asked about it.
 */
export const sessionRecoveryChecked = signal(false);

/** True while the "Restore your previous session?" prompt is on screen. */
export const sessionRecoveryPrompting = signal(false);

/**
 * RT-14 — resolves once opening files is safe: `'ready'` when the recovery
 * check has finished, or `'prompting'` as soon as the restore prompt is on
 * screen (whichever comes first).
 *
 * Files opened while the prompt was showing used to be silently discarded
 * when the user then clicked Restore: `restoreSession` replaces `documents`
 * and `sources` wholesale, so the new document vanished and its bytes were
 * orphaned. Import entry points refuse on `'prompting'` and simply wait out
 * the (normally instant) check otherwise, so a file dropped on a fresh boot
 * with nothing to restore still opens.
 */
export function waitForImportReadiness(): Promise<'ready' | 'prompting'> {
  return new Promise(resolve => {
    let done = false;
    let dispose: (() => void) | null = null;
    dispose = effect(() => {
      if (done) return;
      const outcome = sessionRecoveryChecked.value
        ? 'ready'
        : sessionRecoveryPrompting.value
          ? 'prompting'
          : null;
      if (!outcome) return;
      done = true;
      resolve(outcome);
      // The effect runs synchronously once on creation, before `dispose` is
      // assigned; that case is disposed right after `effect()` returns.
      dispose?.();
    });
    if (done) dispose();
  });
}

export async function loadPendingRecovery(): Promise<SessionRecord | null> {
  const record = await readSetting<SessionRecord>(SESSION_KEY);
  return record && record.documents.length > 0 ? record : null;
}

export async function clearSession(): Promise<void> {
  await writeSetting(SESSION_KEY, null);
}

let isSaving = false;
let needsSave = false;

/**
 * Writes the current workspace as the recovery record, or clears it once
 * nothing is open — an empty record is not "a session to restore," and
 * leaving a stale one around would offer to restore nothing back to nothing.
 */
export async function saveSession(): Promise<void> {
  if (isSaving) {
    needsSave = true;
    return;
  }
  isSaving = true;
  try {
    if (documents.value.length === 0) {
      await clearSession();
      return;
    }
    const record: SessionRecord = {
      documents: documents.value,
      sources: sources.value,
      activeDocId: activeDocId.value,
      selection: [...selectedPageKeys.value],
      cropBoxes: cropBoxes.value,
      pageAnnotations: pageAnnotations.value,
      history: serializeHistory(),
      savedAt: Date.now()
    };
    await writeSetting(SESSION_KEY, record);
  } finally {
    isSaving = false;
    if (needsSave) {
      needsSave = false;
      scheduleSessionSave();
    }
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Debounced entry point for the autosave watcher — coalesces a burst of edits into one write. */
export function scheduleSessionSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveSession().catch(err => logEvent('warn', 'session-recovery', String(err)));
  }, SAVE_DEBOUNCE_MS);
}

export interface RecoveryCheck {
  record: SessionRecord;
  /** Documents dropped because their source bytes no longer exist. */
  droppedDocuments: number;
}

/**
 * Validates a saved record against what OPFS actually still holds, before it
 * is ever offered to the user.
 *
 * The pointer this module saves can outlive the bytes it points to in two
 * ways: `opfs.ts` falls back to an in-memory `Map` in a browser without OPFS
 * support, which does not survive the reload this feature exists to recover
 * from; and `closeDocument` deletes a now-unreferenced source's bytes
 * synchronously while the next autosave recording that removal is still
 * debounced, so a crash in that window leaves a record naming a source that
 * is already gone. Either way, restoring the record as saved would hand back
 * a document Stapler cannot read a single byte of — exactly the silent
 * corruption this product refuses to produce, so it is checked here instead
 * of surfacing as the first failed export after "Restore" was clicked.
 *
 * Returns `null` when nothing in the record survives (nothing to offer).
 */
export async function checkRecovery(record: SessionRecord): Promise<RecoveryCheck | null> {
  const ids = Object.keys(record.sources);
  // A source is usable only if it is both registered in the record (restore
  // registers exactly `record.sources`) *and* still has bytes in OPFS.
  const existing = new Set<string>();
  await Promise.all(
    ids.map(async id => {
      if (await sourceBytesExist(id)) existing.add(id);
    })
  );
  const pageUsable = (page: { sourceDocId: string }) => existing.has(page.sourceDocId);
  const docUsable = (doc: StaplerDoc) =>
    [...doc.pages, ...(doc.baseline ?? doc.pages)].every(pageUsable);
  // RT-2 — the fast path used to trust the record whenever every id *listed
  // in* `record.sources` had bytes, without asking whether the pages actually
  // point at listed ids. A record autosaved after closeDocument had GC'd a
  // source the undo stack still referenced passed that check, and the broken
  // document and history were restored as-is. Every page reference — live
  // documents and every undo/redo snapshot, `pages` and `baseline` — is
  // checked now.
  const historyUsable = [...record.history.undoStack, ...record.history.redoStack].every(state =>
    state.docs.every(docUsable)
  );
  if (existing.size === ids.length && historyUsable && record.documents.every(docUsable)) {
    return { record, droppedDocuments: 0 };
  }

  // A document with even one page whose source is gone is dropped whole:
  // a document silently missing some of its pages is worse than one that
  // is not offered back at all. Checked against `baseline` too, not just
  // `pages` — the export-review diff and "Discard all changes" both read
  // straight from `baseline` (`doc.baseline ?? doc.pages`, the same fallback
  // `restoreSession` uses below, for a record old enough to predate the
  // field) — the same reasoning `closeDocument`'s own source GC already
  // applies (`store.ts`, unions `pages` and `baseline` before freeing a
  // source). A page current pages no longer reference can still be sitting
  // in baseline, so checking `pages` alone would restore a document that
  // exports fine today but throws the moment its diff (or a discard) tries
  // to read the baseline page whose bytes are already gone.
  const survivingDocs = record.documents.filter(docUsable);
  const droppedDocuments = record.documents.length - survivingDocs.length;
  if (survivingDocs.length === 0) return null;

  const survivingSources: Record<string, SourceDocument> = {};
  for (const id of ids) {
    if (existing.has(id)) survivingSources[id] = record.sources[id];
  }

  return {
    droppedDocuments,
    record: {
      ...record,
      documents: survivingDocs,
      sources: survivingSources,
      activeDocId: survivingDocs.some(d => d.id === record.activeDocId)
        ? record.activeDocId
        : survivingDocs[0].id,
      selection: [],
      // A saved undo/redo entry can reference a page key or source this pass
      // just dropped; restoring it would let Undo resurrect the very document
      // that was just excluded for having no bytes behind it. Discarding
      // history here is the same trade-off `closeDocument` already makes for
      // the same reason.
      history: { undoStack: [], redoStack: [], undoLog: [], redoLog: [] }
    }
  };
}

/** Replaces the live workspace wholesale with a previously saved one. */
export function restoreSession(record: SessionRecord): void {
  // `baseline` (added after this record format existed) can be missing from a
  // record saved by an older build — IndexedDB has no schema to migrate that
  // against, so it's backfilled here, the one place a saved record becomes
  // live state. Falling back to the document's own `pages` is the same
  // "baseline starts as whatever's there" rule a freshly opened document
  // gets; it just means edits from the session that crashed aren't visible
  // in the very next review, which is the honest answer when there is no
  // real baseline to recover.
  batch(() => {
    documents.value = record.documents.map(doc => ({
      ...doc,
      baseline: doc.baseline ?? doc.pages
    }));
    sources.value = record.sources;
    activeDocId.value = record.activeDocId;
    selectedPageKeys.value = new Set(record.selection);
    cropBoxes.value = record.cropBoxes;
    pageAnnotations.value = record.pageAnnotations;
  });
  restoreHistoryFromRecord(record.history);
}

/**
 * DOC-11 — the startup recovery flow `AppShell` runs once on mount, before the
 * autosave watcher is allowed to run (reading the record and arming autosave
 * in the same tick would let the first, empty, pre-restore autosave overwrite
 * it before the prompt resolves).
 *
 * `confirm` shows the "Restore your previous session?" prompt for a validated
 * record and resolves true for Restore.
 *
 *  • RT-23 — whatever happens, this ends with `sessionRecoveryChecked` true:
 *    it gates autosave for the whole session and (RT-14) every import entry
 *    point. An exception from a malformed or hand-edited record used to leave
 *    it false forever — silently disabling both — as an unhandled rejection.
 *    A record that throws is cleared rather than failing again next launch.
 *  • RT-14 — `sessionRecoveryPrompting` is true while the prompt is showing,
 *    so imports refuse instead of opening a file that Restore would discard.
 *  • RT-4 — once the decision is made, every stored source outside the
 *    (restored or empty) workspace is swept from OPFS, before imports are
 *    allowed so nothing new can be caught by it, and only when no other
 *    Stapler tab is alive (OPFS is shared per origin).
 */
export async function runStartupRecovery(
  confirm: (check: RecoveryCheck) => Promise<boolean>
): Promise<void> {
  try {
    const pending = await loadPendingRecovery();
    // Confirms the record's sources still have bytes behind them before it is
    // ever offered — see `checkRecovery`.
    const checked = pending ? await checkRecovery(pending) : null;
    if (checked) {
      sessionRecoveryPrompting.value = true;
      let restore: boolean;
      try {
        restore = await confirm(checked);
      } finally {
        sessionRecoveryPrompting.value = false;
      }
      if (restore) {
        restoreSession(checked.record);
      } else {
        await clearSession();
      }
    } else if (pending) {
      // Every document in the record was unrecoverable — nothing to offer,
      // and no stale pointer worth keeping around for next time either.
      await clearSession();
    }
  } catch (err) {
    logEvent('warn', 'session-recovery', `Recovery check failed: ${String(err)}`);
    await clearSession().catch(() => {});
  }
  try {
    await sweepOrphanedSourceBytesIfSoleTab(id => id in sources.value || isSourcePending(id));
  } catch (err) {
    logEvent('warn', 'opfs', `Sweep failed: ${String(err)}`);
  } finally {
    sessionRecoveryChecked.value = true;
  }
}
