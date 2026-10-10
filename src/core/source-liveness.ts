/**
 * AUDIT-2026-10-10 L9 — whether a source is still registered, for code that
 * `store.ts` imports and so cannot import back (`render-cache.ts`). The store
 * installs the real check at load; until then — or with no store at all, as
 * in a unit test of the cache alone — every source counts as live.
 */
let check: (sourceId: string) => boolean = () => true;

export function setSourceLivenessCheck(next: (sourceId: string) => boolean): void {
  check = next;
}

export function isSourceRegistered(sourceId: string): boolean {
  return check(sourceId);
}
