# Building Stapler from source (AMO reviewer instructions)

This add-on's submitted package is built from this source tree via Vite, which
minifies and bundles the code in `src/`. This document reproduces that build
exactly, per Mozilla's source-code-submission requirement.

## Environment

- **OS:** any of Linux, macOS, or Windows — the build has no OS-specific steps.
- **Node.js:** v20 or later. Released packages are built by the GitHub release
  workflow on Ubuntu with **Node v22.23.3** and **pnpm 11.28.5** (0.3.1); use the same
  versions to reproduce the submitted package most closely.
  Download: https://nodejs.org/en/download
- **Package manager:** `pnpm` v11.20.0 or later.
  Install: `npm i -g pnpm` (or `corepack enable` on Node ≥16.10, then `corepack prepare pnpm@latest --activate`).
  Download/docs: https://pnpm.io/installation

No other system dependencies (no native toolchain, no Python, no Rust) are required —
every WASM binary the extension uses (`pdf.js`, `tesseract.js`'s OCR engine, the
face-detector runtime) is a prebuilt npm dependency, not compiled from source
during this build.

## Build steps

```bash
# 1. Install exact dependency versions from the committed lockfile.
pnpm install --frozen-lockfile

# 2. Build the Firefox target.
pnpm run build:ext:firefox
```

`build:ext:firefox` runs `BUILD_TARGET=firefox vite build`, which:

- Bundles and minifies everything under `src/` via Vite/Rolldown (this is the
  step that produces the minified code being reviewed against this source).
- Copies `public/` (icons, `privacy.html`) into the output verbatim.
- Runs the `stapler:firefox-manifest` Vite plugin (`scripts/firefox-manifest.mjs`),
  which transforms `public/manifest.json` into the Firefox-shaped manifest —
  `background.scripts` instead of `background.service_worker`, plus
  `browser_specific_settings.gecko`. That transform is pure and unit-tested at
  `tests/unit/firefox-manifest.test.ts`.

- Applies the `stapler:amo-lint-patches` plugin (`scripts/amo-lint-patches.mjs`) to a
  few third-party files before bundling, and to tesseract.js's prebuilt
  `worker.min.js` as it is copied to `ocr/`. See
  [Build-time library patches](#build-time-library-patches) below.

## Output

The build writes the contents of the submitted `.zip` to `dist/firefox/`. The
submitted package is the one the release workflow (`.github/workflows/release.yml`)
built and tested from the release tag. Rebuilt with the same Node.js and pnpm
versions, `dist/firefox/` should match the unzipped submission (aside from
filesystem metadata); a different Node.js version can change the minified output
by a few bytes without changing behaviour.

## Verifying, optionally

```bash
pnpm run check   # typecheck, lint, format, and this project's own invariant
                  # checks (zero raw colours, zero chrome.* outside src/platform/)
pnpm test        # unit test suite (vitest)
```

Neither is required to reproduce the build — both are included only so a
reviewer who wants extra confidence has a way to get it.

## Build-time library patches

`addons-linter` reported 25 warnings on the 0.3.0 package, all in third-party
libraries and none in Stapler's own source:

- 16 were `Function`/`eval` uses. None of them can run under the extension's CSP
  (`script-src 'self' 'wasm-unsafe-eval'`, with no `'unsafe-eval'`).
- 7 were Preact's `innerHTML` write, which was bundled once in the editor and once
  in each of six workers.
- 2 were pdf.js `import()` calls.

`scripts/amo-lint-patches.mjs` now removes 19 of them at build time: all 16
`Function`/`eval` uses, the editor's Preact `innerHTML` write, and both pdf.js
`import()` calls. The six worker copies of Preact are no longer bundled at all
(explained below the table). `addons-linter` now reports 0 errors, 0 notices and
0 warnings (see [Reproducing the lint](#reproducing-the-lint)).

How the patches are kept safe:

- Each patch names one file inside one package and one exact source string. No regex
  is used on library code.
- The build fails if a string does not occur exactly once in its file, or if a patch
  never matches a bundled module. A library upgrade therefore cannot silently undo
  a patch or move it to the wrong place. `tests/unit/amo-lint-patches.test.ts`
  checks the same against the installed `node_modules`.
- A patch only removes code that cannot run in a supported browser, or code that
  nothing in Stapler calls. Browser behaviour is unchanged, and so is the CSP.
  The one deliberate behaviour change is in the pdf.js row for WebAssembly: a
  case no supported browser reaches now fails with a clear error instead of
  loading a slower pure-JS decoder.

| Library (version) | Where it ships | Removed code | Why the removal is safe |
| --- | --- | --- | --- |
| `regenerator-runtime` 0.13.11 (via `tesseract.js` 7.0.0) | `assets/src-*.js` (OCR worker) | `Function("r", "regeneratorRuntime = r")(runtime)` | This is the `else` branch of `typeof globalThis === "object"`, which is always true in a supported browser. |
| `tesseract.js` 7.0.0 `dist/worker.min.js` (prebuilt, copied to `ocr/worker.min.js`) | `ocr/worker.min.js` | The same regenerator fallback, and webpack's `this \|\| new Function("return this")()` global lookup | Both branches come after a `globalThis` check that always succeeds. The file is patched while it is copied, and is otherwise byte-for-byte the npm file. |
| `underscore` 1.13.8 (via `mammoth` 1.12.2) | `assets/lib-*.js` (convert worker) | `Function('return this')()` in the root lookup, replaced by `globalThis` | `self` matches first in a page and in a worker, so the fallback never ran. |
| `underscore` 1.13.8 | same | `new Function(...)` in `_.template`, replaced by a thrown `Error` | Nothing calls `_.template`: not mammoth, not its dependencies, not Stapler. |
| `bluebird` 3.4.7 (via `mammoth`) | same | Six code generators that build functions from strings (`join.js`, `call_get.js`, `promisify.js`) | Bluebird runs them only when `util.canEvaluate` is true, that is, when `typeof navigator == "undefined"`. That is false in every page and every worker. The patch fixes it at `false` and disables the generator blocks, and the minifier drops them. |
| `jszip` 3.10.1 `dist/jszip.min.js` (via `mammoth`, `pptxgenjs` 4.0.1) | `assets/jszip.min-*.js` | The bundled `setimmediate` polyfill's `new Function("" + callback)` for string callbacks | JSZip only passes functions. A string callback now throws a `TypeError`. Under the CSP it already threw `EvalError`. |
| `docx` 9.7.1 `dist/index.mjs` (its bundled Node polyfills) | `assets/dist-*.js` (convert worker) | The same `setimmediate` string-callback eval | Same as for jszip. |
| `docx` 9.7.1, bundled `function-bind` | same | The `Function("binder", …)` that builds the fallback `bind` | The fallback is used only if `Function.prototype.bind` is missing (`module.exports = Function.prototype.bind \|\| implementation`). |
| `docx` 9.7.1, bundled `get-intrinsic` | same | The table entry `"%eval%": eval` | Nothing asks `GetIntrinsic` for `%eval%`. |
| `docx` 9.7.1, bundled `is-generator-function` | same | `Function("return function*() {}")()`, replaced by the literal `function* () {}` | Both give the same `GeneratorFunction` prototype, without evaluating a string. |
| `pdfjs-dist` 6.2.108 `build/pdf.mjs` | `assets/render.worker-*.js` | The fake-worker fallback in `PDFWorker._setupFakeWorkerGlobal`, `await import(this.workerSrc)`. It now throws an error saying the worker module must be pre-registered | pdf.js runs in-process in the render worker (its "fake worker"; a nested worker would only double the threads). This path was live: it loaded `assets/pdf.worker-*.mjs` on the first document. `src/core/workers/pdfjs-setup.ts` now imports `pdfjs-dist/build/pdf.worker.mjs` statically and sets `globalThis.pdfjsWorker = { WorkerMessageHandler }` before any document is opened. pdf.js checks that global first (`#mainThreadWorkerMessageHandler`), so the `import()` is unreachable. No `workerSrc` is set, and the separate `assets/pdf.worker-*.mjs` file is no longer shipped. Its code is bundled (minified) into the render worker, once. |
| `pdfjs-dist` 6.2.108 `build/pdf.worker.mjs` | `assets/render.worker-*.js` | The `WorkerMessageHandler` static block that calls `initializeFromPort(self)` whenever the module is evaluated in a worker global | Not a linter finding. It is needed by the row above: Stapler never runs this module as its own `Worker`. Left in, it would add a second message listener to the render worker and post a stray `ready` message to the page. |
| `pdfjs-dist` 6.2.108 `build/pdf.worker.mjs` | `assets/render.worker-*.js` | `WasmImage.#getJsModule`'s ``await import(`${wasmUrl}${noWasmFilename}`)``, which loads the pure-JS JPEG 2000 / JBIG2 decoder (`*_nowasm_fallback.js`) when WebAssembly cannot be instantiated. It now throws inside the existing `try` | Every supported browser (the floors in `scripts/browser-floors.mjs`, currently Chrome 147 and Firefox 144) runs WebAssembly, and the CSP allows it (`'wasm-unsafe-eval'`, unchanged). If WebAssembly did fail, pdf.js's `catch` logs the error and the decoder throws `OpenJPEG failed to initialize` / `JBig2 failed to initialize`. pdf.js then records the image as undecodable (`Unable to decode image`), and Stapler's existing paths report it: redaction refuses and names the image, and compression/grayscale leave it untouched and say so. The two `*_nowasm_fallback.js` files (~597 KB) are no longer copied into `pdfjs/wasm/`, because nothing else references them. |
| `preact` 10.29.8 | `assets/releases-*.js` (editor page) | The single `innerHTML` assignment, which serves `dangerouslySetInnerHTML`. It now throws instead | Stapler never uses `dangerouslySetInnerHTML`, and `eslint.config.js` now forbids it, along with `innerHTML`/`outerHTML` assignment, `insertAdjacentHTML`, and `document.write`, anywhere in `src/`. |

Six of the original warnings were not patched. They went away because the code
that triggered them is no longer bundled: each of the six workers (`ocr`, `image`,
`convert`, `render`, `cv`, `process`) carried a full copy of Preact's renderer and
its `innerHTML` line. That copy came only from the i18n module's
`import { signal } from '@preact/signals'`. The module now imports the same `signal`
from `@preact/signals-core`, so no worker contains a DOM renderer.

Not flagged by the linter, but disclosed here: the bundled `get-intrinsic` inside
`docx` still has `getEvalledConstructor`, which calls an aliased `Function` to look
up `%AsyncFunction%` and similar intrinsics. It sits inside a `try`/`catch`. Under
the extension CSP the call throws and the intrinsic is reported as unavailable,
which is how it has always behaved in the extension.

## Reproducing the lint

On `stapler-<version>-firefox.zip`, `addons-linter` reports 0 errors, 0 notices
and 0 warnings. The last two warnings, both pdf.js `import()` calls, are now
patched (the three `pdfjs-dist` rows in the table above). To reproduce the lint, run:

```bash
pnpm package
pnpm dlx addons-linter dist/release/stapler-<version>-firefox.zip
```

