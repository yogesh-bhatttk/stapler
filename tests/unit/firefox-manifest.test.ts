import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { transformManifestForFirefox } from '../../scripts/firefox-manifest.mjs';

/**
 * DIST-04 — the Firefox variant must keep every hard invariant the Chrome/Edge
 * manifest already has (zero permissions, no content scripts, same CSP/icons) and
 * only change the two fields Firefox's MV3 support actually differs on.
 */
describe('transformManifestForFirefox', () => {
  const chromeManifest = JSON.parse(
    readFileSync(path.resolve(process.cwd(), 'public/manifest.json'), 'utf8')
  ) as Record<string, unknown>;

  test('swaps the service worker for a background script, unchanged file', () => {
    const firefox = transformManifestForFirefox(chromeManifest);
    expect(firefox.background).toEqual({ scripts: ['background.js'], type: 'module' });
  });

  test('adds a gecko ID and minimum version AMO requires', () => {
    const firefox = transformManifestForFirefox(chromeManifest);
    const gecko = (firefox.browser_specific_settings as { gecko: Record<string, string> }).gecko;
    expect(gecko.id).toMatch(/@/);
    // 112.0, not MV3's own 109.0 floor: background.type: "module" (below) is only
    // recognized from Firefox 112 onward, and AMO's validator flags 109 here as a
    // real bug, not noise — below 112, Firefox does not know to load background.js
    // as an ES module, which is a parse failure given the compiled file uses
    // import/export.
    expect(gecko.strict_min_version).toBe('112.0');
  });

  test('declares zero data collection, as AMO now requires', () => {
    const firefox = transformManifestForFirefox(chromeManifest);
    const gecko = (
      firefox.browser_specific_settings as {
        gecko: { data_collection_permissions: { required: string[] } };
      }
    ).gecko;
    expect(gecko.data_collection_permissions).toEqual({ required: ['none'] });
  });

  test('leaves host_permissions/content_scripts intact and does not add tabs', () => {
    const firefox = transformManifestForFirefox(chromeManifest);
    expect(firefox.permissions).toEqual([]);
    expect(firefox.host_permissions).toEqual(chromeManifest.host_permissions);
    expect(firefox.content_scripts).toBeUndefined();
  });

  test('leaves CSP, icons, and manifest_version identical to Chrome/Edge', () => {
    const firefox = transformManifestForFirefox(chromeManifest);
    expect(firefox.content_security_policy).toEqual(chromeManifest.content_security_policy);
    expect(firefox.icons).toEqual(chromeManifest.icons);
    expect(firefox.manifest_version).toBe(3);
  });
});
