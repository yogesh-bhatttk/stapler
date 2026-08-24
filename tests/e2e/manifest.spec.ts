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

  test('forbids remote code in its CSP, allowing only the one pinned model-download host', () => {
    // OCR-01 and RED-08 are documented exceptions to zero-network: each fetches
    // one pinned host, once, on explicit consent (CLAUDE.md invariant #1). The
    // CSP's `connect-src` is where that host has to be named, so this asserts
    // the allowance is exactly that one host — not merely that *some* `https:`
    // showed up, which an unrelated CSP change could satisfy without anyone
    // meaning to add a fetchable remote host to the extension.
    const csp: string = manifest.content_security_policy.extension_pages;
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toContain("'unsafe-inline'");

    const connectSrcMatch = csp.match(/connect-src\s+([^;]+);/);
    expect(connectSrcMatch).not.toBeNull();
    const connectSrcHosts = connectSrcMatch![1].trim().split(/\s+/);
    expect(connectSrcHosts).toEqual(["'self'", 'https://cdn.jsdelivr.net']);

    // No other directive may name a remote host at all.
    const withoutConnectSrc = csp.replace(/connect-src\s+[^;]+;/, '');
    expect(withoutConnectSrc).not.toMatch(/https?:/);
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
