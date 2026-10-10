/**
 * Zero permissions, as a property of a manifest (CLAUDE.md invariant #2) —
 * audit 2026-10-10 (CI/Release).
 *
 * One pure check shared by `scripts/check-invariants.mjs` (the source
 * `public/manifest.json` and any built `dist/ext` / `dist/firefox`),
 * `scripts/validate-builds.mjs` and `scripts/package.mjs`, so the three can
 * no longer disagree about what "zero permissions" means. Before this, the
 * built Firefox manifest was only parsed as JSON, `validate-builds` checked
 * `host_permissions` alone, and `package` did not look at
 * `optional_host_permissions`, `web_accessible_resources` or
 * `externally_connectable` at all.
 *
 * What it rejects:
 *  - a non-empty `permissions`, `optional_permissions`, `host_permissions`
 *    or `optional_host_permissions` (each one is either an install warning or
 *    a runtime prompt the product promises never to show);
 *  - `content_scripts`, `web_accessible_resources` or `externally_connectable`
 *    declared at all (each lets a web page reach into or run inside the
 *    extension; the architecture has none, PLAN §2.1);
 *  - a missing `content_security_policy.extension_pages`, or one looser than
 *    the `scripts/csp.mjs` allowlist (`cspFindings`).
 */
import { cspFindings } from './csp.mjs';

export const EMPTY_LIST_KEYS = [
  'permissions',
  'optional_permissions',
  'host_permissions',
  'optional_host_permissions'
];

export const FORBIDDEN_KEYS = [
  'content_scripts',
  'web_accessible_resources',
  'externally_connectable'
];

/**
 * Every invariant `manifest` breaks, as `"<label> — <problem>"` strings.
 * @param {Record<string, unknown>} manifest
 * @param {string} label
 * @returns {string[]}
 */
export function manifestFindings(manifest, label) {
  const out = [];
  for (const key of EMPTY_LIST_KEYS) {
    const value = manifest[key];
    if (value === undefined) continue;
    if (!Array.isArray(value)) out.push(`${label} — "${key}" is not an array`);
    else if (value.length > 0)
      out.push(
        `${label} — "${key}" is non-empty (${value.join(', ')}). Stapler ships with zero ` +
          `permissions so the install dialog shows no warning. See PLAN §5.4 item 3.`
      );
  }
  for (const key of FORBIDDEN_KEYS) {
    if (key in manifest)
      out.push(`${label} — "${key}" is declared; the architecture has none (PLAN §2.1)`);
  }
  const csp = /** @type {{ extension_pages?: unknown } | undefined} */ (
    manifest.content_security_policy
  )?.extension_pages;
  if (typeof csp !== 'string') {
    out.push(`${label} — content_security_policy.extension_pages is missing`);
  } else {
    for (const msg of cspFindings(csp)) out.push(`${label} — ${msg}`);
  }
  return out;
}
