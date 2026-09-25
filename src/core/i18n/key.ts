/**
 * Marks a string as a translation key without translating it.
 *
 * Tables of labels that are defined once at module load (the tool registry,
 * option lists, limitation lists) cannot call `translate()` there — the
 * locale can change after the module is evaluated, and a string translated at
 * load time would stay in the old language. They store the English key
 * instead and translate at render time (`t(tool.title)`).
 *
 * The identity function exists so that `tests/unit/i18n-coverage.test.ts`
 * — which statically extracts every literal passed to `t()`, `translate()`,
 * `tPlural()` and `tKey()` — also finds keys that only reach `t()` through a
 * variable, and fails when one of them is missing from a locale file.
 *
 * Deliberately import-free, so worker-side modules can use it.
 */
export function tKey<T extends string>(key: T): T {
  return key;
}
