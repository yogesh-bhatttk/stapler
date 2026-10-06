import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  LIBRARY_PATCHES,
  applyExactPatches,
  patchTesseractWorker,
  patchesFor
} from '../../scripts/amo-lint-patches.mjs';

/**
 * AMO review — the build-time library patches (`scripts/amo-lint-patches.mjs`)
 * must each match the installed library exactly once, and must leave no
 * `Function(`/`eval` behind in the code they target. The build enforces the
 * same thing; this catches an upgrade before a build is run.
 */
const pnpmStore = path.resolve(process.cwd(), 'node_modules/.pnpm');

/** Every installed copy of the file a patch names (`/node_modules/<pkg>/<path>`). */
function installedCopies(file: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(pnpmStore)) {
    const candidate = path.join(pnpmStore, entry, file);
    if (existsSync(candidate)) out.push(candidate);
  }
  return out;
}

describe('LIBRARY_PATCHES', () => {
  for (const patch of LIBRARY_PATCHES) {
    test(`${patch.name} matches the installed library exactly once`, () => {
      const copies = installedCopies(patch.file);
      expect(copies.length, `no installed ${patch.file}`).toBeGreaterThan(0);
      for (const file of copies) {
        const code = readFileSync(file, 'utf8');
        expect(code.split(patch.find).length - 1, file).toBe(patch.count ?? 1);
        expect(patchesFor(file)).toContain(patch);
      }
    });
  }

  test('after patching, no Function()/eval is left in the patched eval sites', () => {
    const files = new Set(LIBRARY_PATCHES.map(p => p.file));
    for (const file of files) {
      if (file.endsWith('preact.module.js')) continue;
      for (const copy of installedCopies(file)) {
        const patched = applyExactPatches(readFileSync(copy, 'utf8'), patchesFor(copy), copy);
        for (const patch of patchesFor(copy)) expect(patched).not.toContain(patch.find);
      }
    }
  });

  test('preact: the only innerHTML write is gone after patching', () => {
    const [copy] = installedCopies('/node_modules/preact/dist/preact.module.js');
    const patched = applyExactPatches(readFileSync(copy, 'utf8'), patchesFor(copy), copy);
    expect(patched).not.toMatch(/\.innerHTML=[^"=]/);
  });

  test('a library change that moves the code fails loudly', () => {
    const [patch] = LIBRARY_PATCHES;
    expect(() => applyExactPatches('unrelated code', [patch], 'x.js')).toThrow(
      /expected 1 exact match/
    );
    expect(() => applyExactPatches(`${patch.find}\n${patch.find}`, [patch], 'x.js')).toThrow(
      /found 2/
    );
  });
});

describe('patchTesseractWorker', () => {
  test('removes both Function() fallbacks from the installed worker.min.js', () => {
    const source = readFileSync(
      path.resolve(process.cwd(), 'node_modules/tesseract.js/dist/worker.min.js'),
      'utf8'
    );
    expect(source).toMatch(/Function\("/);
    const patched = patchTesseractWorker(source);
    expect(patched).not.toMatch(/Function\("/);
    expect(patched.length).toBeLessThan(source.length);
  });
});
