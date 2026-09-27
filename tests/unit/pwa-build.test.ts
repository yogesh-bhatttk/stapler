import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as pwa from '../../scripts/pwa.mjs';
import { PUBLIC_ONLY_FOR } from '../../vite.config';
import { PDF_AND_IMAGES } from '../../src/platform/index';
import type { PrecacheManifest } from '../../src/platform/pwa/sw-routing';

/**
 * GAP-2 — the build-time half of the web app: the precache list inlined into
 * `sw.js`, and `manifest.webmanifest`.
 */
const {
  buildPrecacheManifest,
  buildWebManifest,
  listBuildFiles,
  readThemeColors,
  isExcludedFromPrecache,
  assertClassicScript,
  pwaHeadTags,
  WEB_MANIFEST_ICON_SIZES
} = pwa as unknown as {
  buildPrecacheManifest: (files: { path: string; hash: string }[]) => PrecacheManifest;
  buildWebManifest: (input: {
    themeColors: { light: string; dark: string };
    fileAccept: Record<string, string[]>;
  }) => Record<string, unknown> & {
    icons: { src: string; sizes: string }[];
    file_handlers: { action: string; accept: Record<string, string[]> }[];
    share_target: {
      action: string;
      method: string;
      enctype: string;
      params: { files: { name: string; accept: string[] }[] };
    };
  };
  listBuildFiles: (dir: string) => { path: string; hash: string }[];
  readThemeColors: (css: string) => { light: string; dark: string };
  isExcludedFromPrecache: (path: string) => boolean;
  assertClassicScript: (code: string) => void;
  pwaHeadTags: (
    base: string,
    colors: { light: string; dark: string }
  ) => { tag: string; attrs: Record<string, string> }[];
  WEB_MANIFEST_ICON_SIZES: number[];
};

const ROOT = path.resolve(__dirname, '../..');

describe('buildPrecacheManifest', () => {
  const files = [
    { path: 'index.html', hash: 'a' },
    { path: 'assets/editor-1.js', hash: 'b' },
    { path: 'assets/editor-1.js.map', hash: 'c' },
    { path: 'ocr/tesseract-core-simd-lstm.wasm', hash: 'd' },
    { path: 'merge-pdf.html', hash: 'e' },
    { path: 'sw.js', hash: 'f' },
    { path: 'robots.txt', hash: 'g' },
    { path: 'sitemap.xml', hash: 'h' },
    { path: 'pdfjs/standard_fonts/FoxitSans.pfb', hash: 'i' },
    { path: 'manifest.webmanifest', hash: 'j' },
    { path: 'icons/icon-192.png', hash: 'k' }
  ];

  it('precaches build files, defers the OCR engine, and skips maps, sw.js and crawler files', () => {
    const manifest = buildPrecacheManifest(files);
    expect(manifest.precache).toEqual([
      'assets/editor-1.js',
      'icons/icon-192.png',
      'index.html',
      'manifest.webmanifest',
      'merge-pdf.html',
      'pdfjs/standard_fonts/FoxitSans.pfb'
    ]);
    expect(manifest.runtime).toEqual(['ocr/tesseract-core-simd-lstm.wasm']);
    expect(manifest.pages).toEqual(['index.html', 'merge-pdf.html']);
    expect(Object.keys(manifest.revisions).sort()).toEqual([...manifest.precache].sort());
    expect(manifest.revisions['index.html']).toBe('a');
  });

  it('is deterministic, and its version changes with any shipped file', () => {
    const a = buildPrecacheManifest(files);
    const b = buildPrecacheManifest([...files].reverse());
    expect(b).toEqual(a);
    expect(a.version).toMatch(/^[0-9a-f]{16}$/);
    const changed = buildPrecacheManifest(
      files.map(f => (f.path === 'pdfjs/standard_fonts/FoxitSans.pfb' ? { ...f, hash: 'z' } : f))
    );
    expect(changed.version).not.toBe(a.version);
    // A map (not shipped to the cache) changing does not force an update.
    const mapOnly = buildPrecacheManifest(
      files.map(f => (f.path.endsWith('.map') ? { ...f, hash: 'z' } : f))
    );
    expect(mapOnly.version).toBe(a.version);
  });

  it('excludes dotfiles', () => {
    expect(isExcludedFromPrecache('.DS_Store')).toBe(true);
    expect(isExcludedFromPrecache('assets/.hidden')).toBe(true);
    expect(isExcludedFromPrecache('assets/x.js')).toBe(false);
  });
});

describe('listBuildFiles', () => {
  it('lists nested files with POSIX paths and SHA-256 hashes', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'stapler-pwa-'));
    try {
      mkdirSync(path.join(dir, 'assets'));
      writeFileSync(path.join(dir, 'index.html'), 'x');
      writeFileSync(path.join(dir, 'assets', 'a.js'), 'x');
      const listed = listBuildFiles(dir).sort((a, b) => a.path.localeCompare(b.path));
      expect(listed.map(f => f.path)).toEqual(['assets/a.js', 'index.html']);
      // sha256("x")
      expect(listed[0].hash).toBe(
        '2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881'
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('theme colours', () => {
  it('come from --canvas in tokens.css, light and dark', () => {
    const colors = readThemeColors(
      readFileSync(path.join(ROOT, 'src/ui/styles/tokens.css'), 'utf8')
    );
    expect(colors.light).toMatch(/^#[0-9a-fA-F]{3,8}$/);
    expect(colors.dark).toMatch(/^#[0-9a-fA-F]{3,8}$/);
    expect(colors.light).not.toBe(colors.dark);
  });

  it('refuse to guess when the token is missing', () => {
    expect(() => readThemeColors(':root { --ink: #000; }')).toThrow(/--canvas/);
  });
});

describe('manifest.webmanifest', () => {
  const colors = { light: '#ffffff', dark: '#000000' };
  const manifest = buildWebManifest({ themeColors: colors, fileAccept: PDF_AND_IMAGES });

  it('is an installable standalone app with relative URLs', () => {
    expect(manifest).toMatchObject({
      name: expect.any(String),
      short_name: 'Stapler',
      start_url: './',
      scope: './',
      display: 'standalone',
      theme_color: '#ffffff',
      background_color: '#ffffff'
    });
    const sizes = manifest.icons.map(icon => icon.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
  });

  it('points at icons that exist, at the size it claims, and ship only in the web build', () => {
    for (const icon of manifest.icons) {
      const png = readFileSync(path.join(ROOT, 'public', icon.src));
      const width = png.readUInt32BE(16);
      const height = png.readUInt32BE(20);
      expect(`${width}x${height}`).toBe(icon.sizes);
    }
    expect(WEB_MANIFEST_ICON_SIZES).toEqual(expect.arrayContaining([192, 512]));
    expect(PUBLIC_ONLY_FOR['icons/icon-192.png']).toBe('web');
    expect(PUBLIC_ONLY_FOR['icons/icon-512.png']).toBe('web');
  });

  it('handles the same file types the app opens, for "Open with" and the share sheet', () => {
    expect(manifest.file_handlers).toEqual([{ action: './', accept: PDF_AND_IMAGES }]);
    const share = manifest.share_target;
    expect(share).toMatchObject({
      action: './share-target',
      method: 'POST',
      enctype: 'multipart/form-data'
    });
    expect(share.params.files[0].name).toBe('files');
    expect(share.params.files[0].accept).toEqual(
      expect.arrayContaining(['application/pdf', '.pdf', 'image/png', '.jpg'])
    );
  });

  it('is linked from every entry page with light and dark theme colours', () => {
    const tags = pwaHeadTags('/', colors);
    expect(tags).toContainEqual(
      expect.objectContaining({
        tag: 'link',
        attrs: { rel: 'manifest', href: '/manifest.webmanifest' }
      })
    );
    const themes = tags.filter(t => t.attrs.name === 'theme-color').map(t => t.attrs.content);
    expect(themes).toEqual(['#ffffff', '#000000']);
  });
});

describe('assertClassicScript', () => {
  it('rejects a module worker or an un-inlined manifest', () => {
    expect(() => assertClassicScript('(function(){})();')).not.toThrow();
    expect(() => assertClassicScript('import x from "./y.js";')).toThrow(/classic/);
    expect(() => assertClassicScript('export {};')).toThrow(/classic/);
    expect(() => assertClassicScript('const m = __STAPLER_PRECACHE__;')).toThrow(/inlined/);
  });
});
