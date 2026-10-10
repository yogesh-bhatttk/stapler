/**
 * The batch summary, grouped by what happened to each file. Every note used to
 * be listed under "Files written unchanged" — including files that *were*
 * changed (a rebuild's `changed` notices), had their metadata removed, or were
 * saved under a new name — which told the user the opposite of the truth
 * (AUDIT-2026-10-10 follow-up). Each kind now has its own heading.
 */
import { tKey } from '../../../core/i18n';
import type { BatchNote } from './state';

type NoteKind = BatchNote['kind'];

/** Headings (translation keys), in display order: problems first. */
const GROUPS: ReadonlyArray<{ kind: NoteKind; heading: string }> = [
  { kind: 'failed', heading: tKey('Files that could not be processed') },
  { kind: 'kept-original', heading: tKey('Files written unchanged') },
  { kind: 'changed', heading: tKey('Files changed or left incomplete — check these') },
  { kind: 'metadata-scrubbed', heading: tKey('Files with metadata removed') },
  { kind: 'renamed', heading: tKey('Files saved under a new name') }
];

export interface BatchNoteGroup {
  kind: NoteKind;
  /** An English key; translate at render time. */
  heading: string;
  notes: BatchNote[];
}

/** The non-empty groups, in display order, each keeping its notes' order. */
export function groupBatchNotes(notes: readonly BatchNote[]): BatchNoteGroup[] {
  return GROUPS.map(({ kind, heading }) => ({
    kind,
    heading,
    notes: notes.filter(note => note.kind === kind)
  })).filter(group => group.notes.length > 0);
}
