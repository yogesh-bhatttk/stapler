import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  collectThirdPartyLicenses,
  renderThirdPartyLicenses
} from '../../scripts/third-party-licenses.mjs';

/**
 * Audit 2026-09-25 PLT-12 — both builds redistributed Apache/MIT/BSD code with
 * none of the licence texts or NOTICE files those licences require.
 */
describe('collectThirdPartyLicenses (real tree)', () => {
  const entries = collectThirdPartyLicenses(process.cwd());
  const byName = (name: string) => entries.find(e => e.name === name);

  test('covers every direct production dependency', () => {
    const pkg = (
      JSON.parse(readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8')) as {
        dependencies: Record<string, string>;
      }
    ).dependencies;
    for (const name of Object.keys(pkg)) {
      // `pdf-lib` is an npm alias; the installed package carries its real name.
      const real = name === 'pdf-lib' ? '@cantoo/pdf-lib' : name;
      expect(byName(real), name).toBeDefined();
    }
  });

  test('includes pdf.js with its Apache licence and the licences of the wasm decoders we ship', () => {
    const pdfjs = byName('pdfjs-dist');
    expect(pdfjs?.license).toBe('Apache-2.0');
    const files = pdfjs?.files.map(f => f.file) ?? [];
    expect(files).toContain('LICENSE');
    expect(files).toContain('wasm/LICENSE_OPENJPEG');
    expect(pdfjs?.files.find(f => f.file === 'LICENSE')?.text).toMatch(/Apache License/);
  });

  test('notes code vendored inside a package bundle (TensorFlow.js inside face-api)', () => {
    expect(byName('@vladmandic/face-api')?.embedded.join(' ')).toMatch(/TensorFlow\.js.*Apache/);
  });

  test('never pulls in devDependencies', () => {
    for (const dev of ['vite', 'vitest', 'eslint', 'typescript', '@playwright/test']) {
      expect(byName(dev), dev).toBeUndefined();
    }
  });
});

describe('collectThirdPartyLicenses (synthetic tree)', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function pkg(at: string, json: Record<string, unknown>, files: Record<string, string> = {}) {
    mkdirSync(at, { recursive: true });
    writeFileSync(path.join(at, 'package.json'), JSON.stringify(json));
    for (const [name, text] of Object.entries(files)) writeFileSync(path.join(at, name), text);
  }

  test('follows nested (pnpm-style) resolution and reproduces NOTICE files', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'tpl-'));
    pkg(dir, { name: 'app', dependencies: { a: '1' }, devDependencies: { dev: '1' } });
    pkg(
      path.join(dir, 'node_modules/a'),
      { name: 'a', version: '1.0.0', license: 'Apache-2.0', dependencies: { b: '2' } },
      { LICENSE: 'Apache License text', NOTICE: 'Copyright A authors' }
    );
    // b resolves from a's own node_modules first, as Node does.
    pkg(path.join(dir, 'node_modules/a/node_modules/b'), {
      name: 'b',
      version: '2.0.0',
      license: { type: 'MIT' }
    });
    pkg(path.join(dir, 'node_modules/dev'), { name: 'dev', version: '9.9.9', license: 'MIT' });

    const entries = collectThirdPartyLicenses(dir);
    expect(entries.map(e => `${e.name}@${e.version}`)).toEqual(['a@1.0.0', 'b@2.0.0']);
    const text = renderThirdPartyLicenses(entries, 'Test');
    expect(text).toContain('--- NOTICE ---');
    expect(text).toContain('Copyright A authors');
    expect(text).toContain('License: MIT');
    expect(text).toContain('No licence file ships in this package');
  });

  test('fails the build when a required dependency is missing, skips a missing optional one', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'tpl-'));
    pkg(dir, { name: 'app', optionalDependencies: { gone: '1' } });
    expect(collectThirdPartyLicenses(dir)).toEqual([]);
    pkg(dir, { name: 'app', dependencies: { gone: '1' } });
    expect(() => collectThirdPartyLicenses(dir)).toThrow(/gone/);
  });
});
