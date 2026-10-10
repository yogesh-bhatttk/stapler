import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as invariants from '../../scripts/manifest-invariants.mjs';
import { transformManifestForFirefox } from '../../scripts/firefox-manifest.mjs';

/**
 * Audit 2026-10-10 (CI/Release) — the built Firefox manifest was only parsed
 * as JSON, `validate-builds` checked `host_permissions` alone, and
 * `package.mjs` never looked at `optional_host_permissions`,
 * `web_accessible_resources` or `externally_connectable`. One shared check
 * now backs all three (`scripts/manifest-invariants.mjs`).
 */
const { manifestFindings } = invariants as unknown as {
  manifestFindings(manifest: Record<string, unknown>, label: string): string[];
};

const root = path.resolve(__dirname, '../..');
const source = JSON.parse(readFileSync(path.join(root, 'public/manifest.json'), 'utf8')) as Record<
  string,
  unknown
>;

describe('manifestFindings', () => {
  it('passes the shipped source manifest and its Firefox transform', () => {
    expect(manifestFindings(source, 'public/manifest.json')).toEqual([]);
    expect(manifestFindings(transformManifestForFirefox(source), 'firefox')).toEqual([]);
  });

  it.each([
    ['permissions', { permissions: ['tabs'] }, /"permissions" is non-empty \(tabs\)/],
    ['optional_permissions', { optional_permissions: ['downloads'] }, /optional_permissions/],
    ['host_permissions', { host_permissions: ['<all_urls>'] }, /host_permissions/],
    [
      'optional_host_permissions',
      { optional_host_permissions: ['https://*/*'] },
      /"optional_host_permissions" is non-empty/
    ],
    ['content_scripts', { content_scripts: [] }, /"content_scripts" is declared/],
    [
      'web_accessible_resources',
      { web_accessible_resources: [{ resources: ['editor.html'], matches: ['<all_urls>'] }] },
      /"web_accessible_resources" is declared/
    ],
    [
      'externally_connectable',
      { externally_connectable: { matches: ['https://example.com/*'] } },
      /"externally_connectable" is declared/
    ],
    ['a non-array permissions', { permissions: 'tabs' }, /"permissions" is not an array/]
  ])('rejects %s', (_name, extra, message) => {
    const findings = manifestFindings({ ...source, ...extra }, 'm');
    expect(findings.join('\n')).toMatch(message);
    // …in the Firefox build too, which the transform copies it into.
    const firefox = transformManifestForFirefox({ ...source, ...extra });
    expect(manifestFindings(firefox, 'ff').join('\n')).toMatch(message);
  });

  it('rejects a missing or loosened CSP', () => {
    const noCsp = { ...source };
    delete noCsp.content_security_policy;
    expect(manifestFindings(noCsp, 'm').join('\n')).toMatch(/extension_pages is missing/);
    const loose = {
      ...source,
      content_security_policy: {
        extension_pages:
          "default-src 'self'; script-src 'self' https://cdn.example.com; object-src 'none'; base-uri 'none';"
      }
    };
    expect(manifestFindings(loose, 'm').join('\n')).toMatch(/cdn\.example\.com/);
  });
});

describe('package.mjs refuses an instrumented build itself', () => {
  it('greps every target for the e2e hook before zipping', () => {
    const script = readFileSync(path.join(root, 'scripts/package.mjs'), 'utf8');
    // The literal the e2e build compiles in (src/ui/pwa.ts) is the one checked.
    const pwa = readFileSync(path.join(root, 'src/ui/pwa.ts'), 'utf8');
    expect(pwa).toContain('stapler:e2e-service-worker');
    expect(script).toContain("Buffer.from('stapler:e2e-service-worker')");
    expect(script.indexOf('E2E_HOOK')).toBeLessThan(script.indexOf('zipDir(join(DIST'));
    expect(script).toContain('manifestFindings(manifest');
  });
});
