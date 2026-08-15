/**
 * BAT-03 — Templated batch output filenames.
 *
 * Supported tokens:
 *   {basename}  — original filename without extension
 *   {index}     — 1-based position of the file in the batch run (zero-padded to
 *                 match the total count width)
 *   {date}      — ISO-8601 date at run start (YYYY-MM-DD)
 */

/**
 * Apply a filename pattern to produce a concrete output name.
 *
 * @param pattern  e.g. "{basename}-{date}-{index}"
 * @param basename original filename without the `.pdf` extension
 * @param index    1-based index within the batch run
 * @param total    total number of files in the run (used for zero-padding)
 * @param date     run-start date (defaults to today)
 * @returns        resolved filename, WITHOUT a `.pdf` extension
 */
export function applyFilenamePattern(
  pattern: string,
  basename: string,
  index: number,
  total: number,
  date: Date = new Date()
): string {
  const padWidth = String(total).length;
  const paddedIndex = String(index).padStart(padWidth, '0');
  const dateStr = date.toISOString().slice(0, 10); // YYYY-MM-DD

  return pattern
    .replace(/\{basename\}/g, basename)
    .replace(/\{index\}/g, paddedIndex)
    .replace(/\{date\}/g, dateStr);
}

/**
 * Strip the `.pdf` extension (case-insensitive) from a filename.
 */
export function stripPdfExtension(name: string): string {
  return name.replace(/\.pdf$/i, '');
}

/**
 * Given an array of raw output names (without extensions), resolve collisions
 * by appending ` (2)`, ` (3)`, etc. Returns a new array of the same length
 * with guaranteed-unique names.
 */
export function deduplicateNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map(name => {
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    if (count === 1) return name;
    // Collision — find the next free suffix
    let suffix = count;
    while (seen.has(`${name} (${suffix})`)) suffix++;
    const resolved = `${name} (${suffix})`;
    seen.set(resolved, 1);
    return resolved;
  });
}
