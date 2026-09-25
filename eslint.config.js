import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * F-04: the layer boundary, plus blocking dialogs — which freeze the main
 * thread, cannot be themed, and are invisible to the app's own accessibility
 * tree.
 */
const LAYER_GLOBALS = [
  {
    name: 'chrome',
    message: 'chrome.* is not available in the website build. Go through src/platform (PLAN §2.2).'
  },
  {
    name: 'alert',
    message: 'Use notify() from src/core/notify.ts so the message is themed and announced.'
  },
  { name: 'confirm', message: 'Use confirmAction() from src/core/notify.ts.' },
  { name: 'prompt', message: 'Use a Modal with a real form field.' }
];

/**
 * Audit 2026-09-25 PLT-6 — CLAUDE.md invariant #1 as a lint rule, so an
 * aliased `const f = fetch`, a multi-line call, or `new WebTransport` shows up
 * in the editor. The fuller check (computed keys, URL sinks, CSS/HTML) is
 * `scripts/network-guard.mjs`, run by `scripts/check-invariants.mjs` and the
 * PostToolUse hook. The CSP (`scripts/csp.mjs`) is the runtime backstop.
 */
const NETWORK_MESSAGE =
  'No runtime network requests (CLAUDE.md invariant #1). The only exception is the OCR model ' +
  'download in src/core/ocr/download.ts.';
const NETWORK_GLOBALS = [
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'WebTransport',
  'RTCPeerConnection'
].map(name => ({ name, message: NETWORK_MESSAGE }));
const NETWORK_PROPERTIES = [
  ...['window', 'self', 'globalThis'].flatMap(object =>
    NETWORK_GLOBALS.map(({ name }) => ({ object, property: name, message: NETWORK_MESSAGE }))
  ),
  { object: 'navigator', property: 'sendBeacon', message: 'sendBeacon — telemetry is forbidden.' }
];

/**
 * The files allowed to reach the network API at all — kept in sync with
 * `NETWORK_ALLOWED_FILES` / `SAME_ORIGIN_FETCH_FILES` in
 * `scripts/network-guard.mjs`. `devanagariFont.ts` reads a bundled font from
 * its own origin; `download.ts` is the one consented, pinned, hash-verified
 * OCR model download.
 */
const NETWORK_ALLOWED_FILES = ['src/core/ocr/download.ts', 'src/core/ocr/devanagariFont.ts'];

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // `.scratch/` is throwaway probe scripts, not shipped code — linting it only ever
    // fails the build on a file nobody intends to keep.
    ignores: [
      '.claude/**',
      '.scratch/**',
      'dist/**',
      'scripts/**',
      'tests/fixtures/**',
      'playwright-report/**'
    ]
  },
  {
    // Zero network, everywhere in shipped source (platform and service worker too).
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-globals': ['error', ...NETWORK_GLOBALS],
      'no-restricted-properties': ['error', ...NETWORK_PROPERTIES]
    }
  },
  {
    // F-04: the layer boundary. `core/` and `ui/` reach the platform only through the
    // adapter, so the same code builds as an extension and as the website twin.
    // Flat config replaces a rule's options wholesale, so the network list is repeated.
    files: ['src/core/**/*.{ts,tsx}', 'src/ui/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-globals': ['error', ...LAYER_GLOBALS, ...NETWORK_GLOBALS]
    }
  },
  {
    // The only files allowed to call the network API (see NETWORK_ALLOWED_FILES).
    files: NETWORK_ALLOWED_FILES,
    rules: {
      'no-restricted-globals': ['error', ...LAYER_GLOBALS],
      'no-restricted-properties': 'off'
    }
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      // Tests legitimately assert on loosely-typed page evaluation results.
      '@typescript-eslint/no-explicit-any': 'off'
    }
  }
);
