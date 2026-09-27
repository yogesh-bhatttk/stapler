/**
 * AUDIT-2026-09-25 GAP-11b — how much the workspace will hold at once.
 *
 * Every open document costs memory even though its bytes live in OPFS: page
 * lists, thumbnails, a per-document undo history, render-worker parses. Past
 * a point the tab slows down and then the browser kills it — which loses
 * every unsaved edit in every document at once. So:
 *
 *  • a hard ceiling on open documents ({@link MAX_OPEN_DOCUMENTS}): an open
 *    that would pass it is refused up front, with a message saying to close
 *    some tabs, rather than half-applied;
 *  • a soft, memory-aware limit ({@link SOFT_WORKSPACE_BYTES}) on the summed
 *    size of the source files behind the workspace: passing it asks first,
 *    because a few very large files can hurt as much as many small ones.
 *
 * Pure on purpose (no store import), so `opfs.ts` can report sizes into it
 * without an import cycle, and the checks are unit-testable.
 */

/** The most documents that can be open at once. */
export const MAX_OPEN_DOCUMENTS = 20;

/** Above this summed source size (1.5 GiB), opening more asks for confirmation first. */
export const SOFT_WORKSPACE_BYTES = 1.5 * 1024 * 1024 * 1024;

/**
 * Byte length of every source whose size has been seen — on write, read, or
 * the existence probe session recovery runs. Keyed by source id.
 */
const sourceSizes = new Map<string, number>();

export function recordSourceSize(sourceId: string, byteLength: number): void {
  sourceSizes.set(sourceId, byteLength);
}

export function forgetSourceSize(sourceId: string): void {
  sourceSizes.delete(sourceId);
}

/** Summed size of the given sources; ones never measured count as 0. */
export function knownSourceBytes(sourceIds: Iterable<string>): number {
  let total = 0;
  for (const id of sourceIds) total += sourceSizes.get(id) ?? 0;
  return total;
}

export function __resetSourceSizesForTests(): void {
  sourceSizes.clear();
}

export type OpenCapacity =
  | { ok: true; overSoftLimit: false }
  /** Allowed, but the workspace would pass {@link SOFT_WORKSPACE_BYTES}. */
  | { ok: true; overSoftLimit: true; projectedBytes: number }
  /** Refused: the document count would pass {@link MAX_OPEN_DOCUMENTS}. */
  | { ok: false; openCount: number; max: number };

/**
 * Whether `incomingDocuments` more documents (of `incomingBytes` in total)
 * fit next to `openCount` documents whose sources sum to `currentBytes`.
 */
export function checkOpenCapacity(
  openCount: number,
  incomingDocuments: number,
  currentBytes: number,
  incomingBytes: number,
  max = MAX_OPEN_DOCUMENTS,
  softBytes = SOFT_WORKSPACE_BYTES
): OpenCapacity {
  if (incomingDocuments > 0 && openCount + incomingDocuments > max) {
    return { ok: false, openCount, max };
  }
  const projectedBytes = currentBytes + incomingBytes;
  if (incomingBytes > 0 && projectedBytes > softBytes) {
    return { ok: true, overSoftLimit: true, projectedBytes };
  }
  return { ok: true, overSoftLimit: false };
}

/** How many more documents can be opened next to `openCount`. */
export function remainingDocumentSlots(openCount: number, max = MAX_OPEN_DOCUMENTS): number {
  return Math.max(0, max - openCount);
}
