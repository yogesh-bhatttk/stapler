import { defineConfig, type Plugin } from 'vite';
import preact from '@preact/preset-vite';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

/**
 * pdf.js resolves its character maps, standard fonts, ICC profiles, and image
 * decoders from a URL at runtime. Left at the defaults it issues real network
 * requests for them — which would silently break the zero-network invariant
 * (PLAN §5.4) on the website twin and 404 inside the extension, making CJK text
 * and JBIG2/JPX images fail. So they ship in the bundle and the workers point at
 * these local copies.
 */
function copyPdfJsAssets(): Plugin {
  const from = resolve(root, 'node_modules/pdfjs-dist');
  return {
    name: 'stapler:pdfjs-assets',
    apply: 'build',
    writeBundle(options) {
      const out = resolve(root, options.dir ?? 'dist', 'pdfjs');
      rmSync(out, { recursive: true, force: true });
      for (const dir of ['cmaps', 'standard_fonts', 'iccs']) {
        cpSync(resolve(from, dir), resolve(out, dir), { recursive: true });
      }
      // The wasm folder also carries quickjs, which only PDF JavaScript execution
      // needs. We keep `enableScripting: false` and deliberately ship no
      // interpreter for script embedded in an untrusted document.
      mkdirSync(resolve(out, 'wasm'), { recursive: true });
      for (const file of readdirSync(resolve(from, 'wasm'))) {
        if (file.startsWith('quickjs')) continue;
        cpSync(resolve(from, 'wasm', file), resolve(out, 'wasm', file));
      }
    }
  };
}

/**
 * OCR-01 — tesseract.js resolves *three* things from a URL at runtime, and two of
 * them are executable code: the nested worker script it spawns (`workerPath`) and
 * the WASM engine that worker loads (`corePath`). Both default to jsdelivr. Remote
 * code is forbidden outright (PLAN §5.4 item 2) and would 404 inside the
 * extension besides, so they ship in the bundle and `ocr.worker.ts` points at
 * these copies. The third — the language model — is the one sanctioned network
 * fetch (item 5) and is deliberately *not* vendored: it is 12 MB the vast majority
 * of users never need, and downloading it only on request is what makes the
 * disclosure meaningful.
 *
 * Exactly one engine variant is copied. `tesseract.js-core` ships six, and
 * `getCore.js` picks between them by probing for SIMD support — a probe that
 * resolves to a filename that would not exist here. Naming the `.js` file directly
 * in `corePath` takes that module's "a specific file was given" branch and skips
 * detection entirely. SIMD + LSTM-only is the correct single choice for this
 * project's evergreen-Chrome target and for the `OEM.LSTM_ONLY` the worker asks
 * for.
 */
function copyTesseractAssets(): Plugin {
  return {
    name: 'stapler:tesseract-assets',
    apply: 'build',
    writeBundle(options) {
      const out = resolve(root, options.dir ?? 'dist', 'ocr');
      rmSync(out, { recursive: true, force: true });
      mkdirSync(out, { recursive: true });

      const files: [string, string][] = [
        ['node_modules/tesseract.js/dist/worker.min.js', 'worker.min.js'],
        [
          'node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js',
          'tesseract-core-simd-lstm.wasm.js'
        ],
        [
          'node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm',
          'tesseract-core-simd-lstm.wasm'
        ]
      ];

      for (const [from, to] of files) {
        const source = resolve(root, from);
        if (!existsSync(source)) {
          // A missing engine file means OCR would fail at run time with a 404
          // against our own origin — the sort of thing that is invisible until a
          // user tries it. Fail the build instead.
          throw new Error(`stapler:tesseract-assets — expected ${from} to exist; run install`);
        }
        cpSync(source, resolve(out, to));
      }
    }
  };
}

/**
 * The website twin has to answer at `/`, but the shared entry point is `editor.html`
 * because that is the page the extension's service worker opens. Emitting an
 * `index.html` copy for the web target is what makes `pnpm build:web` deployable
 * (DIST-03) — without it the deployed site 404s at its own root.
 */
function emitWebIndex(): Plugin {
  return {
    name: 'stapler:web-index',
    apply: 'build',
    writeBundle(options) {
      const dir = resolve(root, options.dir ?? 'dist');
      const entry = resolve(dir, 'editor.html');
      if (existsSync(entry)) cpSync(entry, resolve(dir, 'index.html'));
    }
  };
}

/**
 * DIST-03 — the five per-tool landing pages (`/merge-pdf`, `/compress-pdf`,
 * `/sign-pdf`, `/scan-cleanup`, `/redact-pdf`). Web-only: they are static marketing
 * entry points for the deployed site, not something the extension ever opens, so
 * they are excluded from `BUILD_TARGET=ext` the same way `emitWebIndex` is.
 */
const LANDING_PAGES: Record<string, string> = {
  'merge-pdf': 'merge-pdf.html',
  'compress-pdf': 'compress-pdf.html',
  'sign-pdf': 'sign-pdf.html',
  'scan-cleanup': 'scan-cleanup.html',
  'redact-pdf': 'redact-pdf.html'
};

export default defineConfig(() => {
  const isExt = process.env.BUILD_TARGET === 'ext';

  const input: Record<string, string> = {
    editor: resolve(root, 'editor.html')
  };

  if (isExt) {
    input.background = resolve(root, 'src/background/service-worker.ts');
  } else {
    for (const [name, file] of Object.entries(LANDING_PAGES)) {
      input[name] = resolve(root, file);
    }
  }

  return {
    plugins: [
      preact(),
      copyPdfJsAssets(),
      copyTesseractAssets(),
      ...(isExt ? [] : [emitWebIndex()])
    ],
    build: {
      outDir: isExt ? 'dist/ext' : 'dist/web',
      emptyOutDir: true,
      chunkSizeWarningLimit: 1024,
      rollupOptions: {
        input,
        output: {
          entryFileNames: '[name].js',
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]'
        }
      }
    },
    worker: {
      format: 'es'
    }
  };
});
