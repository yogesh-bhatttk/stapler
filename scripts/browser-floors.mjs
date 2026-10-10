/**
 * Audit 2026-09-25 PLT-9 — the minimum browser versions the builds declare, and
 * the evidence for them, in one place.
 *
 * Nothing in the build transpiles or polyfills the bundled libraries (Vite
 * leaves `node_modules` syntax and built-ins alone), so the real floor is the
 * newest unguarded built-in any shipped code calls. pdf.js 6's *modern* build
 * is by far the most demanding: it calls every API below with no feature test
 * (checked against `node_modules/pdfjs-dist/build/pdf{,.worker}.mjs` 6.2.108 —
 * the one API it does guard, `Iterator.prototype.join`, is left out). Without
 * a declared floor, Chrome or Firefox below it would install fine and then fail
 * to open any PDF.
 *
 * Versions are MDN browser-compat-data `version_added`. `tests/unit/
 * browser-floors.test.ts` asserts the manifests match `max()` of this table,
 * and that every API listed is still really called by the shipped pdf.js — so
 * a pdf.js upgrade that stops needing one is noticed, and the floors in the
 * Chrome manifest, the Firefox transform and this table cannot drift apart.
 *
 * The cost is real, and the floor is *not* "older than every browser still
 * receiving security updates": both numbers come from pdf.js 6's modern build
 * alone (`Math.sumPrecise` sets Chrome 147,
 * `Map.prototype.getOrInsertComputed` sets Firefox 144). That excludes
 * supported browsers — Firefox ESR 140, and any Chromium-based browser or
 * managed fleet still on a Chromium older than 147. The declared floor makes
 * them refuse the install up front instead.
 *
 * (Alternative the audit offered: `pdfjs-dist/legacy`, which is transpiled and
 * polyfilled for older browsers and would lower both floors. Not taken so far;
 * switching is the lever if those users matter more than the modern build's
 * size and speed.)
 */

/** @type {ReadonlyArray<{ api: string, needle: string, chrome: number, firefox: number, why: string }>} */
export const REQUIRED_APIS = [
  {
    api: 'Math.sumPrecise',
    needle: 'Math.sumPrecise(',
    chrome: 147,
    firefox: 137,
    why: 'pdf.js font rebuilding (TrueType/CFF conversion)'
  },
  {
    api: 'Map.prototype.getOrInsertComputed',
    needle: '.getOrInsertComputed(',
    chrome: 145,
    firefox: 144,
    why: 'pdf.js core and display caches'
  },
  {
    api: 'Uint8Array.fromBase64',
    needle: 'Uint8Array.fromBase64(',
    chrome: 140,
    firefox: 133,
    why: 'pdf.js XFA image data'
  },
  {
    api: 'Promise.try',
    needle: 'Promise.try(',
    chrome: 128,
    firefox: 134,
    why: 'pdf.js worker message handler'
  },
  {
    api: 'URL.parse',
    needle: 'URL.parse(',
    chrome: 126,
    firefox: 126,
    why: 'pdf.js URL handling'
  },
  {
    api: 'Promise.withResolvers',
    needle: 'Promise.withResolvers(',
    chrome: 119,
    firefox: 121,
    why: 'pdf.js everywhere'
  },
  {
    api: 'module workers (new Worker(url, { type: "module" }))',
    needle: '',
    chrome: 80,
    firefox: 114,
    why: 'vite.config.ts worker.format = "es"'
  },
  {
    api: 'background.type: "module" (Firefox MV3 event page)',
    needle: '',
    chrome: 91,
    firefox: 112,
    why: 'background.js is an ES module'
  }
];

export const MIN_CHROME_VERSION = Math.max(...REQUIRED_APIS.map(entry => entry.chrome));
export const MIN_FIREFOX_VERSION = Math.max(...REQUIRED_APIS.map(entry => entry.firefox));

/** The `browser_specific_settings.gecko.strict_min_version` string. */
export const GECKO_STRICT_MIN_VERSION = `${MIN_FIREFOX_VERSION}.0`;
