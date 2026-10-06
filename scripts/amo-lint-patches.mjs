/**
 * AMO review — build-time patches that remove dead `eval`-family code and an
 * unused `innerHTML` sink from third-party libraries, so Mozilla's
 * `addons-linter` has nothing to warn about there. Every entry is documented
 * for reviewers in `docs/AMO_SOURCE_BUILD.md` ("Build-time library patches").
 *
 * Rules, because these edit code we do not own:
 *  - Each patch names one file (by its path inside its package) and one exact
 *    source string. No regexes over code.
 *  - The string must occur exactly `count` times in that file, or the build
 *    fails — so a library upgrade that changes the code cannot silently undo a
 *    patch or apply it somewhere unintended.
 *  - Every patch must be used by the build ({@link assertAllPatchesApplied}),
 *    so one whose file stopped being bundled is noticed and removed.
 *  - A patch only removes a path that cannot run in a supported browser (a
 *    polyfill fallback for a missing `globalThis`/`Function.prototype.bind`,
 *    code generation gated off whenever `navigator` exists), or one nothing in
 *    this codebase uses (`_.template`, `dangerouslySetInnerHTML` — the latter
 *    banned by an ESLint rule). The extension CSP has no `'unsafe-eval'`, so
 *    every removed `Function(...)` call would throw `EvalError` there anyway.
 *
 * Behaviour in the browser is unchanged; the CSP is unchanged.
 */

/**
 * @typedef {object} LibraryPatch
 * @property {string} name     Short label for errors and the docs.
 * @property {string} file     Path suffix of the module, from its package dir.
 * @property {string} find     Exact source text to replace.
 * @property {string} replace  Replacement text.
 * @property {number} [count]  Exact number of occurrences required (default 1).
 */

/** @type {LibraryPatch[]} */
export const LIBRARY_PATCHES = [
  // ── regenerator-runtime 0.13.11 (via tesseract.js 7, OCR worker) ────────
  // The strict-mode escape hatch: `globalThis` exists in every target browser,
  // so the `else` branch is unreachable.
  {
    name: 'regenerator-runtime: Function() global assignment',
    file: '/node_modules/regenerator-runtime/runtime.js',
    find: '    Function("r", "regeneratorRuntime = r")(runtime);',
    replace: '    /* stapler: unreachable (globalThis always exists); Function() removed */'
  },

  // ── underscore 1.13.8 (via mammoth, Word→PDF in convert.worker) ─────────
  // `self` is the global in a worker and on a page, so the `Function` fallback
  // never runs.
  {
    name: 'underscore: Function("return this") root',
    file: '/node_modules/underscore/modules/_setup.js',
    find: "          Function('return this')() ||",
    replace: '          globalThis ||'
  },
  // `_.template` compiles a string with `new Function`. Neither mammoth nor
  // its dependencies call it, and the CSP would refuse it anyway.
  {
    name: 'underscore: _.template new Function',
    file: '/node_modules/underscore/modules/template.js',
    find: "    render = new Function(argument, '_', source);",
    replace:
      "    throw new Error('Stapler: _.template is disabled (it compiles strings with new Function, which the CSP forbids)');"
  },

  // ── bluebird 3.4.7 (via mammoth) ────────────────────────────────────────
  // Bluebird generates specialised functions with `new Function` only when
  // `util.canEvaluate` is true, and that is `typeof navigator == "undefined"`
  // — false on every page and in every worker. Pinning it to `false` and
  // turning the code-generation blocks off is exactly the browser behaviour;
  // the minifier then drops the dead generators.
  {
    name: 'bluebird join: canEvaluate',
    file: '/node_modules/bluebird/js/release/join.js',
    find: 'var canEvaluate = util.canEvaluate;',
    replace: 'var canEvaluate = false; /* stapler: always false in a browser */'
  },
  {
    name: 'bluebird join: code generation block',
    file: '/node_modules/bluebird/js/release/join.js',
    find: 'if (canEvaluate) {\n    var thenCallback = function(i) {',
    replace: 'if (false) {\n    var thenCallback = function(i) {'
  },
  {
    name: 'bluebird call_get: canEvaluate',
    file: '/node_modules/bluebird/js/release/call_get.js',
    find: 'var canEvaluate = util.canEvaluate;',
    replace: 'var canEvaluate = false; /* stapler: always false in a browser */'
  },
  {
    name: 'bluebird call_get: code generation block',
    file: '/node_modules/bluebird/js/release/call_get.js',
    find: 'if (!false) {\nvar makeMethodCaller = function (methodName) {',
    replace: 'if (false) {\nvar makeMethodCaller = function (methodName) {'
  },
  {
    name: 'bluebird promisify: canEvaluate',
    file: '/node_modules/bluebird/js/release/promisify.js',
    find: 'var canEvaluate = util.canEvaluate;',
    replace: 'var canEvaluate = false; /* stapler: always false in a browser */'
  },
  {
    name: 'bluebird promisify: code generation block',
    file: '/node_modules/bluebird/js/release/promisify.js',
    find: 'var makeNodePromisifiedEval;\nif (!false) {',
    replace: 'var makeNodePromisifiedEval;\nif (false) {'
  },

  // ── jszip 3.10.1 dist (via mammoth / pptxgenjs) — bundled setimmediate ──
  // The polyfill accepts a *string* callback and evals it. JSZip only ever
  // passes functions; a string now throws instead of being evaluated (under
  // the CSP it threw EvalError already).
  {
    name: 'jszip.min: setImmediate string callback',
    file: '/node_modules/jszip/dist/jszip.min.js',
    find: '"function"!=typeof e&&(e=new Function(""+e))',
    replace:
      '"function"!=typeof e&&(e=function(){throw new TypeError("setImmediate: callback must be a function")})'
  },

  // ── docx 9.7.1 dist (PDF→Word, convert.worker) — bundled Node polyfills ──
  {
    name: 'docx: setImmediate string callback',
    file: '/node_modules/docx/dist/index.mjs',
    find: '"function" != typeof e && (e = new Function("" + e));',
    replace:
      '"function" != typeof e && (e = function() { throw new TypeError("setImmediate: callback must be a function"); });'
  },
  // function-bind's implementation is only used when `Function.prototype.bind`
  // is missing (`module.exports = Function.prototype.bind || implementation`).
  {
    name: 'docx: function-bind fallback',
    file: '/node_modules/docx/dist/index.mjs',
    find: 'bound = Function("binder", "return function (" + joiny(boundArgs, ",") + "){ return binder.apply(this,arguments); }")(binder);',
    replace: 'bound = function() { return binder.apply(this, arguments); };'
  },
  // get-intrinsic's table entry for `%eval%`; nothing asks for that intrinsic.
  {
    name: 'docx: get-intrinsic %eval%',
    file: '/node_modules/docx/dist/index.mjs',
    find: '"%eval%": eval,',
    replace: '"%eval%": void 0,'
  },
  // is-generator-function obtains the GeneratorFunction prototype by
  // evaluating a string; a generator literal yields the same prototype.
  {
    name: 'docx: is-generator-function probe',
    file: '/node_modules/docx/dist/index.mjs',
    find: 'return Function("return function*() {}")();',
    replace: 'return function* () {};'
  },

  // ── preact 10.29.8 — dangerouslySetInnerHTML ────────────────────────────
  // The only innerHTML write in the renderer. Stapler never passes
  // `dangerouslySetInnerHTML` (ESLint forbids it, eslint.config.js), so the
  // branch is unreachable; reaching it now throws instead of writing markup.
  {
    name: 'preact: dangerouslySetInnerHTML',
    file: '/node_modules/preact/dist/preact.module.js',
    find: '(u.innerHTML=h.__html)',
    replace: '(()=>{throw new Error("Stapler: dangerouslySetInnerHTML is disabled")})()'
  }
];

/**
 * tesseract.js 7's prebuilt nested worker (`dist/worker.min.js`), copied
 * verbatim into `ocr/` by `stapler:tesseract-assets`. Same two dead
 * `globalThis` fallbacks as above, in webpack-minified form.
 * @type {Omit<LibraryPatch, 'file'>[]}
 */
export const TESSERACT_WORKER_PATCHES = [
  {
    name: 'tesseract worker: regenerator-runtime Function() global assignment',
    find: ':Function("r","regeneratorRuntime = r")(i)}',
    replace: ':void 0}'
  },
  {
    name: 'tesseract worker: webpack global Function("return this")',
    find: 'try{return this||new Function("return this")()}',
    replace: 'try{return this}'
  }
];

function countOccurrences(code, find) {
  let n = 0;
  for (let i = code.indexOf(find); i !== -1; i = code.indexOf(find, i + find.length)) n++;
  return n;
}

/** Applies `patches` to `code`, failing loudly unless each matches exactly. */
export function applyExactPatches(code, patches, where) {
  let out = code;
  for (const patch of patches) {
    const expected = patch.count ?? 1;
    const found = countOccurrences(out, patch.find);
    if (found !== expected) {
      throw new Error(
        `stapler:amo-lint-patches — "${patch.name}" expected ${expected} exact match(es) in ` +
          `${where}, found ${found}. The library changed: re-check the patch in ` +
          `scripts/amo-lint-patches.mjs and docs/AMO_SOURCE_BUILD.md.`
      );
    }
    out = out.split(patch.find).join(patch.replace);
  }
  return out;
}

/** The library patches that apply to module `id` (an absolute path). */
export function patchesFor(id) {
  const path = id.split('?')[0].replaceAll('\\', '/');
  return LIBRARY_PATCHES.filter(p => path.endsWith(p.file));
}

/** Patches `worker.min.js` from tesseract.js. */
export function patchTesseractWorker(code) {
  return applyExactPatches(code, TESSERACT_WORKER_PATCHES, 'tesseract.js/dist/worker.min.js');
}

/** Names of the library patches applied so far in this process. */
const applied = new Set();

export function assertAllPatchesApplied() {
  const missing = LIBRARY_PATCHES.filter(p => !applied.has(p.name)).map(p => p.name);
  if (missing.length) {
    throw new Error(
      `stapler:amo-lint-patches — these patches never matched a bundled module: ` +
        `${missing.join('; ')}. Remove them (and their docs entry) or fix the file path.`
    );
  }
}

/**
 * The Vite plugin. Add it to both `plugins` and `worker.plugins`; pass
 * `{ verify: true }` on the page build only — its `generateBundle` runs after
 * every worker bundle has been built.
 * @returns {import('vite').Plugin}
 */
export function amoLintPatches({ verify = false } = {}) {
  return {
    name: 'stapler:amo-lint-patches',
    apply: 'build',
    enforce: 'pre',
    transform(code, id) {
      const patches = patchesFor(id);
      if (!patches.length) return null;
      const out = applyExactPatches(code, patches, id);
      for (const p of patches) applied.add(p.name);
      return { code: out, map: null };
    },
    generateBundle() {
      if (verify) assertAllPatchesApplied();
    }
  };
}
