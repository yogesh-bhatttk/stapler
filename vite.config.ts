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

export default defineConfig(() => {
  const isExt = process.env.BUILD_TARGET === 'ext';

  const input: Record<string, string> = {
    editor: resolve(root, 'editor.html')
  };

  if (isExt) {
    input.background = resolve(root, 'src/background/service-worker.ts');
  }

  return {
    plugins: [preact(), copyPdfJsAssets(), ...(isExt ? [] : [emitWebIndex()])],
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
