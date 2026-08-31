/**
 * DIST-04 — pure transform from the Chrome/Edge manifest to the Firefox-compatible
 * variant, factored out of `vite.config.ts` so it has a unit test instead of only
 * being exercised by a full build.
 *
 * Firefox's MV3 support differs from Chrome/Edge's in the ways that matter here:
 *
 * 1. AMO requires an explicit add-on ID (`browser_specific_settings.gecko.id`) and a
 *    minimum Firefox version; Chrome's manifest carries neither.
 * 2. Firefox does not run an MV3 background as `background.service_worker` — it uses
 *    the classic non-persistent event-page shape, `background.scripts` (+
 *    `type: "module"`). The compiled file is identical either way (`background.js`);
 *    only the manifest key pointing at it differs. `background.type: "module"` is
 *    itself only recognized from Firefox 112 onward (AMO's own validator flags this
 *    as a warning, not an error, but below 112 Firefox does not know to load
 *    `background.js` as an ES module at all — since the compiled file uses
 *    `import`/`export`, that is a parse failure, not a degraded feature). Hence
 *    `strict_min_version: '112.0'`, not the '109.0' floor MV3 support alone would
 *    allow — 109 was AMO's validator producing a real bug, not just noise.
 * 3. AMO rejects submission outright without `gecko.data_collection_permissions`
 *    (mandatory since Nov 2025). Stapler collects nothing — zero telemetry, zero
 *    accounts, the whole point of the zero-network invariant — so the only honest
 *    value is `{ required: ['none'] }`.
 *
 * Every other field — host_permissions, CSP, icons — is untouched, so
 * Chrome/Edge and Firefox cannot silently drift apart from hand-maintaining two
 * manifests.
 */

/** @param {Record<string, unknown>} manifest */
export function transformManifestForFirefox(manifest) {
  return {
    ...manifest,
    background: { scripts: ['background.js'], type: 'module' },
    browser_specific_settings: {
      gecko: {
        id: 'stapler-offline-pdf@stapler.app',
        strict_min_version: '112.0',
        data_collection_permissions: { required: ['none'] }
      }
    }
  };
}
