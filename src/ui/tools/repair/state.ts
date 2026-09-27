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
