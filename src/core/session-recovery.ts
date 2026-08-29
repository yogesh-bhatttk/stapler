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
import { signal } from '@preact/signals';
import { documents, sources, activeDocId, selectedPageKeys } from './store';
import type { StaplerDoc, SourceDocument } from './store';
import { cropBoxes } from '../ui/tools/crop/state';
import type { CropBox } from '../ui/tools/crop/state';
import { pageAnnotations } from '../ui/tools/annotate/state';
import type { Annotation } from '../ui/tools/annotate/state';
import { serializeHistory, restoreHistoryFromRecord, type SerializedHistory } from './history';
import { readSetting, writeSetting } from './db';
import { logEvent } from './errors';
import { sourceBytesExist } from './opfs';

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

export async function loadPendingRecovery(): Promise<SessionRecord | null> {
  const record = await readSetting<SessionRecord>(SESSION_KEY);
  return record && record.documents.length > 0 ? record : null;
}

export async function clearSession(): Promise<void> {
  await writeSetting(SESSION_KEY, null);
}

/**
 * Writes the current workspace as the recovery record, or clears it once
 * nothing is open — an empty record is not "a session to restore," and
 * leaving a stale one around would offer to restore nothing back to nothing.
 */
export async function saveSession(): Promise<void> {
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
  const existing = new Set<string>();
  await Promise.all(
    ids.map(async id => {
      if (await sourceBytesExist(id)) existing.add(id);
    })
  );
  if (existing.size === ids.length) return { record, droppedDocuments: 0 };

  // A document with even one page whose source is gone is dropped whole:
  // a document silently missing some of its pages is worse than one that
  // is not offered back at all.
  const survivingDocs = record.documents.filter(doc =>
    doc.pages.every(page => existing.has(page.sourceDocId))
  );
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
  documents.value = record.documents;
  sources.value = record.sources;
  activeDocId.value = record.activeDocId;
  selectedPageKeys.value = new Set(record.selection);
  cropBoxes.value = record.cropBoxes;
  pageAnnotations.value = record.pageAnnotations;
  restoreHistoryFromRecord(record.history);
}
