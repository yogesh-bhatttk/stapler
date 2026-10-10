import { describe, expect, it } from 'vitest';
import * as bundleScan from '../../scripts/check-bundle-network.mjs';

/**
 * Audit 2026-10-10 S4 — blind spots in the post-build bundle scan, tested on
 * synthetic bundle snippets (the real dist/ is not rebuilt in unit tests).
 *
 *  - `fetch()` and friends were not sinks in bundle mode, while the
 *    documentation allowlist names hosts that serve content (raw.github.com,
 *    github.com, sheetjs.com…), so `fetch('https://raw.github.com/…')` passed.
 *  - `.webmanifest` and `.txt` files were never read.
 *  - A protocol-relative `//host/x.js` was invisible to the URL inventory.
 */
const { scanText } = bundleScan as unknown as {
  scanText(text: string, rel: string): { failures: string[]; urls: number };
};

const scan = (text: string, rel = 'dist/web/assets/vendor-abc.js') => scanText(text, rel).failures;

describe('audit 2026-10-10 S4: request-API arguments are sinks in bundle mode', () => {
  const DOC = 'https://raw.github.com/owner/repo/main/payload.js';

  it('a documentation host is fine as text, not as a request', () => {
    expect(scan(`/* see ${DOC} */ var help = "${DOC}";`)).toEqual([]);
    expect(scan(`fetch("${DOC}")`).join('\n')).toMatch(/fetch\(\) of a remote URL/);
  });

  it.each([
    ['global fetch', `fetch("${DOC}").then(r => r.text())`],
    ['self.fetch', `self.fetch("${DOC}")`],
    ['aliased fetch', `const f = globalThis.fetch; f("${DOC}")`],
    ['a library fetch method', `client.fetch("https://github.com/x/y.json")`],
    ['importScripts (any argument)', `importScripts("/local.js", "https://sheetjs.com/x.js")`],
    ['sendBeacon', `navigator.sendBeacon("https://stuk.github.io/b", data)`],
    ['XHR open', `var x = new XMLHttpRequest(); x.open("GET", "https://gitbrent.github.io/d")`],
    ['WebSocket', `new WebSocket("wss://github.com/socket")`],
    ['EventSource', `new EventSource("https://github.com/events")`],
    ['a concatenated URL', `fetch("https://raw.github" + ".com/x")`]
  ])('%s', (_name, code) => {
    const failures = scan(code);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.join('\n')).toMatch(/of a remote URL/);
  });

  it('same-origin and unknown targets stay quiet (libraries fetch their own assets)', () => {
    expect(
      scan(`fetch("./pdf.worker.mjs"); fetch(url); x.open("GET", path); window.open("_blank")`)
    ).toEqual([]);
  });
});

describe('audit 2026-10-10 S4: protocol-relative URLs are inventoried', () => {
  it('flags //host at the start of a string, attribute or url()', () => {
    expect(scan(`var s = "//cdn.evil.example/x.js";`).join('\n')).toMatch(
      /not in the bundle allowlist: \/\/cdn\.evil\.example\/x\.js/
    );
    expect(
      scan(`<img src="//tracker.example.com/p.gif">`, 'dist/web/index.html').join('\n')
    ).toMatch(/tracker\.example\.com/);
    expect(scan(`a{background:url(//cdn.example.org/a.png)}`, 'dist/web/a.css').join('\n')).toMatch(
      /cdn\.example\.org/
    );
  });

  it('as a sink, a protocol-relative URL is remote', () => {
    expect(scan(`fetch("//github.com/x")`).join('\n')).toMatch(/fetch\(\) of a remote URL/);
  });

  it('matches allowlisted hosts as the https URL they would load', () => {
    expect(scan(`var c = "//stapler.app/merge-pdf";`)).toEqual([]);
  });

  it('ignores // comments and // inside paths', () => {
    expect(scan(`// see foo.js for details\nvar p = "a//b.js"; var r = /\\/\\/x/;`)).toEqual([]);
  });
});

describe('audit 2026-10-10 S4: .webmanifest and .txt are scanned', () => {
  it('a remote icon in a web manifest fails', () => {
    const manifest = JSON.stringify({
      icons: [{ src: 'https://cdn.example.com/icon.png', sizes: '192x192' }]
    });
    expect(scan(manifest, 'dist/web/manifest.webmanifest').join('\n')).toMatch(/cdn\.example\.com/);
    expect(
      scan(
        JSON.stringify({ icons: [{ src: '//cdn.example.com/i.png' }] }),
        'dist/web/m.webmanifest'
      ).join('\n')
    ).toMatch(/cdn\.example\.com/);
    expect(
      scan(JSON.stringify({ icons: [{ src: 'icons/192.png' }] }), 'dist/web/m.webmanifest')
    ).toEqual([]);
  });

  it('a remote URL in robots.txt fails; licence texts may link anywhere', () => {
    expect(
      scan('Sitemap: https://evil.example/sitemap.xml', 'dist/web/robots.txt').join('\n')
    ).toMatch(/evil\.example/);
    expect(scan('Sitemap: https://stapler.app/sitemap.xml', 'dist/web/robots.txt')).toEqual([]);
    expect(
      scan(
        'See https://fsf.org/ and https://scripts.sil.org/OFL',
        'dist/ext/THIRD_PARTY_LICENSES.txt'
      )
    ).toEqual([]);
    // …but only in licence files.
    expect(scan('https://fsf.org/', 'dist/ext/notes.txt').length).toBe(1);
  });
});
