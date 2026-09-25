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
  // Widened to a plain record: the manifest is open-ended JSON, and the tests below
  // probe keys (permissions, icons, CSP) the transform only passes through.
  const firefoxOf = (m: Record<string, unknown>): Record<string, unknown> =>
    transformManifestForFirefox(m);

  test('swaps the service worker for a background script, unchanged file', () => {
    const firefox = firefoxOf(chromeManifest);
    expect(firefox.background).toEqual({ scripts: ['background.js'], type: 'module' });
  });

  test('adds a gecko ID and minimum version AMO requires', () => {
    const firefox = firefoxOf(chromeManifest);
    const gecko = (firefox.browser_specific_settings as { gecko: Record<string, string> }).gecko;
    expect(gecko.id).toMatch(/@/);
    // Audit 2026-09-25 PLT-9: not MV3's 109.0 nor the 112.0 that
    // `background.type: "module"` needs — the bundled pdf.js calls
    // `Map.prototype.getOrInsertComputed` unguarded (Firefox 144).
    // browser-floors.test.ts ties this to the evidence table.
    expect(gecko.strict_min_version).toBe('144.0');
  });

  test('declares zero data collection, as AMO now requires', () => {
    const firefox = firefoxOf(chromeManifest);
    const gecko = (
      firefox.browser_specific_settings as {
        gecko: { data_collection_permissions: { required: string[] } };
      }
    ).gecko;
    expect(gecko.data_collection_permissions).toEqual({ required: ['none'] });
  });

  test('leaves host_permissions/content_scripts intact and does not add tabs', () => {
    const firefox = firefoxOf(chromeManifest);
    expect(firefox.permissions).toEqual([]);
    expect(firefox.host_permissions).toEqual(chromeManifest.host_permissions);
    expect(firefox.content_scripts).toBeUndefined();
  });

  test('drops the Chrome-only minimum_chrome_version key', () => {
    expect(chromeManifest.minimum_chrome_version).toBeDefined();
    expect(firefoxOf(chromeManifest)).not.toHaveProperty('minimum_chrome_version');
  });

  test('leaves CSP, icons, and manifest_version identical to Chrome/Edge', () => {
    const firefox = firefoxOf(chromeManifest);
    expect(firefox.content_security_policy).toEqual(chromeManifest.content_security_policy);
    expect(firefox.icons).toEqual(chromeManifest.icons);
    expect(firefox.manifest_version).toBe(3);
  });
});
