/**
 * GAP-2 — the website twin as an installable, offline-capable web app.
 * Web build only: the extension is offline by construction and must ship
 * neither file (`scripts/package.mjs` fails a release that does).
 *
 * The `stapler:web-pwa` Vite plugin ({@link webPwa}):
 *  - emits `manifest.webmanifest` — name, icons, `display: standalone`,
 *    theme/background colours read from `--canvas` in `src/ui/styles/tokens.css`
 *    at build time (a manifest cannot use `var()`, and a copied literal would
 *    drift from the token), `file_handlers` for PDFs and the supported images
 *    ("Open with Stapler", consumed through `launchQueue`) and a `share_target`
 *    (the Android share sheet), both handled in `src/platform/pwa/`;
 *  - links it, plus light/dark `theme-color`, from every entry page;
 *  - after every other plugin has written its files, lists the whole output
 *    directory, hashes each file, and compiles `src/platform/pwa/service-worker.ts`
 *    into a self-contained classic `sw.js` with that precache manifest inlined.
 *    Any change to any shipped file changes `sw.js`, which is what makes the
 *    browser install the new version.
 *
 * No Workbox, no CDN, nothing fetched at build time. The pure parts are
 * unit-tested in `tests/unit/pwa-build.test.ts`.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

/** Never cached: debugging maps, the worker itself, crawler files. */
export function isExcludedFromPrecache(path) {
  return (
    path.endsWith('.map') ||
    path === 'sw.js' ||
    path === 'robots.txt' ||
    path === 'sitemap.xml' ||
    path.split('/').some(part => part.startsWith('.'))
  );
}

/**
 * Cached on first use instead of on install. The OCR engine (~7 MB) is useless
 * without a language model, which is itself a consented download (OCR-01), so
 * pre-fetching it for every visitor would be pure waste.
 */
export const RUNTIME_CACHE_PREFIXES = ['ocr/'];

/** Top-level `.html` files are the entry pages (network-first in the worker). */
export function isEntryPage(path) {
  return !path.includes('/') && path.endsWith('.html');
}

/**
 * `{ path, hash }[]` for a build (POSIX paths relative to its root) → the
 * `PrecacheManifest` inlined into `sw.js` (`src/platform/pwa/sw-routing.ts`).
 * Deterministic: the same files produce the same manifest and version.
 */
export function buildPrecacheManifest(files) {
  const kept = files
    .filter(file => !isExcludedFromPrecache(file.path))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const precache = [];
  const runtime = [];
  const revisions = {};
  for (const file of kept) {
    if (RUNTIME_CACHE_PREFIXES.some(prefix => file.path.startsWith(prefix))) {
      runtime.push(file.path);
    } else {
      precache.push(file.path);
      revisions[file.path] = file.hash;
    }
  }
  const version = createHash('sha256')
    .update(kept.map(file => `${file.path}\u0000${file.hash}`).join('\n'))
    .digest('hex')
    .slice(0, 16);
  return { version, precache, runtime, pages: precache.filter(isEntryPage), revisions };
}

/** Every file under `dir` with the SHA-256 of its bytes. */
export function listBuildFiles(dir) {
  const out = [];
  const walk = current => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else
        out.push({
          path: relative(dir, full).split(sep).join('/'),
          hash: createHash('sha256').update(readFileSync(full)).digest('hex')
        });
    }
  };
  walk(dir);
  return out;
}

/**
 * `--canvas` in the light (`:root`) and dark (`[data-theme='dark']`) blocks
 * of tokens.css — the page background, and so the right splash / title-bar
 * colour for the installed app.
 */
export function readThemeColors(tokensCss) {
  const darkAt = tokensCss.indexOf("[data-theme='dark']");
  const light = darkAt === -1 ? tokensCss : tokensCss.slice(0, darkAt);
  const dark = darkAt === -1 ? '' : tokensCss.slice(darkAt);
  const canvas = css => css.match(/--canvas\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/)?.[1];
  const result = { light: canvas(light), dark: canvas(dark) };
  if (!result.light || !result.dark) {
    throw new Error('stapler:web-pwa — could not read --canvas (light and dark) from tokens.css');
  }
  return result;
}

export const WEB_MANIFEST_ICON_SIZES = [48, 128, 192, 512];

/** The share-target form field the service worker reads files from. */
export const SHARE_TARGET_FIELD = 'files';

/**
 * The web app manifest. URLs are relative, so they resolve against the
 * manifest's own URL and the site works at any base path.
 *
 * @param {{ themeColors: { light: string }, fileAccept: Record<string, string[]> }} input
 */
export function buildWebManifest({ themeColors, fileAccept }) {
  return {
    id: './',
    name: 'Stapler — Offline PDF Tools',
    short_name: 'Stapler',
    description:
      'Merge, split, compress, sign and redact PDFs entirely on your device. No upload, no account.',
    start_url: './',
    scope: './',
    display: 'standalone',
    theme_color: themeColors.light,
    background_color: themeColors.light,
    icons: WEB_MANIFEST_ICON_SIZES.map(size => ({
      src: `icons/icon-${size}.png`,
      sizes: `${size}x${size}`,
      type: 'image/png',
      purpose: 'any'
    })),
    file_handlers: [{ action: './', accept: fileAccept }],
    share_target: {
      action: './share-target',
      method: 'POST',
      enctype: 'multipart/form-data',
      params: {
        files: [
          {
            name: SHARE_TARGET_FIELD,
            accept: Object.entries(fileAccept).flatMap(([mime, extensions]) => [
              mime,
              ...extensions
            ])
          }
        ]
      }
    }
  };
}

/** Tags injected into every entry page's `<head>`. */
export function pwaHeadTags(base, themeColors) {
  return [
    { tag: 'link', attrs: { rel: 'manifest', href: `${base}manifest.webmanifest` } },
    {
      tag: 'meta',
      attrs: {
        name: 'theme-color',
        media: '(prefers-color-scheme: light)',
        content: themeColors.light
      }
    },
    {
      tag: 'meta',
      attrs: {
        name: 'theme-color',
        media: '(prefers-color-scheme: dark)',
        content: themeColors.dark
      }
    },
    { tag: 'link', attrs: { rel: 'apple-touch-icon', href: `${base}icons/icon-192.png` } }
  ].map(tag => ({ ...tag, injectTo: 'head' }));
}

/** A module statement in the compiled worker would make it fail as a classic script. */
export function assertClassicScript(code) {
  if (/^\s*(?:import|export)\b/m.test(code)) {
    throw new Error('stapler:web-pwa — sw.js must be a self-contained classic script');
  }
  if (/__STAPLER_PRECACHE__/.test(code)) {
    throw new Error('stapler:web-pwa — the precache manifest was not inlined into sw.js');
  }
}

/**
 * @param {{ root: string, fileAccept: Record<string, string[]> }} options
 * @returns {import('vite').Plugin}
 */
export function webPwa({ root, fileAccept }) {
  const swEntry = resolve(root, 'src/platform/pwa/service-worker.ts');
  const themeColors = readThemeColors(
    readFileSync(resolve(root, 'src/ui/styles/tokens.css'), 'utf8')
  );
  let base = '/';
  return {
    name: 'stapler:web-pwa',
    apply: 'build',
    enforce: 'post',
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml() {
      return pwaHeadTags(base, themeColors);
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.webmanifest',
        source: `${JSON.stringify(buildWebManifest({ themeColors, fileAccept }), null, 2)}\n`
      });
    },
    writeBundle: {
      // After every other plugin's writeBundle (pdf.js assets, the OCR engine,
      // index.html…), so the list really is everything that ships.
      sequential: true,
      order: 'post',
      async handler(options) {
        const dir = resolve(root, options.dir ?? 'dist');
        const manifest = buildPrecacheManifest(listBuildFiles(dir));
        const { build } = await import('vite');
        const result = await build({
          configFile: false,
          root,
          logLevel: 'warn',
          publicDir: false,
          define: { __STAPLER_PRECACHE__: JSON.stringify(manifest) },
          build: {
            write: false,
            emptyOutDir: false,
            copyPublicDir: false,
            modulePreload: false,
            sourcemap: false,
            minify: true,
            rollupOptions: {
              input: swEntry,
              output: { format: 'iife', entryFileNames: 'sw.js' }
            }
          }
        });
        const outputs = (Array.isArray(result) ? result : [result]).flatMap(r => r.output ?? []);
        const chunk = outputs.find(item => item.type === 'chunk' && item.fileName === 'sw.js');
        if (!chunk) throw new Error('stapler:web-pwa — compiling sw.js produced no output');
        assertClassicScript(chunk.code);
        writeFileSync(resolve(dir, 'sw.js'), chunk.code);
        this.info?.(
          `sw.js: ${manifest.precache.length} files precached, ${manifest.runtime.length} on first use (version ${manifest.version})`
        );
      }
    }
  };
}
