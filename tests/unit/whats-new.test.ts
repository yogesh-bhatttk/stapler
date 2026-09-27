import { describe, expect, test } from 'vitest';
import { RELEASES, shouldShowWhatsNew } from '../../src/ui/whats-new/releases';

/** GAP-7 — when the service worker opens `#/whats-new`. */
describe('What’s new version gating', () => {
  const current = RELEASES[0].version;

  test('opens on an update to a version with notes', () => {
    expect(
      shouldShowWhatsNew({ reason: 'update', previousVersion: '0.0.1', currentVersion: current })
    ).toBe(true);
  });

  test('never opens on a first install — the welcome dialog covers that', () => {
    expect(shouldShowWhatsNew({ reason: 'install', currentVersion: current })).toBe(false);
  });

  test('ignores browser updates and shared-module updates', () => {
    expect(shouldShowWhatsNew({ reason: 'chrome_update', currentVersion: current })).toBe(false);
    expect(shouldShowWhatsNew({ reason: 'shared_module_update', currentVersion: current })).toBe(
      false
    );
  });

  test('ignores a reload that did not change the version', () => {
    expect(
      shouldShowWhatsNew({ reason: 'update', previousVersion: current, currentVersion: current })
    ).toBe(false);
  });

  test('never opens twice for the same version', () => {
    expect(
      shouldShowWhatsNew({
        reason: 'update',
        previousVersion: '0.0.1',
        currentVersion: current,
        lastShownVersion: current
      })
    ).toBe(false);
    // …but a later version is news again.
    expect(
      shouldShowWhatsNew({
        reason: 'update',
        previousVersion: '0.0.1',
        currentVersion: current,
        lastShownVersion: '0.0.1'
      })
    ).toBe(true);
  });

  test('stays closed for a version with no notes', () => {
    expect(
      shouldShowWhatsNew({ reason: 'update', previousVersion: '0.0.1', currentVersion: '99.0.0' })
    ).toBe(false);
  });

  test('releases are unique, newest first, and non-empty', () => {
    const versions = RELEASES.map(release => release.version);
    expect(new Set(versions).size).toBe(versions.length);
    const numeric = versions.map(v => v.split('.').map(Number));
    for (let i = 1; i < numeric.length; i++) {
      const [a, b] = [numeric[i - 1], numeric[i]];
      const cmp = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
      expect(cmp).toBeGreaterThan(0);
    }
    for (const release of RELEASES) expect(release.items.length).toBeGreaterThan(0);
  });
});
