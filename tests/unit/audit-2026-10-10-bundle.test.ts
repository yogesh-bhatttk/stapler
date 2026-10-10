/**
 * AUDIT-2026-10-10 bundle — every locale dictionary was emitted twice in the
 * package (3.6 MB): once in the page graph and once in the worker graph, under
 * different hashes, because the worker-safe i18n module itself did the
 * `import('./locales/<locale>.json')`. Dictionaries are now loaded only on the
 * page (`src/core/i18n/load.ts`) and sent to each worker with the locale
 * message, so worker-produced messages are still translated.
 *
 * Three halves: no worker entry can statically reach a dictionary import; the
 * worker-realm `loadLocale` installs only what it was sent; and the pool
 * client sends each instance the real dictionaries, each one once.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as Comlink from 'comlink';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');
const WORKERS = path.join(ROOT, 'src/core/workers');
const LOCALES = path.join(ROOT, 'src/core/i18n/locales');

function dictionary(locale: string): Record<string, string> {
  return JSON.parse(fs.readFileSync(path.join(LOCALES, `${locale}.json`), 'utf8')) as Record<
    string,
    string
  >;
}

/**
 * The module specifiers `file` really imports at run time: value imports and
 * re-exports, side-effect imports, and `import()` calls (a template literal
 * keeps its raw text). Type-only imports and `import('x').T` type references
 * are erased before bundling, so they add no edge.
 */
function runtimeSpecifiers(file: string): string[] {
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const specs: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const named = clause?.namedBindings;
      const allTypes =
        !!clause &&
        (clause.isTypeOnly ||
          (!clause.name &&
            !!named &&
            ts.isNamedImports(named) &&
            named.elements.length > 0 &&
            named.elements.every(el => el.isTypeOnly)));
      if (!allTypes) specs.push(node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node) &&
      !node.isTypeOnly &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specs.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0]
    ) {
      const arg = node.arguments[0];
      specs.push(ts.isStringLiteralLike(arg) ? arg.text : arg.getText(sf));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return specs;
}

function resolveLocal(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec.split('?')[0]);
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx')
  ]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Every source file reachable from `entry` through relative imports (static or dynamic). */
function reachable(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop() as string;
    if (seen.has(file) || !/\.tsx?$/.test(file)) continue;
    const specs = runtimeSpecifiers(file);
    seen.set(file, specs);
    for (const spec of specs) {
      const next = resolveLocal(file, spec);
      if (next) queue.push(next);
    }
  }
  return seen;
}

const workerEntries = fs
  .readdirSync(WORKERS)
  .filter(name => name.endsWith('.worker.ts'))
  .map(name => path.join(WORKERS, name));

describe('worker bundles carry no translations', () => {
  it('finds the seven worker entries', () => {
    expect(workerEntries.map(file => path.basename(file)).sort()).toEqual([
      'convert.worker.ts',
      'cv.worker.ts',
      'image.worker.ts',
      'ocr.worker.ts',
      'process.worker.ts',
      'render.worker.ts',
      'zip.worker.ts'
    ]);
  });

  it.each(workerEntries.map(file => [path.basename(file), file]))(
    '%s reaches neither i18n/load.ts nor any locale JSON',
    (_name, entry) => {
      const graph = reachable(entry);
      // The walk really does follow the i18n import (it is not vacuous).
      expect(graph.has(path.join(ROOT, 'src/core/i18n/index.ts'))).toBe(true);
      expect(graph.has(path.join(ROOT, 'src/core/i18n/load.ts'))).toBe(false);
      for (const [file, specs] of graph) {
        const offending = specs.filter(spec => /locales\//.test(spec));
        expect({ file: path.relative(ROOT, file), offending }).toEqual({
          file: path.relative(ROOT, file),
          offending: []
        });
      }
    }
  );

  it('the page side (i18n/load.ts) is where the dictionary import lives', () => {
    // Also proves the walker sees a template-literal import().
    expect(runtimeSpecifiers(path.join(ROOT, 'src/core/i18n/load.ts'))).toContain(
      '`./locales/${locale}.json`'
    );
    expect(
      runtimeSpecifiers(path.join(ROOT, 'src/core/i18n/index.ts')).filter(spec =>
        spec.includes('locales/')
      )
    ).toEqual([]);
  });
});

describe('worker-realm loadLocale', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('cannot switch to a locale it was never sent, and translates with one it was', async () => {
    vi.resetModules();
    const i18n = await import('../../src/core/i18n');
    // A fresh realm has nothing installed, and no longer fetches anything itself.
    expect(await i18n.loadLocale('de')).toBe(false);
    expect(i18n.currentLocale.value).toBe('en');

    const de = dictionary('de');
    const en = dictionary('en');
    expect(await i18n.loadLocale('de', { de, en })).toBe(true);
    expect(i18n.currentLocale.value).toBe('de');
    const key = 'Cancel';
    expect(de[key]).toBeTruthy();
    expect(i18n.translate(key)).toBe(de[key]);

    // Once sent, a dictionary stays installed: switching back needs no resend.
    expect(await i18n.loadLocale('en')).toBe(true);
    expect(await i18n.loadLocale('de')).toBe(true);
    expect(i18n.translate(key)).toBe(de[key]);
  });
});

vi.mock('comlink', async importOriginal => {
  const actual = await importOriginal<typeof import('comlink')>();
  return {
    ...actual,
    expose: (value: unknown, endpoint?: Comlink.Endpoint) =>
      endpoint ? actual.expose(value, endpoint) : undefined
  };
});

describe('worker client sends the dictionaries', () => {
  it('sends the locale and English once each, with their real contents', async () => {
    vi.resetModules();
    const { currentLocale } = await import('../../src/core/i18n');
    const { createWorkerClient } = await import('../../src/core/workers/client');

    const received: { locale: string; sent: Record<string, Record<string, string>> }[] = [];
    interface Api {
      setLocale(locale: string, sent: Record<string, Record<string, string>>): Promise<boolean>;
      ping(): string;
    }
    const spawn = (): Worker => {
      const { port1, port2 } = new MessageChannel();
      const api: Api = {
        async setLocale(locale, sent) {
          received.push({ locale, sent });
          return true;
        },
        ping: () => 'pong'
      };
      Comlink.expose(api, port2);
      port1.start();
      return {
        postMessage: (message: unknown, transfer?: Transferable[]) =>
          port1.postMessage(message, transfer ?? []),
        addEventListener: (type: string, fn: EventListener) =>
          type === 'error' ? undefined : port1.addEventListener(type, fn),
        removeEventListener: (type: string, fn: EventListener) =>
          port1.removeEventListener(type, fn),
        terminate: () => {
          port1.close();
          port2.close();
        }
      } as unknown as Worker;
    };

    currentLocale.value = 'de';
    const client = createWorkerClient<Api>(spawn, { syncLocale: true, idleMs: 0, maxSize: 1 });
    const pinned = client.pin();
    await expect(pinned.lease(api => api.ping())).resolves.toBe('pong');
    currentLocale.value = 'fr';
    await pinned.lease(api => api.ping());
    currentLocale.value = 'de';
    await pinned.lease(api => api.ping());

    expect(received.map(r => [r.locale, Object.keys(r.sent).sort()])).toEqual([
      ['de', ['de', 'en']],
      ['fr', ['fr']],
      ['de', []]
    ]);
    expect(received[0].sent.de).toEqual(dictionary('de'));
    expect(received[0].sent.en).toEqual(dictionary('en'));
    expect(received[1].sent.fr).toEqual(dictionary('fr'));

    pinned.release();
    client.terminate();
    currentLocale.value = 'en';
  });
});

describe('tesseract engine ships as one file', () => {
  const core = path.join(ROOT, 'node_modules/tesseract.js-core');

  it('the .wasm.js core embeds exactly the bytes of the sibling .wasm', () => {
    const loader = fs.readFileSync(path.join(core, 'tesseract-core-simd-lstm.wasm.js'), 'utf8');
    const embedded = /\("(AGFzbQ[A-Za-z0-9+/=]+)"\)/.exec(loader);
    expect(embedded).not.toBeNull();
    const decoded = Buffer.from((embedded as RegExpExecArray)[1], 'base64');
    const wasm = fs.readFileSync(path.join(core, 'tesseract-core-simd-lstm.wasm'));
    expect(decoded.length).toBe(wasm.length);
    expect(decoded.equals(wasm)).toBe(true);
  });

  it('nothing could redirect the core to a separate .wasm file', () => {
    // Emscripten only fetches a separate binary through these module options,
    // and tesseract.js's worker never passes any of them.
    const worker = fs.readFileSync(
      path.join(ROOT, 'node_modules/tesseract.js/dist/worker.min.js'),
      'utf8'
    );
    for (const option of ['locateFile', 'wasmBinary', 'instantiateWasm']) {
      expect(worker.includes(option)).toBe(false);
    }
    const config = fs.readFileSync(path.join(ROOT, 'vite.config.ts'), 'utf8');
    expect(config).toContain("'tesseract-core-simd-lstm.wasm.js'");
    expect(config).not.toContain("'tesseract-core-simd-lstm.wasm'");
  });
});
