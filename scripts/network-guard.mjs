/**
 * Zero-network analyzer (CLAUDE.md invariant #1) — audit 2026-09-25 PLT-6.
 *
 * Shared by the PostToolUse hook (`.claude/hooks/check-invariants.mjs`, one
 * file per call), the whole-repo guard (`scripts/check-invariants.mjs`, run by
 * `pnpm check`) and the post-build bundle scan (`scripts/check-bundle-network.mjs`).
 *
 * The regex guards it replaces matched `fetch(` on one line, so an alias
 * (`const f = fetch`), a computed key (`globalThis['fe' + 'tch']`), a call
 * split over two lines, a line starting with `*`, or any URL sink that is not
 * a network *API* (`img.src = 'https://…'`, CSS `url()`, `new Worker(url)`)
 * went straight past them. This version parses:
 *
 *  - TS / TSX / JS / MJS with the TypeScript compiler API, one throwaway
 *    Program per file (noLib, noResolve) so the checker can tell a global
 *    `fetch` from a local binding and follow `const` aliases and constant
 *    string expressions ('fe' + 'tch', templates, `[..].join('')`, `atob`).
 *  - CSS with comments and escapes removed: `url()`, `@import`, `image-set()`.
 *  - HTML with a small tag/attribute tokenizer: resource attributes, meta
 *    refresh, `style=` and inline `<style>` (as CSS), inline `<script>` and
 *    `on*=` handlers (as JS), `srcdoc` (as HTML).
 *
 * Comments are never scanned (they are not code); every string that is code
 * is, whatever its line starts with.
 *
 * What is flagged in scripts (mode 'source'):
 *  - any value reference to a network global (NETWORK_GLOBALS) that is not a
 *    local binding — called, aliased, passed, `new`-ed or extended — and any
 *    binding *named* like one (so a shadowing import can't launder it);
 *  - the same names read as a property/element of the global object (window,
 *    self, globalThis, top, parent, frames, opener, document.defaultView, and
 *    local aliases of them), with element keys resolved through constant
 *    folding; a key that cannot be resolved is flagged as unverifiable;
 *    `sendBeacon`/`importScripts`/`XMLHttpRequest`… as a property of anything;
 *  - destructuring / spreading / enumerating the global object
 *    (`const { fetch: f } = self`, `Object.values(window)`, `Reflect.get(...)`);
 *  - `eval`, `Function(...)`, `.constructor('code')`, string `setTimeout` and
 *    `with` — dynamic code the analyzer cannot see into;
 *  - `import`/`export … from`, `import()`, `require()` with a remote or
 *    `data:`/`blob:` specifier, and `import()` of a specifier that is not
 *    statically relative or bare;
 *  - `new Worker/SharedWorker(x)` unless `x` is statically same-origin;
 *    `new Audio/Request(remote)`, `serviceWorker.register`/`addModule(remote)`;
 *  - a remote URL assigned to `.src/.href/.action/.data/.srcset/.poster/…`,
 *    to `location`, set with `setAttribute`, given as `src:` in an object
 *    literal, or passed to `open()` / `location.assign|replace()` / `navigate()`;
 *  - JSX resource attributes (`<img src>`, `<iframe src>`, `<link href>`…)
 *    with a remote value (`<a href>` is user navigation and is allowed);
 *  - CSS or HTML *inside* a string or template that loads a remote URL, and
 *    any string naming a known CDN / analytics host.
 *
 * Mode 'bundle' (third-party code in dist/) keeps only the remote-URL sink
 * rules: bundled libraries legitimately reference `fetch` for code paths the
 * app never takes (the CSP and the extension e2e project cover those).
 *
 * Allowed without analysis: `src/core/ocr/model.ts` and
 * `src/core/ocr/download.ts`, the one consented, pinned, hash-verified model
 * download, and `src/core/workers/network-guard.ts`, which wraps the network
 * APIs inside workers so they refuse remote URLs (audit 2026-10-01 PLT-2). `src/platform/pwa/passthrough.ts` forwards a
 * held same-origin GET unchanged from the web service worker (PLT-4). `src/core/ocr/devanagariFont.ts` may call `fetch()` only with a
 * statically same-origin target (its bundled font).
 */
import ts from 'typescript';

/** The one documented exception to zero-network (CLAUDE.md invariant #1). */
export const NETWORK_ALLOWED_FILES = new Set([
  'src/core/ocr/model.ts',
  'src/core/ocr/download.ts',
  // Audit 2026-10-01 PLT-2: the worker-side backstop. It names `fetch`,
  // `XMLHttpRequest` and `importScripts` only to *replace* them with versions
  // that refuse remote URLs; the URL rule it applies lives in the analysed
  // `src/core/workers/network-policy.ts`.
  'src/core/workers/network-guard.ts',
  // Audit 2026-10-01 PLT-4 follow-up: the web service worker's passthrough.
  // A request it held after a restart and then found not to be a kept file
  // is forwarded to the network unchanged (`fetch(event.request)`), exactly as
  // if the worker had not intercepted it. No static check can prove a runtime
  // `Request` same-origin, so the file proves it itself: it forwards only a
  // GET to the worker's own origin (`isPassThroughAllowed`, unit-tested in
  // tests/unit/pwa-sw-routing.test.ts) and does nothing else — no URL is
  // built, no header added, nothing stored. Never a remote URL.
  'src/platform/pwa/passthrough.ts'
]);

/**
 * Files that may call `fetch()` — but only on a target the analyzer can prove
 * is same-origin (`new URL('./relative', import.meta.url)` and the like).
 * `devanagariFont.ts` reads its bundled font file this way.
 */
export const SAME_ORIGIN_FETCH_FILES = new Set(['src/core/ocr/devanagariFont.ts']);

/** Globals that open a connection (or load remote script) when referenced at all. */
export const NETWORK_GLOBALS = new Set([
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'WebTransport',
  'RTCPeerConnection',
  'webkitRTCPeerConnection',
  'mozRTCPeerConnection',
  'importScripts'
]);

/** Names distinctive enough to flag as a property of *any* object. */
const DISTINCTIVE_PROPS = new Set([...NETWORK_GLOBALS, 'sendBeacon']);
DISTINCTIVE_PROPS.delete('fetch'); // `cache.fetch()` etc. — only flagged on the global object

/** Flagged when read from the global object. */
const GLOBAL_OBJECT_PROPS = new Set([...NETWORK_GLOBALS, 'sendBeacon', 'eval', 'Function']);

const GLOBAL_OBJECT_NAMES = new Set([
  'window',
  'self',
  'globalThis',
  'top',
  'parent',
  'frames',
  'opener'
]);

/** DOM properties whose assignment makes the browser request the URL (or navigate). */
const URL_PROPS = new Set([
  'src',
  'href',
  'action',
  'formAction',
  'data',
  'srcset',
  'srcSet',
  'imageSrcset',
  'poster',
  'background',
  'ping',
  'codebase'
]);

/** Attribute names (lower-cased) that load or navigate to a URL. */
const URL_ATTRS = new Set([
  'src',
  'href',
  'xlink:href',
  'action',
  'formaction',
  'data',
  'poster',
  'background',
  'codebase',
  'manifest'
]);
const SRCSET_ATTRS = new Set(['srcset', 'imagesrcset']);

/** Known CDN / analytics / telemetry hosts — never legitimate in shipped source. */
const KNOWN_REMOTE_HOSTS =
  /\b(?:googleapis\.com|gstatic\.com|jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|esm\.sh|skypack\.dev|jspm\.io|googletagmanager\.com|google-analytics\.com|doubleclick\.net|sentry\.io|segment\.(?:io|com)|mixpanel\.com|hotjar\.com|amplitude\.com|posthog\.com|datadoghq\.com|bugsnag\.com|plausible\.io|cloudflareinsights\.com|facebook\.net)\b/i;

const SCRIPT_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

// ---------------------------------------------------------------------------
// URL classification

const REMOTE_SCHEME = /^(?:https?|wss?|ftp):/i;
const ANY_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * What the URL parser would see: tabs/newlines are removed anywhere, leading
 * C0 controls and spaces are trimmed, and `\` means `/` for http(s) URLs — so
 * `' \\\\evil.example'` and `'ht\ttps://…'` are both remote.
 */
function normalizeUrl(s) {
  return s
    .replace(/[\t\n\r]/g, '')
    .replace(/^[\u0000- ]+/, '')
    .replace(/\\/g, '/');
}

/** 'remote' for http(s)/ws(s)/ftp and protocol-relative URLs, else 'local'. */
export function classifyUrl(s) {
  const u = normalizeUrl(s);
  return REMOTE_SCHEME.test(u) || u.startsWith('//') ? 'remote' : 'local';
}

/** Classify a string of which only the first `prefix` characters are known. */
function classifyPrefix(prefix) {
  const u = normalizeUrl(prefix);
  if (!u) return 'unknown';
  if (REMOTE_SCHEME.test(u) || u.startsWith('//')) return 'remote';
  if (ANY_SCHEME.test(u)) return 'local';
  if (/^\.{1,2}\//.test(u) || /^\/[^/]/.test(u)) return 'local';
  if (/^[^:/?#]+[/?#]/.test(u)) return 'local'; // a relative path segment, before any ':'
  return 'unknown';
}

const worst = (...kinds) =>
  kinds.includes('remote') ? 'remote' : kinds.includes('unknown') ? 'unknown' : 'local';

function srcsetRemote(value) {
  return value
    .split(',')
    .map(c => c.trim().split(/\s+/)[0] ?? '')
    .some(u => u && classifyUrl(u) === 'remote');
}

// ---------------------------------------------------------------------------
// CSS

function stripCssComments(text) {
  let out = '';
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      out += c;
      if (c === '\\' && i + 1 < text.length) out += text[++i];
      else if (c === quote || c === '\n') quote = null;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop - 1;
    } else {
      if (c === '"' || c === "'") quote = c;
      out += c;
    }
  }
  return out;
}

/** CSS escapes (`u\72l(`, `\68ttps`) decoded; a hex escape eats one space/tab, never a newline. */
function decodeCssEscapes(text) {
  return text.replace(/\\(?:([0-9a-fA-F]{1,6})[ \t]?|([^\n0-9a-fA-F]))/g, (_, hex, ch) => {
    if (ch !== undefined) return ch;
    const cp = parseInt(hex, 16);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '�';
  });
}

const lineOf = (text, index) => {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
};

/** Remote loads in a stylesheet (or a `style=` attribute / CSS-in-JS string). */
export function analyzeCss(text, { lineOffset = 0 } = {}) {
  const findings = [];
  let css = decodeCssEscapes(stripCssComments(text));
  // `@namespace url(http://www.w3.org/…)` names a namespace; it is never fetched.
  css = css.replace(/@namespace\b[^;]*;?/gi, m => m.replace(/[^\n]/g, ' '));
  const flag = (index, message) =>
    findings.push({ line: lineOffset + lineOf(css, index), message });

  for (const m of css.matchAll(/@import\s+(?:url\(\s*)?(?:"([^"]*)"|'([^']*)'|([^\s;)]+))/gi)) {
    const url = m[1] ?? m[2] ?? m[3] ?? '';
    if (classifyUrl(url) === 'remote')
      flag(m.index, `CSS @import of a remote stylesheet (${url}) — bundle it locally`);
  }
  for (const m of css.matchAll(/\b(?:url|src)\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\)?/gi)) {
    const url = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (classifyUrl(url) === 'remote')
      flag(m.index, `CSS url() loads a remote resource (${url}) — bundle it locally`);
  }
  for (const m of css.matchAll(/image-set\(([^)]*)\)/gi)) {
    for (const s of m[1].matchAll(/"([^"]*)"|'([^']*)'/g)) {
      const url = s[1] ?? s[2] ?? '';
      if (classifyUrl(url) === 'remote')
        flag(m.index, `CSS image-set() loads a remote resource (${url})`);
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// HTML

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  colon: ':',
  sol: '/',
  bsol: '\\',
  period: '.',
  tab: '\t',
  newline: '\n',
  lpar: '(',
  rpar: ')',
  nbsp: ' '
};

function decodeEntities(s) {
  return s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));?/gi, (m, dec, hex, name) => {
    if (dec) return String.fromCodePoint(Math.min(Number(dec), 0x10ffff));
    if (hex) return String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff));
    const v = NAMED_ENTITIES[name.toLowerCase()];
    return v ?? m;
  });
}

function parseTag(text, i) {
  const m = /^<([a-zA-Z][\w:.-]*)/.exec(text.slice(i, i + 80));
  if (!m) return null;
  const name = m[1].toLowerCase();
  let j = i + m[0].length;
  const attrs = [];
  let selfClosing = false;
  while (j < text.length) {
    while (j < text.length && /\s/.test(text[j])) j++;
    if (text[j] === '>') {
      j++;
      break;
    }
    if (text.startsWith('/>', j)) {
      selfClosing = true;
      j += 2;
      break;
    }
    const an = /^[^\s"'>/=]+/.exec(text.slice(j, j + 200));
    if (!an) {
      j++;
      continue;
    }
    const attr = { name: an[0].toLowerCase(), value: '', index: j };
    j += an[0].length;
    let k = j;
    while (k < text.length && /\s/.test(text[k])) k++;
    if (text[k] === '=') {
      k++;
      while (k < text.length && /\s/.test(text[k])) k++;
      const q = text[k];
      if (q === '"' || q === "'") {
        const end = text.indexOf(q, k + 1);
        const stop = end === -1 ? text.length : end;
        attr.value = text.slice(k + 1, stop);
        j = stop + 1;
      } else {
        const v = /^[^\s>]*/.exec(text.slice(k))[0];
        attr.value = v;
        j = k + v.length;
      }
    }
    attrs.push(attr);
  }
  return { name, attrs, end: j, selfClosing };
}

/** Remote loads in an HTML document or fragment. */
export function analyzeHtml(text, { lineOffset = 0, mode = 'source', depth = 0 } = {}) {
  const findings = [];
  const at = index => lineOffset + lineOf(text, index);
  const flag = (index, message) => findings.push({ line: at(index), message });
  const nested = (list, index) => {
    const base = at(index) - 1;
    for (const f of list) findings.push({ line: base + f.line, message: f.message });
  };

  let i = 0;
  while ((i = text.indexOf('<', i)) !== -1) {
    if (text.startsWith('<!--', i)) {
      const e = text.indexOf('-->', i + 4);
      i = e === -1 ? text.length : e + 3;
      continue;
    }
    if (text[i + 1] === '!' || text[i + 1] === '?') {
      const e = text.indexOf('>', i);
      i = e === -1 ? text.length : e + 1;
      continue;
    }
    const tag = parseTag(text, i);
    if (!tag) {
      i++;
      continue;
    }
    const { name, attrs } = tag;
    const get = n => attrs.find(a => a.name === n)?.value;
    for (const attr of attrs) {
      const an = attr.name;
      const v = decodeEntities(attr.value);
      if (an === 'style') nested(analyzeCss(v), attr.index);
      else if (an === 'srcdoc' && depth < 3)
        nested(analyzeHtml(v, { mode, depth: depth + 1 }), attr.index);
      else if (an.length > 2 && an.startsWith('on') && depth < 3)
        nested(analyzeScript(v, 'inline-handler.js', { mode, depth: depth + 1 }), attr.index);
      else if (SRCSET_ATTRS.has(an)) {
        if (srcsetRemote(v)) flag(attr.index, `remote ${an} on <${name}> — bundle it locally`);
      } else if (an === 'ping') {
        if (v.split(/\s+/).some(u => u && classifyUrl(u) === 'remote'))
          flag(attr.index, `remote ping on <${name}> — tracking beacons are forbidden`);
      } else if (URL_ATTRS.has(an)) {
        // A link the user clicks is navigation, not a request the app makes.
        if ((an === 'href' || an === 'xlink:href') && (name === 'a' || name === 'area')) continue;
        // `<link rel="canonical">` is SEO metadata — never fetched.
        if (an === 'href' && name === 'link' && /\bcanonical\b/i.test(get('rel') ?? '')) continue;
        if (an === 'data' && name !== 'object') continue;
        if (classifyUrl(v) === 'remote')
          flag(attr.index, `remote ${an}="${v}" on <${name}> — breaks the zero-network guarantee`);
      }
    }
    if (name === 'meta' && /refresh/i.test(get('http-equiv') ?? '')) {
      const url = /url\s*=\s*['"]?([^'";]+)/i.exec(decodeEntities(get('content') ?? ''))?.[1];
      if (url && classifyUrl(url) === 'remote') flag(i, `meta refresh to a remote URL (${url})`);
    }

    i = tag.end;
    if ((name === 'script' || name === 'style') && !tag.selfClosing) {
      const close = text.slice(i).search(new RegExp(`</${name}\\s*>`, 'i'));
      const end = close === -1 ? text.length : i + close;
      const body = text.slice(i, end);
      if (name === 'style') nested(analyzeCss(body), i);
      else {
        const type = (get('type') ?? '').trim().toLowerCase();
        if (!type || /^(?:module|(?:text|application)\/(?:java|ecma)script)$/.test(type)) {
          if (depth < 3)
            nested(analyzeScript(body, 'inline-script.js', { mode, depth: depth + 1 }), i);
        } else if (type === 'importmap' || type === 'speculationrules') {
          for (const m of body.matchAll(/"((?:[^"\\]|\\.)*)"/g))
            if (classifyUrl(m[1]) === 'remote')
              flag(i + m.index, `remote URL in <script type="${type}"> (${m[1]})`);
        }
        // Other types (application/ld+json, …) are inert data blocks.
      }
      i = end;
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Scripts

const COMPILER_OPTIONS = {
  noLib: true,
  noResolve: true,
  types: [],
  allowJs: true,
  checkJs: false,
  jsx: ts.JsxEmit.Preserve,
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  noEmit: true
};

function scriptKindFor(fileName) {
  const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
  if (ext === '.tsx') return ts.ScriptKind.TSX;
  if (ext === '.jsx') return ts.ScriptKind.JSX;
  if (ext === '.ts' || ext === '.mts' || ext === '.cts') return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function createChecker(fileName, sourceFile) {
  const host = {
    getSourceFile: name => (name === fileName ? sourceFile : undefined),
    getDefaultLibFileName: () => '/__nolib__.d.ts',
    writeFile: () => {},
    getCurrentDirectory: () => '/',
    getCanonicalFileName: f => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: name => name === fileName,
    readFile: () => undefined,
    getDirectories: () => []
  };
  return ts
    .createProgram({ rootNames: [fileName], options: COMPILER_OPTIONS, host })
    .getTypeChecker();
}

function skipOuter(node) {
  let n = node;
  for (;;) {
    if (!n) return n;
    if (
      ts.isParenthesizedExpression(n) ||
      ts.isAsExpression(n) ||
      ts.isNonNullExpression(n) ||
      ts.isTypeAssertionExpression(n) ||
      (ts.isSatisfiesExpression && ts.isSatisfiesExpression(n))
    )
      n = n.expression;
    else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.CommaToken)
      n = n.right;
    else return n;
  }
}

function isAmbientDeclaration(decl) {
  if (decl.getSourceFile().isDeclarationFile) return true;
  for (let a = decl; a && !ts.isSourceFile(a); a = a.parent) {
    if (
      ts.canHaveModifiers(a) &&
      ts.getModifiers(a)?.some(m => m.kind === ts.SyntaxKind.DeclareKeyword)
    )
      return true;
  }
  return false;
}

function inTypeContext(node) {
  for (let a = node.parent; a && !ts.isSourceFile(a); a = a.parent) {
    if (ts.isTypeNode(a)) {
      // `class X extends WebSocket` — the heritage expression is a value.
      if (
        ts.isExpressionWithTypeArguments(a) &&
        ts.isHeritageClause(a.parent) &&
        a.parent.token === ts.SyntaxKind.ExtendsKeyword &&
        (ts.isClassDeclaration(a.parent.parent) || ts.isClassExpression(a.parent.parent))
      )
        return false;
      return true;
    }
    if (ts.isBlock(a) || ts.isExpressionStatement(a)) return false;
  }
  return false;
}

function isDeclarationName(id) {
  const p = id.parent;
  return (
    (ts.isVariableDeclaration(p) ||
      ts.isParameter(p) ||
      ts.isFunctionDeclaration(p) ||
      ts.isFunctionExpression(p) ||
      ts.isClassDeclaration(p) ||
      ts.isClassExpression(p) ||
      ts.isBindingElement(p) ||
      ts.isImportSpecifier(p) ||
      ts.isImportClause(p) ||
      ts.isNamespaceImport(p) ||
      ts.isImportEqualsDeclaration(p) ||
      ts.isEnumDeclaration(p)) &&
    p.name === id
  );
}

function isValueReference(id) {
  const p = id.parent;
  if (!p) return false;
  if (isDeclarationName(id)) return false;
  if (
    (ts.isPropertyAccessExpression(p) ||
      ts.isPropertyAssignment(p) ||
      ts.isPropertyDeclaration(p) ||
      ts.isPropertySignature(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isMethodSignature(p) ||
      ts.isGetAccessorDeclaration(p) ||
      ts.isSetAccessorDeclaration(p) ||
      ts.isEnumMember(p) ||
      ts.isInterfaceDeclaration(p) ||
      ts.isTypeAliasDeclaration(p) ||
      ts.isModuleDeclaration(p) ||
      ts.isTypeParameterDeclaration(p) ||
      ts.isJsxAttribute(p)) &&
    p.name === id
  )
    return false;
  if (ts.isBindingElement(p) && p.propertyName === id) return false;
  if (ts.isQualifiedName(p) || ts.isMetaProperty(p)) return false;
  if (ts.isExportSpecifier(p) || ts.isNamespaceExport(p)) return false;
  if (ts.isLabeledStatement(p) || ts.isBreakStatement(p) || ts.isContinueStatement(p)) return false;
  if (
    (ts.isJsxOpeningElement(p) || ts.isJsxSelfClosingElement(p) || ts.isJsxClosingElement(p)) &&
    p.tagName === id &&
    /^[a-z]/.test(id.text)
  )
    return false;
  return !inTypeContext(id);
}

/**
 * Analyze one script. `fileName` only picks the dialect (TS/TSX/JS).
 * Returns `{ line, message }[]`.
 */
export function analyzeScript(text, fileName = 'file.ts', options = {}) {
  const { mode = 'source', sameOriginFetch = false, lineOffset = 0, depth = 0 } = options;
  const source = mode === 'source';
  const vname = '/virtual/' + fileName.replace(/^.*[\\/]/, '');
  const sf = ts.createSourceFile(vname, text, ts.ScriptTarget.Latest, true, scriptKindFor(vname));
  const checker = createChecker(vname, sf);
  const findings = [];
  const seen = new Set();
  const lineAt = node => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 + lineOffset;
  const flag = (node, message) => {
    const line = lineAt(node);
    const key = `${line}\u0000${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ line, message });
  };
  const nested = (node, list) => {
    const base = lineAt(node) - 1;
    for (const f of list) {
      const key = `${base + f.line}\u0000${f.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({ line: base + f.line, message: f.message });
    }
  };

  const symbolOf = id => {
    const p = id.parent;
    return p && ts.isShorthandPropertyAssignment(p) && p.name === id
      ? checker.getShorthandAssignmentValueSymbol(p)
      : checker.getSymbolAtLocation(id);
  };

  /** True when `id` is not bound anywhere in this file (or only by `declare`). */
  const isGlobalRef = id => {
    const sym = symbolOf(id);
    if (!sym) return true;
    const decls = sym.declarations ?? [];
    return decls.length === 0 || decls.every(isAmbientDeclaration);
  };
  const isGlobalNamed = (node, name) => {
    const n = skipOuter(node);
    return !!n && ts.isIdentifier(n) && n.text === name && isGlobalRef(n);
  };

  /** Initializer of the variable `id` refers to (any `const`/`let`/`var` in this file). */
  const initializerOf = id => {
    const sym = symbolOf(id);
    if (!sym || sym.flags & ts.SymbolFlags.Alias) return undefined;
    const decl = sym.valueDeclaration;
    if (decl && ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name) && decl.initializer)
      return decl.initializer;
    return undefined;
  };

  // --- constant folding --------------------------------------------------

  const evalString = (node, stack = new Set()) => {
    const n = skipOuter(node);
    if (!n || stack.has(n) || stack.size > 64) return undefined;
    stack.add(n);
    try {
      if (ts.isStringLiteralLike(n)) return n.text;
      if (ts.isNumericLiteral(n)) return n.text;
      if (ts.isTemplateExpression(n)) {
        let s = n.head.text;
        for (const span of n.templateSpans) {
          const v = evalString(span.expression, stack);
          if (v === undefined) return undefined;
          s += v + span.literal.text;
        }
        return s;
      }
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        const l = evalString(n.left, stack);
        if (l === undefined) return undefined;
        const r = evalString(n.right, stack);
        return r === undefined ? undefined : l + r;
      }
      if (ts.isIdentifier(n)) {
        const init = initializerOf(n);
        return init ? evalString(init, stack) : undefined;
      }
      if (ts.isCallExpression(n)) {
        const args = n.arguments;
        const callee = skipOuter(n.expression);
        if (ts.isIdentifier(callee) && isGlobalRef(callee)) {
          const a0 = args[0] && evalString(args[0], stack);
          if (a0 === undefined) return undefined;
          if (callee.text === 'atob') {
            try {
              return Buffer.from(a0, 'base64').toString('latin1');
            } catch {
              return undefined;
            }
          }
          if (callee.text === 'String') return a0;
          if (
            callee.text === 'decodeURIComponent' ||
            callee.text === 'decodeURI' ||
            callee.text === 'unescape'
          ) {
            try {
              return callee.text === 'unescape' ? unescape(a0) : decodeURIComponent(a0);
            } catch {
              return undefined;
            }
          }
          return undefined;
        }
        if (ts.isPropertyAccessExpression(callee)) {
          const method = callee.name.text;
          const obj = skipOuter(callee.expression);
          if (method === 'fromCharCode' || method === 'fromCodePoint') {
            if (!isGlobalNamed(obj, 'String')) return undefined;
            const codes = args.map(a => Number(evalString(a, stack)));
            if (codes.some(c => !Number.isInteger(c) || c < 0 || c > 0x10ffff)) return undefined;
            return String.fromCodePoint(...codes);
          }
          if (method === 'join' && ts.isArrayLiteralExpression(obj)) {
            const parts = obj.elements.map(e => evalString(e, stack));
            if (parts.some(p => p === undefined)) return undefined;
            const sep = args[0] ? evalString(args[0], stack) : ',';
            return sep === undefined ? undefined : parts.join(sep);
          }
          const base = evalString(obj, stack);
          if (base === undefined) return undefined;
          if (method === 'concat') {
            const rest = args.map(a => evalString(a, stack));
            return rest.some(r => r === undefined) ? undefined : base.concat(...rest);
          }
          if (method === 'toLowerCase') return base.toLowerCase();
          if (method === 'toUpperCase') return base.toUpperCase();
          if (method === 'trim') return base.trim();
          if (method === 'toString') return base;
          if (method === 'split' || method === 'reverse') return undefined;
        }
      }
      return undefined;
    } finally {
      stack.delete(n);
    }
  };

  /** The statically known prefix of a string expression: `{ value, full }`. */
  const evalPrefix = (node, stack = new Set()) => {
    const full = evalString(node, stack);
    if (full !== undefined) return { value: full, full: true };
    const n = skipOuter(node);
    if (!n || stack.has(n) || stack.size > 64) return { value: '', full: false };
    stack.add(n);
    try {
      if (ts.isTemplateExpression(n)) {
        let s = n.head.text;
        for (const span of n.templateSpans) {
          const v = evalString(span.expression, stack);
          if (v === undefined) return { value: s, full: false };
          s += v + span.literal.text;
        }
        return { value: s, full: false };
      }
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        const l = evalPrefix(n.left, stack);
        if (!l.full) return l;
        const r = evalPrefix(n.right, stack);
        return { value: l.value + r.value, full: false };
      }
      if (ts.isIdentifier(n)) {
        const init = initializerOf(n);
        return init ? evalPrefix(init, stack) : { value: '', full: false };
      }
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === 'concat'
      ) {
        return { value: evalPrefix(n.expression.expression, stack).value, full: false };
      }
      return { value: '', full: false };
    } finally {
      stack.delete(n);
    }
  };

  // --- global object / location recognition -----------------------------

  const isGlobalObject = (node, d = 0) => {
    const n = skipOuter(node);
    if (!n || d > 8) return false;
    if (ts.isIdentifier(n)) {
      if (GLOBAL_OBJECT_NAMES.has(n.text) && isGlobalRef(n)) return true;
      const init = initializerOf(n);
      return !!init && isGlobalObject(init, d + 1);
    }
    if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) {
      const key = keyOf(n);
      if (key && GLOBAL_OBJECT_NAMES.has(key) && isGlobalObject(n.expression, d + 1)) return true;
      if (key === 'defaultView' && isDocument(n.expression, d + 1)) return true;
      return false;
    }
    if (ts.isBinaryExpression(n)) {
      const k = n.operatorToken.kind;
      if (
        k === ts.SyntaxKind.QuestionQuestionToken ||
        k === ts.SyntaxKind.BarBarToken ||
        k === ts.SyntaxKind.AmpersandAmpersandToken
      )
        return isGlobalObject(n.left, d + 1) || isGlobalObject(n.right, d + 1);
    }
    if (ts.isConditionalExpression(n))
      return isGlobalObject(n.whenTrue, d + 1) || isGlobalObject(n.whenFalse, d + 1);
    return false;
  };
  const memberOfGlobal = (node, name, d = 0) => {
    const n = skipOuter(node);
    if (!n || d > 8) return false;
    if (ts.isIdentifier(n)) {
      if (n.text === name && isGlobalRef(n)) return true;
      const init = initializerOf(n);
      return !!init && memberOfGlobal(init, name, d + 1);
    }
    if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n))
      return keyOf(n) === name && isGlobalObject(n.expression, d + 1);
    return false;
  };
  const isDocument = (node, d = 0) => memberOfGlobal(node, 'document', d);
  const isNavigator = node => memberOfGlobal(node, 'navigator');
  const isLocation = node => {
    if (memberOfGlobal(node, 'location')) return true;
    const n = skipOuter(node);
    return (
      !!n &&
      (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) &&
      keyOf(n) === 'location' &&
      isDocument(n.expression)
    );
  };

  function keyOf(access) {
    if (ts.isPropertyAccessExpression(access))
      return ts.isIdentifier(access.name) ? access.name.text : undefined;
    return evalString(access.argumentExpression);
  }

  // --- URL flow ------------------------------------------------------------

  const isSameOriginBase = node => {
    const n = skipOuter(node);
    if (!n) return false;
    if (
      ts.isPropertyAccessExpression(n) &&
      ts.isMetaProperty(n.expression) &&
      n.name.text === 'url'
    )
      return true; // import.meta.url
    if (isLocation(n)) return true;
    if (
      (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) &&
      ['href', 'origin'].includes(keyOf(n) ?? '') &&
      isLocation(n.expression)
    )
      return true;
    if (ts.isPropertyAccessExpression(n) && n.name.text === 'baseURI' && isDocument(n.expression))
      return true;
    return false;
  };

  /** 'remote' | 'local' | 'unknown' for a URL-valued expression. */
  const urlInfo = (node, d = 0) => {
    const n = skipOuter(node);
    if (!n || d > 12) return 'unknown';
    const p = evalPrefix(n);
    if (p.value) return p.full ? classifyUrl(p.value) : classifyPrefix(p.value);
    if (ts.isNewExpression(n) && isGlobalNamed(n.expression, 'URL')) {
      const [a, b] = n.arguments ?? [];
      if (!a) return 'unknown';
      const pa = evalPrefix(a);
      const ia = pa.value
        ? pa.full
          ? classifyUrl(pa.value)
          : classifyPrefix(pa.value)
        : urlInfo(a, d + 1);
      if (ia === 'remote') return 'remote';
      if (pa.value && ANY_SCHEME.test(normalizeUrl(pa.value))) return ia; // absolute
      if (!b) return ia === 'local' ? 'unknown' : ia;
      if (isSameOriginBase(b)) return ia === 'unknown' ? 'unknown' : 'local';
      return worst(ia, urlInfo(b, d + 1));
    }
    if (ts.isPropertyAccessExpression(n) && ['href', 'toString'].includes(n.name.text))
      return urlInfo(n.expression, d + 1);
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const m = n.expression.name.text;
      if (m === 'toString') return urlInfo(n.expression.expression, d + 1);
      if (m === 'createObjectURL' && isGlobalNamed(n.expression.expression, 'URL')) return 'local';
      if (m === 'getURL') return 'local'; // chrome.runtime.getURL — extension origin
    }
    if (isSameOriginBase(n)) return 'local';
    if (ts.isIdentifier(n)) {
      const init = initializerOf(n);
      return init ? urlInfo(init, d + 1) : 'unknown';
    }
    if (ts.isConditionalExpression(n))
      return worst(urlInfo(n.whenTrue, d + 1), urlInfo(n.whenFalse, d + 1));
    if (ts.isBinaryExpression(n)) {
      const k = n.operatorToken.kind;
      if (k === ts.SyntaxKind.QuestionQuestionToken || k === ts.SyntaxKind.BarBarToken)
        return worst(urlInfo(n.left, d + 1), urlInfo(n.right, d + 1));
    }
    return 'unknown';
  };

  const describe = node => {
    const t = node.getText(sf).replace(/\s+/g, ' ');
    return t.length > 60 ? t.slice(0, 57) + '…' : t;
  };

  // --- rules ---------------------------------------------------------------

  const networkMsg = name =>
    name === 'importScripts'
      ? 'importScripts — MV3 forbids remote code; bundle it instead'
      : `${name} — no runtime network requests are permitted (CLAUDE.md invariant #1)`;

  const allowedSameOriginFetch = node => {
    // `fetch(x)` / `self.fetch(x)` with x provably same-origin, in a file that may do so.
    if (!sameOriginFetch) return false;
    const call = node.parent;
    return (
      !!call &&
      ts.isCallExpression(call) &&
      call.expression === node &&
      call.arguments.length > 0 &&
      urlInfo(call.arguments[0]) === 'local'
    );
  };

  const checkSpecifier = (node, spec, kind) => {
    const p = evalPrefix(spec);
    const info = p.value ? (p.full ? classifyUrl(p.value) : classifyPrefix(p.value)) : 'unknown';
    const s = normalizeUrl(p.value);
    if (info === 'remote' || (p.full && /^(?:data|blob):/i.test(s)))
      flag(node, `${kind} of a remote module (${describe(spec)}) — bundle it locally`);
    else if (info === 'unknown' && source && kind !== 'import declaration')
      flag(
        node,
        `${kind} of a specifier that is not statically relative or bare (${describe(spec)})`
      );
  };

  const flagDestructure = (pattern, node) => {
    // `const { fetch: f } = globalThis` and friends.
    if (ts.isObjectBindingPattern(pattern)) {
      for (const el of pattern.elements) {
        if (el.dotDotDotToken) {
          flag(el, 'rest-destructuring the global object — cannot verify no network API escapes');
          continue;
        }
        let key;
        if (el.propertyName) {
          key = ts.isComputedPropertyName(el.propertyName)
            ? evalString(el.propertyName.expression)
            : el.propertyName.text;
        } else if (ts.isIdentifier(el.name)) key = el.name.text;
        if (key === undefined)
          flag(
            el,
            'computed destructuring of the global object — key cannot be resolved statically'
          );
        else if (GLOBAL_OBJECT_PROPS.has(key)) flag(el, networkMsg(key));
      }
    } else if (ts.isObjectLiteralExpression(pattern)) {
      for (const prop of pattern.properties) {
        if (ts.isSpreadAssignment(prop)) {
          flag(prop, 'rest-destructuring the global object — cannot verify no network API escapes');
          continue;
        }
        const nameNode = prop.name;
        const key = !nameNode
          ? undefined
          : ts.isComputedPropertyName(nameNode)
            ? evalString(nameNode.expression)
            : nameNode.text;
        if (key === undefined)
          flag(
            prop,
            'computed destructuring of the global object — key cannot be resolved statically'
          );
        else if (GLOBAL_OBJECT_PROPS.has(key)) flag(prop, networkMsg(key));
      }
    }
    void node;
  };

  const checkStringContent = node => {
    // CSS / HTML inside a string that is code, and known remote hosts.
    if (inTypeContext(node)) return;
    const p = node.parent;
    if (
      p &&
      (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isExternalModuleReference(p))
    )
      return;
    let text;
    if (ts.isStringLiteralLike(node)) text = node.text;
    else if (ts.isTemplateExpression(node)) {
      text = node.head.text;
      for (const span of node.templateSpans)
        text += (evalString(span.expression) ?? '\u0001') + span.literal.text;
    } else return;
    if (!text) return;
    if (source && KNOWN_REMOTE_HOSTS.test(text))
      flag(
        node,
        `reference to a remote host (${KNOWN_REMOTE_HOSTS.exec(text)[0]}) — breaks the zero-network guarantee`
      );
    if (/url\(|@import|image-set\(/i.test(text)) nested(node, analyzeCss(text));
    if (/<[a-zA-Z]/.test(text) && depth < 3)
      nested(node, analyzeHtml(text, { mode, depth: depth + 1 }));
  };

  const RESOURCE_JSX_TAGS_HREF_EXEMPT = new Set(['a', 'area']);

  const checkJsxAttributes = el => {
    const tag = el.tagName;
    if (!ts.isIdentifier(tag) || !/^[a-z]/.test(tag.text)) return;
    const tagName = tag.text.toLowerCase();
    const attrs = el.attributes.properties;
    const valueOf = a => {
      if (!a.initializer) return undefined;
      if (ts.isStringLiteral(a.initializer)) return a.initializer;
      if (ts.isJsxExpression(a.initializer)) return a.initializer.expression;
      return undefined;
    };
    const attrName = a =>
      ts.isJsxNamespacedName(a.name) ? `${a.name.namespace.text}:${a.name.name.text}` : a.name.text;
    const rel = attrs.find(a => ts.isJsxAttribute(a) && attrName(a).toLowerCase() === 'rel');
    const relValue = rel
      ? (evalString(valueOf(rel) ?? ts.factory.createStringLiteral('')) ?? '')
      : '';
    for (const a of attrs) {
      if (!ts.isJsxAttribute(a)) continue;
      const raw = attrName(a);
      let an = raw.toLowerCase();
      if (an === 'xlinkhref') an = 'xlink:href';
      const value = valueOf(a);
      if (!value) continue;
      if (SRCSET_ATTRS.has(an)) {
        const s = evalString(value);
        if (s !== undefined && srcsetRemote(s))
          flag(a, `remote ${raw} on <${tagName}> — bundle it locally`);
        continue;
      }
      if (!URL_ATTRS.has(an)) continue;
      if ((an === 'href' || an === 'xlink:href') && RESOURCE_JSX_TAGS_HREF_EXEMPT.has(tagName))
        continue;
      if (an === 'href' && tagName === 'link' && /\bcanonical\b/i.test(relValue)) continue;
      if (an === 'data' && tagName !== 'object') continue;
      if (urlInfo(value) === 'remote')
        flag(
          a,
          `remote ${raw} on <${tagName}> (${describe(value)}) — breaks the zero-network guarantee`
        );
    }
  };

  const visit = node => {
    // Identifiers: network globals, eval, shadowing declarations.
    if (ts.isIdentifier(node)) {
      const name = node.text;
      if (source && NETWORK_GLOBALS.has(name)) {
        if (isDeclarationName(node))
          flag(
            node,
            `declares a binding named "${name}", shadowing the network global — rename it`
          );
        else if (
          isValueReference(node) &&
          isGlobalRef(node) &&
          !(name === 'fetch' && allowedSameOriginFetch(node))
        )
          flag(node, networkMsg(name));
      }
      if (source && name === 'eval' && isValueReference(node) && isGlobalRef(node))
        flag(node, 'eval — dynamic code cannot be checked for network access');
    }

    // Member access: window.fetch, globalThis['fe'+'tch'], navigator.sendBeacon…
    if (source && (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))) {
      if (!inTypeContext(node)) {
        const key = keyOf(node);
        if (key !== undefined) {
          if (DISTINCTIVE_PROPS.has(key)) flag(node, networkMsg(key));
          else if (GLOBAL_OBJECT_PROPS.has(key) && isGlobalObject(node.expression)) {
            if (!(key === 'fetch' && allowedSameOriginFetch(node))) flag(node, networkMsg(key));
          }
        } else if (ts.isElementAccessExpression(node)) {
          if (isGlobalObject(node.expression) || isNavigator(node.expression))
            flag(
              node,
              `computed property access on the global object (${describe(node)}) — the key cannot be resolved statically, so it may name a network API`
            );
        }
      }
    }

    if (source && ts.isWithStatement(node))
      flag(node, '`with` statement — scope cannot be checked for network access');

    // Destructuring / spreading the global object.
    if (source) {
      if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && node.initializer) {
        if (
          !ts.isIdentifier(node.name) &&
          (isGlobalObject(node.initializer) || isNavigator(node.initializer))
        )
          flagDestructure(node.name, node);
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isObjectLiteralExpression(node.left) &&
        (isGlobalObject(node.right) || isNavigator(node.right))
      )
        flagDestructure(node.left, node);
      if (
        (ts.isSpreadElement(node) || ts.isSpreadAssignment(node)) &&
        isGlobalObject(node.expression)
      )
        flag(node, 'spreading the global object — cannot verify no network API escapes');
    }

    // Imports.
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier)
      checkSpecifier(node, node.moduleSpecifier, 'import declaration');
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference))
      checkSpecifier(node, node.moduleReference.expression, 'import declaration');

    if (ts.isCallExpression(node)) {
      const callee = skipOuter(node.expression);
      const args = node.arguments;
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        if (args[0]) checkSpecifier(node, args[0], 'dynamic import()');
      } else if (ts.isIdentifier(callee) && isGlobalRef(callee)) {
        const n = callee.text;
        if (n === 'require' && args[0]) checkSpecifier(node, args[0], 'require()');
        if (source && n === 'Function')
          flag(node, 'Function() — dynamic code cannot be checked for network access');
        if (
          source &&
          (n === 'setTimeout' || n === 'setInterval') &&
          args[0] &&
          evalPrefix(args[0]).value
        )
          flag(node, `${n} with a string — dynamic code cannot be checked for network access`);
        if (n === 'open' && args[0] && urlInfo(args[0]) === 'remote')
          flag(node, `open() of a remote URL (${describe(args[0])})`);
      } else if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
        const m = keyOf(callee);
        const obj = callee.expression;
        if (m === 'open' && isGlobalObject(obj) && args[0] && urlInfo(args[0]) === 'remote')
          flag(node, `window.open() of a remote URL (${describe(args[0])})`);
        if (
          (m === 'assign' || m === 'replace') &&
          isLocation(obj) &&
          args[0] &&
          urlInfo(args[0]) === 'remote'
        )
          flag(node, `location.${m}() to a remote URL (${describe(args[0])})`);
        if (m === 'navigate' && args[0] && urlInfo(args[0]) === 'remote')
          flag(node, `navigate() to a remote URL (${describe(args[0])})`);
        if ((m === 'register' || m === 'addModule') && args[0] && urlInfo(args[0]) === 'remote')
          flag(node, `${m}() of a remote script (${describe(args[0])})`);
        if (m === 'setAttribute' || m === 'setAttributeNS') {
          const [nameArg, valueArg] = m === 'setAttribute' ? args : args.slice(1);
          const attr = nameArg && evalString(nameArg)?.toLowerCase();
          if (attr && valueArg) {
            if (SRCSET_ATTRS.has(attr)) {
              const s = evalString(valueArg);
              if (s !== undefined && srcsetRemote(s))
                flag(node, `setAttribute('${attr}') to a remote URL`);
            } else if ((URL_ATTRS.has(attr) || attr === 'ping') && urlInfo(valueArg) === 'remote')
              flag(node, `setAttribute('${attr}') to a remote URL (${describe(valueArg)})`);
          }
        }
        if (source && m === 'constructor' && args.some(a => evalPrefix(a).value))
          flag(
            node,
            '.constructor(code) — the Function constructor; dynamic code cannot be checked'
          );
        if (
          source &&
          (m === 'get' || m === 'getOwnPropertyDescriptor') &&
          (isGlobalNamed(obj, 'Reflect') || isGlobalNamed(obj, 'Object')) &&
          args[0] &&
          (isGlobalObject(args[0]) || isNavigator(args[0]))
        ) {
          const key = args[1] && evalString(args[1]);
          if (key === undefined)
            flag(
              node,
              `${describe(callee)} on the global object with a key that cannot be resolved statically`
            );
          else if (GLOBAL_OBJECT_PROPS.has(key)) flag(node, networkMsg(key));
        }
        if (
          source &&
          ['values', 'entries', 'getOwnPropertyDescriptors', 'assign'].includes(m ?? '') &&
          (isGlobalNamed(obj, 'Object') || isGlobalNamed(obj, 'Reflect')) &&
          args.some(a => isGlobalObject(a))
        )
          flag(
            node,
            `${describe(callee)} over the global object — cannot verify no network API escapes`
          );
      }
    }

    if (ts.isNewExpression(node)) {
      const callee = skipOuter(node.expression);
      let ctor;
      if (ts.isIdentifier(callee) && isGlobalRef(callee)) ctor = callee.text;
      else if (
        (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
        isGlobalObject(callee.expression)
      )
        ctor = keyOf(callee);
      const arg = node.arguments?.[0];
      if ((ctor === 'Worker' || ctor === 'SharedWorker') && arg) {
        const info = urlInfo(arg);
        if (info === 'remote') flag(node, `new ${ctor}() from a remote URL (${describe(arg)})`);
        else if (info === 'unknown' && source)
          flag(
            node,
            `new ${ctor}() target is not statically same-origin (${describe(arg)}) — use new URL('./x', import.meta.url)`
          );
      }
      if ((ctor === 'Audio' || ctor === 'Request') && arg && urlInfo(arg) === 'remote')
        flag(node, `new ${ctor}() of a remote URL (${describe(arg)})`);
      if (source && ctor === 'Function')
        flag(node, 'new Function() — dynamic code cannot be checked for network access');
    }

    // Assignments into URL sinks.
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.EqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken)
    ) {
      const left = skipOuter(node.left);
      if (ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) {
        const key = keyOf(left);
        if (key && (key === 'srcset' || key === 'srcSet' || key === 'imageSrcset')) {
          const s = evalString(node.right);
          if (s !== undefined && srcsetRemote(s)) flag(node, `remote URL assigned to .${key}`);
        } else if (key && URL_PROPS.has(key) && urlInfo(node.right) === 'remote')
          flag(
            node,
            `remote URL assigned to .${key} (${describe(node.right)}) — the browser will request it`
          );
        else if (
          key === 'location' &&
          (isGlobalObject(left.expression) || isDocument(left.expression)) &&
          urlInfo(node.right) === 'remote'
        )
          flag(node, `navigation to a remote URL (${describe(node.right)})`);
      } else if (
        ts.isIdentifier(left) &&
        left.text === 'location' &&
        isGlobalRef(left) &&
        urlInfo(node.right) === 'remote'
      )
        flag(node, `navigation to a remote URL (${describe(node.right)})`);
    }

    // `{ src: 'https://…' }` — handed to Object.assign(img, …) and the like.
    if (ts.isPropertyAssignment(node) && !ts.isComputedPropertyName(node.name)) {
      const key = node.name.text;
      if ((key === 'src' || key === 'poster') && urlInfo(node.initializer) === 'remote')
        flag(node, `remote URL as "${key}" (${describe(node.initializer)})`);
    }

    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) checkJsxAttributes(node);

    if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) checkStringContent(node);

    ts.forEachChild(node, visit);
  };

  visit(sf);
  return findings;
}

// ---------------------------------------------------------------------------
// Entry point

const extOf = rel => {
  const base = rel.replace(/^.*\//, '');
  const dot = base.lastIndexOf('.');
  return dot === -1 ? '' : base.slice(dot).toLowerCase();
};

/**
 * All zero-network findings for one file. `rel` is the repo-relative,
 * forward-slash path (it picks the dialect and the allowlist).
 *
 * @param {string} text
 * @param {string} rel
 * @param {{ mode?: 'source' | 'bundle' }} [options]
 * @returns {{ line: number, message: string }[]}
 */
export function analyzeNetwork(text, rel, { mode = 'source' } = {}) {
  if (mode === 'source' && NETWORK_ALLOWED_FILES.has(rel)) return [];
  const ext = extOf(rel);
  let findings;
  if (ext === '.css') findings = analyzeCss(text);
  else if (ext === '.html' || ext === '.htm') findings = analyzeHtml(text, { mode });
  else if (SCRIPT_EXTS.has(ext))
    findings = analyzeScript(text, rel, {
      mode,
      sameOriginFetch: mode === 'source' && SAME_ORIGIN_FETCH_FILES.has(rel)
    });
  else return [];
  return findings.sort((a, b) => a.line - b.line);
}

/** True for files `analyzeNetwork` understands. */
export function isAnalyzable(rel) {
  const ext = extOf(rel);
  return ext === '.css' || ext === '.html' || ext === '.htm' || SCRIPT_EXTS.has(ext);
}
