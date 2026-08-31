# Building Stapler from source (AMO reviewer instructions)

This add-on's submitted package is built from this source tree via Vite, which
minifies and bundles the code in `src/`. This document reproduces that build
exactly, per Mozilla's source-code-submission requirement.

## Environment

- **OS:** any of Linux, macOS, or Windows — the build has no OS-specific steps.
- **Node.js:** v20 or later (developed and verified against Node v22.22.2).
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

## Output

The build writes the exact contents of the submitted `.zip` to `dist/firefox/`.
Diffing that directory against the unzipped submission should show no
differences (aside from filesystem metadata).

## Verifying, optionally

```bash
pnpm run check   # typecheck, lint, format, and this project's own invariant
                  # checks (zero raw colours, zero chrome.* outside src/platform/)
pnpm test        # unit test suite (vitest)
```

Neither is required to reproduce the build — both are included only so a
reviewer who wants extra confidence has a way to get it.
