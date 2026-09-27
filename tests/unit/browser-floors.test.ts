import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  GECKO_STRICT_MIN_VERSION,
  MIN_CHROME_VERSION,
  MIN_FIREFOX_VERSION,
  REQUIRED_APIS
} from '../../scripts/browser-floors.mjs';
import { transformManifestForFirefox } from '../../scripts/firefox-manifest.mjs';

/**
 * Audit 2026-09-25 PLT-9 — the Chrome manifest had no `minimum_chrome_version`
 * and Firefox's floor (112) predated APIs pdf.js 6 calls unguarded, so stores
 * accepted installs whose rendering was dead on arrival. This ties the three
 * places a floor appears — the evidence table, `public/manifest.json`, and the
 * Firefox transform — to each other and to the pdf.js actually shipped.
 */
const read = (file: string) => readFileSync(path.resolve(process.cwd(), file), 'utf8');

describe('browser floors', () => {
  const manifest = JSON.parse(read('public/manifest.json')) as Record<string, unknown>;

  test('the floors are the newest version any required API needs', () => {
    expect(MIN_CHROME_VERSION).toBe(Math.max(...REQUIRED_APIS.map(a => a.chrome)));
    expect(MIN_FIREFOX_VERSION).toBe(Math.max(...REQUIRED_APIS.map(a => a.firefox)));
    // Guard against a table edit that silently lowers the floor below what the
    // audit verified for pdfjs-dist 6.2.108.
    expect(MIN_CHROME_VERSION).toBeGreaterThanOrEqual(147);
    expect(MIN_FIREFOX_VERSION).toBeGreaterThanOrEqual(144);
  });

  test('public/manifest.json declares the Chrome floor', () => {
    expect(manifest.minimum_chrome_version).toBe(String(MIN_CHROME_VERSION));
  });

  test('the Firefox build declares the Firefox floor', () => {
    const firefox = transformManifestForFirefox(manifest) as {
      browser_specific_settings: { gecko: { strict_min_version: string } };
    };
    expect(firefox.browser_specific_settings.gecko.strict_min_version).toBe(
      GECKO_STRICT_MIN_VERSION
    );
    expect(GECKO_STRICT_MIN_VERSION).toBe(`${MIN_FIREFOX_VERSION}.0`);
  });

  test('every pdf.js API in the table is still called by the shipped pdf.js', () => {
    // If a pdf.js upgrade drops one, the table (and maybe the floor) is stale.
    const shipped =
      read('node_modules/pdfjs-dist/build/pdf.mjs') +
      read('node_modules/pdfjs-dist/build/pdf.worker.mjs');
    for (const { api, needle } of REQUIRED_APIS) {
      if (!needle) continue;
      expect(shipped.includes(needle), api).toBe(true);
    }
  });

  test('the pinned pdf.js is the version the table was verified against', () => {
    // A new pdf.js may call something newer still; re-audit, then bump this.
    const pkg = JSON.parse(read('node_modules/pdfjs-dist/package.json')) as { version: string };
    expect(pkg.version).toBe('6.2.108');
  });
});
