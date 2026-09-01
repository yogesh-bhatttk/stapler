/**
 * PLAN §5.5 — the mandatory-preview gate, as real state rather than a label.
 *
 * OCR-03's table export gates its own buttons because it owns them: the panel
 * renders three disabled Export buttons until a preview exists. CNV-08 saves
 * through the *action bar's* single primary CTA (DESIGN-ADAPTATION §4.2), which
 * the panel does not own — so a tool needs a way to say "not yet, and here is
 * why" to a button in another component.
 *
 * This lives in `ui/` rather than in `core/tools.ts` on purpose: whether a
 * preview has been produced is UI state, and `core/` must not reach into a
 * panel's signals to find out.
 *
 * The gate is advisory to the button and mandatory in the handler: `ActionBar`
 * disables the CTA, and the tool's own commit handler in `commit.ts` refuses
 * again if it is somehow reached anyway. A disabled button is a courtesy; the
 * handler's check is the guarantee.
 */
import { signal } from '@preact/signals';
import type { ToolId } from '../../core/tools';

/** Tool id → why its commit is blocked. Absent means "nothing is blocking it". */
const gates = signal<Partial<Record<ToolId, string>>>({});

/** Blocks the tool's commit with `reason`, or clears the block when null. */
export function setCommitGate(tool: ToolId, reason: string | null): void {
  const current = gates.value;
  if (reason === null) {
    if (current[tool] === undefined) return;
    const next = { ...current };
    delete next[tool];
    gates.value = next;
    return;
  }
  if (current[tool] === reason) return;
  gates.value = { ...current, [tool]: reason };
}

/** Why this tool's commit is blocked, or null. Reads the signal, so it tracks. */
export function commitGate(tool: ToolId): string | null {
  return gates.value[tool] ?? null;
}
