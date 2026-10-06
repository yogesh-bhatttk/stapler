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

describe('pdf.js patches', () => {
  const patched = (file: string) => {
    const [copy] = installedCopies(file);
    return {
      before: readFileSync(copy, 'utf8'),
      after: applyExactPatches(readFileSync(copy, 'utf8'), patchesFor(copy), copy)
    };
  };
  /** Dynamic `import(` calls, ignoring the one inside a string literal. */
  const dynamicImports = (code: string) =>
    code.split('\n').filter(line => /\bimport\(/.test(line) && !/`await import\("/.test(line));

  test('pdf.mjs: the fake-worker import(workerSrc) is the only dynamic import, and it is gone', () => {
    const { before, after } = patched('/node_modules/pdfjs-dist/build/pdf.mjs');
    expect(dynamicImports(before)).toHaveLength(1);
    expect(dynamicImports(after)).toEqual([]);
    // The pre-registered handler is still consulted first; only the fallback throws.
    expect(after).toContain('if (this.#mainThreadWorkerMessageHandler) {');
    expect(after).toContain('Register globalThis.pdfjsWorker');
  });

  test('pdf.worker.mjs: no dynamic import and no standalone auto-start remain', () => {
    const { before, after } = patched('/node_modules/pdfjs-dist/build/pdf.worker.mjs');
    expect(dynamicImports(before)).toHaveLength(1);
    expect(dynamicImports(after)).toEqual([]);
    expect(before).toContain('this.initializeFromPort(self);');
    expect(after).not.toContain('this.initializeFromPort(self);');
    // It still registers itself for pdf.js to find, and still exports the handler.
    expect(after).toContain('globalThis.pdfjsWorker = {');
    expect(after).toContain('export { WorkerMessageHandler };');
  });

  test('pdf.worker.mjs: a missing WebAssembly decoder still reaches the failure callback', () => {
    const { after } = patched('/node_modules/pdfjs-dist/build/pdf.worker.mjs');
    const start = after.indexOf('async #getJsModule(fallbackCallback) {');
    const body = after.slice(start, after.indexOf('async #instantiateWasm(', start));
    // The throw is inside the try, so the catch warns and calls back with
    // `null`, and the decoder then throws "failed to initialize" — which pdf.js
    // turns into an undecodable image, never a silently blank one.
    expect(body).toMatch(/try \{\s*throw new Error\(`Stapler: WebAssembly could not start/);
    expect(body).toContain('fallbackCallback(instance);');
    expect(after).toContain('throw new JpxError("OpenJPEG failed to initialize");');
    expect(after).toContain('throw new Jbig2Error("JBig2 failed to initialize");');
  });

  test('pdfjs-setup.ts registers the worker module and sets no workerSrc', () => {
    const setup = readFileSync(
      path.resolve(process.cwd(), 'src/core/workers/pdfjs-setup.ts'),
      'utf8'
    );
    expect(setup).toContain("from 'pdfjs-dist/build/pdf.worker.mjs';");
    expect(setup).toMatch(/\.pdfjsWorker = \{\s*WorkerMessageHandler\s*\}/);
    expect(setup).not.toMatch(/GlobalWorkerOptions\.workerSrc\s*=/);
    expect(setup).not.toContain('?url');
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
