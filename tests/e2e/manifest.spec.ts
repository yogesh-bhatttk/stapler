import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * F-02 — the manifest ships with nothing that would put a warning in Chrome's install
 * dialog. Asserted against the file rather than by eye, because a single added
 * permission is the difference between "no warnings" and a scary install prompt, and
 * that is the product's main differentiator (PLAN §1).
 */
test.describe('manifest', () => {
  const manifest = JSON.parse(
    readFileSync(path.resolve(process.cwd(), 'public/manifest.json'), 'utf8')
  );

  test('requests no permissions at all', () => {
    expect(manifest.permissions ?? []).toEqual([]);
    expect(manifest.optional_permissions ?? []).toEqual([]);
    expect(manifest.host_permissions ?? []).toEqual([]);
  });

  test('declares no content scripts and no web-accessible resources', () => {
    expect(manifest.content_scripts).toBeUndefined();
    expect(manifest.web_accessible_resources).toBeUndefined();
  });

  test('is Manifest V3 with a module service worker', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.background.service_worker).toBe('background.js');
    expect(manifest.background.type).toBe('module');
  });

  test('declares a minimum Chrome version at or above the pdf.js floor', () => {
    // Audit 2026-09-25 PLT-9: with no floor, the store accepted installs on a
    // Chrome whose pdf.js could not open a single PDF. The evidence and the
    // exact number live in scripts/browser-floors.mjs (unit-tested there).
    expect(Number(manifest.minimum_chrome_version)).toBeGreaterThanOrEqual(147);
  });

  test('has a default-deny CSP whose only remote source is the path-scoped pinned OCR model', () => {
    // Audit 2026-09-25 PLT-3: without `default-src`, image beacons, remote
    // styles and iframes were all allowed; and a bare `https://cdn.jsdelivr.net`
    // in connect-src allowed every npm package on that CDN. The OCR language
    // model (OCR-01) is the one documented network exception (CLAUDE.md
    // invariant #1), so the only remote sources allowed are its exact pinned
    // directories.
    const csp: string = manifest.content_security_policy.extension_pages;
    const directives = new Map(
      csp
        .split(';')
        .map(d => d.trim())
        .filter(Boolean)
        .map(d => {
          const [name, ...sources] = d.split(/\s+/);
          return [name, sources] as const;
        })
    );

    expect(directives.get('default-src')).toEqual(["'self'"]);
    expect(directives.get('script-src')).toEqual(["'self'", "'wasm-unsafe-eval'"]);
    expect(directives.get('object-src')).toEqual(["'none'"]);
    expect(directives.get('base-uri')).toEqual(["'none'"]);
    expect(directives.get('frame-src')).toEqual(["'none'"]);
    expect(directives.get('form-action')).toEqual(["'none'"]);
    expect(csp).not.toContain("'unsafe-eval'");
    // Inline *styles* are allowed (dependencies create <style> elements);
    // inline *script* never is.
    expect(directives.get('script-src')).not.toContain("'unsafe-inline'");

    const remote = (directives.get('connect-src') ?? []).filter(source => /^https?:/.test(source));
    expect(remote).toEqual([
      'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int/',
      'https://cdn.jsdelivr.net/npm/@tesseract.js-data/hin@1.0.0/4.0.0_best_int/'
    ]);
    // Never the whole host.
    expect(directives.get('connect-src')).not.toContain('https://cdn.jsdelivr.net');

    // No other directive may name a remote source at all.
    for (const [name, sources] of directives) {
      if (name === 'connect-src') continue;
      expect(
        sources.filter(source => /^https?:/.test(source)),
        name
      ).toEqual([]);
    }
  });

  test('ships every icon size the store requires, at real dimensions', () => {
    // DIST-01: these were 1×1 placeholder pixels for a while — this only ever
    // asserted the manifest *declared* a path, never that the file behind it
    // was a real icon, so the toolbar button and the store listing were both
    // blank the entire time. A PNG's width/height live at fixed offsets in
    // its IHDR chunk (bytes 16–23), no image library needed to check them.
    for (const size of ['16', '32', '48', '128']) {
      const declaredPath: string = manifest.icons[size];
      expect(declaredPath).toBeTruthy();
      const bytes = readFileSync(path.resolve(process.cwd(), 'public', declaredPath));
      const width = bytes.readUInt32BE(16);
      const height = bytes.readUInt32BE(20);
      expect(width).toBe(Number(size));
      expect(height).toBe(Number(size));
    }
  });

  test('version matches package.json', () => {
    // Found out of sync (manifest said 1.0.0, package.json said 0.1.0) with
    // nothing catching it — RELEASE_CHECKLIST.md's "keep these in step" step
    // is manual and easy to skip under release pressure.
    const pkg = JSON.parse(readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'));
    expect(manifest.version).toBe(pkg.version);
  });
});
