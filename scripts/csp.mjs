/**
 * The one Content-Security-Policy both builds ship (audit 2026-09-25 PLT-3 /
 * PLT-4).
 *
 *  - The extension carries it as `content_security_policy.extension_pages` in
 *    `public/manifest.json` (a static file, so it is written out there by hand;
 *    `tests/unit/csp.test.ts` fails if the two ever differ).
 *  - The website twin gets it as a `<meta http-equiv>` injected into every
 *    entry page by the `stapler:web-csp` plugin in `vite.config.ts` — GitHub
 *    Pages cannot set response headers, so a meta tag is the only option.
 *
 * `default-src 'self'` is what makes this a backstop rather than a partial
 * list: an image beacon, a remote stylesheet, font or iframe is refused, not
 * just scripts and fetches. The only remote source anywhere is in
 * `connect-src`, and it is path-scoped to the exact pinned OCR model
 * directories (`src/core/ocr/model.ts`) — not the whole CDN host, which would
 * also allow fetching any other npm package's files (and, with
 * `'wasm-unsafe-eval'`, instantiating remote WASM).
 *
 * Notes on the non-obvious sources:
 *  - `worker-src 'self'` only — Chrome refuses to load an MV3 extension whose
 *    `extension_pages` CSP puts `blob:` in `worker-src` (verified: the
 *    unpacked build does not load at all). Every Stapler worker is a bundled
 *    module; tesseract's blob wrapper is disabled (`workerBlobURL: false`).
 *    HEIC decodes in the bundled `image.worker.ts` (libheif-js WASM, no
 *    eval) — audit CONV-1 replaced heic2any, whose blob worker needed both.
 *  - `style-src 'unsafe-inline'` — the one known need is `public/privacy.html`,
 *    a static page with an inline `<style>` element (it is copied verbatim,
 *    outside the bundle, so it cannot link `tokens.css`). The editor itself
 *    sets styles only through Preact `style={…}` props, which write
 *    `element.style` (CSSOM) and are not governed by `style-src` at all; pdf.js
 *    and pptxgenjs, once the reason given here, now run only inside workers,
 *    which have no DOM. Whether anything else on a page still injects a
 *    `<style>` element or `style="…"` attribute at run time has not been
 *    verified in a browser (audit 2026-10-10), so the source stays until that
 *    is checked; a hash of privacy.html's block could then replace it. Styles
 *    cannot fetch anything here either way, because `img-src`/`font-src`
 *    stay local.
 *
 * Where the policy does *not* reach (audit 2026-10-01 PLT-2):
 *  - Workers on the website. A `<meta>` CSP governs only the document it is
 *    in; a dedicated worker takes its policy from its own script's response
 *    headers, and GitHub Pages sends none. So on the website a `fetch()`
 *    inside a worker was not blocked (probed: it reached the network, while
 *    the extension — whose manifest CSP does cover its workers — refused it).
 *    The backstop is `src/core/workers/network-guard.ts`, imported first by
 *    every `*.worker.ts` entry: it wraps `fetch`, `XMLHttpRequest#open`
 *    (on the prototype), `importScripts`, `Cache#add`/`addAll`, `FontFace`
 *    with a `url()` source, and `new Worker`/`SharedWorker` (same-origin
 *    scripts only), and refuses `WebSocket`/`WebSocketStream`/`EventSource`/
 *    `WebTransport`/`RTCPeerConnection`, allowing this `connect-src` minus its
 *    remote source (self, `blob:`, `data:` — `network-policy.ts`). Each input
 *    is normalised the way the real API reads it (`toString()`), and that
 *    normalised value is what is both checked and forwarded (audit
 *    2026-10-10 S3). The pinned OCR paths are
 *    not needed there: the model is downloaded on the main thread, under the
 *    meta CSP; `tests/unit/network-guard-worker.test.ts` keeps any future
 *    worker allowlist a subset of `OCR_MODEL_CONNECT_SOURCES`.
 *  - Still uncovered there: the *inside* of tesseract's vendored nested
 *    worker (`ocr/worker.min.js`, copied verbatim, so nothing can be imported
 *    into it — the guard only ensures it is started from a same-origin
 *    script, and it is only ever given same-origin paths and a `langPath`
 *    that cannot reach the network), a dynamic `import()` or a static
 *    `import` in a module worker of a remote URL (no global to wrap; the
 *    source and bundle scans forbid any non-relative specifier), and the
 *    service worker `sw.js`, which issues no request except Cache API reads
 *    of this build's own files. The guard is a backstop against a
 *    dependency's stray request, not a sandbox: code that is already hostile
 *    inside a worker is out of its scope.
 *  - `frame-ancestors`/`report-uri` cannot be set from a meta tag; the policy
 *    uses neither. A host that can send response headers would close all of
 *    the above at once; GitHub Pages cannot.
 *
 * Kept in sync with `.claude/hooks/check-invariants.mjs` (which is a
 * zero-dependency single file and so duplicates the allowlist below).
 */

/** Exact pinned model directories the OCR downloader may request (OCR-01). */
export const OCR_MODEL_CONNECT_SOURCES = [
  'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int/',
  'https://cdn.jsdelivr.net/npm/@tesseract.js-data/hin@1.0.0/4.0.0_best_int/'
];

/** Directive → sources, in the order they are written out. */
export const CSP_DIRECTIVES = {
  'default-src': ["'self'"],
  'script-src': ["'self'", "'wasm-unsafe-eval'"],
  'worker-src': ["'self'"],
  'connect-src': ["'self'", 'blob:', 'data:', ...OCR_MODEL_CONNECT_SOURCES],
  'img-src': ["'self'", 'blob:', 'data:'],
  'style-src': ["'self'", "'unsafe-inline'"],
  'font-src': ["'self'", 'data:'],
  'object-src': ["'none'"],
  'frame-src': ["'none'"],
  'base-uri': ["'none'"],
  'form-action': ["'none'"]
};

export function buildCsp(directives = CSP_DIRECTIVES) {
  return Object.entries(directives)
    .map(([name, sources]) => `${name} ${sources.join(' ')};`)
    .join(' ');
}

export const STAPLER_CSP = buildCsp();

/**
 * Every source each directive may carry — what both invariant checkers
 * enforce. A policy may be *stricter* than `CSP_DIRECTIVES` (drop a source)
 * but never looser.
 */
export const CSP_ALLOWED_SOURCES = Object.fromEntries(
  Object.entries(CSP_DIRECTIVES).map(([name, sources]) => [name, new Set(sources)])
);

/** Directives a policy must declare for the allowlist to mean anything. */
export const CSP_REQUIRED_DIRECTIVES = ['default-src', 'script-src', 'object-src', 'base-uri'];

/** Every problem with `csp` against the allowlist, as human-readable strings. */
export function cspFindings(csp) {
  const out = [];
  const seen = new Set();
  for (const directive of csp
    .split(';')
    .map(d => d.trim())
    .filter(Boolean)) {
    const [name, ...sources] = directive.split(/\s+/);
    seen.add(name);
    const allowed = CSP_ALLOWED_SOURCES[name];
    if (!allowed) {
      out.push(`CSP directive "${name}" is not in the allowlist (scripts/csp.mjs).`);
      continue;
    }
    for (const source of sources) {
      if (!allowed.has(source)) {
        out.push(
          `CSP directive "${name}" allows "${source}" — not in the allowlist (scripts/csp.mjs). ` +
            `Only connect-src may name a remote source, and only the exact pinned OCR model ` +
            `paths. See PLAN §5.4 item 5.`
        );
      }
    }
  }
  for (const name of CSP_REQUIRED_DIRECTIVES) {
    if (!seen.has(name)) out.push(`CSP is missing the required "${name}" directive.`);
  }
  return out;
}
