/**
 * GAP-6 — Repair tool state.
 *
 * Deliberately *not* reset on document change: the file to repair is usually
 * one Stapler refused to open, which never became a document at all, and the
 * "Try to repair" action on a failed import sets it from outside this tool.
 */
import { signal } from '@preact/signals';
import type { RepairResult } from '../../../core/operations';
import { translate } from '../../../core/i18n';
import { toolRoute } from '../../../core/tools';
import {
  addDocument,
  makePageRefs,
  releaseSourceIfUnused,
  workspaceOpenCapacity,
  type SourceDocument
} from '../../../core/store';

/** A file picked in the panel, or handed over by a refused import. */
export const repairCandidate = signal<File | null>(null);

export interface RepairRun {
  /** The name the repaired copy is saved and opened under. */
  name: string;
  result: RepairResult;
}

/** The last repair — its report, and the verified bytes behind "Open the repaired copy". */
export const lastRepair = signal<RepairRun | null>(null);

/** Called by the import path when a file is refused as damaged. */
export function offerRepair(file: File): void {
  repairCandidate.value = file;
  lastRepair.value = null;
}

/**
 * AUDIT-2026-10-01 UI-9 — forgets the chosen file, so Repair targets the open
 * document again. A file picked (or handed over by a refused import) used to
 * stay the target of every later repair for the rest of the session.
 */
export function clearRepairCandidate(): void {
  repairCandidate.value = null;
  lastRepair.value = null;
}

/** True while "Open the repaired copy" is registering the copy. */
export const openingRepaired = signal(false);

export type OpenRepairedOutcome = 'opened' | 'busy' | 'full';

/**
 * AUDIT-2026-10-01 RT-2 — opens a repaired copy as a new document.
 *
 *  • `'full'` at the document ceiling: checked before anything is written,
 *    and again by `addDocument` itself (another open can take the last slot
 *    while the copy registers) — in which case the just-registered source is
 *    released rather than left orphaned in OPFS. This used to ignore
 *    `addDocument`'s `false` and report success with no tab.
 *  • `'busy'` while a previous call is still running, so a double-click opens
 *    one copy, not two. The flag is a signal set synchronously, before the
 *    first `await`, so the second click always sees it.
 *
 * `register` is `import.ts`'s `registerSourceFromBytes`, passed in so this
 * module stays free of the render worker.
 */
export async function openRepairedCopy(
  run: RepairRun,
  register: (bytes: Uint8Array, name: string) => Promise<SourceDocument>
): Promise<OpenRepairedOutcome> {
  if (openingRepaired.value) return 'busy';
  if (!workspaceOpenCapacity(1).ok) return 'full';
  openingRepaired.value = true;
  try {
    const source = await register(run.result.bytes, run.name);
    const added = addDocument({
      id: crypto.randomUUID(),
      name: run.name,
      pages: makePageRefs(source.id, source.pageCount),
      annotations: [],
      dirty: false
    });
    if (!added) {
      releaseSourceIfUnused(source.id);
      return 'full';
    }
    return 'opened';
  } finally {
    openingRepaired.value = false;
  }
}

/** `contract.pdf` → `contract-repaired.pdf`. */
export function repairedName(name: string): string {
  return `${name.replace(/\.pdf$/i, '')}-repaired.pdf`;
}

/**
 * The toast action a refused import carries: hands the file to Repair and
 * opens it. Hash routing, so it works from anywhere — a toast has no router.
 */
export function tryToRepairAction(file: File): { label: string; run: () => void } {
  return {
    label: translate('Try to repair'),
    run: () => {
      offerRepair(file);
      window.location.hash = `#${toolRoute('repair')}`;
    }
  };
}
