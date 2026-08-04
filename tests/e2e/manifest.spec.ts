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

  test('forbids remote code in its CSP', () => {
    const csp: string = manifest.content_security_policy.extension_pages;
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/https?:/);
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toContain("'unsafe-inline'");
  });

  test('ships every icon size the store requires', () => {
    for (const size of ['16', '32', '48', '128']) {
      expect(manifest.icons[size]).toBeTruthy();
    }
  });
});
