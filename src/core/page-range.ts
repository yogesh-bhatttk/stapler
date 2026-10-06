/**
 * X-7 (AUDIT-2026-10-01, pattern 5) — the one parser for a user-typed,
 * 1-based page list such as "all" or "1-3, 6".
 *
 * The watermark/header-footer preview and the export worker each had their
 * own: for the range " " the preview marked every page and the export none,
 * so what was shown was not what was saved. Both now call this, and the panel
 * warns when a non-empty range selects nothing ({@link rangeSelectsNothing})
 * instead of exporting an untouched document without a word.
 *
 * Rules:
 *  • empty, whitespace-only, or "all" (any case) → every page (`null`);
 *  • parts separated by commas or semicolons; each is a page ("4") or an
 *    inclusive range ("2-5", "5-2", with a hyphen, en dash, em dash or minus
 *    sign — what a word processor turns a typed hyphen into);
 *  • pages are clamped to the document; 0, junk, and pages past the end
 *    select nothing (never "every page": an invalid list must not silently
 *    stamp the whole document).
 */

const PART = /^(\d+)(?:\s*[-‐‑‒–—−]\s*(\d+))?$/;

/** Whether `value` means "every page". */
export function isAllPages(value: string | undefined | null): boolean {
  if (value === undefined || value === null) return true;
  const trimmed = value.trim().toLowerCase();
  return trimmed === '' || trimmed === 'all';
}

/**
 * The 0-based page indexes `value` selects in a `pageCount`-page document, or
 * `null` for every page.
 */
export function parsePageRange(
  value: string | undefined | null,
  pageCount: number
): Set<number> | null {
  if (isAllPages(value)) return null;
  const selected = new Set<number>();
  for (const part of (value as string).split(/[,;]/)) {
    const match = part.trim().match(PART);
    if (!match) continue;
    const from = Number(match[1]);
    const to = Number(match[2] ?? match[1]);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) continue;
    const last = Math.min(pageCount, Math.max(from, to));
    for (let page = Math.max(1, Math.min(from, to)); page <= last; page++) {
      selected.add(page - 1);
    }
  }
  return selected;
}

/** Whether a 1-based range string covers `pageIndex` (0-based) of a `pageCount`-page document. */
export function pageIndexInRange(
  value: string | undefined | null,
  pageIndex: number,
  pageCount: number = pageIndex + 1
): boolean {
  const selected = parsePageRange(value, Math.max(pageCount, pageIndex + 1));
  return selected === null || selected.has(pageIndex);
}

/** True when `value` is a real (non-"all") range that selects no page of the document. */
export function rangeSelectsNothing(value: string | undefined | null, pageCount: number): boolean {
  const selected = parsePageRange(value, pageCount);
  return selected !== null && selected.size === 0;
}
