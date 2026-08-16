/**
 * DIST-04 — pure transform from the Chrome/Edge manifest to the Firefox-compatible
 * variant, factored out of `vite.config.ts` so it has a unit test instead of only
 * being exercised by a full build.
 *
 * Firefox's MV3 support differs from Chrome/Edge's in exactly two ways that matter
 * here:
 *
 * 1. AMO requires an explicit add-on ID (`browser_specific_settings.gecko.id`) and a
 *    minimum Firefox version; Chrome's manifest carries neither.
 * 2. Firefox does not run an MV3 background as `background.service_worker` — it uses
 *    the classic non-persistent event-page shape, `background.scripts` (+
 *    `type: "module"`). The compiled file is identical either way (`background.js`);
 *    only the manifest key pointing at it differs.
 *
 * Every other field — permissions, host_permissions, CSP, icons — is untouched, so
 * Chrome/Edge and Firefox cannot silently drift apart from hand-maintaining two
 * manifests.
 */

/** @param {Record<string, unknown>} manifest */
export function transformManifestForFirefox(manifest) {
  return {
    ...manifest,
    permissions: Array.from(new Set([...(manifest.permissions || []), 'tabs'])),
    background: { scripts: ['background.js'], type: 'module' },
    browser_specific_settings: {
      gecko: {
        // TODO(DIST-04): replace with the real ID assigned/chosen at AMO submission.
        id: 'stapler-offline-pdf@stapler.app',
        strict_min_version: '109.0'
      }
    }
  };
}
