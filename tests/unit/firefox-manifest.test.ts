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
    expect(gecko.strict_min_version).toBe('109.0');
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
