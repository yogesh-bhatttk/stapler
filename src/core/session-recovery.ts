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
import {
  normalizeSerializedHistory,
  restoreHistoryFromRecord,
  serializeHistory,
  type SerializedDocHistory,
  type SerializedHistory
} from './history';
import { readSettingResult, writeSetting } from './db';
import { logEvent } from './errors';
import { announceTab, sourceBytesExist, sweepOrphanedSourceBytesIfSoleTab } from './opfs';
import { notify } from './notify';
import { translate } from './i18n';
import { noteSessionSaved } from './storage-persistence';
import { MAX_OPEN_DOCUMENTS } from './workspace-limits';

const SESSION_KEY = 'session.recovery';
const SAVE_DEBOUNCE_MS = 500;

export interface SessionRecord {
  documents: StaplerDoc[];
  sources: Record<string, SourceDocument>;
  activeDocId: string | null;
  selection: string[];
  cropBoxes: Record<string, CropBox>;
  pageAnnotations: Record<string, Annotation[]>;
  /**
   * Per-document undo/redo (GAP-11a). A record saved by an older build holds
   * the previous global format here instead; it is dropped on restore (the
   * documents themselves are restored with empty undo) — see
   * `normalizeSerializedHistory`. Typed wide on purpose: it is read from
   * storage, not trusted.
   */
  history: unknown;
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

/** Thrown when storage could not be read, as opposed to "there is no record". */
export class RecoveryStorageUnavailable extends Error {
  constructor() {
    super('Session storage could not be read');
    this.name = 'RecoveryStorageUnavailable';
  }
}

export async function loadPendingRecovery(): Promise<SessionRecord | null> {
  const { ok, value: record } = await readSettingResult<SessionRecord>(SESSION_KEY);
  if (!ok) throw new RecoveryStorageUnavailable();
  return record && record.documents.length > 0 ? record : null;
}

/**
 * Set when the recovery record could not be read at startup. The saved
 * session may still be there, so nothing may overwrite or clear it this
 * session — autosave stays off (regression review R-RT-4).
 */
let autosaveSuspended = false;

/** Whether autosave was turned off because the saved session could not be read. */
export function isAutosaveSuspended(): boolean {
  return autosaveSuspended;
}

/**
 * GAP-12 — "Clear all local data" turns autosave off for the rest of this page's
 * life (the page reloads straight after), so a debounced save cannot write the
 * session record back after it was cleared.
 */
export function suspendAutosave(): void {
  autosaveSuspended = true;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
}

/** Test hook: clear the suspension a previous startup set. */
export function __resetAutosaveSuspendedForTests(): void {
  autosaveSuspended = false;
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
  if (autosaveSuspended) return;
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
    // GAP-9 — the first saved session is what makes persistence worth asking for.
    if ((await writeSetting(SESSION_KEY, record)) !== false) noteSessionSaved();
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
  /**
   * Documents dropped: their source bytes no longer exist, or (RT-6) they
   * were past the open-document ceiling — {@link RecoveryCheck.droppedOverLimit}
   * of them.
   */
  droppedDocuments: number;
  /** How many of `droppedDocuments` were dropped only for the document ceiling. */
  droppedOverLimit: number;
}

/**
 * AUDIT-2026-10-01 RT-6 — at most `MAX_OPEN_DOCUMENTS` of `docs`, in their
 * saved order, always keeping the active one. A record saved before the
 * ceiling existed (or by a build with a higher one) used to restore whole,
 * putting the workspace past the limit every other open path enforces.
 */
function withinDocumentCap(docs: StaplerDoc[], activeId: string | null): StaplerDoc[] {
  if (docs.length <= MAX_OPEN_DOCUMENTS) return docs;
  const kept = docs.slice(0, MAX_OPEN_DOCUMENTS);
  const active = docs.find(d => d.id === activeId);
  if (active && !kept.includes(active)) kept[kept.length - 1] = active;
  return kept;
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
  // point at listed ids. Every page reference — live documents and every
  // undo/redo snapshot, `pages` and `baseline` — is checked now.
  //
  // GAP-11a — history is per document, so an unusable history costs only its
  // own document's undo, not every document's: a document whose live state is
  // fine but whose history reaches a missing source is restored with empty
  // undo. A history in the pre-GAP-11 global format normalises to empty.
  const history = normalizeSerializedHistory(record.history);
  const historyUsable = (entry: SerializedDocHistory) =>
    [...entry.undoStack, ...entry.redoStack].every(state => docUsable(state.doc));
  const usableHistory: SerializedHistory = { version: 2, docs: {} };
  for (const [docId, entry] of Object.entries(history.docs)) {
    if (historyUsable(entry)) usableHistory.docs[docId] = entry;
  }
  const allHistoryKept =
    Object.keys(usableHistory.docs).length === Object.keys(history.docs).length;
  if (
    existing.size === ids.length &&
    allHistoryKept &&
    record.documents.length <= MAX_OPEN_DOCUMENTS &&
    record.documents.every(docUsable)
  ) {
    return {
      record: { ...record, history: usableHistory },
      droppedDocuments: 0,
      droppedOverLimit: 0
    };
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
  const usableDocs = record.documents.filter(docUsable);
  if (usableDocs.length === 0) return null;
  const survivingDocs = withinDocumentCap(usableDocs, record.activeDocId);
  const droppedOverLimit = usableDocs.length - survivingDocs.length;
  const droppedDocuments = record.documents.length - survivingDocs.length;

  let survivingSources: Record<string, SourceDocument> = {};
  for (const id of ids) {
    if (existing.has(id)) survivingSources[id] = record.sources[id];
  }
  if (droppedOverLimit > 0) {
    // A source only a document dropped for the ceiling used is not registered:
    // nothing could ever close it, and the startup sweep then frees its bytes.
    const referenced = new Set<string>();
    const note = (doc: StaplerDoc) => {
      for (const page of [...doc.pages, ...(doc.baseline ?? [])]) referenced.add(page.sourceDocId);
    };
    survivingDocs.forEach(note);
    for (const doc of survivingDocs) {
      const entry = usableHistory.docs[doc.id];
      if (!entry) continue;
      for (const state of [...entry.undoStack, ...entry.redoStack]) note(state.doc);
    }
    survivingSources = Object.fromEntries(
      Object.entries(survivingSources).filter(([id]) => referenced.has(id))
    );
  }

  return {
    droppedDocuments,
    droppedOverLimit,
    record: {
      ...record,
      documents: survivingDocs,
      sources: survivingSources,
      activeDocId: survivingDocs.some(d => d.id === record.activeDocId)
        ? record.activeDocId
        : survivingDocs[0].id,
      selection: [],
      // Only the surviving documents' histories, and only those whose every
      // snapshot still has bytes behind it: a saved undo entry must not be
      // able to resurrect a page this pass just found unreadable.
      history: {
        version: 2,
        docs: Object.fromEntries(
          Object.entries(usableHistory.docs).filter(([docId]) =>
            survivingDocs.some(d => d.id === docId)
          )
        )
      } satisfies SerializedHistory
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
  // RT-6 — the backstop for a record that did not come through
  // `checkRecovery` (which trims and reports): never past the ceiling.
  const docs = withinDocumentCap(record.documents, record.activeDocId);
  batch(() => {
    documents.value = docs.map(doc => ({
      ...doc,
      baseline: doc.baseline ?? doc.pages
    }));
    sources.value = record.sources;
    // `withinDocumentCap` always keeps the active document.
    activeDocId.value = record.activeDocId;
    selectedPageKeys.value = new Set(record.selection);
    cropBoxes.value = record.cropBoxes;
    pageAnnotations.value = record.pageAnnotations;
  });
  restoreHistoryFromRecord(
    record.history,
    docs.map(doc => doc.id)
  );
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
  // Announce this tab before anything else, so a tab that starts meanwhile —
  // or is already sitting on its own restore prompt — can see it and won't
  // sweep bytes this one is about to restore (regression review R-RT-2).
  await announceTab();
  let storageReadable = true;
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
        // Re-checked after the prompt: the user may have taken a while, and
        // bytes can disappear meanwhile (another tab, the browser evicting
        // storage). Restoring a record with missing bytes gives blank pages.
        const still = pending ? await checkRecovery(pending) : null;
        if (still) restoreSession(still.record);
        else {
          notify('warning', translate('The previous session could not be restored.'), {
            detail: translate('Its files are no longer in browser storage.')
          });
          await clearSession();
        }
      } else {
        await clearSession();
      }
    } else if (pending) {
      // Every document in the record was unrecoverable — nothing to offer,
      // and no stale pointer worth keeping around for next time either.
      await clearSession();
    }
  } catch (err) {
    if (err instanceof RecoveryStorageUnavailable) {
      // Storage did not answer (e.g. a slow or blocked IndexedDB open). The
      // saved session may well exist: never clear it, never sweep its bytes,
      // never let autosave overwrite it this session (R-RT-4).
      storageReadable = false;
      autosaveSuspended = true;
      logEvent('warn', 'session-recovery', 'Recovery record unreadable; autosave suspended');
    } else {
      logEvent('warn', 'session-recovery', `Recovery check failed: ${String(err)}`);
      await clearSession().catch(() => {});
    }
  }
  try {
    if (storageReadable) {
      await sweepOrphanedSourceBytesIfSoleTab(id => id in sources.value || isSourcePending(id));
    }
  } catch (err) {
    logEvent('warn', 'opfs', `Sweep failed: ${String(err)}`);
  } finally {
    sessionRecoveryChecked.value = true;
  }
}
