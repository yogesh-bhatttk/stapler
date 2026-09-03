/**
 * The spreadsheet column alphabet, in one place.
 *
 * `A`…`Z`, `AA`…`AZ`, `BA`… — bijective base-26, which is *not* ordinary base-26
 * (there is no zero digit, so `Z` is followed by `AA` and not by `BA`). Getting
 * that wrong is silent: the mistake only shows past column 26, in a cell
 * reference that names the wrong column or a band label that misdescribes it.
 *
 * It lived twice — once in `xlsx-writer.ts` as `getColRef`, to write a `<c r="…">`
 * reference, and once in `xlsx-reader.ts` as `columnName`/`cellAddress`, to look
 * a cell up and to label a column band. Two copies of the same off-by-one.
 */

/** `0` → `A`, `25` → `Z`, `26` → `AA`. */
export function columnRef(index: number): string {
  let rest = index;
  let name = '';
  do {
    name = String.fromCharCode(65 + (rest % 26)) + name;
    rest = Math.floor(rest / 26) - 1;
  } while (rest >= 0);
  return name;
}
