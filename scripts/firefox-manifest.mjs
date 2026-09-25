/**
 * DIST-04 — pure transform from the Chrome/Edge manifest to the Firefox-compatible
 * variant, factored out of `vite.config.ts` so it has a unit test instead of only
 * being exercised by a full build.
 *
 * Firefox's MV3 support differs from Chrome/Edge's in the ways that matter here:
 *
 * 1. AMO requires an explicit add-on ID (`browser_specific_settings.gecko.id`) and a
 *    minimum Firefox version. Chrome's manifest carries its own floor as
 *    `minimum_chrome_version`, a Chrome-only key Firefox warns about, so it is
 *    dropped here.
 * 2. Firefox does not run an MV3 background as `background.service_worker` — it uses
 *    the classic non-persistent event-page shape, `background.scripts` (+
 *    `type: "module"`). The compiled file is identical either way (`background.js`);
 *    only the manifest key pointing at it differs. The minimum version is not
 *    MV3's own 109.0, nor the 112.0 `background.type: "module"` needs: it is
 *    the newest unguarded built-in the bundled pdf.js calls
 *    (`Map.prototype.getOrInsertComputed`, Firefox 144). Below that Firefox
 *    installs the add-on and then fails to open any PDF (audit 2026-09-25
 *    PLT-9). The number and its evidence live in `browser-floors.mjs`.
 * 3. AMO rejects submission outright without `gecko.data_collection_permissions`
 *    (mandatory since Nov 2025). Stapler collects nothing — zero telemetry, zero
 *    accounts, the whole point of the zero-network invariant — so the only honest
 *    value is `{ required: ['none'] }`.
 *
 * Every other field — host_permissions, CSP, icons — is untouched, so
 * Chrome/Edge and Firefox cannot silently drift apart from hand-maintaining two
 * manifests.
 */

import { GECKO_STRICT_MIN_VERSION } from './browser-floors.mjs';

/** @param {Record<string, unknown>} manifest */
export function transformManifestForFirefox(manifest) {
  const { minimum_chrome_version: _chromeOnly, ...shared } = manifest;
  return {
    ...shared,
    background: { scripts: ['background.js'], type: 'module' },
    browser_specific_settings: {
      gecko: {
        id: 'stapler-offline-pdf@stapler.app',
        strict_min_version: GECKO_STRICT_MIN_VERSION,
        data_collection_permissions: { required: ['none'] }
      }
    }
  };
}
