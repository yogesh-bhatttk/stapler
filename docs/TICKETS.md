# Stapler — Story Tickets

Companion to [`PLAN.md`](PLAN.md) and [`DESIGN-ADAPTATION.md`](DESIGN-ADAPTATION.md).

**Sizes:** `XS` <½d · `S` ½–1d · `M` 1–3d · `S`…`L` 3–5d · `XL` >5d
**Priority:** `P0` blocks v1.0 · `P1` v1.1–1.2 · `P2` v2.0+

Each ticket carries a **Status** line, audited against the code rather than against
intent — this file is the single source of truth for per-ticket state (an earlier
parallel `STATUS.md`, and later a `REMAINING-WORK-PLAN.md` snapshot, were both
removed once they drifted out of sync with the entries below — re-derive "what's
left" from this file's Status lines, not from a cached summary of them).
Reproduce the evidence with `pnpm check && pnpm test && pnpm test:e2e`.

Every ticket must satisfy this **definition of done**, in addition to its own criteria:

- [ ] TypeScript strict, no `any` without a written justification
- [ ] Unit tests for pure logic; E2E test if it adds a user-facing flow
- [ ] Works in light **and** dark theme, keyboard-only, and with a screen reader label
- [ ] Long operations are cancellable and report determinate progress
- [ ] No new manifest permission; no new runtime network request
- [ ] No main-thread block >50ms (verify in a performance trace)
- [ ] Errors surface a human-readable message; document bytes are never silently altered
- [ ] Anything touching workers, WASM or a third-party decoder is verified in the loaded
      extension (`dist/ext`), not only the web preview (AUDIT-2026-09-25 M4)
- [ ] Regression tests run the user flow through the real pipeline, including the default
      path where the user skips optional buttons, and assert on real output bytes; a
      "fixed"/"fails CI" claim cites such a test or says it is a manual check
      (AUDIT-2026-09-25 M8)

---

## EPIC-0 · Foundation

### F-01 · Repository and build pipeline — `S` `P0`

**Status: Done** — `build:ext`/`build:web` both emit and load; `pnpm check` green.

Scaffold Vite + Preact + TypeScript (strict) with a multi-target build.

- **Requirements:** `pnpm dev` runs an HMR dev server for `editor.html`; `pnpm build:ext`
  emits an unpacked extension to `dist/ext`; `pnpm build:web` emits the static site to
  `dist/web`; ESLint + Prettier + `tsc --noEmit` wired to `pnpm check`.
- **AC:** `dist/ext` loads via `chrome://extensions` → Load unpacked with zero console
  errors. `pnpm check` passes on a clean tree.

### F-02 · Manifest V3 with zero permissions — `XS` `P0`

**Status: Done** — Asserted in `tests/e2e/manifest.spec.ts`.

- **Requirements:** MV3 manifest; `"permissions": []`; no `host_permissions`; no content
  scripts; `background.service_worker` only; CSP allows no remote code; icons at 16/32/48/128.
- **AC:** Chrome's install dialog shows **no** permission warnings. `manifest.json` contains
  no `optional_permissions` at v1.0.

### F-03 · Service worker: open the editor tab — `XS` `P0`

**Status: Done** — Focuses an existing editor tab rather than opening a second.

- **Requirements:** `chrome.action.onClicked` → `chrome.tabs.create({url: runtime.getURL('editor.html')})`;
  if an editor tab already exists, focus it instead of opening a second. `onInstalled` opens
  the welcome route once.
- **AC:** Clicking the icon twice yields one tab, focused. Service worker holds no other logic.

### F-04 · Platform adapter — `S` `P0`

**Status: Done** — All seven capabilities present; typed FSA wrappers replaced nine `any` casts.

Implement `src/platform/` per PLAN §2.2 with `extension.ts` and `web.ts`.

- **Requirements:** Interface covers `openFiles`, `openDirectory`, `saveFile`,
  `saveFileAs`, `persistHandle`, `restoreHandles`, `revokeHandle`. Extension build uses
  File System Access API; web build falls back to `<input type=file>` + Blob download.
- **AC:** ESLint boundary rule fails the build if anything under `core/` or `ui/` imports
  `chrome.*` directly. Both builds can open and save a file.

### F-05 · Worker infrastructure — `M` `P0`

**Status: Done** — Progress + `AbortSignal` cancellation, and the client factory now pools
real instances up to `min(4, hardwareConcurrency - 1)`, spawning lazily and sharing the
least-busy instance once at the cap. `ocr` worker itself does not exist yet (OCR-01, P2).

- **Requirements:** Comlink-wrapped `render`, `process`, `ocr` workers with typed RPC. A
  shared job protocol supporting `progress(0..1, label)`, `cancel()` via `AbortSignal`, and
  structured error returns. ArrayBuffers transferred, never copied. Worker pool sized to
  `min(4, hardwareConcurrency - 1)`.
- **AC:** A synthetic 10s job reports monotonic progress, cancels within 200ms of request,
  and leaves no orphaned worker. Chrome task manager shows workers terminating on idle.

### F-06 · IndexedDB layer — `S` `P0`

**Status: Done** — Versioned schema, migration hook, quota surfaced as a message. The `documents` store was removed — see `core/store.ts`.

- **Requirements:** `idb`-backed stores: `handles`, `signatures`, `presets`, `settings`,
  `searchIndex`. Versioned schema with migration hooks. Quota-exceeded handled gracefully.
- **AC:** Data survives a tab reload. A forced quota error surfaces a toast, never a crash.

### F-07 · Error, logging, and crash surface — `S` `P0`

**Status: Done** — Six-kind taxonomy, bounded in-memory log, copy-diagnostic. 12 unit tests.

- **Requirements:** Central error taxonomy (`UnsupportedFeature`, `CorruptDocument`,
  `OutOfMemory`, `UserCancelled`, `InternalError`). Every error maps to user-facing copy plus
  a "copy diagnostic to clipboard" action. **Logs stay in memory and are never transmitted.**
- **AC:** Each error class renders its own message and recovery action. No `console.error`
  reaches production builds without a mapped user message.

---

## EPIC-11 · Design system and UI shell

_Runs in parallel with EPIC-0; blocks all feature UI._

### DS-01 · Tokens as CSS custom properties — `S` `P0`

**Status: Done** — Values reconciled with DESIGN-ADAPTATION §3; theme painted before render.

Implement DESIGN-ADAPTATION §3 in `src/ui/styles/tokens.css`.

- **Requirements:** All colour, type, radius, spacing, elevation, motion tokens as CSS vars.
  `:root` = light; `[data-theme="dark"]` overrides. Theme resolution: stored setting →
  `prefers-color-scheme` → light. Document tokens (`--doc-*`) defined separately.
- **AC:** Toggling theme repaints with no layout shift and no flash. No hard-coded hex value
  exists anywhere outside `tokens.css` (enforced by a lint rule).

### DS-02 · Contrast audit — `XS` `P0`

**Status: Done** — `scripts/check-contrast.mjs` in `pnpm check`; four failing pairs corrected, none waived.

- **AC:** Every foreground/background pair in both themes meets WCAG AA (4.5:1 text,
  3:1 large text and UI boundaries). Results recorded in a table in this repo. Any failing
  pair is corrected in `tokens.css`, not waived.

### DS-03 · Component library — `L` `P0`

**Status: Done** — All 20 components built, including a `#/dev/components` gallery
exercising every state. `forwardRef` was retrofitted to all 23 library components on
2026-08-17 (`mergeRefs`, `forwardRefGeneric`; AUDIT-FINDINGS §10.2, HRD-20). **Missing:**
the gallery's axe-core pass (blocked on NFR-01, which wires axe-core in at all).

Build the primitives and app components listed in DESIGN-ADAPTATION §5.

- **Requirements:** Every component: all interaction states in both themes, keyboard
  behaviour, accessible name, `forwardRef`, no inline styles. Focus rings use
  `--primary-focus`. Filled accent is reserved for the single primary CTA.
- **AC:** Component gallery route renders every component in every state. axe-core reports
  zero violations on the gallery in both themes.

### DS-04 · App shell and routing — `M` `P0`

**Status: Done** — Tools declare canvas mode and panel need in `core/tools.ts`; panel is a bottom sheet under 1100px, not hidden.

- **Requirements:** `TopBar` + `FileTabs` + `ToolRail` + canvas + `OptionsPanel` +
  `ActionBar` per DESIGN-ADAPTATION §4.2. Hash routing. Rail collapses at <800px; panel
  becomes a bottom sheet at <1100px. Tools declare `canvasMode: 'grid' | 'single'` and
  whether they need an options panel.
- **AC:** Back/forward navigate between tools correctly. Resizing across both breakpoints
  never clips a control or produces a horizontal scrollbar.

**Amended (2026-09-14):** `FileTabs` did not gate switching or closing the active tab
against a running job — `useJob`'s shared `activeJob` signal only ever disabled the action
bar's own commit button. A handler that reads `activeDoc`/calls `currentDocumentBytes` more
than once across its own `await`s (building a "before" and an "after" separately, for
instance — several do) could silently pick up a different document mid-job if the user
switched tabs in the gap between those reads. Switching to a *different* tab and closing
the *active* one (which also moves `activeDocId`, the same risk) are both now blocked while
a job runs; the active tab itself stays clickable (a harmless no-op) and a non-active tab
can still be closed freely. `tests/e2e/tool-flows.spec.ts` › "switching tabs is blocked
while a job runs on the active document" drives a real multi-second compression analysis
and asserts the other tab is disabled for its duration, then enabled again once it finishes.

**Amended (2026-09-14) — a second, unrelated bug found investigating UX-06 below:**
`Canvas.tsx`'s single-page dispatcher tracked the pager's position in its own local
`useState`, never reading or writing `core/store.ts`'s `activePageIndex` signal — the one
signal `CropPanel`/`CropOverlay`'s `current` scope, `OutlinePanel`'s "Add bookmark for page
N", and OCR's folder-search jump-to all read expecting it to mean "the page the single-page
view is showing right now". In practice it meant "whichever page one of those two external
writers last jumped to", stale the moment the user paged anywhere with the view's own
Previous/Next buttons: page to page 5 in Crop and click "Reset crop on current page", and it
reset page 1's crop, not the one on screen; page to page 3 in Outline and click "Add
bookmark for page 3" (the button's own label, computed from the same stale signal, so even
the *label* was wrong), and both the label and the bookmark it added named whatever page the
signal last happened to hold. `Canvas.tsx` now reads and writes `activePageIndex` directly
instead of a parallel local copy, so every reader sees the page actually on screen.
`tests/e2e/tool-flows.spec.ts` › 'bookmarks: "Add" targets the page the pager is actually
showing'; `tests/e2e/organize-crop-shortcut.spec.ts` (UX-06, below) exercises the same fix
from the Crop side.

### DS-05 · Home launcher — `M` `P0`

**Status: Done** — Drop zone states, fuzzy tool search, Recents from persisted handles.

- **Requirements:** Drop zone (idle/hover/active/reject states), searchable grouped tool
  grid, Recents from persisted handles. Full arrow-key navigation of the grid.
- **AC:** Dropping 5 PDFs loads them and routes to the workspace. Typing filters tools
  within 1 frame. Recents reopen a file in one click, re-prompting for permission if needed.

### DS-06 · Command palette — `S` `P0`

**Status: Done** — Enumerates the registry; E2E asserts every tool is reachable.

- **Requirements:** `⌘K`/`Ctrl+K`. Fuzzy-searches tools, per-document actions, and settings.
  Arrow + Enter navigation, Esc closes, focus returns to origin.
- **AC:** Every tool is reachable from the palette. Opening and executing an action is
  possible without touching the mouse.

### DS-07 · Offline badge and trust page — `S` `P0`

**Status: Done (re-verified 2026-09-26)** — A real button on every route; the trust copy matches what the tests verify.

**Reopened by AUDIT-2026-09-25 §4, now closed again.** The audit found the chip was a
hardcoded "0 requests" string that stayed at 0 after a consented OCR model download
(PLT-16). It is now driven by `core/disclosedDownloads.ts`, which `ocr/download.ts`
increments once per completed, verified download (`tests/unit/ocr.test.ts` asserts the
count). The panel also links to the shipped `privacy.html` and `THIRD_PARTY_LICENSES.txt`
(`tests/e2e/a11y-and-perf.spec.ts`). What is *kept* on the device — the other half of the
trust claim — is DS-12 (Done). The chip's mobile presentation is DS-10.

- **Requirements:** Persistent `Offline · 0 requests` chip in the top bar. Click opens a
  panel explaining no upload / no account / no limits, with instructions to verify in
  DevTools and a link to the public repo. Never animated.
- **AC:** Chip is visible on every route in both themes and passes contrast audit.

### DS-08 · Shortcut sheet and first-run welcome — `S` `P0`

**Status: Done** — Every shortcut row maps to a real binding; E2E asserts the welcome stays gone after reload.

- **AC:** `?` opens a categorised shortcut list. First run shows a one-screen welcome
  (what it does, that nothing is uploaded) that never reappears.

---

## EPIC-1 · Document core

### DOC-01 · Document model and store — `M` `P0`

**Status: Done** — Sources split from workspace documents; 18 unit tests.

- **Requirements:** `StaplerDoc { id, name, bytes, pageCount, pages: PageRef[], meta,
dirty }`. `PageRef` carries source doc id, source index, rotation, crop box, and a stable
  key surviving reorder. Multi-document workspace with per-document tabs. Signals-based
  store; a 300-page grid must not re-render wholesale on a single page change.
- **AC:** Reordering one page in a 300-page document re-renders only affected thumbnails
  (verified in a performance profile).

**Amended (2026-09-14):** `duplicatePages` copied a page's rotation forward to its
duplicate (a `PageRef` field, carried by spreading the page) but not its crop box or page
annotations — separate signals keyed by page key, unaffected by minting the duplicate's new
key. A duplicate of a cropped or annotated page silently started out uncropped and
unannotated, while every other property of the page it was duplicated from survived —
inconsistent in a way that reads as data loss, not a deliberate "duplicates start clean"
design. Both now carry forward to the duplicate's own key (page annotations re-issued fresh
ids, so a per-id lookup can never find one page's mark on the other).
`tests/unit/store.test.ts` › "carries the crop box and page annotations forward to the
duplicate".

### DOC-02 · Import and validation — `M` `P0`

**Status: Done** — Re-verified against the real corpus, not against intent.

- **AC, first half — every fixture imports or gets its specific, accurate explanation:** proven by a sweep over the whole corpus, `tests/e2e/import.spec.ts` › "every PDF in the corpus imports or is refused with a specific reason". It reads `tests/fixtures/*.pdf` off disk (41 files on the last run), imports each through the real file input, and requires every refusal to match one of the pipeline's own sentences — a generic "something went wrong" fails the test. Result: 35 imported (including `xfa.pdf`, `jbig2.pdf`, `jpx.pdf`, `cjk.pdf`, `rtl.pdf`, `cmyk*.pdf`, `heavy.pdf`, `text-300.pdf`); 6 refused — `encrypted.pdf` ("requires a password"), `not-a-pdf.pdf` ("does not start with a PDF header"), and four truncation shapes ("its structure is invalid or truncated").
- **AC, second half — a truncated PDF never crashes the tab:** the pre-existing coverage used `not-a-pdf.pdf`, which is refused by the header check and never reaches pdf.js, so the truncated path was untested and `corruptPdf()` in `tests/e2e/fixtures.ts` was dead code. Now covered three ways (tail-truncated, mid-body, header-only) with a `pageerror` listener asserting no uncaught error, and with a good file imported afterwards in the same tab to prove it still works.
- **Formats:** PNG, JPEG, WebP, TIFF and HEIC each import through the real pipeline from a real fixture (`sample.png`, `tiny.jpg`, `sample.webp`, `sample.tiff`, `sample.heic`), and three at once become one three-page PDF whose bytes re-parse.
- **Oversized:** `largeFileWarning()` is unit-tested at the boundary (100MB exactly → silent, +1 byte → warns), and an import of a >100MB PDF is proven to warn rather than refuse (`tests/unit/import.test.ts`). The warning now also covers oversized *images*, which it previously did not.
- **Two full copies of the bytes — one real instance found and fixed:** `render.worker.ts` `loadDocument` did `new Uint8Array(bytes)` before handing the buffer to pdf.js, so a 100MB import held 200MB in the render worker. The copy protected nothing: the argument arrives by structured clone (no call site transfers it), so the array is already private to that worker. Removed; all 34 `tool-flows` E2E tests, which load a document on every path, still pass. The main-thread read (`new Uint8Array(await file.arrayBuffer())`) is a view, not a copy, and was already correct.
- **Fixed along the way:** `tiny.jpg` and `cmyk-text.pdf` were used by unit tests but neither committed nor generated — a fresh clone failed six tests. Both are now built by `scripts/generate-static-fixtures.mjs` and allow-listed. The unsupported-file message and the drop-zone hint both omitted TIFF while the pipeline accepted it; both now read from one `SUPPORTED_FORMATS` constant.
- **Fixed 2026-09-12 (56db43c):** opening a permission-restricted PDF (no user password,
  printing/copying forbidden by its owner — the common kind) means decrypting it, and
  pdf-lib drops `/Encrypt` the instant it does; every export built from one used to be
  written back with the restrictions silently gone. `core/pdf/load.ts`'s
  `loadPdfDocumentWithRestrictions` now recovers the original `/P` from a second,
  non-decrypting parse at import time (the only moment it is still readable) and carries
  it on `SourceDocument.restrictions`; every export re-applies it
  (`RED-06`'s `permissionOnlyPlan`, wired through `ui/tools/commit.ts`'s `save()`).
  `tests/unit/permission-restrictions.test.ts` (20 tests) proves this against real output
  bytes with pdf.js and poppler, not against `documentRestrictions()`'s own opinion.
- **Amended (2026-09-14):** that second parse can itself fail on a malformed `/Encrypt`
  dictionary — genuinely rare, since the decrypting parse right before it already
  succeeded on the same bytes — and was silently reporting "nothing to preserve," which
  is indistinguishable from a file that really has nothing to preserve and reintroduces
  the exact silent-stripping bug above for that one case. Both places this can fail now
  report a distinguishable `restrictionsUnknown`, surfaced as an import-time warning
  ("this document's original permission restrictions could not be read…") instead of a
  silent, unrestricted export. `tests/unit/permission-restrictions.test.ts` › "when the raw
  /Encrypt re-parse itself fails"; `tests/unit/import.test.ts` › "warns when the original
  restrictions could not be read, rather than exporting unrestricted with no notice".

- **Requirements:** Accept PDF, PNG, JPEG, WebP, TIFF, HEIC. Detect and classify:
  encrypted, XFA, corrupt/truncated, oversized (>100MB warning). Read via streaming where
  possible; never load two full copies of the bytes.
- **AC:** Every fixture in the corpus either imports correctly or produces its specific,
  accurate explanation. A truncated PDF never crashes the tab.

### DOC-03 · Renderer and thumbnail cache — `L` `P0`

**Status: Done** — Handles and bitmaps keyed by *source* id; first thumbnail of 100 pages under 1.5s in E2E.

- **Requirements:** pdf.js in `render.worker` producing `ImageBitmap`s at requested scale.
  LRU bitmap cache with a memory ceiling and explicit `close()` on eviction. Progressive
  render: low-res placeholder first, then sharp. Cancel renders for scrolled-away pages.
- **AC:** First thumbnail of a 100-page PDF <1.5s; all 100 <6s; peak memory within
  PLAN §5.1. Rapid scrolling through 300 pages does not grow memory unboundedly.

### DOC-04 · Virtualized page grid — `M` `P0`

**Status: Done** — Row windowing, multi-select, ⌘A, drag with an insertion line, `Alt`+arrow reorder. **60 fps measured (2026-10-05):** `tests/e2e/perf.spec.ts` › "DOC-04: a 300-page grid scrolls at 60 fps" asserts the p95 frame time and the 50 ms long-task budget while scrolling all 300 pages. Grid scroll was fixed for it: hidden tool strips are no longer composited, and the window re-renders only when its rows change. Measured 59.4 fps, with frames over 25 ms down from about 4% to about 0.3%.

- **Requirements:** Windowed rendering, multi-select (click, shift-range, ⌘/Ctrl-toggle,
  ⌘A), drag-to-reorder with a clear drop indicator, and a **keyboard reorder alternative**
  (select → `⌥↑/↓` to move) for accessibility.
- **AC:** 300 pages scroll at 60fps. Every selection and reorder action is achievable by
  keyboard alone.

### DOC-05 · Export pipeline — `M` `P0`

**Status: Done** — Order and rotation asserted on real bytes. Save-over-original is
offered in the UI (asks explicitly on every commit for a document opened from one writable
file). The full export pipeline is now verified by `tests/unit/export-pipeline.test.ts`
(14 tests: pdf-lib round-trip, compose-path, sanitizeFileStem, splitBoundaries — all
passing). Save-over-original via the native file-picker is the one step Playwright cannot
drive; it is covered in QA-05's manual checklist in `RELEASE_CHECKLIST.md` §1.
**Coexists with DOC-08 (2026-10-05):** every `process.worker.ts` save goes through one
`saveOutput` helper that keeps `useObjectStreams: true` by default; DOC-08's plain-xref,
first-page-first layout applies only when the user turns on the opt-in "Fast web view"
export setting (`tests/unit/export-fast-web-view.test.ts` › "off (the default): the export
keeps object streams, as DOC-05 requires"; `tests/e2e/export-claims.spec.ts` › "off by
default: the export keeps its object streams").

- **Evidence:** `pnpm check && pnpm test` — 38 test files · 430 tests · 0 failures (after
  adding `tests/unit/export-pipeline.test.ts`).

- **Requirements:** Compose the output from `PageRef`s via pdf-lib; `useObjectStreams`
  enabled. Save via `showSaveFilePicker` with a sensible default filename
  (`contract-merged.pdf`); support save-over-original when the handle is writable.
- **AC:** Output re-parses cleanly, page count and order match the UI exactly, and opens
  without warnings in Chrome's viewer, Acrobat, and Preview.

### DOC-06 · Undo/redo — `M` `P0`

**Status: Done** — Depth 50, selection in the snapshot, drag coalescing. 9 unit tests incl. the 20-op round trip.

- **Requirements:** Command-pattern history over document-model mutations (min depth 50),
  with `⌘Z`/`⌘⇧Z`. Committed exports are not undoable and must not enter the stack.
- **AC:** 20 mixed operations undo and redo to byte-identical model state.

---

## EPIC-2 · Page operations

### OPS-01 · Merge — `S` `P0`

**Status: Done** — Mixed page sizes preserved, asserted on output. **Bookmarks are now
preserved**: pdf-lib has no outline API, so `process.worker.ts`'s `copyOutlines` walks the
raw `/Outlines` tree by hand, remapping each item's direct page-reference destination to its
new ref in the merged output (golden test: `tests/unit/golden.test.ts`, "preserves bookmarks
across a merge, remapped to the merged pages"). A named destination (a name-tree lookup pdf-lib
also has no API for) or a non-`GoTo` action is left out rather than guessed at — narrower than
full outline support, but disclosed as such in `MergePanel.tsx` rather than the previous
blanket "not carried into" claim. The 10×5MB budget is asserted in
`tests/e2e/a11y-and-perf.spec.ts`, though against a fixture worth re-checking — see NFR-02.

- **Requirements:** Combine N documents; drag to reorder at document _and_ page level;
  handle mixed page sizes (preserve by default, with an optional normalize toggle);
  preserve bookmarks where pdf-lib allows and state plainly when it cannot.
- **AC:** 10 × 5MB PDFs merge in <8s with correct order. Merging documents with different
  page sizes produces no scaling artifacts.

### OPS-02 · Organize: rotate, delete, duplicate, reorder — `S` `P0`

**Status: Done** — Rotation applied to the page dictionary; normalisation unit-tested.

- **Requirements:** Per-page and bulk rotate in 90° steps, delete, duplicate, move.
  Rotation is applied to the page dictionary, not by re-rendering.
- **AC:** Rotations persist correctly through export and display identically in three
  external viewers. Deleting 100 of 300 pages completes in <1s.

### OPS-03 · Split and extract — `M` `P0`

**Status: Done** — All four modes; boundaries property-tested so outputs union to the input page set.

- **Requirements:** Four modes — extract a selection to one new file, split at chosen
  page boundaries, split every N pages, split into individual pages. Multi-file output goes
  to a chosen directory, or a ZIP via `fflate` when directory access is unavailable.
- **AC:** All four modes verified against a 300-page fixture; every output re-parses and
  the union of outputs equals the input page set.

### OPS-04 · Insert pages from another document — `S` `P0`

**Status: Done** — Dedicated `InsertPanel`, insertion index defaults to after the last
grid-selected page, newly-inserted pages are selected as the insertion indicator. 6 unit
tests, verified end-to-end against a live instance.

- **AC:** Pages insert at a chosen index with a visible insertion indicator; source
  document remains unmodified.

### OPS-05 · Remove blank pages — `S` `P1`

**Status: Done** — Detection only selects; removal is separately confirmed.

- **Requirements:** Detect blankness by ink coverage below a threshold on a downsampled
  render; **always preview candidates for confirmation** before removal.
- **AC:** On the scanned fixture, detects blanks with no false positives at default
  threshold; nothing is removed without explicit confirmation.

### OPS-06 · Crop and trim margins — `M` `P1`

**Status: Done** — `cropBoxes` undo integration landed in Chunk 1; this pass added the
rest. `CropOverlay` now has 8 pointer-draggable resize handles plus a move-by-dragging-the-
interior gesture, and is keyboard-operable (arrow keys move, Ctrl/Cmd+arrow resizes,
Delete/Backspace resets) — mirroring the SGN-02 stamp overlay's keyboard pattern. The
"Apply crop to" dropdown (`cropSettings.scope`) is wired for real: drawing, resizing,
moving, or resetting a box now applies it to every page the chosen scope
(`current`/`all`/`odd`/`even`) resolves to via the new `pagesForScope` helper, not just
the page on screen — previously "all pages" silently did nothing beyond the current page.
Auto-trim uses the same scope. A "Reset crop" button clears the box on every scoped page.
Export still uses `setCropBox`, unchanged, so text stays selectable. Covered by
`tests/unit/crop.test.ts` (scope resolution, resize-handle geometry and clamping) and a
new Playwright test exercising odd-page scope propagation, keyboard resize/move, the
reset button, and undo of the reset.

- **Requirements:** Manual crop box with handles, auto-detect content bounds, apply to
  one page / odd / even / all. Modify `CropBox`, do not destroy content.
- **AC:** Cropping is reversible via undo and by resetting the box; text remains selectable
  in the output.

### OPS-07 · N-up and booklet imposition — `M` `P1`

**Status: Done (fixed AUDIT-2026-09-25 PDF-12, 2026-09-26)** — All source pages are embedded in one `embedPages` call (was one copier per cell, ~10× size), the user is told which links, comments and fields n-up drops, and pages with no `/Contents` work. Test: `tests/unit/rebuild-page-links.test.ts`.

- **Requirements:** 2-up and 4-up layouts; booklet fold ordering; configurable margins
  and gutter.
- **AC:** A printed 8-page booklet folds into correct reading order (verified against a
  physical or PDF-viewer mock-up).

### OPS-08 · Page numbers, watermark, header/footer — `M` `P1`

**Status: Done** — Text watermark supports the 9-point grid, font size, opacity, colour,
rotation, start-at numbering, a comma-separated page range, and CJK-safe refusal. An image
watermark (PNG/JPEG, same grid/opacity/rotation/page-range) and a real header/footer (fixed
margin band, own page range, left/center/right alignment, `{n}`/`{total}`) were added in
a later pass; the image-watermark and header/footer AC below reflect what shipped.
AUDIT-2026-10-01 X-7 (HRD-67, 2026-10-02): the AC "live preview matches output" failed on page ranges — a whitespace-only range selected every page in the preview and none in the export, and an en dash, `;`, `0` or `-` selected nothing silently. Preview and worker now share `parsePageRange` (`src/core/page-range.ts`), and a non-empty range that selects zero pages is flagged (`tests/unit/ui-audit-2026-10-01.test.ts`).

- **Requirements:** Position (9-point grid), font size, opacity, colour, start-at value,
  page-range targeting, and a text or image watermark with rotation.
- **AC:** Live preview matches output. Watermarks over CJK-text fixtures do not corrupt
  glyph rendering.

### OPS-09 · Normalize page size — `S` `P1`

**Status: Done** — Fully implemented in the UI and worker.

- **AC:** A document mixing A4/Letter/Legal converts to one size with correct aspect
  preservation and no content clipping.

---

## EPIC-3 · Conversion

### CNV-01 · Images → PDF — `M` `P0`

**Status: Done** — EXIF orientation honoured, decoding off the main thread. `ImageOptionsDialog.tsx` now provides page size (original/A4/Letter), orientation, margin, and quality controls, wired through `ImagesToPdfOptions`.

- **Requirements:** Multi-image import with reorder; per-image page size (fit / A4 /
  Letter / original), orientation, margin, and JPEG quality. EXIF orientation respected.
- **AC:** 20 phone photos become a correctly-oriented 20-page PDF in <10s. A rotated EXIF
  image is not sideways in the output.

### CNV-02 · PDF → images — `S` `P0`

**Status: Done** — PNG/JPEG, four DPI settings, page range, ZIP output.

- **Requirements:** PNG or JPEG, selectable DPI (72/150/300/600), page-range selection,
  ZIP or directory output.
- **AC:** 300 DPI export of a 20-page fixture completes without exceeding the memory
  ceiling; output dimensions match the requested DPI exactly.

### CNV-03 · HEIC decoding — `S` `P0`

**Status: Done** (re-audited 2026-09-26; extension AC automated 2026-10-05).

**Reopened by AUDIT-2026-09-25 (CONV-1).** The original "Done" rested on the web preview
only: heic2any compiles its libheif bindings with `new Function`, which the extension's
MV3 CSP blocks, so HEIC import hung forever in both extension builds. Now:

- The decoder is `libheif-js`'s WebAssembly build (no `eval`/`new Function`), run in the
  image worker (`core/raster-decode.ts`, `core/workers/image.worker.ts`) with a timeout and
  cancellation (`tests/unit/image-import.test.ts`). heic2any is gone from `package.json`.
- Absent from the initial bundle: **met** — in a web build, libheif appears only in
  `assets/libheif-*.js` and the image-worker chunk, not in `editor.js`
  (`scripts/check-bundle-size.js` enforces the initial-chunk budget but does not name
  libheif specifically).
- Colour and orientation: **met in the web build** — `tests/e2e/import.spec.ts` imports
  `tests/fixtures/sample.heic` and `photo-rotated.heic` (right-side up).
- In the loaded extension: **met (2026-10-05)** — `tests/e2e/extension/tool-flows.spec.ts`
  › "HRD-51 — HEIC in the packaged extension" imports `sample.heic` and
  `photo-rotated.heic` (upright, checked by corner colours) in the packaged `dist/ext`.
- libheif is LGPL-3.0; it ships as a separate, replaceable chunk and its licence is in
  `THIRD_PARTY_LICENSES.txt`.

- **Requirements:** Lazy-loaded WASM HEIC decoder, used only when a HEIC file is imported.
- **AC:** Decoder is absent from the initial bundle (verified in a bundle report). iPhone
  HEIC photos import with correct colour and orientation.

### CNV-04 · PDF → text / Markdown — `S` `P0`

**Status: Done** — Reading-order layout with 14 unit tests incl. CJK and RTL. The AC is proven
end to end in `tests/e2e/tool-flows.spec.ts` rather than in a Vitest golden file: pdf.js text
extraction needs a real browser (OffscreenCanvas, a Worker-hosted decoder) that Node/Vitest
doesn't provide, so `tests/unit/golden.test.ts` explicitly excludes it (see that file's header
comment) — "extract: text comes out in reading order" asserts heading-before-body ordering on
real output, and dedicated CJK (`cjk.pdf`, CID-keyed "中文") and RTL (`rtl.pdf`, Arabic through
`Identity-H`) tests drive the real fixtures QA-01 built specifically to validate this.

- **Requirements:** pdf.js text layer with reading-order heuristics; preserve paragraph
  breaks; Markdown mode promotes probable headings by font size.
- **AC:** Text extraction on the text-only fixture matches a golden file. CJK and RTL
  fixtures extract without mojibake or reversed runs.

### CNV-05 · Markdown → PDF — `S` `P1`

**Status: Done (re-audited 2026-08-17); non-WinAnsi glyphs are substituted, not rendered** — AUDIT-2026-08-17 §1/§3 #27 found links drawn as literal `[text](url)`, table cells cut at 30 characters, and CJK silently turned into `?` (which later regressed to a crash). Now links are real `/Link` annotations with safe `/URI`s (`safeLinkUri`, http(s)/mailto/tel), cells word-wrap to their column, and characters outside Windows-1252's real range are substituted with a visible warning (`sanitizeWinAnsiText` reports `substituted`). Verified on output bytes: the URIs read back and no literal markdown syntax remains. **Open (feature):** rendering CJK/RTL glyphs needs an embedded Unicode font (HRD-05).

- **AC:** Headings, lists, tables, code blocks, and links render; page breaks are sensible;
  output text is selectable.

---

## EPIC-4 · Sign and fill

### SGN-01 · Signature capture and library — `M` `P0`

**Status: Done (2026-10-05)** — Draw/type/import, PNG with real alpha, white-paper removal. Initials supported. The former DoD gap (AUDIT-FINDINGS §14 H3) is closed: `trimTransparentToPng` and `removeWhiteBackground` keep their API but run their pixel loops in the cv worker (`src/core/workers/signature-pixels.ts`), with byte-identical output (`tests/unit/signature-pixels-worker.test.ts`). The browser performance trace on a 4000×3000 import is still unrun (HRD-27).

- **Requirements:** Three creation modes — draw on canvas (pointer + stylus pressure where
  available), type with a script-style face, or import a transparent PNG. Auto-trim
  whitespace, remove the white background to real transparency, store in IndexedDB.
  Support multiple signatures plus initials.
- **AC:** A drawn signature exports with genuine alpha (no white box) over coloured page
  content. Saved signatures survive reload.

### SGN-02 · Placement on page — `M` `P0`

**Status: Done (fixed AUDIT-2026-09-25 PDF-9, 2026-09-26)** — Real single-page view at true scale, drag, resize, arrow nudge. Placement goes through `src/core/pdf/display-frame.ts` (CropBox ∩ MediaBox, origin and `/Rotate`); before, a signature on a cropped or bleed page could land outside the visible page. Tests: `tests/unit/display-frame-geometry.test.ts`. Open (reverse direction): `getFormFields` still reports field rects against the raw MediaBox (HRD-42).

- **Requirements:** Single-page view; click to place; drag, resize (aspect-locked), rotate;
  duplicate to other pages; snap to detected signature lines. Also place date stamps, text,
  checkmarks, and initials.
- **AC:** Placement is pixel-accurate against the exported PDF at 100% zoom. Every
  placement action has a keyboard equivalent (arrow-key nudge, `⇧` for coarse).

### SGN-03 · Fill interactive AcroForms — `M` `P0`

**Status: Done** — Four separate faults, each of which alone made a form unfillable while the UI reported success: field kinds were identified by `field.constructor.name`, which a minified build renames, so every field came back `Unknown` and rendered as "Unsupported"; `/AcroForm` did not survive the `copyPages` compose, so filling the source bytes had its `/V` values dropped by the export; the stamp overlay covered the field inputs; and `.stage` centred with `align-items` under `overflow: auto`, leaving the top sixth of the page permanently unreachable. XFA is now decided on raw bytes before any parse. A fifth fault found in a later audit: a `RadioGroup` field rendered as a full `<select>` of every option, duplicated at each radio widget's position on the page — fixed to one native radio input per widget, paired with its export value positionally against `field.options`.

- **Requirements:** Detect and enumerate AcroForm fields; render native inputs for text,
  checkbox, radio, dropdown; fill and optionally flatten. **XFA forms detected and clearly
  explained as unsupported** with the recommended workaround (use the stamp tools).
- **AC:** The AcroForm fixture fills and flattens with values intact in external viewers.
  The XFA fixture shows the explanatory message and never partially processes.

### SGN-04 · Signature-line detection — `S` `P1`

**Status: Done** — Previously threw on every use (store id passed where a render handle was expected).

- **AC:** Detects horizontal rules and "Signature:" labels on the contract fixture and
  offers a suggested placement the user can accept or ignore.

---

## EPIC-5 · Compression

### CMP-01 · Page analyzer and routing — `M` `P0`

**Status: Done (re-audited 2026-08-17); one fixture test is stale** — Inventory-driven classification. AUDIT-2026-08-17 §1 found only 5 real fixtures classified against the AC's "all 15". `tests/unit/compress-plan-fixtures.test.ts` now classifies 14 real fixtures against their bytes. The skip list covers the whole filter chain and mask filters (AUDIT-EDGE-CASES §2.4). Any real text, however short, keeps a page off `raster` (§1.6 and AUDIT-2026-08-17 §3 #12). Bit depth below 8 blocks surgical only (§2.9). **Gap (AUDIT-EDGE-CASES §6 #2):** the `jbig2.pdf`/`jpx.pdf` cases assert `reencode: []` but not `route`, and their comment claims a raster route the planner doesn't take (`blocked()` ⇒ `already-optimized`). The `indexed`/`icc`/`soft-mask` cases overwrite the fixtures' dimensions before classifying (HRD-39).

Implements PLAN §4.1 classification.

- **Requirements:** Per page, determine text presence, image XObject inventory (dimensions,
  colour space, filter, displayed size, SMask presence), and vector complexity. Route to
  `raster`, `surgical`, or `already-optimized`. Detect JBIG2/JPX and mark as skip.
- **AC:** Classification is correct on all 15 fixture PDFs (asserted in unit tests). No
  fixture is misrouted to `raster` when it contains extractable text.

### CMP-02 · Raster path — `M` `P0`

**Status: Done** — Raster path operates at chosen DPI and quality. A Playwright E2E test validates that the scanned fixture (`scanned_skewed.pdf`) reduces by 70-90% as expected.

- **Requirements:** Render at selected DPI (72/150/300, default 150) → JPEG at selected
  quality → rebuild PDF. Page-at-a-time with bitmap release.
- **AC:** Scanned fixture reduces 70–90%. Visual quality at 150/0.75 is acceptable in a
  side-by-side review. Memory stays within budget on the 300-page fixture.

### CMP-03 · Surgical image re-encode — `XL` `P0`

**Status: Done** — The path now works: it did nothing at all before, in three independent ways (pdf.js image objects were read before they had been decoded; images were matched by resource name against pdf.js's own object ids, which never match; and JPEG images arrive as a `VideoFrame`, which the decoder did not recognise). SMask and stencil-mask images, DeviceCMYK, Indexed and ICCBased are all re-encoded now, downscaled to displayed size, with the mask re-attached byte-for-byte; a shared image is encoded *and stored* once. Still skipped and reported: `/Separation` and `/DeviceN` (flattening a named ink to RGB destroys the plate), colour-key `/Mask` arrays, `/Matte` pre-blended soft masks, `/ImageMask` stencils, JPX/JBIG2, sub-byte depth. **Correction:** the mask stream is now resampled too (`encodeMask` in `render.worker.ts`, applied in `rebuildCompressed`), shrink-only so a mask already smaller than the new target is left untouched rather than inflated — this row's "never resampled" was stale as of the SMask-resampling pass. A newly found and fixed correctness bug from this audit: image replacement was keyed by resource *name*, which is scoped per dictionary — a page-level image and an unrelated image inside a nested Form XObject could legally share a local name, letting one silently overwrite or misattach the other's re-encoded bytes. Replacement is now keyed by PDF object number, which is unique document-wide.

**Skip-detection audit (this pass).** Four bugs found and fixed; the deliberate skip list itself is unchanged.

1. **`/Filter` chains were read from the wrong end.** A chain applies left to right, so `[/ASCII85Decode /JPXDecode]` is a JPX image — but only the head was read, reporting `ASCII85Decode`, which matches neither undecodable filter. A JPX or JBIG2 image behind any wrapper filter was therefore routed to the surgical re-encode and never reported as skipped. `ImageFacts` now carries the whole chain (`filters`) and `filter` is its last entry.
2. **A shared image could be judged unsafe on one page and re-encoded because of another.** `/ColorSpace` may be a resource-scoped name (`/CS0`) resolved against the resources of the page that draws it, so the same `/Separation` object read `Separation` on the page that names it and `CS0` on a page that does not — and since replacement is by object number, the page that said "safe" flattened the ink plate for the whole document. Safety is now decided per image *object*, document-wide: unsafe anywhere is unsafe everywhere.
3. **`rebuildCompressed`'s "second lock" did not actually hold.** It tested `/Mask` unresolved, so the ordinary indirect form (`/Mask 12 0 R` pointing at a colour-key array) read as a plain `PDFRef` and was copied verbatim onto a downscaled JPEG whose samples can no longer fall in those ranges; `/Matte` and `/ImageMask true` were not checked at all. All three are now re-checked against the resolved objects, so the guard no longer depends on the classifier having reached the same conclusion.
4. **A shared image was sized from whichever pages happened to over-sample it.** The displayed size is only measured on pages listing the image in `reencode`, so an image over-sampled on a small page and correctly sized on a larger one was replaced at the small page's size and the larger placement silently inherited the downscale. Candidacy is now document-wide, so "largest use wins" sees every use. The same pass stopped a shared image's bytes being counted once per page in `actionableBytes`, which had inflated CMP-04's pre-flight estimate.

Still `Partial` only in the sense of its deliberate bounds: the six unsupported constructs are detected before any mutation, left byte-identical, and named in the report (`CompressPanel`, and the commit summary). CMP-05's live preview, once the ticket's remaining unbuilt half, is now built and Done.

The hardest ticket in v1.0. Budget accordingly.

- **Requirements:** Extract each image XObject via pdf.js operator lists; downscale to
  actual displayed size; re-encode to JPEG; replace the XObject **in place**, preserving
  references. Correctly handle: SMask/transparency re-attachment, CMYK → RGB, Indexed
  colour spaces, and images reused across pages (dedupe, encode once). Skip JBIG2/JPX.
  Text and vector content must be byte-untouched.
- **AC:** Mixed text+image fixture reduces 30–70% with text still selectable and searchable.
  **The transparency fixture shows no black boxes.** The CMYK fixture has no colour shift
  beyond a documented tolerance. A shared image appearing on 10 pages is encoded once.

### CMP-04 · Honest reporting and safety net — `S` `P0`

**Status: Done** — Pre-flight estimate before the work; output measured and the original kept when not smaller. Also fixes the reason compression could *inflate* a file — pdf-lib writes unreferenced objects, so the document is rebuilt.

- **Requirements:** Before/after size with percentage; when the achievable gain is <5%,
  state _"already optimized — only N% possible"_ and offer cancel. **If output ≥ input,
  discard it and keep the original bytes**, telling the user why.
- **AC:** Already-optimized fixture triggers the honest message rather than a pointless
  save. No fixture, under any setting, can produce a saved file larger than its input.

### CMP-05 · Quality preview UI — `M` `P0`

**Status: Done** — A live before/after preview wired to the real pipeline, and a projection
that is measured rather than modelled. Evidence below is from
`tests/e2e/compress-preview.spec.ts`, which asserts on produced bytes and painted pixels.

**What the preview does.** The representative page is composed into a one-page PDF
(`composeDocument`), classified by the real planner (`planCompression`) and re-encoded by the
real `compressDocument` at the current DPI/quality; the returned bytes are loaded into pdf.js
and rendered into the "after" half of `CompareSlider`. It is the export's own encoder output,
not a canvas-quality simulation — the test proves it by asserting the two canvases differ
pixel-wise and that dropping quality from 70% to 30% produces fewer bytes from the encoder.
All work is in the render/process workers, each stage takes an `AbortSignal`, and an
abandoned slider tick aborts rather than finishing unwatched.

**Representative page.** `PagePlan` gained `imagePixels`, and `representativePageIndex`
(pure, unit-tested) picks the most image area, falling back to actionable bytes then page 1.
Asserted on a purpose-built three-page fixture whose largest image is on page 3
(`imageOnLastPagePdf`): the preview reports `data-preview-page=3`, so "most image area" is
distinguishable from "the first page".

**AC 1 — slider changes reflect within 400ms: met.** Measured end to end from the keypress
to the new bitmap being on screen at the new quality: **192ms** on an idle machine (337ms
with another test suite running alongside), and under 400ms again when stepping back to a
cached setting. Composed bytes, the plan (keyed by DPI only, since quality never changes
routing) and the encoded output are cached, so a quality tick re-runs only the encode and
the render, and a zoom change re-runs neither. The number is wall-clock and load-sensitive:
on a machine at load average 30 the same assertion measured 6.6s, so treat a failure here as
a machine-contention signal before a regression.

**AC 2 — projected size within 15% of actual: met, by replacing the model with a
measurement.** The pre-flight estimator was measured at **296% over** on the mixed fixture
and **108% over** on the scanned one, so `refineEstimate` now re-anchors the displayed
projection on the page the preview actually re-encoded. Two corrections carry it: a surgical
page's non-image bytes survive into the output and must come out of the ratio, and a raster
page's do *not* survive and must come out of the "untouched" total (that one assumption was
the entire 108%). Against real exported bytes: **surgical 11,524 projected vs 11,524 actual
(0.0%)**, **raster 424,405 vs 423,699 (0.2%)**. The e2e also asserts the number shown is the
measured one, so a lucky fallback cannot pass.

**Deliberately unchanged:** `commit.ts`'s CMP-04 export gate still runs its own pre-flight
`planCompression` and decides on that. Only the *displayed* projection is refined, and it is
labelled "Projected output (measured)" when it is. A measurement is discarded when the
settings or the page change, so a stale ratio is never applied.

**One existing test was re-scoped, not weakened.** CMP-04's "already optimized" e2e asserted
an unscoped `getByText('no reduction')`; the preview now reports a size delta of its own, so
that locator matched three nodes and failed strict mode. It is now scoped to the Compress
options panel, which is the surface that assertion was always about. Full compress e2e after
the change: 13/13 (5 CMP-05, 8 CMP-02/03/04). `pnpm check` clean, `pnpm test` 275/275.

- **Requirements:** Quality slider with live re-render of one representative page (the one
  with the most image area), `CompareSlider` before/after, zoom to 400%, and a live
  projected output size.
- **AC:** Slider changes reflect in the preview within 400ms. Projected size is within 15%
  of actual output.

---

## EPIC-6 · Scan cleanup _(hero feature)_

### SCN-01 · Document edge detection and de-warp — `L` `P0`

**Status: Done** — Detection reports confidence, with four draggable keyboard-nudgeable
handles as the fallback. Measured against synthetic scenes with known ground truth (no real
phone-photo corpus is possible in CI): 8/8 realistic scenes plus one adversarial case
correctly deferring to manual handles — 9/10 by the AC's counting. Fixed two real bugs found
while measuring: an out-of-bounds read past the blur pass's valid region produced a false
confident detection on a textureless photo, and hysteresis thresholding was breaking the
page boundary into four disconnected edges at the corners (fixed with one dilation pass).

- **Requirements:** Detect page corners (grayscale → blur → Sobel/Canny → largest
  quadrilateral); perspective-transform to a rectangle; manual corner handles as the always-
  available fallback when detection is wrong or ambiguous.
- **AC:** Detects correct corners on 8 of 10 phone-photo fixtures; the other 2 fall back to
  manual handles without error. Corrected output has straight edges and correct aspect.

### SCN-02 · Deskew, threshold, despeckle — `M` `P0`

**Status: Done** — Two real bugs fixed and pinned: `Uint32` overflow in the summed-area
table, and the deskew sign that *doubled* skew. Despeckle exists, is tested, and is wired
into `cv.worker.ts`; all three presets match the AC (`bw`/`auto` threshold, `photo` skips
thresholding so a colour photo is not destroyed).

- **Requirements:** Auto-deskew via dominant text-line angle (±15°); adaptive threshold for
  a clean white background; despeckle; three presets — **Auto**, **B&W document**,
  **Photo/colour** — plus manual brightness/contrast.
- **AC:** Gray, blotchy phone photo becomes a white-background document with legible text.
  A colour photo under the Photo preset is not destroyed by thresholding.

### SCN-03 · Cleanup UI and before/after — `M` `P0`

**Status: Done** — Compare view and per-page apply that writes back — **there was no
Apply at all, so the feature produced no output**. Apply-to-all now reports per-page
progress and is cancellable at the same per-page boundary.

- **Requirements:** Single-page view with `CompareSlider`; per-page or apply-to-all;
  batch progress across pages; re-run without reimporting.
- **AC:** The before/after view is the store's first screenshot — it must be visually
  convincing at 1280×800 in both themes.

---

## EPIC-7 · Redaction and privacy _(hero feature)_

### RED-01 · Region marking and search-and-mark — `M` `P1`

**Status: Done** — Each hit sized to the matched substring; marks keyed by workspace page index, not `sourceIndex`.

- **Requirements:** Draw redaction rectangles in single-page view; search a string and mark
  every occurrence across the document; list all marks with page numbers; remove individual
  marks before applying.
- **AC:** Searching a term present on 12 pages marks all 12 occurrences and none other.

### RED-02 · True content removal — `XL` `P1`

**Status: Done (reopened by AUDIT-2026-09-25 PDF-1/PDF-4/PDF-5/PDF-11, closed 2026-09-26)** — Operator-level removal is implemented. The audit found redacted text still in the file (an orphan page copy whenever an annotation, link or widget referenced the page), 45°-rotated images escaping, hidden layers un-hidden by the scrub, and form values surviving on sibling widgets; fixed by the single-copier rebuild and verified on output bytes (HRD-40, HRD-41).

Implements PLAN §4.2 steps 2–3.

- **Requirements:** Strip text-showing operators intersecting a region from the content
  stream; clip or re-encode intersecting image XObjects; rasterize the affected region as a
  final guarantee. Never rely on an overlay rectangle alone.
- **AC:** After applying, text extraction of the output contains **zero** redacted strings.
  Copy-paste from three external viewers over the redacted area yields nothing. Content
  outside regions is unchanged (asserted by text diff). No decoded stream anywhere in the
  output contains a redacted string, and no /Type /Page object exists outside the page tree
  (strings/qpdf check).

### RED-03 · Verification report gate — `M` `P1`

**Status: Done (reopened by AUDIT-2026-09-25 M7, closed 2026-09-26)** — Per-region geometric verification (four-corner quads, independent of the redaction's plan) plus a whole-file scan of every decoded stream for the redacted strings and a check that no page exists outside the page tree; saving is blocked on any failure. **Earlier verifiers reported "passed" for regions they never checked, and then for leaking output (PDF-1, PDF-4).** See HRD-41.

- **Requirements:** Re-extract text and assert absence of every redacted string; render each
  region and check for residual glyphs; present a per-region pass/fail table. **Saving is
  blocked when any region fails**, with an explanation.
- **AC:** A deliberately-sabotaged build (overlay-only redaction) is _rejected_ by the
  verifier. Report renders in both themes and is exportable as text.

### RED-04 · Metadata inspector and scrubber — `M` `P1`

**Reopened by AUDIT-2026-09-25 UI-1 (🔴), PDF-13, PDF-5, R-PDF-2; closed 2026-09-26.** "Strip & export" without a prior "Inspect" stripped nothing (`{}` settings are truthy and skipped the strip-all default) and settings carried over to the next document; a scrub with nothing ticked dropped bookmarks, page labels, the tag tree, `/Lang` and OutputIntents (and so did every redaction); the default scrub kept bookmark JavaScript. Tests: `metadata-default-scrub.test.ts`, `rebuild-page-links.test.ts`, `pdf-regression-review.test.ts`. See HRD-40, HRD-47.

**Status: Done** — Inspector plus rebuild-on-strip so removed objects are absent, with a
checkbox per finding and `Select all` / `Select none` above the list for the one-click
strip-all. Findings now include each non-standard Info entry with its value and a
`Filesystem paths` section naming where every path was found (Producer, a custom property,
the XMP packet) and therefore which toggle clears it.

Two real defects fixed here, both found by the new fixture: the rebuild copied pages into a
fresh document and never carried the catalog across, so *keeping* an item was a no-op —
embedded files, hidden layers, an open action, embedded JavaScript and the XMP packet were
removed whether or not their box was ticked (the copy now runs through a single
`PDFObjectCopier` shared with the page copy, so a kept `/OCProperties` still points at the
objects the page content marks); and `PDFDocument.create()`'s own Producer/Creator/dates
repopulated categories that had just been stripped.

Verified against `tests/fixtures/metadata-windows-path.pdf` (author `Grace Hopper`; the same
Windows user path in a custom Info key, in `/Producer`, and in the XMP packet; plus a
document-level JavaScript action): unit tests assert all three are reported before, that a
per-item strip removes only the ticked category, and that after strip-all none of the
strings survive anywhere in the decompressed output while the page and its text remain; the
e2e test asserts the author and both paths are on screen before, drives a checkbox from the
keyboard, and asserts absence from the exported bytes. Metadata scrubbing runs automatically
inside `applyRedactions` (`src/core/operations.ts`).

- **Requirements:** Show everything hidden in the file: author, producer, creator, dates,
  filesystem paths, XMP, embedded thumbnails, embedded JavaScript, launch actions, embedded
  files, hidden OCG layers. One-click strip-all plus per-item control. Runs automatically as
  part of redaction.
- **AC:** On a fixture containing an author name and a Windows user path, both are displayed
  before and absent after. Embedded JavaScript is detected and removable.

---

## EPIC-8 · Annotation

### ANN-01 · Highlight, freehand, shapes, text, sticky notes — `L` `P1`

**Status: Done (re-audited 2026-08-17)** — `src/ui/tools/annotate/` is a real annotation layer separate from SGN-02 stamps. `AnnotationType` carries all eight required tools: highlight, freehand, rectangle, text, sticky note, whiteout, **arrow and ellipse**. The last two were missing until AUDIT-2026-08-17 §1. **Any** annotation can be reselected and re-edited, not only the most recently created one. Undo and redo reach the layer (`tests/unit/history.test.ts` › "reaches the ANN-01 overlay layer, not just SGN-02 stamps"). The canvas is keyboard-operable (Enter adds, arrows move, Delete removes), stroke width is normalised between screen and PDF, and swatches come from tokens. `tests/e2e/tool-flows.spec.ts` covers a pointer-drawn whiteout exported and undone. Not automated: "three external viewers" (QA-05 manual).

- **Requirements:** Overlay layer per page; tools for highlight (multiply blend over text),
  freehand ink, arrow, rectangle, ellipse, text box, sticky note, and whiteout. Colour and
  stroke-width picker. Editable until flattened.
- **AC:** Annotations survive undo/redo and export flattened at correct positions and scale
  in three external viewers.

### ANN-02 · Compare two PDFs — `M` `P1`

**Status: Done (re-audited 2026-08-17 and 2026-10-01)** — Visual pixel diff and word diff. AUDIT-2026-08-17 §1 found that the AC's fixture didn't exist, the only test was a crash smoke test, and only the visible page was diffed. Now the committed `contract-v1.pdf`/`contract-v2.pdf` pair backs a real assertion. Every page is diffed in the cv worker with determinate progress (`compare-export-audit-2026-10-01.test.ts` › "X-6: …"). Sensitivity is no longer inverted, and pages of different sizes are compared at real size (HRD-07).
  - *Context*: Visual pixel-diffing for architectural plans or word-by-word diffing for contracts.
  - *AC*: Two revisions of the contract fixture surface every real change with no false positives above default sensitivity.

---

## EPIC-9 · Batch and presets

### BAT-01 · Batch processing over a folder — `L` `P1`

**Status: Done (re-audited 2026-08-17, re-verified 2026-10-05)** — AUDIT-2026-08-17 §1 found three gaps: no ZIP output, failures shown only as transient toasts, and no `role="progressbar"`. All three are fixed: a real ZIP via `fflate` (`zipSync` in `runner.ts`), a persistent per-file `notes` summary, and `role="progressbar"` on the progress region. Hardened since then: a reentrancy guard (AUDIT-EDGE-CASES §2.1), the same validation gate as single-file import (§1.8), and rollback that keeps later tools (§4 #3). See HRD-32, HRD-33 and HRD-38. Not automated: the AC's 200-file live-queue run.

- **Requirements:** `showDirectoryPicker()` → apply one operation to every matching file;
  per-file progress, per-file error isolation (one failure never aborts the run), summary
  report, output to a chosen directory or ZIP.
- **AC:** 200 files process with a live queue; a deliberately corrupt file is reported and
  skipped while the other 199 complete.

**Amended (2026-09-14):** CMP-04's never-grow guarantee ("no fixture, under any setting,
can produce a saved file larger than its input") did not actually hold for a batch recipe
that both compresses and touches a permission-restricted file. `compressDocument`'s own
`keptOriginal` check compares only against the bytes it was handed; it has no way to know
that restriction reapplication (a fresh `/Encrypt` dictionary, hex-string ciphertext, and
`useObjectStreams: false` giving up the xref stream) is about to add bytes back afterwards
— on a file barely worth compressing, that overhead alone could erase the gain and leave
the batch output larger than skipping compression would have, written silently. The batch
runner now compares its final, fully-restricted output against what skipping compression
(restricted the same way) would have produced, and discards the compressed version with a
`kept-original` note if it did not actually help. `tests/unit/batch-runner.test.ts` ›
"compress's never-grow guarantee survives restriction reapplication" (two tests: one
proving the discard, one proving a genuine reduction is still kept).

### BAT-02 · Saved recipes — `M` `P1`

**Status: Done (re-audited 2026-08-17)** — AUDIT-2026-08-17 §1 found recipes in `localStorage`, no JSON export or import, and a hard-coded 4-tool chain. Recipes now live in IndexedDB (`recipes` store, `core/db.ts`, with a one-time `localStorage` migration), export and import as JSON (partial imports are reported), and the chain is a checkbox-and-reorder UI. An unchecked tool is verified to be excluded, and a recipe survives a reload. A malformed stored recipe stops the run with a clear message (`batch-runner.test.ts` › "X-15: …"). Not automated: the AC's 50-file "identical to manual" comparison.

- **Requirements:** Chain operations (e.g. compress → watermark → number pages), save
  named recipes to IndexedDB, one-click apply to a file or a batch. Export/import recipes
  as JSON.
- **AC:** A 3-step recipe applied to 50 files produces identical results to running the
  steps manually.

---

## EPIC-10 · OCR and local search

### OCR-01 · Tesseract integration with disclosed model download — `L` `P2`

**Status: Done (hardened by AUDIT-2026-09-25 CONV-2/CONV-8/CONV-16, 2026-09-26)** — Lazy `tesseract.js` with user-confirmed, SHA-256-pinned model download, cached offline. Tesseract can never fetch on its own (`cacheMethod: 'readOnly'`, a `langPath` with no network, engine-load failure fatal for the run); an uploaded model is trial-loaded before it is kept and stored models can be removed; the download streams with progress and is cut off past twice the pinned size. The CSP's `connect-src` allows only the pinned model paths. Searchable text layer produced over the original scan. See HRD-51, HRD-52.

- **Requirements:** Lazy `tesseract.js`; language model fetched **once** on explicit user
  confirmation, cached in CacheStorage/IndexedDB, then fully offline. Confirmation dialog
  states exactly what is downloaded and from where — this is the sole documented exception
  to the zero-network invariant. Produce a searchable text layer over the original scan.
- **AC:** After first download, OCR works with the network disabled. The extension performs
  no fetch unless the user opts in. Recognized text is selectable in the exported PDF.

### OCR-02 · Folder index and search — `L` `P2`

**Status: Done (2026-10-05)** — `indexDirectory` / `searchFolderIndex` in `src/core/ocr/folder-index.ts` keep an inverted index in IndexedDB (`searchIndex` store), with snippets, page numbers and jump-to-page. Incremental re-index skips unchanged files. Stale responses are dropped (`searchSeq`, AUDIT-EDGE-CASES §3 #9). A real pdf.js multi-page extraction is tested (`tests/unit/folder-index.test.ts`). "OCR scans on demand" is implemented (AUDIT-2026-08-17 §1 had found `enableOcr` declared but never used): an opt-in "Also OCR scanned pages" option in folder search. It is consent-gated (with no stored model it never asks or downloads on its own; turning it on shows OCR-01's consent dialog, and declining fetches nothing), cached per file and language (an unchanged file is not OCR'd again; a language change re-OCRs its text-less pages), cancellable mid-folder, and marks hits with a "Recognized text" badge. Tests: `tests/unit/folder-index-ocr.test.ts` › "ocr/folder-index — OCR scans on demand (OCR-02)".

- **Evidence:** `pnpm check && pnpm test` on master after merge at commit `e2488b9`.
  37 test files · 416 tests · 0 failures. New test file: `tests/unit/folder-index.test.ts`
  (182 lines, 7 dedicated tests).

- **Requirements:** Index a chosen directory's PDFs (text layer, OCR scans on demand);
  inverted index in IndexedDB; query with snippets, page numbers, and jump-to-page;
  incremental re-index on change.
- **AC:** 200 PDFs indexed, queries return in <500ms with correct page attribution.

### OCR-03 · Table extraction → CSV/XLSX _(beta)_ — `L` `P2`

**Status: Done** — `extractTableFromPage` clusters text items into rows
(y-tolerance) and columns (x-alignment); `exportTableToCsv`, `exportTableToTsv`,
`exportTableToXlsx` in `src/core/ocr/table-extract.ts`. `TableExtractPanel` presents a
mandatory editable preview grid before any download. Clearly labelled beta in the UI.

- **Evidence:** `pnpm check && pnpm test` on master after merge at commit `ff0a60e`.
  37 test files · 416 tests · 0 failures. New test file: `tests/unit/table-extract.test.ts`
  (172 lines, 14 dedicated tests).

- **Requirements:** Infer columns from text x-positions; mandatory preview grid before
  export; clearly labelled beta.
- **AC:** Bank-statement fixture extracts with correct row/column alignment; preview cannot
  be bypassed.

### OCR-04 · Hindi + mixed-language OCR with a non-Latin text layer — `M` `P2`

**Status: Done, verified against a real browser run** — `hin` and `eng+hin`
added to `OCR_LANGUAGES` (`src/core/ocr/model.ts`). A combined run is left
entirely to tesseract's own loader: `langPath` is left unset, so it computes
each language's own default URL (the exact pinned package/version
`resolveModelBase` uses) and caches each independently — no pre-fetching into
OPFS is needed or done. A vendored, OFL-licensed Devanagari font
(`src/core/ocr/assets/NotoSansDevanagari.ttf`, subset to Basic Latin +
Devanagari, ~180 KB) is embedded via `fontkit` as a fallback whenever a word
Helvetica cannot show appears, so a Hindi or Hinglish word is no longer
silently dropped from the invisible text layer.

- **The bug this closes, not just the gap:** `@cantoo/pdf-lib`'s standard-font
  encoder does not throw on a codepoint outside WinAnsi the way upstream
  pdf-lib does — it silently substitutes `?` and reports success. The
  pre-existing `encodable()` check in `textLayer.ts` trusted `encodeText` to
  throw as its capability test, so it never actually detected an unencodable
  word; any non-Latin OCR text (not just Hindi) was being written into the
  text layer as literal question marks while being counted as *added*, not
  skipped. Fixed by checking `Encodings.WinAnsi.canEncodeUnicodeCodePoint`
  directly instead of relying on a throw (`winAnsiEncodable` in
  `textLayer.ts`).
- **A second, subtler bug on the way to fixing the first:** encoding a whole
  word through a shaping-aware custom font (`fontkit`'s `layout`, which
  `CustomFontEmbedder.encodeText` calls) reorders combining marks for correct
  *visual* placement — e.g. a Devanagari vowel sign is stored after its
  consonant in Unicode but drawn before it. This text is never painted, only
  indexed, so that reordering corrupted the extracted string ("सचिवालय" came
  back as "सिचवालय"). Fixed by encoding one character at a time
  (`encodeInLogicalOrder`), which gives the shaper nothing to reorder against.
- **Two more bugs found only by actually running OCR in a real browser**
  (unit tests mock the worker boundary, so neither surfaced until a live
  Playwright run against the real Adobe Scan fixture that motivated this
  ticket):
  - `cv.worker.ts`'s `cleanupForOcr` read `bitmap.width`/`bitmap.height`
    *after* `bitmap.close()` — an `ImageBitmap`'s dimensions reset to 0 once
    closed, so `getImageData` was asked for a zero-width image and threw on
    **every** OCR run, any language, from the moment the phone-scan cleanup
    step (above) was added. Fixed by capturing the dimensions before closing.
  - `tesseract.js@7.0.0` has a genuine bug in its own `initialize()`: given an
    array of `{code, data}` objects (what a combined run's original design
    built, to hand tesseract pre-fetched bytes directly), it derives the
    language string for `TessBaseAPI.Init` via `langs.map(l => l.data).join
    ('+')` — the *bytes*, not `l.code` — so recognition failed outright
    ("Tesseract couldn't load any languages!"). Fixed by never building that
    array for a combined run (see the loader-is-sufficient-alone note above);
    the single-language "uploaded a custom model" path still uses a
    one-element version of the same array shape and carries the same bug,
    tracked separately since it is untouched by, and not exercised by, this fix.
- **Evidence:** `pnpm test` — 56 test files, 633 tests, 0 failures, including a
  fixture round-tripping a real Devanagari word through
  `addOcrTextLayerToDocument` → `save()` → pdf.js `getTextContent()` and
  asserting the exact string comes back. `pnpm run check:type`,
  `check:lint`, `check:format`, `check:invariants` all pass.
  `BUILD_TARGET=ext vite build` succeeds; the font asset is emitted as an
  ordinary bundled file (`dist/ext/assets/NotoSansDevanagari-*.ttf`), not
  fetched from a remote host. Additionally verified end-to-end against a real
  browser: a Playwright run imported the actual Adobe Scan fixture that
  prompted this ticket, ran OCR with English + Hindi (mixed) — real consent
  dialog, real 14 MB model download, real tesseract recognition — and
  re-extracted correctly-formed Hindi ("सचिवालय", "उत्तराखण्ड", "अधिकारी", full
  sentences) from the result, with the report reading "234 words added across
  1 page. Replaced an existing, broken text layer on 1 page."
- **Requirements:** Hindi selectable as its own OCR language; a combined
  English+Hindi run recognises mixed-script ("Hinglish") pages in one pass;
  recognised Devanagari text survives into the exported PDF's searchable text
  layer.
- **AC:** `hin` and `eng+hin` appear in the language picker. A combined run
  discloses only the language(s) not yet downloaded, in one consent dialog,
  and cannot re-fetch a language already cached. A page containing Devanagari
  text produces an exported PDF whose text layer contains that exact text
  when re-extracted — not skipped, not garbled into `?`, not reordered.
- **Robustness for a phone-camera scan:** every OCR run now passes each
  rasterised page through `cv.worker.ts`'s new `cleanupForOcr` — adaptive
  thresholding (SCN-02's Auto-preset parameters) to cancel the lighting/shadow
  gradient a flash or angled light leaves, plus despeckle for JPEG noise —
  before handing the bitmap to tesseract. Reuses the exact, already-shipped
  SCN-02 pipeline rather than new heuristics. Deliberately excludes deskew and
  perspective dewarp: both move pixels to different coordinates, and
  `textLayer.ts` places recognised words by mapping bitmap pixels back to page
  points via a plain DPI scale plus the page's own `/Rotate` (one of four
  fixed angles) — feeding it a dewarped or arbitrarily-rotated bitmap would
  place every word's invisible box in the wrong spot without a general
  affine/perspective inverse fed back through `OcrPageLayer`, which is a
  separate, larger project.
- **Known limitation, not addressed here:** the above — deskew/dewarp for OCR
  specifically requires generalizing `textLayer.ts`'s placement math beyond
  the four fixed rotations, and no low-confidence-word filtering exists yet.
  Both are orthogonal to language support and the lighting/noise cleanup above.

---

## EPIC-12 · Accessibility, i18n, performance

### NFR-01 · Accessibility pass — `M` `P0`

**Status: Done (2026-10-05)** — Focus traps, the roving-tabindex grid, accessible names, live regions and reduced motion are each asserted in e2e. AUDIT-2026-08-17 §1/§3 #20 found a serious `nested-interactive` + `aria-allowed-role` violation on Home (`DropZone`), hidden because the sweep skipped Home and never opened a document. Now `a11y-and-perf.spec.ts` › "every route has one main landmark, a title, and no positive tabindex" scans Home and every registered tool with a document open. That sweep surfaced further violations, all fixed (HRD-09). The AC's "every route in both themes" is now met at desktop width: the sweep runs once per theme (`a11y-and-perf.spec.ts` › "every route has one main landmark, a title, and no positive tabindex (light)" and "(dark)"), covering Home with and without the welcome dialog, the trust panel, every registered tool with a document open, and the privacy page. Fixes it needed: the privacy page gained a `<main>` landmark and underlined links (`public/privacy.html`), and tooltips now portal into a host inside the main landmark rather than `document.body` (`FloatingTooltip.tsx`). Phone width stays covered by `mobile.spec.ts`.

- **AC:** axe-core: zero violations on every route in both themes. Full keyboard walkthrough
  of merge, organize, sign, and compress flows documented. Screen-reader pass on the page
  grid announces page number and selection state. `prefers-reduced-motion` honoured.

### NFR-02 · Performance budget enforcement — `M` `P0`

**Status: Done** — Every budget in `tests/e2e/perf.spec.ts` (the never-retried `perf` project, AUDIT-2026-09-25 PLT-18; formerly in `a11y-and-perf.spec.ts`) is asserted for real:
interactive <500ms, first thumbnail <1.5s, all-100-thumbnails-scrolled-through <6s, windowed
mounting, merge 10×5MB <8s, peak heap on heavy/300-page fixtures, **and** the 50ms main-thread
rule — a `requestAnimationFrame` monitor during the 10×5MB merge asserts the max frame gap
stays under 70ms (a small margin over the 50ms budget for CI stability), not just that the
merge finished in time. Initial chunk 226KB/74KB gzipped against the 900KB budget
(`scripts/check-bundle-size.js`, in `pnpm check`). The old test asserted `tti < 5000` while
claiming a 500ms budget — that comment was already stale by the time this pass started; the
current test actually asserts `< 500`.

**Re-audited 2026-09-26 (AUDIT-2026-09-25 §4, PLT-2 / PLT-18): Done, with one caveat.**
"Fails CI" was not true when this was marked Done — CI had never run (the workflow
triggered on a branch that did not exist). `.github/workflows/ci.yml` now triggers on
push/PR to `master`, and the budgets run in their own `perf` job (`pnpm test:perf`,
`tests/e2e/perf.spec.ts`), never retried, so a slow run fails instead of being retried
green. Caveats, stated rather than hidden: (1) CI runs the budgets with
`STAPLER_PERF_SLACK=1.5`, i.e. 1.5× PLAN §5.1's numbers, to allow for shared runners —
every run records measured vs budget as a test annotation; (2) from this environment we
can confirm the workflow file, not that a GitHub run has happened. The merge
main-thread budget, which failed 4/4 during the audit because Comlink transfers were
silently structured-clones, now passes locally.

**Merge frame gap fixed (2026-10-05):** the longest main-thread frame gap during the 10×5MB
merge went from 67 ms to 17 ms (the download is assembled as a chunked Blob, review bytes
are transferred rather than cloned, and the review's pixel diff moved to the cv worker), so
`perf.spec.ts` › "merges 10 × 5MB PDFs within 8 seconds" now asserts the gap against the
real 50 ms budget (× `STAPLER_PERF_SLACK`) instead of 70 ms. The same project now also
asserts DOC-04's 60 fps scroll, CNV-01, CNV-02's memory ceiling and F-05's cancel, with
worker heaps measured (HRD-08, HRD-12).

- **AC:** Automated Playwright perf test asserts every budget in PLAN §5.1 and fails CI on
  regression. Bundle-size report fails the build above 900KB gzipped for the initial chunk.

### NFR-03 · Memory safety on large documents — `M` `P0`

**Status: Partly done (2026-10-05)** — Worker heaps are measured now. `tests/e2e/perf.spec.ts` › "NFR-03: processes heavy documents within memory limits" opens three large files in sequence (heavy, 300-page, heavy again), and `tests/e2e/worker-heap.ts` reads every realm over CDP (`Runtime.getHeapUsage`, no COOP/COEP needed); the test asserts 200 MB per realm (main and each worker) and 1.5 GB across all realms including buffers (AUDIT-FINDINGS §2.5, HRD-12). CNV-02's 300 DPI export is held to the same ceilings. Measured 2026-10-05: main heap about 10 MB, largest worker heap about 10.6 MB, all realms about 107 MB. **Open:** the AC's heap snapshot is not taken, so retention is bounded only by the ceilings; a bitmap leak smaller than the headroom would pass.

- **AC:** 300-page and 100MB fixtures complete every P0 operation within the memory ceiling.
  A heap snapshot after processing three large files in sequence shows no bitmap retention.

### NFR-04 · i18n framework and 10 locales — `M` `P1`

**Status: Done for coverage; RTL layout and translation review are not verified** (re-audited 2026-09-26).

**Reopened by AUDIT-2026-09-25 (UI-8), now largely closed.** When this was marked Done,
383 keys passed to `t()` existed in no locale file (English only rendered correctly
because keys are English text), and messages generated in workers were never translated.
Now `tests/unit/i18n-coverage.test.ts` statically extracts every key passed to
`t`/`translate`/`tPlural`/`tKey` in `src/` and fails if any locale lacks it, lacks a
plural category its language needs (CLDR, via `Intl.PluralRules`), or drops a
`{placeholder}`; workers load their locale and translate their own messages
(`tests/unit/worker-locale.test.ts`). All ten non-English locales now carry real
translations, including the CNV-08..13 disclaimers the 2026-09-05 note below deferred.
Still open against the AC as written: (1) the translations have not been reviewed by
native speakers; (2) "Arabic shifts the UI layout seamlessly" has no automated check —
`dir="rtl"` is set, but the tool canvases have not been walked through in Arabic.

Original entry: [x] **NFR-04** — Implement an i18n framework.
  - *Context*: Some users speak Spanish. The team wants to expand globally, so we need RTL support.
  - *AC*: No hard-coded user-facing strings remain in English; Arabic shifts the UI layout seamlessly without breaking the unified canvas tools.
  - **Correction found in a later audit:** `initLocale()` was dead code — nothing called it, so no dictionary ever loaded on boot and the only way one loaded at all was the user manually touching the language `<select>`. Strings keyed by their own English text (most of them) rendered correctly by accident; strings keyed symbolically (`header.title`, `tool.batch`, `tool.compare`, and the `tool.annotate.*`/`tool.sign.*` keys added in this pass) rendered their literal dotted key. Fixed by calling `initLocale()` at bootstrap in `src/ui/app.tsx`, alongside a related signal-reactivity fix (`dictionaryVersion`) needed for translated strings to actually re-render on language change.
  - **Second correction, 2026-09-05:** the six CNV-08..13 converter panels all correctly call `t()`/`translate()` on their strings, but none of those ~139 keys (an AST scan of every literal argument to `t`/`translate` across the six panels plus the `EXCEL_LIMITATIONS`/`PPTX_LIMITATIONS`/`PPT_LIMITATIONS`/`BLANK_SLIDE_LABEL` constants they render confirms the exact count) existed in `en.json` or any other locale dictionary. English rendered correctly only by the same key-equals-text coincidence noted above; every other locale would have shown English regardless of the selected language, silently. Registered all 139 keys in `en.json` (key = English text, matching `scripts/i18n-extract.ts`'s own convention) so the dictionary is now a complete source of truth for a future translation pass — `i18n-extract.ts` only harvests literal JSX text and specific attributes, so it would never have picked these up on its own, since the CNV series wrote `t('...')` calls directly instead of relying on the codemod. Translation into the other 9 locales was deliberately deferred (not done here): several of these keys are full disclaimer paragraphs about exactly what each beta converter preserves — the PLAN §5.5 claims-discipline copy — and shipping unreviewed AI translations of that into 10 languages, several non-Latin scripts, was judged a real quality/risk tradeoff rather than a mechanical fix. Until a reviewed pass exists, all 9 non-English locales fall back to English for these strings — the same documented behavior RED-07 already accepts for new UI strings pending the next `i18n-extract` pass.

---

## EPIC-13 · QA infrastructure

### QA-01 · Fixture corpus — `M` `P0`

**Status: Done** — Deterministic generators for large/heavy files, rotated pages, SMask, and AcroForm added to `tests/e2e/fixtures.ts`. Static minimal/raw PDFs for CMYK, scanned skew, JBIG2, JPX, XFA, CJK, RTL, and encrypted committed to `tests/fixtures/` with a README.

**Build this first — before feature work.** Assemble every fixture listed in PLAN §6 with a
README describing what each one is for and what must not regress.

- **AC:** 18+ fixtures committed with documented expectations. Total repo size stays
  reasonable (compress or generate large fixtures at test time).

### QA-02 · Unit and golden-file suites — `M` `P0`

**Status: Done** — The unit suite (176 files in `tests/unit/` on 2026-10-05; count it with `pnpm test` rather than quoting a number here, see HRD-01) includes `tests/unit/golden.test.ts`: one golden-file test per pdf-lib-based P0 operation (merge, organize, split, extract, insert, images→PDF, plus crop and normalize). Each drives the real code path and re-parses the output for page count, order and text content. PDF→images, PDF→text/Markdown and both compress routes need pdf.js's real decode/render path (there is no Node/vitest equivalent) and are covered end to end by `tests/e2e/tool-flows.spec.ts` instead.

- **AC:** Every `core/ops` function has unit coverage. Every operation has a golden-file
  test that re-parses output and asserts page count, order, and text content.

### QA-03 · Zero-network CI test — `S` `P0`

**Status: Done (re-audited 2026-09-26)** — Layered: the web-preview sweep of every tool, the `extension` Playwright project on the real `dist/ext` (smoke set, not every tool), an AST network guard, a post-build bundle scan and a strict CSP in both builds (HRD-53, HRD-54). pdf.js data files are bundled.

**Reopened by AUDIT-2026-09-25 §4 (PLT-2, PLT-6, PLT-7), now closed again.** "CI fails if…"
was not true when this was marked Done: CI had never run, the sweep only ever ran against
the web preview (never the extension), and the invariant guards missed most of 30 bypass
payloads. Now, layered:

- `tests/e2e/zero-network.spec.ts` (web preview) plus the `extension` Playwright project
  (`tests/e2e/extension/`), which loads the real `dist/ext` under its MV3 CSP and fails on
  any request outside the package, any CSP violation or any page error.
- An AST-based static guard (`scripts/network-guard.mjs`, used by both the write hook and
  `scripts/check-invariants.mjs`); `tests/unit/network-guard.test.ts` covers 69 bypass
  payloads (aliased/computed `fetch`, remote `import()`, `new Image().src`, CSS `url()`,
  HTML resource attributes, …) and 26 negatives — the "deliberately add a Google Fonts
  link / CDN import" AC is exercised there on every run.
- A post-build scan of both builds for remote URLs (`pnpm check:bundle-network`, CI job
  `bundle-network`), and a strict CSP in both builds (`default-src 'self'`).
- CI (`.github/workflows/ci.yml`) triggers on push/PR to `master` and runs `e2e`,
  `e2e-extension` and `bundle-network`. Whether a GitHub run has happened cannot be
  confirmed from here.

Known gap: the extension project covers load, licence file, PNG import, merge and face
blur; the per-tool sweep (every tool route) runs against the web preview only.

The test that protects the entire product claim.

- **Requirements:** Playwright run with `page.on('request')`; any request whose URL is not
  `chrome-extension://` or a `blob:`/`data:` URL fails the test. Runs across every tool flow.
- **AC:** CI fails if a developer adds a Google Fonts link, a CDN import, or an analytics
  snippet. Verified by deliberately adding one and confirming the failure.

### QA-04 · E2E flows per tool — `L` `P0`

**Status: Done** — Flows for every P0 tool asserting real output bytes, including sign
(text stamp, AcroForm fill, XFA refusal), redact (drawn-region removal, keyboard-only
marking), and cleanup (B&W preset alters the page, verified by re-import and pixel sample) —
each has its own QA-01 fixture. The per-tool flows run on the web preview; the packaged extension has a smoke set (see
the re-audit note below and HRD-54).

**Re-audited 2026-09-26 (AUDIT-2026-09-25 §4, PLT-2 / PLT-7 / M4): Done, with the scope
stated.** "Runs headless in CI" was not true when this was marked Done — CI had never run —
and every flow tested the web preview, which is how HEIC shipped dead in the extension
(CONV-1). Now the `e2e` CI job runs the web functional suite on push/PR to `master` (one
retry, and `failOnFlakyTests` fails a run that only passed on the retry), and a separate
`e2e-extension` job runs the packaged-extension project against the `dist/ext` it just
built. After the audit fixes the suite was 160/160 across the web, extension and perf
projects. The per-tool import → operate → export flows are still web-preview flows; the
extension project is a smoke set (load, PNG import, merge + export, face blur), not a
per-tool copy of the suite. Several flows that raced the UI were fixed to wait on
conditions (audit §7).

- **AC:** Each P0 tool has an import → operate → export test asserting real output bytes.
  Suite runs headless in CI in under 10 minutes.

### QA-05 · External viewer compatibility checklist — `S` `P0`

**Status: Done** — Automated structural validation implemented in `scripts/qa05-validate.mjs`
(run via `pnpm run qa05`). Tests 8 P0 tool output categories (Merge, Rotate, Split,
Export/Compose, Compress, Sign/AcroForm, Annotate, Table Extract CSV) — all 8 pass.
Manual external-viewer steps (Chrome, Acrobat, Preview, Firefox pdf.js) are documented
in `RELEASE_CHECKLIST.md` §1 as pre-release gates. The automation covers the maximum
possible without a real PDF viewer process.

- **Evidence:** `node scripts/qa05-validate.mjs` (2026-08-16): 8/8 checks passed.

- **AC:** Manual checklist covering Chrome viewer, Acrobat Reader, macOS Preview, and
  Firefox pdf.js, run before each release and recorded in the release notes.

---

## EPIC-14 · Distribution

### DIST-01 · Store listing assets — `M` `P0`

**Status: Done** — Title, short/long description, keywords, and icon set (16/32/48/128,
generated by `scripts/generate-icons.mjs` — the previous files were 1×1 placeholder pixels,
undetected because the only test checked the manifest declared a path, never the file's real
dimensions) are done. 5 screenshots exist (`docs/screenshots/`, generated by
`scripts/generate-screenshots.mjs` against the real built app), first is scan cleanup
before/after. Copy explicitly states no upload, no account, no size limit, no watermark, open
source/MIT — previously only implied some of these. No competitor trademarks; no "legally
binding" signature claim (`SignPanel.tsx` says the opposite explicitly). The 1280×800 promo
tile and 440×280 small tile now exist too (`docs/promo/`, `scripts/generate-promo-tiles.mjs`,
`npm run assets:promo`). The 1400×560 marquee tile remains unproduced — optional and outside
this ticket's AC.

- **Requirements:** Keyword-bearing title (PLAN §7), short and long description, 5
  screenshots (first = scan cleanup before/after), 1280×800 promo tile, icon set. Copy must
  state: no upload, no account, no size limit, no watermark, open source. **No competitor
  trademarks. No "legally binding" signature claim.**
- **AC:** Listing passes review on first submission. Every claim in the copy is true and
  demonstrable.

### DIST-02 · Privacy policy and public repo — `S` `P0`

**Status: Done** — In-app trust panel and MIT licence. `public/privacy.html` ships into both build targets and is now linked from the trust panel (previously unreachable from the app). `README.md` exists and documents `pnpm run verify`/the DevTools check for the zero-network claim.

- **AC:** Privacy policy page states no data collection, hosted in-extension and on the
  website. Repo public under MIT with a README explaining how to verify the zero-network
  claim.

### DIST-03 · Website twin with per-tool landing pages — `L` `P1`

**Status: Partly done — Lighthouse ≥95 is unverified on a real deploy** (re-audited 2026-09-26).

**Reopened by AUDIT-2026-09-25 §4 (PLT-4, PLT-17).** Two claims below did not hold: the
site is deployed to **GitHub Pages**, not Cloudflare Pages, and the deployed twin had **no
CSP at all** (GitHub Pages cannot set response headers). Now the web build injects the
same CSP the extension manifest carries as the first `<meta http-equiv>` of every page
(`vite.config.ts` `stapler:web-csp`, from `scripts/csp.mjs`; `tests/unit/csp.test.ts`),
and PLAN notes the real GitHub Pages deploy. Still unmet: the AC's "Lighthouse ≥95 on all
four categories" has never been measured on the deployed site — the only numbers are the
local 2026-08-16 run below (90–92 performance, index SEO 91), which is **below** the AC's
95. `frame-ancestors`/`X-Frame-Options` cannot be expressed in a `<meta>` CSP, so
clickjacking protection on the web twin depends on the host. The offline/installable
twin is DIST-06; compress-to-size landing pages are DIST-08.

**2026-10-06 — generated, not committed.** The sixteen landing `.html` files (these
eleven plus DIST-08's five) no longer sit at the repo root. Each page's text lives once in
`src/landing/pages.ts` (typed data: slug, name, description, og text, h1, intro, feature
points, FAQ, entry script, body attributes) and one template, `src/landing/template.ts`,
renders the full document. The `stapler:landing-pages` plugin in `vite.config.ts` serves
each as a virtual `<root>/<slug>.html` module (`resolveId`/`load`), so Vite's HTML
pipeline and `stapler:web-csp` treat it exactly like a file and emit `dist/web/<slug>.html`
at the same URL; `pnpm dev` serves the same render at `/<slug>.html`. `sitemap.xml` is
emitted from the same list (it is no longer in `public/`). Verified on output bytes: every
file of `dist/web` (all HTML, `sitemap.xml`, every hashed asset and `sw.js`) was
byte-identical before and after the move. `scripts/check-invariants.mjs` scans the
rendered pages, and the CSP e2e case iterates the page list. The implementation notes
below that mention "the static `.html` file" now mean the rendered page.

Original entry: `pnpm build:web` now emits eleven real static HTML entry points,
and all twelve landing pages (index + 11 tool pages) serve HTTP 200 from `vite preview`.
Lighthouse scores measured locally against `http://localhost:4173` (2026-08-16), for the
original five tool pages:

| Page | Perf | A11y | Best Practices | SEO |
|---|---|---|---|---|
| `/` (index) | 90 | 100 | 96 | 91 |
| `/merge-pdf.html` | 92 | 96 | 100 | 100 |
| `/compress-pdf.html` | 92 | 96 | 100 | 100 |
| `/sign-pdf.html` | 92 | 96 | 100 | 100 |
| `/scan-cleanup.html` | 92 | 96 | 100 | 100 |
| `/redact-pdf.html` | 92 | 96 | 100 | 100 |

All landing-page categories ≥90; SEO 100 on tool pages (91 on index — the index
shares the editor's `<title>` rather than having its own landing title). SEO fixes
applied: absolute `rel=canonical` URLs and `public/robots.txt` added.
Cloudflare Pages / real-domain Lighthouse is a deploy-time step for the submitter.

Extended 2026-09-05 to cover the six CNV-08..13 converters — `/pdf-to-word`,
`/word-to-pdf`, `/pdf-to-excel`, `/excel-to-pdf`, `/pdf-to-ppt`, `/ppt-to-pdf` — the
same shape as the original five (search volume for "pdf to word" etc. is exactly the
kind of front-loaded SEO door PLAN §1 argues for, and it was the one gap left after
CNV-08..13 shipped without matching landing pages). Copy for each states the beta
status and the specific fidelity limit from that tool's `summary` in
`src/core/tools.ts` (PLAN §5.5's claims-discipline rule), plus a card calling out the
mandatory preview PLAN §5.5 requires before every conversion. `public/sitemap.xml`
was also filled in — previously it listed only `/`, missing all eleven tool routes.
New pages were not re-measured with real Lighthouse (same "unverified here" caveat as
the original five, below); they reuse the identical static-hero/`marketing.css`
pattern that scored ≥90 on all categories, so no new failure mode is expected, but
that is an inference, not a measurement.

- **Requirements:** `pnpm build:web` deployed to Cloudflare Pages; routes `/merge-pdf`,
  `/compress-pdf`, `/sign-pdf`, `/scan-cleanup`, `/redact-pdf`, `/pdf-to-word`,
  `/word-to-pdf`, `/pdf-to-excel`, `/excel-to-pdf`, `/pdf-to-ppt`, `/ppt-to-pdf`, each
  server-rendered static with the tool preloaded, plus an install CTA. Upstream's
  marketing components (hero/display type, feature cards) are appropriate here.
  - Implementation: `vite.config.ts` adds these eleven `.html` files to
    `rollupOptions.input` only when `BUILD_TARGET` is not `ext` (same gating as the
    existing `emitWebIndex` plugin), so `build:ext` is untouched — confirmed: `dist/ext`
    contains only `editor.html`/`privacy.html`, no landing pages.
  - The routed app tree was pulled out of `app.tsx` into `src/ui/AppRoot.tsx` (exported
    `App` component, no side effects) so both the editor entry and the landing pages mount
    the *same* tool code — merge/compress/sign/cleanup/redact are not reimplemented for
    the marketing site. `src/ui/mountLanding.tsx` sets the initial hash route to the
    page's tool (`#/tool/<id>`) before mounting, so the tool is preloaded on a direct hit.
    Global error hooks were factored into `src/ui/errorHooks.ts`, shared by both entries.
  - Hero/feature/CTA markup lives directly in each static `.html` file (real `<h1>`,
    description, feature cards, and CTA — present before any script runs), styled by a
    new `src/ui/styles/marketing.css` using only `var(--token)` from `tokens.css`
    (`check:tokens` passes). Two new type tokens were added, `--text-display` and
    `--text-headline`, for the hero — DESIGN-ADAPTATION §3.2 already documents a
    website-twin-only display ramp; these are the first tokens to use it, deliberately
    kept far below upstream's 80px.
  - The install CTA is a disabled `<button>` reading "Install from the Chrome Web
    Store — coming soon", matching README's own "Coming Soon" status — the store listing
    is not live (`docs/STORE_LISTING.md`), so this does not link to a placeholder URL that
    would look real but go nowhere. A second CTA jumps to the embedded tool itself.
- **AC:** Lighthouse ≥95 on all four categories. Each landing page works fully without the
  extension installed.
  - Lighthouse ≥95: **unverified here** — no Cloudflare Pages deploy or Lighthouse CI
    access in this environment. The build has no runtime network requests (zero-network
    e2e assertion passes against the built site, see below), real per-page meta
    title/description, semantic headings, and a `min-height` reservation for the mounted
    app to avoid layout shift, which point at a passing run but were not measured with
    real Lighthouse.
  - Works fully without the extension installed: **met**. Each page mounts the real
    `App`/tool code client-side; nothing in the landing bundle references the extension
    or `chrome.*` (layer boundary unchanged — landing files import only `core/`/`ui/`).
  - Evidence: `BUILD_TARGET=web vite build` emits all 12 pages
    (`dist/web/{index,editor,merge-pdf,compress-pdf,sign-pdf,scan-cleanup,redact-pdf,
    pdf-to-word,word-to-pdf,pdf-to-excel,excel-to-pdf,pdf-to-ppt,ppt-to-pdf}.html`)
    with real content, injected per-page CSS/JS by Vite (confirmed by inspecting
    `dist/web/merge-pdf.html` and `dist/web/pdf-to-word.html`). `BUILD_TARGET=ext vite
    build` output is unchanged (only `editor.html`/`privacy.html`). `pnpm check`
    (type/lint/format/tokens/invariants) passes. The two `tests/e2e/zero-network.spec.ts`
    cases pass against the built web preview. Full `pnpm test:e2e` and a real
    Lighthouse/Cloudflare run remain manual follow-ups — add to the `QA-05`/`DIST-05`
    manual checklist.

### DIST-04 · Edge and Firefox submissions — `M` `P1`

**Status: Done** — Everything doable without a store account or a real Firefox/Edge
browser is done and verified. Both `dist/ext` (Chrome/Edge) and `dist/firefox` build
correctly and pass structural validation via `scripts/validate-builds.mjs` (14 checks,
all passing). The submissions themselves require a store account and a human submitter;
instructions are in `RELEASE_CHECKLIST.md` §5 and §5b.

- **Evidence:** `pnpm build:ext && pnpm build:ext:firefox && node scripts/validate-builds.mjs`
  — 14/14 checks passed. `tests/unit/firefox-manifest.test.ts` (4/4) green.

- Edge Add-ons: no code changes were needed. `public/manifest.json` (empty `permissions`
  and `host_permissions`, module `background.service_worker`, no content scripts) is
  already Chromium MV3 as Edge consumes it. The layer-boundary audit
  (`grep -rl "chrome\." src`) turned up `chrome.*` only in `src/platform/{current,index}.ts`
  and `src/background/service-worker.ts` — no violation of the `core`/`ui` boundary, so
  nothing Chrome-specific leaks outside the platform layer that Edge would trip over.
- Firefox: two real MV3 differences existed and are now handled.
  1. AMO requires `browser_specific_settings.gecko.id` (+ a minimum version). Chrome's
     manifest has neither.
  2. Firefox does not run `background.service_worker`; it needs the classic
     `background.scripts` + `type: "module"` event-page shape. Same compiled
     `background.js`, different manifest key.
  - `pnpm build:ext:firefox` (`BUILD_TARGET=firefox vite build`) now emits a third,
    independent unpacked directory, `dist/firefox`, byte-identical to `dist/ext` apart
    from `manifest.json`. The rewrite is a pure function,
    `transformManifestForFirefox` (`scripts/firefox-manifest.mjs`), applied to the
    manifest Vite already copied from `public/`, via a `writeBundle` plugin
    (`firefoxManifest()` in `vite.config.ts`) — the same pattern `copyPdfJsAssets`
    already used. Permissions, CSP, and icons are untouched, so Chrome/Edge and Firefox
    cannot drift apart from hand-maintaining two manifest files.
  - `gecko.id` is fixed in the Firefox manifest transform as
    `stapler-offline-pdf@stapler.app` — AMO submission still uses that same add-on ID.
  - The File System Access fallback the AC asks to see "exercised on Firefox" already
    existed before this ticket: `src/platform/file-system.ts`'s `openFilesViaInput`
    (`<input type=file>`) and `saveViaDownload` (anchor download), wired in through
    `hasFileSystemAccess()` checks in both `src/platform/extension.ts` and
    `src/platform/web.ts`. No new platform code was needed — this was already correct for
    a browser without `showOpenFilePicker`/`showSaveFilePicker`/`showDirectoryPicker`; it
    was simply never proven to matter until this ticket asked for a real Firefox build to
    point it at.
- **Verified here:** `pnpm check` (type/lint/format/tokens/contrast) green; `pnpm test`
  green except one pre-existing, unrelated failure (`tests/unit/process.test.ts` —
  missing fixture `tests/fixtures/oversized-mask.pdf`, not touched by this ticket);
  `tests/e2e/manifest.spec.ts` (6/6) green against the unmodified Chrome/Edge manifest;
  new unit test `tests/unit/firefox-manifest.test.ts` (4/4) asserting the Firefox manifest
  keeps every hard invariant and only changes the two fields above; `pnpm build:ext` and
  `pnpm build:ext:firefox` both run to completion, each producing a loadable
  `dist/{ext,firefox}` with `manifest.json`, `background.js`, `editor.html`/`.js`, workers,
  and icons present; `pnpm build:web` re-run afterward to confirm the website twin is
  unaffected.
- **Cannot be verified here (needs a real submission or a real browser):** actually
  loading `dist/firefox` via `about:debugging` in Firefox, actually loading `dist/ext` in
  Edge's `edge://extensions`, and the AMO/Edge Add-ons review processes themselves —
  Playwright in this environment drives Chromium only and cannot load an unpacked
  extension into Firefox, so this is a manual step, not an automatable one. `QA-05`
  (external viewer compatibility) is a separate manual checklist and does not cover
  store-load verification, so this ticket adds a new `RELEASE_CHECKLIST.md` §5b covering
  both stores: load `dist/ext` in Edge and `dist/firefox` in Firefox before either
  submission, replace the placeholder `gecko.id`, and zip/submit each.
- **AC:** Same codebase builds and passes review on Edge Add-ons and Firefox AMO, with
  File System Access fallbacks exercised on Firefox. — build side confirmed for both
  targets; "passes review" is inherently unverifiable without submitting to each store.

### DIST-05 · Release process — `S` `P0`

**Status: Done** — `RELEASE_CHECKLIST.md` walks version bump → `CHANGELOG.md` →
`pnpm check`/`test`/`test:e2e` → an explicit zero-network-test gate (previously implicit,
buried inside "run verify") → the QA-05 manual pass (previously not mentioned at all) →
build → local load-unpacked verification → zip → store submission → git tag. `CHANGELOG.md`
did not exist before this pass, despite the checklist instructing every release to update it.

- **AC:** Documented checklist: version bump, changelog, `pnpm check`, full test suite,
  QA-05 manual pass, build, zip, submit. No release without a green zero-network test.

---

## EPIC-15 · v1.1 feature expansion

Twenty new tools/features, scoped to fit the product as it exists rather than bolted on.
Every one of these must still satisfy every hard invariant in `CLAUDE.md` — zero network,
zero permissions, tokens-only colour, the `core`/`ui`/`platform` layer boundary — and the
definition of done at the top of this file. None of these revisit the deliberate non-goals
in `PLAN.md` §1.1 (PDF→Word, Office→PDF, password removal, accounts, analytics); adding
**password protection** (RED-06) is a distinct, newly-scoped feature, not a reversal of the
password-*removal* non-goal.

### RED-05 · Pattern-based auto-redaction — `M` `P1`

**Status: Done** — Matching lives in `src/core/patterns.ts` as pure string work (`detectPatterns`
finds the hits, `locatePatterns` maps them back onto pdf.js text runs), so every false-positive
question is testable without a PDF. The render worker's new `findPatterns` calls it per page and
returns `PatternSuggestion`s built from the same `TextRegion` shape `findText` already produces;
accepting one pushes its regions into the existing `pendingRedactions` array, so the RED-02 commit
path and the RED-03 verifier cannot tell a suggested mark from a drawn one. Runs are concatenated
per page (newline at `hasEOL`) before matching, so a value the typesetter split across two runs is
still found, and one suggestion can carry a rectangle per run.

Category precedence resolves overlaps — an SSN is reported as an SSN, never as a phone number —
and card numbers must pass Luhn, not just look like a digit run. The phone matcher requires a
separator between every group, which is what stops the digits inside a card number being
re-reported.

Verified against a generated fixture whose lines pdf.js actually extracts
(`tests/unit/redact-patterns.test.ts`): the six planted values surface in document order with the
right categories and in-page rectangles, the four prose lines around them (`3.14.15`, `12:00:00`,
`000-00-0000`, `4111-1111-1111-1112`, a 20-digit serial) produce nothing, and accepting only the
SSN then running `applyRedactions` leaves the export with the SSN gone and the five declined
values still extractable. `tests/unit/patterns.test.ts` covers the matcher itself (7 cases).

**Known limitation, tested rather than implied:** RED-02 removes the whole text-showing operator a
mark intersects, so declining a value typeset in the *same* run as an accepted one loses it too.
The last test in `redact-patterns.test.ts` pins that behaviour down. Values on separate lines are
unaffected. Narrowing it is RED-02's granularity, not this ticket's.

- **Requirements:** Scan extracted page text for emails, phone numbers, US SSNs, credit
  card numbers (Luhn-validated), and IPv4/IPv6 addresses. Surface each match as a
  suggested mark the user can accept, edit, or dismiss individually, or accept all of one
  category at once — never auto-redact without a confirming click. Reuse the existing
  redaction mark/commit pipeline; this only changes how marks are proposed.
- **AC:** A fixture containing one instance of each pattern surfaces exactly those matches,
  correctly categorized, with zero false positives on the surrounding prose. Declining a
  suggestion leaves the source text fully intact in the export.

### RED-06 · Add password protection on export — `M` `P1`

**Status: Done** — pdf-lib cannot write encrypted documents and no dependency in `package.json`
could, so the standard security handler is implemented in `src/core/pdf/encrypt.ts` against
pdf-lib's low-level object model: load the finished bytes, walk every indirect object, replace each
string (as a hex string, so ciphertext survives serialisation) and each raw stream with its
ciphertext, register the `/Encrypt` dictionary *last* so the walk never encrypts it, set a trailer
`/ID`, and save with `useObjectStreams: false` so there is no xref stream to leave in the clear. No
new dependency was added — nothing to audit for network calls.

Revision 6 / AES-256 is the algorithm because it needs only primitives WebCrypto offers (SHA-2 and
AES-CBC) where RC4 revisions need MD5 and RC4 hand-rolled, and because it uses one file key for
every object rather than a per-object derivation. Two WebCrypto gaps are worked around and
commented at their call sites: AES-CBC always pads, so the no-padding form drops the trailing
block; and there is no ECB, so algorithm 10's single-block ECB is done as CBC with a zero IV.

Applied in `applyProtection` inside `save()` in `src/ui/tools/commit.ts`, so every tool's export
goes through the one rule rather than a forked save path. An encryption failure returns `null` and
blocks the save outright — writing the plaintext instead would hand back a file the user believes
is protected. A ZIP export says plainly that no password was applied. The password is typed twice
and the setting resets when the active document changes, because encrypting a document the user
did not mean to encrypt is not recoverable.

**How the password requirement was proved** (`tests/unit/encrypt.test.ts`, 8 passing): pdf.js —
which, unlike pdf-lib, actually implements the security handler and accepts a password — is handed
the exported bytes. With no password and with a wrong password it rejects with `PasswordException`;
with the user password and again with the owner password it opens, reports 2 pages, and
`getTextContent` returns both pages' text verbatim, so the streams genuinely decrypt. The
document title round-trips through `getMetadata` while the literal string `Board pack` is absent
from the raw bytes, proving strings are encrypted too. `getPermissions()` reports PRINT present and
COPY / MODIFY_CONTENTS absent for a print-only export. The plaintext input array is byte-identical
after the call and still opens with no password. Re-encrypting an encrypted file is refused.
Independently confirmed outside the JS ecosystem with poppler: `pdfinfo` on the exported file exits
1 with `Incorrect password`, and `pdfinfo -upw <password>` reports
`Encrypted: yes (print:yes copy:no change:no addNotes:no algorithm:AES-256)`, with `pdftotext -opw`
recovering the page text.

**One caveat, stated rather than glossed:** the AC names Chrome's own viewer, and PDFium was not
exercised directly — headless Chromium does not run the PDF plugin, so the check would have been
theatre. Two independent implementations of the handler (pdf.js and poppler) were used instead,
both of which refuse the file without the password and decrypt it with one. PDFium documents
support for V5/R6 AES-256, so this is expected to hold, but it is inference, not a measurement.

- **Requirements:** Optional owner/user password and a permission set (print, copy,
  modify) applied to the exported PDF only, entirely client-side. Clearly label this as
  encryption *added* at export, distinct from RED-04's metadata scrubbing and from the
  password-*removal* non-goal — Stapler still never opens or decrypts a document that
  needs a *real* password it wasn't given (it does try the empty one automatically, the
  same way Chrome/Acrobat/Preview do — see PLAN §1.1's 2026-09-12 revision note — but a
  document that actually requires a password stays refused).
- **AC:** Exported file requires the set password to open in an external viewer (Chrome's
  own PDF viewer, at minimum) and the unprotected original in the editor is unaffected.

**Amended (2026-09-14):** the silent-restriction-preservation path DOC-02 added
(`permissionOnlyPlan`, no password change requested) re-encrypts under this handler's one
fixed algorithm the same as the explicit-password path does — a real, permanent narrowing
of which readers can open the file (an old/embedded PDF viewer without R6 support could
open the input and can no longer open the output), previously undisclosed: the file still
opens with no password either way, so nothing was ever said about it. `save()`'s success
toast now names it explicitly ("this document's restrictions were preserved (now
AES-256-encrypted; needs a reader from the last decade or so)") when it happens, the same
way the explicit-password path already discloses "password required to open." Preserving
the *original* algorithm instead is not attempted — this handler is deliberately the only
one pdf-lib gets, so there is no RC4/older-revision writer to fall back to (see this
ticket's own header comment on why AES-256/R6 was chosen), and implementing one is out of
proportion to how rarely an old-revision-encrypted, permission-only file is re-exported.

### OPS-10 · Bookmark and outline editor — `M` `P1`

**Status: Done** — A `Bookmarks` tool (`src/ui/tools/outline/`) reads the document's
`/Outlines` through a new `readOutline` worker method and edits it as a tree: rename,
add pointing at the current page, delete, move up/down, indent/outdent. The tree is held
in *page keys*, not page indexes, so a bookmark still points at the right page after the
pages are reordered; it is resolved to output page indexes only at export, where
`writeOutline` replaces the carried-through source outlines (an emptied tree exports no
`/Outlines` at all, asserted). The override happens only once the user has actually
changed something (`outlineEdited`): the tree is read from the *first* page's source
document, so writing an untouched tree back would have silently narrowed OPS-01's
merge-time carry-through for a second merged-in document. Reuses OPS-01's raw-dictionary read/write code
(`registerOutlineSiblings`) and inherits its documented limit: a named destination or a
non-`GoTo` action cannot be resolved, so it is now *reported* (`pageIndex: -1`, counted in
the panel) and exports as a heading with no page rather than being dropped or guessed at.
Titles are now written as UTF-16BE hex strings, which also fixes a latent OPS-01 bug —
`PDFString.of` does not escape `)` or `\`, so such a title produced a broken outline
dictionary. Evidence: `tests/unit/outline.test.ts` (10 tests across its two OPS-10
describe blocks, including the AC round trip
"round-trips an edited tree through export and re-import, exactly as left") and
`tests/e2e/tool-flows.spec.ts` → "bookmarks: renaming, reordering, and adding survives
export (OPS-10)", which reorders from the keyboard (`.press('Enter')` on the row button)
and re-parses the exported bytes' outline. Every row control is a native
`<button>`/`<input>` with an accessible name, so the existing registry-driven axe sweep in
`a11y-and-perf.spec.ts` covers the new tool automatically.

- **Requirements:** List the document's existing outline (`/Outlines`) as an editable
  tree: rename, add (pointing at the current page), delete, and reorder/reindent entries.
  Independent of OPS-01's merge-time bookmark preservation, which only carries existing
  outlines through — this creates and edits them directly.
- **AC:** Adding, renaming, and deleting entries round-trips through export/re-import with
  the tree exactly as left, keyboard-operable throughout.

### OPS-11 · Bates numbering — `S` `P1`

**Status: Done** — Built into the OPS-08 stamp engine, not beside it: `composePages`
draws it in the same per-page pass as the watermark and header/footer, positioned through
the same `positionOrigin` 9-point grid, and it is configured in the Watermark panel's own
Bates section (`batesSettings`). The label maths is a pure module (`src/core/bates.ts`) so
the panel can preview the exact string; a number wider than the padding grows the field
rather than truncating, since a truncated Bates number would let two pages share an
identifier. Numbering follows the whole production set across a split via `pageOffset`,
and it is deliberately independent of the `{n}` page-number substitution. Evidence:
`tests/unit/outline.test.ts` → "stamps 20 pages strictly sequentially from 000001" (the
AC, read back off the exported content streams, hex literals decoded), "is independent of
the header/footer page-number stamp", and "keeps numbering continuous across the files of
a split"; e2e "bates: a stamped run is sequential and zero-padded (OPS-11)".

- **Requirements:** Sequential legal numbering stamp — prefix, zero-padded digit count,
  starting number, 9-point placement grid — built on the OPS-08 stamp engine rather than
  a parallel implementation.
- **AC:** A 20-page document stamped from 000001 produces strictly sequential, correctly
  zero-padded numbers across every page, independent of any existing page-number stamp.

### OPS-12 · Split by bookmarks — `S` `P1`

**Status: Done** — A fifth mode on the existing four (the requirement below says "fourth",
written before OPS-03's extract-selection mode was counted). `splitBoundaries('bookmarks',
…)` takes the top-level bookmarks' start pages and cuts at all but the first, so pages
before the first bookmark join that bookmark's file instead of forming a nameless extra
one — which is what makes the count exactly N for N bookmarks while keeping the
boundary-union property. Filenames come from `sanitizeFileStem`, and the worker de-dupes
ZIP entry names, because two chapters called "Appendix" keyed into one `Record` would
have silently dropped a slice of the user's document. Evidence: `tests/unit/outline.test.ts`
→ "preserves every page exactly once, like the other modes" (the same union/no-overlap
property OPS-03's `split.test.ts` asserts), "produces exactly one named file per top-level
bookmark, covering every page" (the AC, on real ZIP output), and "does not lose a file when
two bookmarks share a title"; e2e "split: bookmark mode writes one file per top-level
bookmark (OPS-12)".

- **Requirements:** A fourth OPS-03 split mode: use the document's top-level outline
  entries as split boundaries, one output file per top-level bookmark, named from the
  bookmark's title (sanitized for the filesystem).
- **AC:** A fixture with N top-level bookmarks produces exactly N files whose page ranges
  union to the input page set with no overlap, matching OPS-03's existing boundary
  property test.

### OPS-13 · Flatten page background — `S` `P2`

**Status: Done (re-audited 2026-09-26)**

**Reopened by AUDIT-2026-09-25 (PDF-3, 🔴 Critical), now closed again.** The flatten
dropped only the paint operator (`f`) of the background fill and left its path
construction (`0 0 612 792 re`) in the stream, so the *next* fill on the page — often
text or a small rectangle — painted the whole page in its colour (a black page). The
earlier e2e passed because its fixture drew nothing after the background with a fill.
Now the whole path-construction run is dropped together with its painter, a fill-and-
stroke background keeps its stroke, a page-sized path that is also a clip is refused,
and a full-page scan is never mistaken for a background
(`tests/unit/flatten-background.test.ts`, re-parsing real output content streams). The
pixel-sampled e2e (`tests/e2e/tool-flows.spec.ts` › "cleanup: flatten background
preserves text") still runs.

- **Requirements:** Replace a page's background with solid white (a scan-cleanup-adjacent
  operation for e.g. a coloured letterhead sheet re-scanned repeatedly) or apply a flat
  colour tint, without touching foreground text/vector content or existing images beyond
  the background layer itself.
- **AC:** On a fixture with a coloured background fill, output shows solid white (or the
  chosen tint) behind unchanged foreground content, verified pixel-sampled off-text.

### CNV-06 · Extract embedded images — `M` `P1`

**Status: Done** — An `Extract images` tool (`src/ui/tools/extract-images/`) whose worker
method `extractImages` reuses CMP-03's own enumeration (`collectImageRefs`, extended to
carry the resource scope an image's `/ColorSpace` name resolves against) and then does the
opposite of CMP-03: it hands over the image object's *own* encoded bytes.

- `/DCTDecode` → written as `.jpg` **byte-for-byte** — the stream is already a complete
  JFIF/Adobe JPEG, so nothing is decoded and no generational loss is possible. Asserted by
  equality with the source file on disk, not by a similarity threshold.
- `/JPXDecode` → `.jp2`, likewise untouched. CMP-03 refuses JPX because pdf.js cannot
  re-encode it; extraction can hand it over precisely *because* it never decodes it.
- Transport filters only (Flate/LZW/ASCII85/ASCIIHex/RunLength, or none) → an exact PNG
  re-frame via `src/core/png.ts`: same bit depth (1/2/4/8/16), same sample order, same
  palette for `/Indexed`, filter byte 0 per scanline so the IDAT payload *is* the PDF's
  decoded samples. A canvas round trip was rejected for this path — it would promote
  everything to 8-bit RGBA and cannot express a palette or a 1-bit stencil at all.
  A wrapper around a codec (`[/ASCIIHexDecode /DCTDecode]`) is unwrapped with pdf-lib's own
  decoders; the codec payload still is never decoded.
- Skipped and reported, following CMP-03's precedent rather than converting: JBIG2 (an
  embedded segment sequence whose globals live in another object — not a standalone file),
  CCITT (a bare codestream), CMYK and `/Separation` rasters (no lossless single-file raster
  format; converting to RGB would be the re-encode this ticket exists to avoid), a
  non-identity `/Decode`, and any stream whose data is shorter than its declared raster.
- Transparency is written *beside* the image (`page-001-image-01-mask.png`), because a JPEG
  cannot carry an alpha channel and merging the pair would mean re-encoding both.
- One file per distinct image *object*, named `page-NNN-image-NN.ext` for the page and
  position it first appears at; later pages report the reuse. So a logo on 300 pages is
  decoded once and written once.
- Encrypted input that actually needs a password to open is refused with the standard
  message — its streams are ciphertext, so "extracting" them would write files full of
  noise. A permission-only file (empty user password, print/copy restricted by its owner)
  is not refused: `load` opens it the same way every other tool does (see PLAN §1.1's
  2026-09-12 revision note) and its images extract normally — there is no PDF permission
  concept on the raw JPEG/PNG bytes this ticket writes out. Nothing is written when nothing
  could be extracted: an empty ZIP would read as a successful export of nothing.

Evidence: `tests/unit/extract-images.test.ts` (16 tests) — the AC's two halves are
"writes a DCTDecode image out byte-for-byte, with no decode step at all",
"re-frames a Flate raster into PNG with the samples unchanged" (IDAT inflated and compared
to `decodePDFRawStream(...).decode()`), and "yields one file per image on a page with N
images" — plus the Indexed palette, SMask sibling, truncated-raster refusal, reuse,
CMYK/JBIG2/JPX routing, encryption, and progress/cancellation cases. E2E:
`tests/e2e/tool-flows.spec.ts` → "extract images: the extracted file holds the source image
samples exactly", which drives the real UI and compares the ZIP's PNG against the image
stream inside the imported PDF.

**Known limit:** a CMYK or `/Separation` *raster* (as opposed to a CMYK JPEG, which is
handed over untouched) is reported, never converted — so `cmyk.pdf` extracts nothing and
says why. That is the deliberate reading of "no re-encode"; a user who wants those pixels
converted is asking for CNV-02.

- **Requirements:** Pull the original image XObjects out of a PDF byte-for-byte — no
  re-render, no re-encode — distinct from CNV-02 (which rasterizes whole pages). Output
  each at its native format/resolution in a ZIP, named by page and position.
- **AC:** Extracted bytes match the source image object's decoded pixels exactly (no
  generational loss versus a re-encoded round trip); a page with N images yields N files.

### CNV-07 · Paste image as page — `S` `P2`

**Status: Done (2026-10-05)** — the paste handler reads `ClipboardEvent.clipboardData` first (with `preventDefault()`), falls back to the async Clipboard API, and calls `insertPages(doc.id, …, at)` for an open document. `tests/e2e/import.spec.ts` › "CNV-07 paste image as page" now uses the real clipboard (granted permissions, a real image `ClipboardItem`), with no test hook: "with nothing open, a pasted image becomes a one-page document", "into an open 3-page document, the image lands after the selected page 2, at its own size", "a clipboard with no image is refused with a clear message". The `window.__mockClipboardImage` hook is removed from production code (AUDIT-FINDINGS §11.10, HRD-23).

- **Requirements:** Read an image directly off the OS clipboard (Clipboard API) and
  insert it as a new page at the current insertion point, reusing CNV-01's image-to-PDF
  page composition.
- **AC:** Pasting a clipboard image inserts a correctly-sized page at the expected index;
  refused with a clear message if the clipboard holds no image.

### DOC-07 · Compress to a target size — `M` `P1`

**Status: Done** — An "Aim for a size" preset on the compress tool
(`compressMode`/`compressTarget` in `src/ui/tools/compress/state.ts`) hands DPI and
quality to a measured search (`src/core/compress-target.ts`,
`operations.compressToTargetSize`) instead of to the user. The search bisects a
nine-rung (DPI, quality) ladder — 300/90% down to a 72 DPI / 30% floor — for the
*highest-quality* rung whose real output lands at or under the target, capped at
`MAX_TARGET_TRIALS` (5) full render+encode passes. Every rung it reports on is a
complete `planCompression` + `compressDocument` run, so each trial independently
keeps CMP-04's safety net (an output that is not smaller is discarded and the
original returned) and CMP-01's skip rules; nothing here is derived from
`estimateSavings`' static model, deliberately — CMP-05 had to re-anchor that model
on a real re-encode precisely because it is wrong by multiples on content it was
not fitted to, and a target-size feature built on it would *assert* a size it had
never produced. The floor rung is probed **first**: it is the one run that can
settle "impossible" outright, so the honest answer costs one pass rather than
four. That case is not exotic — CMP-03 still skips six image categories, so on a
document dominated by JPX/JBIG2/Separation/stencil/colour-key/pre-blended images
"cannot reach the target" is the ordinary outcome, and the dialog names the
skipped constructs when it says so. Progress spans the whole search
("*300 DPI at 75% — Processing page 2*") and the abort signal is checked between
trials as well as inside them.
AUDIT-2026-10-01 (HRD-64, 2026-10-02): the "Reached" toast is gated on the final written size, Protect's encryption overhead included (IMG-5); the target field validates against `PDF_TARGET_BOUNDS` with a 10 KB minimum, matching the deep link (IMG-12); a missed size is rounded up (IMG-3). Tests: `tests/unit/size-honesty-commit.test.ts`.

Evidence, all against real output byte counts:

- `tests/e2e/compress-preview.spec.ts` → "DOC-07 compress to a target size":
  - *reaches it*: `scanned_skewed.pdf` (3,224,311 B) with a 300 KB target →
    `DOC-07 reachable: target 300000 B, achieved 290117 B, file on disk 290117 B,
    4 attempt(s)`. The number the panel reports is asserted equal to the byte
    length of the file the export actually wrote, and ≤ the target.
  - *cannot reach it, honestly*: same fixture with a 5 KB target →
    `DOC-07 unreachable: target 5000 B, smallest achievable 22567 B after 1
    attempt(s)`. A "Could not reach 5 KB" dialog states the smallest achievable
    size; declining it writes **nothing** (asserted: no `download` event), and the
    panel reports `data-target-outcome="missed"`. The floor answers it in one
    pass — degrading further is never on offer.
  - Mode is switched from the keyboard (focus the first radio, `ArrowDown`), and
    both new controls are a native `<input type=number>` and `<select>` with
    accessible names, so the registry-driven axe sweep in `a11y-and-perf.spec.ts`
    covers them (15 passed).
- `tests/unit/compress-target.test.ts` (7 tests) covers the search order itself:
  floor-first (one run when impossible), highest-quality rung at or under the
  target, ≤ 5 trials for *every* target across the ladder, cancellation mid-search
  (`UserCancelled` after 2 runs, remaining trials never started), and — against a
  deliberately non-monotone encoder — that success is only ever claimed from a
  measurement, never inferred from ladder order.
- `pnpm check` clean, `pnpm test` 302 passed, `pnpm test:e2e compress-preview`
  7 passed, `tool-flows` 37 passed, `a11y-and-perf` 15 passed.

Known limits, stated rather than papered over: the ladder is fixed, so the best
achievable size is quantised to its nine rungs (a target between two rungs lands
on the lower one, not on an interpolated setting); and the search's notion of
"smallest possible" is the floor rung, not a proof that no encoder could do
better.

- **Requirements:** A compression preset that takes a target size (e.g. "under 10MB")
  and iterates DPI/quality within CMP-02/CMP-03's existing pipeline to land at or under
  it, reporting the achieved size; if the floor quality still exceeds the target, say so
  rather than degrading further.
- **AC:** A fixture compressible below the target lands at or under it; a fixture that
  cannot reach the target under the quality floor reports that honestly, never silently
  overshooting.

### DOC-08 · Linearize export ("fast web view") — `S` `P2`

**Status: Done (2026-10-05)** — The DOC-05/DOC-08 conflict is resolved by owner decision: DOC-08 is an opt-in "Fast web view" checkbox in the export review (`src/ui/tools/export-settings.ts`, remembered across sessions, off by default), so DOC-05's object streams stay the default and the two coexist. When it is on, `src/core/pdf/fast-web-view.ts` rewrites the export with a plain xref and page 1's objects first; it survives RED-06 encryption, and is dropped with a visible note if it cannot be applied or would make the file outgrow the guard. Tests: `tests/unit/export-fast-web-view.test.ts` (re-parses the written bytes: same page count, plain xref, page 1's objects before later pages'); `tests/e2e/export-claims.spec.ts` › "on: no object streams, page 1's objects first, same pages — and it stays on". See HRD-23 (AUDIT-FINDINGS §11.8).

- **Requirements:** Reorder the exported PDF's objects so the first page's content is
  available from the start of the byte stream (linearized/optimized structure), improving
  progressive display in viewers that support it.
- **AC:** Output re-parses cleanly and page content/order is unchanged; the first page's
  objects precede later pages' in byte offset.

### SGN-05 · Flatten form and annotations — `S` `P1`

**Status: Done** — Two thirds of this was already true and is left alone. Stamps and
ANN-01 marks were never annotation dictionaries: `compose` draws them straight into the
content stream (`drawAnnotations`). Filled AcroForm values were already flattened by
`fillFormFields(…, true)` via pdf-lib's `form.flatten()`, which refuses rather than
half-flattening on a broken `/DA` or a missing `/DR` font.

Two real gaps closed. **(a)** `form.flatten()` only reaches *widget* annotations, and
`copyPages` carries a source document's `/FreeText`, `/Square`, `/Highlight`, `/Stamp`,
`/Link` and `/Popup` dictionaries through every compose — so a "flattened" export still
shipped annotations the recipient could move or delete, failing the AC's "no annotation
dictionaries remaining". A new `flattenDocument` worker method (`process.worker.ts`,
`flattenAnnotations`) draws each annotation's `/AP /N` appearance into the page as a form
XObject and then deletes `/Annots` outright. Placement is PDF 32000-1 §12.5.5's algorithm,
not a translate: the `/BBox` is transformed by the stream's own `/Matrix`, the bounding box
of *that* is fitted to `/Rect`, and only the fitting transform is pushed — ignoring
`/Matrix` draws the fixture's `/FreeText` at double size. `/AP /N` sub-dictionaries are
resolved through `/AS` (or a single unambiguous entry, never a guess). Annotations with
nothing to draw — `/Link` hotspots, `/Popup` windows, anything flagged Hidden or NoView —
are removed rather than baked, and counted separately so the UI can say that a link lost
its clickability instead of burying it. `/AcroForm` is deleted from the catalog outright,
not left as an empty `/Fields`. **(b)** Flatten was hardcoded on with no user-facing
choice, so there was no "finalize" distinct from a normal export. `FlattenOption`
(`src/ui/tools/FlattenOption.tsx`, a native `Checkbox`) appears in both the Sign and
Annotate panels — the two tools the requirement names — backed by `flattenOnExport`, on by
default to preserve the previous behaviour. It is read *only* by those two commit handlers:
a global settings signal read by every tool's export was the OPS-09 bug.

Evidence: `tests/unit/process.test.ts` → `describe('flattenDocument (SGN-05)')`, 5 tests
re-parsing the produced bytes — no `/AcroForm` key and no `/Annots` after a
compose→fill→finalize round trip, `annotationsBaked: 2 / annotationsDropped: 2` on the new
`annotatedPdf()` fixture, the exact `1 0 0 1 50 700 cm` and `0.5 0 0 0.5 300 400 cm`
operands proving the `/Matrix` and rect-fitting maths, a hidden annotation that must not
appear, XFA refused with input bytes unmutated, and a document with neither fields nor
annotations left structurally intact. `tests/e2e/tool-flows.spec.ts` → three SGN-05 tests:
the default-on path (no `/AcroForm`, no `/Annots`, value still in drawn text), unchecking
the toggle *from the keyboard* leaving a genuinely fillable form, and an annotated document
exporting with its appearances baked in and its hidden annotation still invisible.

- **Requirements:** Bake filled AcroForm field values and placed annotations/stamps into
  static page content, removing the underlying interactive fields/widgets so the result
  can't be re-edited — a natural "finalize" step after SGN-03 fill or ANN-01 annotation.
- **AC:** Flattened output shows the same visual content with no `/AcroForm` fields and no
  annotation dictionaries remaining; text extraction still finds the baked-in values.

### SGN-06 · Create form fields — `L` `P2`

**Status: Done** — Interactive AcroForm field placement (text, checkbox, radio-group)
added to the Sign panel. Fields are drawn via click-drag on the canvas overlay
(`AnnotationOverlay.tsx`) and written into a real `/AcroForm` dictionary on export
(`src/core/workers/process.worker.ts`). Name, type, and export-value are configurable
in the sign panel (`src/ui/tools/sign/SignPanel.tsx`).

- **Evidence:** `pnpm check && pnpm test` on master after merge at commit `3685d13`.
  37 test files · 416 tests · 0 failures. New test file: `tests/unit/form-fields-create.test.ts`
  (180 lines, 8 dedicated tests for AcroForm field round-tripping).

- **Requirements:** Draw new text, checkbox, and radio-group fields onto a page (not
  filling existing ones, which is SGN-03) — placement, sizing, and a name/export-value per
  field, written into a real `/AcroForm` on export.
- **AC:** A field drawn and exported opens fillable in Chrome's own PDF viewer with the
  configured name/type; SGN-03 can fill it back in a second round trip.

### ANN-03 · Search and highlight — `S` `P1`

**Status: Done** — The Annotate panel gains a "Find and highlight text" field over the
same call RED's find-and-mark makes: `operations.findTextRegions` (renamed from
`searchForRedaction` when this became its second caller) → the render worker's existing
`findText`. No second search, no second locator; the redact panel's own call site changed
by one identifier. What ANN-03 adds is only the conversion, and it is a pure module —
`src/core/highlight.ts`, `highlightsForRegions` — so the geometry is testable without a
PDF, exactly like RED-05's `patterns.ts`.

Each match becomes an ANN-01 `highlight` annotation (a stroked segment down the vertical
centre of the located box, which is the one annotation type both the canvas overlay and
`drawAnnotations` paint at 0.5 multiply) pushed into `pageAnnotations` on the page *key*
the match's page index resolves to — not into `pendingRedactions`, and not as an overlay
of its own. `strokeWidth` is a fraction of page **width** in both renderers while the
located box's height is a fraction of page **height**, so the conversion multiplies by the
page's displayed aspect ratio (`displayedAspectRatio`, rotation included); skipping that is
invisible on a square page and 30% too thin on A4, and a unit test pins the stroke to the
text height in page units. A match whose page index has no page is *counted and reported*,
never dropped silently. Undo integration is DOC-06's existing model: one `commit()` and one
`addAnnotations` write for the whole search, so 40 highlights are one ⌘Z, not 40.

**A real ANN-01 export bug had to be fixed to satisfy this AC.** `drawAnnotations` built its
SVG path in already-flipped coordinates (`height - y * height`) and passed no `y` option, but
`drawSvgPath` emits its own `1 0 0 -1 0 y cm` flip about that option (default 0) — so every
freehand stroke and every highlight was drawn at *negative* y, off the page and invisible in
the export. Fixed by writing the path in SVG (top-left origin) coordinates and passing
`y: height`; round line caps/joins were added at the same time so the exported stroke matches
what the overlay drew. ANN-01's rectangle/text/sticky/whiteout paths were never affected,
which is why the existing whiteout e2e passed throughout.

Evidence:

- `tests/e2e/tool-flows.spec.ts` → "annotate: search highlights every match, at the text
  (ANN-03)", the AC, against real exported bytes. `text-6.pdf` draws `Line 3 of body text on
  page N.` once per page at a known x=56 / baseline y=676 / size 11, so searching
  `Line 3 of body text` must produce exactly 6 highlights, and the test decompresses every
  page's content streams, undoes `drawSvgPath`'s y-flip, and asserts each stroke is on its own
  page, starts at x≈56, spans the phrase, is horizontal, sits between the baseline and the line
  above, and is as thick as the text is tall. The search is driven **keyboard-only** (focus the
  field, type, Enter). One `Control+z` then exports zero strokes.
- `tests/unit/highlight.test.ts` (6 tests): one annotation per match on the match's own page
  key with distinct ids, the box→segment geometry including the aspect factor, the panel's
  picked colour, unplaced matches reported rather than dropped, no zero-width stroke, and the
  empty case.
- `pnpm check` clean, `pnpm test` 347 passed (25 files), `pnpm test:e2e tool-flows` 42 passed,
  `a11y-and-perf` 15 passed (the new field, checkbox, and button are native labelled controls,
  so the registry-driven axe sweep covers them; one flaky first-run failure of the unrelated
  "shortcut sheet opens with ?" test reproduced neither in isolation nor on re-run).

**Scope note:** the panel reports the count and offers no per-match list — the highlights
themselves are the list, editable and deletable on the page as ordinary ANN-01 annotations.
Highlight placement inherits RED's monospace approximation of glyph advances (`findText`), so
a proportional-font match's box is slightly over-inclusive; for a highlight that is the safe
direction, and narrowing it belongs to `findText`, not here.

- **Requirements:** Find text across the document (reusing RED's find-and-mark text
  location) and turn every match into a real highlight annotation via ANN-01's layer,
  rather than a redaction mark.
- **AC:** Searching a term present N times produces N highlight annotations at the correct
  text locations, undo/redo-integrated per ANN-01's existing model.

### ANN-04 · Export annotation summary — `S` `P2`

**Status: Done** — `exportAnnotationSummary` exports PDF/text summary listing all notes, positions, and page numbers. Tested in `tests/unit/annotation-summary.test.ts`.

- **Requirements:** Collect every sticky note and comment from ANN-01's layer into a
  printable summary — either an appended page or a separate export — listing each note's
  page, position, and text.
- **AC:** A document with N notes across multiple pages produces a summary listing all N,
  correctly attributed to their page numbers.

### CMP-06 · Compression report export — `S` `P2`

**Status: Done (2026-10-05)** — `generateCompressionReportText` and JSON export breakdown in `src/core/compress-report.ts`. The measured result is scoped to its document, carries per-image stats from `rebuildCompressed`, and records `finalBytes` after RED-06 protection and the optional fast web view rewrite (`commit.ts`). The AC is now checked against the real saved file: `tests/unit/export-fast-web-view.test.ts` › "HRD-23 §11.9 / CMP-06 — the report's size is the size written to disk" (with Protect on, with Protect and fast web view on, with neither), and `tests/e2e/export-claims.spec.ts` › "HRD-23 §11.9: with Protect on, the compression report total equals the saved file" (AUDIT-FINDINGS §11.9, HRD-23).

- **Requirements:** Alongside CMP-04's on-screen honest-reporting summary, an exportable
  per-page/per-image breakdown (sizes before/after, which images were re-encoded vs.
  skipped and why) as a plain-text or JSON sidecar file.
- **AC:** Exported report's totals match the actual output file size and the skip reasons
  match what CMP-04's UI summary shows for the same run.

### ANN-05 · Export visual diff — `S` `P2`

**Status: Done (re-audited 2026-08-17 and 2026-10-01, fixed 2026-10-02)** — `exportVisualDiff` (`src/core/visual-diff-export.ts`) renders the real diff into a PDF, or reports an error. AUDIT-2026-08-17 §3 #16 found that the Compare panel passed an empty result set and swallowed render failures in a bare `catch {}`, writing an all-white page that "succeeded". `visual-diff-export.test.ts` now asserts real embedded XObjects, not just byte length (§3 #31). e2e: `tool-flows.spec.ts` › "compare: visual pixel diff exports a real rendered image, not text mode". AUDIT-2026-10-01 fixes (HRD-66): a cancelled export saves nothing (X-1); each page keeps its real CropBox size and rotation instead of 612×792 (X-2); mixed sizes are resampled rather than refused (X-3); each document is loaded once (X-4); the diff and encode run in the cv worker with per-page progress (X-6). Tests: `tests/unit/compare-export-audit-2026-10-01.test.ts`, `tests/e2e/audit-2026-10-01-ui.spec.ts`.

- **Requirements:** Extend the Compare tool (ANN-02) to export its side-by-side or overlay
  diff view — changed regions highlighted — as a new PDF, rather than only viewing diffs
  live in the editor.
- **AC:** Exported diff PDF's highlighted regions match what the live Compare view marks
  as changed, for both an added-content and a removed-content fixture.

### DOC-09 · Contact sheet export — `S` `P2`

**Status: Done** — `contactSheetExport` tiles page thumbnails into a new PDF with configurable columns. Tested in `tests/unit/contact-sheet.test.ts`.

- **Requirements:** Generate a single PDF or image containing a grid of page thumbnails
  (configurable columns), reusing DOC-03's existing thumbnail cache rather than
  re-rendering pages.
- **AC:** A 20-page document at a 4-column setting produces a 5-row contact sheet whose
  thumbnails are recognizably the source pages in order.

### ACC-01 · Alt-text editor for images — `M` `P1`

**Status: Done (re-audited 2026-08-17)** — `/Alt` is written as UTF-16BE hex (`PDFHexString.of(utf16BeHex(…))`, `src/core/pdf/accessibility.ts`). AUDIT-2026-08-17 §3 #21 found it written one byte per JS char code, which corrupted any non-Latin-1 alt text. The alt-text input has a real `<label for>`, and alt text reads back on re-import (AUDIT-FINDINGS). AC addition: alt text outside Latin-1 (for example `日本語の写真 — café`) round-trips byte-exact.

- **Requirements:** Let the user attach alt-text to each image XObject on a page, written
  as real structure-tree/`/Alt` metadata on export — basic PDF/UA-style accessibility
  tagging, not just an in-app label.
- **AC:** Alt-text set in the UI round-trips: present in the exported bytes' structure
  tree and re-readable by re-importing the file into the same editor.

### DS-09 · Custom keyboard shortcut remapping — `S` `P2`

**Status: Done** — Local IndexedDB shortcut remapping store, conflict detection, reset-to-default, and shortcuts UI. Tested in `tests/unit/shortcuts.test.ts`.

- **Requirements:** Let the user rebind any shortcut listed in DS-08's shortcut sheet,
  persisted locally (IndexedDB, per F-06), with conflict detection against other bound
  shortcuts and a reset-to-default action.
- **AC:** A rebound shortcut fires the original action and no longer fires under its old
  key; the shortcut sheet reflects the active bindings, not the defaults, once changed.

### BAT-03 · Templated batch output filenames — `S` `P2`

**Status: Done** — Templated pattern token substitution (`{basename}`, `{index}`, `{date}`) and deduplication in `src/core/batch-filename.ts`. Tested in `tests/unit/batch-filename.test.ts`.

- **Requirements:** A filename pattern field for BAT-01 batch runs supporting tokens like
  `{basename}`, `{index}`, `{date}`, applied per output file instead of a fixed suffix.
- **AC:** A batch run with a pattern using all three tokens produces correctly-substituted,
  collision-free filenames for every input file.

---

## EPIC-16 · v1.2 feature expansion

Twenty more tools/features. Same rules as EPIC-15: every one satisfies the hard invariants
in `CLAUDE.md` (zero network, zero permissions, tokens-only colour, the `core`/`ui`/`platform`
boundary) and the definition of done at the top of this file, and none of these revisit the
non-goals in `PLAN.md` §1.1. RED-08's local face/logo blur model follows OCR-01's precedent —
a large model fetched once on explicit user confirmation, not a standing network dependency.

### ACC-02 · Read-aloud mode — `S` `P2`

**Status: Done (re-audited 2026-09-26)**

**Reopened by AUDIT-2026-09-25 (PLT-5), now closed again.** "On-device OS/browser voices
only" was not guaranteed: Chrome's default voices include "Google …" voices with
`localService === false`, which synthesise on Google's servers — page text would have
left the device. The tool now only ever speaks with a voice whose `localService` is
`true` (`src/ui/tools/read-aloud/voices.ts`); when every voice is a network voice the tool
is disabled with an explanation rather than falling back
(`tests/unit/read-aloud-voices.test.ts`: never offers a network voice, does not follow a
network default, keeps the user's pick only while it is local). It also stops when the
user leaves the tool (UI-15). Voice picker, sentence highlighting and remembered
voice/rate are ACC-04.

Original entry: a new `read-aloud` tool (`src/ui/tools/read-aloud/`), grid canvas mode
so the existing page thumbnails stay usable while listening. `extractPageText` (a new
thin wrapper in `src/core/operations.ts` around the render worker's existing `extractText`,
factored out so a single-page read doesn't carry `extractDocumentText`'s multi-page
`--- Page N ---` banner) supplies each page's already-tested reading-order text
(`layoutText`, CNV-04's own logic — see ACC-03 below for what that does and does not
handle). Playback is driven by the Web Speech Synthesis API directly — an on-device
browser capability, not `chrome.*`, so it is used straight from `ui/` the same way
`createImageBitmap`/`crypto.randomUUID` already are — with `SpeechSynthesisUtterance.onend`
auto-advancing to the next page. Pause/resume use the API's own `pause()`/`resume()`,
which suspend and continue the *same* utterance rather than restarting it, so resuming
does not lose position within a page. A page with no extractable text sets a visible
note and immediately advances rather than sitting silent forever (the AC's "not a silent
hang"). Rate changes restart the current utterance at the new rate — the Web Speech API
has no way to alter one already speaking, so leaving the old rate running until the next
page would make the slider lie. `hasSpeechSynthesis()` feature-detects and shows a
plain message instead of a broken control on a browser without it.

Verified against the real app (dev server + a real multi-page fixture, Playwright,
in-tree because Node/vitest has no `speechSynthesis` global to unit-test against):
Play starts on page 1 with the status line reading "Reading page 1 of 3", Pause and Stop
both work, Next/Previous move the page indicator, and both light and dark theme render
without console errors. `tsc --noEmit`, full unit suite, eslint, and prettier all clean.

- **Requirements:** Read the current document's extracted text aloud via the Web Speech
  Synthesis API (on-device OS/browser voices only), with play/pause, per-page navigation,
  and rate control. No audio file is fetched or generated remotely.
- **AC:** Starting playback on a multi-page fixture reads pages in order, pausing and
  resuming without losing position; unsupported/empty text pages are skipped with a
  spoken or visible notice, not a silent hang.

### ACC-03 · Reflow view — `M` `P2`

**Status: Done, with one AC explicitly unmet — disclosed below, not papered over.** A new
`reflow` tool, `canvasMode: 'single'`, wired into `Canvas.tsx` the same way `compare` and
`compress` get a fully custom view instead of the default page-image one. `ReflowView`
calls the same new `extractPageText` ACC-02 uses and renders it as large, single-column
paragraphs (`ReflowView.module.css`, font size from a `Slider` in `ReflowPanel`), with its
own Previous/Next pager reusing `SinglePageView.module.css`'s existing `.pager` styles.
Purely presentational: nothing here calls any mutation or export path, and the tool's
commit handler is a no-op, so the document is trivially byte-identical before and after —
there is nothing to toggle back from.

**The multi-column half of the AC is not met.** Reading order comes from `layoutText`
(`src/core/text-layout.ts`), which groups runs into lines by baseline and sorts each line
left-to-right — correct for ordinary single-column pages (already proven by CNV-04's own
tests) but not column-aware: on a genuine two-column layout it reads straight across both
columns on each shared baseline, interleaving them, rather than finishing the left column
before starting the right one. Real column detection (clustering lines by a sustained
horizontal gutter, handling full-width headers/footers that span both columns) is a
distinct, non-trivial layout-analysis problem, not a documented shortcut of an existing
building block. Rather than ship an untested heuristic likely to garble real documents in
exactly the case the AC cares about, this is left for a follow-up and reported honestly
as unmet, per this file's own definition of done ("Verify acceptance criteria against
real output bytes, not against intent").

Verified against the real app: a multi-page fixture's page 1 text renders as large,
readable single-column prose in the main canvas area, Next/Previous move between pages,
and both light and dark theme render without console errors. One real bug caught by that
check and fixed: the page text used `var(--ink)`, a token that inverts for dark mode,
against `var(--doc-page)`, which — correctly, per the existing "a page is white in both
themes" rule — never inverts; the result was near-white text on a white page, unreadable
in dark mode. Fixed by adding `--doc-ink`/`--doc-ink-muted` to `tokens.css`, always-dark
tokens for text drawn directly on the never-inverted document page, alongside the
existing always-dark `--doc-redact`. `tsc --noEmit`, full unit suite, eslint, and prettier
all clean.

- **Requirements:** A reading mode that re-lays the extracted text of a page into a large,
  single-column, resizable-font view for low-vision users, entirely presentational —
  the underlying document is never modified.
- **AC:** Toggling reflow view on a fixture with multi-column text presents it as ordered
  single-column text matching reading order; toggling off returns to the normal page view
  with the document byte-identical to before. **Unmet:** multi-column reading order — see
  writeup above.

### OPS-14 · Auto-outline from heading detection — `M` `P2`

**Status: Done** — `detectHeadingOutline` in `src/core/outline-detect.ts` is pure and
independent of pdf.js: it takes the same `{text, x, y, width, height}` item shape
`extractPageTextItems` already returns, groups items into lines by vertical proximity
(the same tolerance-and-gap heuristics `text-layout.ts`'s `layoutText` already uses, so a
heading split across two runs still reads as one line), finds the document's own
body-text size as whichever line height covers the most lines, and treats anything at
least 15% larger as a heading candidate. Distinct heading sizes become nesting levels —
the largest becomes level 1, and so on — built into a tree the same way Markdown ATX
headings nest: a heading closes every open level at least as deep as itself before
attaching under whatever remains open above it. Sizes deeper than `maxLevels` (default
3, matching the AC) collapse into the deepest level as siblings rather than inventing a
level that was never actually distinguishable by size.

`proposeOutlineFromHeadings` in `operations.ts` is the only orchestration: read every
page's text items, hand them to the pure detector, return candidates. Nothing here
writes anything. The panel converts page-index-based candidates to the same page-*key*-
based `OutlineEntry` shape every other bookmark in OPS-10's tree already uses (so a
detected heading survives a reorder exactly as well as a manual one), then calls the
existing `editTree` — the exact same seam a manually-typed bookmark goes through. The
proposal is not written to `/Outlines` by this action; the user reviews it in the same
editable tree OPS-10 already provides and has to press Export for anything to reach the
document, which is what "seeding the editor rather than writing directly" means
concretely. Replacing a non-empty tree asks for confirmation first, since detection is a
destructive action against manual edits otherwise.

Evidence: `tests/unit/outline-detect.test.ts` (8 tests) — the AC's own scenario, three
heading levels by font size, produces a tree with the exact nesting and page indexes
expected; a document with no font-size jump detects nothing; a heading split across two
runs (no space between them) is still read as one title; heading sizes beyond
`maxLevels` collapse into siblings at the deepest level rather than a phantom fourth
level; consecutive same-level headings are siblings, not nested; and `countCandidates`
counts the whole tree, not just the top level (a real bug caught live, not in review: an
earlier version of the "Found N heading(s)" toast counted only top-level candidates,
reporting "Found 1" when a chapter and its nested section both appeared on screen).
Confirmed live end to end against the running app: a real two-level fixture (an H1 and a
nested H2) detects correctly, exports, and the *exported* PDF's real `/Outlines` —
independently re-parsed, not the panel's own state — has "Chapter 1" as the top-level
entry with "Section 1.1" nested under it exactly as detected, going through OPS-10's
existing, already-tested export path completely unchanged. Full suite (744 tests),
`tsc --noEmit`, eslint, and prettier all clean.

- **Requirements:** Scan extracted text runs for font-size/weight jumps that read as
  headings and propose a bookmark tree from them, seeding OPS-10's editor rather than
  writing `/Outlines` directly. The user reviews and accepts before anything is written.
- **AC:** A fixture with three heading levels by font size produces a proposed tree with
  matching nesting and correct target pages; accepting it round-trips through OPS-10's
  existing export path unchanged.

### SGN-07 · Calculated AcroForm fields — `M` `P2`

**Status: Done** — `src/core/formula.ts` is a closed infix grammar: four operators,
parentheses, decimal literals, and field names matched *longest-first* against the
document's own field list (so `Line Total`, `name.first`, or any field name a PDF author
actually used — spaces, dots, hyphens — is addressable, which no identifier regex could
manage). There is no `Function`/`eval` anywhere in it — the parser can only ever build the
three `FormulaNode` kinds, so a hostile formula string has nothing to reach — and a
function-call spelling like `sum(a, b)` is caught and rejected with the infix form named
in the message, rather than a bare syntax error. `evaluateFormulas` resolves one field's
formula referencing another calculated field correctly (computed from *this pass's*
value, not last render's), detects a reference cycle instead of recursing forever, and
treats an unfilled field as 0 while an unparseable one (text, a European `12,50`) is a
hard error rather than a silently wrong total.

**Where the formula lives**: in-session Stapler state only (`formulas` signal in
`src/ui/tools/sign/state.ts`), not written into the PDF anywhere — lost on reload, which
is the deliberate, disclosed trade-off. A full spec-compliant calculated field (an `/AA`
JavaScript action Acrobat itself would run) is explicitly out of scope; this recomputes
the value once, at export, from Stapler's own rules.

**UI**: a "Calculated fields" section in `SignPanel.tsx` lists every text field with a
checkbox ("Calculate…") that reveals a formula input, live-validated (`parseFormula`)
with the parse error shown inline. `AcroFormOverlay.tsx` renders a calculated field's live
computed value directly on the page and makes it read-only — the on-page box is
literally `applyFormulas(formulas, fields, formValues)`'s own output, the same call the
panel and the export path make, so what is on screen cannot drift from what gets written.
`commit.ts`'s `sign` handler runs that same merge before `fillFormFields` and refuses the
save outright — no file written — if any formula errors, naming which field and why.

Evidence: `tests/unit/formula.test.ts`, 53 tests — the parser's accepted/rejected
boundary (26 rejection cases spanning every JS operator/syntax form deliberately left
out, a function-call spelling, cycle detection, nesting/length caps against an
adversarial `((((…` input); `parseFieldNumber`'s coercion (checkbox as 1/0, a leading
currency symbol, grouped thousands accepted, a European decimal *refused* rather than
misread); and the AC itself against a real fixture (`calculatedFormPdf` in
`tests/e2e/fixtures.ts`) — `getFormFields` → `applyFormulas` → the existing SGN-03
`fillFormFields` → an independent `PDFDocument.load` reading `/V` straight off the field
dictionary, confirming the *computed* number is there, the formula string is nowhere in
the raw bytes, and no `/JavaScript` or `/AA` was added (nothing needs to run for a
viewer to show the right value). A companion case proves flattening still bakes the
computed value into the page content, and another proves a formula error leaves nothing
written. Live recalculation was additionally confirmed by hand against the running dev
server: checking "Calculate" on a fixture's total field and typing `subtotal + tax +
shipping` updates the on-page box to `119.75` immediately, with zero console errors.
Capturing the actual export *download* through that same ad-hoc script did not succeed —
the dev server (unlike the built preview server `tests/e2e` targets) 404s on a pdf.js
asset unrelated to this ticket, and chasing that further was not a good use of time given
the export path itself is already independently proven by the unit test above, which
exercises the identical `fillFormFields` call against real bytes. `tsc --noEmit`, the full
suite (723 tests), eslint, and prettier are all clean.

- **Requirements:** A formula field type on top of SGN-03 restricted to sum/product/
  difference across named numeric fields — no arbitrary expression evaluation — that
  recalculates when a referenced field changes and writes the result as a normal field
  value on export.
- **AC:** A fixture with three input fields and one sum field shows the correct total
  live as inputs change, and the exported PDF's field value matches in an external
  viewer with no active script required to display it.

### SGN-08 · Fast multi-page initialing — `S` `P2`

**Status: Done** — Already shipped: `duplicateAnnotationToAllPages` in `src/core/store.ts`
and the per-stamp "Duplicate to all pages" button in `AnnotationOverlay.tsx` (both
pre-dating this ticket) do exactly what SGN-08 asks — place a saved initial (or any
stamp) on every remaining page at the source stamp's own rectangle, in a single
`commit()`, so it is one undo entry rather than one per page. What was missing was the
AC's own proof, which had no test at all before this ticket.

Evidence: `tests/unit/store.test.ts` → "duplicateAnnotationToAllPages (SGN-08: fast
multi-page initialing)" — a 20-page fixture ends with exactly one stamp per page, every
stamp sharing the source's `x`/`y`/`width`/`height`/`data` (the AC's literal "rectangle
position equality across pages"), every stamp with its own distinct id (so moving one
later cannot move them all), and two `undo()` calls peeling back exactly two entries —
placement, then the all-pages duplication — confirming "in one action" rather than
nineteen. A second case confirms a reference to a since-removed annotation is a no-op,
not a crash. Full suite green, `tsc --noEmit`, eslint, and prettier all clean.

- **Requirements:** Apply a saved initial (from SGN-01's library) to every page in one
  action, at a fixed position/size, instead of placing it page by page through SGN-02.
- **AC:** Running it on a 20-page fixture places the same initial at the same position
  on every page in one action, verified by rectangle position equality across pages.

### SGN-09 · Signature/tamper integrity report — `S` `P2`

**Status: Done** — `checkSignatureIntegrity` in `src/core/workers/process.worker.ts` walks
`/AcroForm/Fields` (recursing into `/Kids`, the same field hierarchy `getFormFields`
already handles) for any field with `/FT /Sig`, reads its `/V` signature dictionary's
`/ByteRange`, and checks whether the range's second span reaches the document's *current*
byte length. Standard incremental-update signing has that span run to the file's end
*as it was when signed*; if the file has grown since (bytes appended without re-signing),
the current length no longer matches — which is the structural definition of "modified
after signing" this ticket asks for, computed from real offsets rather than inferred.
`/Contents` (the signature payload itself) is never read or validated — this is
explicitly not PAdES/CMS cryptographic verification, matching the ticket's own scope and
this codebase's non-goal on certificate-based signing.

For a document signed more than once, only the *outermost* signature's reach is what
`intact` reports on: an earlier signature's own range legitimately stops short once a
later signature adds bytes after it, so checking every signature's own reach would
misreport a valid, ordinary multi-signature chain as tampered. Surfaced in `SignPanel.tsx`
as a note next to the existing form-fields notice — neutral when intact, using the
existing warning-styled `.note` class when not — computed alongside the existing
`getFormFields` fetch, not inside it, since the check has nothing to do with whether the
document has *fillable* fields.

Evidence: `tests/unit/signature-integrity.test.ts` — since there is no cryptographic
signing anywhere in this codebase to produce a real signed PDF from, the fixture builds a
`/Sig` dictionary by hand (the same approach `golden.test.ts` already uses for a raw
`/Outlines` tree): a `/Contents` hex placeholder and `/ByteRange` numbers are both
reserved at a fixed text width *before* the first save (mirroring how real incremental
signing reserves space before it knows the final offsets), the real offsets are measured
from the saved bytes, and patched back in as same-width text so nothing else shifts —
the fixture is proved genuine by re-parsing it with a fresh `PDFDocument.load` and
reading its real page count before ever calling the function under test. Four cases: no
`/Sig` field at all reports `{ hasSignature: false, intact: null }`; the intact fixture
reports `intact: true` with `start + length` of its second range equal to the real file
length; the same fixture with exactly one byte appended reports `intact: false`, and the
reported range now falls exactly one byte short of the tampered file's real length (not
merely "false", the precise arithmetic the AC calls for); and a copied buffer of the
intact fixture, re-checked, still reports intact — ruling out any read-time drift.
Confirmed live against the running app: both fixtures show the correct note (neutral vs.
warning-styled) with zero console errors. Full suite (736 tests), `tsc --noEmit`, eslint,
and prettier all clean.

- **Requirements:** For a document containing a `/Sig` dictionary, report whether the
  signature's byte range still covers the current file content (i.e., whether bytes
  outside the signed range were appended/changed) — a structural check, not PAdES/CMS
  cryptographic validation.
- **AC:** An untouched signed fixture reports intact; the same fixture with a byte
  appended after the signed range reports modified-after-signing, both against real
  byte offsets, not a guessed heuristic.

### RED-07 · Freehand/polygon redaction shapes — `M` `P1`

**Status: Done** — A shaped mark is an *optional polygon on the existing rectangle*, not a
second kind of mark. `RedactionRegion` (`src/core/workers/process.worker.ts:304`) gained
`points?: {x,y}[]` in the same normalised page-fraction frame, with `x/y/width/height`
continuing to hold the outline's bounding box. That choice is what kept RED-01/02/03
untouched: `groupRegionsByPage`, the pixel verifier's render window, the annotation sweep, the
panel's mark list and the overlay's arrow-key nudging all still read the box, and a mark with
no `points` takes byte-identical code paths to before. A discriminated union would have
forced every one of those to narrow first. RED-05's suggestions, being boxes, are unaffected.

Geometry lives in one new pure module, `src/core/geometry.ts`, because four layers ask the
same "is this inside the mark?" question in four different spaces (content space, the
normalised display frame, region-local pixels, an image's unit square) and any disagreement
between two of them is a leak. It uses the **nonzero winding rule** throughout
(`pointInPolygon`, `geometry.ts:65`) precisely because that is what pdf-lib's `drawSvgPath`
fill emits (`f`, not `f*`); had the predicates used even-odd while the cover filled nonzero, a
self-crossing scribble would paint opaque black over an area the predicates call "outside" —
text never removed, never verified, hidden under a black shape, which is the overlay-only
failure RED-02 exists to prevent.

Where the polygon is consulted:

- **Removal** — `RedactionArea` (`interpreter.ts:353`) is `Rect & { polygon? }`, so
  `filterContentStream`'s signature change is source-compatible with every existing
  `Rect[]` caller. `areaTouches`/`areaCovers` (`interpreter.ts:366`, `:372`) test the box
  first and then the shape, and replace the bare `intersects`/`contains` calls for text
  runs, vector paths, Form XObjects, image coverage, and (`process.worker.ts:5545`)
  overlapping annotations. The granularity is deliberately RED-02's existing one: a run is
  removed when its box *overlaps* the shape, not when the shape contains it, so switching a
  mark from rectangle to shape can never leave behind a run the rectangle would have taken.
  RED-05's documented whole-run limitation is unchanged and not narrowed here.
- **The cover** — a shaped mark is filled as its own path (`process.worker.ts:4877` via
  `polygonSvgPath`, `:5080`) instead of `drawRectangle`. Drawing the bounding rectangle would
  black out the corners the shape deliberately left alone — content the user chose to keep —
  and the shape-aware pixel verifier would still pass it, so the difference would be silent.
- **Coordinates** — the polygon goes through `redactionRectsForPage`'s own four-case rotation
  mapping, reduced to a point (`pointToPage`, `process.worker.ts:5109`), rather than a second
  transform invented for shapes. Proved rather than asserted: at each of 0/90/180/270°, a
  polygon built from a rectangle's own four corners removes exactly the lines that rectangle
  removes.
- **Verification (RED-03)** — `checkRegionText` (`render.worker.ts:1397`) adds the shape test
  to its per-character box test. The pixel half needed a real fix, not just an extension:
  `regionPixelResidue` grades the rendered *bounding box*, so a correct shaped redaction would
  have failed on the corner content it correctly kept, blocking a legitimate save. It now
  rasterises the shape into the region's own pixel grid and erodes it by the same
  anti-aliasing inset the rectangle path trims from its edges (`render.worker.ts:674`,
  `regionLocalPolygon` at `:750`). A mask of all ones eroded by that inset *is* the old
  rectangle loop, which is why the rectangle path is untouched and its tests unchanged.
- **Images** — the shape is carried through the inverse CTM into the image's unit square
  (`redactionAreaInUnitSpace`, `interpreter.ts:459`) and `paintRectsBlack`
  (`image-redaction.ts:57`) rasterises it into the image's own pixels, dilated by one pixel to
  keep the existing over-removal rounding bias. So a shape over a photo destroys the pixels it
  encloses rather than the box around them.

UI: a `Draw shape` radio group in the panel (`RedactPanel.tsx:119`) switches
`redactShapeMode` (`state.ts:14`); the overlay traces on pointer-move, sampling by distance
(`TRACE_STEP`, `RedactOverlay.tsx:46`, capped at 160 vertices by `thinTrace`) and closes the
shape on pointer-up (`finishTrace`, `:193`). A shaped mark reuses the rectangle mark's box
element — same focus, same remove button, same arrow-key move/resize, with the outline carried
by the same transform as the box so the two cannot drift apart — and draws itself as an inline
SVG polygon with `var(--doc-redact)`/`var(--danger)`; no new token, no colour literal.
Verified visually at 1280×800 and 900×800 in both themes: the shape matches the trace, the
page stays white in dark mode, and the `--primary-focus` ring is visible on keyboard focus.

**Keyboard fallback, decided deliberately:** `Enter`/`Space` on the drawing layer adds a
**rectangle even in freehand mode**. There is no keyboard equivalent of tracing, and a default
polygon would hand a keyboard user a shape they cannot reshape (per-vertex editing is out of
scope) instead of one they can move and resize. The reason that fallback exists — never
leaving a keyboard-only user unable to mark something the text search cannot find — is served
by a rectangle, and would not be served better by a decorative polygon.

Evidence, `tests/unit/redact-polygon.test.ts` (17 tests) against a right triangle whose
bounding box has a large empty corner with content planted in it, so the two possible
implementations produce different exports: the enclosed run is gone from the decompressed
content stream *and* from pdf.js's text extraction, the corner run and a vector block in that
corner survive, and the control — the same box with no `points` — removes both, which is what
proves the polygon test rather than the layout saved them. Then: `checkRegionText` finds
nothing in the shape, `checkRegionPixels` passes it while grading the same output as a box
fails, a probe over the kept corner still reads as content (the cover really is not a
rectangle), and a block painted back inside the shape is caught. E2E in a real browser
(`tests/e2e/tool-flows.spec.ts`, "a freehand shape removes only what its outline encloses"
and "freehand mode still has a keyboard path to a mark") traces the shape with the mouse and
asserts the exported bytes.

**Limitations accepted rather than solved:** per-vertex editing after drawing is out of scope —
draw it, or delete and redraw. `polygonContainsBox` answers "no" for an edge that merely grazes
the box, which routes an image to the pixel path and destroys slightly more of it than
necessary (over-removal is the only safe direction). A shape whose interior is thinner than
the anti-aliasing inset samples no pixels, so the pixel half of the gate abstains on it and
only the text and string checks apply — the same conservatism a sub-pixel rectangle mark has
always had. New UI strings fall back to English until the next `i18n-extract` pass.

- **Requirements:** Extend RED-01's rectangle-only marking with a freehand/polygon draw
  mode whose bounding shape feeds the same RED-02 commit and RED-03 verification
  pipeline — a polygon mark removes the text/image content it encloses, not just its
  bounding box's naive rectangle.
- **AC:** A polygon mark drawn around an irregular region removes exactly the enclosed
  text runs on export and RED-03's verifier reports no residual text inside the marked
  polygon.

### RED-08 · On-device face/logo blur — `L` `P2`

**Status: Done, with the logo half deliberately narrowed — see "Scope narrowed" below.** **Superseded in part by AUDIT-2026-09-25 CONV-6 / PLT-8 (2026-09-26):** the `tinyFaceDetector` weights are now bundled, so there is no download, no consent dialog and no CSP allowance — OCR is again the only network exception. The paragraphs below on the "second disclosed network exception", `download.ts`, `modelState.ts` and AC 2's decline path describe the first implementation (`tests/unit/faceblur-offline.test.ts` replaces `faceblur-consent.test.ts`). Faces inside Form XObjects are found since PDF-14; images drawn only from annotation appearances or tiling patterns are still skipped (HRD-41).

**The second disclosed network exception.** Invariant #1 allowed exactly one fetch — OCR's
language model. This adds the second, and the two are now enumerated together in
`CLAUDE.md` invariant #1, `docs/PLAN.md` §5.4 item 5, and the header comment of
`src/core/ocr/model.ts` (which used to call itself "the single documented exception").
`.claude/hooks/check-invariants.mjs`'s `ocrExempt` is renamed `modelDownloadExempt` and
now also matches `src/core/faceblur/`, used exactly where the old flag was — the
`REMOTE_HOSTS` and `NETWORK_APIS` checks only, never the colour or `chrome.*` checks.

**Engine bundled, weights fetched.** `@vladmandic/face-api@1.7.15` (MIT) is a normal
dependency in `package.json`; its `dist/face-api.esm.js` carries the TensorFlow.js runtime
inside it, and `src/core/faceblur/detect.ts` imports that path as a literal dynamic import
so Vite code-splits it into a chunk nothing loads until a blur is actually run. Only the
`tinyFaceDetector` weights (~196 KB) are fetched, from
`https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/model/` — pinned to the exact
package version, the same "download once, then fully offline" pattern OCR-01 established.

**On the library choice**, since it was a starting recommendation to verify rather than
take on faith: `@vladmandic/face-api` is real, MIT, and the maintained fork of the
abandoned face-api.js, though its last release (1.7.15) is well over a year old — "actively
updated" would be generous. It was still the right pick over the more current alternative
considered (`@mediapipe/tasks-vision`): face-api's weights land on the CDN host this
project already discloses for OCR rather than adding a second one, the model itself is a
fraction of MediaPipe's WASM runtime, and — the deciding factor — face-api's TensorFlow.js
runs on a pure-JS CPU backend, which is what makes the real detector testable in the unit
suite under Node rather than only behind a browser (MediaPipe cannot run headless at all).

**Where the work happens.** `src/core/faceblur/` holds the parts that can be tested without
a PDF: `model.ts` (the pinned URL and a `setModelBaseOverride` test seam, mirroring
`ocr/model.ts`), `modelState.ts` (`faceblur.modelDownloaded.<id>` via `readSetting`/
`writeSetting`, mirroring `ocr/modelState.ts`), `download.ts` (the only `fetch`),
`detect.ts`, `blur.ts`, `logoMatch.ts`, and `runFaceBlur.ts`. The PDF surgery reuses RED-02's
plumbing rather than a parallel copy: `render.worker.ts`'s new `blurPageImages` calls the
same `decodeImage`/`encodeRedacted` that `redactPageImages` uses, so SMask re-attachment,
CMYK→RGB and Indexed handling are code paths RED-02 already proved. `process.worker.ts`
adds `planPageImages` and `replacePageImages`; the latter is deliberately *not* a
`PDFDocument.create()` + `copyPages` rebuild the way `applyRedactions` is, because blur
touches pixels only and the cheapest way to keep every content stream, font and vector
byte-identical is to never take them apart. Retired image streams are purged via the
existing `purgeXObjectIfUnreferenced`, after every page is rewritten rather than during, so
an image shared by two pages is not unhooked while the second still names it. Reuse costs
one encode, not one per page: `runFaceBlur.ts` keys a `firstPlacement` map by object number,
decodes each distinct image on the first page that draws it, and `replacePageImages` embeds
each replacement once and reuses the ref across every slot.

**AC 1 — "a fixture with a known face position blurs a region overlapping that position and
no others": met.** `tests/fixtures/face-chip.png` is a real 240×240 photograph of a face,
cropped from the MIT-licensed `demo/sample1.jpg` inside the installed face-api package (so
no asset enters the repo from outside the dependency tree). The face occupies `x 62, y 63,
113×112` in it — measured by eye and recorded in `tests/fixtures/README.md`, deliberately
not taken from a detector run, since asserting that the detector agrees with its own
previous answer would prove nothing. `tests/unit/faceblur.test.ts` composites that chip on
a larger raster with coloured blocks elsewhere, loads the real `tinyFaceDetector` weights
off disk and runs the real network on the CPU backend, and asserts: exactly one detection;
most of the known face rectangle inside it at a high IoU; after `pixelateRects`, the large
majority of sampled pixels inside the known box differ substantially from the original;
named background probes are byte-identical; and a fine-stride sweep of the raster finds
zero changed pixels outside the padded detection boxes. A second test feeds a face-free
texture and asserts the result is `[]`, so "blurs a region" is not "blurs everything". The
same is then proved through real PDF bytes in the same file: the raster goes into a
one-page PDF with real text, through the real `planPageImages` → `replacePageImages` pair,
and the output bytes are re-parsed — pdf-lib reports the right page count, pdf.js
re-extracts the page's own text untouched by a pixel operation, the substituted image's own
inflated samples show the same changed/unchanged split, and a sweep of every image stream
in the output confirms the unblurred original is gone from the file rather than merely
unreferenced.

**AC 2 — "declining the model download leaves the tool disabled with a clear message, never
a silent no-op on export": met.** `runFaceBlur.ts` resolves the confirmation before
anything is spawned or requested, and returns `null` on a decline.
`tests/unit/faceblur-consent.test.ts` stubs `fetch` to throw rather than to resolve (a stub
that returns something would still pass a call-count test) and asserts that on decline
`fetch`, `renderWorker`, and `processWorker` are all untouched and the consent flag is
unset. The flag is written only after a run completes, so a failed run re-asks. Logo-only
mode asks for nothing and fetches nothing, because template matching needs no model.
Through the real UI, `tests/e2e/tool-flows.spec.ts`'s RED-08 test declines the dialog and
asserts the persistent toast, the "Blur faces" checkbox and "Find and blur" button both
disabled with a panel note explaining why, the export path itself saying "Faces in this
document were not blurred" when Verify & apply is pressed afterwards (`commit.ts`'s
`redact` handler, gated on `faceBlurModelDeclined`) — the specific "never a silent no-op on
export" clause — and zero external requests across the whole decline path. An "Allow the
download" button restores the tool.

**Scope narrowed, stated rather than glossed:** "or a marked logo" is implemented as
template matching (`logoMatch.ts`), not as a second model. A face detector does not find
logos, and the honest cheap answer is correlation: the user marks the logo once with an
ordinary RED-01 mark, its pixels are cropped out of the image it sits on, and every other
embedded image is searched for it by zero-mean normalised cross-correlation —
brightness- and contrast-invariant, so the same mark over a grey header and over white
paper both score. It does not find a rotated, mirrored, or recoloured copy, and searches
only a narrow scale ladder around the marked size. The panel says so. It also only searches
*embedded images*: a logo drawn as vectors has no pixels to match, and the panel says that
too.

**One honest gap:** the pdf.js decode / OffscreenCanvas re-encode step inside
`blurPageImages` is not covered by the Node unit suite — neither exists outside a browser —
so the byte-level AC 1 test drives the pure detection and pixel code plus the real pdf-lib
substitution, with the decode/encode pair being the identical, already-proven functions
RED-02 ships. The e2e test covers the decline path in a real browser but not a completed
blur. This implementation was recovered and merged from a background agent whose worktree
had drifted from a different point in this session's history (missing fixtures the rest of
this session had since added, and RED-07, which did not exist on that branch); after
merging, `tsc --noEmit`, `eslint`, `prettier --check`, and the full `vitest run` (805 tests)
are all clean on this tree — the agent's own "not green" disclosure was accurate for its
worktree but does not carry over.

- **Requirements:** Detect faces or a marked logo in embedded page images using a local
  WASM/ONNX model downloaded once on explicit user confirmation (OCR-01's pattern), and
  blur/pixelate the detected regions in the exported image, never uploading pixels
  anywhere.
- **AC:** A fixture with a known face position blurs a region overlapping that position
  and no others; face blur makes zero network requests (bundled weights); an image the
  detector cannot reach is reported as skipped, never a silent "no faces found".

### RED-09 · Batch metadata scrub — `S` `P1`

**Status: Done** — A "Scrub metadata from every file" checkbox in the Batch panel
(`scrubMetadataInBatch` in `src/ui/tools/batch/state.ts`) runs after BAT-01's existing
per-file tool loop in `runner.ts`. The decision is made per file, not per batch: each
file's own bytes are re-inspected with the same `readMetadata` RED-04 uses, then
`stripAllMetadataSettings` (`src/core/metadata-scrub.ts`, a pure function shared by
nothing else on purpose — it has to build "strip everything *this* file's findings
report" from a `MetadataFindings`, not from another file's) turns that into the
`ScrubSettings` RED-04's own `scrubMetadata` already accepts. A file with nothing to
strip is written through untouched and gets no scrub note; a file that had something
removed gets a `metadata-scrubbed` batch note naming how many findings were removed —
`countMetadataFindings` counts actual pieces of information (a `customInfo` toggle that
clears seven non-standard Info entries reports 7, not 1), fixed after an independent AC
verification pass caught the original `Object.keys(settings).length` undercounting it.
The panel checkbox label was also rewritten after that pass flagged it leaking the
ticket ID (`RED-04`) into user-facing copy.

Evidence: `tests/unit/batch-runner.test.ts` → "RED-09" describe block — off by default
(no `readMetadata`/`scrubMetadata` call), and "decides each file from its own findings,
not the first file's": two mocked fixtures, only one carrying a marker `readMetadata`
reads as an author, prove only that file's bytes reach `scrubMetadata` and only that file
gets the note. That test mocks both worker calls, though, so it proves *routing*, not that
metadata is actually removed — the same verification pass called this out directly. Real
removal is proved separately in `tests/unit/batch-metadata-scrub.test.ts`, driving the
*real* `processWorkerImpl.readMetadata`/`scrubMetadata` (comlink mocked, nothing else) on
two real documents with different metadata: each document's strip settings are asserted to
reflect only its own findings, the scrub actually removes them from re-parsed output bytes
(`PDFDocument.load` afterwards, not just the findings report), and a separate case proves
even pdf-lib's own stamped Producer/Creator/dates on an otherwise-plain document are caught
and stripped — the kind of disclosure RED-04 exists for in the first place.

- **Requirements:** Run RED-04's metadata scrubber across every file in a selected
  folder/batch in one action, reusing BAT-01's folder-processing infrastructure.
- **AC:** A batch of N fixtures each carrying identifying metadata produces N outputs
  with metadata removed, each independently verified against its own source (not just
  the first file in the batch).

### OPS-15 · Split by target file size — `S` `P1`

**Status: Done** — A "Split by target file size" mode alongside OPS-03/OPS-12, planned by
`planSizeSplitBoundaries`/`planRangesBySize` in `src/core/operations.ts` since a slice's
real size is only known after composing, not from page count alone.
AUDIT-2026-10-01 IMG-4 (HRD-64, 2026-10-02): the target is decimal (`targetSizeKb * 1000`); it was `* 1024`, so "5000 KB" allowed 5.12 MB parts that fail a 5 MB portal limit.

**First version had a real bug, found by an independent AC verification pass, not by
inspection: it over-split documents whose pages share a large resource.** That version
composed every page *individually* once, summed the isolated sizes, and cut greedily
before the running sum would exceed the target — reasoning that summing isolated pages is
a safe over-estimate, since a multi-page slice can only *save* bytes by embedding a shared
resource once instead of once per file. That reasoning is correct in direction but was
used the wrong way: on `tests/fixtures/shared-image.pdf` (10 pages sharing one big image,
~4.68MB combined) it produced **10 files totalling ~46.8MB** — each individual page
"safely" fit under a 5MB target on its own, so the greedy walk cut after every single
page, throwing away all of the sharing the real combined file gets for free. A target the
whole document already met produced ten times more output than the input.

The fix replaces summing with recursive bisection over real measurements
(`planRangesBySize`): ask whether the *whole* candidate range's actual composed size fits
the target; if yes, stop — that range is one output file, no matter how many pages it
spans. If no and the range is more than one page, bisect and ask the same question of
each half. This asks "does sharing already make this fit?" before ever proposing a cut,
so a document that fits entirely (the shared-image case) costs exactly one `composeSplit`
call and produces zero cuts. `planSizeSplitBoundaries` wires this to reality: each
candidate range is composed alone (no internal boundaries) through the same
`splitDocument`/`composeSplit` path the real split uses, so what gets measured is exactly
what would ship. A leaf that is still one page and still over target is unavoidable (nothing
left to bisect) and is now reported back as `oversized` rather than silently accepted —
`commit.ts`'s split handler surfaces a persistent warning naming each such page and its
real size, which the first version never did; a user asking for ≤2MB used to get a larger
file back with no indication anything was off.

Wired into the split commit handler in `commit.ts` (`settings.mode === 'size'` branch)
ahead of the existing `splitDocument` call, so it reuses every downstream behaviour
(ZIP/folder output, Bates, watermark) unchanged.

Evidence: `tests/unit/split-by-size.test.ts` — `planRangesBySize` against synthetic cost
models, including one that explicitly simulates the shared-resource scenario (proving zero
cuts when the whole thing already fits, and correct bisection down to oversized singles
when a shared cost alone exceeds the target), plus the same union/no-overlap and
single-page-never-splits properties `split.test.ts` asserts for the other modes;
`planSizeSplitBoundaries` against a mocked `composeSplit` for the range-slicing wiring; and
— the actual regression test for the bug — a real-fixture case against
`tests/fixtures/shared-image.pdf` through the unmocked `processWorkerImpl`, asserting the
whole 10-page, ~4.68MB document plans as zero cuts under a generous target, which is
exactly the case the first version got wrong by an order of magnitude. Full suite green,
`tsc --noEmit` clean, lint/format clean on every touched file.

- **Requirements:** A size-based split mode alongside OPS-03/OPS-12: cut the document
  into consecutive-page files each at or under a target size (e.g., for email
  attachment limits), never splitting a single page across two outputs.
- **AC:** A fixture whose pages have known, unequal weights splits into files each
  under the target size (measured on real output bytes), with the same
  union/no-overlap page-coverage property OPS-03 already tests.

### OPS-16 · Cross-document page reordering before merge — `M` `P1`

**Status: Done** — Already built, by construction, before this ticket existed: OPS-01's
"Add files" appends each new source's pages into the *same* unified `doc.pages` array
(`appendPages` in `src/core/store.ts`), and `movePages`/`movePage` reorder by page key
alone with no notion of which source a key came from. DOC-04's page grid already calls
`movePages` from both drag-and-drop and the arrow-key reorder (OPS-02), so a user could
already drag any page next to any other page regardless of source — `MergePanel.tsx`'s
own description text ("Drag pages in the grid to reorder across files") already said so.
What this ticket actually contributes is proof that the claim holds all the way through
export, not just in the in-memory list: `tests/unit/golden.test.ts` →
"golden: OPS-16 cross-document page reordering before merge" seeds three sources of
unequal page count (2, 2, 1), appends them end-to-end, then calls the exact same
`movePages` the UI calls to interleave into `[a0, b0, c0, a1, b1]` — an arrangement no
whole-file reorder could produce — and asserts the real composed export's page count,
per-page text (each source's own 1-based numbering, read back in interleaved order), and
the page-union property (every `sourceDocId:sourceIndex` pair contributed exactly once)
all match. No production code changed; nothing needed to.

- **Requirements:** Before committing OPS-01's merge, let the user drag individual
  pages from multiple loaded source documents into one combined, freely-ordered list —
  not just reordering whole source files in sequence.
- **AC:** Merging three fixtures with pages interleaved out of source order produces an
  output whose page sequence matches the interleaved order exactly, keyboard-operable
  throughout.

### OPS-17 · Image/logo watermark — `S` `P1`

**Status: Done** — Already shipped: OPS-08's own writeup discloses that "an image
watermark (PNG/JPEG, same grid/opacity/rotation/page-range)... was added in a later
pass," and it was — `WatermarkImage`/`kind: 'image'`/`imageScale` in
`src/ui/tools/watermark/state.ts`, a file picker sniffing PNG/JPEG magic bytes
(`readWatermarkImage`), and the actual draw in `process.worker.ts` (`embedPng`/
`embedJpg` + `drawImage`, sharing `positionOrigin`'s 9-point grid and
`placeDisplayBox`'s rotation handling with the text watermark, Bates stamp, and
header/footer) all existed before this ticket. What was missing was AC-grade proof:
the one prior test (`process.test.ts` → "embeds the picked image only on the targeted
pages") checked presence per page range, not that position/opacity/scale actually
landed where the settings said.

Added `tests/unit/process.test.ts` → "places the image at the exact position, scale,
and opacity the settings specify": a page-rendering canvas isn't available in this
Node test environment (per QA-02's own note on why PDF→image tests live in e2e
instead), so this reads the real content stream instead of pixel-sampling a raster.
`drawImage` at rotation 0 emits its placement as three separate `cm` operators —
translate, an identity rotate, then scale — confirmed by probing pdf-lib's own
`drawImage` operation list rather than assumed; the test decodes those and asserts
the translate's e/f against `positionOrigin`'s bottom-right formula
(`pageWidth - boxW - padding`, `padding`) and the scale's a/d against
`pageWidth * imageScale` and its aspect-derived height, on a deliberately non-square
(2:1) image so a width/height swap would be caught. Opacity is read from the page's
`/ExtGState` resource's `/ca` entry directly, not regexed out of the stream. Full
suite green (643 tests), `tsc --noEmit` clean, lint/format clean.

- **Requirements:** Extend OPS-08's stamp engine to place a user-supplied image (e.g., a
  logo) as a watermark, sharing the same 9-point placement grid, opacity, and scale
  controls as the existing text watermark.
- **AC:** A fixture stamped with a logo image shows it at the configured position,
  opacity, and scale on every page, pixel-sampled against the expected placement.

### ANN-06 · Redline export — `S` `P2`

**Status: Done (2026-10-02)** — A new `exportRedlinePdf` (`src/core/redline-export.ts`), wired in as a
third `diffMode` alongside ANN-05's `'visual'`/`'text'` in `compare-export.ts`'s existing
dispatcher and `ComparePanel.tsx`'s `RadioGroup`. Each source page is rasterised once
(`renderAllPages` loads the whole document a single time rather than once per page, unlike
`exportVisualDiff`'s per-page load) and drawn into its own output PDF page next to its
counterpart, "Before"/"After" labelled, rather than merged into one overlay image the way
ANN-05 does.
AUDIT-2026-10-01 X-5 (HRD-66): the export now works page by page instead of rasterising every page of both documents at once (~1.7 GB for a 200-page pair), and its diff/encode runs in the cv worker with per-page progress (X-6). Tests: `tests/unit/compare-export-audit-2026-10-01.test.ts`, `tests/e2e/audit-2026-10-01-ui.spec.ts` (each pane at its own page size).

- **AC met — before/after side by side at matching scale:** both panes are placed at their
  *true* point size — pixel dimensions divided by the same `RENDER_SCALE` (1.5) constant
  for both sides (`redline-export.ts:130-137`) — rather than stretched to fit a shared box.
  `tests/unit/redline-export.test.ts`'s "renders each pane at its own true scale" test
  proves this the way a force-fit implementation would fail it: a 100×100 "before" next to
  a 200×200 "after" produces an output page wide enough for both true sizes (100/1.5 +
  200/1.5 pt), not merely twice the smaller pane — a real size change stays visible instead
  of being hidden by normalisation. Live-verified with two 3-page fixtures differing only
  on page 2: `pdftoppm` raster of the real download shows "Before"/"Page two (before)" and
  "After"/"Page two (after, marked)" side by side at equal scale.
- **AC met — unchanged pages skipped or marked, per the option:** a new `unchangedPages:
  'skip' | 'mark'` setting (`compareSettings` in `src/ui/tools/compare/state.ts`, a second
  `RadioGroup` shown only in redline mode). `pageHasChanges` (`redline-export.ts:72-85`)
  calls the same `pixelDiff` ANN-05 already uses, plus two cases pixel-diff alone can't
  cover: a page present on only one side, or a page whose rendered dimensions differ, both
  of which count as changed by definition rather than throwing (pixelDiff itself requires
  identical dimensions). `'mark'` keeps every page and stamps a grey "UNCHANGED" banner
  band on ones with no changes (confirmed live: an unchanged page's output height came out
  `LABEL_BAND_PT` taller than a changed page's — 588pt vs 568pt on the test fixtures —
  exactly the added banner row); `'skip'` drops them, verified
  live with the two 3-page fixtures producing exactly 1 output page (the one truly-changed
  page). `tests/unit/redline-export.test.ts` covers both modes plus the "nothing changed at
  all" edge case (`'skip'` with zero real differences still emits one informational page
  rather than a degenerate zero-page PDF) and the missing-page-on-one-side case.
- **Test seam matching ANN-05's:** `exportRedlinePdf` takes an optional 4th
  `RedlineRenderedPages` argument so unit tests inject known `ImageData` directly instead of
  routing through the render worker — the same shape `exportVisualDiff`'s `diffResults`
  parameter already gives ANN-05, not a new pattern.
- **No raw colours:** the banner/border colours needed for PDF page content (not CSS) were
  added to `src/core/doc-colors.ts` as named RGB tuples (`REDLINE_BANNER_BG_RGB`,
  `REDLINE_BANNER_TEXT_RGB`, `REDLINE_PLACEHOLDER_BORDER_RGB`), the same pattern every
  other pdf-lib-facing colour in that file already follows, rather than passing numeric
  literals to `rgb()` directly (which the invariant hook correctly rejects).
- 7 new tests in `tests/unit/redline-export.test.ts`, 1 new dispatcher-routing test in
  `tests/unit/compare-export.test.ts`; full suite (760 tests) green, `tsc --noEmit`,
  `eslint`, `prettier` all clean.

- **Requirements:** Export a side-by-side before/after page layout (source page image
  next to the compared page image) as a print-ready PDF, distinct from ANN-05's
  overlay-diff export.
- **AC:** Comparing two fixtures with a known changed page produces a redline PDF with
  that page's before/after rendered side by side at matching scale; unchanged pages are
  either skipped or clearly marked unchanged, per the export option chosen.

### DOC-10 · Local edit-history / audit-trail log — `M` `P2`

**Status: Done, with "affected pages" explicitly not implemented — see below.** A new
`history` tool lists the session's operations and exports them as text. The log is
`undoLog`/`redoLog` in `src/core/history.ts`, two arrays kept in exact lockstep with the
existing `undoStack`/`redoStack` — same push, same pop, same clear — rather than folding
a label into `Snapshot` itself, so `historySourceRefCount`'s existing raw-snapshot walk
is untouched. `operationLog()` is just `undoLog` copied out: an operation undone before
export is excluded *by construction* (it physically leaves `undoLog` the moment `undo()`
pops it onto `redoLog`), not by a separate filter that could drift from what the undo
stack actually holds — and it comes back, with its original label and timestamp
unchanged, if redone.

**Labelling, and the design problem it solves**: the ticket asks for "tool name," but
`commit()`/`beginTransaction()` are called from ~20 sites across `store.ts` and three UI
files with no operation-name argument at all — threading a bespoke label through each
would be the same invasive refactor rejected for the same reason elsewhere in this file.
Instead, `core/tools.ts` gained a plain `activeToolId` signal that `useActiveTool` (called
by `ActionBar`/`Canvas`/`OptionsPanel` on every render, so always in sync) keeps mirroring
the router's own idea of the current tool — something `history.ts`, a plain module with no
hook access, cannot read any other way. `push()` reads `findTool(activeToolId.value)?.title`
at the moment it fires, which is also what makes `beginTransaction`'s own coalescing key
(`crop-${page.key}`, `move-annotation`) the wrong thing to show the user: it exists purely
to detect "is this the same open transaction," not to be read.

**"Affected pages" is not implemented.** `Snapshot` records whole-document *state before*
a mutation, not a diff — at `push()` time the mutation hasn't happened yet, so there is
nothing to compare against. Computing which pages changed would need a second hook
*after* every mutation at the same ~20 call sites the label threading above was
deliberately designed to avoid touching. Disclosed rather than guessed at or silently
dropped from the requirements list.

Evidence: `tests/unit/history.test.ts` → "DOC-10: operation log" (7 tests) — labels come
from the tool active at push time, not at read time or at undo/redo time (switching tools
between an undo and its redo does not relabel the restored entry); the generic "Edit"
fallback when no tool is active; a whole coalesced transaction produces exactly one entry,
not one per drag step; `resetHistory` clears the log; timestamps are real and
non-decreasing. Confirmed live against the running app: rotating a page under Organize and
switching to the new Edit History tool shows one "Organize" entry at the correct time, with
zero console errors, in a screenshot. Full suite (730 tests), `tsc --noEmit`, eslint, and
prettier all clean.

- **Requirements:** Record every operation applied in the current session (tool name,
  timestamp, affected pages) in memory/IndexedDB and let the user export it as a text
  or PDF log — no data leaves the device, and the log reflects only what the undo
  stack (DOC-06) actually applied.
- **AC:** A session with five known operations exports a log listing exactly those five
  entries in order; an operation that was undone before export is excluded. **Partially
  met:** page-level attribution ("affected pages") is not implemented — see writeup above.

### OPS-18 · Stamp a QR/barcode onto pages — `S` `P2`

**Status: Done** — A new "QR / barcode stamp" section in the Watermark panel
(`barcodeStampSettings` in `src/ui/tools/watermark/state.ts`), built on the exact
OPS-08/OPS-11 stamp engine: `positionOrigin`/`placeDisplayBox` for the 9-point grid,
threaded through `ComposeExtras.barcodeStamp` in `process.worker.ts` the same way
`extras.bates` already is, and plumbed through `composeDocument`/`splitDocument` and
all four of `commit.ts`'s Bates call sites (export, annotate, size-split planning,
split export) identically to Bates.

- **`src/core/barcode.ts`** (new) — `qrcode` and `jsbarcode` added as real bundled
  npm dependencies (not a network fetch of any kind; see the module's doc comment for
  why this doesn't need a zero-network exception, the same reasoning that already
  applies to `pdf-lib`/`pdf.js`/`tesseract.js`). `generateQrRaster(text)` uses
  `QRCode.create()`'s pure module matrix (no canvas) rasterised by hand into RGB
  samples and handed to the existing `encodePng` writer. `encodeCode128Bars(text)`
  calls `jsbarcode`'s undocumented-but-real "object" render target (an empty plain
  object matched by its own `getRenderProperties` on having no `nodeName`/`getContext`,
  landing on `ObjectRenderer`, which assigns the encoded bar string instead of drawing
  anywhere) — a one-line, well-isolated cast bridges the gap between that real behaviour
  and its narrower published `.d.ts`.
- **QR embeds as a raster; CODE128 draws as vector bars — and this split was found
  live, not assumed.** The first implementation rasterised both the same way. QR round
  tripped fine (Reed-Solomon error correction absorbs ordinary antialiasing), but a
  live Playwright export of a 14-character CODE128 value, rasterised with poppler's
  `pdftoppm` and decoded with `zxing-wasm` (ZXing-C++/WASM, independent of both
  encoders here), came back empty — a 1D barcode has no error correction and decodes
  by comparing *relative bar widths*, and the antialiasing between this module's raster
  and whatever DPI a viewer/printer/scanner finally renders at was enough width
  distortion to misread. Fixed by building CODE128 as a tiny one-page PDF of vector
  rectangles (`process.worker.ts`'s `barcodeForm` branch), embedded once via
  `outDoc.embedPdf()` and placed per page with `drawPage()` — geometrically exact at
  any render resolution, since only one final rasterisation ever happens (by the
  viewer/printer), not two compounding ones.
- **A second, independent live-repro found a real sizing bug the unit tests alone
  would not have caught:** even as vector content, a moderate-length CODE128 value
  (~189 modules for `"CODE128-XYZ-99"`) squeezed into a small fraction of page width
  puts well under one device pixel per module at ordinary print/scan resolutions —
  physically unscannable regardless of vector precision. Fixed with two floors in
  `process.worker.ts`: `CODE128_MIN_MODULE_WIDTH_PT` (1pt/module, inside the usual
  10-20 mil "X-dimension" scanning-quality guidance) governs width *before* the "Size"
  setting is applied — the setting can only make a stamp bigger, never smaller than
  scannable — and `CODE128_MIN_STAMP_HEIGHT_PT` (20pt) guards height the same way,
  kept even though it turned out not to be the binding constraint once the width
  floor was added (aspect ratio means the width floor already implies a height well
  above it) — cheap, honest insurance against a future change to the internal
  rendering unit that could make it the binding one again.
- **AC met — decodes back to the exact input text via an independent decoder:**
  `tests/unit/barcode.test.ts` round-trips both `generateQrRaster` and
  `encodeCode128Bars` through `zxing-wasm`, an engine neither encoder here is derived
  from. Re-verified live end-to-end after each fix: a real document exported through
  the actual UI, rasterised with `pdftoppm` (independent of this codebase entirely),
  decoded with `zxing-wasm` — QR and CODE128 both came back with the exact stamped
  text, `isValid: true`.
- **AC met — at every configured placement position:** position/scale geometry is
  verified precisely in `tests/unit/process.test.ts`'s "barcode stamp composition"
  suite by reading the drawn `cm` translate/scale operators directly off the page's
  own content stream (the same technique OPS-17's image-watermark geometry test
  already uses), not by trusting "a stamp exists somewhere" — including a dedicated
  test proving the CODE128 width floor actually binds (scale-derived width ≈30pt vs.
  a 209pt floor) rather than coincidentally landing above it, and that `drawPage`
  scales *relative to the embedded form's own BBox* (unlike `drawImage`, which scales
  relative to an implicit unit square) was read back from the real PDF rather than a
  hardcoded production constant.
- **No page-range targeting** — applies to every exported page, matching Bates'
  behaviour (and its absence of a page-range field) rather than the text/image
  watermark's independent per-stamp range, since the settings signal started with one
  and it was removed once nothing in the UI exposed it (an unreachable, unexposed
  field is worse than no field).
- 11 new unit tests across `tests/unit/barcode.test.ts` (6) and `process.test.ts`'s
  new "barcode stamp composition (OPS-18)" describe block (5); full suite (771 tests)
  green across three consecutive runs, `tsc --noEmit`, `eslint`, `prettier` all clean.
  `zxing-wasm` is a devDependency only (test-time independent verification), never
  bundled into the shipped extension.

- **Requirements:** Encode user-provided text (e.g., a document ID) as a QR or 1D
  barcode and stamp it via OPS-08/OPS-11's existing stamp engine and placement grid.
- **AC:** A stamped fixture's barcode decodes back to the exact input text when scanned
  by an independent decoder, at every configured placement position.

### SCN-04 · Decode barcodes from scanned pages — `M` `P2`

**Status: Done** — A "Barcodes" section in the Metadata panel
(`src/ui/tools/metadata/BarcodeScanSection.tsx`), matching DOC-12's Font Embedding
section's exact shape (a "Check"/"Scan" button, a live `busy` flag rather than
`useJob`'s non-reactive `isRunning()`, a findings list). `decodeBarcodesFromImage`
(`src/core/barcode.ts`) wraps `zxing-wasm`'s reader — the same independent decoder
OPS-18's own tests round-trip against — now promoted from a devDependency (test-only)
to a real bundled dependency, since this ticket uses it at runtime. Its reader build is
single-threaded (a plain `fetch()` of its own same-origin `.wasm` binary, no worker of
its own to spawn), so none of OCR-04's blob-URL-under-MV3-CSP problem specifically
applies here — but a related, equally real packaging bug did, caught the same way
OCR-04's was: by loading the actual packaged extension rather than trusting the dev
server. See below.

- **A real MV3 bug found by loading the packaged extension, not the dev server —
  `zxing-wasm` defaults to fetching its own engine `.wasm` file from the jsDelivr CDN**
  (documented behaviour of `PrepareZXingModuleOptions.overrides`, not a bug in the
  library — it assumes a bundler will override it). Against the dev server this
  succeeds silently, because the request just goes out over the real internet and
  nothing looks wrong. Loading `dist/ext` as a real unpacked extension via Playwright's
  `launchPersistentContext` with `--load-extension` — the same technique that would have
  caught OCR-04's bug immediately, and did here — showed the real failure: `wasm
  streaming compile failed`, then an `XMLHttpRequest` to
  `https://fastly.jsdelivr.net/npm/zxing-wasm@…/dist/reader/zxing_reader.wasm`, which
  MV3's CSP (`connect-src 'self' https://cdn.jsdelivr.net`) does not even allow — this
  would have failed outright in a real user's browser, for every barcode scan, forever,
  and passed every dev-server and unit test in this repo. Fixed two ways:
  1. A new `stapler:zxing-assets` Vite plugin (`vite.config.ts`) copies
     `zxing_reader.wasm` into the build's `assets/` folder — Vite's bundler never
     detects this asset on its own, because the library resolves it via its own runtime
     `fetch()`, not a static `import`/`new URL(..., import.meta.url)` Vite can trace.
  2. `barcode.ts`'s `ensureZxingLocalWasm()` overrides `locateFile` to resolve against
     `self.location` — the exact pattern `ocr.worker.ts`'s `WORKER_PATH`/`CORE_PATH`
     already established for tesseract, so the same code is correct under
     `chrome-extension://`, the website twin, and the dev server without any of them
     knowing the other's base path. Guarded on `typeof self !== 'undefined'` so the
     override is skipped in the Node test environment, where the library's own
     resolution already works correctly and needed no fixing.
  Re-verified after the fix with the same real-extension harness: stamped a QR (OPS-18)
  with a known value, exported, re-imported, scanned (SCN-04) — decoded correctly, zero
  console errors, zero requests outside the extension's own origin. `pnpm run
  check:bundle` still passes (357.93 KB gzipped initial bundle, budget 900 KB): like
  `@vladmandic/face-api`, the reader chunk is dynamically imported and never loads
  until a scan actually runs.

- **Reuses the rendering pipeline, not the cleanup pipeline:** `render.worker.ts` gained
  `decodePageBarcodes(handle, pageIndex, dpi)`, built the same way `pageToImageBytes`
  already renders a page to a bitmap (same `page.getViewport`/`page.render` call), then
  hands the pixels to `decodeBarcodesFromImage`. "Reusing SCN-01/02's rendering
  pipeline" is this shared render call — the one SCN-01/02's own cleanup preview
  renders a page through — not the deskew/threshold step, which a barcode decoder does
  not need: `zxing-wasm`'s library defaults (`tryHarder`/`tryRotate`/`tryInvert`, all on)
  already tolerate the moderate rotation and noise a real scan carries, and are tuned
  for exactly that case rather than the perfectly upright synthetic images the encoder
  half of `barcode.ts` produces.
- **`scanDocumentBarcodes`** (`src/core/operations.ts`) loads the document once and
  loops every requested page through `decodePageBarcodes`, reporting progress and
  honouring cancellation — the same shape `extractDocumentText` already has.
- **AC met — a fixture with a known barcode decodes to the exact planted value:**
  `tests/unit/barcode.test.ts`'s new `decodeBarcodesFromImage` suite plants a known QR
  and a known CODE128 value on a synthetic bitmap and asserts the decoded text matches
  exactly. Live end-to-end, chaining this ticket with OPS-18's own new stamping feature:
  a QR stamped with `SCN04-ROUNDTRIP-8891` via the Watermark panel, exported, re-opened,
  and scanned with this ticket's "Scan for barcodes" button reports
  `Page 1 — QRCode: SCN04-ROUNDTRIP-8891` — a full round trip through two tickets'
  worth of real code, not a synthetic fixture on either end.
- **AC met — a page with no barcode reports none, not a false positive:**
  `decodeBarcodesFromImage` is tested against both a blank white bitmap and a
  deliberately barcode-*shaped* decoy (evenly spaced vertical bars that are not a real,
  checksummed CODE128 pattern) — a naive "any dark stripes" heuristic would be fooled
  by the second one; a real decoder is not, and both return `[]`. `scanDocumentBarcodes`
  is tested (mocked render worker, `tests/unit/scan-document-barcodes.test.ts`) to prove
  a page with none gets an explicit `{ pageIndex, barcodes: [] }` entry — every requested
  page is actually checked, never silently skipped — and separately that cancellation is
  honoured before the next page is scanned. Live: a blank-page fixture scanned through
  the real UI shows "No barcodes found on any page." in both themes, no console errors.
- **Export as a sidecar list:** "Export N as a list" writes a tab-separated
  `barcodes.txt` (page, format, value per line) via `platform.saveFileAs`, satisfying the
  ticket's "export as a sidecar list" phrasing directly rather than only "attachable to
  search," which nothing else in this codebase currently indexes page content into.
- 7 new tests (4 in `barcode.test.ts`'s decode suite, 3 in `scan-document-barcodes.test.ts`);
  full suite (812 tests) verified green across four consecutive runs, `tsc --noEmit`,
  `eslint`, `prettier` all clean. The WASM module's cold-start under heavy parallel test
  load was observed to occasionally abort outright rather than merely run slowly; a
  `prepareZXingModule` warm-up with one retry in the test file's `beforeAll` (not in
  product code — a real browser never runs 68 competing Node worker processes at once)
  made four full-suite reruns deterministic.

- **Requirements:** Scan rendered page bitmaps for barcodes/QR codes and surface decoded
  values as extractable metadata (e.g., attachable to search or export as a sidecar
  list), reusing SCN-01/02's rendering pipeline.
- **AC:** A fixture with a known barcode on a known page decodes to the exact planted
  value; a page with no barcode reports none, not a false positive.

### DOC-11 · Crash/reload session recovery — `M` `P1`

**Status: Done** — This is not the session-persistence feature `store.ts`'s own header
warns was removed for cost: that version wrote whole documents, bytes included, to
IndexedDB on every mutation. Since that removal, `store.ts` was already refactored so
document *bytes* live in OPFS (`opfs.ts`), addressed by source id, entirely separate from
the *pointer* state (`documents`/`sources`/`activeDocId`) and the undo stack
(`history.ts`'s `Snapshot`) — neither of which has ever held a byte array. Persisting all
of it costs about what persisting one document's page list costs, because that is all it
has ever contained; OPFS bytes for a source already survive a reload on their own, so
recovery only has to restore the pointers that say which files matter and in what
arrangement.

- **`history.ts`** gained `serializeHistory()`/`restoreHistoryFromRecord()`, converting
  each snapshot's one non-JSON-safe field (`selection: Set<string>`) to and from an
  array; everything else round-trips as-is.
- **`src/core/session-recovery.ts`** (new) — `saveSession()` writes
  `documents`/`sources`/`activeDocId`/selection/crop boxes/page annotations/the
  serialized history stack to the generic `settings` IndexedDB store (F-06) under one
  key, or clears that key once `documents.value.length === 0` (an empty record is not "a
  session," and leaving one around would offer to restore nothing back to nothing).
  `restoreSession()` is the inverse, replacing the live signals wholesale.
- **Autosave is debounced (500ms) and gated behind a `sessionRecoveryChecked` signal.**
  `AppShell.tsx` runs the startup recovery check in one `useEffect` and the autosave
  watcher (`useSignalEffect` over `documents`/`sources`/`activeDocId`/`historyVersion`) in
  another; the watcher's very first line returns early until the check has resolved.
  Without that gate, the watcher's first run — on a fresh boot, before the saved record
  has even been read — would see the empty state a boot starts in and overwrite the
  record before the user was ever asked about it.
- **AC met — offers to restore the exact prior document state and undo stack:** the
  startup check calls the existing generic `confirmAction()` dialog (no new modal
  component) with the saved document count, then `restoreSession()` on accept. Live
  end-to-end via a real Playwright `page.reload()` (a genuine navigation, not an
  in-memory reset — the only way to actually prove IndexedDB survives it): opened a
  2-page fixture, rotated page 2 by 90° and selected it, waited past the debounce,
  reloaded. The dialog appeared reading "Stapler found 1 document open from before this
  tab closed"; accepting restored the same file, the same 2 pages, page 2 still rotated
  90°, and page 2 still the selected one — position, transform, and selection, not just
  "a document reopened." `tests/unit/session-recovery.test.ts` covers the same round trip
  at the unit level plus, separately, that a real mutation's undo entry survives: restore,
  then `undo()`, and the rotation reverts — proving the *stack* came back, not only the
  current state.
- **AC met — declining clears the record, not retried on the next launch:** live, a
  second reload (session still open, nothing declined yet) offered the prompt again as
  expected; clicking "Start fresh" and reloading a third time showed no prompt at all.
  Unit-tested directly (`clearSession()` empties what `loadPendingRecovery()` returns).
- Two comments this ticket makes stale were corrected rather than left to rot:
  `store.ts`'s "session persistence was removed" note now explains what DOC-11 added and
  why it is not the same mistake, and `useUnsavedGuard.ts`'s "a reload genuinely loses
  edits" note now names the real remaining gap (a declined restore, cleared storage, or
  further edits after export) instead of a claim recovery now makes false.
- 5 new unit tests; full suite (817 tests) green, `tsc --noEmit`, `eslint`, `prettier` all
  clean.
- **Fixed 2026-09-13 (1082992):** `baseline` (added to `StaplerDoc` after this record
  format already existed) could be missing entirely from a record saved by an older build;
  `restoreSession()` now backfills it from the document's own `pages` — the same
  "baseline starts as whatever's there" rule a freshly opened document gets — rather than
  handing back a document that crashes the moment anything reads `doc.baseline`.
- **Amended (2026-09-14):** `checkRecovery`'s own validation against what OPFS still holds
  only ever checked `doc.pages`, not `doc.baseline` — inconsistent with `closeDocument`'s
  own source GC (`store.ts`), which deliberately unions both before deciding a source is
  free, precisely because a baseline page can outlive the deletion of the page it came
  from. A source freed in the narrow window between a crash and the next debounced
  autosave could leave a *surviving* document's baseline pointing at bytes that no longer
  exist, passing this check because its *current* pages happened not to reference that
  source. Traced forward, that dangling reference breaks every export-review diff for the
  document (baseline compose throws) and, worse, "Discard all changes" copies it straight
  into the *live* page list with no validation at all, permanently blanking that page's
  thumbnail — a genuine "silently corrupt a document" gap. `checkRecovery` now checks the
  union of `pages` and `baseline`, the same as `closeDocument` already does.
  `tests/unit/session-recovery.test.ts` › "checkRecovery drops a document whose BASELINE
  (not current pages) points at gone bytes".

- **Requirements:** Persist enough session state to F-06's IndexedDB layer to reopen the
  editor after a crash or accidental reload and resume the in-progress document and undo
  stack, with an explicit prompt to restore or discard rather than silent resumption.
- **AC:** Killing the tab mid-edit and reopening the editor offers to restore the exact
  prior document state and undo stack; declining starts a clean session with the
  recovery record cleared, not retried on the next launch.

### DOC-12 · Font-embedding checker — `S` `P2`

**Status: Done, with "any matching locally-available system font" deliberately narrowed**
**— see below** (re-audited 2026-09-26).

**Reopened by AUDIT-2026-09-25 (PDF-2, 🔴 Critical), now closed again.** The fix below
was reported as working while it turned every run of text in the fixed font into
garbage: pdf-lib's `embedFont` writes a `Type0/Identity-H` font (2-byte CIDs) but the
content kept its 1-byte WinAnsi codes, so "Hello" was read as CIDs 0x4865… and rendered
as `.notdef`, and `/Widths` were lost. The tests below only checked that a `/FontFile*`
existed — never that the text still read the same. Now the fix writes a *simple*
`/TrueType` font with the original encoding (including an original `/Differences`),
`/FirstChar`/`/LastChar`/`/Widths` and `/FontFile2`; content streams are untouched; a
glyph with no substitute, or a non-embedded composite (Type0) font, is refused and the
original bytes kept; fonts used only inside forms with inherited `/Resources` are found
too (`tests/unit/font-embedding.test.ts` › "embedMissingFont keeps the text (PDF-2)",
which re-extracts the text from the output bytes). The paragraphs below describe the
first implementation; where they say `embedFont` / Type0, that is what PDF-2 replaced.

Original entry: `checkFontEmbedding` in `src/core/workers/process.worker.ts` walks every
page's `/Resources/Font` (reusing the existing `pageFontDictOf`/`asDict`/`asArray` helpers
`fontInfoFor` already established for RED-02's width lookups), grouping by `/BaseFont`
with any subset tag (`ABCDEF+`) stripped. A `/Type0` composite font's embedding question
and display name both live one level down in `/DescendantFonts[0]`, not on the font dict
itself — handled once in a shared `descriptorHostOf` rather than duplicated between the
checker and the fixer. A finding names exactly the pages where *that* font is not
embedded, not everywhere its name appears, since a document can legitimately carry two
font objects sharing a family name where only one is embedded.

**The "system font" half is narrower than the requirement's literal wording, disclosed
rather than silently reduced.** A real local-font-file match would need the Local Font
Access API (`window.queryLocalFonts()`) — Chromium-only, gated behind its own runtime
permission prompt, which this product has never asked for anywhere else — and even with
a real font file in hand, swapping the program behind an *existing* reference risks a
glyph-mapping mismatch between the original and the substitute that could silently change
what the text looks like, which this codebase's "never silently corrupt a document" rule
cannot allow. Separately, pdf-lib's own 14 "standard" fonts are not a real fix either: the
PDF spec assumes viewers already have them, so pdf-lib writes no `/FontFile` for them at
all — embedding `StandardFonts.Helvetica` would satisfy nothing this ticket's AC actually
asks for. The one substitution actually offered is regular-weight Arial/Helvetica,
re-embedded with the *real*, already-vendored Liberation Sans Regular font program — the
same metric-compatible substitute pdf.js's own renderer already uses for this exact case
(`pdfjs-setup.ts`) — copied into `src/core/pdf/assets/` (with its license text) and
imported with Vite's `?inline` so it is a base64 string baked into the bundle at build
time, not fetched: there is no `fetch()`/network call anywhere in this path, so no
addition to the invariant hook's OCR-only exemption was needed at all. A bold or italic
Arial reports no match rather than a wrong one, since only the regular weight is vendored
and substituting a different weight would be exactly the visual change the "never
corrupt" rule rules out.

`embedMissingFont` embeds that font once, then repoints every non-embedded occurrence's
resource-*name* entry (`/F1`, `/F2`, …) at it — content-stream operators are untouched,
since they reference the name, not the underlying object. The UI (`FontEmbeddingSection`,
composed into the existing Metadata panel) applies the fix with `repointPage` per page
inside one `beginTransaction`, not `replaceWithSource`: the latter clears annotations,
correct for a scan-cleanup pixel rewrite but wrong here, since a font fix touches no page
content a stamp could have been placed relative to.

Evidence: `tests/unit/font-embedding.test.ts` (8 tests) — the AC's own scenario (one font
embedded via real fontkit embedding of the vendored NotoSansDevanagari.ttf, one hand-built
`/BaseFont /Arial` with no `/FontDescriptor` at all) reports exactly the non-embedded one;
a subset tag is stripped before reporting; a document with no fonts reports nothing; a
bold/italic Arial variant reports no match; and — the AC's literal requirement —
`embedMissingFont`'s output, independently re-parsed with a fresh `PDFDocument.load`, has
a real `/FontFile*` present on the fixed font (drilling into `/DescendantFonts[0]` for the
fontkit-produced `/Type0` composite the same way the checker itself does), the
already-embedded font is left completely untouched, the checker reports the export clean
afterward, and a font with no safe substitute is refused with the document unwritten.
Confirmed live end to end against the running app: a real fixture with two non-embedded
fonts (a hand-built Arial and pdf-lib's own default Helvetica, both flagged) — embedding
one leaves the other still flagged and un-corrupted, the toast confirms which font was
fixed, and the document tab's dirty indicator confirms the in-session edit, all with zero
console errors. A real `vite build` (not just the dev server / vitest transform) confirms
the vendored font is inlined as base64 directly into `process.worker.js` with no separate
fetchable asset file, unlike the OCR font's own `fetch()`-loaded asset. Full suite
(752 tests), `tsc --noEmit`, eslint, and prettier all clean.

- **Requirements:** Report which fonts referenced by the document are not embedded, and
  offer to embed any matching locally-available system font, without touching text that
  already uses an embedded font.
- **AC:** A fixture with one embedded and one non-embedded font reports exactly the
  non-embedded one; embedding it (when a system match exists) is confirmed by re-parsing
  the export and finding the font's `/FontFile*` present.

### ANN-07 · Synced dual-pane compare — `M` `P2`

**Status: Done** — `src/ui/tools/side-by-side/state.ts` holds three shared signals
(`sideBySideSourceId`, `sideBySidePageIndex`, `sideBySideZoomStep`); `SideBySidePanel.tsx`
picks the second document the same way ANN-02's compare tool does
(`platform.openFiles` → `importFiles`); `SideBySideView.tsx` renders two `Pane`s reading
those same shared signals, so page and zoom are identical by construction rather than
copied across a channel — no `BroadcastChannel` is used since both panes live in the same
JS context (comment at `SideBySideView.tsx:1-20` records why one would be pointless here).
`Canvas.tsx:120-129` wires `'side-by-side'` in as its own `canvasMode: 'single'` branch,
memoising the second document's page refs on `sideBySideSource?.id`/`pageCount`
(`Canvas.tsx:58-64`) — `makePageRefs` mints a fresh key per call, so without the `useMemo`
every render would hand `Pane` a page whose identity never survives a re-render, discarding
its cached bitmap.

- **AC met — scroll sync within one frame:** `SideBySideView.tsx:162-176`'s `mirror()`
  converts the scrolled pane's position to a 0–1 fraction of its own scrollable range and
  applies that fraction to the other pane's range on the same `onScroll` event (not
  polled/debounced), guarded by a `syncing` ref against feedback loops. Verified live via
  Playwright (`scripts/verify-ann07.mjs`): scrolling pane A to its bottom
  (`scrollTop = scrollHeight`) leaves both panes' `scrollTop / (scrollHeight - clientHeight)`
  at exactly `1` after one frame.
- **AC met — zoom/page sync:** both are literally one shared signal each (`sideBySideZoomStep`,
  `sideBySidePageIndex`) read by both panes, so there is only one zoom control and one pager
  in the UI, not two to keep consistent. Verified live: zooming in moves the single zoom
  label 100%→150%, and clicking Next moves both panes from page 1 to page 2 together.
- **AC met — closing one pane leaves the other independently usable:** `SideBySidePanel.tsx`
  gained a "Close" button (`variant="ghost"`, next to the "Comparing against…" line) that
  sets `sideBySideSourceId.value = null`; this was missing from the initial implementation
  and was added specifically to satisfy this AC line, which is stronger than ANN-02/ANN-06's
  compare tools promise (neither one offers a close, only "change"). Verified live: after
  Close, pane B reverts to its pre-open "No second document" placeholder and pane A's own
  Previous/Next/zoom controls keep working, unaffected (`maxPages` falls back to
  `pagesA.length` once `pagesB` is `null`, `Canvas.tsx:61-64`).
- **No console errors** in either theme; a light/dark screenshot pair confirmed pages stay
  on `--doc-page` (white in both themes) while the rail/panel chrome inverts correctly, per
  `docs/DESIGN-ADAPTATION.md`.
- **Deliberately separate from `SinglePageView`:** `SideBySideView.tsx`'s `Pane` duplicates
  that component's render approach (`renderHandleFor`/`bitmapKey`/`thumbnailCache`) instead
  of extending it — `SinglePageView` is shared by five other tools with their own
  uncontrolled zoom state, and threading a second, externally-controlled zoom mode through
  it risked all five for the sake of this one new consumer (comment at the top of the file).

- **Requirements:** A two-pane view of two documents with scroll position and zoom kept
  in sync via `BroadcastChannel`/local state, distinct from ANN-02's single-view diff —
  no network channel involved.
- **AC:** Scrolling or zooming one pane moves the other to the matching page/offset
  within one frame; closing one pane leaves the other independently usable.

### RED-10 · Redaction pattern packs beyond US formats — `S` `P1`

**Status: Done** — Three categories added to `src/core/patterns.ts`'s `MATCHERS`, each
with a real checksum deciding acceptance rather than shape alone, the same "regex is the
cheap filter" split RED-05 already used for credit cards:

- **IBAN** — `ibanChecksumValid` implements ISO 7064 MOD 97-10 (rearrange the first 4
  characters to the end, expand letters to two-digit values, reduce mod 97, valid iff 1)
  digit-by-digit so no number ever exceeds what a JS number represents exactly, plus the
  real 15-34 character length bound. The regex itself is deliberately loose (a country/
  check prefix then one-or-more 1-4 char alnum groups) so a real IBAN's shorter final
  group — the UK's own 4-4-4-4-2 — still matches in full; an earlier draft required every
  group to be exactly 4 characters and silently truncated the UK textbook example IBAN
  before its last two digits, which then failed the checksum it should have passed. Caught
  by the fixture test, not inspection.
- **UK National Insurance number** — HMRC's structural rules only (there is no
  arithmetic check digit for a NINO, unlike the other two): specific excluded letters in
  each of the first two positions, the six reserved prefixes (BG, GB, NK, KN, TN, ZZ) via
  a negative lookahead, and a suffix restricted to A-D.
- **Passport** — a 9-character alphanumeric document number plus a check digit validated
  with the ICAO 9303 7-3-1 weighted algorithm, the same scheme printed in the
  machine-readable zone of most of the world's passports and ID cards (not a bespoke
  US/UK format, since no single passport check-digit scheme is universal).

Precedence: `uk-nino` and `passport` are ordered ahead of `iban` in `MATCHERS`, not
after — IBAN's own regex is the loosest of the three and would otherwise be tried
against, and on a checksum coincidence even claim, a NINO- or passport-shaped span first.
The reverse never happens: a real IBAN's mixed letter/digit grouping essentially never
satisfies NINO's "6 *consecutive* digits" requirement or passport's separate check digit.
The AC's explicit example — an IBAN must not also fire the credit-card matcher — holds by
the existing span-claiming mechanism: ordering IBAN ahead of `credit-card` in `MATCHERS`
means the whole IBAN span (letters included) is claimed before the credit-card matcher's
pure-digit regex ever gets to try the digit groups inside it.

Evidence: `tests/unit/patterns.test.ts` — the existing "one of each category" and
"finds nothing beyond the sensitive ones" fixtures extended with one real, checksum-valid
example of each new category (the textbook UK/DE/FR IBANs, an HMRC-format NINO, and a
locally-computed valid passport check digit) and, in the prose fixture, one deliberately
*wrong* example of each (bad IBAN check digits, a reserved NINO prefix, a wrong passport
check digit) that must produce zero matches; a dedicated test proves the IBAN-before-
credit-card precedence claim; `ibanChecksumValid` and `icaoCheckDigit` are also tested
directly against known-correct published values (including the ICAO 9303 specification's
own worked example, "L898902C" → check digit 3). 13 tests, all passing; the pre-existing
`redact-patterns.test.ts` (RED-05's PDF-level integration test) is unaffected. `tsc
--noEmit`, eslint, and prettier all clean on `patterns.ts` and its test file. No UI or
worker changes were needed — `RedactPanel.tsx` already renders one section per
`PATTERN_LABELS` entry generically, so the three new categories appear automatically.

- **Requirements:** Extend RED-05's matcher with IBAN, EU/UK national insurance/ID
  numbers, and passport number formats as additional selectable categories, each with
  its own precedence rule against the existing categories (an IBAN must not also fire
  the generic card-number matcher, etc.).
- **AC:** A fixture with one instance of each new category surfaces exactly those
  matches with zero false positives against the existing RED-05 fixture's prose and
  planted values.

### CNV-08 · PDF → Word (DOCX) — `XL` `P1`

**Status: Done, after an independent audit found five defects that are now
closed — one of them a real bug behind a false claim. Three limitations remain,
stated in the tool's own copy rather than hidden.** Carves a scoped exception
into the `PLAN.md` §1.1 non-goal — see the revision note there. Best-effort
structural conversion, not layout-perfect; ships labeled beta with a mandatory
preview per §5.5, same policy as OCR-03. The audit's findings and what was and
was not done about each are in **Audit follow-up** below; the one it did *not*
ask to be fixed (table cell formatting) is now limitation 3 rather than a
silently broken promise.

New tool `pdf-to-word` (group Convert, `Save .docx`). Three workers, sequenced by
`convertPdfToDocx` in `src/core/operations.ts`:

- **`render`** gains `extractPageBlocks`. Text runs come from
  `src/core/convert/pdf-runs.ts`, blocks from `src/core/convert/blocks.ts`.
- **`process`** contributes images through CNV-06's existing `extractImages` — the
  embedded XObject's own bytes, never re-encoded.
- **`convert`** is a new fifth worker (`src/core/workers/convert.worker.ts`,
  `maxSize: 1`) owning only the `docx` package, loaded by a dynamic `import()`
  inside `src/core/convert/docx-writer.ts`.

It takes a block model rather than PDF bytes on purpose: reading a PDF needs
pdf.js and pdf-lib, both of which already have a worker, and `index.ts`'s split is
by library so the build holds one copy of each. Passing bytes in would add a third
copy of pdf.js and a second of pdf-lib to save one Comlink hop. What it *does* take
as raw bytes is CNV-06's image archive, unopened and `handOver`-transferred rather
than cloned — unzipping a document's worth of images is exactly the >50ms
main-thread work the NFRs forbid, and this way the image bytes cross a worker
boundary once instead of being copied into the model first. That transfer is why
`buildDocx` takes the archive and its per-image report as **two top-level
parameters** rather than one `{ archive, entries }` object: see finding 1 below,
where the object version was found to transfer nothing at all.

Reuse rather than reimplementation, as the requirements ask: `text-layout.ts` was
refactored to expose `layoutLines`, so CNV-04's line grouping, paragraph-break
threshold and CNV-05's 1.25× heading promotion are now *one* implementation read by
both the Markdown export and this one (`layoutText` is a six-line consumer of it;
its 32 existing tests are unchanged and still pass). Table *grids* are built by
OCR-03's `extractTableFromPage`. The only new heuristic is the question OCR-03
never had to ask — which lines on a page belong to a table at all, since its user
hand-picks a page and gets the whole page as one grid: consecutive lines that wide
gaps (>2.5× the body type size) split into ≥2 cells, ≥2 rows deep, headings
excluded. That threshold is an order of magnitude above the ~1× a justified line's
word spaces can stretch to, which is what keeps prose out of tables — asserted
directly, not assumed.

Bold/italic come from font descriptors, as specified, and getting them needed one
non-obvious step: `getTextContent()`'s `styles` map carries only pdf.js's CSS
*fallback* family, the same string for Helvetica and Helvetica-Bold, and pdf.js
only sends the real font object to the main thread while building an **operator
list** (its `getTextContent` path never calls `TranslatedFont.send`). So
`formattedRuns` calls `getOperatorList()` per page purely to populate
`page.commonObjs` and discards the result. Two sources are then combined because
neither alone is sufficient: pdf.js's own `font.bold`/`font.italic` are set only on
the `fallbackToSystemFont` path, so they are `undefined` for every *embedded* font,
while the `/BaseFont` name is always present and carries the style by convention
("AAAAAA+Arial-BoldMT"). Where neither says anything the run is reported unstyled
rather than guessed from glyph geometry.

**The three limitations, all surfaced to the user, none silent:**

1. **Image position within a page is not reconstructed.** CNV-06 reports an
   image's *resource* order, not where the content stream draws it, so images are
   appended after their own page's text. Inventing a y-position would put an image
   in a plausible-looking but wrong place.
2. **An image PDF-format Word cannot embed is left out and reported.** JPEG 2000
   is the live case: CNV-06 hands over the `.jp2` codestream untouched, and
   re-encoding it here would mean decoding a format pdf.js itself often cannot.
   Same for JBIG2/CCITT (CNV-06's own skip reason is passed through verbatim) and
   for an `/SMask`, which is a separate PDF object neither a JPEG nor this writer
   carries across. Every one of these appends a sentence to the preview's "left
   out of the Word document" list.
3. **Bold/italic inside a table cell is dropped.** `blocks.ts` models a table as
   `{ kind: 'table'; rows: string[][] }` — plain strings, no run structure — so a
   bold figure in a cell arrives as the right word in the right cell, unbolded.
   Only paragraph and heading runs carry formatting. Added by the audit pass
   below: the panel copy previously promised bold/italic without excepting
   tables, which was a claim the output did not honour. **The formatting loss
   itself is not fixed** — carrying runs into cells means a `DocxRun[][][]` row
   model and a second `lineRuns` path through `extractTableFromPage`, which is
   real added scope. What is fixed is the claim.

The preview is the gate, not a label: `PdfToWordPanel` runs the whole conversion,
**holds the produced bytes**, and only then clears `ui/tools/commit-gate.ts`'s
block on the action bar's primary CTA — which `ActionBar` reads to disable the
button and to render the reason as visible text. Saving writes those exact bytes,
so what was reviewed and what lands on disk cannot differ; changing the "include
images" option or switching document throws the preview away and re-closes the
gate. `commit.ts`'s handler refuses again if reached anyway (a disabled button is a
courtesy; the handler's check is the guarantee). Encrypted input is refused by
`loadDocument`; XFA is refused from the raw bytes before any parse, with its own
message (`XFA_CONVERT_MESSAGE`) rather than the compose one — the failure is the
other way round here, nothing is written *into* the PDF, the problem is that a
pure XFA form's page objects usually hold only an "open this in Adobe Reader"
placeholder.

**Audit follow-up.** An independent audit confirmed the structural correctness,
the table cell values, the reading order and the gating logic against real bytes,
and raised five defects. All five are closed. Two of them were the kind this
repo's conventions exist to catch — a claim in a comment that the code did not
honour, and a guarantee whose test never executed the guarantee.

1. **The "zero-copy transfer" transferred nothing.** `operations.ts` called
   `api.buildDocx(model, { archive: handOver(bytes), entries }, job)`. Comlink
   reads its transfer list off each **top-level argument** only — `toWireValue`
   looks the value up in `transferCache` and never recurses into a plain object's
   properties (`comlink.mjs`, the final `return [{ type: 'RAW', value },
   transferCache.get(value) || []]`) — so the marker on the nested array was
   dropped and every image byte was structured-cloned, which is the exact cost
   the comment claimed to avoid. `buildDocx` now takes `(model, imageArchive,
   imageEntries, job)` with the `Uint8Array` as its own argument, matching how
   the two working `handOver` call sites in the same file
   (`flattenDocument`, `scrubMetadata`) are already shaped. The comment says what
   the code does, and says why the argument position is load-bearing.
2. **`pdf-to-word` was missing from the zero-network sweep** — and the sweep's own
   comment already says why visiting a panel is not enough. Added to the tool
   list, plus a dedicated test that runs a *real* conversion and save under the
   request monitor. This tool is the sharpest case in the build for that
   distinction: the conversion is what triggers the lazy `await import('docx')`,
   a chunk carrying jszip, pako and buffer that a rendered panel never loads.
3. **`convertPdfToDocx` had no direct coverage.** The unit test hand-rolled the
   render → build sequence, so the exported function never ran and neither of its
   refusal branches was ever executed. The test now mocks `core/workers` to lease
   the three *real* worker implementations and calls `convertPdfToDocx` itself, so
   the round-trip assertions grade the production entry point; the two refusals
   (encrypted, XFA) are asserted on the whole function, including that the writer
   was never reached.
4. **A stale preview survived a document edit.** The gate keyed on the active
   document's *id* alone. Deleting or rotating a page in another tool leaves the
   id unchanged, so pre-edit bytes stayed marked valid and Save would have
   written them — silently, which is precisely the outcome §5.5's mandatory
   preview exists to prevent. The gate now also keys on `history.ts`'s
   `historyVersion`, the counter every store mutator already bumps through
   `commit()` and that `AppShell`/`HistoryPanel` already read as *the*
   "something changed" signal, rather than a new counter that could drift from
   it. The revision is captured *before* the input bytes are read, so an edit
   made while a conversion is still running invalidates it too.
5. **The panel copy overclaimed table formatting.** Corrected, and recorded as
   limitation 3 above. The underlying formatting loss is deliberately *not*
   fixed — see that entry for what fixing it would cost.

- **Evidence** (re-run in full after the audit pass). `pnpm check` green (type,
  lint, format, 102 tokens, 30 contrast pairs × 2 themes, invariants).
  `pnpm test`: 78 files · 919 tests · 0 failures, including
  `tests/unit/pdf-to-word.test.ts` (27, up from 23) and the new
  `tests/unit/pdf-to-word-transfer.test.ts` (3), with `text-layout.test.ts` still
  32 and unchanged. `pnpm test:e2e`: 107 passed, including
  `tests/e2e/pdf-to-word.spec.ts` (3, up from 2) and `zero-network.spec.ts` (3,
  up from 2). **One flake seen and not hidden:** a second full run of the same
  tree came back 106 passed / 1 failed on
  `compress-preview.spec.ts:65` (CMP-05) — it sampled the "before" canvas before
  it had painted and got all-white pixels, so `after.pixels` and `before.pixels`
  compared equal. It is a pre-existing render-timing flake in a path CNV-08 does
  not touch, under a memory-constrained machine: the spec passes 7/7 re-run on
  its own, and passed in the first full run. Not investigated further here, and
  not attributed to this ticket — flagged so the next `QA` pass knows it exists.
  `pnpm check:bundle`: 360.65 KB gzipped initial JS against the
  900 KB budget — and the `docx` chunk (`assets/dist-*.js`, 373,408 bytes raw) is
  referenced from exactly one place in the whole build,
  `assets/convert.worker-*.js`, and only as ``import(`./dist-*.js`)``, re-checked
  by grepping the built output rather than the source. `manifest.json` still
  ships `"permissions": []` with no `host_permissions`; `docx`'s built chunk
  contains no `fetch(`, `XMLHttpRequest`, `WebSocket` or `sendBeacon` at all —
  zero occurrences of each, counted in the built chunk (it does carry URL
  *strings* in license banners and error messages — jszip, pako, buffer — which
  are text, not requests).
- **Evidence specific to the audit findings.** Each fix was checked by making it
  fail, not only by watching it pass.
  - Finding 1 is measured against real `postMessage` semantics rather than a
    stub: `pdf-to-word-transfer.test.ts` runs `convertPdfToDocx` against a real
    `Comlink.wrap`/`Comlink.expose` pair over a real `MessageChannel` (this is the
    one CNV-08 test file that does *not* `vi.mock('comlink')`) and asserts the
    source `ArrayBuffer` is **detached** — `byteLength` 0 — afterwards, which only
    a transfer does, while the 1024 bytes arrive intact on the far side. Both
    regressions were reproduced against it: re-nesting the array in an
    `{ archive, entries }` wrapper fails the test, and dropping the `handOver`
    while keeping the argument position fails it at `byteLength === 0` with the
    buffer still at 1024. A third test pins Comlink's own behaviour — the same
    array transfers as an argument and clones as a property — so the signature
    cannot be "tidied" back into a wrapper silently.
  - Finding 2's new test asserts more than the absence of requests, which on its
    own a broken test also satisfies: it records *every* request and asserts that
    JS chunks — the convert worker among them, by name — were fetched between the
    preview click and the outline appearing. A conversion that silently stopped
    running would fail rather than pass by observing nothing.
  - Finding 4's e2e test was run against a deliberately reverted, id-only gate
    and **failed** exactly as the audit described: after deleting a page in
    Organize, `Save .docx` remained `enabled` over the pre-edit bytes
    (`expect(locator).toBeDisabled() failed … unexpected value "enabled"`). With
    the fix it passes, and the unit test covers the same path plus undo and the
    missing-revision case.
- **Not verifiable here, and not claimed:** that the output opens in Microsoft Word
  or LibreOffice. Neither is installed in this environment. What is proved instead
  is structural and comes from the produced bytes two independent ways — `mammoth`
  re-parses the file and yields `<h1>`/`<h2>`, `<strong>`/`<em>`, one real
  `<table>` whose 4×3 cell grid equals the fixture's, an `<img>`, and **zero**
  warning messages; and `fflate` unzips the OPC package to confirm
  `[Content_Types].xml`, `word/document.xml`, `_rels/.rels`, exactly one
  `word/media/` part carrying a real PNG signature, and a relationship in
  `word/_rels/document.xml.rels` pointing at it. Add "opens in Word 365 and
  LibreOffice Writer with no repair prompt" to the `QA-05` manual checklist.

**Second review pass** (a general code-review sweep, independent of the audit
above) found three more defects, all fixed:

- **DOCX title race.** `convertPdfToDocx` used to read `activeDoc.value?.name`
  live, partway through its own multi-await sequence (page-render loop, then
  optional image extraction, then the worker build) — so switching the active
  tab mid-conversion could title the output after a *different* document than
  the one whose bytes it actually converted. Cosmetic only: the save gate
  already keys off the source document's id and revision independently, so the
  wrong tab can neither read nor overwrite the wrong file, only the internal
  `docProps/core.xml` title could end up mismatched. Fixed by adding
  `documentName` to `PdfToDocxOptions` and having the caller
  (`PdfToWordPanel.tsx`) pass the document name it already captured at click
  time, alongside `bytes`, instead of the function reading a live signal.
  Regression tests: "titles the .docx from the documentName option, not from
  whatever document happens to be active" and the generic-title fallback case,
  both asserting `docProps/core.xml`'s `<dc:title>` directly.
- **`CLAUDE.md` / `PLAN.md` drift.** `CLAUDE.md`'s working-style section still
  named "PDF→Word, Office→PDF" as `PLAN.md` §1.1 non-goal examples after this
  ticket's revision note removed that blanket restriction — the two governing
  docs contradicted each other. Reworded to name the fidelity non-goal that
  actually survives (pixel-perfect PDF↔Office layout) and to point at
  CNV-08..13 as the in-scope carve-out.
- **Quadratic table-clustering on adversarial pages.** In `blocks.ts`'s
  `pageBlocks`, a long run of lines that each look tabular by the cheap
  per-line gap check but never actually agree on a consistent column grid
  (e.g. an inconsistently-aligned two-column layout) used to be re-clustered
  once per line in the run — each rejection advanced the scan by only one
  line before re-scanning nearly the same range again, instead of skipping
  the whole rejected run. Fixed with a `rejectedTableEnd` guard so a range
  already scanned and rejected is never re-attempted. Existing table/paragraph
  tests (accepted grids, single wide-gapped lines, heading exclusion) all
  still pass unchanged; no dedicated adversarial-input timing test was added
  for this one, since reliably constructing an input that clears the per-line
  gap heuristic but fails OCR-03's alignment-tolerant clustering (without
  either being flaky or over-fitting to the clustering internals) was judged
  not worth the added test-suite complexity for a fix this mechanical — the
  existing coverage plus code inspection is the evidence here, not a new test.

- **Requirements:** Extract page text via the render worker's existing reading-order
  layout (CNV-04's `layoutText`) plus basic run formatting (bold/italic from font
  descriptors) and embedded images, and build a real `.docx` with the `docx` package
  (lazy-loaded, never in the initial bundle). Paragraphs, headings (by font-size
  heuristic, reusing CNV-05's promotion logic), simple tables, and images are
  preserved as structure; exact fonts, columns, and pagination are not guaranteed.
  Unsupported input (encrypted, XFA) is detected and refused with a clear message,
  never half-converted.
- **AC:** A multi-page fixture with headings, paragraphs, a table, and an image
  produces a `.docx` that opens in Word/LibreOffice with all text present in reading
  order, the table intact as a real table, and the image embedded — verified by
  re-parsing the output with `mammoth` in a round-trip test, not by visual inspection.
  Beta label and mandatory preview appear before the save action is enabled.

### CNV-09 · Word (DOCX) → PDF — `L` `P1`

**Status: Done, after a second review pass (below) that fixed one silent text
loss and corrected two claims this entry made about its own evidence. Both
acceptance criteria met against real output bytes. Eight limitations, every one
of them stated in the tool's own panel copy *and* in this entry; three deliberate
deviations from the brief, all disclosed below.** Ships labeled beta with a
mandatory preview per §5.5, same policy as CNV-08 and OCR-03.

New tool `word-to-pdf` (group Convert, `Save PDF`, `worksWithoutDocument`). Its
input is a `.docx` picked from disk, not the open document — requiring an
unrelated PDF to be open first, just to convert a Word file, would be nonsense.
Two workers, sequenced by `convertDocxToPdf` in `src/core/operations.ts`:

- **`convert`** gains `docxToBlocks`. `src/core/convert/docx-reader.ts` owns the
  `mammoth` call behind a dynamic `import()`, exactly as `docx-writer.ts` owns
  `docx`; `src/core/convert/html-to-pdf-blocks.ts` turns its HTML into the block
  model.
- **`process`** gains `layoutBlocksToPdf`, which draws the model onto pages via
  `src/core/convert/pdf-block-layout.ts`.

**Why two workers rather than one.** The brief asked for a method on the
`convert` worker rather than a sixth worker, and that is what this is — but the
*drawing* stays in `process`, because `index.ts` splits workers by **library** so
the build holds one copy of each, and pdf-lib already lives there. Putting the
layout engine in `convert` would have added a second copy of pdf-lib to save one
Comlink hop. The block model crosses that hop with its image bytes
**transferred**, not cloned: `blocks` is argument 0 of `layoutBlocksToPdf` for
precisely the reason CNV-08's audit finding 1 established — Comlink reads a
transfer marker off top-level arguments only.

**Reuse rather than reimplementation.** `StyledRun` extends CNV-08's `DocxRun`,
so the two block models are one vocabulary rather than two. The layout engine
extends `markdown-to-pdf.ts`'s approach as the requirements ask and imports its
`sanitizeWinAnsiText` / `hadUnsupportedCharacter` pair and its
`addLinkAnnotation` (newly exported for this) rather than copying them, so the
Markdown and Word exports cannot disagree about which characters a standard font
can draw or about how a `/Link` annotation is built. What is new is what Markdown
never needed: wrapping *across* styled runs, real raster images, and tables whose
cells are runs.

**One thing this direction does better than CNV-08.** Table cells carry runs
(`StyledRun[][][]`), not plain strings, so bold and italic survive *into* a cell
— the exact loss CNV-08 records as its limitation 3. Proved twice over, both
times against the `WORD_TO_PDF` fixture itself: the production read path
(`readDocxAsHtml` → `parseHtmlBlocks`) marks that fixture's header row bold and
its three body rows not, and the **content stream of the produced PDF** shows
`Region`/`Revenue`/`Change` drawn with `/Helvetica-Bold` while every body row is
drawn with `/Helvetica`. The second one is the load-bearing assertion: font
*embedding* alone proves nothing here, because the fixture's headings and italic
run embed those faces whatever the table does — see the second review pass below,
where that is demonstrated rather than argued.

**The eight limitations, none silent, all in the panel's own copy:**

1. **Word's pagination, fonts, columns, headers/footers and footnotes are not
   reproduced.** `mammoth` discards the section geometry, so there is nothing to
   reproduce them *from*. Page size is therefore an explicit option (A4 or US
   Letter, 1" margins — Word's own default) rather than a guess, and the panel
   says outright that this is a structural conversion.
2. **Text is drawn in Helvetica, via the WinAnsi standard fonts.** A character
   outside WinAnsi (CJK, Cyrillic, most Arabic/Hebrew) is replaced with `?` and
   the panel raises a non-dismissing warning saying so — the same honest
   degradation CNV-05's Markdown export makes, and the same reason: embedding a
   Unicode font is a separate piece of work with its own bundle cost.
3. **Only PNG and JPEG images are embedded.** Word stores pasted vector art as
   EMF/WMF, which `mammoth` hands over as a data URI no PDF can embed and this
   build carries no decoder for. Each one appends a sentence to the preview's
   "left out of the PDF" list rather than vanishing.
4. **Underline, superscript and subscript are drawn as plain text.** pdf-lib's
   `drawText` has no underline, and faking super/subscript would be a guess at a
   baseline offset. Stated in the panel copy.
5. **A table continued onto a second page does not repeat its header row**, and a
   single row taller than a whole page is allowed to overflow rather than be
   truncated — losing a cell's text is the worse outcome of the two.
6. **An empty Word paragraph (the spacer people press Enter for) is dropped.**
   Keeping them would fill the mandatory preview with blank rows, which makes the
   preview harder to check — and checking it is the whole point.
7. **An image inside a table cell is left out.** A cell in this engine is one
   wrapped text box, and a row's height is measured from its text; placing a
   raster inside one would need the cell to become a small layout of its own.
   Each occurrence appends a sentence to the preview's "left out of the PDF"
   list. Found undisclosed by the second review pass — the behaviour was already
   surfaced at runtime, but it was in neither this list nor the panel.
8. **A list nested more than eight levels deep is flattened to eight.** Word
   offers nine levels; this engine indents eight. Every item's *text* is drawn,
   at the deepest indent available, and a note says so. Before the second review
   pass this was the one place in the converter where content really did vanish
   — see below.

**The preview is the gate, not a label**, on the same mechanism as CNV-08:
`WordToPdfPanel` runs the whole conversion, **holds the produced bytes**, and only
then clears `ui/tools/commit-gate.ts`'s block on the action bar's primary CTA.
Saving writes those exact bytes. `commit.ts`'s handler refuses again if reached
anyway — and that refusal is *executed* by a test, not merely asserted (see
below), because CNV-08's audit finding 3 was a guarantee whose test never ran it.

**How the staleness fix differs here, deliberately.** CNV-08 keys on the document
id *plus* `historyVersion`, because editing a page leaves the id unchanged. This
tool's input is not the workspace document at all, so `historyVersion` says
nothing about it and gating on it would re-close the gate on an unrelated edit.
The equivalent is an **input revision** — a counter that every change to the
chosen file or to an option bumps — checked *alongside* the `File` object's own
identity, not instead of it. It is the same shape of fix: identity alone is not
enough. Two paths need it, and only the second is caught by clearing the preview
on change: re-picking a different file that happens to have the same name, and a
conversion that **finishes after its own input changed** (the revision is
captured before the bytes are read, so a page-size change made mid-conversion
invalidates the result that lands afterwards).

**Unreadable input is refused before any conversion happens**, each with its own
message rather than a generic failure — this was the sharpest correctness risk in
the ticket, because `mammoth` reports a corrupt package by rejecting with a bare
jszip `Error` ("Can't find end of central directory : is this a zip file ?") that
an unhandled rejection would surface as nothing useful:

- **Not a ZIP at all** and **empty file** — caught from the first bytes, before
  `mammoth` is even loaded.
- **A legacy binary `.doc`, or a password-protected `.docx`** — both are OLE2
  compound files, caught by that signature, with a message naming both cases and
  what to do.
- **A valid ZIP with no `word/document.xml`** — only `mammoth` can tell, so its
  error is translated (`translateMammothError`).
- Anything unmatched is still wrapped as a refusal with the underlying text
  attached. Every one of these leaves the user's `.docx` untouched and writes
  nothing.

- **Evidence** (re-measured after the second review pass; the figures before it
  were 80 files · 958 tests and 360.94 KB). `pnpm check` green (type, lint,
  format, 102 tokens, 30 contrast pairs × 2 themes, invariants). `pnpm test`:
  **81 files · 964 tests · 0 failures**, including `tests/unit/word-to-pdf.test.ts`
  (35, up from 32), `tests/unit/word-to-pdf-commit.test.ts` (5) and the new
  `tests/unit/word-to-pdf-transfer.test.ts` (3); CNV-08's 27 + 3 + 3 are unchanged
  and still pass. `pnpm test:e2e`: **111 passed / 0 failed** in one full run (up
  from CNV-08's 107), including `tests/e2e/word-to-pdf.spec.ts` (3) and
  `zero-network.spec.ts` (4, up from 3). The `compress-preview.spec.ts` render-
  timing flake CNV-08 flagged for the next QA pass did **not** reproduce; it is
  still an open pre-existing issue, not a fixed one. `a11y-and-perf.spec.ts`'s
  "merges 10 × 5MB PDFs within 8 seconds" *did* fail twice under a loaded machine
  (once on its 70ms main-thread gap, once on a 30s upload wait) and passes on its
  own and in a clean full run — a second load-sensitive timing flake for the same
  QA pass, in a test that touches no CNV-09 code. `pnpm check:bundle`:
  **360.96 KB gzipped** initial JS against the 900 KB budget — 0.31 KB above
  CNV-08's 360.65 KB, which is the tool-registry entry and the panel wiring; the
  panel itself rides in the lazy `OptionsPanel` chunk. `manifest.json` still ships
  `"permissions": []` with no `host_permissions`.
- **One a11y regression, caught by the sweep and fixed before it shipped.** The
  panel's new limitations list was first rendered with `panelStyles.list`, which
  is a `max-height`/`overflow-y` scroll container of single-line rows: axe's
  `scrollable-region-focusable` rule failed the whole-app sweep (a scrollable
  region with nothing focusable inside is unreachable by keyboard in Safari), and
  `.listRow`'s ellipsis would have truncated every sentence to one line anyway.
  Replaced with a new `.proseList` class — wrapping, non-scrolling, token-styled
  — and `a11y-and-perf.spec.ts`'s route sweep passes again.
- **Evidence for AC 1 (the round trip).** `tests/e2e/fixtures.ts` gains
  `WORD_TO_PDF` / `wordToPdfDocx()`, built in code with the `docx` package rather
  than committed as a binary, with the same content categories as CNV-08's
  fixture plus the two a `.docx` can state and a PDF's geometry cannot: a
  bulleted list and a numbered one. The round-trip test converts it through the
  production entry point and reads the produced PDF back with **CNV-04's own
  `extractDocumentText`** — not by inspecting the model it was drawn from. Every
  source paragraph, heading, list item and the inline bold/italic sentence comes
  back, each after everything that precedes it; the four table rows each come
  back as **one extracted line in column order**, matched cell-by-cell against
  the fixture; the image is a real image XObject in the output (counted by
  re-parsing with pdf-lib, not taken from the converter's own report); and the
  requested page size really changes the output's `MediaBox`, so the option is
  not decorative.
- **Evidence for AC 2 (beta label and mandatory preview).**
  `tests/e2e/word-to-pdf.spec.ts` drives it in a real browser: the CTA starts
  disabled with a *readable* reason, a chosen file alone does not unlock it, the
  preview control is keyboard-reachable and activates with Enter, the outline
  then renders real structure (the h1, `Table, 4 rows × 3 columns`, the image,
  a bullet) and only then does the CTA enable; changing the page size re-closes
  it; and the file that finally lands on disk begins `%PDF-` and has the *second*
  preview's page size, proving what was saved is what was last reviewed.
- **Each guard was checked by making it fail, not only by watching it pass.**
  Reverting `wordToPdfPreviewIsStale` to an identity-only check (revision
  comparison removed) fails two tests, including "refuses a result that finished
  after its own input changed". Removing the staleness check from `commit.ts`'s
  handler fails "writes nothing when the preview finished after its own input
  changed" — the handler wrote the stale bytes, which is the whole reason that
  check exists. Two more were found this way during implementation rather than
  after: the HTML tokenizer originally closed the *outermost* matching element,
  which stranded every list item after a nested list outside its list; and the
  `/Title` was never set because `documentName` was not being mapped onto the
  engine's `title`. Both are now covered by the tests that caught them.
- **Zero-network evidence.** `word-to-pdf` is in `zero-network.spec.ts`'s tool
  sweep, *and* has a dedicated case that runs a real conversion and save under
  the request monitor — the sweep alone would not do, for the reason its own
  comment gives: a rendered panel loads none of `mammoth`, and the lazy
  `await import('mammoth')` is what pulls the chunk in. That case asserts JS
  chunks (the convert worker by name) really were fetched inside the watched
  window, so a test that silently stopped converting would fail rather than pass
  by observing nothing. In the built output, `mammoth`'s chunk
  (`assets/lib-*.js`, 499,317 bytes raw) is referenced from exactly one place in
  the whole build, `assets/convert.worker-*.js`, and only as
  ``import(`./lib-*.js`)`` — checked by grepping the built output, not the
  source. That chunk contains **zero** occurrences of `fetch(`,
  `XMLHttpRequest`, `WebSocket`, `sendBeacon` or `EventSource`, and no
  `require("fs")` (mammoth's package `browser` field swaps its Node `unzip.js`
  and `docx/files.js` for browser versions, and Vite honours it). It has one
  occurrence of the *string* `importScripts` — `setimmediate` reading it as a
  property to detect whether it is in a worker, not a call — and a handful of
  URL strings that are XML namespaces (`schemas.openxmlformats.org`) and library
  documentation links in error text. Text, not requests.
- **Three deliberate deviations from the brief, with reasons.**
  1. **The engine is two files, not one.** The brief named
     `html-to-pdf-blocks.ts` as "the layout engine"; it is split into
     `html-to-pdf-blocks.ts` (block model + HTML parser, no pdf-lib) and
     `pdf-block-layout.ts` (pdf-lib layout). One file importing both `mammoth`'s
     consumer side and pdf-lib would have dragged pdf-lib into the `convert`
     worker, which is the duplication `index.ts`'s library split exists to
     prevent. Both are generalized over the block model, so CNV-11/CNV-13 can
     reuse either half.
  2. **`markdown-to-pdf.ts` was not rewritten on top of the new engine.** The
     brief called that file "the base to extend", and the engine does extend its
     approach and import its helpers — but converting CNV-05's own export to run
     through it would put its link annotations, code blocks and 30-plus passing
     tests at risk for no ticket, and CNV-09 does not need it. The reuse is real
     (shared sanitiser, shared annotation builder); the migration is not attempted
     and is not claimed.
  3. **`mammoth` is called with both `arrayBuffer` and `buffer`.** Its package
     `browser` field swaps `lib/unzip.js`, and the browser and Node versions read
     *different* option keys. Passing both is what lets the shipped worker and the
     Node unit test execute the identical call, rather than the test exercising a
     path the browser never takes. The browser build ignores `buffer` entirely.
- **Not verifiable here, and not claimed:** that the output opens correctly in
  Acrobat, Preview, or Chrome's built-in viewer, and that it visually resembles
  the source document in Word. No PDF viewer and no copy of Word is installed in
  this environment. What is proved instead is structural, from the produced
  bytes, two independent ways — pdf.js re-extracts every paragraph and table cell,
  and pdf-lib re-parses the page count, page size, `/Title`, font resources and
  image XObjects. Add "CNV-09 output opens in Acrobat and Preview with no
  warning, and reads as a faithful structural copy of the source `.docx`" to the
  `QA-05` manual checklist.
- **Known gap, stated rather than papered over:** the HTML parser is a small
  hand-written tokenizer, because a dedicated worker has no `DOMParser`. It is
  scoped to what `mammoth` emits and covered by nine unit tests including
  malformed markup, but it is not a general-purpose HTML parser. Anything it does
  not recognise is *recursed into* rather than dropped, so the failure mode is
  "an unusual wrapper's text arrives as plain paragraphs", never "text
  disappears" — asserted directly by the "never loses text inside an element it
  does not recognise" test. That claim was **true of unrecognised elements and
  false of deeply nested lists** when this entry first made it; the second review
  pass found the one construct that contradicted it and fixed it (finding 1
  below).

**Second review pass** (an independent audit of this ticket, the same convention
CNV-08's entry uses). It confirmed both acceptance criteria against real output
bytes, and found one real defect, two inaccurate claims in this entry, and four
polish items. All seven are fixed:

- **Silent text loss on lists nested deeper than eight levels** — the only
  finding that was a live bug rather than a documentation problem.
  `html-to-pdf-blocks.ts`'s `listBlocks` guarded its recursion with
  `if (depth + 1 < MAX_LIST_DEPTH)` and simply returned otherwise: a 9- and a
  10-level list each produced **8 blocks and 0 notes**, with the items below
  level 8 gone from the model, gone from the preview, gone from the PDF and
  unmentioned anywhere. Word supports nine list levels, so this was reachable,
  and it contradicted both this entry's own "never text disappears" claim and
  `CLAUDE.md`'s invariant. Fixed by *flattening* rather than skipping — the
  deeper items are emitted at the deepest depth the engine indents — plus one
  `DEEP_LIST_NOTE` in the same `notes` list an unembeddable image uses, which is
  this file's established pattern for "recognised, carried across imperfectly,
  and said so". Regression test: "flattens a list nested deeper than it can
  indent, and never loses its text" asserts 9 and 10 items with the expected
  clamped depths and exactly one note, *and* re-extracts `Level 1`…`Level 10`
  from the produced PDF. Reverting the one-line guard fails it with the audit's
  exact symptom (`expected … to have a length of 9 but got 8`).
- **This entry overstated its own evidence for bold-in-table-cells.** It claimed
  the behaviour was "asserted two ways: the parsed model marks the fixture's
  header cells bold, and the produced PDF really embeds `Helvetica-Bold` and
  `Helvetica-Oblique`". Neither assertion actually proved it: the model-level
  one ran against a hand-written HTML snippet rather than the fixture, and the
  font-embedding one is satisfied by the fixture's *heading* and italic run
  whatever the table contains. Demonstrated, not argued: with `cellRuns`
  patched to strip every cell's bold, the old font-embedding test still
  **passed**. Closed by adding the coverage rather than by softening the words
  — a fixture-level model assertion (header row `bold: true`, all three body
  rows `false`, cell texts equal to `WORD_TO_PDF.table`) and, more to the point,
  one that reads the produced PDF's **content stream**, maps each `Tf` resource
  to its `/BaseFont`, and checks the face the cell strings were drawn with. Both
  fail under that same patch.
- **No transfer regression test**, where CNV-08 has one. `convertDocxToPdf` hands
  the block model over with `Comlink.transfer(read.blocks, imageBuffersOf(…))`,
  and CNV-08's audit finding 1 is the reason it is argument 0 — but nothing
  executed that. `tests/unit/word-to-pdf-transfer.test.ts` now mirrors
  `pdf-to-word-transfer.test.ts` exactly: a real `MessageChannel` with a real
  `Comlink.expose`/`wrap` pair, asserting the sending realm's image buffer is
  **detached** (`byteLength === 0`) and arrived intact on the other side.
  Dropping the `Comlink.transfer(…)` call fails it. A second case covers the
  `Set` in `imageBuffersOf`: one image reused across two blocks must not list the
  same transferable twice — with the dedup removed, `postMessage` throws
  `DataCloneError: Transfer list contains duplicate ArrayBuffer`, which would
  have failed a perfectly ordinary document.
- **Limitations were disclosed in inconsistent places.** Of the six this entry
  listed, only two were in the panel's static copy; two were runtime-only (a
  toast, a preview note) and two appeared nowhere but this ticket — so what a
  user learned depended on which surface they happened to read. All eight
  (the original six, plus images-in-table-cells and the flattened deep list) are
  now in one `LIMITATIONS` list rendered by `WordToPdfPanel` *before* the
  conversion runs, and in this entry, in the same order.
- **`mammoth`'s warnings were being counted as dropped content.**
  `convertDocxToPdf` merged `read.warnings` — mammoth's own structural remarks,
  typically "unrecognised paragraph style: X" — into the same `notes` list the
  panel renders under "Some content was left out of the PDF:" and the save toast
  counts as "N item(s) could not be converted". A style that fell back to a
  default is not missing content, so this overstated the damage. `warnings` is
  now its own field on `DocxToPdfResult`, rendered in its own clearly-labeled
  section and excluded from the toast's count. Covered by "keeps the reader's
  warnings out of the 'left out of the PDF' list".
- **Wrong error kind for a user-input condition.** `pdf-block-layout.ts` raised
  `internal()` for "this document produced no text or images to convert", which
  puts "Something went wrong inside Stapler." in front of someone whose only
  mistake was converting a document with nothing convertible in it. Now
  `corrupt()`, which is the kind `docx-reader.ts` already raises for the
  neighbouring conditions (an empty file; a `.docx` with no `word/document.xml`,
  i.e. "there is nothing to convert"), with a message naming the likely causes.
  The existing refusal test now asserts the `kind` as well as the message.
  CNV-08's `docx-writer.ts` has the same `internal()` on its mirror-image
  refusal; it is **not** changed here, because it is CNV-08's line and this pass
  did not re-open that ticket.
- **Shared module-global state, documented rather than refactored.**
  `markdown-to-pdf.ts`'s `sawUnsupportedCharacter` flag now has two callers in
  the same pooled `process` worker (CNV-05's `markdownToPdfBytes` and CNV-09's
  `layoutBlocksToPdf`). Neither is concurrently re-entrant today, so this is a
  pre-existing pattern being reused rather than new risk; a comment at the flag's
  definition now says so, and says what a third caller would have to do first.
  Deliberately not refactored in this pass.

- **Requirements:** Read `.docx` via `mammoth` (lazy-loaded) into structured HTML,
  convert to the shared block model, and lay it onto PDF pages via the new
  `html-to-pdf-blocks` engine (extends `markdown-to-pdf.ts`'s existing approach rather
  than a new one). Headings, paragraphs, lists, tables, bold/italic runs, and images
  are preserved as content; exact Word pagination/fonts are not reproduced.
- **AC:** A `.docx` fixture with the same content categories as CNV-08's fixture
  round-trips through this tool to a PDF whose extracted text (via CNV-04's own
  extraction) matches the source paragraphs and table cell values, with the beta
  label and mandatory preview shown before save.

### CNV-10 · PDF → Excel (XLSX) — `L` `P1`

**Status: Done, after a second review pass (below) that added a genuine SheetJS
round-trip test and a cancellation test, and corrected a factually wrong
justification in this entry's first draft.** Both acceptance criteria are met
against real output bytes, verified two independent ways (see "AC1 verification"
below). Six limitations, five of them measured rather than assumed; four are named
in the tool's own panel copy, one is reported at runtime in the preview's "left
out" list, and the sixth (control-character stripping, which removes no visible
content) is disclosed here only. Generalizes OCR-03's table→XLSX writer (`table-extract.ts`,
`docs/TICKETS.md:795`) — that ticket only ran on OCR'd scan output; this one runs the
same column-position-clustering heuristic over a PDF's real, selectable text layer,
covering ordinary (non-scanned) PDFs with tabular or columnar content. Ships labeled
beta with a mandatory preview per §5.5, same policy as CNV-08, CNV-09 and OCR-03.

New tool `pdf-to-excel` (group Convert, `Save .xlsx`). Two workers, sequenced by
`convertPdfToXlsx` in `src/core/operations.ts`:

- **`render`** gains `extractPageSheet`, which reduces one page to "the tables on
  it, and the lines that are not in one" (`src/core/convert/sheets.ts`).
- **`convert`** gains `buildXlsx`, which plans the sheets and zips the OOXML.

**Why two workers and not one, again.** `index.ts` splits workers by *library* so
the build holds one copy of each. Reading the PDF needs pdf.js, which already lives
in `render`; the writer needs nothing but `fflate`. Nothing is transferred *into*
either call here — page data is strings — so, unlike CNV-08's image archive and
CNV-09's block model, argument order carries no `Comlink.transfer` meaning and
**no transfer regression test was written**, deliberately: there is no transfer to
regress. The finished workbook is transferred back out.

**Three pieces of reuse, and one deliberate divergence.**

- **Table detection is CNV-08's, now shared.** `pageBlocks` had the "which lines on
  this page are part of a table at all" scan written inline — the thresholds, the
  heading exclusion, and the `rejectedTableEnd` guard CNV-08's own review pass added
  against quadratic re-scanning. That scan moved verbatim into
  `src/core/convert/table-regions.ts` and both `blocks.ts` and `sheets.ts` call it,
  so a tuning change cannot land in the Word export and not the Excel one. The move
  is behaviour-preserving; CNV-08's existing table/paragraph/heading tests are the
  regression cover and all still pass unchanged.
- **Grid clustering is still OCR-03's `extractTableFromPage`**, untouched.
- **The XLSX writer is OCR-03's, generalized and moved** to
  `src/core/convert/xlsx-writer.ts` as `buildXlsx(sheets, { title })`. It grew a
  sheet list, per-sheet content-type overrides and relationships, sheet-name
  sanitizing (Excel's 31-character cap, its six illegal characters, the reserved
  name "History") and de-duplication, an optional `docProps/core.xml`, and a strip
  of the code points XML 1.0 cannot represent at all. `exportTableToXlsx` is now a
  one-line caller of it, so there is exactly one XLSX writer in the build and an
  escaping or content-type bug can only exist in one place. **No new dependency**:
  `fflate` was already bundled.
- **The divergence:** this path keeps **lines**, where CNV-08's block model merges a
  wrapped paragraph into one block. A spreadsheet row is a line, and the AC is
  stated in lines. It also uses `textRuns` rather than `formattedRuns`, skipping the
  `getOperatorList()` call per page that resolving bold/italic from font descriptors
  costs — an XLSX cell carries no emphasis, so paying for it would buy nothing.

**Every cell is written as an inline string, never a number, date or formula.** A
PDF's text layer carries the glyphs that were drawn, not what they meant: "1,204" is
a string that looks like a number, "007" loses its zeros the moment something decides
it is one, and a date is whatever the producer's locale said it was. Excel still lets
the user convert a text cell; guessing here would silently change values.

**Four refusals, all before anything is written**, on CNV-08's pattern: encrypted
(raised by `loadDocument`), XFA (from the raw bytes, with `XFA_CONVERT_MESSAGE`), a
PDF with **no selectable text at all** (the scanned-PDF case — refused by name, with
the message pointing at the OCR tool, rather than writing a workbook with nothing in
it), and a workbook every sheet of which the user's own option excluded.

**The six limitations.** Five were *measured* against the real `pageSheet`, not
assumed. Where each one is disclosed to the user is noted on it:

1. **A multi-column page layout is read as a table.** A four-line, two-column
   newsletter layout clusters into a 4×2 grid — measured, not predicted. This is the
   heuristic's headline false positive and the reason the preview is mandatory: the
   sheet list and each table's header row are where it is visible before saving.
   *In the panel copy.*
2. **A merged header spanning two columns is separated from its table.** Measured: a
   `Financial results` banner over a Region/Revenue grid lands on the page's text
   sheet, and the grid below it becomes the table. No cell is lost; the association
   is. *In the panel copy.*
3. **A table continued across a page break becomes two sheets.** Pages are processed
   independently, and nothing in a PDF says "this grid continues". Joining them would
   need a same-column-geometry heuristic across pages that could just as easily weld
   two unrelated tables together. *In the panel copy.*
4. **Merged cells, borders, colours, column widths and formulas are not
   reconstructed.** A PDF has none of them as data — borders are drawn lines, and a
   formula's result is all that was ever printed. *In the panel copy.*
5. **A cell past Excel's 32,767-character limit is truncated**, and the count is
   reported in the "left out" list. Writing it in full produces a file Excel offers
   to repair, which is the worse outcome. *Reported at runtime, in the preview's
   "left out" list.*
6. **Control characters a PDF's text layer can carry are stripped silently.** NUL,
   BEL or a stray vertical tab in a part makes the whole workbook unparseable, which
   Excel reports as a corrupt file rather than as a bad cell. This is the one drop
   that is *not* itemised for the user, on the grounds that it removes no visible
   content.

**Two behaviours worth recording as measured-good rather than assumed**: a
right-aligned numeric column clusters correctly (OCR-03's scorer weighs right-edge
alignment as well as left), and a row with a genuinely empty middle cell keeps its
shape — the gap stays in the right column rather than shifting the row left.

**The preview is the gate, not a label**, on the same mechanism as CNV-08 and CNV-09:
`PdfToExcelPanel` runs the whole conversion, **holds the produced bytes**, and only
then clears `ui/tools/commit-gate.ts`'s block on the action bar's primary CTA. Saving
writes those exact bytes. `commit.ts`'s handler refuses again if reached anyway, and
that refusal is *executed* by a test rather than asserted. The staleness fix CNV-08's
audit had to add after the fact (finding 4) is here **from the start**: the gate keys
on `historyVersion` as well as the document id, because deleting or rotating a page
leaves the id unchanged, and the revision is captured *before* the input bytes are
read so an edit made mid-conversion invalidates the result that lands afterwards.

**AC1 verification, two independent ways.** The criterion says the workbook is
re-opened "via the `xlsx` reader" (SheetJS). `xlsx` is now a devDependency (added by
the second review pass below — it is verification tooling, not shipped: confirmed
absent from every built chunk) and `tests/unit/pdf-to-excel.test.ts` calls
`XLSX.read()` on the produced bytes directly, asserting the sheet list and each
sheet's grid against the fixture. Alongside it, the original `fflate`-based check
still runs too, not as a fallback but because it catches things a black-box reader
comparison would not: every worksheet part is parsed back into a grid **keyed by
each cell's own `r="B3"` reference** (so a cell written to the wrong column or a row
emitted out of order fails the comparison), every part is run through a strict XML
well-formedness scanner, and the package's relationship graph is followed — a
`<sheet r:id>` must resolve through `workbook.xml.rels` to a part that exists *and*
is declared in `[Content_Types].xml`. Both checks are real, non-visual, cell-by-cell
assertions, run against the same output bytes. What neither proves is that Excel or
LibreOffice Calc themselves accept the file — added to the `QA-05` manual checklist
in `RELEASE_CHECKLIST.md`. CNV-11 already plans to add `xlsx` as a dependency for its
own read side; that dependency is now in place for it to build on, as a
devDependency here and promotable to a real one there if CNV-11 needs it at runtime.

- **Evidence.** `pnpm check` green (type, lint, format, 102 tokens, 30 contrast pairs
  × 2 themes, invariants). `pnpm test`: **83 files · 1007 tests · 0 failures** (up
  from CNV-09's 81 · 964), including `tests/unit/pdf-to-excel.test.ts` (38, up from
  29 after the second review pass added the SheetJS round-trip and cancellation
  cases) and `tests/unit/pdf-to-excel-commit.test.ts` (5); `table-extract.test.ts`
  (OCR-03, now running through the shared writer) and CNV-08's `pdf-to-word.test.ts`
  (29 — corrected here; both this and CNV-09's entry had copied forward an
  already-wrong "27" from CNV-08's own writeup) are unchanged and still pass.
  `pnpm test:e2e`: **115 passed / 0 failed** in one full run (up from 111), including
  `tests/e2e/pdf-to-excel.spec.ts` (3) and `zero-network.spec.ts` (5, up from 4). A
  later full run under more machine load hit **3 failures, all load-sensitive
  timing flakes, none touching CNV-10 code**: `a11y-and-perf.spec.ts`'s 10 × 5MB
  merge (the same flake CNV-08/09 already flagged), plus two new ones this run
  surfaced for the first time — `import.spec.ts`'s full-corpus import test and its
  CNV-07 clipboard-paste test, both unrelated to Word/Excel/PowerPoint conversion.
  All three passed cleanly when re-run in isolation
  (`pnpm exec playwright test tests/e2e/import.spec.ts -g "every PDF in the
  corpus|Paste image as page"` → 2 passed). Recorded here rather than silently
  re-run until green, per this repo's "report honestly" convention — these are
  pre-existing infra flakiness under load, not something this ticket introduced or
  fixed, and QA-05's manual pass should watch for recurrence.
  `pnpm check:bundle`: **361.22 KB gzipped** initial JS against the 900 KB budget —
  0.26 KB above CNV-09's 360.96 KB, which is the tool-registry entry and the panel
  wiring, the same shape of delta CNV-09 added, and **unchanged by adding the `xlsx`
  devDependency**, which is test-only. Confirmed by grepping the *built* output
  rather than the source: `inlineStr` (the writer) appears only in
  `assets/convert.worker-*.js` and `assets/table-extract-*.js`, both lazy;
  `extractPageSheet` appears in `assets/render.worker-*.js` (the implementation) and
  in `assets/operations-*.js` (the call site) — both expected, neither in the
  initial bundle; the panel only in the lazy `assets/OptionsPanel-*.js`; `xlsx`
  appears in no built chunk at all. `manifest.json` still ships `"permissions": []`
  with no `host_permissions`, and this ticket adds no runtime dependency and no
  network call.
- **Evidence specific to the gate.** Each guard was checked by making it *fail*, not
  only by watching it pass.
  - Reverting `pdfToExcelPreviewIsStale` to an id-only check (CNV-08's original bug)
    fails two unit tests — "writes nothing when the document was edited after the
    preview ran" and "…when the conversion finished after its own input changed" —
    and fails the e2e spec with the same error CNV-08's did:
    `expect(locator).toBeDisabled() failed … unexpected value "enabled"`.
  - Reducing `commit.ts`'s handler check to `if (!preview)` — trusting the disabled
    button — fails three of the five commit tests. The handler's refusal is executed,
    not asserted.
  - The three refusals assert that the writer was **never reached**
    (`buildXlsxCalls === 0`), so a refused document cannot be half-converted.

**Second review pass** (an independent audit of this ticket, the same convention
CNV-08 and CNV-09 followed) confirmed both acceptance criteria against real output
bytes using tooling outside this repo entirely — Python's `expat` XML parser
independently re-parsed a produced workbook, and the shared `table-regions.ts`
extraction was differentially fuzz-tested (400 randomized pages against the
pre-extraction code, byte-identical output) rather than trusted from the diff. It
also found, and this pass fixed:

- **The AC1 deviation's stated reason was factually wrong.** The first draft of this
  entry claimed "this machine's `npm` refuses before it reaches a registry" as the
  reason `xlsx` could not be added even as a devDependency. That is false: `npm`
  refuses locally only because of this repo's own `devEngines.packageManager` guard
  demanding `pnpm` — nothing to do with network reachability. `pnpm add -D xlsx`
  works immediately. Fixed by actually adding it and writing the SheetJS round-trip
  test described above, rather than correcting only the wording.
- **The compensating control was never written.** This entry always intended to
  defer real-application validation to a manual `QA-05` step, the same as CNV-08 and
  CNV-09 do — but unlike theirs, the entry was never actually added to
  `RELEASE_CHECKLIST.md`. Combined with the wrong justification above, no reader
  outside this repo — not even a real one from the correct library — had ever
  opened the file. Added, mirroring CNV-08/09's existing entries there.
- **No cancellation test**, unlike CNV-09's own. The behaviour was already correct
  (confirmed independently: an abort mid-extraction stops before all pages are read
  and the writer is never reached; a pre-aborted signal does no work at all) but had
  no regression cover. `describe('CNV-10 — cancellation', …)` in
  `tests/unit/pdf-to-excel.test.ts` now formalizes both cases.
- Two minor inaccuracies in this entry's own evidence bullets, corrected above: the
  built-output grep for `extractPageSheet` had missed its call site in
  `operations-*.js`, and the CNV-08 test count ("27") had been copied forward
  already wrong from CNV-08's and CNV-09's own writeups (both actually 29).

- **Requirements:** Detect table-like regions from pdf.js text-position data across
  the whole document (not just a manually-selected single table as OCR-03 does), and
  write one sheet per detected table (or per page, for non-tabular text) via the
  generalized `xlsx-writer.ts` — no new dependency, since this reuses the existing
  hand-rolled zip+XML builder already shipping for OCR-03.
- **AC:** A fixture PDF with an unambiguous multi-column table produces an `.xlsx`
  whose cell grid matches the table's rows/columns exactly when re-opened via the
  `xlsx` reader in a round-trip test. A PDF with no detectable table still produces a
  usable sheet (one row per line of text) rather than an empty or failed export.
  Beta label and mandatory preview appear before save.

### CNV-11 · Excel (XLSX) → PDF — `M` `P1`

**Status: Done.** Both acceptance criteria are met against real output bytes. Nine
limitations, all nine named in the tool's own panel copy (the list is a `core/`
constant the panel renders, so the panel and the reader cannot state different
ones); six of them additionally report *counts* at runtime in the preview's "left
out" list. Ships labeled beta with a mandatory preview per §5.5, same policy as
CNV-08, CNV-09 and CNV-10.

New tool `excel-to-pdf` (group Convert, `Save PDF`, `worksWithoutDocument`). Two
workers, sequenced by `convertXlsxToPdf` in `src/core/operations.ts`:

- **`convert`** gains `xlsxToBlocks`, which reads the workbook into the shared
  block model (`src/core/convert/xlsx-reader.ts`, new).
- **`process`** reuses `layoutBlocksToPdf` **unchanged apart from one additive
  option** (below). CNV-09 built that engine "deliberately generalized over
  `html-to-pdf-blocks.ts`'s `LayoutBlock` rather than over anything Word-shaped,
  because CNV-11 … is planned to feed the same engine". That claim held: row
  pagination, page breaking, WinAnsi sanitising, link annotations and the
  `PdfPreviewItem` outline all worked for a spreadsheet with no change.

**The one change to the shared engine, and why it is not a hack.** The table block
gained an optional `columnWidths?: number[]` and `drawTable` honours it. Without
it the engine divides the content width equally, which is the only honest reading
of a `.docx` table (`mammoth` reports no column geometry) but is plainly wrong for
a spreadsheet, which states its widths. The widths are *relative weights*
normalised to the content width inside the engine, so page size stays the engine's
business; absent, present-but-malformed (wrong length, zero, negative, `NaN`) and
zero-total all fall back to the old equal split, which has its own test. CNV-08's
and CNV-09's existing table tests are the regression cover and pass unchanged.

**Formulas: the computed value, never the formula text.** SheetJS exposes a
formula cell's cached result in `v`/`w` and the formula itself in `f`; this reader
draws the former and never the latter. `tests/unit/excel-to-pdf.test.ts` asserts
both halves against the extracted PDF text — `2,191.50` and `11.1%` present,
`SUM(B2:B3)`, `SUM(D2:D3)` and `=SUM` absent. A formula cell with **no** cached
result (a file written by a tool that stores formulas without values, or saved
before recalculation) is blank and *counted* in the "left out" list; nothing is
calculated here.

**Number and date formatting is preserved by asking for the string Excel
displayed.** The read passes `cellNF` + `cellText` + `cellDates`, so each cell
carries `w` — SheetJS's own rendering of the value against its number format — and
that is what gets drawn. `1204.5` under `#,##0.00` reaches the PDF as `1,204.50`,
`0.081` under `0.0%` as `8.1%`, a date under `yyyy-mm-dd` as `2026-01-15`. The
test asserts the formatted forms are present **and the raw ones are not**, which
is the assertion that fails if the reader ever falls back to `v`.

**Hidden content is excluded, by name and by count.** Hidden sheets (from the
workbook-level `Hidden` flag), hidden rows and hidden columns (from `!rows`/`!cols`,
which is why the read passes `cellStyles`) are left out, matching what Excel itself
prints. Each exclusion is disclosed — sheets by name, rows and columns by count —
and the round-trip test asserts that six strings living only behind hidden
sheets/rows/columns appear **nowhere** in the produced PDF. Publishing what Excel
was hiding would be the worse failure of the two.

**Six refusals, all before anything is drawn**, on CNV-09's pattern: an empty
file, an OLE2 file (legacy `.xls` **or** a password-protected `.xlsx` — OOXML
encryption wraps the ZIP in an OLE container), a file that is not a ZIP at all, a
ZIP that holds no workbook part, a workbook with no sheets, and a workbook every
sheet of which is hidden. Each asserts the layout engine was **never reached**, so
a refused file cannot be half-converted.

**The refusal that is doing the most work here.** `XLSX.read` is markedly more
permissive than `mammoth.convertToHtml`: handed twelve bytes of binary garbage it
does **not throw** — it sniffs the buffer as delimiter-separated text and returns
a one-sheet workbook whose cells hold the control characters it found. A CSV
renamed `.xlsx` is read the same way. Converting either would hand the user a PDF
of nonsense presented as their spreadsheet. So `xlsx-reader.ts` decides what an
`.xlsx` is (a ZIP, by magic bytes) *before* SheetJS gets to guess, and the test
asserts SheetJS's permissiveness first (so the test cannot silently stop being
about anything) and then the refusal.

**Caps, because Excel's limits are not document-shaped.** A sheet may legally hold
1,048,576 × 16,384 cells. This engine draws at most 50 sheets, 1,000 rows and 32
columns per sheet, and 500 characters per cell. Each cap reports exactly what it
left out and by how much — the shape CNV-09's audit had to retrofit after its list
recursion was found deleting items below the indent limit with nothing anywhere to
say so. A declared `!ref` larger than the cells that exist (a generator writing
`A1:B1048576` for a one-cell sheet) is ignored in favour of the real extent read
from the cell keys, which has its own timing-bounded test.

**Wide sheets are continued, not truncated.** Columns are grouped into bands that
each fit a printable width (at most 12, or fewer if the approximated widths do not
fit), and each band becomes its own grid under a `Columns A-H (1 of 3)` label
drawn into the document itself. This mirrors Excel's own print behaviour and means
**no column is ever dropped for want of page width** — the 20-column fixture sheet
is asserted to have every header and every value in the produced PDF.

**Empty sheets still get a section, and a *damaged* sheet says so instead.** A
sheet with no cells, or one whose every row with content is hidden, produces its
heading plus a paragraph saying so. Otherwise "one section per sheet" would
quietly be false for exactly the sheet a user is most likely to wonder about. A
sheet whose worksheet part exists but did not parse gets a **different**
paragraph — `XLSX_SHEET_UNREADABLE_TEXT`, plus a note in the "left out" list —
because calling that one empty is a false claim about the user's document, which
is what the second review pass found and fixed (finding 1 below). "Empty" is now
proved from the ZIP's own bytes and never inferred from SheetJS returning
nothing.

**`xlsx` promoted from devDependency to a real runtime dependency.** CNV-10 added
it test-only, for verification; this is the ticket that needs it at runtime, the
same lifecycle `mammoth` went through (test-only in CNV-08, promoted in CNV-09).
It is loaded through a dynamic `import()` inside `xlsx-reader.ts` only — never a
static top-level import — so it lands in its own lazy chunk. **Verified in the
built output, not from the source:** `assets/xlsx-*.js` is 331 KB, is referenced
from exactly one place in the whole build (`assets/convert.worker-*.js`) and only
as `import(...)`, and appears in none of the 11 initial chunks. Scanned for
network reachability too: 0 occurrences of `fetch(`, `XMLHttpRequest` or
`WebSocket`, and its only `http://` literals are OOXML/Dublin-Core XML namespace
URIs, which are identifiers and are never dereferenced.

**The ten limitations**, all in the panel copy before the conversion runs:
computed values only and no recalculation; hidden sheets/rows/columns excluded;
cell fonts, colours, fills, borders and alignment not reproduced; merged cells
drawn as the grid beneath them (the value survives in the first cell, the merge
does not); charts, images, pivot tables, shapes, comments and conditional
formatting not carried across at all; column widths approximated then scaled, with
wide sheets continued as further bands; Helvetica only, so non-Latin-1 characters
become `?` and the conversion says so when it happens; the sheet/row/column caps;
the 500-character per-cell cap (added by the second review pass — it was reported
at runtime but missing from the static list, which is half a disclosure); and a
grid split across pages not repeating its header row (inherited from CNV-09's
engine and stated rather than half-implemented).

**The preview is the gate, not a label**, on the same mechanism as its three
siblings: `ExcelToPdfPanel` runs the whole conversion, **holds the produced
bytes**, and only then clears `ui/tools/commit-gate.ts`'s block on the action bar's
primary CTA. Saving writes those exact bytes. Because the input is a picked file
rather than the open document, staleness keys on CNV-09's *input revision* (a
counter every file or option change bumps) alongside the `File` object's identity
— `historyVersion` would say nothing here and would re-close the gate on an
unrelated edit. The revision is captured **before** the input bytes are read, so a
change made mid-conversion invalidates the result that lands afterwards. Built in
from the start, not retrofitted.

- **Evidence.** `pnpm check` green — run step by step (`tsc --noEmit`, `eslint .`,
  `prettier --check .`, 102 tokens, 30 contrast pairs × 2 themes, invariants),
  because this machine has only `npm` and the repo's `devEngines.packageManager`
  guard makes `npm-run-all`'s inner `npm run` calls fail before they start; each
  underlying step was run directly and all six pass. `pnpm test`: **85 files ·
  1050 tests · 0 failures** (up from CNV-10's 83 · 1007), including
  `tests/unit/excel-to-pdf.test.ts` (37) and `tests/unit/excel-to-pdf-commit.test.ts`
  (6). No existing test changed. `pnpm test:e2e`: **119 tests, 117 passed / 2
  failed** in one full run (up from 115), the new ones being
  `tests/e2e/excel-to-pdf.spec.ts` (3) and `zero-network.spec.ts`'s sixth case. Both
  failures are load-sensitive timing flakes untouched by this ticket:
  `a11y-and-perf.spec.ts`'s 10 × 5MB merge (the flake CNV-08/09/10 already flagged
  — and confirmed pre-existing here by stashing this ticket's entire diff and
  re-running it on a clean tree, where it fails *worse*: 100 ms max main-thread gap
  against the 70 ms assertion, versus 83 ms with the changes applied), and
  `compress-preview.spec.ts`'s CMP-05 latency assertion, which passes in isolation
  at 356 ms against its 400 ms budget. CNV-10's two other known flakes
  (`import.spec.ts`'s full-corpus import and its CNV-07 clipboard paste) did not
  reproduce. All four new e2e tests pass in isolation. `pnpm check:bundle`:
  **361.42 KB gzipped** initial JS against the 900 KB budget — 0.20 KB above
  CNV-10's 361.22 KB, which is the tool-registry entry, the `Sheet` icon and the
  panel wiring, and **unchanged by `xlsx` becoming a runtime dependency** because
  it is a lazy chunk (see the built-output verification above). `manifest.json`
  still ships `"permissions": []` with no `host_permissions`; this ticket adds no
  network call anywhere, and the `excel-to-pdf` conversion now runs end to end
  under `zero-network.spec.ts`'s monitor — pick the file, convert, save — with the
  assertion that lazy chunks really were fetched inside the watched window, so a
  test that stopped converting cannot pass by observing nothing.
- **Evidence specific to the gate.** Both guards were checked by making them
  *fail*, not only by watching them pass.
  - Weakening `commit.ts`'s handler check from
    `!preview || !source || excelToPdfPreviewIsStale()` to `if (!preview)` —
    trusting the disabled button — fails two of the six commit tests ("writes
    nothing when the preview finished after its own input changed" and "…when a
    preview is held with no revision recorded at all"). Removing the check
    altogether fails all five refusal cases. The handler's refusal is executed,
    not asserted.
  - The e2e spec drives the whole gating cycle in a real browser: disabled with no
    file → file chosen, still disabled → previewed via **keyboard only** (focus +
    Enter), enabled → page size changed, disabled again → previewed again, enabled
    → saved, and the file on disk is re-parsed with pdf-lib and asserted to be US
    Letter, i.e. the *second* preview's bytes rather than the first's. A second
    spec proves a re-pick of the same file re-closes the gate (a new `File`, same
    bytes) and that converting again re-opens it.
  - Dark theme and token compliance are asserted behaviourally: the panel's own
    computed text colour must change when the theme flips, which a hard-coded
    literal would not do.
- **Deliberate deviations, disclosed.**
  1. **Hidden rows and columns are excluded, not drawn.** The ticket does not say;
     Excel does not print them, and a converter that published hidden content would
     be the more surprising of the two. Excluded *and* counted in the preview.
  2. **Legacy `.xls` is refused even though SheetJS CE can read it.** The tool is
     "Excel (XLSX) → PDF"; claiming a format with no fixture and no test would be
     worse than the clear refusal that names what to do instead.
  3. **An external cell hyperlink becomes a real PDF link annotation**, which the
     ticket does not ask for. It is one line on top of CNV-09's existing `href`
     support and dropping it would lose content the workbook had. In-workbook
     references (`#'Sheet2'!A1`) are dropped, because there is no second sheet in a
     PDF for them to reach.
  4. **No character formatting is read from the workbook** — not even a bold first
     row. SheetJS CE's style reporting is partial and undocumented, and guessing
     that row 1 is a header would be a guess presented as fact. Stated as a
     limitation instead.
  5. **The caps (50/1,000/32/500) are chosen, not derived.** They are the point at
     which the output stops being a document; each is a named export with its own
     note and its own test, so raising one is a one-line change with visible
     consequences.
- **Not verifiable here:** whether Acrobat, macOS Preview or Chrome's viewer render
  the result acceptably. Added to the `QA-05` manual checklist in
  `RELEASE_CHECKLIST.md` with the specific things to look at, mirroring CNV-08/09/10's
  entries.

**Second review pass** (an independent audit of this ticket, the same convention
CNV-08, CNV-09 and CNV-10 followed). It confirmed **both acceptance criteria
against real output bytes**, and found the highest-risk claim in this entry — that
displayed/formatted cell values are drawn and never raw numbers or formula source
text — held up under adversarial probing beyond what the shipped tests check. It
also found one real defect, one refusal message that misdescribed its own input,
one untested (and possibly dead) refusal, and four coverage gaps. All seven are
fixed:

- **A corrupted worksheet part was reported as an empty sheet** — the only finding
  that was a live defect, and it is the exact class the CNV-08/09/10 audits were
  all fishing for: not a crash, a **false claim about the user's document**.
  Reproduced by replacing `xl/worksheets/sheet1.xml` with non-XML content inside
  an otherwise-valid `.xlsx`. `XLSX.read` does **not** fail on that: SheetJS's
  `safe_parse_sheet` swallows a per-sheet parse error and its `parse_ws_xml`
  simply matches no `sheetData` in garbage, so the sheet arrives as a *truthy,
  key-less* `{}` — byte for byte the value a genuinely blank sheet produces. The
  reader fell into its `lastRow < 0` branch and drew "This sheet is empty." into
  the PDF for a sheet that has content and could not be read. Three signals were
  tried and rejected before the fix: `opts.WTF: true` (does not help — nothing
  *throws*, the regexes just find nothing), a per-sheet re-read with
  `{ sheets: index, WTF: true }` (same reason), and testing the parsed object for
  `!ref`/`!cols` (SheetJS's *own* writer emits a blank sheet that also parses to
  `{}`, so this would have called real blank sheets damaged). What works is
  positive evidence from the bytes: `xlsx-reader.ts` now resolves the sheet's
  worksheet part through `xl/_rels/workbook.xml.rels` (falling back to
  `sheetN.xml`, the same two-step SheetJS uses), reads just that one entry out of
  the ZIP with `fflate`, and requires it to be a **complete worksheet document**
  — a `worksheet` root element that closes — before it will say "empty".
  Everything else, including "the part is not in the package at all", is reported
  as unreadable, in the PDF *and* as a note in the panel's "left out" list, with
  a new `SheetSummary.unreadable` field so the panel and the document cannot
  disagree. `zipOpens`/`zipPart` inflate nothing they do not need and run only on
  a failure or empty-sheet path, so an ordinary conversion still opens the
  archive once. Six regression tests, including the audit's exact repro; reverting
  the one-line decision fails two of them with the audit's exact symptom
  (`expected '… Broken This sheet is empty. …' to contain 'This sheet could not be
  read…'`). Four *valid* blank-worksheet shapes — self-closed `sheetData` with no
  `dimension`, open/close `sheetData`, what Excel actually writes, and a
  namespace-prefixed root — are asserted to still be called empty, because
  over-reporting damage would be its own false claim.
- **A refusal message misdescribed its input.** A valid ZIP holding just
  `hello.txt` was told "its ZIP container could not be opened", about a ZIP that
  opened fine. The cause is that SheetJS throws the *same* `Unsupported ZIP file`
  string for a container it could not open **and** for one it opened perfectly
  that holds no `[Content_Types].xml` — so the message alone cannot tell them
  apart, and the shipped test at `excel-to-pdf.test.ts` was codifying the wrong
  answer. `translateSheetJsError` now takes the evidence of this module's own ZIP
  probe (`unzipSync` over the central directory, `filter: () => false`, inflating
  nothing) and routes a *proved-openable* archive to
  `XLSX_NOT_A_WORKBOOK_MESSAGE`. `Could not find workbook` (one step further into
  the package) and `Unsupported NUMBERS …` were unhandled and fell through to the
  generic wrapper; both now land on the same message. `Unsupported ZIP
  Compression method` deliberately still blames the container, because the probe
  inflates nothing and so never meets the method SheetJS refused. Both directions
  are tested end to end — the `hello.txt` ZIP and a real workbook cut in half —
  and the message table keeps its evidence-free behaviour for the unit case.
- **`XLSX_NO_SHEETS_MESSAGE` had no test, and the audit's doubt was whether it was
  reachable at all.** It is. SheetJS's *writer* refuses to emit a sheetless
  workbook (`XLSX.write` throws "Workbook is empty"), but its *reader* parses a
  hand-built package whose `<sheets/>` is empty perfectly happily and returns
  `SheetNames: []`. The new test assembles that package by hand, asserts SheetJS
  really does return no sheet names, and then asserts the refusal — so the branch
  is proved live rather than annotated as defensive.
- **A test comment claimed something the test did not do.** "Cancels
  mid-conversion, once the read has already started" said "the per-sheet
  checkpoint is what has to notice"; the audit found the synchronous `abort()`
  lands before checkpoint 0's continuation runs, so checkpoint 0 notices, exactly
  as in the test above it. The comment now describes what the test actually
  covers (a signal live at start-up rather than pre-aborted) and says so.
  Alongside it, the phase nothing exercised now has a test:
  `pdf-block-layout.ts` checkpoints once per block and `convertXlsxToPdf` maps
  that band onto 0.45..1, so a 20-sheet workbook aborted on the first progress
  report strictly above 0.45 aborts **inside the layout engine** — asserted by
  `layoutCalls === before + 1`, the opposite of what the two read-phase
  cancellation tests assert.
- **No Comlink transfer test.** `xlsxToBlocks(handOver(bytes), …)` has the same
  shape as the two calls CNV-08's audit found *broken* (a transfer marker on a
  nested value is silently dropped and every byte copied), and cited that finding
  in a comment without testing it. New `tests/unit/excel-to-pdf-transfer.test.ts`
  mirrors CNV-08's and CNV-09's: a real `MessageChannel` with a real
  `Comlink.expose`/`wrap` pair, nothing about Comlink mocked, proving the sending
  realm's `ArrayBuffer` is detached (`byteLength === 0`) and arrived intact on the
  far side — plus the same "a marker nested in an object is dropped" regression
  pin. Removing `handOver` fails it (`expected 1024 to be +0`).
- **The 500-character per-cell cap was disclosed only after the fact**, via
  `truncatedCellsNote`, while the sheet/row/column caps were also in the panel's
  static list. Added to `EXCEL_LIMITATIONS` (now ten items), per the standard
  CNV-09's audit set: state a limitation in the static copy *and* at runtime when
  it triggers, not one or the other.
- **An error cell could in principle have printed a bare number.** The audit
  could not trigger it with ten real-world number formats, but the mechanism is
  concrete: an error cell stores a *code* in `v` (`#DIV/0!` is 7) and relies on
  `w` for its token, and `w` is absent whenever SSF cannot parse the cell's
  format — at which point the general `String(value)` fallback would have drawn
  `7` where the spreadsheet shows `#DIV/0!`, a wrong value presented as a right
  one. `cellText` now special-cases `t === 'e'` and is symbolic always: the eight
  documented codes by name, a producer-supplied `#…` token kept as-is, and
  `#ERROR!` for anything else — deliberately not a real Excel token, because
  inventing `#N/A` for an unknown code would be as wrong as printing the number.
  The broader SSF-parse-failure fallback is left alone and disclosed rather than
  fixed: it is a very low-probability edge the audit could not reach, and
  guessing a format SheetJS could not parse would be this converter inventing a
  value.

**Deliberately deferred by the second review pass, and disclosed rather than
fixed:** every `.xlsx` in the corpus, this ticket's fixture included, is written
by **SheetJS's own writer**, so every automated check reads back a file produced
by the same library that parses it. Nothing here can catch a construct Excel
writes differently. That is a fixture-provenance gap, not something a new unit
test can close, so it is now a named `QA-05` manual step in `RELEASE_CHECKLIST.md`
listing the specific constructs to convert from a workbook saved by a real copy of
Excel — including the check that a genuinely blank sheet still reads "This sheet
is empty." and not the new damaged-sheet message.

- **Evidence, second pass.** `pnpm test`: **86 files · 1065 tests · 0 failures**
  (up from 85 · 1050), of which `tests/unit/excel-to-pdf.test.ts` is 50 (up from
  37) and `tests/unit/excel-to-pdf-transfer.test.ts` is 2 (new). One existing
  assertion changed, deliberately and called out above: the `hello.txt` ZIP
  refusal now expects `XLSX_NOT_A_WORKBOOK_MESSAGE`, because the old expectation
  was codifying finding 2. `pnpm check` green, run step by step for the same
  `devEngines.packageManager` reason as the first pass (`tsc --noEmit`,
  `eslint .`, `prettier --check .`, 102 tokens, 30 contrast pairs × 2 themes,
  invariants). `pnpm check:bundle`: **361.42 KB gzipped**, byte-identical to the
  first pass — `fflate` was already in the initial bundle (`core/png.ts`), and
  everything this pass added lives in the lazy `xlsx-reader.ts` chunk.
  `pnpm test:e2e`: **119 tests, 118 passed / 1 failed**, the failure being
  `a11y-and-perf.spec.ts`'s 10 × 5MB merge — the same load-sensitive flake
  CNV-08/09/10 and this ticket's first pass all recorded, untouched by this pass
  and passing in isolation. `compress-preview.spec.ts`'s CMP-05 latency
  assertion, the first pass's other flake, did not reproduce.

- **Requirements:** Read `.xlsx` via the `xlsx` (SheetJS CE) reader (lazy-loaded,
  read-only usage), render each sheet as a paginated grid through the shared
  `html-to-pdf-blocks` engine (one logical "table" block per sheet, split across pages
  by row count). Cell values and basic number/date formatting are preserved; column
  widths are approximated, not pixel-matched to Excel's own layout.
- **AC:** A multi-sheet fixture produces a PDF with one section per sheet, all cell
  values present and in the correct row/column order, verified by re-extracting text
  via CNV-04's extraction and comparing to the source grid. Beta label and mandatory
  preview appear before save.

### CNV-12 · PDF → PowerPoint (PPTX) — `XL` `P2`

**Status: Done, reviewed.** Both acceptance criteria are met against real output
bytes, with one half of the first explicitly **unverifiable here** (see "Not
verifiable here" below). Ships labeled beta with a mandatory preview per §5.5,
same policy as CNV-08..11. An independent audit followed; it confirmed the
`pptxgenjs` zero-network argument and found one real correctness bug (a cropped
page displaced every line and picture by the crop's origin) plus one undisclosed
gap (in-page rotated text flattened to horizontal at the wrong size). Both are
fixed, and limitations 10 and 11 now say what remains — see **"Second review
pass"** at the end of this entry.

**Read the limitations before the rest of this entry.** This is the widest
fidelity gap of the six conversion tools and the ticket says the beta copy has to
say so plainly, so the twelve limitations are a `core/` constant
(`PPTX_LIMITATIONS` in `src/core/convert/slides.ts`) that the panel renders in
full **before** the conversion runs — the panel and the converter cannot state
different ones, and `pdf-to-ppt.spec.ts` asserts three of them as *rendered
text*. In plain terms, what this tool produces is:

1. **One text box per line of the page, and nothing else.** No paragraphs, no
   bullets, no outline, no title placeholders, no grouping. A PDF states none of
   those and none is invented.
2. **No reflow.** Edit a box and it will not re-wrap with the rest of the slide,
   because nothing on the slide is connected to anything else on it. This is the
   single biggest gap between "a deck" and what this writes.
3. **No fonts.** Every box uses the deck's own theme font at the size the PDF
   used, so line widths differ from the original and a long line can overrun its
   box (`wrap: false` — see below for why that is the lesser evil).
4. **All text is black.** The PDF's text colour is not read, so white-on-dark or
   coloured type arrives as black type.
5. **No vectors at all.** Tables, columns, rules, borders, backgrounds, every
   other drawing on the page: absent. Only text and embedded raster images are
   placed. A PDF table therefore arrives as a scatter of individually positioned
   cell boxes with no grid drawn around them.
6. **An OCR'd scan's invisible text layer becomes *visible* black text over the
   page image**, because PowerPoint has no invisible text. The tool ships two
   switches for exactly this and names the case in its copy.
7. **One slide size for the whole deck** — PowerPoint allows no other. It is the
   *first page's* displayed size; every other size is scaled uniformly, centred,
   and *reported per document* in the "left out" list.
8. **JBIG2 and JPEG 2000 images cannot be embedded**, are named in the preview,
   and are left in the PDF rather than re-encoded (CMP-03's and CNV-08's rule).
9. **Image transparency is not carried across** — a masked image is opaque, and
   says so.
10. **Positioning is approximate, and the approximation is *vertical*.**
    Rewritten in the second review pass: this used to say a line "can sit a point
    or two" from where the PDF drew it, which understated a real bug — see
    "Second review pass" below. What is measured from the page is where a line
    starts and how wide it is; what is *not* stated by any PDF is how far above
    its baseline a box has to begin, so ordinary Latin text metrics are assumed
    (0.80 em ascent, 1.20 em line height — chosen, not derived). A line of Latin
    text lands within about a point of where the page drew it; a face with
    unusual metrics, or a script whose glyphs rise higher than Latin ones (CJK,
    Devanagari), can sit further off. Nothing is displaced by the page's **crop**
    — a cropped or offset-origin page is placed against the box the reader sees,
    not against raw PDF coordinates. `W n` clip paths are still not applied, so
    an image the page clips with one is placed at its unclipped size (a Form
    XObject's own `/BBox` **is** applied — see below).
11. **Text drawn at an angle is placed at that angle, but not reproduced
    exactly.** Added in the second review pass, where the previous behaviour —
    silently flattening it to horizontal at a hardcoded 12pt — was found
    undisclosed. A diagonal watermark or a sideways column header now gets its
    real angle and its real type size, both read off the run's own transform.
    What is still not reproduced: each *run* of a rotated line becomes its own
    text box rather than being joined into one, and a **mirrored** transform is
    placed upright inside the same frame rather than turned. Both are named per
    page in the preview, the way a rotated *image* already was.
12. **Links, annotations, form fields, bookmarks and page labels** are not
    carried into the deck.

New tool `pdf-to-ppt` (group Convert, `Save .pptx`, canvas `grid`). Three
workers, sequenced by `convertPdfToPptx` in `src/core/operations.ts`, on
CNV-08's shape:

- **`render`** (pdf.js) gains `extractPageSlide`, which reduces a page to "one
  positioned line of text per line" plus the geometry a slide needs. A third page
  pass rather than a re-use of `extractPageBlocks` or `extractPageSheet`, for the
  reason the latter's own comment gives about the former: the answer is a
  different shape, and deriving it from a block model would mean un-merging
  paragraphs that model deliberately merged. Line grouping is still
  `text-layout.ts`'s `layoutLines`, so a line here is the same line CNV-04's
  text export writes.
- **`process`** (pdf-lib) gains `imagePlacements`, and this is the real new
  capability of the ticket — see below.
- **`convert`** gains `buildPptx`, which plans the deck (`convert/slides.ts`,
  pure) and writes it (`convert/pptx-writer.ts`, the only module that touches
  `pptxgenjs`).

**The thing this ticket had to build that no prior one did: where a page
*draws* an image.** CNV-06's `extractImages` answers "which images does this
page hold", from the page's `/Resources /XObject` dictionary — and CNV-08's
`blocks.ts` states outright that it therefore cannot reconstruct where an image
sat, appending images after the page's text instead. That is an honest answer for
a Word document and a useless one for a slide: "one slide per page at the page's
own size" only means something if a picture lands where the page put it. So
`src/core/pdf/image-placements.ts` walks the page's **content stream** and reports
the device-space rectangle of every `Do` that paints an image. It is not new
machinery: the tokenizer, the parser, the matrix algebra and the graphics-state
stack are all RED-02's `interpreter.ts`, the same code that decides which
operators a redaction removes, and this is a second (much smaller) consumer of
them. A private `q`/`Q`/`cm` walker for the PowerPoint export would have been two
implementations that could disagree about one page.

Four things about that walk are worth stating because each is a decision:

- **Nothing is decoded.** CMP-03 resolves an image's object number by *awaiting
  pdf.js's decoded pixels* — seconds of work and tens of megabytes for a number
  the resource dictionary already states. Here the object number comes from the
  `/XObject` entry's own indirect reference, and matching to `extractImages` is by
  `(pageIndex, objectNumber)`, the one identifier both halves share.
- **Form XObjects are followed**, with the form's `/Matrix` composed in the same
  order `interpreter.ts` uses and the form's `/BBox` applied as a clip, because a
  form's content is clipped to it per spec — without that, a large image shown
  through a small window would be placed at its unclipped size, which is a visible
  lie about the page. `tests/e2e/fixtures.ts`'s `pdfToPptFormXObjectPdf()` is a
  page whose *only* image is inside a form with a non-trivial matrix **and** a
  clipping `/BBox`; the test asserts the picture comes out 60 × 100 pt at
  (100, 100) from the top, and that it is narrower than it is tall — which it
  would not be if the clip were skipped.
- **Every placement is its own picture.** CMP-03's `imagePlacements` in
  `render.worker.ts` collapses repeated draws to the largest, because it only
  wants a re-encode size; collapsing here would silently drop the second copy of a
  logo drawn in a header and again in a footer. The test asserts the same image
  object comes out at *two different sizes* on slides 1 and 4.
- **A placement that cannot be matched is reported, never guessed.** A direct
  (non-indirect) image object has no number, so it names itself in the "left out"
  list (`/Im9 … stored directly in the page`). A page whose content stream uses a
  filter chain we cannot decode is named too — "their text is still on the slide;
  their pictures were left out" — rather than reported as having no images, which
  would be a false claim about the user's document. And an image present in the
  resources but *never painted* is reported as left out with "nothing visible on
  the page is missing", because the two lists are compared rather than assumed to
  agree.

**One real defect found and fixed while building this, worth naming because it
is the class the CNV-11 audit was fishing for: a message that misdescribed its
own input.** RED-02's `parseContentStream` **throws** on the `ID` operator — an
inline image's binary payload sits directly in the operator stream, so tokenising
it yields garbage tokens that can contain byte sequences reading as `q`, `Q`,
`cm` or `Do`, which would corrupt the CTM and could emit a placement for an image
that is not on the page. Refusing is right. But the first version of
`convertPdfToPptx` collapsed every walk failure into one summary line saying "the
page's content stream uses a filter Stapler cannot decode" — which is a false
claim about a page whose only problem is an inline image, and exactly the shape
of thing that makes a user distrust every other message the tool prints. The
worker now returns `unreadable: { pageIndex, reason }[]`, carrying each page's
*own* reason (`decodeContentStreamBytes` names the filter chain,
`parseContentStream` names inline images), and `operations.ts` emits one note per
page. `tests/e2e/fixtures.ts`'s `inlineImagePdf()` is a page that draws a real
inline image alongside real text — appended as a second `/Contents` entry, which
also proves the placement pass concatenates the array rather than walking its
entries separately — and the test asserts the note *names inline images*, does
**not** mention a filter, and that the page's text still reaches its slide.

**Rotation is applied, not ignored, and it is one transform.** `/Rotate 90` and
`/Rotate 270` display a page landscape while its content is drawn upright, so
using the unrotated media box for the slide would produce a portrait slide for a
landscape page. `slides.ts` maps a box's **centre** through the rotation and sets
PowerPoint's own `rotate` on the shape, which rotates about the centre — mapping
a *corner* instead would put a rotated box a half-diagonal from where it belongs.
All four rotations are unit-tested at the page corner, where a sign error is
unmistakable, and the end-to-end test asserts `rot="5400000"` (OOXML's 60000ths
of a degree) on slide 3's heading *and* that an unrotated page's boxes carry no
rotation at all — so `rot` is written from the page rather than always.

Since the second review pass a text box's `rotate` is the page's `/Rotate`
**plus the line's own baseline angle**, so a diagonal watermark on an upright
page and an upright line on a sideways page both land at the angle the page draws
them at. It is still one transform and still mapped through the centre; the angle
is simply no longer restricted to the four quarter turns. See "Second review
pass", finding 2.

**`wrap: false` is a choice between two bad options, and it is the disclosed
one.** With wrapping on, a line measured in the PDF's font but drawn in
PowerPoint's would wrap and push its second half down onto the *next* line's box.
With it off, one PDF line stays one visual line at the position the page drew it,
and a long line may overrun its box instead. Position is what this tool promises,
so overrun is the cost — stated in limitation 3.

**Two options, and one of them exists for a single document type.**
`includeText` and `includeImages` both default on. `includeText` off is the
switch an OCR'd scan needs (limitation 6): the invisible text layer would
otherwise be visible black type over the page image, and pdf.js's
`getTextContent` does not report text rendering mode, so the invisible-text case
cannot be detected and silently skipped. Disclosing it and offering the switch is
the honest answer; guessing would not be. Pictures are added to each slide
**before** its text boxes, so text sits over images — the z-order the page itself
has, and the only order that leaves that text layer legible rather than hidden.
Both switches off is refused, not written.

**`pptxgenjs` is a genuinely new dependency, and it carries an
`XMLHttpRequest`.** This is the sharpest zero-network question any ticket in this
series has raised. `encodeSlideMediaRels` in the library's bundle resolves any
media relationship whose `data` is unset with `new XMLHttpRequest()`.

**The argument that it is unreachable rests on three facts, not on a test.**
(Corrected in the second review pass — see below; the first version of this
entry leant on a test that does not exercise the branch it claimed to rule out.)

1. `addImage` is called from **exactly one place in the whole application**, the
   loop at the bottom of `pptx-writer.ts`. Grep the source tree: there is no
   other call site.
2. That call sets `data` **unconditionally** and never sets `path`. There is no
   branch on which `data` is absent — a placement whose bytes are missing is
   refused by `planSlides` and skipped before the call.
3. The library picks the relationships it has to resolve with **one filter**,
   `rel.type !== 'online' && !rel.data && …`, and **that same filter gates every
   branch**: the browser's `XMLHttpRequest`, and the `node:fs` and `node:https`
   branches it takes instead under Node. A relationship carrying its own bytes
   is excluded before any of them is chosen.

Because the candidate list is shared across branches, a conversion that
*completes at all*, in any environment, is evidence that the list was empty: had
this writer produced an XHR-eligible relationship, Node's own branch would have
tried to read it off a filesystem and failed. `tests/unit/pdf-to-ppt.test.ts`
converts a document that embeds real images and asserts two of them arrived in
the package, so that evidence is exercised on every run.

Two further things, and it matters what each does and does not show:

- `zero-network.spec.ts` runs the whole flow (import → convert → save) in a
  **real browser** under its request monitor, with the assertion that the lazy
  chunks really were fetched inside the watched window. This is the only place
  the claim is measured in the environment it is actually about, and it is the
  layer that would catch the argument above being wrong.
- The unit suite also installs a **throwing** `XMLHttpRequest`, `fetch` and
  `WebSocket` around a real conversion. It is kept, but as a *regression
  tripwire*, not as proof: it runs under Vitest's Node environment, where
  `pptxgenjs` checks `process.versions?.node` and takes its Node branch, so the
  browser XHR call is never a candidate there and the stub going unfired proves
  nothing about it. What it would still catch is a future `addImage` that passed
  a `path` — that breaks fact 2, and the run fails loudly.

**How this surfaces in an offline audit, stated accurately.** The built chunk
`assets/pptxgen.es-*.js` holds **1** occurrence of `XMLHttpRequest` (that
branch), **0** of `fetch(` and **0** of `WebSocket`; its only `http(s)://`
literals are OOXML/Dublin-Core/W3C XML namespace URIs (identifiers, never
dereferenced) and `gitbrent.github.io` / `github.com` links inside the library's
own `throw new Error(...)` message strings. `node:fs`, `node:https` and
`image-size` are stubbed out by the package's own `browser` field.

The `verify-offline` skill's **layer 2** will hit this chunk — for those URL
literals, which is what layer 2 greps for (`http://`, `https://`, `fetch(`, the
known CDN hosts). It will **not** report the `XMLHttpRequest`: that term appears
only in the skill's layer 1, which is `src/`-only and so never reaches a
dependency's chunk. Since a reviewer may reasonably widen the layer-2 grep and
find it, the finding is written down where a release pass will meet it rather
than left to be rediscovered as an unexplained hit: `RELEASE_CHECKLIST.md`
§ "Known, analysed bundle findings", with a pointer in
`scripts/check-bundle-size.js` (the script a reviewer already runs against
`dist/`). Layer 3 — the runtime monitor, i.e. the zero-network spec above — is
the layer that actually covers it.

**One media part per distinct image, which the library does not give you.**
`pptxgenjs` performs **no deduplication at all** for the way this writer calls
it. Its only collapsing rule compares the `path` a caller passed, and this writer
never passes one — so a picture handed over as `data` always becomes a new media
part, even twice on the same slide, and every part is named
`image-<slideNum>-<n>`. That is measured rather than read off the source: the
first of the three dedup tests asserts the *library's own* behaviour (three
slides drawing one image → three parts) before asserting this pass collapses
them, so the test cannot silently stop being about anything. A logo drawn on 300
pages is therefore 300 identical parts, i.e. a 400 KB letterhead on a 300-page
document is a ~120 MB deck. This codebase's rule for a shared image (CNV-06,
CMP-03) is *encode once, not once per page*, so `pptx-writer.ts` does two things:
it base64-encodes each distinct archive entry once, and `dedupeMediaParts` then
collapses byte-identical `ppt/media/` parts in the finished package and repoints
the relationships that named the copies. It is safe because a media part is
referenced only from a `_rels` `Target` and `[Content_Types].xml` types these by
*extension*, not per part. Identity is compared **byte for byte** (grouped by
length first), never by a hash: a hash collision here would silently swap one
image for another, which is the exact class of failure this codebase refuses. When
nothing is duplicated the original bytes are returned untouched — not unzipped
and re-zipped for nothing. Three tests: the library's own behaviour is asserted
*first* (three slides → three parts) so the test cannot silently stop being about
anything, then the pass is shown to collapse them to one with all three
relationships repointed; a deck with no duplicates comes back as the identical
array; and two genuinely different images stay two parts.

**Caps, because a page is not a slide.** 400 text boxes and 1,000 characters per
box per slide, 400 image placements per page, and a Form XObject chain followed 8
deep. Each cap reports exactly what it left out and by how much, and each is a
named export with its own test — the shape CNV-09's audit had to retrofit. Past
400 boxes a deck has stopped being editable (every box is a separate object in
PowerPoint's outliner); the 1,000-character cap is for the producer that draws a
whole page on one text baseline; the placement cap is for a tiled background.
PowerPoint's own 1–56 inch slide-size limits are enforced too, and a page outside
them is scaled to fit rather than refused — an A0 poster is a legitimate PDF page.

**`pptx-reader.ts` exists because the acceptance criterion asks for a round
trip.** It is a hand-rolled zip-of-XML walker over the existing `fflate`
dependency — no new library, which is what CNV-13's own ticket text requires —
and it shares **no code with the writer**, so agreement between them is evidence
rather than the writer confirming itself. Slide order comes from
`ppt/presentation.xml`'s `<p:sldIdLst>` resolved through
`ppt/_rels/presentation.xml.rels`, **not** from sorting part names: `slide10`
sorts before `slide2`, so a filename sort silently reorders any deck of ten or
more slides and a per-slide text assertion would then be comparing the wrong
page. A 12-page test pins that. It is the mirror of CNV-11's finding about
SheetJS: a hand-rolled reader's hazard is finding *nothing* in a valid file and
reporting an empty deck as a success, so every failure is an explicit refusal —
an empty file, an OLE2 container (a legacy `.ppt` **or** a password-protected
`.pptx`), bytes that are not a ZIP, twelve bytes of binary garbage, a ZIP with no
`ppt/presentation.xml`, a `<p:sldId>` whose part is missing from the package, and
a deck listing no slides. "0 slides" is never returned as a success. It ships
**unused by the product** until CNV-13 reads a real deck with it, so it is
tree-shaken out of the build; CNV-13 is expected to consume it unchanged
(per-slide runs, per-slide media parts, per-shape geometry) and no part of
CNV-13's conversion, UI or worker method is built here.

**The preview is the gate, not a label**, on the same mechanism as its four
siblings: `PdfToPptPanel` runs the whole conversion, **holds the produced
bytes**, and only then clears `ui/tools/commit-gate.ts`'s block on the action
bar's primary CTA. Saving writes those exact bytes. Staleness keys on
`historyVersion` alongside the document id from the start rather than as a
follow-up fix — CNV-08's audit found that a doc-id-only check left a preview
valid across an edit (delete a page, rotate one, crop) because none of those
change the id. The revision is captured **before** the input bytes are read, so a
change made mid-conversion invalidates the result that lands afterwards.

- **Requirements:** One slide per PDF page: page rendered/extracted content (text
  blocks by position, embedded images) placed onto a same-size slide via `pptxgenjs`
  (lazy-loaded). Exact PDF layout is approximated as positioned text boxes and images,
  not editable rich text reflow — this is the widest fidelity gap of the six tickets
  and must say so plainly in the beta copy.
- **AC:** A multi-page fixture produces a `.pptx` with one slide per page, opens in
  PowerPoint/LibreOffice Impress, and each slide's extracted text (via a round-trip
  through `pptx-reader.ts`) matches the source page's text content. Beta label and
  mandatory preview appear before save.
- **Evidence.** `pnpm check` green — run step by step (`tsc --noEmit`,
  `eslint .`, `prettier --check .`, 102 tokens, 30 contrast pairs × 2 themes,
  invariants), because this machine has only `npm` and the repo's
  `devEngines.packageManager` guard makes `npm-run-all`'s inner `npm run` calls
  fail before they start; each underlying step was run directly and all six
  pass. `pnpm test`: **89 files · 1129 tests · 0 failures** (up from CNV-11's
  86 · 1065), the new ones being `tests/unit/pdf-to-ppt.test.ts` (54),
  `tests/unit/pdf-to-ppt-commit.test.ts` (7) and
  `tests/unit/pdf-to-ppt-transfer.test.ts` (3). No existing test changed. Three
  consecutive full runs at 22.2 s, 27.7 s and 25.9 s wall against a 22.9 s
  baseline (measured on this machine by stashing the whole diff), plus 28.1 s and
  20.8 s on the two runs after that. One earlier run did time out three unrelated
  tests (`encrypt.test.ts`, `ocr.test.ts`) at their default 5-second budget under
  parallel load; that was traced to this file rebuilding its four-page fixture
  ten times, which is now built once and its three read-only conversions cached —
  the fixture cache is documented in the test file as a correctness-of-the-suite
  measure, not a micro-optimisation, and the timeouts have not recurred in four
  subsequent full runs. No existing test's timeout was raised.
  `pnpm check:bundle`: **361.84 KB gzipped** initial JS against the 900 KB
  budget — **0.42 KB** above CNV-11's 361.42 KB (measured on this tree by
  stashing the whole diff and rebuilding), which is the tool-registry entry, the
  `Presentation` icon and the panel wiring. `pptxgenjs` itself adds **272 KB raw
  / 92.9 KB gzipped as its own lazy chunk**, and that is verified in the built
  output rather than from the source: `assets/pptxgen.es-*.js` is referenced from
  exactly one place in the whole build (`assets/convert.worker-*.js`), only as
  ``import(`./pptxgen.es-*.js`)``, with no static `from"…pptxgen…"` anywhere, and
  it is absent from the 11 initial chunks. A unit test also greps the **source
  tree** and fails on any occurrence of `pptxgenjs` that is not the dynamic
  `import()`, an erased `import type`, or a comment.
  `pnpm test:e2e`: **123 tests, 121 passed / 2 failed** in one full run (up from
  CNV-11's 119), the new ones being `tests/e2e/pdf-to-ppt.spec.ts` (3) and
  `zero-network.spec.ts`'s seventh case. Both failures are load-sensitive timing
  flakes untouched by this ticket, and both pass in isolation:
  `a11y-and-perf.spec.ts`'s 10 × 5MB merge (the flake CNV-08/09/10/11 already
  flagged — 6.3 s in isolation against its 8-second budget), and
  `tool-flows.spec.ts`'s CMP-03 CMYK case, which failed inside the shared
  `openApp` helper waiting for the app's `<header>` rather than on anything about
  CMP-03, and passes in 11.7 s alone. An earlier full run instead flaked
  `compress-preview.spec.ts`'s CMP-05 latency assertion and
  `a11y-and-perf.spec.ts`'s per-route axe sweep (41.8 s in isolation, so that is
  the sweep's own length under load and not a violation in the new panel — the
  new route *is* in that sweep, and it passes); neither reproduced on the final
  run. All four new e2e tests pass, in isolation and in the full suite.
  `manifest.json` still ships
  `"permissions": []` with no `host_permissions`, no `optional_permissions` and
  no content scripts; this ticket adds no network call anywhere.
- **Evidence for AC 1 (one slide per page, text matches the source page).**
  Graded two independent ways at once, against real output bytes. The four-page
  fixture `pdfToPptPdf()` is converted through the real `operations.convertPdfToPptx`
  (workers leased as their real implementations, Comlink stubbed), then the
  produced package is read back with `pptx-reader.ts` **and** the source PDF's
  own per-page text is read with the same `render` worker method CNV-04's text
  export uses. Slide *N*'s word sequence must equal page *N*'s word sequence, for
  all four — and the test additionally asserts the four pages hold four
  *different* texts and that page 1 holds more than twenty words, so the
  comparison cannot pass vacuously. Neither side of that comparison is a copy of
  the fixture's string constants. Beyond the criterion itself: the deck's slide
  size is asserted in real EMU (7772400 × 10058400 = 8.5 × 11 in, from page 1);
  the title box's `<a:off>` is asserted against the coordinate the fixture drew at
  (within one point); the three body lines are asserted to be three separate
  shapes (the case CNV-08's block model deliberately merges); bold and italic are
  asserted off `b="1"`/`i="1"` on the `<a:rPr>` rather than off the model; the
  picture's rectangle is asserted against the content stream's own placement, and
  the *second* placement of the same object against its own, different rectangle;
  pictures are asserted to precede text in painting order; the A4 page's scale
  **and** centring offset are computed and compared; and the preview's per-slide
  counts are compared against the shapes actually in each slide's XML.
- **Evidence for AC 2 (beta label and mandatory preview gate the save).** Proven
  by mutation, the standard every ticket in this series has met.
  - Weakening `commit.ts`'s handler check from
    `!preview || pdfToPptPreviewIsStale(doc.id)` to `if (!preview)` — trusting
    the disabled button — fails **four** of the seven commit tests (a foreign
    document's preview, an edit after the preview, a preview that finished after
    its own input changed, and a preview held with no revision at all). Verified
    by making the change, running the file, and restoring it. The handler's
    refusal is executed, not asserted.
  - The e2e spec drives the whole gating cycle in a real browser: disabled with
    the document open → previewed via **keyboard only** (focus + Enter),
    enabled → an option changed, disabled again → previewed again, enabled →
    saved, and the file on disk is unzipped and asserted to be the *second*
    preview's bytes (images were switched off for that run, so the package
    carries no `ppt/media/` part at all). A second spec deletes a page in
    Organize after a preview, confirms the gate re-closes, re-previews, and
    asserts the deck on disk has **three** slides rather than four — so the
    second preview really re-read the document.
  - The beta badge and the limitation list are asserted as *rendered text* in
    the panel, not as source constants, including three specific limitations.
  - One trap this test caught, recorded because it is easy to get wrong in both
    directions: `pptxgenjs` calls `zip.folder('ppt/media')` unconditionally, so
    the ZIP always carries a `ppt/media/` **directory entry** even for a deck
    with no images. A `names.some(n => n.startsWith('ppt/media/'))` assertion
    therefore fails on a deck that genuinely has none, and the mirror mistake
    would be an assertion that counts the directory entry as a picture. Every
    media assertion in this ticket's tests filters `!name.endsWith('/')`.
  - Dark theme and token compliance are asserted behaviourally: the panel's own
    computed text colour must change when the theme flips, which a hard-coded
    literal would not do.
- **Evidence at document scale, which is the claim that decides usability.**
  CMP-03's own `sharedImagePdf(6)` fixture — six A4 pages that all draw the same
  1600 × 1200 photo — is converted end to end and asserted to produce six
  placements, **one** media part, and a deck whose total size is within a third
  again of that single image (a ratio, so it cannot drift with the fixture's
  photo size); six copies would put it past 3x. Every slide is then asserted to
  still reference the part that survived, so the collapse repointed rather than
  dropped. Measured off-suite at twenty pages for the same fixture: 7.0 s, 20
  slides, 220 text boxes, 20 placements, **one** 4.3 MB media part, 4.4 MB deck —
  against roughly 86 MB if each placement wrote its own copy.
- **Evidence for cancellation and progress.** Built in from the start, with both
  phases covered — CNV-10's audit had to add the missing phase after the fact.
  Three tests: a signal already aborted before the call (the writer is never
  reached); an abort on the first progress report, which lands inside the
  page-reading loop (asserted: the writer was not reached, the *image passes*
  were not entered either, and progress never crossed 0.5); and an abort on the
  first report above 0.75, which lands **inside** `buildPptx`'s per-slide
  checkpoints (asserted: the writer really ran, progress really crossed the
  inter-phase gate, and the run never reported itself finished). A fourth test
  asserts progress is determinate, monotonic, within 0..1, and crosses all four
  of `convertPdfToPptx`'s own band boundaries (0.5 / 0.62 / 0.75) — which is the
  evidence that the real function ran its own sequence rather than a helper
  standing in for it.
- **Evidence for the Comlink transfer.** `tests/unit/pdf-to-ppt-transfer.test.ts`
  measures `postMessage`'s own behaviour over a real `MessageChannel` with no
  Comlink stub: the sending realm's `ArrayBuffer` must be **detached**
  (`byteLength === 0`), which only a real transfer does, while arriving intact on
  the other side. This mattered more here than for its siblings because
  `buildPptx` has more to nest than they did — alongside the archive it passes
  the per-image report, the placement list and the option flags, and putting the
  archive in that object would have been the natural shape and the wrong one.
  The file also pins Comlink's behaviour directly (a marker on a top-level
  argument transfers; the same marker on an object property is silently dropped
  and structured-cloned), so the signature cannot be tidied away without a test
  going red.
- **Deliberate deviations, disclosed.**
  1. **Text is emitted one box per *line*, not per paragraph**, and CNV-08's
     paragraph-merging heuristics are deliberately not reused. A merged paragraph
     has no single position, which is the one thing this tool is for. Line
     grouping is still shared (`layoutLines`); only the merging is not.
  2. **Table detection is not run**, even though `table-regions.ts` is right
     there and CNV-08 and CNV-10 both use it. A grid on the page is already a
     grid of positioned boxes on the slide; turning it into a PowerPoint table
     would move every cell to that table's own layout, which is the opposite of
     what this tool promises. Stated as limitation 5 instead.
  3. **Slide size is the *first* page's, not the most common one.** The first
     page is the one a user comparing the deck's dimensions will look at, and
     "most common" would silently letterbox page 1 of a document whose cover is a
     different size from its body.
  4. **Notes are aggregated where a per-page line would bury them.** An image
     present in a page's resources but never painted by it is counted once for
     the document, not reported once per page — an unused entry inherited by all
     300 pages of a document would otherwise produce 300 identical lines. The
     same is true of the mixed-size, dropped-line and shortened-box counts. A
     *refusal* (a JBIG2 image, an unmatched object, an unreadable content stream)
     is still reported per page with its own reason, because that is a specific
     thing missing from a specific slide. Both halves have their own test.
  5. **`dedupeMediaParts` re-zips the package.** The ticket does not ask for it;
     without it a shared image is duplicated once per slide, which breaks this
     codebase's own encode-once rule at the file level and makes a long document
     unusable. It is a no-op (original bytes returned) when there is nothing to
     collapse.
  6. **The caps (400 boxes / 1,000 chars / 400 placements / 8 form levels) and
     the text metrics (0.80 em ascent, 1.20 em line height) are chosen, not
     derived.** Each is a named export with its own note and its own test, so
     changing one is a one-line change with visible consequences.
  7. **`pptx-reader.ts` ships unused by the product.** The acceptance criterion
     names it, and CNV-13 will need it; shipping it now with its own refusal tests
     is better than a test-only helper that CNV-13 would have to re-audit. It is
     tree-shaken out of the build until something imports it.
- **Not verifiable here:** whether Microsoft PowerPoint or LibreOffice Impress
  open the result without a repair prompt and render it acceptably. Nothing in
  this repo can launch either, and this is the half of AC 1 that must be reported
  **unverified rather than met**. Added to the `QA-05` manual checklist in
  `RELEASE_CHECKLIST.md` as two entries, mirroring CNV-08/09/10/11's: one for the
  four-page fixture (with the specific things to look at, and an explicit list of
  what must *not* be raised because it is disclosed), and one for an OCR'd scan,
  which is the case where the default output is knowingly wrong-looking. Also not
  verified here: how the output looks to a human. Every geometric claim above is
  checked in EMU against the source page's own coordinates, which is a different
  question from whether the slide reads well.

**Second review pass** (an independent audit of this ticket, the same convention
CNV-08 through CNV-11 followed). The headline finding is good news, and it is the
claim this entry spent the most words on: the `pptxgenjs` `XMLHttpRequest` branch
really is unreachable, independently verified — there is exactly one `addImage`
call site in the whole application and it always sets `data`, never `path`, which
is the only thing that could reach it. **No network violation, and the mechanism
was left untouched.** The audit then found **one real, reachable correctness
bug**, **one undisclosed fidelity gap**, and four documentation inaccuracies —
including one in the very argument above. All are fixed below.

**The two that matter, first, because this series' whole method is to err toward
*finding* fidelity gaps rather than hiding them — and both of these were gaps
this entry had described in terms that made them sound smaller than they were.**

1. **A cropped or offset-origin page had everything displaced by the box's own
   origin. Fixed.** pdf.js reports a text run's transform, and a content stream
   states an image's `cm`, in **raw** PDF user space — but a page's `/MediaBox`
   need not start at `(0, 0)` and its `/CropBox` usually does not. Stapler's own
   Crop tool writes one (`composeDocument`, `process.worker.ts`). The size was
   never wrong — `page.getViewport(...)` accounts for the crop, so a
   `[50 50 562 742]` crop on a `612 × 792` media box correctly produced a
   `512 × 692` slide — but every *position* on it was raw, so the whole page was
   shifted by the crop's origin. The audit's worked example: on a page cropped to
   `[100 100 612 792]`, a 24pt title drawn at PDF-space `(150, 700)` belongs at
   `(50, 72.8)` on the slide and landed at `(150, −27.2)`, i.e. 100 pt to the
   right and **off the top edge entirely**.
   - The fix threads the box through both halves. `render.worker.ts`'s
     `extractPageSlide` now reads **`page.view`** — pdf.js's own view box,
     `/CropBox` ∩ `/MediaBox` falling back to the `/MediaBox`, which is the box
     its viewport is built from and therefore the box its text transforms have to
     be read against. All four numbers come from there rather than the extents
     from a viewport and the origin from elsewhere, because a viewport's extents
     are multiplied by `/UserUnit` and text transforms are not. This is the same
     crop-first box selection the rest of the app already makes for edge-anchored
     furniture, where `process.worker.ts` reads `getCropBox()` because a Bates
     number once landed outside the crop the same export had just applied.
   - `PageSlideData.mediaWidth/mediaHeight` are gone, replaced by a single
     `box: PageBox` carrying `x`/`y` alongside `width`/`height` — the rename is
     the point: those fields were never the media box, and calling them that is
     part of how this was missed. `planSlides` subtracts the origin in **exactly
     one place**, for text and pictures alike, before the y flip and before
     `/Rotate`.
   - `findImagePlacements` is still called with **no `initialCtm`**, deliberately.
     Seeding a translated CTM there would work, and would also make the `process`
     worker a second, independent opinion about which box governs the page —
     pdf-lib's `getCropBox()` returns the `/CropBox` as written while pdf.js
     intersects it with the `/MediaBox`, so on a malformed file the two could
     disagree and the pictures would then sit at a constant offset from the text.
     One origin, one subtraction. The reasoning is recorded at the call site.
   - **Evidence.** Two new fixtures in `tests/e2e/fixtures.ts` in this series'
     convention, each stating its expected slide coordinates as literals worked
     out by hand from the box: `pdfToPptCroppedPdf()` reproduces the audit's exact
     example (`/CropBox [100 100 612 792]`, a 24pt title at raw `(150, 700)`, plus
     a second line and an image inside the crop) and `pdfToPptOffsetMediaBoxPdf()`
     is a `/MediaBox [20 30 632 822]` with **no** `/CropBox` — the case that
     proves the origin cannot simply be read off a crop. Five tests: the title
     lands at `(50, 72.8)` and is asserted *not* to be at its raw coordinate; the
     picture lands against the same origin and agrees with the text's left edge;
     the offset-media-box page's heading and picture both land; the shift is a
     no-op for a box already at `(0, 0)`; and the origin is removed *before* the
     quarter turn on a `/Rotate 90` cropped page. Falsified by reverting the two
     subtractions: **all five fail**, then pass again on restore.
2. **In-page rotated text was silently flattened to horizontal *at the wrong
   size*, with nothing said. Fixed rather than merely disclosed.** Page-level
   `/Rotate` was handled and rotated *images* got an explicit per-instance note,
   but text drawn at an angle inside a page — a diagonal watermark, a sideways
   column header — came out horizontal, and because `layoutLines` takes its size
   from `|transform[3]|`, which is **zero** for a quarter-turn run, at a hardcoded
   12pt. Silent: no note, unlike the image case. The audit judged a real fix
   possibly containable, and it was.
   - `textBaselineAngle` reads the angle from `atan2(b, a)` and
     `textTypeSize` reads the size from `hypot(c, d)` — the length of the
     transformed up-vector, which equals `|d|` for horizontal text, so it agrees
     with `layoutLines` on every ordinary page and is still right at an angle.
     `planSlides` generalises the existing baseline→box arithmetic to any angle
     (it reduces exactly to the old expression at 0°) and sets the shape's
     `rotate` to `page /Rotate − baseline angle`, which lands correctly because
     `placeByCentre` maps the box's **centre** and PowerPoint rotates about it.
   - **Angled runs are separated out before `layoutLines` sees them.** That
     function groups by shared `transform[5]` — right for horizontal text,
     meaningless for a sideways run whose glyphs share an `x` — and it is shared
     with CNV-04, CNV-05, CNV-08 and CNV-10, so it was not touched. Each angled
     run becomes its own line instead. That accepts a rotated line split across
     two show operations arriving as two correctly placed boxes, to avoid the
     worse failure of merging two unrelated angled runs that happen to share a
     `y`.
   - **A mirrored transform is *not* turned into a rotation.** A negative
     determinant is a reflection, and rotating the box by `atan2(b, a)` would flip
     the glyphs the other way as well — so a mirrored run stays on the horizontal
     path (its existing behaviour) and is **counted and reported**, rather than
     being silently turned into something the page does not say.
   - Both residuals are disclosed twice over: **new limitation 11** in
     `PPTX_LIMITATIONS` (which is what the panel renders, so the copy and the
     converter cannot disagree), and a **per-page note in the preview**, mirroring
     how a rotated image already announced itself.
   - **Evidence.** `pdfToPptRotatedTextPdf()` — an upright control line, a 90°
     sideways header at 18pt and a 45° diagonal watermark at 30pt. Six tests,
     graded off the produced package: the sideways shape carries
     `rot="16200000"` (270° clockwise) and `sz="1800"` **in its own `<p:sp>`**,
     the diagonal carries `rot="18900000"` and `sz="3000"`, the control line
     carries no `rot` and is the page's only 12pt run; the angled run is kept out
     of the horizontal grouping; the preview names the page; a mirrored run is
     reported and left upright. Falsified by flattening every run back to
     horizontal: **four fail**, then pass again on restore.

**Limitation 10 was rewritten**, because "a line can sit a point or two from
where the PDF drew it" understated the bug above and was the wording that made it
easy to dismiss. It now says what is measured (where a line starts, how wide it
is), what is assumed (the 0.80/1.20 em Latin metrics, because no PDF states an
ascent), that a script with taller glyphs than Latin can sit further off, and —
explicitly — that nothing is displaced by the page's crop.

**The four documentation inaccuracies, all corrected, none a behaviour change:**

3. **The throwing-XHR test's stated rationale was wrong, though its conclusion
   still holds.** This entry and `pptx-writer.ts` both described a unit test that
   makes `XMLHttpRequest`/`fetch`/`WebSocket` throw as *proof* the XHR path is
   unreachable. It is not: that test runs under Vitest's Node environment, where
   `pptxgenjs` checks `process.versions?.node` and takes an entirely different
   internal branch, so the browser XHR call is never a candidate there and the
   stub going unfired shows nothing about it. The sound argument needs no such
   framing and is now what both places state: **one** `addImage` call site in the
   whole app, `data` set **unconditionally** on it, and the library's **single
   candidate filter** (`rel.type !== 'online' && !rel.data && …`) gating the
   browser-XHR branch and the `node:fs`/`node:https` branches *alike* — so a
   conversion that completes under Node's branch is itself evidence that no
   XHR-eligible relationship exists under the browser's. The stubs are kept as a
   **regression tripwire** (a future `path`-based call would make the app itself
   throw), labelled as such, and `zero-network.spec.ts` — a real browser, a real
   request log — is now correctly identified as the only place the claim is
   measured in the environment it is about.
4. **The `verify-offline` reference was wrong, and the known hit had no durable
   record.** This entry claimed the skill's "layer-2 sweep" greps the built bundle
   for `XMLHttpRequest` and would flag the `pptxgenjs` occurrence. It does not:
   layer 2 greps for `http://`, `https://`, `fetch(` and the known CDN hosts, and
   `XMLHttpRequest` appears only in layer 1, which is `src/`-only and never
   reaches a dependency's chunk. Corrected above — layer 2 *will* hit the chunk,
   but for its namespace URIs, and layer 3 (the runtime monitor) is what actually
   covers the branch. More usefully, the finding is now written down where a
   release pass will meet it: `RELEASE_CHECKLIST.md` gains a **"Known, analysed
   bundle findings"** step naming both expected hits with their reasoning and a
   pointer back here, and `scripts/check-bundle-size.js` — the script a reviewer
   already runs against `dist/` — carries the same note at the top. Re-measured on
   this build (`assets/pptxgen.es-DFh8Ui1o.js`): **1** `XMLHttpRequest`, **0**
   `fetch(`, **0** `WebSocket`, and the only hosts are `schemas.openxmlformats.org`,
   `schemas.microsoft.com`, `purl.org`, `www.w3.org` (namespace identifiers) plus
   `gitbrent.github.io` / `github.com` in `throw new Error(...)` strings.
5. **A wrong test count in `pdf-to-ppt-commit.test.ts`.** Its header said
   "these five cases … weakening … fails the last three; removing it altogether
   fails the first four". Re-measured by actually making both mutations: there are
   **7 tests covering 5 refusal cases**; weakening the guard to `if (!preview)`
   fails **four** (the last four refusals — the "no preview" case is the one the
   weakened check still covers), and removing the check **altogether**, both
   conditions, fails **all five**. The comment now states those numbers and says
   they were measured, matching the "4 of 7" figure this entry already had right.
6. **A wrong claim about `pptxgenjs`'s dedup behaviour.** `pptx-writer.ts` said a
   shared image becomes one media part "because pptxgenjs dedupes identical
   data". It does not dedupe at all for the way this writer calls it — its only
   collapsing rule compares the `path` a caller passed, and this writer never
   passes one, so every `addImage` writes a fresh part even twice on one slide.
   `dedupeMediaParts` is correct and *necessary* for exactly that reason. Both the
   comment and this entry now say so, and point at the test that measures the
   library's own behaviour first.

**Two minor findings, both fixed:**

7. **D4 — a line of exactly the cap length was reported as shortened when
   nothing was cut.** `planSlides` tested `chars >= MAX_BOX_CHARS` while
   `lineToRuns` was already computing an exact `truncated` count that was being
   discarded. The exact count is now carried on `PageTextLine` and used, so the
   converter cannot misdescribe its own output — the same class of defect this
   ticket already had to fix once, in the inline-image message. A boundary test
   pins both sides: a line of exactly `MAX_BOX_CHARS` reports nothing, one
   character more reports. Falsified by restoring a length-based check.
8. **D7 — a zero-length archive entry was dropped in silence and could
   over-report `imageCount` by one.** `addSlide` skips a zero-length image, but
   `planSlides` had counted it as placed, so the plan (which `imageCount` and the
   preview's per-slide counts are both read off) could claim a picture the file
   does not carry. Fixed at the source rather than by plumbing a second report
   back: `convert.worker.ts` now builds `archivedFiles` from the **non-empty**
   entries, so `imageRefusal` names it in the notes and every count stays exact.
   Practically unreachable, but it cost one line.

**Verification after all eight fixes.** `pnpm check` green — run step by step for
the reason this entry already gives (`tsc --noEmit`, `eslint .`,
`prettier --check .`, 102 tokens, 30 contrast pairs × 2 themes, invariants); all
six pass. `pnpm test`: **89 files · 1141 tests · 0 failures**, up from 1129 —
the twelve new ones being five for the box origin, six for angled text and one
for the truncation boundary. No existing test's *assertions* changed; the
`PageSlideData` literals in `pdf-to-ppt.test.ts` and `pdf-to-ppt-transfer.test.ts`
were updated for the `box` field and moved behind two builders. `pnpm test:e2e`:
**123 tests, 123 passed / 0 failed** in one full run (7.9 min) — the first clean
full run in this series, with none of the load-sensitive flakes CNV-08..12 have
each had to note. `pnpm check:bundle`: **361.84 KB gzipped**, identical to the
pre-audit figure — every change here is inside the workers and the lazy convert
chunk, none in the initial bundle.

Each of the three behavioural fixes was **falsified before being believed**: the
change was reverted, the file was run, the expected tests failed, and the fix was
restored. Five fail for the box origin, four for angled text, one for the
truncation boundary. The two mutation counts in finding 5 were measured the same
way.

### CNV-13 · PowerPoint (PPTX) → PDF — `L` `P2`

**Status: Done.** Both acceptance criteria are met against real output bytes.
Ships labeled beta with a mandatory preview per §5.5, same policy as CNV-08..12.
Ten limitations, all ten named in the tool's own panel copy (the list is a
`core/` constant the panel renders, so the panel and the converter cannot state
different ones); **ten** counted disclosures report numbers at runtime in the
preview's "left out" list — six as shipped, four more added by the second review
pass below. **Read "The honest fidelity statement" and the "Second review pass"
below before the rest of this entry** — the gap between "converts a deck this
codebase wrote" and "converts an arbitrary PowerPoint file" is real and is not
fully closed.

New tool `ppt-to-pdf` (group Convert, `Save PDF`, `worksWithoutDocument`). Two
workers, sequenced by `convertPptxToPdf` in `src/core/operations.ts`:

- **`convert`** gains `pptxToBlocks`, which reads the deck into the shared block
  model (`src/core/convert/pptx-slides.ts`, new; `pptx-reader.ts` extended).
- **`process`** reuses `layoutBlocksToPdf`, with one additive block kind and one
  additive option (below).

This is the **only one of the six conversions that adds no library at all.**
CNV-12's `pptx-reader.ts` is a hand-rolled walk over `fflate`, which is already
in the initial bundle, so there is no lazy chunk here whose contents have to be
taken on trust. §2.4's "PPTX read — *(hand-rolled, via existing `fflate`)*" row
is now actually exercised by a shipping tool rather than only by a test.

#### The one new block kind, and why a slide is not a flow

CNV-09's engine flows: it stacks each block under the last and breaks a page when
it runs out of room. CNV-11 fed it a spreadsheet and needed one additive field
(`columnWidths`). A deck cannot be fed to it that way, and the reason is not
fidelity polish — it is that **a slide states where its content goes.** Two
shapes sit side by side; a caption sits under a picture; the order the XML
happens to use is not the order a reader sees. Flowed down an A4 page, that is a
different document rather than a lower-fidelity copy of the same one, and "one
PDF page per slide" would depend on how much text happened to fit.

So the model gains a `canvas` block: **one page of producer-positioned content,
drawn on a page of its own.** Nothing in its definition names PowerPoint — it
carries its own coordinate space (points, origin top-left, y down), a z-ordered
list of positioned text / image / table items, and a label. The engine starts a
fresh page for it and leaves that page full, which is what makes one-page-per-
slide a *structural* property of the model. `PdfLayoutOptions` also gains
`pageBox`, an exact page size in points: a `.docx` and an `.xlsx` state no page
size worth honouring, but a deck does, and a 13.33 × 7.5in deck exported onto A4
is letterboxed on every page for no reason. Out-of-range boxes are clamped to
what the PDF format allows and reported, never written as given. CNV-08's,
CNV-09's and CNV-11's existing engine tests are the regression cover and pass
unchanged.

#### The geometry, and the test that would catch it being wrong

OOXML measures in EMU (914400/inch) from the slide's **top-left, y down**. A PDF
page is points from its **bottom-left, y up**. A converter that forgets the flip
produces a file where every assertion made against its own model still passes and
every page is upside down — which is precisely the class of bug CNV-12's audit
found in the opposite direction (a cropped page displaced every line and picture
by the crop's origin).

So the flip, the fit-to-page scale and the centring happen in exactly one
function, `drawCanvas` in `pdf-block-layout.ts`, and `pptx-slides.ts` does no
page geometry at all beyond dividing by 12700. The fixture deck puts a title
0.4in from the slide's top edge and a footer 6.9in down, and the test reads where
they landed **out of the produced PDF** with pdf.js — CNV-12's own
`extractPageSlide`. The title's baseline must be ~468pt on a 540pt page and the
footer's ~27pt; drop the flip and the first is ~29. The picture's placement is
read the same way, out of the page's own content stream `cm` operands.

#### What CNV-13 added to `pptx-reader.ts`, and why it belongs there

CNV-12 shipped that reader with three gaps written down as obligations on its
successor. All three are closed, because each is a fact about the *file format*
rather than about either conversion:

1. **Group shapes.** `<p:grpSp>` writes its children in its own child coordinate
   space (`<a:chOff>`/`<a:chExt>`), which its `<a:off>`/`<a:ext>` map onto the
   slide. Reporting a child's raw geometry — what the file used to do — is
   *wrong*, not approximate, and PowerPoint groups shapes routinely. The
   transform now composes down the tree, nested groups included.
2. **Tables.** `<a:tbl>` lives inside a `<p:graphicFrame>`, which the old scan
   did not look at at all, and which states its transform in the `p:` namespace
   rather than the `a:` one. Cell text reached `runs`/`text` (they scan for
   `<a:t>` anywhere) but no *shape* carried it — so a positioned layout would
   have drawn nothing while the slide's own `text` claimed the words were there.
   That is a silent loss, so the grid is now read: column widths, row heights,
   per-cell paragraphs, and merge-continuation cells.
3. **Run and paragraph properties** — `sz`, `b`, `i`, `algn`, `lvl`, and a
   literal `<a:buChar>`. A converter that draws this text needs a size; guessing
   one is how a deck comes out at the wrong scale.

The element scan is no longer one non-greedy regex per name, because a
`<p:grpSp>` can contain a `<p:grpSp>` and `[\s\S]*?` closes the outer group at
the inner one's end tag — truncating the outer group's remaining shapes.
`childElements` counts depth instead, and a test asserts a sibling written *after*
a nested group survives.

#### Sharing an image across slides: encode once

A logo on forty slides is one `ppt/media/` part. The reader hands the same
`Uint8Array` instance to every slide that references it, the canvas image item
carries the part name as an `id`, and the layout engine caches embedded XObjects
by that id — so the PDF holds one image object however many slides show it. The
fixture proves this end to end: two slides draw one part, and the produced file
has **one** image XObject for two placements. `operations.ts`'s `imageBuffersOf`
had to be taught to descend into `canvas.items` for the second worker hop, which
is a real hazard with no other symptom (a silent structured clone of a deck's
worth of photographs); `ppt-to-pdf-transfer.test.ts` pins it, and reverting that
branch fails two of its three tests.

#### The honest fidelity statement

The fixture is a `pptxgenjs`-written deck — the same writer CNV-12 ships — driven
directly rather than through `buildPptx`, because `SlidePlan` cannot express a
table. That gets it closer to an authored deck than a Stapler round trip would
(bulleted paragraphs with `<a:buChar>`, a centred paragraph with `algn="ctr"`,
per-run `b`/`i`/`sz`, a real `<a:tbl>`, one media part referenced twice). It is
still **not** an arbitrary real-world PowerPoint file, and two differences matter:

- **Layout and master inheritance is not read at all.** Text typed into a
  placeholder is in the slide part and converts; a title, footer, slide number or
  background that only the *layout* supplies is not read and does not appear. A
  deck whose slides are made entirely of inherited placeholders comes out blank —
  which is refused with a message naming that exact cause rather than written as
  blank pages.
- **No theme, no colour, no fills.** All text is black, no shape fill, outline,
  shadow or slide background is drawn, and every glyph is Helvetica at the deck's
  stated size. A slide that is a coloured banner with white type on it arrives as
  black type on white. Nothing here reads a `.thmx` or a `<a:solidFill>`.

One consequence of that second point is worth naming on its own, because it is
the difference between "lower fidelity" and "unreadable". A placeholder that
inherits its *geometry* from the layout carries no `<a:xfrm>` at all — ordinary
in an authored deck, and most likely on the shape holding the title. Read as a
box of zero width it would wrap to one character per line: a page missing no text
and impossible to read. So an unstated extent becomes "the rest of the slide from
this corner", every shape it happens to is counted, and the note says the text is
all present but its wrapping and position are approximate.

Also not carried across, each stated in the panel and counted at runtime where a
count is meaningful: **transitions, animations and speaker notes** (the ticket's
own out-of-scope list — a PDF page has no notion of any of them); rotated and
flipped shapes (drawn upright at the same position and size, counted); charts,
SmartArt and embedded objects (their text only); numbered bullets (PowerPoint
stores the scheme, not the numbers — counted); video, audio, hyperlinks and
comments. A run stating no `sz` is drawn at 18pt and counted. `•` reaches the
page as `-`, because `markdown-to-pdf.ts`'s shared WinAnsi sanitiser rewrites it
for every tool in this codebase (CNV-09's own list markers included) — the
marker survives as a marker, and the substitution is the app's existing one
rather than a loss introduced here.

**Refusals, all before any PDF exists**, each with its own message and each with
a test asserting the layout engine was never reached: an empty file; an OLE2
container (a legacy `.ppt`, or a password-protected `.pptx` — the same
container); a file that is not a ZIP; a ZIP with no `ppt/presentation.xml`; a
deck listing no slides; a package listing a slide it does not contain; and a deck
that would produce nothing but blank pages. Slide order comes from
`<p:sldIdLst>` through `presentation.xml.rels`, never from sorting part names —
`slide10` sorts before `slide2`, and a per-slide assertion would then be
comparing the wrong page.

**Verification.** `pnpm check` green (`tsc --noEmit`, `eslint .`,
`prettier --check .`, 102 tokens, 30 contrast pairs × 2 themes, invariants).
`pnpm test`: **92 files · 1193 tests · 0 failures**, up from 1141 — 52 new,
across `ppt-to-pdf.test.ts` (43), `ppt-to-pdf-commit.test.ts` (6) and
`ppt-to-pdf-transfer.test.ts` (3). No existing test's assertions changed; CNV-12's
66 reader tests pass unchanged against the extended reader. `pnpm test:e2e`:
**127 tests** (123 + 3 for the gate + 1 zero-network conversion run). Reported
exactly as measured, because the two full runs disagreed and neither was clean:
the first was **126 passed / 1 failed** (`compress-preview.spec.ts`'s CMP-05
canvas-pixel comparison) and the second **124 passed / 3 failed** — that same
CMP-05 comparison, `a11y-and-perf.spec.ts`'s route scan failing on the *home*
route with "document must have `<title>`" and "html must have a lang attribute"
(i.e. axe ran against a page that had not finished loading, before the tool loop
it would have swept a new route in), and `import.spec.ts`'s clipboard-paste test.
All three pass on a targeted rerun (**38/38**), none is in a file this ticket
touches, and all four of this ticket's own e2e tests passed in both runs. These
are the load-sensitive flakes CNV-08..11 each had to note; CNV-12's entry
recorded the series' one clean full run, and this is not a second one.
`pnpm check:bundle`: **362.04 KB gzipped**, +0.20 KB on CNV-12's 361.84 KB — the
tool adds no dependency, and its reader is already-bundled `fflate`.

Both mutation claims were **measured, not asserted**: weakening `commit.ts`'s
guard to `!preview` fails the two revision cases and removing it fails all five
refusal cases; removing the `canvas` branch from `imageBuffersOf` fails two of
the three transfer tests.

**Not verifiable here.** Nothing in this repo opens PowerPoint, Acrobat, Preview
or Keynote, and no real-world deck (with a theme, a master, and fonts) was
converted — the fixture is machine-written. Both belong on the `QA-05` manual
checklist: convert a deck someone actually authored and compare it page by page.

#### Closing the series: is CNV-08..13 actually six tools?

CNV-13 is the last of the six, so the claim PLAN §1.1's revision note made at the
start of the series — that PDF ↔ Office is "in scope as **CNV-08..13**" — is now
checkable rather than a plan. Swept against the code, all six are complete and
symmetric: each has a `ToolDefinition` in `tools.ts`, a body in `OptionsPanel`'s
`BODIES`, a handler in `commit.ts`'s `HANDLERS`, an entry in
`zero-network.spec.ts`'s tool sweep **and** its own conversion run under the
network watch, a gate spec in `tests/e2e/`, and a beta badge plus a
preview-gated save in its panel. Nothing in the series was left half-done. Two
notes on the revision note's own wording, neither a defect:

- Its "(paragraphs, headings, tables, basic runs, **images**)" is the class of
  capability across the six, not a per-tool promise. The Excel pair carries no
  images in either direction by design, and CNV-11's panel says so
  (`EXCEL_LIMITATIONS`: "Charts, images, pivot tables, shapes, comments…").
- §2.4's stack table has one stale cell, unrelated to this ticket: "DOCX write —
  **docx** (lazy) … only loaded by CNV-08/12". `docx` is loaded from exactly one
  place in the tree (`convert/docx-writer.ts`, dynamically) and only CNV-08
  reaches it; CNV-12 writes PowerPoint with `pptxgenjs`. Reads like a renumbering
  leftover. Flagged rather than edited — PLAN.md is out of scope for this ticket.

**Second review pass** (an independent audit of this ticket, the same convention
CNV-08 through CNV-12 followed — and the last one in the series). The headline is
good news on the parts this entry spent the most words defending: **both
acceptance criteria are genuinely met against real output bytes**, the
group-transform composition is **correct**, verified against eight adversarial
cases including nested groups with asymmetric scale (the exact class of bug that
bit CNV-12 in the opposite direction), and the `canvas`/`pageBox` extension to
the layout engine is **genuinely additive** — no existing tool's path changed.

The audit then found **four real defects, three of them silent loss** — content
left out with nothing said, which is the one failure class this whole series
exists to police. All four are fixed, plus two minor findings it flagged as
lower priority. Every behavioural fix was **falsified before being believed**:
the change was reverted, the file was run, the expected tests failed, and the fix
was restored. The counts are stated per finding.

1. **A rotated or flipped group was silently discarded, uncounted, and the
   panel's own promise was false for it. Fixed, both halves.** `pptx-reader.ts`
   read `<a:off>`/`<a:ext>`/`<a:chOff>`/`<a:chExt>` off a `<p:grpSp>`'s
   `<a:xfrm>` and **never read `rot`, `flipH` or `flipV` at all** — so a group's
   orientation did not even reach `pptx-slides.ts`'s tally, which stayed at 0 and
   produced `notes: []` for a deck of flipped groups. Limitation 7's panel copy
   says such shapes are drawn "at their stated position and size" and that "the
   count is reported with the conversion"; **both halves were false for a group**,
   because PowerPoint's group flip mirrors the *child coordinate space* — the
   children's own positions move, not just their orientation.
   - **The positional half is fixed properly, not disclosed away.** A mirror is a
     sign change on one axis, so `composeGroup` now carries a negative
     `scaleX`/`scaleY` and adds the group's extent to the constant term
     (`off + ext − chOff·scale`, which reduces to the old expression when there
     is no flip), and `place` normalises the negative-width interval that
     produces back into a left edge and a width. Composition therefore stays one
     affine map: a flip inside a flip **cancels**, and the child comes back
     exactly where it was written.
   - **A group's rotation is *not* applied**, and that is now a named limitation
     rather than a silence: applying it needs the group's centre and a rotated
     draw, which nothing in this converter does. Every affected shape carries
     `PptxShape.groupRotated`, `rotatedGroupNote` states the count, and
     limitation 7's copy now says outright that a rotated group's children are
     drawn where its *unrotated* rectangle puts them and that this can be well
     away from where PowerPoint shows them.
   - `PptxShape.rot`/`flipH`/`flipV` are now *effective* values — the shape's own
     composed with every enclosing group's (sum, and XOR) — so a child of a 45°
     group reports 45° and reaches the existing count. The doc comment says
     plainly that the sum is an orientation **report**, never used to place
     anything, and that it does not model a mirror reversing a rotation's sense.
   - **Evidence.** Four tests around the audit's own repro — a group with
     `rot="2700000" flipH="1"` mapping its child space 1:1 (so the mirror is the
     only thing that can move the child). The child used to come back at
     `x = 1000000` with `{rot: 0}`, no flip flags and `notes: []`; it now comes
     back at `1800000` with `rot: 2700000`, `flipH`, `groupRotated`, and both
     `rotatedNote(1)` and `rotatedGroupNote(1)` in the notes. A second test reads
     the mirrored position **out of the produced PDF** with pdf.js (141.7pt, not
     the 78.7pt the old reading wrote). A third asserts flip-inside-flip cancels
     and reports *nothing* — so the disclosure is not a blanket. A fourth covers
     `flipV` and a group stating an orientation but no child rectangle.
     Falsified: dropping the sign change fails 3, dropping the orientation
     propagation fails 2.
2. **Charts and SmartArt contributed nothing, silently, and limitation 8 was
   false for the realistic case. Fixed by actually reading their text.** A
   `<p:graphicFrame>` holding a chart is a *reference*: `textRuns(frame.body)`
   finds nothing, and the old code `continue`d on that — so no shape, nothing on
   the slide's comparison surface, and `notes: []`. A chart's title, series names
   and category labels live in `ppt/charts/chart1.xml` and SmartArt's node text
   in `ppt/diagrams/data1.xml`, and `readPptx` opened neither. Limitation 8 said
   these frames "contribute their text only", which was true only for the
   unrealistic case of text inline in the frame.
   - `graphicPartText` reads the two places that text actually lives: rich text
     (`<a:t>` — chart and axis titles, every SmartArt node) and the **string**
     caches (`<c:strCache>`'s `<c:v>` — series names, category labels),
     deduplicated because every series repeats the same categories. **Numeric
     caches are deliberately not read**: a bar's height is not a label, and
     listing the numbers would read as a data table this converter did not draw.
     Resolution happens in `readPptx`, where the package is, off the frame's own
     `r:id`/`r:dm`; `shapesOf` stays a pure walk over the slide XML.
   - Kept honest at the edges: the text is capped at `MAX_GRAPHIC_TEXT_RUNS`
     (60) and **the remainder is counted**, not truncated in silence; and a frame
     is now emitted as a `graphic` shape **even when nothing could be read from
     it** (a missing part, or an OLE object whose part is binary), because the
     note is then the only thing standing for it. `graphicFrameNote` fires **per
     frame, naming the slide** — an aggregate would not tell the user which page
     to look at.
   - **Limitation 8 is rewritten** to what is now true: charts and SmartArt are
     *not drawn*; their own text is read and drawn as plain text where the frame
     sits, with no axes, bars, connectors or layout; an embedded object
     contributes nothing at all; each frame is named per slide. The phrase
     "contribute their text only" is gone from the list, and a test asserts it
     stays gone.
   - **Evidence.** Five tests. A hand-built package whose chart part holds
     "Revenue by region" (plus a series name and two categories): the frame is
     read as a `chart` at its own `p:xfrm`, the four strings reach the slide's
     text, the numeric `41` does **not**, `graphicFrameNote` names slide 1, and
     "Revenue by region" comes back out of the **produced PDF**. Then SmartArt
     out of a `dgm:dataModel`, a chart whose reference does not resolve (noted as
     "nothing on the page stands for it", alongside real content so the deck
     still converts), the 60-label cap reporting 7 dropped, and the panel-copy
     assertion. Falsified: restoring the `continue` fails 3, stubbing the part
     read fails 2.
3. **The mandatory preview stayed silent about blank pages it already knew
   about. Fixed in the panel, which is where the finding was.** `SlideSummary.
   empty` was computed per slide and read by **nothing** except the all-or-nothing
   refusal, so a deck with one real slide and three placeholder-only ones — more
   common in an authored deck than the fully-empty case — previewed as if every
   page had content. `PptToPdfPanel` now marks the row itself with
   `BLANK_SLIDE_LABEL` (a `core/` constant, so the panel and the converter cannot
   describe the same page differently), and `blankSlidesNote` lists the numbers in
   the "left out" list.
   - **Evidence.** A unit test on a partially blank deck asserts
     `[false, true, true, true]` per slide and the note naming "Slides 2, 3 and
     4" — and an **e2e test** drives the real panel with a new fixture
     (`pptToPdfPartiallyBlankPptx`, three of four slides with no shape at all):
     row 1 is unmarked, rows 2–4 each read "appears blank", the note is visible,
     and the save still unlocks — disclosed, not refused. Falsified by removing
     the panel's marker: the e2e test fails with the row reading
     `"p2 · Slide 2Slide 2"`, which is exactly what the audit described.
4. **The all-blank refusal misattributed its cause and threw away a better
   message it had already built. Fixed.** A deck whose only content is a picture
   missing from the package, or an EMF, was already diagnosed exactly —
   `missingImageNote` / `unsupportedImageNote` were computed and in hand — and
   then, because the slide had no *text*, it fell into the generic
   `PPTX_EMPTY_DECK_MESSAGE` and told the user their text "probably" lives in a
   slide layout. A wrong diagnosis for a problem the code had solved.
   `blankDeckMessage` now prefers the specific reasons (missing media,
   unsupported format, a chart with no readable text, an all-empty table) and
   falls back to the layout guess only when there genuinely is none.
   - **Evidence.** Three tests through the production entry point with
     `layoutCalls` asserted at 0: a picture whose relationship resolves to a part
     that is not in the package, an EMF picture, and a chart-only deck. Each
     asserts its own specific sentence **and** that "slide layout or master" is
     *not* in the message; a fourth pins the fallback for a deck that really is
     nothing but empty placeholders. Falsified by restoring the unconditional
     throw: all three fail.

**Both minor findings are fixed too, because both were cheap:**

5. **CDATA desynchronised the element scan** — `childElements` stripped nothing,
   so `<a><![CDATA[</a>]]>real</a><a>second</a>` closed the first element inside
   the CDATA section and lost the middle text. That contradicted this file's own
   claim that a regex walker's risk is "a missed element, never a wrong one". Both
   comments and CDATA sections are now located up front and any "tag" inside one
   is ignored, so the claim is true rather than merely likely — and because a
   body is a slice of the original XML, the text inside a section is still kept.
   One more thing fell out of it: a run written as `<a:t><![CDATA[…]]></a:t>` used
   to reach the page **with the `<![CDATA[` markers in it** (wrong text, not
   missing text), so `textContent` now decodes the two kinds of segment
   differently — entities outside, verbatim inside. Three tests, including the
   audit's exact repro; falsified by removing the skip (2 fail). Unreachable for
   PowerPoint's own output, as the audit said; fixed because "wrong, not missing"
   is the one thing this reader promised it could not be.
6. **An all-empty table evaded blank detection** — it was drawn as an empty grid
   and counted as content, so it benefited from neither the refusal nor the new
   per-slide marker. `SlideSummary.empty` now means "carries nothing a reader can
   read", which is items-drawn *and* the one case where something is drawn and
   says nothing; `emptyTableNote` names the slide, and a deck that is nothing but
   empty grids is refused with that note rather than with the layout guess. Two
   tests.

**What is still disclosed-but-unfixed, stated plainly because this is the last
ticket in the series.** With the four fixes in, the series' safety claim — *every
limitation is stated up front and counted at runtime* — now **holds for CNV-13
in both halves**: every limitation is in `PPT_LIMITATIONS`, which the panel
renders before the conversion runs, and the counted disclosures went from six to
ten (`blankSlidesNote`, `rotatedGroupNote`, `graphicFrameNote`, `emptyTableNote`
are the four new ones). Three residuals are consciously left, and each is now
*stated* rather than silent:

- **A rotated group's children are drawn at unrotated positions.** Not
  approximate — potentially far from where PowerPoint shows them. Counted
  (`rotatedGroupNote`) and named in limitation 7. Fixing it properly means
  rotating a whole canvas item, which the layout engine does not do for any tool.
- **A child of a flipped group that states no extent of its own** is mirrored
  about its left edge rather than its box, because there is no width to mirror.
  It is already inside the `unpositionedNote` count ("position and wrapping
  approximate"), and the interaction is not called out separately in the panel.
- **Chart and SmartArt text arrives in the part's order, not the picture's.** A
  chart's labels are drawn as a plain list where the frame sat; nothing pretends
  it is a chart, and limitation 8 says so, but "the text is present" is a weaker
  promise than "the slide reads the same". Numeric caches are not read at all,
  and past 60 strings the remainder is counted rather than drawn.

Unchanged from the original entry, and still the biggest gaps in this direction:
layout and master inheritance is not read (blank pages are now flagged per slide,
which is disclosure, not content), and no theme, colour or fill is drawn. Neither
is a counting problem, and neither is closed. **Still not verifiable here:**
nothing in this repo opens PowerPoint, Acrobat or Keynote, and no real-world
authored deck (theme, master, embedded fonts) was converted — both remain on the
`QA-05` manual checklist.

**Verification after all six fixes.** Run step by step for the reason this entry
already gives. `tsc --noEmit` clean; `eslint .` clean; `prettier --check .`
clean; 102 tokens; 30 contrast pairs × 2 themes; invariants clean (the panel's
one new colour is `var(--warning)`, already an audited pair and already used as
text elsewhere in `OptionsPanel`). `pnpm test`: **92 files · 1211 tests · 0
failures**, up from 1193 — 18 new, all in `ppt-to-pdf.test.ts` (43 → 61). **No
existing test's assertions changed**, and CNV-12's 66 reader tests pass unchanged
against the further-extended reader, which is what makes the reader changes
additive rather than a re-interpretation. `pnpm test:e2e`: **128 tests, 128
passed / 0 failed** in one full run (8.4 min) — 127 + the new blank-preview test,
and a clean run: none of the load-sensitive flakes this entry recorded
(`compress-preview`'s CMP-05 pixel comparison, `a11y-and-perf`'s route scan,
`import`'s clipboard paste) reproduced this time. `pnpm check:bundle`: **362.04 KB
gzipped**, byte-identical to the pre-audit figure — every change is inside the
reader, the converter and the panel, none in the initial bundle, and no
dependency was added.

- **Requirements:** Read `.pptx` via the hand-rolled `pptx-reader.ts` (a zip-of-XML
  walker over the existing `fflate` dependency — no new library for this narrow read
  need), extract per-slide text runs and images, and lay one PDF page out per slide
  via the shared `html-to-pdf-blocks` engine. Slide transitions, animations, and
  speaker notes are not reproduced (out of scope, not silently dropped — state this
  in the tool's copy).
- **AC:** A multi-slide fixture (text + at least one image, one slide with a table)
  produces a PDF with one page per slide, all slide text present, verified against
  the source deck's own text content. Beta label and mandatory preview appear before
  save.

---

## EPIC-17 · Workflow polish

Six features shipped together over 2026-09-12/13, the first five sharing one thread: never
let an export surprise the user — show them what is about to be written, never write
something they did not ask for, and never make discarding a change riskier than making one.
The sixth (UX-06) is a smaller, unrelated shortcut from the same commit. Same hard
invariants and definition of done as every other epic in this file. Audited for edge cases
on 2026-09-14 (this file's own tickets were never written for this work until this pass —
the commits shipped it directly); every fix below has a regression test that fails on the
pre-fix code, confirmed by reverting the fix and re-running it.

### UX-01 · Unified open-document flow — `S` `P1`

**Status: Done** — `core/open-document.ts` factors "pick or drop files → import → add as
workspace document(s)" out of the home route's drop zone (DS-05) into one shared entry
point (`pickAndImportFiles`/`importFilesAsDocuments`), so a tool opened with nothing loaded
is not a dead end: `OpenDocumentPrompt` (previously inert text in `OptionsPanel`) calls the
same pipeline and lands the user in the same tool once a file is chosen.

**Audited and hardened (2026-09-14):** the button's own label picked up a wording change
("Open a document…" → "Open a document or image…") whose translation never made it past
`en.json` — every one of the other 10 locales silently fell back to English for the button
specifically, while the caption above it was correctly translated (a *different* key,
which did get updated everywhere). Fixed by adding the missing key to all 10 locale files.
`tests/e2e/i18n.spec.ts` › "the open-document empty-state button is translated, not left
in English".

- **Requirements:** A single "open a document" pipeline, reachable both from the home
  route's drop zone and from any tool's own empty state, importing PDFs and images through
  the same validation/classification path.
- **AC:** Opening a tool with nothing loaded shows a prompt that itself opens a file,
  landing in the same tool. The prompt's copy and its button are both translated in every
  supported locale, not just English.

### UX-02 · Pre-export review: page rendering and diff — `M` `P1`

**Status: Done** — `core/diff-preview.ts` renders a `beforeIndex`/`afterIndex` pair from
two documents to `ImageData` via the render worker and pixel-diffs them (`pixelDiff`),
reusing the exact render-worker call shape ANN-05's `visual-diff-export.ts` already
established — load both documents in one lease, render the target page from each, close
both handles. `core/page-alignment.ts`'s `alignPages` matches `current` against `baseline`
by each page's stable key (survives rotation, reordering, and the deletion of *other*
pages), so a reordered page is compared against its true counterpart rather than whatever
sits at the same position on both sides.

**Audited and hardened (2026-09-14) — five real bugs found and fixed:**
1. `alignPages`'s `moved` flag compared `beforeIndex` to raw `currentIndex` — deleting or
   duplicating *any* page shifted every later page's index, wrongly flagging it
   "reordered" (delete page 3 of 9 → 6 pages wrongly badged "Was page N"). Replaced with a
   longest-increasing-subsequence check over the `beforeIndex` sequence, so only pages
   genuinely out of relative order are flagged — a deletion just removes an element from
   an already-increasing sequence, it does not disturb it. `tests/unit/page-alignment.test.ts`
   (new — this module had no unit coverage at all before this pass).
2. A 90/270° rotation swaps the rendered page's width and height, which made the pair
   `comparable: false` — masking any *other* edit (crop, watermark) made on the same page
   behind a misleading "this page changed size" note that was simply the wrong
   explanation. `diffPage` now takes a `rotationOverride` (a new parameter on the render
   worker's `renderPage`) and renders the baseline page at the *current* page's rotation
   instead of its own, so a rotation-only change compares as pixel-identical and a real
   edit layered on top of one still surfaces. `tests/e2e/review-alignment.spec.ts` › "a
   rotated page compares cleanly, not as a false 'changed size'".
3. N-up collapses 2–4 original pages onto one output sheet; `alignPages`'s per-page
   metadata (one entry per *original* page) was still being read at a *sheet* index by
   every handler whose compose can include N-up (`annotate`, `normalize`, `metadata`,
   `ocr`, and the generic organize-style exporter), handing the wrong baseline page to a
   sheet and showing false Rotated/Was-page badges. Alignment is now skipped entirely
   whenever N-up is active — after-only review, the same treatment the contact sheet
   already gets for the identical "different page layout entirely" reason.
   `tests/e2e/review-alignment.spec.ts` › "an N-up export does not misapply per-page
   alignment badges to sheets".
4. A leaked render-worker document handle when the *before* load rejected: `Promise.all`
   rejects before a destructuring assignment from its resolved value ever runs, which was
   skipping the handle-close for an *after* load that had actually succeeded just fine.
   Each load's handle is now captured off its own `.then` as soon as it resolves, not off
   the combined `Promise.all` result.
5. Clicking Next before the real page count had resolved could push `pageIndex` past the
   last real page; the "after" render then came back `null` and the display silently fell
   back to showing the *before* image, unlabeled, as if it were the result. `canNext` now
   requires a confirmed count rather than optimistically assuming one exists.

- **Requirements:** Render and diff one page from each of two documents by true page
  identity, not position; degrade gracefully (no diff mask, no crash) when the two pages
  are not pixel-comparable.
- **AC:** A rotated page with no other edit shows no differences and no "changed size"
  note. A crop/N-up/Normalize-resized page shows both images side by side, not just the
  after page. Reordering, deleting, or duplicating pages never mislabels an untouched page
  as changed.

### UX-03 · Pre-export review modal — `M` `P1`

**Status: Done** — `ExportReviewModal.tsx` reads `exportReviewRequest` (set by
`commit.ts`'s `reviewAndSave`/`reviewAndSaveZip`/`reviewOnly`) and resolves it when the
user picks Save or Cancel. `'single'` shows a page-by-page before/after `CompareSlider`
with a pixel-diff-highlight toggle; `'zip'` shows a file list, each member previewed on its
own, since a split chunk or an extracted image never lines up 1:1 with an original page.

**Audited and hardened (2026-09-14):** none of the modal's three render effects (the
single-page diff, the removed-page preview, the zip member preview) caught a render
failure — a rejected promise left a blank stage with Save still enabled and no
explanation, indistinguishable on screen from "nothing changed here." All three now catch
and show a plain-language note instead of failing silently.

- **Requirements:** Show the result of a commit before it is written, with a real
  before/after comparison where one is meaningful and an after-only preview where it is
  not (a page subset, a different layout, a non-PDF archive member).
- **AC:** Cancelling writes nothing. A render failure is disclosed to the user, not
  silently blank with Save still available.

### UX-04 · Route every export through a mandatory review — `M` `P1`

**Status: Done** — `TOOLS_WITH_EXPORT_REVIEW` names every handler in `commit.ts` whose
output routes through `reviewAndSave`/`reviewAndSaveZip`/`reviewOnly` before `save()` ever
writes a byte, so the action bar can tell the user up front that its commit button shows a
preview first rather than saving immediately, without duplicating each handler's own logic
to find out.

**Audited and hardened (2026-09-14) — four real bugs found and fixed:**
1. `save()` unconditionally re-anchored the diff baseline (`refreshBaseline`) to the
   current page list after *any* successful write — including a ZIP export
   (pdf-to-images, extract-images, split-to-zip), a page-subset extract, or the contact
   sheet, none of which write out `doc.pages` as a real document. Rotate or delete pages,
   export to an image ZIP, then export the real PDF, and the review would have compared
   `doc.pages` against itself and reported nothing changed for edits that were never
   actually written anywhere. `save()` and `reviewAndSave()` now take a
   `refreshesBaseline` flag, false for every one of those non-representative paths.
2. The same non-representative paths could also trigger "Save over original" (offered
   whenever the document has a writable file handle), letting the user silently overwrite
   their real PDF with a ZIP or a page subset. Gated off by the same flag — when
   `refreshesBaseline` is false, "save over original" is never offered, only "save as a
   new file."
3. `split` is in `TOOLS_WITH_EXPORT_REVIEW` — the action bar tells the user a preview
   comes first — but extract mode wrote straight to disk, the one branch of it that
   bypassed the dialog entirely. Now goes through `reviewAndSave` like the tool's other
   branches (after-only, since a page subset has no 1:1 "before"). `tests/e2e/tool-flows.spec.ts`
   › "split: extracting a selection shows a review before saving".
4. Deleting every page (`deletePages` has no last-page guard — select-all-and-delete is a
   legitimate way to clear a document before starting over) hit `composeDocument`'s own
   internal "there are no pages to export" error, which surfaced as a generic "something
   went wrong inside Stapler, file an issue" dialog for an entirely ordinary state. Caught
   once, centrally, in `commitTool`, before any handler runs, with a plain "Nothing to
   export" message. `tests/e2e/tool-flows.spec.ts` › "deleting every page shows a clear
   message, not a crash dialog".

- **Requirements:** Every tool that writes a file shows the user what it is about to
  write first, unless the output can't meaningfully be diffed (in which case an
  after-only preview still appears) — never a silent write.
- **AC:** No handler named in `TOOLS_WITH_EXPORT_REVIEW` writes a file without the dialog
  having appeared and been confirmed first, regardless of output shape (single PDF, ZIP,
  page subset, or derived layout).

### UX-05 · Discard all changes — `S` `P1`

**Status: Done** — `ui/discardAllChanges.ts`'s `confirmAndDiscardAllChanges` reverts a
document's page structure to its baseline (rotate/reorder/delete/duplicate since the last
import or save) and clears crop, watermark/header-footer/Bates/barcode, N-up, this
document's loaded outline, redaction marks, and page annotations — all in one confirmed
action. Rendered on every tool's action bar, not folded into Organize's panel, since a
rotation, a crop box, and a watermark are all "changes to this document" regardless of
which panel happens to be open when the user wants out of all of them at once.

**Audited and hardened (2026-09-14) — two real bugs found and fixed:**
1. The button was unconditionally enabled whenever a document was open and not busy,
   popping a "danger" confirmation dialog for a click that would have discarded nothing on
   a freshly-opened, untouched document. `hasAnythingToDiscard()` now checks, read-only,
   every source the action actually touches (page-structure change, crop boxes, page
   annotations, watermark/header-footer/Bates/barcode content, N-up, this document's
   loaded-and-edited outline, pending redaction marks), and the button only renders when
   at least one of them has something to revert. `tests/e2e/discard-all-changes.spec.ts`
   › "is not offered on a freshly opened document with nothing to discard".
2. `confirmAction`'s `confirmRequest` is a single global signal (`core/notify.ts`); a
   second call before the first resolves replaces it outright, silently orphaning the
   first `await` forever — its `resolve` is never called once the dialog is showing the
   *second* request instead. A fast double-click, before the modal had actually mounted to
   swallow further clicks, was exactly that. Guarded with a module-level in-flight flag,
   so a second call while one is pending is a no-op rather than a stuck promise.
   `tests/unit/discardAllChanges.test.ts` › "a second call while the first is still
   awaiting confirmation is a no-op, not an orphaned promise".

- **Requirements:** One confirmed action that reverts page-structure edits and clears
  every other pending, workspace-wide edit at once, reachable from any tool screen.
- **AC:** Offered only when there is something to discard. A fast double-invocation
  cannot orphan the confirmation or fire the reset twice.

### UX-06 · Organize's shortcut into Crop — `XS` `P1`

**Status: Done** — `OrganizePanel.tsx`'s "Crop…" button jumps to the Crop tool scoped from
whatever is currently selected in the page grid: nothing selected sets Crop's scope to
`all`; exactly one page selected sets it to `current` and moves the single-page view to
that page. Crop's own scope model (`current`/`all`/odd/even) has no notion of an arbitrary
multi-page selection, so rather than inventing one, an in-between selection (more than one
page, fewer than all) just disables the button — an honest limit, stated in the code
rather than silently guessed at. Shipped in the same commit as UX-01–04 (2026-09-12) but
never named in its commit message and, like the rest of this epic, never ticketed until
now; unlike the rest of this epic it also had no test coverage at all before this pass.

**Audited and hardened (2026-09-14):** selecting one page and clicking "Crop…" correctly
set `cropSettings.scope` to `current`, but landed on whatever page the single-page view's
own local state last held — not the page that had actually been selected — because of the
`activePageIndex` bug DS-04's amendment above describes in full (this shortcut is one of
its two writers, and the one that surfaced it first). Fixed by that same change.
`tests/e2e/organize-crop-shortcut.spec.ts` (new) covers all three cases: nothing selected,
one page selected, and the disabled in-between state.

- **Requirements:** A single click from Organize into Crop, scoped to the current
  selection where Crop's scope model can express it, disabled where it cannot.
- **AC:** Nothing selected scopes to all pages; exactly one page selected scopes to and
  visibly lands on that page; any other selection size disables the shortcut rather than
  guessing.

---

## EPIC-18 · Product gaps from AUDIT-2026-09-25

The ten product gaps of the 2026-09-25 robustness audit (GAP-2…GAP-12), turned into
tickets (2026-09-26); the audit's 98 findings and root causes are kept as requirements
in EPIC-19 (HRD-40…HRD-55). GAP-1 ("Done means works in the shipped build") is not a
ticket of its own:
it is the extension e2e project, CI on `master` and the post-build network scan that
already landed with the audit fixes, and it is recorded on the tickets it reopened (DS-07,
CNV-03, NFR-02, NFR-04, QA-03, QA-04, DIST-03, ACC-02, DOC-12, OPS-13). Every ticket here
respects PLAN §1.1 — nothing below edits text in place, removes a password, adds an
account or phones home. Same hard invariants and definition of done as every other epic;
in particular **no new manifest permission** (the omnibox key and the web app manifest
are checked against Chrome's install dialog) and **no new runtime network request** (the
web twin's service worker precaches same-origin build output only).

### DIST-06 · Installable, offline-capable web twin (PWA) — `M` `P1` · GAP-2

**Status: Done (2026-10-02) in code and CI; not verified on a device** — service worker precaches the web build (same-origin only, cross-origin requests untouched), `manifest.webmanifest` with `file_handlers` + `launchQueue` and a `share_target`; offline reload + import, share POST and manifest checks pass in e2e. AUDIT-2026-10-01 found "never swaps code under an open document" unmet; fixed (HRD-63): hashed entry names, cache-first pages from the controlling worker's own cache with SHA-256-checked installs (PLT-1), an update in one tab keeps the old cache until its clients are gone and other tabs are told (PLT-4), a 3 s network-fallback timeout (PLT-6), a confirmed "Open N shared files?" for shares the worker cannot trace to this origin and rejection of cross-site ones (PLT-3), and a worker-side network guard (PLT-2). Not verified here: Lighthouse installability, a real OS "Open with" launch, a real Android share sheet (manual step in RELEASE_CHECKLIST.md).

The web twin is branded "Offline PDF tools" and is the only path for locked-down
machines and phones, yet it has no service worker and no web app manifest.

- **Requirements:** A same-origin precaching service worker whose file list is generated
  at build time (no Workbox CDN, no runtime fetch to any other origin); a
  `manifest.webmanifest` with icons, `file_handlers` + `launchQueue` ("Open with Stapler"
  for PDFs and images) and `share_target` (Android share sheet); an update flow that
  never swaps code under an open document without asking. Web build only — the extension
  build ships neither file.
- **AC:** After one online visit, the web twin loads and runs a merge and a compress with
  the network disabled (Playwright `context.setOffline(true)`). Lighthouse's installability
  check passes. Opening a PDF via the OS "Open with" / share sheet lands it in the
  workspace. The zero-network e2e still passes (the service worker makes no cross-origin
  request). `dist/ext` contains no service-worker registration or web manifest.

### DIST-07 · Automated release packaging — `S` `P1` · GAP-8

**Status: Done (2026-10-02) in CI; not yet run on a real tag** — `.github/workflows/release.yml` on `v*` tags builds once (version check first), then runs check/test, the bundle network scan, web and extension e2e, perf, and `e2e-web-shipped` (the unzipped shipped web zip: no test hooks, zero-network, offline and share specs) against those exact artifacts, and creates a **draft** GitHub Release with the Chrome, Firefox and web zips, a `.sha256` per zip and `SHA256SUMS`. AUDIT-2026-10-01's gaps (no web zip, no `--draft`, no per-file `.sha256`, rebuild instead of shipping the tested bytes, `perf` not in `needs`, RELEASE_CHECKLIST.md describing a manual release) are fixed (PLT-7, HRD-63); RELEASE_CHECKLIST.md points at the workflow.

Release packaging was a 277-line manual checklist with a hand-made zip that included
sourcemaps. `pnpm package` (build ext / firefox / web → strip maps → zip → SHA-256) landed
with the audit fixes (PLT-13); the tag-triggered workflow did not.

- **Requirements:** A GitHub Actions workflow triggered by a `v*` tag that runs the full
  CI gates, then `pnpm package`, and attaches the Chrome, Firefox and web zips plus their
  SHA-256 sums to a draft GitHub release. The manifest `version` must equal the tag.
- **AC:** Pushing a test tag produces a draft release whose zips contain no `*.map` file,
  whose checksums match the attached `.sha256` files, and whose manifest version matches
  the tag; a mismatched version fails the workflow. `RELEASE_CHECKLIST.md` points at the
  workflow instead of the manual zip steps.

### DS-10 · Phone-width layout — `M` `P1` · GAP-3

**Status: Done (2026-10-02)** — tools sheet below 600px, icon trust chip, opaque pinned options sheet, shortcut hints hidden on coarse pointers; `tests/e2e/mobile.spec.ts` (360/390/414px, four locales, axe on key screens, light + dark) passes. AUDIT-2026-10-01's AC gaps are closed: `tests/e2e/mobile-export.spec.ts` walks Home → a tool → options → export and checks the saved file, with confirm and review dialogs stacked above the sheet; the options sheet no longer covers the preview or the grid below 1100px (the canvas reserves the sheet's measured height); the rail's hidden labels no longer stretch the layout at tablet width; the pager wraps at phone width so zoom-in stays on screen. The tooltip Escape race that made `mobile.spec.ts` flaky under load is fixed (UI-11, HRD-65).

At 390px the trust chip is clipped, the icon rail takes ~15% of the width, the Compress
options sheet overlaps the preview with text showing through, the ⌘K hint shows on touch
devices — and the trust panel itself renders *under* the options sheet (seen while
building DS-12).

- **Requirements:** Below 600px, tools in a sheet instead of a permanent rail; an opaque
  options sheet with correct z-order under every modal; the trust chip collapsed to an
  icon with the same accessible name and tooltip; shortcut hints hidden on
  `(pointer: coarse)`. Both themes, keyboard operable.
- **AC:** A mobile Playwright project (390×844, touch) walks Home → a tool → options →
  export with no horizontal scroll, no overlap between the options sheet and the preview,
  every modal above every sheet, and an axe pass with no serious violations.

### DIST-08 · Compress-to-size landing pages — `S` `P1` · GAP-4

**Status: Done (2026-10-02)** — five web-only pages (100 KB, 200 KB, 500 KB, 1 MB, custom) deep-link into Compress "Aim for a size" via `#/tool/compress?target=…`; the same link works in the extension editor. AUDIT-2026-10-01 copy gaps fixed (HRD-64): "Reached" is gated on the final written size with Protect's overhead included (IMG-5), and a missed size is rounded up so "unreachable" never shows the target as the result (IMG-3); the Compress field shares the deep link's 10 KB minimum (IMG-12). Tests: `tests/unit/size-honesty-commit.test.ts`, `tests/unit/bytes-and-size-guard.test.ts`. Landing-page copy is English only, like the existing landing pages.

"Compress PDF to 100 KB" is the top search intent and has no landing page, although
DOC-07 already compresses to a target size.

- **Requirements:** 2–4 static landing pages (100 KB, 200 KB, 1 MB, custom) in the DIST-03
  pattern that deep-link into Compress with the target pre-filled via a URL parameter;
  the parameter is validated (bounds, units) and ignored when malformed. Copy follows
  PLAN §5.5: it says when a target cannot be reached instead of promising it.
- **AC:** Each page builds into `dist/web` only, has its own title/description/canonical
  and a sitemap entry, and opening it with a PDF selected lands in Compress with that
  target set; an unreachable target reports the smallest size achieved and never emits a
  file larger than the input (CMP-04).
- **2026-10-06:** the five pages are generated from one copy, not five files:
  `COMPRESS_TARGET_SIZES` in `src/landing/pages.ts` lists the fixed sizes, and every
  size-specific string (title, description, FAQ, hero, "Other target sizes" links,
  `data-compress-target`) is written once with the size substituted; the pick-your-own
  page is a separate entry sharing the common cards and FAQ. See DIST-03's 2026-10-06 note.

### CNV-14 · Image target size and resize output — `M` `P2` · GAP-5

**Status: Done (2026-10-02)** — PDF→Images "Aim for a file size" + longest-side limit, and a new "Image to size" tool; bounded JPEG quality/scale search in workers, cancellable, per-image fits/over report; e2e measures outputs byte-for-byte. AUDIT-2026-10-01 gaps fixed (HRD-64, HRD-69): an exact width × height in both tools, aspect-locked by default, with output pixels exact on the decoded files and an unlocked edit kept on re-lock (`tests/unit/cnv14-exact-size.test.ts`); one area and one per-side limit (`render-limits.ts`) checked before any canvas is allocated (`tests/unit/cnv14-exact-limit.test.ts`); "longest side at most N" never gives N+1 px (IMG-6); misses say by how much; TIFF orientation is applied (IMG-9); an original that already fits is never replaced by a bigger re-encode (IMG-1); dimensions come from the file header.

Portals ask for "a photo under 20 KB" or a fixed pixel size.

- **Requirements:** Reuse DOC-07's search loop over JPEG quality and scale to hit a byte
  target, plus an explicit width/height (aspect-locked) option, in PDF → Images and as a
  single-image mode. Work in a worker, cancellable, with determinate progress.
- **AC:** A fixture photo exported with a 20 KB target comes out ≤ 20 KB (bytes checked),
  or the tool says the target is unreachable and by how much; requested pixel dimensions
  are exact; EXIF orientation is applied before resizing.

### OPS-19 · Grayscale / black-and-white — `S` `P2` · GAP-6

**Status: Done (2026-10-02)** — vector-preserving grayscale (colour operators, images, patterns, forms, annotations) with per-page raster fallback that is reported, 1-bit B&W for scans. AUDIT-2026-10-01 found three AC gaps, all fixed (HRD-61, HRD-64): a page rasterised for an annotation kept its colour annotation on top and passed verification (PDF-2: raster pages now render annotations and count as colour left, `tests/unit/grayscale-audit.test.ts`); growth was saved with only a warning (UI-OPS19: growth is warned with both sizes, including Protect-only growth, and the export review shows both before writing; it warns rather than blocks by design); and "offered as a compression lever for scans" was missing — Compress now has a Colour option (Keep colour / Shades of grey / Black and white), compresses first, and never saves a file larger than the input (grey not smaller → the colour-compressed file; that not smaller → the original), naming pages it could not convert (`tests/unit/ops19-compress-gray.test.ts`). The option is not applied to compress-to-target-size. Text is not extractable on rasterised pages (disclosed in the UI). Batch recipes don't include it yet.

- **Requirements:** Convert pages to grayscale, or threshold to 1-bit black and white, as
  a page tool; images are re-encoded, vector/text colours mapped to gray; also offered as a
  compression lever for scans.
- **AC:** On a colour fixture every sampled output pixel has R = G = B (grayscale) or is
  pure black/white (B&W); text stays extractable; a "compress" use never outputs a file
  larger than its input.

### OPS-20 · Duplex interleave — `XS` `P2` · GAP-6

**Status: Done (2026-10-02)** — "Duplex scan" in Merge and Organize, reverse-backs on by default, unequal counts warned and nothing dropped; undoable. The AC's "verified by text on each output page" is now checked on the saved PDF (`tests/e2e/duplex-merge.spec.ts`), and the interleave button is disabled until the order changes, so a second press can no longer scramble it (AUDIT-2026-10-01 UI-8, HRD-65, `tests/unit/ui-audit-2026-10-01.test.ts`).

- **Requirements:** Merge an odd-pages scan and an even-pages scan into one document, with
  a "reverse the even pages" option (sheet-feeder order). Pure page-order logic on page
  refs — no re-encode, undoable.
- **AC:** 5 odd + 5 even pages (even reversed) produce pages 1–10 in order, verified by
  text on each output page; unequal counts are explained, not silently padded.

### DOC-13 · Repair — `S` `P2` · GAP-6

**Status: Done (2026-10-02)** — tolerant re-save with salvage, verified in pdf.js and pdf-lib before it is offered; a PDF refused as corrupt gets a "Try to repair" toast action. AUDIT-2026-10-01 found three AC failures, all fixed (HRD-61, HRD-65, HRD-68): an encrypted file with a lost trailer was "repaired" into ciphertext (PDF-1: also refused on a security-handler dict or a raw `/Encrypt` outside stream data, `tests/unit/repair.test.ts`); an intact file with obj-like text in a stream was reported damaged (PDF-3: salvage only on evidence of damage, outside stream ranges; eleven intact fixtures round-trip as already valid with unchanged text, `tests/unit/repair-intact.test.ts`, `tests/e2e/repair-intact.spec.ts`); and the open document's edits were dropped (UI-3: an untouched document is repaired from its raw file, an edited one from its own pages, rotations, crops and annotations, never with panel settings, `tests/unit/size-honesty-commit.test.ts`).

- **Requirements:** Re-save a damaged PDF through the tolerant parser (xref rebuild,
  dropped broken objects) and report what was fixed. Never claims success for a file it
  could not load; never alters page content beyond what the report lists.
- **AC:** The QA-01 truncated/corrupt fixtures either come out loadable by pdf-lib *and*
  pdf.js with a report naming the repairs, or are refused with a specific reason; an
  intact file round-trips with an "already valid" report and unchanged page text.

### DS-11 · Discoverability: omnibox, What's new, rail labels — `S` `P2` · GAP-7

**Status: Done (2026-10-02)** — `pdf` omnibox keyword (no permission, `permissions: []` asserted), What's-new page on version update (stored outside `chrome.storage`), rail tooltips on hover and focus with grouped sections. Re-audited 2026-10-01 with no AC gap; the rail tooltip now meets WCAG 1.4.13 (hoverable bubble with a hide delay, a static hidden summary per rail item for `aria-describedby`; AUDIT-2026-10-01 UI-11, HRD-65). Omnibox suggestions are English only (the service worker cannot load locale chunks).

- **Requirements:** An `omnibox` keyword that opens a tool by name (manifest key, no
  permission); a "What's new" page opened from `onInstalled` with reason `update`
  (never on install, which already opens the welcome); rail labels shown on hover and
  keyboard focus, grouped like the home page.
- **AC:** `manifest.json` still has empty `permissions` and Chrome's install dialog shows
  no warning (F-02's e2e still passes); typing the keyword + a tool name opens that tool;
  an update (not an install) opens What's new once; every rail item exposes its label on
  focus to a screen reader and visually.

### DOC-14 · Storage persistence and quota warnings — `S` `P2` · GAP-9

**Status: Done (2026-10-02)** — persistence requested once after the first real save or model download, usage/quota and persistence state in the trust panel, one-time warnings when denied or near quota. "Never asked again" no longer depends on an IndexedDB write succeeding: a per-session flag stops a re-ask, and no toast shows when the outcome could not be recorded (AUDIT-2026-10-01 RT-9, HRD-62, `tests/unit/local-data.test.ts`).

Everything kept between visits (the session-recovery record and the OPFS bytes it points
at, downloaded OCR models, signatures) lives in best-effort storage the browser may evict.

- **Requirements:** Request `navigator.storage.persist()` once — after the first
  successful session save or OCR model download — and remember the outcome in the
  `settings` store so the browser is never asked again on its own; skip the request when
  `persisted()` is already true (typical for extension pages); treat a non-boolean answer
  as "unsupported". Show `storage.estimate()` usage/quota and the persistence state in
  the trust panel, with a manual "Ask the browser to keep this data" retry. Warn (toast,
  translated) once when persistence is denied, and once per session when usage reaches
  80% of the quota.
- **AC:** Unit tests prove: one request per profile (concurrent triggers share it, a
  remembered denial is reused in a later session with no prompt and no toast), no
  request when already persistent or unsupported, the first *non-empty* session save
  triggers it, the manual retry asks even after a denial, and the quota warning fires
  once at ≥80% and is rate-limited.
- **Implementation:** `src/core/storage-persistence.ts` (`requestPersistenceOnce`,
  `requestPersistenceNow`, `checkStorageHeadroom`, `noteSessionSaved`,
  `noteModelStored`), called from `session-recovery.ts` `saveSession` (only when the
  record write succeeded — `writeSetting` now returns whether it did) and from
  `ocr/runOcr.ts` after a model is recorded. Tests: `tests/unit/local-data.test.ts`.
  Known limit: Chrome decides `persist()` silently from site engagement, so most
  first-time web visitors get "denied" and see the one-time warning.

### ACC-04 · Read-aloud basics — `S` `P2` · GAP-10

**Status: Done (2026-10-02)** — one utterance per sentence with sentence highlight (word highlight when the voice fires `boundary`), remembered voice and rate, in-panel keyboard control, polite live status; local voices only. AUDIT-2026-10-01 gaps fixed: a remembered voice that is no longer installed (or is now a network voice) falls back with a notice (`tests/unit/ui-audit-2026-10-01.test.ts`), and voice and rate surviving a reload has an e2e (`tests/e2e/read-aloud-preferences.spec.ts`). Read-aloud defects UI-1, UI-2, UI-4 and UI-10 are fixed (HRD-65). Real voices' `boundary` behaviour checked only with a scripted voice.

- **Requirements:** A voice picker listing only local voices (`localService === true`,
  ACC-02/PLT-5); sentence highlighting driven by the utterance `boundary` event; the
  chosen voice and rate remembered locally (and removed by DS-12's clear-all).
- **AC:** No network voice is ever offered or used; the highlighted sentence tracks
  playback on a multi-sentence fixture; voice and rate survive a reload; a remembered
  voice that is no longer installed falls back to the default local voice with a notice.

### DOC-15 · Per-document undo and an open-document cap — `M` `P1` · GAP-11

**Status: Done (2026-10-02)** — each document has its own undo/redo stack (50 steps per document, 400 total); opening and closing are no longer undo steps; history-aware source liveness and recovery kept (old records migrate by dropping history); 20-document cap and a 1.5 GiB soft-limit confirmation. AUDIT-2026-10-01 gaps fixed (HRD-62, HRD-68): undo past a save no longer marks the document clean (RT-1: `rebaseHistory()` on save, `dirty` recomputed, an annotation added mid-save stays unsaved); Repair's "Open repaired" is refused at the cap with a message and opens one copy on double-click (RT-2); restored sessions and redo stacks obey the cap and `MAX_TOTAL_SNAPSHOTS` (RT-6, RT-7). Tests: `tests/unit/runtime-audit-2026-10-01.test.ts`.

G1/G2 from earlier audits. RT-2, RT-3 and RT-6 all came from one global undo stack shared
by every open document.

- **Requirements:** One undo/redo history per document, serialised per document in the
  session-recovery record; closing a document drops only its own history and bytes;
  opening a file never touches another document's history. A ceiling on open documents
  (and/or total pages) with a clear message instead of an out-of-memory tab.
- **AC:** Edit A, edit B, Ctrl+Z on A undoes only A's edit and B's history is intact;
  closing B leaves A fully undoable; a restored session restores each document's own
  history; opening past the cap is refused with a message naming the limit; the RT-2/RT-3/
  RT-6 regression tests still pass.

### DS-12 · "Stored on this device" and Clear all local data — `M` `P1` · GAP-12

**Status: Done (2026-10-02)** — "Stored on this device" list with per-category clear, and "Clear all local data" (refused while a job runs or another tab is open; lists what goes; reloads to a clean state). AUDIT-2026-10-01 gaps fixed (HRD-62, HRD-63): OPFS failures are counted and shown as a partial clear (RT-3); the other-tab check runs again after the confirm (RT-4); the tesseract-cache open is bounded (RT-5); the `stapler-meta` database and the `stapler-share-inbox` cache are deleted (RT-8, PLT-5). Tests: `tests/unit/runtime-audit-2026-10-01.test.ts`, `tests/unit/local-data.test.ts`, `tests/e2e/local-data.spec.ts`. Known limit: the web-twin precache survives (app code, not user data).

"Nothing is uploaded" is half the privacy story; the trust panel never said what *is*
kept locally, and the only way to delete it was the browser's own "clear site data" —
which is also how RT-4's pre-redaction originals were meant to be cleaned up.

- **Requirements:** The trust panel lists what Stapler keeps, with counts and sizes:
  open/recoverable documents in OPFS, OCR language models (tesseract's cache and uploaded
  copies), saved signatures and initials, Recents file handles, presets and recipes, the
  folder-search index, settings/shortcuts/session record. Per-category clear where cheap
  (OCR models, signatures, Recents, search index). One "Clear all local data" button that
  confirms as a danger action listing exactly what will be deleted, says open documents
  will be closed and unsaved changes lost, is refused while a job runs or another Stapler
  tab is open, clears OPFS files, the IndexedDB stores, tesseract's cached models and the
  app's localStorage keys — only Stapler's own entries, since the web twin's origin can be
  shared — then reloads so no in-memory state survives. Both themes, keyboard operable,
  stacked over the trust panel.
- **AC:** A web e2e stores a session (imported document) and a signature, clears all from
  the trust panel, and after the reload: no restore prompt, no session record, no
  `*.pdf` in OPFS, no signatures (in IndexedDB or the Sign panel), and a second reload
  still restores nothing. Unit tests prove the breakdown, that clear-all removes every
  Stapler file/store/key and nothing else, the in-memory fallback is cleared, and the
  confirmed flow's refusals (busy, another tab), cancel, autosave suspension, and a clean
  startup recovery afterwards.
- **Implementation:** `src/core/local-data.ts` (report + `clearAllLocalData`),
  `src/ui/clearLocalData.ts` (confirmed flows), `src/ui/components/LocalDataSection.tsx`
  (in `TrustModal`); helpers in `db.ts` (`readStaplerDbStats`, `clearStaplerStores`),
  `opfs.ts` (`listStoredFiles`, `clearStaplerFiles`, `otherStaplerTabsOpen`),
  `ocr/tesseractCache.ts` (`listCachedModels`, `clearCachedModels`), `signatures.ts`
  (`clearSignatureLibrary`), `session-recovery.ts` (`suspendAutosave`); `ConfirmDialog`
  gained an optional bullet list. Tests: `tests/unit/local-data.test.ts`,
  `tests/e2e/local-data.spec.ts`. Known limits: the "disclosed downloads" count is not
  storage and simply resets with the reload; a web-twin precache (DIST-06) is app code,
  not user data, and is not cleared; granted persistence cannot be revoked by a page.

---

## EPIC-19 · Hardening requirements from the audits

Every finding of the five audits — AUDIT-2026-08-17, AUDIT-FINDINGS (opened 2026-08-16,
extended 2026-08-17 and 2026-09-15), AUDIT-EDGE-CASES-2026-09-15, AUDIT-2026-09-25 (a
whole-codebase robustness audit of v0.2.1 whose 98 findings all passed `pnpm check` and the
full test suite) and AUDIT-2026-10-01 (54 findings over the EPIC-18 tickets plus a repo-wide
pattern sweep) — and of their post-fix reviews, recorded as lasting requirements. The audit
documents themselves were removed; this epic is where their findings live. A finding that
belongs to one ticket's acceptance criteria is recorded on that ticket's Status line; the
tickets here hold what spans tickets or has no ticket of its own. Each requirement starts
with its original tag (for example `AUDIT-2026-09-25 RT-14`, `AUDIT-FINDINGS §4`,
`AUDIT-EDGE-CASES-2026-09-15 §1.1`), which is what code comments and tests cite, so
`grep -r "<ID>"` leads from a requirement to its fix and regression test (some comments
spell the tag `Audit 2026-10-01 <ID>`, add a file suffix to the edge-case tag, or cite the
bare ID). IDs restart per audit: `AUDIT-2026-09-25 PDF-1` and `AUDIT-2026-10-01 PDF-1` are
different findings. AUDIT-2026-08-17 has two numbering schemes (`§2 R#N` is its remediation
table's "Finding #N", `§3 #N` its §3 list; for example R#17 = §3 #15 = F-03);
AUDIT-FINDINGS sub-tags `§N.k` number a section's findings in document order and §14 keeps
its C/H/M/L/G numbering; the unnumbered edge-case bullets are numbered in document order
(`§3 #1` …); AUDIT-2026-09-25 severity maps to priority as 🔴/🟠 → `P0`, 🟡 → `P1`,
⚪ → `P2`. Each requirement says what must hold, and "was:" records the defect it replaced.
Status reflects the code as of commit `c3a8994` (2026-10-05), not the audits' own check-marks. Same hard
invariants and definition of done as every other epic.

### HRD-01 · Release gates pass on a clean tree, and measure the real thing — `S` `P0`

**Status: Done (re-verified 2026-10-05)** — `pnpm check` passes, `check:tokens`/`check:invariants` find no raw colours, the bundle gate measures the editor graph, and CI runs on `master`. Open: none. QA-02's Status now carries the current test count.

On 2026-08-17, `pnpm check` failed on a clean `master`. Several gates also passed while
measuring nothing. A gate that cannot fail is worse than no gate, because it certifies the
build anyway.

- **Requirements:**
  - **AUDIT-2026-08-17 §0 baseline #3** / **§2 R-gate**: `pnpm check` passes on a clean tree. Was: 5 `rgb()` literals in `src/core/text-diff-export.ts`, which broke the release-gate AC of F-01, DS-01 and DIST-05. Diff colours now come from the central document-colour constants.
  - **AUDIT-2026-08-17 §3 #14** / **§2 R#15**: the 900 KB gzip budget measures the complete statically imported editor graph (`scripts/check-bundle-size.js`). Was: it measured a 0.26 KB entry stub and could never fail.
  - **AUDIT-2026-08-17 §3 #35**: the zero-network e2e and the full suite run in CI on every push and PR (`.github/workflows/ci.yml`; later extended by DIST-07). Was: no CI existed, although the README claimed it did.
  - **AUDIT-2026-08-17 §3 #39** / **§2 R#41**: `RELEASE_CHECKLIST.md` ships with every per-release box unticked, and its own gate (`pnpm check` clean) can pass. Was: the QA-05 box was pre-ticked.
  - **AUDIT-2026-08-17 §3 #33** / **§2 R#35**: DS-02's contrast results are committed (`docs/CONTRAST-AUDIT.md`, from `scripts/check-contrast.mjs --markdown`).
  - **AUDIT-2026-08-17 §3 #34** / **§2 R#36**: every URL that `robots.txt` advertises exists in `dist/web` (`sitemap.xml`). Was: masked locally because the SPA fallback returns 200 for any path.
  - **AUDIT-2026-08-17 §3 #38** / **§2 R#40**: any test count or measured number quoted in `TICKETS.md` is either current or dated. Was: "196 unit tests across 13 files" against a real 609/56, and a "0.0% surgical" CMP-05 projection that re-measured at 5.8%. **Regressed:** QA-02 again says "610 unit tests across 56 files" (176 unit files today).
  - **AUDIT-2026-08-17 §3 #29** / **§2 R#31**: comments about save options match the code. Was: `linearize.ts` claimed most saves pass `useObjectStreams: true` when none did. Today all 16 `process.worker.ts` save sites pass `true` (see DOC-05).
  - **AUDIT-2026-08-17 §3 #36** / **§2 R#38**: no `TODO(<ticket>)` marker survives in a ticket the status calls finalized (the `gecko.id` TODO).
- **AC:** On a fresh clone, `pnpm check && pnpm test` pass. A raw colour added anywhere outside `tokens.css` fails `pnpm check`. Bloating the editor graph past 900 KB gzip fails the bundle gate. CI runs all three gates on a PR.

### HRD-02 · Redaction hardening from the 08-17 bug hunt — `M` `P0`

**Status: Done (re-verified 2026-10-05)** — every item holds in code. R#2 has since been superseded by a stronger behaviour (see below). Open: none.

The audit's §4 put these first because of their privacy and legal consequences. They are
listed only in the remediation table (R#8 was never listed).

- **Requirements:**
  - **AUDIT-2026-08-17 §2 R#1**: redacted output carries no `/Outlines`, so copying bookmarks cannot pull source page dictionaries back into the file. Test: `tests/unit/process.test.ts` › "drops source outlines from redacted output". The loss is disclosed in `RedactPanel` (AUDIT-EDGE-CASES §3 #5, HRD-36).
  - **AUDIT-2026-08-17 §2 R#2**: a mark that partly overlaps a Form XObject never deletes the whole form. Was: the whole form was deleted, losing unmarked content. The 08-17 fix refused instead. Since AUDIT-EDGE-CASES §3 #4 (HRD-36), the form's own content is filtered, and it refuses only when that content can't be read (`process.test.ts` › "filters inside a partly covered Form XObject rather than deleting the whole form").
  - **AUDIT-2026-08-17 §2 R#3**: redaction materialises a page-local `/Resources` before deleting XObject entries, so a shared image is never removed from sibling pages (`process.test.ts` › "does not delete a shared XObject dictionary from sibling pages").
  - **AUDIT-2026-08-17 §2 R#4**: pointer coordinates go through the page rotation before a mark is stored, so marks land on the displayed content on `/Rotate 90/270` pages (`tests/unit/redact-polygon.test.ts` › "maps a rectangle's own four corners to that rectangle at …°").
  - **AUDIT-2026-08-17 §2 R#5**: text search, pattern suggestions and signature-line detection map text runs through the viewport corners. Was: raw x/y shortcuts on rotated pages.
  - **AUDIT-2026-08-17 §2 R#9**: the redaction unit test proves the removed text is absent from the decoded page stream, not merely that the bytes changed.
  - **AUDIT-2026-08-17 §2 R#10**: the verifier checks text against rotation-aware character boxes. Was: a top-left shortcut that rotated or skewed text escaped.
  - **AUDIT-2026-08-17 §2 R#11**: the page-text helper throws when stream inflation fails. Was: a decode failure read as an empty page, which passed verification.
- **AC:** On a `/Rotate 90` fixture, a mark drawn over a word removes exactly that word: absent from the inflated content stream, verifier passes. A shared image on page 2 survives a redaction on page 1. A stream that fails to inflate fails verification instead of passing it.

### HRD-03 · Tests fail on the bug they guard; no test hook ships — `S` `P0`

**Status: Done (re-verified 2026-10-05)** — Open: none from this audit. The general rule recurs as M7/M8 in AUDIT-2026-09-25.

A test that passes on broken output certifies the bug. Several 08-17 "Done" verdicts
rested on tests of that kind.

- **Requirements:**
  - **AUDIT-2026-08-17 §3 #13**: an assertion band matches its AC. Was: CMP-02 accepted `>0.7 && <0.95` against a stated 70–90% reduction. Now `<0.9` (`tests/e2e/tool-flows.spec.ts` › "compress: CMP-02 raster path reduces scanned fixture by 70-90%").
  - **AUDIT-2026-08-17 §3 #31**: export tests assert content, not just length or count. Was: `annotation-summary.test.ts` and `visual-diff-export.test.ts` would pass on an all-white export. Both now assert real content and embedded XObjects.
  - **AUDIT-2026-08-17 §3 #32**: a test's comment and docstring match its assertions. Was: "< 200MB" in the comment against `< 300` in the code, and a "three-file" docstring over a two-file test. Now `tests/e2e/perf.spec.ts` › "NFR-03: processes heavy documents within memory limits" asserts three readings, each < 200 MB.
  - **AUDIT-2026-08-17 §2 R#16**: a benchmark drives the real UI flow it names. The 10×5MB merge goes through the merge panel into one workspace document (`perf.spec.ts` › "merges 10 × 5MB PDFs within 8 seconds").
  - **AUDIT-2026-08-17 §3 #30** / **§2 R#32**: no test backdoor is reachable in a release build. Was: `window.__mockClipboardImage` was read before the real clipboard in shipped code. Now it is gated behind the `VITE_E2E_TEST_HOOKS` build flag, which `scripts/package.mjs` and the extension e2e build keep out of release output.
- **AC:** Reverting any one listed fix makes its named test fail. `grep -r __mockClipboardImage dist/ext dist/web` after `pnpm package` finds nothing.

### HRD-04 · Tab focus with zero permissions, on every browser — `S` `P0`

**Status: Done (re-verified 2026-10-05)** — `service-worker.ts` uses `runtime.getContexts`. The Firefox manifest adds no permission. Open: none. Firefox < 127 opens a new tab per click by design (AUDIT-EDGE-CASES §4 #5, HRD-38).

- **Requirements:**
  - **AUDIT-2026-08-17 §3 #15** / **§2 R#17**: the toolbar click finds and focuses the existing editor tab without the `tabs` permission. Was: `chrome.tabs.query({url})` silently returned `[]` without `tabs`, so every click opened a new tab. Tests: `tests/unit/service-worker.test.ts` › "focuses the existing tab via getContexts when it is available", "opens a fresh tab when getContexts finds nothing", "falls back to opening a fresh tab when getContexts does not exist (pre-127 Firefox)".
  - **AUDIT-2026-08-17 §3 #25** / **§1 DIST-04**: the Firefox manifest transform changes only `browser_specific_settings` and the background shape. Permissions, CSP and icons match the Chrome manifest exactly. Was: `transformManifestForFirefox` added `tabs`, and its own test asserted that. Test: `tests/unit/firefox-manifest.test.ts`.
- **AC:** Both built manifests have `permissions: []`, no `host_permissions` and no `optional_permissions`. Two toolbar clicks in a loaded Chrome build leave one editor tab, focused.

### HRD-05 · No silent data loss on import or export — `M` `P0`

**Status: Done (2026-10-05)** — N IFDs → N pages is proven on a committed 3-page fixture: `tests/fixtures/multipage.tiff` and `tests/unit/tiff-multipage.test.ts` › "decodes every IFD as its own page, in order, upright", "imports as a 3-page PDF with each page at its own size and orientation". Accepted limitation (owner decision, 2026-10-05): Markdown→PDF still substitutes non-WinAnsi text (CJK) with a visible warning rather than rendering it; rendering would need an embedded Unicode font. Open: none.

CLAUDE.md: never silently corrupt a document. Each item below dropped or garbled user
content while reporting success.

- **Requirements:**
  - **AUDIT-2026-08-17 §3 #26**: a multi-page TIFF imports every IFD as a page. Was: `ifds[0]` only, so a 12-page scan became 1 page with no warning. Now `src/core/raster-decode.ts` `decodeTiffPages` loops every IFD (`tests/unit/raster-decode.test.ts` › "decodes sample.tiff page by page with a checkpoint before each page"). **Closed 2026-10-05:** `sample.tiff` has one page, so N pages is now proven on the 3-page `multipage.tiff` (`tests/unit/tiff-multipage.test.ts`).
  - **AUDIT-2026-08-17 §3 #27**: Markdown→PDF never silently replaces or drops text. Out-of-range characters are substituted only outside Windows-1252's real range (`sanitizeWinAnsiText`), the result reports `substituted`, and the UI warns. Table cells word-wrap instead of being cut at 30 characters. Was: silent `?`, which then regressed to a crash. **Accepted limitation (owner decision, 2026-10-05):** rendering CJK/RTL glyphs needs an embedded Unicode font; until then the substitution and its warning stand.
  - **AUDIT-2026-08-17 §3 #21**: text written into PDF strings outside Latin-1 round-trips as UTF-16BE hex (`PDFHexString`). Was: ACC-01 alt text written one byte per JS char code. Same bug class as OPS-10's outline titles.
  - **AUDIT-2026-08-17 §2 R#6**: radio-group extraction keeps widget rectangles and export labels aligned by widget index (`tests/unit/form-fields-create.test.ts` › "keeps radio options aligned with the widgets that still have appearances").
  - **AUDIT-2026-08-17 §2 R#7**: the outline loader records the page signature it loaded, so a stale in-flight read is retried instead of leaving bookmarks empty.
  - **AUDIT-2026-08-17 §3 #22** / **§2 R#24**: a folder-picker failure that is not an abort (permission denied, `SecurityError`) shows a visible warning. Was: `console.error` only.
- **AC:** A 3-page TIFF fixture imports as 3 pages. Alt text `日本語の写真 — café` reads back byte-exact after export and re-import. A Markdown file with CJK exports with a visible substitution warning, and its table cells keep their full text.

### HRD-06 · Undo, redo and shortcut remapping are always keyboard-reachable — `XS` `P1`

**Status: Done (re-verified 2026-10-05)** — Open: none.

- **Requirements:**
  - **AUDIT-2026-08-17 §3 #23** / **§2 R#25**: Redo answers both `Mod+Y` and `Mod+Shift+Z`, unless the user has remapped redo (`src/core/shortcuts.ts`, macOS-convention branch). Was: only `mod+y`, which contradicted DOC-06.
  - **AUDIT-2026-08-17 §3 #24** / **§2 R#26** / **§0 baseline #2 (DS-09 e2e)**: the shortcuts tool works without an open document (`worksWithoutDocument: true`). Was: "Open a document to use this tool", so remapping was unreachable (`tests/e2e/a11y-and-perf.spec.ts` › "shortcut rows are keyboard operable").
  - **AUDIT-2026-08-17 §5 follow-up (remap race)**: the remap-cancel listener lives for the component's whole lifetime and reads state through a ref. Was: an Escape pressed before the effect attached was dropped, and the UI stuck in "editing". The recorder also refuses navigation keys (UI-5; `tests/unit/shortcuts.test.ts` › "refuses bindings that would trap keyboard navigation (UI-5)").
- **AC:** With no document open, ⌘K → Shortcuts → rebind → Escape all work by keyboard. `Ctrl+Shift+Z` redoes.

### HRD-07 · Compare and diff export report real differences or fail loudly — `S` `P1`

**Status: Done (re-verified 2026-10-05)** — The ANN-02 and ANN-05 Status lines are patched to record this. Open: none.

- **Requirements:**
  - **AUDIT-2026-08-17 §3 #16** / **§2 R#18**: "Export Diff PDF" renders the real diff or reports an error. Was: `exportVisualDiff(docA, docB, [], …)` plus a bare `catch {}` wrote an all-white PDF and reported success (`tests/e2e/tool-flows.spec.ts` › "compare: visual pixel diff exports a real rendered image, not text mode").
  - **AUDIT-2026-08-17 §3 #17** / **§2 R#19**: higher sensitivity means stricter matching. Was: inverted, so at 100% nothing was ever marked.
  - **AUDIT-2026-08-17 §3 #18** / **§2 R#20**: images of different dimensions fail explicitly or are compared at real size. They are never indexed past the end of the shorter buffer (`NaN > t` read as "unchanged"). Since X-6 (AUDIT-2026-10-01), every page is diffed at its real size (`tests/e2e/audit-2026-10-01-ui.spec.ts` › "visual diff: every page at its real size, A4 against Letter exported, not refused").
  - **AUDIT-2026-08-17 §1 ANN-02**: the diff covers the whole document, not only the visible page, against the committed `contract-v1.pdf`/`contract-v2.pdf` pair (`tests/unit/compare-export-audit-2026-10-01.test.ts` › "X-6: diffs every page in the cv worker, page by page, with determinate progress").
- **AC:** Comparing a document with itself exports no highlighted region. Comparing the contract pair highlights every real change. A deliberately throwing renderer makes the export fail visibly.

### HRD-08 · Verification the audits could not do — `M` `P1`

**Status: Partly done (2026-10-05)** — Automated now: perf budgets for DOC-04's 300-page grid scroll, CNV-01's 20 photos < 10 s, CNV-02's memory ceiling at exact DPI and F-05's 200 ms cancel (`tests/e2e/perf.spec.ts`), with worker heaps read over CDP (`tests/e2e/worker-heap.ts`); axe in both themes on every route (`a11y-and-perf.spec.ts`); HEIC in the extension e2e (`tests/e2e/extension/tool-flows.spec.ts`). Still human or real-deploy only: store loads and review, PDFium rendering, Lighthouse on a deploy, QA-05's four-viewer check, booklet folding, the SCN-03 visual judgement, and translation quality.

- **Requirements:**
  - **AUDIT-2026-08-17 §0 cannot-verify #1**: real store loads and AMO/Edge Add-ons review (DIST-04's "passes review"). **Open**, needs a store account.
  - **AUDIT-2026-08-17 §0 cannot-verify #2**: rendering in Chrome's PDFium viewer for RED-06 and SGN-06 (pdf.js and poppler were used as proxies). **Open**, part of QA-05's manual pass.
  - **AUDIT-2026-08-17 §0 cannot-verify #3** / **§1 DIST-03** / **§5 still-open #1**: Lighthouse ≥ 95 on the default throttled profile against a real deploy. The code fix landed (landing critical-path JS cut from ~289 KB to ~37 KB gzip by lazy-loading `OptionsPanel`/`ActionBar`). **Open**, as DIST-03's status already says.
  - **AUDIT-2026-08-17 §0 cannot-verify #4** / **§5 still-open #2**: QA-05's four-viewer check (Chrome viewer, Acrobat, macOS Preview, Firefox pdf.js). **Open by design**: a human-run step every release.
  - **AUDIT-2026-08-17 §0 cannot-verify #5**: OCR-01's real model download. **Done**: an e2e runs consent → real fetch → tesseract → text layer (see HRD-09).
  - **AUDIT-2026-08-17 §0 cannot-verify #6**: HEIC colour and orientation. **Done** in the web build (`sample.heic`, `photo-rotated.heic`, `tests/e2e/import.spec.ts`), and since 2026-10-05 in the packaged extension (`tests/e2e/extension/tool-flows.spec.ts` › "HRD-51 — HEIC in the packaged extension").
  - **AUDIT-2026-08-17 §0 cannot-verify #7**: wall-clock and memory ACs (DOC-03 1.5 s/6 s thumbnails, DOC-04 300 pages at 60 fps, CNV-01 20 photos < 10 s, CNV-02 DPI-exact dimensions and memory ceiling, F-05 200 ms cancel with no orphan worker). DOC-03's budgets are asserted in the never-retried `perf` project (`perf.spec.ts`). **Done 2026-10-05:** `perf.spec.ts` › "DOC-04: a 300-page grid scrolls at 60 fps", "CNV-01: 20 phone photos become a correctly-oriented 20-page PDF within 10s", "CNV-02: 300 DPI export of 20 pages stays under the memory ceiling, at exact DPI", "F-05: Cancel takes effect within 200ms"; the memory ceilings cover every worker heap as well as the main thread (`tests/e2e/worker-heap.ts`, HRD-12).
  - **AUDIT-2026-08-17 §0 cannot-verify #8**: OPS-07 booklet fold order on paper, and SCN-03's "visually convincing" screenshot. **Open**, human judgement.
  - **AUDIT-2026-08-17 §0 weak-spot #1**: the bug hunt was a single pass. Later audits (AUDIT-FINDINGS, AUDIT-EDGE-CASES-2026-09-15, AUDIT-2026-09-25, AUDIT-2026-10-01) found 98+ more. **Ongoing**: re-audit after each epic.
  - **AUDIT-2026-08-17 §0 weak-spot #2**: no dedicated UI visual and interaction pass. **Partly addressed**: the `ui-review` skill exists and DS-10/mobile axe landed. No full ui-review record is committed.
  - **AUDIT-2026-08-17 §0 weak-spot #3** / **§5 still-open #3**: translation quality across the 10 non-English locales. **Open**: needs a native-speaker or professional review (NFR-04's status already says so).
  - **AUDIT-2026-08-17 §0 weak-spot #4**: no adversarial cross-check of the auditors' own claims. **Partly addressed**: AUDIT-2026-09-25 §4 found five contradicted claims, and the `ac-verifier` agent exists.
  - **AUDIT-2026-08-17 §0 weak-spot #5**: per-ticket nits were folded into parentheticals in the confirmed-done list. They are lost with the doc. Accepted.
  - **AUDIT-2026-08-17 §5 still-open #4**: the remaining OCR-01/HEIC unknowns, and full CJK glyph rendering in Markdown→PDF. The latter is a feature (embedded Unicode font), tracked in HRD-05.
- **AC:** Each line is either closed with evidence (a test, a recorded manual run or a measured deploy) or explicitly accepted in the owning ticket's Status.

### HRD-09 · Record of what the follow-up found and what was confirmed — `XS` `P2`

**Status: Done (re-verified 2026-10-05)** — An evidence record, so the deleted audit's positive findings survive. Open: none.

- **Requirements:**
  - **AUDIT-2026-08-17 §0 baseline #1**: the baseline at audit time was 56 files / 609 unit tests, all green, and 86/88 e2e (two failures, below).
  - **AUDIT-2026-08-17 §0 baseline #2** / **§2 R#12** / **§3 #37**: OPS-13 "cleanup: flatten background preserves text" failed. Flatten now reports a content rewrite as a change even when pdf-lib makes the file bigger. The separate "Page cleaned." timeout (#37) was already passing at follow-up. OPS-13 was later reopened and refixed for PDF-3 (its status records that).
  - **AUDIT-2026-08-17 §5 follow-up #1**: the extended axe sweep found and fixed nested-focusable thumbnails and file tabs, an invalid `tablist`, an h1→h3 skip in about a dozen panels, an unlabeled Annotate slider, and two keyboard-unreachable scroll regions (crop and compare previews). Requirement: the axe sweep scans Home, and every tool with a document open (`a11y-and-perf.spec.ts` › "every route has one main landmark, a title, and no positive tabindex"). See the NFR-01 patch for the dark-theme gap.
  - **AUDIT-2026-08-17 §5 follow-up #2**: an OCR-01 e2e exercises the real consented model download and recognition into the exported text layer.
  - **AUDIT-2026-08-17 §5 follow-up #3**: every fixture a test reads is committed. `sample.heic` had been silently excluded by `.gitignore`'s allow-list. `photo-rotated.heic` (EXIF 6) was added, with a corner-pixel orientation check.
  - **AUDIT-2026-08-17 §2 confirmed-done**: confirmed done by independent reproduction on 2026-08-17: F-02, F-04, F-06, DS-06, DS-07, QA-01, QA-02, QA-05, DIST-05, DOC-01, DOC-04, DOC-06, DOC-07, DOC-08, OPS-01, OPS-02, OPS-04, OPS-06, OPS-08, OPS-09, OPS-10, OPS-11, OPS-12, CNV-01, CNV-04, CNV-06, SGN-03, SGN-05, SGN-06, CMP-03, CMP-04, CMP-05, SCN-02, RED-03, RED-04, RED-05, RED-06, ANN-03, ANN-04, BAT-03, OCR-01. Later audits reopened some (DS-07, QA-03 and others, per EPIC-18's header), and each ticket's own Status is authoritative.
  - **AUDIT-2026-08-17 §1 NFR-04** / **§3 #19** / **§2 R#21**: the locale persists across reloads, `pt-BR` resolves exactly, English is the fallback dictionary, and `translate()` has `params` substitution (`tests/e2e/i18n.spec.ts` › "an exact regional tag (pt-BR) resolves to its own dictionary", "switching language renders real translated text, not English fallback"). Was: never persisted, regional tags unresolved, about 83 `notify()` calls and 29 `aria-label`s hard-coded. NFR-04's status ("RTL layout and translation review are not verified") already holds.
  - **AUDIT-2026-08-17 §1 DS-05** / **§2 R#22**: the Home `DropZone` no longer gives a button role or tab stop to a label wrapping a file input. Recorded on NFR-01's Status, and DS-05's status holds.
  - **AUDIT-2026-08-17 §1 DIST-02** / **§3 #28** / **§2 R#30**: the MIT `LICENSE` exists, and the README link resolves. The status already says "MIT licence".
  - **AUDIT-2026-08-17 §1 DOC-05** / **§3 #29**: `useObjectStreams: true` at all 16 `process.worker.ts` save sites (counted 2026-10-05), so the Requirement holds. `encrypt.ts` saves with `false`, which is intended: an `/Encrypt` rewrite needs a classic xref.
  - **AUDIT-2026-08-17 §1 SCN-01**: the de-warp half is tested (`warp-target-size.test.ts` › "de-warp end to end", "turns a square on a tilted page back into a square"). The status holds.
  - **AUDIT-2026-08-17 §1 OPS-03**: directory output is real (`platform.openDirectory` at the split and extract-images commit sites, behind an "Output Folder" option). The status holds.
  - **AUDIT-2026-08-17 §1 DIST-03** and **§1 DIST-04**: the status already holds (DIST-03 is "Partly done — Lighthouse ≥95 unverified"; DIST-04's "permissions untouched" is true again). See HRD-08 and HRD-04.
  - **AUDIT-2026-08-17 §4 priority**: fix order was gates → redaction → Compare → F-03/DS-09 → the rest. All done.
- **AC:** None beyond the referenced tests staying green.

### HRD-10 · Rebuilds keep the catalog and share one object copier — `S` `P0`

**Status: Done (re-fixed under AUDIT-2026-09-25 M1)** — the 2026-08-17 claim that the redact rebuild "shares one `PDFObjectCopier`" was false. PDF-7 found a copier per page (4.7 MB → 46.8 MB), which was also the root of the PDF-1 leak. Every rebuild now uses one copier per rebuild, in `src/core/pdf/rebuild.ts`. The PDF-7 known limit (a text-only 100-page file roughly doubling through redaction, 75 KB → 150 KB) was fixed on 2026-10-05 by `src/core/pdf/compact-save.ts` (HRD-40).

Canonical tag: `AUDIT-FINDINGS §0` (cited by `tests/unit/rebuild-catalog.test.ts`). Rebuilding
a document page by page with `copyPages` silently dropped the catalog and duplicated every
shared resource. It was the same bug in three places.

- **Requirements:**
  - **AUDIT-FINDINGS §0.1** — A page-by-page rebuild (compress, redact, compose) never
    silently strips the document catalog. Compress keeps `/Outlines`, `/PageLabels`,
    `/OCProperties` and `/StructTreeRoot`. Redaction keeps page-independent entries and
    `/PageLabels`, and carries `/OCProperties` through `preserveOptionalContent` so hidden
    layers stay hidden (AUDIT-2026-09-25 PDF-5). It deliberately drops page-linked trees
    such as `/Outlines` (`REDACTION_CATALOG_KEYS`, `process.worker.ts`). Was: a shared
    copier was claimed for both paths but never tested, and on the redaction path it was
    untrue until M1.
  - **AUDIT-FINDINGS §0.2** — The base export path dedupes objects shared across pages. It
    uses one copier per source document, so a logo on every page is embedded once. Was:
    claimed, with no test.
- **AC:** Checked on re-parsed output bytes, not intent: `tests/unit/rebuild-catalog.test.ts`
  ("§0 — catalog survives the compression rebuild", "§0 — page-independent catalog survives
  a redaction", "drops page-linked catalog entries during applyRedactions", "embeds a logo
  used on every page exactly once"); `tests/unit/rebuild-page-links.test.ts` (M1 link
  remapping). `shared-image.pdf` comes out of redaction at about its input size.

### HRD-11 · Redaction removes content, and the gate proves it — `L` `P0`

**Status: Done** — every §1 item was fixed or verified on 2026-08-17, with byte-level tests. AUDIT-2026-09-25 hardened it further (PDF-1 orphan-page leak, PDF-4 rotated images, M7 independent verifier).

Canonical tag: `AUDIT-FINDINGS §1` (cited by `src/core/pdf/text-search.ts`,
`tests/unit/interpreter.test.ts`, `tests/unit/text-search.test.ts`). RED-01..06 affect
security: content under a redaction mark must be removed, not just covered.

- **Requirements:**
  - **AUDIT-FINDINGS §1.1** — Vector content (stroked and filled paths: `S s f F f* B B* b b*`,
    `re`) is removed from the content stream when its CTM-transformed geometry overlaps a
    region. Geometry outside every region, and `W n` clip paths, are kept. `cm` is honoured.
    Was: the audit said this content was only covered; the code already removed it but had
    no test.
  - **AUDIT-FINDINGS §1.2** — The verification gate has an independent pixel half.
    `checkRegionPixels` renders each region and fails any region more than 2% off the fill
    colour (24/255 per-channel tolerance, 8% edge inset). A region that cannot be rendered
    fails **closed** and blocks the save. Was: the text-only gate passed a region that still
    held a vector shape.
  - **AUDIT-FINDINGS §1.3** — When a region covers part of an image, only the covered pixels
    are painted (`src/core/pdf/image-redaction.ts`). An image fully inside a region has its
    XObject removed. An image pdf.js cannot decode is refused as `unsupported` and never
    reported as `verified: true`. Was: a region deleted the whole image.
  - **AUDIT-FINDINGS §1.4** — Rotation is read through the inheritance-aware
    `page.getRotation()`. Was: a `/Rotate` lookup that ignored inherited values.
  - **AUDIT-FINDINGS §1.5** — Each `q` nesting level costs O(1) (`saveSnapshot`). Depth 40
    completes in well under a second, and the CTM unwinds back to identity. Was: the audit
    alleged an exponential clone.
  - **AUDIT-FINDINGS §1.6** — Glyph widths come from the font: `/Widths`/`/FirstChar`/
    `/MissingWidth`, and `/W`/`/DW` for Type0 fonts, which also decide one- or two-byte
    decoding. `Tz`, `Tc`, `Tw`, the `"` operands and TJ kerning are applied to the decoded
    strings. Was: a fixed 0.6 em guess.
  - **AUDIT-FINDINGS §1.7** — Find-and-mark matches text split across pdf.js runs
    (`findAcrossRuns`), but never across a line break. Was: it matched within a single run
    only.
  - **AUDIT-FINDINGS §1.8** — The success toast and the copyable report state the number of
    verified regions. No `rasterizedPages` field claims rasterisation that never happens.
    Was: a dead message that was always wrong.
  - **AUDIT-FINDINGS §1.9** — Tests cover an image under a region, a vector under a region,
    page rotation, and content outside the region surviving. Was: tests only checked that
    the output bytes differed.
- **AC:** `tests/unit/interpreter.test.ts` ("removes a stroked path that overlaps the
  region, not just covers it", "keeps a path that does not reach the region", plus the
  depth-40 and glyph-width cases); `tests/unit/redaction-verify.test.ts` ("catches vector
  content that the text-only check passes", "fails closed when the region cannot be rendered
  at all", "actually calls the pixel check — the gate is not text-only");
  `tests/unit/image-redaction.test.ts`; `tests/unit/text-search.test.ts` ("finds a match
  split across two runs — the whole point", "does not match across a line break");
  `tests/unit/rotation-placement.test.ts`.

### HRD-12 · Compression reports only what it measured — `M` `P0`

**Status: Done (2026-10-05)** — §2.1–§2.5 were fixed on 2026-08-17. The §2.5 memory limit is closed: `tests/e2e/worker-heap.ts` reads every worker's heap over CDP (`Runtime.getHeapUsage` per realm, so no COOP/COEP is needed), and `perf.spec.ts` asserts 200 MB per realm (main and each worker) and 1.5 GB across all realms including buffers, and fails if no worker was sampled. Measured 2026-10-05: main heap about 10 MB, largest worker heap about 10.6 MB, all realms about 107 MB. Open: none.

Canonical tag: `AUDIT-FINDINGS §2`.

- **Requirements:**
  - **AUDIT-FINDINGS §2.1** — A page with no text and an image that is unsafe to re-encode
    (e.g. `/Separation`) is never rasterised. It goes to the `already-optimized` route with
    a stated reason. Was: the safety skip list was computed and then ignored on the raster
    route.
  - **AUDIT-FINDINGS §2.2** — A replacement image is used only when it is smaller than the
    stream it replaces. A run that saves nothing returns the input byte-for-byte, marked
    `keptOriginal`. Was: a run that did no work, or made the file bigger, could still report
    savings.
  - **AUDIT-FINDINGS §2.3** — A report written before any compression has run is labelled as
    an estimate ("Estimated Size" in text, `summary.estimated` in the JSON). It never uses
    the measured labels. Was: the projection was printed as if it were a measurement.
  - **AUDIT-FINDINGS §2.4** — Each distinct image is decoded and encoded once per document,
    at the largest size any page displays it (`extractSharedImages`), holding at most
    `MAX_HELD_PAGES` pages while it waits. Was: "encoded once" was true of storage, not of
    the encoding work.
  - **AUDIT-FINDINGS §2.5** — `rebuildCompressed` measures each image's stored size before
    and after, plus any skip reason, and those figures reach CMP-06's sidecar. Was: the
    sidecar's per-image list was always empty. **Closed 2026-10-05:** the memory budget
    was not verified for worker heaps, because `performance.memory` sees only the main
    realm and `measureUserAgentSpecificMemory()` needs COOP/COEP, which neither build
    sets. Worker heaps are now read over CDP (`tests/e2e/worker-heap.ts`).
- **AC:** `tests/unit/compress-plan.test.ts` ("never rasterises a textless page whose image
  is unsafe to re-encode"); `tests/unit/compress-rebuild.test.ts` ("keeps the original
  bytes for an empty compression plan", "refuses a replacement that is larger than the
  stream it replaces", "reports the original and replacement byte lengths of a real swap");
  `tests/unit/compress-report.test.ts` (estimate cases); `tests/unit/compress-encode-once.test.ts`
  ("still encodes once when six pages reference the same image"); worker heaps in
  `tests/e2e/perf.spec.ts` via `tests/e2e/worker-heap.ts` (done 2026-10-05).

### HRD-13 · One display frame for every placement — `M` `P0`

**Status: Done (crop/origin half re-fixed under AUDIT-2026-09-25 M2)** — the 2026-08-17 fix only covered rotation. Tools still mapped positions onto the MediaBox and ignored the CropBox and its origin (PDF-8/9/10). All placement now goes through `src/core/pdf/display-frame.ts`, which combines CropBox ∩ MediaBox, the origin and `/Rotate`.

Canonical tag: `AUDIT-FINDINGS §3` (cited by `tests/unit/rotation-placement.test.ts`). One
root cause broke five tools, and the same bug came back in SGN-06 (HRD-22) and in raster
compression.

- **Requirements:**
  - **AUDIT-FINDINGS §3.1** — Crop, watermark, header/footer, Bates and stamps all place
    content against the shared display frame. Edge-anchored content is laid out against the
    crop box. Output for unrotated, uncropped pages is unchanged. Was: on a rotated page,
    content was placed in the wrong frame.
  - **AUDIT-FINDINGS §3.2** — A signature placed before the page is rotated in the grid does
    not move or spin, because placements take their frame from the source `/Rotate` only.
    Was: rotating after signing moved the signature.
  - **AUDIT-FINDINGS §3.3** — Page ranges for watermark, header/footer and Bates are parsed
    against the document's total page count and matched against `pageOffset + i`, so they
    stay correct across split slices. A duplicated page keeps its first instance. Bookmarks
    resolve both `/Dests` and `/Names /Dests`. Was: every split slice was stamped as if it
    were pages 1–3.
- **AC:** `tests/unit/rotation-placement.test.ts` (all four rotations, checked against a
  transcription of pdf.js `PageViewport`; "rotating a page after signing it does not move or
  spin the signature (§3)"; "keeps the Bates number inside a crop box applied by the same
  export"; "does not restamp every split slice as if it started at page 1");
  `tests/unit/display-frame-geometry.test.ts` ("pageDisplayFrame reproduces the pdf.js
  viewport exactly", plus the PDF-9/PDF-10 cases on rotated, cropped, offset-origin pages).

### HRD-14 · Worker hand-off, cancellation and error surfacing — `M` `P0`

**Status: Done (2026-10-05)** — §4.1–§4.3 were closed on 2026-08-17. The §4.1 regression test, deleted in commit `6d0e9fc` ("wip", 2026-08-18), is restored and adapted to today's code: `tests/unit/source-transfer-hazard.test.ts` drives the real `processWorkerImpl` over a real `MessageChannel`. Since source bytes moved to OPFS, compose *does* transfer what `bytesForPages` returns (PLT-18); that is safe because `readSourceBytes` hands out a fresh copy every time, and the test guards that copy: "compose transfers its source bytes, and the store and the other document are intact", "currentDocumentBytes's fast path is a copy, so applyRedactions and rebuildCompressed may consume it", "would corrupt the other document if the store's own array were transferred" (the teeth), "operations.ts does not hand applyRedactions or rebuildCompressed input over". Open: none.

Canonical tag: `AUDIT-FINDINGS §4` (cited by `src/core/operations.ts` `handOver`,
`src/background/service-worker.ts` and `tests/unit/store.test.ts`). The docblock in
`operations.ts` sends readers here for what would have to change before the transfer gate
could open.

- **Requirements:**
  - **AUDIT-FINDINGS §4.1** — Bytes are transferred to a worker, rather than cloned, only
    when the caller provably owns them and never reads them again (`handOver`, used by
    `flattenDocument` and the redaction-internal `scrubMetadata`). `compose`,
    `rebuildCompressed` and `applyRedactions` keep the clone, because their bytes are the
    store's canonical `source.bytes`. `canTransferSourceBytes` decides on three things:
    page and document reference counts (a `computed`, never hand-incremented), whether the
    undo history can still reach the bytes, and whether a render handle holds them. Opening
    the gate would require three changes, each costing more than the clone it saves: make
    those operations non-undoable (or have the history keep its own copy), stop
    `currentDocumentBytes` returning store-owned bytes, and close the render handle before
    the call. Was: every call into a worker cloned the whole document. The fix was measured,
    and the measurement said not to transfer.
  - **AUDIT-FINDINGS §4.2** — Every long operation takes a `JobHandle` with real checkpoints
    (getting and filling form fields, flatten, scrub, protect). `encryptPdf` checkpoints
    inside its object loop every 50 ms or 64 objects, whichever comes first, and reports
    into the 0.1–0.95 progress band through `subJob`. An abort leaves the input
    byte-identical. Cancellation is cooperative by design: no worker is terminated on
    abort, which keeps the warm pdf.js instance and other work in the pool alive. Was:
    cancellation was polling, and several operations had no job handle at all.
  - **AUDIT-FINDINGS §4.3** — If a worker fails to boot, a `danger` toast appears with a
    copyable diagnostic, never just a bare `console.error`. A second click on the extension
    icon joins the open already in progress (a promise guard). A tab without an `id` opens a
    fresh editor tab with a warning. Was: errors went unreported to the user, and a double
    click raced.
- **AC:** `tests/unit/store.test.ts` ("source reference counting", "canTransferSourceBytes");
  `tests/unit/encrypt.test.ts` ("cancellation inside the object loop");
  `tests/unit/service-worker.test.ts`; `tests/unit/source-transfer-hazard.test.ts` (restored 2026-10-05). **Was remaining:** restore the deleted hazard test. It
  set up two documents sharing one source, ran compose, applyRedactions and
  rebuildCompressed on one of them, and asserted the other could still export. It also did
  a manual `structuredClone(buf, { transfer: [buf] })` to prove the test catches the
  failure, and checked structurally that `handOver` is not applied to those three calls.

### HRD-15 · Document core: grid keys, contact sheet, thumbnails, ordering, import — `S` `P0`

**Status: Done** — all five §5 items were fixed on 2026-08-17. HRD-23 §11.8 reopened the DOC-08 ordering claim; it was resolved on 2026-10-05 as an opt-in "Fast web view" export setting (DOC-08).

Canonical tag: `AUDIT-FINDINGS §5`.

- **Requirements:**
  - **AUDIT-FINDINGS §5.1** — Home, End and the arrow keys work on a virtualised grid: the
    target row is scrolled into view first and the tile is focused once it renders
    (`pendingFocusRef`). Was: the keys did nothing for tiles outside the overscan window.
  - **AUDIT-FINDINGS §5.2** — Contact Sheet's main export button produces a contact sheet.
    It lays out 20 cells per A4 sheet, keeps cells legible at 300 pages, and both export
    routes read one shared `contactSheetColumns` setting. Was: the action-bar button
    exported something else, with the column count hardcoded to 4.
  - **AUDIT-FINDINGS §5.3** — Rotating a page re-renders its thumbnail (`page.rotation` is a
    dependency of the render effect). Was: the stale bitmap was stretched with CSS.
  - **AUDIT-FINDINGS §5.4** — First-page-first object ordering is named honestly: it is not
    ISO 32000-1 §F linearization, and no `/Linearized` dictionary is fabricated. It can be
    turned off per save or process-wide, and its object-stream caveat is asserted in tests.
    Was: the naming implied real linearization.
  - **AUDIT-FINDINGS §5.5** — Import can be cancelled between its real stages (read, header
    check, parse, inspect), and each stage reports its own progress fraction and label.
    Was: progress jumped from 0 to 100%.
- **AC:** `tests/unit/rotation-placement.test.ts` ("spreads 300 pages over many sheets,
  keeping every cell legible"); `tests/unit/linearize.test.ts` ("does not claim to be ISO
  32000 linearization", "can be switched off per document and process-wide").

### HRD-16 · Scan cleanup, OCR and folder search fail visibly — `M` `P1`

**Status: Done** — all seven §6 items were fixed on 2026-08-17.

Canonical tag: `AUDIT-FINDINGS §6`.

- **Requirements:**
  - **AUDIT-FINDINGS §6.1** — Edge detection measures how confident it is, by comparing
    luminance inside and outside each edge against the sample noise. When it is not
    confident, the warp is skipped. Was: a failed detection still cropped a blind 2% inset.
  - **AUDIT-FINDINGS §6.2** — Despeckle updates the preview, and "Apply to all" cleans
    every page. Flatten always runs against the original vector page, because OPS-13 must
    preserve text; the cleanup settings apply only on the rasterise path. Was: despeckle did
    nothing.
  - **AUDIT-FINDINGS §6.3** — After flatten or cleanup, a page is repointed at the page
    index the result actually holds (`sourceIndex` or `0`). Was: the index was hardcoded to
    `0`.
  - **AUDIT-FINDINGS §6.4** — Folder search skips any file pdf.js refuses (encrypted,
    corrupt or unsupported) and tells the user why, instead of scraping its raw bytes. An
    incremental re-index deletes index records only for the files it rewrites. Was: those
    files went into the index as garbage, and re-indexing lost the entries of files that had
    not changed.
  - **AUDIT-FINDINGS §6.5** — Table extraction's main button exports the grid on screen,
    using page, cells and format state shared with the panel. With nothing previewed it
    extracts first, and it warns when no table is found. It writes through
    `platform.saveFileAs`, never through PDF encryption. Was: the button did nothing.
  - **AUDIT-FINDINGS §6.6** — The zero-network e2e visits the `ocr`, `table-extract`, `acc`,
    `contact-sheet`, `outline` and `shortcuts` routes. Was: it never visited the OCR route.
  - **AUDIT-FINDINGS §6.7** — Signature-line detection also finds a horizontal vector rule
    drawn near a "Signature", "Date", "Sign here" or "Printed name" label. Was: it looked at
    text and underscores only.
- **AC:** `tests/unit/edge-detection.test.ts`; `tests/e2e/tool-flows.spec.ts` ("cleanup:
  flatten background preserves text"); the route sweep in `tests/e2e/zero-network.spec.ts`;
  `tests/unit/signature-lines.test.ts`.

### HRD-17 · A form Stapler creates resolves its own fonts — `XS` `P0`

**Status: Done** — fixed on 2026-08-17. Sign's default no longer flattens its own fields (HRD-22 §11.5).

Canonical tag: `AUDIT-FINDINGS §7` (cited by `tests/unit/acroform-defaults.test.ts`).

- **Requirements:**
  - **AUDIT-FINDINGS §7.1** — A generated `/AcroForm` carries a `/DR` with a registered
    Helvetica font and a document-level `/DA` (`ensureAcroFormDefaults`). It never
    overwrites a `/DR` that came from the source document. With flattening off the field
    survives the export; with flattening on it is baked in cleanly. Was: the default export
    settings deleted the fields the tool had just created.
- **AC:** `tests/unit/acroform-defaults.test.ts` ("writes /DR with a Helvetica font resource
  and a document /DA", "resolves every field's /DA font name inside /DR", "flattens the
  generated form without refusing", "does not overwrite a /DR carried in from the source
  document"); the Sign export cases in `tests/e2e/tool-flows.spec.ts`.

### HRD-18 · Batch filenames, recipe isolation, alt-text read-back — `S` `P1`

**Status: Done** — all three §8 items were fixed on 2026-08-17.

Canonical tag: `AUDIT-FINDINGS §8`.

- **Requirements:**
  - **AUDIT-FINDINGS §8.1** — Batch output names are indexed by each file's own position in
    the run, so a failure never shifts the names of later files. Was: the index came from a
    counter that only advanced on success.
  - **AUDIT-FINDINGS §8.2** — When a recipe step has a setting that was never configured,
    that tool is skipped with a warning naming it. It never picks up a live global setting
    from another tool. Was: settings open in another tool were picked up silently.
  - **AUDIT-FINDINGS §8.3** — Alt text round-trips. Each tagged page gets a unique
    `/StructParents` key into the `ParentTree`, which is built as a real `PDFArray` rather
    than a wrapped JS array. A reader (`readAltTextFromDoc`) fills the panel when a document
    loads. Was: alt text was never read back.
- **AC:** `tests/unit/batch-runner.test.ts`; `tests/unit/accessibility.test.ts` ("round-trips
  alt text through a real save and re-parse of the bytes", "keeps each tagged page on its
  own /StructParents key across multiple pages").

### HRD-19 · Invariant tooling scans everything that ships — `XS` `P0`

**Status: Done** — both §9 items were fixed on 2026-08-17.

Canonical tag: `AUDIT-FINDINGS §9` (cited by `scripts/check-invariants.mjs`).

- **Requirements:**
  - **AUDIT-FINDINGS §9.1** — The colour check catches colour keywords and literals inside
    quoted and backtick JS strings, across all colour-bearing properties (`background`,
    `border-color`, `fill`, `stroke`, `box-shadow`, …), not just bare CSS `color:`. Was: one
    raw colour literal got past the hook.
  - **AUDIT-FINDINGS §9.2** — The whole-repo invariant scan (`scripts/check-invariants.mjs`,
    part of `pnpm check`) covers every file that ships, not just files written or edited
    under `src/`. `public/privacy.html` follows the same rule as `tokens.css`: a raw colour
    may appear only in a `--token: value;` declaration line. Was: a blanket exemption hid
    that page's hex literals.
- **AC:** `pnpm check` fails when a raw colour is added to any shipped file, including as a
  quoted JS literal, or anywhere in `public/privacy.html` outside a custom-property
  declaration.

### HRD-20 · Locale completeness and ref-forwarding components — `S` `P1`

**Status: Done; translation review open** — NFR-04's coverage test has superseded §10.1 (AUDIT-2026-09-25 UI-8 found 383 keys in use that were missing from every locale). A native-speaker review has still not been done; that is tracked on NFR-04. §10.2 is done for the DS-03 primitives.

Canonical tag: `AUDIT-FINDINGS §10`.

- **Requirements:**
  - **AUDIT-FINDINGS §10.1** — Every key used in `src/` (UI and workers) has a real
    translation in all 10 locales, enforced by a test. No string is identical to the English
    because a translation was left out. Was: six `tool.annotate.*` strings were untranslated
    in nine locales. The translations of the "Annotate" tool name (de/ru/ar/hi) were also
    flagged for a native speaker to check.
  - **AUDIT-FINDINGS §10.2** — Library components forward their ref to their root DOM
    element. `mergeRefs` is used where a component already has its own ref, and
    `forwardRefGeneric` keeps the generic type of `Select`, `RadioGroup` and
    `SegmentedControl`. App-level sections added since (`JobStatusRow`,
    `OpenDocumentPrompt`, `LocalDataSection`, `FloatingTooltip`) do not forward refs, which
    is fine unless they are moved into the library. `ErrorBoundary` is a class component.
    Was: none of the 23 components forwarded refs.
- **AC:** NFR-04's locale coverage test passes, and every DS-03 primitive accepts a `ref`
  that resolves to its root element.

### HRD-21 · Flatten background never destroys the page — `S` `P1`

**Status: Done (re-fixed under AUDIT-2026-09-25 PDF-3)** — §11.1–§11.4 were fixed on 2026-08-17. But flatten still dropped only the paint operator and left the path construction, so the next fill on the page painted the whole page. It now removes the whole path-construction run together with its painter (OPS-13, re-audited 2026-09-26).

Canonical tag: `AUDIT-FINDINGS §11` (findings §11.1–§11.4, OPS-13).

- **Requirements:**
  - **AUDIT-FINDINGS §11.1** — A full-page `Do` image (a scan) is never a candidate for
    removal; only a qualifying full-page vector fill is. When no background is found, the
    operation returns an explicit "unchanged" result. Was: it produced a blank white page.
  - **AUDIT-FINDINGS §11.2** — Flatten never changes `/Resources`, which can be inherited
    and shared by sibling pages. Was: it deleted a resource entry that other pages shared.
  - **AUDIT-FINDINGS §11.3** — Flatten loads the file through the normal `load(bytes)`, which
    refuses encrypted files, and never uses `ignoreEncryption: true`. Was: it processed
    encrypted files.
  - **AUDIT-FINDINGS §11.4** — The cover rectangle uses the crop box's origin. Nothing is
    injected when nothing was detected. The save is refused unless the output is smaller
    than the input. The operation has real tests. Was: it had no tests, took its geometry
    from `getSize()`, and always reported success.
- **AC:** `tests/unit/flatten-background.test.ts` ("never mistakes a full-page scan for a
  removable background", "removes the construction run with its painter, so a later fill
  stays small", "keeps the stroke of a fill-and-stroke background (B → S)", "refuses a
  page-sized path that is also a clip"); `tests/e2e/tool-flows.spec.ts` ("cleanup: flatten
  background preserves text").

### HRD-22 · Created form fields: interactive by default, placed in the display frame — `S` `P1`

**Status: Done** — §11.5–§11.7 were fixed on 2026-08-17. Widget placement has since moved onto the shared `display-frame.ts` (AUDIT-2026-09-25 M2).

Canonical tag: `AUDIT-FINDINGS §11` (findings §11.5–§11.7, SGN-06).

- **Requirements:**
  - **AUDIT-FINDINGS §11.5** — Sign leaves its exported form fields interactive by default,
    while Annotate keeps finalising by default. Each tool has its own flatten toggle. Was:
    SGN-06's own default deleted the fields it had just created.
  - **AUDIT-FINDINGS §11.6** — A widget's rectangle is computed by mapping its displayed
    corners through the crop-aware display frame (rotation, crop and origin). Was: it was
    computed from raw `page.getSize()`, so on `/Rotate 90` it came out transposed — the §3
    bug class again.
  - **AUDIT-FINDINGS §11.7** — If the document already has a field with the same name but a
    different type, export throws a named `UnsupportedFeature` error that includes the field
    name. Was: pdf-lib's raw `FieldAlreadyExistsError` aborted the export.
- **AC:** `tests/unit/form-fields-create.test.ts` (widget rectangle on a rotated, cropped
  page; field type conflict); in `tests/e2e/tool-flows.spec.ts`, Sign's default export is
  fillable and the keyboard path can opt into flattening.

### HRD-23 · Export claims match the bytes: fast web view, report size, paste — `M` `P2`

**Status: Done (2026-10-05)** — §11.8: resolved by owner decision as an opt-in "Fast web view" export setting (off by default, so DOC-05's object streams stay the default). `src/core/pdf/fast-web-view.ts` rewrites the output with a plain xref and page 1's objects first. Every `process.worker.ts` save (17 call sites) goes through one `saveOutput` helper, so the DOC-05/DOC-08 choice is made in one place; `commit.ts` applies the rewrite to the last unencrypted bytes of a PDF export, encrypts once afterwards when Protect is on, and drops it with a note if it fails or would break the growth guard. Tests: `tests/unit/export-fast-web-view.test.ts` › "HRD-23 §11.8 — fast web view reaches the written bytes" (off keeps object streams; on puts page 1 first with no object streams; the ordering survives RED-06 encryption) and `tests/e2e/export-claims.spec.ts`. §11.9: the report is checked against the real file, in unit (`export-fast-web-view.test.ts` › "HRD-23 §11.9 / CMP-06 — the report's size is the size written to disk") and e2e (`export-claims.spec.ts` › "HRD-23 §11.9: with Protect on, the compression report total equals the saved file"). §11.10: `tests/e2e/import.spec.ts` › "CNV-07 paste image as page" pastes through the real clipboard (granted permissions, a real `ClipboardItem`) into an open 3-page document and checks the index; `window.__mockClipboardImage` is gone from `src/` and `tests/`. Open: none.

Canonical tag: `AUDIT-FINDINGS §11` (findings §11.8–§11.11).

- **Requirements:**
  - **AUDIT-FINDINGS §11.8** — DOC-08's first-page-first ordering reaches the output bytes
    of user exports, or the ticket says that it does not. DOC-05 (object streams) and DOC-08
    (ordering, which needs a plain xref) conflict, and the conflict must be resolved
    explicitly: either add a user-facing "Fast web view" option that saves with a plain
    xref, or drop the claim. Was: fixed on 2026-08-17 by saving with a plain xref, and that
    fix has since been reverted.
  - **AUDIT-FINDINGS §11.9** — CMP-06's exported report always describes the last measured
    run on the open document: the result is tagged with its document and cleared on a
    switch through `docScoped`. Its totals use the size actually written to disk after
    RED-06 protection (`finalBytes`). Was: it could show another document's stale numbers,
    and it used the size measured before encryption.
  - **AUDIT-FINDINGS §11.10** — Paste-as-page reads `ClipboardEvent.clipboardData` first and
    calls `preventDefault()`, falls back to the async Clipboard API, and inserts the page at
    the current position in an open document. Was: the e2e exercised only a production test
    hook (`window.__mockClipboardImage`, then still in `src/platform/file-system.ts`; removed
    2026-10-05) and only the empty-workspace branch.
  - **AUDIT-FINDINGS §11.11** — These had no findings and are kept as baselines to re-check
    whenever they change: RED-05's pattern precedence and Luhn check; RED-06's encryption,
    cross-verified against poppler, with per-object cancellation; OPS-11's Bates numbering
    through the display frame; OPS-12's split-by-bookmarks dedupe; DOC-07's bounded,
    measured bisection.
- **AC:** A plain user export of a multi-page fixture places page 1's objects before later
  pages' by byte offset, or DOC-08 is re-scoped. An e2e compresses with a password and
  asserts the exported report's total equals the saved file's byte length. An e2e pastes a
  real `ClipboardEvent` with image data into an open 3-page document at page 2 and asserts
  the new page lands at index 2, and the `__mockClipboardImage` hook is removed.

### HRD-24 · Tool state never bleeds across documents — `M` `P0`

**Status: Done (2026-10-05)** — §12 fixed three tools on 2026-08-17, but the same pattern remained in others (UI-1/3/11/12/18/25). `src/ui/tools/docScoped.ts` now scopes tool state to `{docId, pagesVersion}` (AUDIT-2026-09-25 M3). The two minor items are closed: §12.10, the outline editor's boundary buttons are `aria-disabled` with a reason, still focusable and inert (`tests/unit/outline-edge-buttons.test.ts`); §12.11, the annotation-summary export runs through `useJob` with determinate progress and cancel, and its PDF is built in the process worker (`src/core/workers/annotation-summary-pdf.ts`; `tests/unit/annotation-summary-job.test.ts` › "builds the PDF in the process worker, not on the main thread", "AnnotatePanel runs it through useJob, passing the job on"). Open: none.

Canonical tag: `AUDIT-FINDINGS §12`. The root cause was module-level signals holding
per-document data with no document scoping. The staleness guard in OPS-10's
`useOutline.ts` was the model for the fix.

- **Requirements:**
  - **AUDIT-FINDINGS §12.1** — Alt text keys each image by page plus image name, which
    survives compose and rebuild. The writer still accepts the legacy object-number key.
    Was: it used the wrong object numbering and silently failed to attach.
  - **AUDIT-FINDINGS §12.2** — `altTextMap` is cleared on a document switch, and a late scan
    result from the previous document is dropped. Was: it was never cleared.
  - **AUDIT-FINDINGS §12.3** — The annotation summary lists an annotation whose `pageKey` is
    not in the current document as `Detached`, never as page 1. Was: stale annotations from
    another document bled in.
  - **AUDIT-FINDINGS §12.4** — Every shortcut-remap row is a real button, reachable with Tab
    and activated with Enter or Space. Was: the rows could not be reached by keyboard.
  - **AUDIT-FINDINGS §12.5** — Conflict detection treats Delete and Backspace as equivalent
    through the same helper the runtime matcher uses. Was: the two disagreed.
  - **AUDIT-FINDINGS §12.6** — Compare's "Export diff" follows the mode on screen (visual,
    text or redline). Was: it always exported a pixel diff.
  - **AUDIT-FINDINGS §12.7** — Annotate search re-checks the active document after the
    worker returns, and drops the results if it has changed. Was: there was no guard.
  - **AUDIT-FINDINGS §12.8** — A batch name pattern that already ends in `.pdf` never
    produces `.pdf.pdf`. Was: the extension was doubled.
  - **AUDIT-FINDINGS §12.9** — Contact-sheet export reuses cached thumbnails, and on a cache
    miss it renders the page and adds it to the cache. Was: it re-rendered every page.
  - **AUDIT-FINDINGS §12.10** — **Done 2026-10-05 (was open, minor):** the bookmark editor's move, indent and
    outdent `IconButton`s are not disabled at the edges of the tree (`OutlinePanel.tsx`).
  - **AUDIT-FINDINGS §12.11** — **Done 2026-10-05 (was open, minor):** the annotation-summary export did not go
    through `useJob()`, so it has no progress and no cancel, unlike every other export
    (`AnnotatePanel.tsx`).
- **AC:** `tests/unit/doc-scoped-state.test.ts` ("clears table rows, extracted text,
  compress results and sign state on tab switch"); `tests/unit/accessibility.test.ts` ("also
  accepts the stable image-name key used by the alt-text editor");
  `tests/unit/annotation-summary.test.ts` (Detached); `tests/e2e/a11y-and-perf.spec.ts`
  ("shortcut rows are keyboard operable"); `tests/unit/shortcuts.test.ts` ("treats Delete and
  Backspace as the same shortcut for conflict detection"); `tests/unit/compare-export.test.ts`;
  `tests/unit/annotate-search.test.ts`; `tests/unit/batch-runner.test.ts`;
  `tests/unit/contact-sheet-export.test.ts`; `tests/unit/outline-edge-buttons.test.ts`
  (§12.10); `tests/unit/annotation-summary-job.test.ts` (§12.11).

### HRD-25 · Every build target honours zero permissions; CI stays green — `XS` `P0`

**Status: Done** — §13.1 is superseded: the Firefox build no longer adds `tabs` at all, because the service worker uses `chrome.runtime.getContexts`. That is stricter than the exemption the audit recorded.

Canonical tag: `AUDIT-FINDINGS §13`.

- **Requirements:**
  - **AUDIT-FINDINGS §13.1** — The Firefox manifest ships with empty `permissions`, like the
    Chrome manifest, and the invariant and build validators check the Firefox output too.
    Was: `tabs` was added unconditionally and treated as an exemption.
  - **AUDIT-FINDINGS §13.2** — `pnpm test:e2e` is green on `master`. The batch route's
    primary button passes axe's colour-contrast check through the shared primary token,
    which was fixed in `tokens.css`, not waived. Was: the e2e suite was red on a clean tree.
- **AC:** `tests/unit/firefox-manifest.test.ts` ("leaves host_permissions/content_scripts
  intact and does not add tabs"); `node scripts/check-contrast.mjs`; the batch route scan in
  `tests/e2e/a11y-and-perf.spec.ts`.

### HRD-26 · Concurrency: queued modals, safe storage, bounded diffs — `S` `P0`

**Status: Done** — all five §14 Critical items were fixed on 2026-09-16.

Canonical tag: `AUDIT-FINDINGS §14` (Critical C1–C5).

- **Requirements:**
  - **AUDIT-FINDINGS §14 C1** — `confirmAction`, `requestOcrConsent` and
    `requestExportReview` go through `createModalQueue()`. A concurrent request waits its
    turn, and every caller's promise settles. Was: a second call orphaned the first.
  - **AUDIT-FINDINGS §14 C2** — Every OPFS access goes through `tryGetOpfsRoot()`, which
    falls back to memory when `getDirectory()` throws (Firefox private browsing, a sandboxed
    iframe). Was: the throw took down the whole app.
  - **AUDIT-FINDINGS §14 C3** — `useJob`'s cleanup clears its controller ref, so a late
    `finally` cannot clear another job's `activeJob`. Was: it wiped another job's progress
    bar.
  - **AUDIT-FINDINGS §14 C4** — The text diff is bounded by `MAX_DIFF_WORDS`, with a coarse
    line-level fallback past it (it has since moved to a worker, CONV-14). Was: an unbounded
    `(n+1)×(m+1)` table.
  - **AUDIT-FINDINGS §14 C5** — No worker proxy is handed out without a lease. The unused
    `api()` was removed; `pin()`/`release()` is the way to hold a proxy across several
    calls. Was: the idle timer could kill a worker in the middle of a call.
- **AC:** The fixes are present in `src/core/notify.ts`, `src/core/opfs.ts`,
  `src/ui/useJob.ts`, `src/core/diff.ts` and `src/core/workers/client.ts`, and the full unit
  suite is green.

### HRD-27 · Resource lifecycle and error paths — `M` `P1`

**Status: Done in code; one measurement open (2026-10-05)** — H1–H13 were fixed or resolved on 2026-09-16 (H11 was not a live bug; PLT-19 and DOC-15 have since superseded H5 and H6). H3 is fixed: `trimTransparentToPng` and `removeWhiteBackground` now run their pixel loops in the cv worker (`src/core/workers/signature-pixels.ts`), transferring bitmaps and PNG bytes both ways, with byte-identical output to the old main-thread code (`tests/unit/signature-pixels-worker.test.ts` › "trimTransparentToPng: byte-identical PNG to the old main-thread code", "removeWhiteBackground: identical RGBA to the old main-thread code, still a canvas", "runs the pixel work in the cv worker and transfers bitmaps and PNG bytes both ways"). **Open:** the AC's browser performance trace (a 4000×3000 signature import with no main-thread task over 50 ms) has not been run.

Canonical tag: `AUDIT-FINDINGS §14` (High H1–H13).

- **Requirements:**
  - **AUDIT-FINDINGS §14 H1** — The render cache never closes a bitmap that is still in
    use. An invalidated entry with users is marked orphaned and closed when its last user
    calls `release()`.
  - **AUDIT-FINDINGS §14 H2** — `useImageImportOptions` queues concurrent requests.
  - **AUDIT-FINDINGS §14 H3** — **Done in code 2026-10-05 (cv worker):** signature trimming and white-background removal
    must run in a worker, or in bounded chunks, so importing a 4000×3000 image never blocks
    the main thread for more than 50 ms. Was: a synchronous loop lasting several seconds.
  - **AUDIT-FINDINGS §14 H4** — A failure in `requestImageOptions()` goes through
    `notifyError('import', …)`, not an unhandled rejection.
  - **AUDIT-FINDINGS §14 H5** — A dismissed file picker always settles. It now uses the
    `cancel` event, with focus as a last resort (PLT-19).
  - **AUDIT-FINDINGS §14 H6** — Closing a document never wipes other documents' undo
    history. History is now per document (DOC-15).
  - **AUDIT-FINDINGS §14 H7** — The theme listener's `MediaQueryList` is kept for the
    module's lifetime, so WebKit cannot garbage-collect it.
  - **AUDIT-FINDINGS §14 H8** — An unnamed created field falls back to `field_${ann.id}`,
    never to a shared literal name that would link the fields together.
  - **AUDIT-FINDINGS §14 H9** — A `closeDocument` rejection in a `finally` block never masks
    the original error (all 18 call sites).
  - **AUDIT-FINDINGS §14 H10** — `activePageIndex` is clamped after `deletePages`.
  - **AUDIT-FINDINGS §14 H11** — A restore never points at deleted OPFS bytes, because
    `checkRecovery()` confirms `sourceBytesExist()` before offering it. This was not a live
    bug.
  - **AUDIT-FINDINGS §14 H12** — `splitDocument` refuses an empty page list, as compose
    already did.
  - **AUDIT-FINDINGS §14 H13** — Scratch canvases are zeroed after their `ImageData` is
    extracted.
- **AC:** The fixes are present at the cited sites. **Remaining (H3, unrun):** a performance trace
  of importing a 4000×3000 signature image shows no main-thread task longer than 50 ms.

### HRD-28 · Edge-case bounds and small correctness fixes — `S` `P2`

**Status: Done; four Low items accepted** — M1–M19 were resolved on 2026-09-16 (M1 is deliberate, M13 was inaccurate, M19 is not actionable). L1–L18 are resolved except four: L1 (deferred), L5 (cannot be verified here), L8 (won't fix) and L16 (accepted). L18 is moot because the face-detector weights are now bundled (RED-08).

Canonical tag: `AUDIT-FINDINGS §14` (Medium M1–M19, Low L1–L18).

- **Requirements:**
  - **AUDIT-FINDINGS §14 M1** — Deleting every page is allowed, on purpose; export then
    says "Nothing to export" instead of failing.
  - **AUDIT-FINDINGS §14 M2** — Tooltip runs a child's own event handlers before its own,
    rather than overwriting them.
  - **AUDIT-FINDINGS §14 M3** — `revokeHandle` only touches IndexedDB when
    `hasFileSystemAccess()` is true.
  - **AUDIT-FINDINGS §14 M4** — Pixel diff sums RGB only, to match its 765 threshold.
  - **AUDIT-FINDINGS §14 M5** — Markdown table column width is safe when the header is
    empty.
  - **AUDIT-FINDINGS §14 M6** — A Markdown table row taller than a page flows onto the next
    pages.
  - **AUDIT-FINDINGS §14 M7** — `toRgba` refuses images over 40 MP instead of allocating
    around 400 MB.
  - **AUDIT-FINDINGS §14 M8** — HEIC and TIFF import checks the `AbortSignal` for each frame
    and each image.
  - **AUDIT-FINDINGS §14 M9** — `bytesForPages` reads distinct sources concurrently.
  - **AUDIT-FINDINGS §14 M10** — `cropBoxes` and `pageAnnotations` entries are pruned once
    no document's pages or baseline reference the key (`pruneOrphanedPageState`, called
    only from the mutators).
  - **AUDIT-FINDINGS §14 M11** — The first render waits for `initLocale()`, so there is no
    flash of unlocalised text.
  - **AUDIT-FINDINGS §14 M12** — The in-memory search-index fallback is capped at 20,000
    records.
  - **AUDIT-FINDINGS §14 M13** — `listSignatures()` never rejects (it is wrapped in
    `guard()`), so no change was needed.
  - **AUDIT-FINDINGS §14 M14** — `localStorage` reads and writes in i18n are wrapped in
    try/catch.
  - **AUDIT-FINDINGS §14 M15** — The shortcuts settings promise chain has a `.catch`.
  - **AUDIT-FINDINGS §14 M16** — `douglasPeucker` is iterative, so it cannot overflow the
    stack.
  - **AUDIT-FINDINGS §14 M17** — `rotateImageData` caps its `fit` output at 40 MP.
  - **AUDIT-FINDINGS §14 M18** — The formula tokenizer uses a trie, so each lookup costs
    O(name length).
  - **AUDIT-FINDINGS §14 M19** — Freeing tensors when a worker is terminated externally is
    the browser's job; not actionable here.
  - **AUDIT-FINDINGS §14 L1** — Deferred: `supportsFileSystemAccess` is evaluated once at
    module load. That is acceptable because browser globals exist before any module runs.
  - **AUDIT-FINDINGS §14 L2** — Tooltip clears its hide timer on unmount.
  - **AUDIT-FINDINGS §14 L3** — `isAbort` treats `NotAllowedError` as a silent cancel.
  - **AUDIT-FINDINGS §14 L4** — `saveViaDownload` returns `false` on a synchronous failure,
    and documents that `true` does not guarantee the download completed.
  - **AUDIT-FINDINGS §14 L5** — Unverified: the action listener returns the open promise
    (`openEditorOnce`). Confirming the MV3 service-worker lifetime window needs a real
    Chrome.
  - **AUDIT-FINDINGS §14 L6** — TIFF decode zeroes each frame's canvas after use.
  - **AUDIT-FINDINGS §14 L7** — `open-document.ts` uses `imported.pages` instead of making a
    second set of page refs.
  - **AUDIT-FINDINGS §14 L8** — Won't fix: the 200-entry diagnostic log keeps using
    `shift()`.
  - **AUDIT-FINDINGS §14 L9** — Text-layout line grouping is O(items).
  - **AUDIT-FINDINGS §14 L10** — Shortcut writes are serialised on one `writeChain`.
  - **AUDIT-FINDINGS §14 L11** — QR data too large to encode gets a clear message.
  - **AUDIT-FINDINGS §14 L12** — Logo matching uses Rec. 709 luma, like `enhance.ts`.
  - **AUDIT-FINDINGS §14 L13** — If a locale fails to load, the previous locale stays
    active.
  - **AUDIT-FINDINGS §14 L14** — A summary card taller than a page is truncated with an
    "N more lines not shown" note.
  - **AUDIT-FINDINGS §14 L15** — Highlight height falls back to a square aspect when the
    page aspect is `NaN`.
  - **AUDIT-FINDINGS §14 L16** — Accepted: `FinalizationRegistry` is only a backstop, since
    every `pin()` caller calls `release()` explicitly.
  - **AUDIT-FINDINGS §14 L17** — OCR model downloads use `Promise.allSettled` and report
    every failure.
  - **AUDIT-FINDINGS §14 L18** — Moot: the face-detector weights are bundled (RED-08). The
    finding was a `Content-Length` pre-check on a download that no longer exists.
- **AC:** The fixes are present at the cited sites, and the existing formula, text-layout,
  edge-detection, logo-match and OCR suites pass unchanged.

### HRD-29 · Architecture: per-document undo, document cap, modal queue, worker death — `M` `P1`

**Status: Done** — G1 and G2 shipped as DOC-15, and G3 with §14 C1. G4's premise was wrong (AUDIT-2026-09-25 RT-1): a crashed worker made every call *hang*, not reject. That is fixed, and calls on a dead worker now reject. Automatic retry is deliberately not implemented.

Canonical tags: `AUDIT-FINDINGS G1` to `AUDIT-FINDINGS G4` (§14 Architectural).

- **Requirements:**
  - **AUDIT-FINDINGS G1** — Each document has its own undo/redo stack, and closing one never
    touches another's history. Was: one global stack of whole-workspace snapshots (H6 had
    narrowed the damage).
  - **AUDIT-FINDINGS G2** — There is a ceiling on open documents, with a clear message: 20
    documents, plus a confirmation past a 1.5 GiB soft limit. Was: no ceiling.
  - **AUDIT-FINDINGS G3** — Confirmation-style requests share one FIFO queue (§14 C1).
  - **AUDIT-FINDINGS G4** — When a worker crashes or fails to boot, every in-flight and
    pinned call rejects promptly (each call is in a reject set and removed when it
    settles). Render handles owned by the dead instance are evicted, the user is told to
    retry, and the next call gets a fresh worker. There is no automatic retry, because a
    retry is not provably safe for an operation that was partly applied. Was: the audit said
    "the lease just rejects"; in fact it hung forever.
- **AC:** DOC-15's AC; `tests/unit/worker-crash.test.ts` ("rejects an in-flight lease when
  the worker errors, instead of hanging", "a pinned client whose instance died throws
  immediately and reports dead", "reopens on a fresh instance instead of handing out the
  dead handle").

### HRD-30 · The raster compression route never corrupts what it re-renders — `M` `P0`

**Status: Done (re-verified 2026-10-05)** — Open: none.

CMP-02's raster route is the most common real input path: landscape phone scans with a
stamp or a link.

- **Requirements:**
  - **AUDIT-EDGE-CASES-2026-09-15 §1.2**: a `/Rotate 90/180/270` page is rotated exactly once. pdf.js already bakes rotation into the raster, so the rebuilt page doesn't re-apply `/Rotate`. Was: double-rotated, and a 792×612 raster squeezed into a 612×792 box. Tests: `tests/unit/compress-raster-page.test.ts` › "the raster route does not rotate a page twice (§1.2)" (unrotated fill, `/Rotate 90/270` upright, "turns a /Rotate 180 page exactly once").
  - **AUDIT-EDGE-CASES-2026-09-15 §1.3**: a rasterised page keeps its `/Annots` (links with URI actions, comments, widgets) at unchanged geometry, and does not drag the replaced page in with them. Was: `/Annots [ ]`. Tests: `compress-raster-page.test.ts` › "the raster route carries annotations forward (§1.3)".
  - **AUDIT-EDGE-CASES-2026-09-15 §1.6**: any real selectable text, however short (a Bates number, "Page 1 of 12"), keeps a page off the raster route. Was: `MEANINGFUL_TEXT_CHARS = 24`, so 23 characters were flattened into a JPEG while the report said "no extractable text". Tests: `tests/unit/compress-plan.test.ts` › "never rasterises a page that has extractable text", "keeps a sparse text-only page out of the raster path". This also closes AUDIT-2026-08-17 §3 #12.
- **AC:** Compressing a textless `/Rotate 90` scan that has one `/Link` gives an upright page of the same box, whose `/Annots` holds that link. A page with 1 character of real text is never routed `raster`.

### HRD-31 · Redaction, Protect and XFA never weaken a guarantee silently — `M` `P0`

**Status: Done (re-verified 2026-10-05)** — Open: none.

- **Requirements:**
  - **AUDIT-EDGE-CASES-2026-09-15 §1.4**: the redaction verifier and the strip step cover every place a string can live off the painted page. That means `/A /URI` (including chained `/Next`), `/RC` with no `/Contents` (string or stream), `/TU`, `/DV`, check box `/V`/`/AS`, values on widgetless and `/Kids` fields, and `FileAttachment` `/FS /EF` contents and names. Was: only `/Contents` and text/choice values were scanned, so the save passed with the secret still in the bytes. Tests: `tests/unit/redaction-offpage-text.test.ts` › "collectOffPageText sees text a viewer never paints (§1.4)", "the redaction strip step clears the same values (§1.4)".
  - **AUDIT-EDGE-CASES-2026-09-15 §1.5**: turning Protect on never re-grants a bit the input's `/P` forbids, including bits 6 (annotate), 9 (fill forms) and 12 (high-quality print), which have no UI toggle. Was: they were re-granted from the `-4` base flags. Tests: `tests/unit/permission-restrictions.test.ts` › "turning Protect on never loosens an inherited restriction (§1.5)" (per-bit cases, "writes the preserved bit into the encrypted output bytes").
  - **AUDIT-EDGE-CASES-2026-09-15 §1.7**: XFA is detected by the parsed catalog check as well as the byte scan, so an object-stream-encoded XFA form is refused for compose, fill and flatten, and reported at import. Was: `hasXfaMarker` alone missed it, and pdf-lib had already stripped `/XFA` (no `preserveXFA`). Tests: `tests/unit/xfa-object-stream.test.ts` › "an object-stream-encoded XFA form is still detected (§1.7)".
- **AC:** Redacting a string that also appears in a URI, a tooltip, an `/RC` and an attachment either removes it from all of them or blocks the save. A `/P` forbidding only bit 9 still forbids it after Protect. An object-stream XFA form refuses compose with `XFA_COMPOSE_MESSAGE`.

### HRD-32 · Import and session safety — `S` `P0`

**Status: Done (2026-10-05)** — §1.1 now has its e2e: `tests/e2e/drop-guard.spec.ts` › "HRD-32 §1.1 — dropping a file on an open document" drops a PDF on a page tile, the top bar and the window itself, and asserts the drop is cancelled, the "Add PDF" hint shows, and the URL, the tab and its three pages survive; "with nothing open, a PDF dropped on the window opens exactly one tab". §1.8's truncated input is covered end to end: `tests/e2e/batch-folder.spec.ts` › "three bad files fail with classified reasons; the two good ones are written" (`not-a-pdf.pdf`, an empty file and `truncated-mid-body.pdf`), plus "the same folder to a ZIP holds only the good files". Open: none.

- **Requirements:**
  - **AUDIT-EDGE-CASES-2026-09-15 §1.1**: a file dragged from the OS and dropped anywhere in the app never triggers the browser's default navigation. Was: `PageGrid` called `preventDefault` only for internal reorder drags, so a drop navigated the tab away and lost the whole workspace. Now a window-level `dragover`/`drop` guard in `src/ui/shell/AppShell.tsx` points at "Add PDF" when a document is open. **Follow-on regression, fixed:** the window handler double-imported Home drops (AUDIT-2026-09-25 UI-2). It now skips `defaultPrevented` events (`tests/e2e/audit-2026-09-25.spec.ts` › "UI-2: a PDF dropped on the Home drop zone opens exactly one tab"). **Closed 2026-10-05:** a test now drops a file onto an open document and asserts the tab stays put with its documents (`tests/e2e/drop-guard.spec.ts`).
  - **AUDIT-EDGE-CASES-2026-09-15 §1.8**: batch input goes through the same gate as `importPdf`: empty check, PDF header sniff, then a pdf.js parse with page count > 0. A bad file fails with a classified message and the run continues. Was: a raw `TypeError` from `getOrCreateAcroForm`, or a 95%-truncated 100-page file silently processed as 74 pages. Tests: `tests/unit/batch-runner.test.ts` › "§1.8: a bad file in a batch folder fails cleanly" ("rejects a file with no PDF header…", "rejects an empty file cleanly"). Probed 2026-10-05: a 95% or 80% truncated file is refused by pdf.js ("Invalid PDF structure"), so the gate holds; the committed truncated-file case is the e2e `tests/e2e/batch-folder.spec.ts` (`truncated-mid-body.pdf`).
  - **AUDIT-EDGE-CASES-2026-09-15 §1.9**: OPFS `writeSourceBytes` turns `QuotaExceededError` into the same actionable "Local storage is full…" message IndexedDB already gives. Was: "Something went wrong". Tests: `tests/unit/opfs.test.ts` › "turns a QuotaExceededError into a clear, actionable message", "writes normally when there is room".
- **AC:** An e2e drops a PDF onto the page grid of an open document: the URL is unchanged, the open tabs survive, and the "Add PDF" hint shows. A batch folder holding `not-a-pdf.pdf`, an empty file and `truncated-mid-body.pdf` reports three classified failures and still processes the good files.

### HRD-33 · Concurrency and partial failure never cost the whole job — `M` `P0`

**Status: Done (re-verified 2026-10-05)** — §2.2 was completed by AUDIT-2026-09-25 RT-8. §2.6 is moot because the face weights are now bundled (AUDIT-2026-09-25 CONV-6). Open: none.

- **Requirements:**
  - **AUDIT-EDGE-CASES-2026-09-15 §2.1**: `runBatch` has a synchronous reentrancy guard set before its first `await`, and only the owning run's `AbortController` is replaced. Was: a double click ran two interleaved batches, and Cancel stopped only the newer one. Tests: `batch-runner.test.ts` › "§2.1: a second concurrent runBatch() call is a no-op" ("only the first call actually processes files", "a run started after the first one finishes is not blocked").
  - **AUDIT-EDGE-CASES-2026-09-15 §2.2**: undo and redo refuse to run while a job is active, so a slow export can't stamp a stale baseline. Was: Ctrl+Z during a pending save made the next Export Review diff wrong. Tests: `tests/unit/history.test.ts` › "undo/redo refuse to run while a job is active (§2.2)". Extended by RT-8: every user-facing page mutator is guarded via `src/ui/busy.ts`.
  - **AUDIT-EDGE-CASES-2026-09-15 §2.3**: OCR renders each page inside its own try/catch, with the render scale clamped (`clampRenderScale`). A page that can't be rendered is recorded in `skippedPages` and reported, and every other page's recognition is kept. Was: one oversized page (legal up to 14,400 pt) discarded the whole run. Tests: `tests/unit/ocr.test.ts` › "skips only the page that failed and keeps recognition from the others".
  - **AUDIT-EDGE-CASES-2026-09-15 §2.6**: face-detector weights can't be corrupted or stuck in a cache. Was: a truncated shard was cached forever, with no delete path. **Superseded:** the weights are bundled (`src/core/faceblur/bundledWeights.ts`), with no download, consent or CSP path. Tests: `tests/unit/faceblur-offline.test.ts` › "decodes to exactly the files shipped in the installed face-api package", "checks the shard length against the tensor shapes its manifest declares", "has no network allowance left: model.ts names no host and no URL".
- **AC:** Double-pressing Run Batch processes each file once. Ctrl+Z during an export is a no-op. OCR over a document with one 14,400 pt page returns text for the other pages and names the skipped one.

### HRD-34 · Compression classification: decode, mask and size edge cases — `M` `P0`

**Status: Done (re-verified 2026-10-05)** — Open: none. The stale fixture test noted under HRD-39 §6 #2 was fixed on 2026-10-05.

- **Requirements:**
  - **AUDIT-EDGE-CASES-2026-09-15 §2.4**: the undecodable-filter skip list checks an image's `/SMask`/`/Mask` filter chain as well as its own (`maskFilters`). Was: a FlateDecode photo with a JPX soft mask went to `surgical`. Tests: `tests/unit/compress-edge-cases.test.ts` › "§2.4 the skip list inspects the mask's filter chain, not just the image's".
  - **AUDIT-EDGE-CASES-2026-09-15 §2.5**: a replacement JPEG that pdf-lib can't parse (`embedJpg` throws) skips one image on the surgical route, or one page on the raster route, and keeps the original. Was: `SOI not found in JPEG` aborted `rebuildCompressed`. Tests: `compress-edge-cases.test.ts` › "§2.5 an unparseable replacement JPEG skips one image, not the whole run".
  - **AUDIT-EDGE-CASES-2026-09-15 §2.9**: bit depth below 8 keeps an image off the surgical route only. It never blocks rasterising the page. Was: 1-bit fax scans got zero compression and a false "already optimized". Tests: `compress-edge-cases.test.ts` › "§2.9 a 1-bit bilevel scan can still be rasterised".
  - **AUDIT-EDGE-CASES-2026-09-15 §2.10**: a stream whose stored size can't be read is "unmeasurable, skip", which is distinct from a real 0-byte stream. Was: both returned `0`, hiding a 0 → 20,000-byte growth. Tests: `compress-edge-cases.test.ts` › "§2.10 a stream whose size cannot be read is not treated as empty".
- **AC:** Each of the four cases, built from real pdf-lib objects, gives the stated route or skip, and output never exceeds input (CMP-04).

### HRD-35 · Scan cleanup survives degenerate geometry and blank pages — `S` `P1`

**Status: Done (re-verified 2026-10-05)** — Open: none.

- **Requirements:**
  - **AUDIT-EDGE-CASES-2026-09-15 §2.7**: a degenerate crop quad (collinear, coincident, near-collinear or pinpoint corners) returns the page unchanged. A genuinely thin page at a sharp angle still warps. Was: a solid black page or a 1×1 image, despite a comment promising otherwise. Tests: `tests/unit/warp-target-size.test.ts` › "degenerate quads" ("returns the page unchanged for three collinear corners, not a black page", "…for four coincident corners, not a 1x1 image", "still warps a genuinely thin page photographed at a sharp angle").
  - **AUDIT-EDGE-CASES-2026-09-15 §2.8**: deskew reports zero skew when no angle beats the others (blank, uniform or faint pages), and never resizes such a page. Was: `bestScore = -1` let the first candidate win (−16° on a blank page, output 399×468). Tests: `tests/unit/enhance.test.ts` › "a page with no skew signal" ("reports no skew for a blank page rather than the first angle tried", "does not resize a blank page on its way through deskew", "holds the ±maxDegrees bound even when the winner is at the edge").
- **AC:** Cleanup with default deskew on an all-white page returns the same dimensions. Dragging three handles into a line leaves the page as it was.

### HRD-36 · Redaction fidelity: layers, notes, Type 3, forms, disclosure — `M` `P0`

**Status: Done (2026-10-05)** — The §3 #1 fix was undone by the mandatory scrub (AUDIT-2026-09-25 PDF-5 ⟲ regression) and fixed again. The Form XObject without `/BBox` now has its own tests: `tests/unit/redaction-form-no-bbox.test.ts` › "a mark over part of a whole-page form with no /BBox filters inside it", "honours the form /Matrix when there is no /BBox to measure", "a no-/BBox form nested in a no-/BBox form is filtered recursively", "refuses, and changes nothing, when a no-/BBox form's content cannot be read". Open: none.

- **Requirements:**
  - **AUDIT-EDGE-CASES-2026-09-15 §3 #1**: redaction keeps a hidden optional-content layer hidden. `/OCProperties` is carried over and relinked (including `/OC` on XObjects), and survives the pipeline's mandatory metadata scrub. Was: `/OCProperties` was stripped, so an OFF layer rendered and printed. **Contradicted by AUDIT-2026-09-25 §4 / PDF-5, now true again:** the scrub keeps `/OCProperties` by default. Tests: `tests/unit/redaction-optional-content.test.ts` › "redaction keeps a hidden layer hidden (§3)", including "keeps the layer hidden through the pipeline's mandatory metadata scrub (PDF-5)".
  - **AUDIT-EDGE-CASES-2026-09-15 §3 #2**: annotation text is read from pdf.js 6.x's `contentsObj.str`, so find-and-mark and the verifier see sticky notes. Was: `.contents`, always `undefined`. Tests: `tests/unit/annotation-contents-pdfjs.test.ts` › "pdf.js exposes annotation text as contentsObj, not contents (§3)".
  - **AUDIT-EDGE-CASES-2026-09-15 §3 #3**: Type 3 glyphs are measured through their `/FontMatrix` (`glyphSpaceScale`). Was: LaTeX/dvips runs measured ~0.14 pt wide, so redaction was blocked on them. Tests: `tests/unit/redaction-type3-font.test.ts` › "applyRedactions on a real Type 3 document (§3)".
  - **AUDIT-EDGE-CASES-2026-09-15 §3 #4**: a mark that partly covers a Form XObject filters the form's own content (recursively, up to `MAX_FORM_DEPTH`). A form with no `/BBox` is judged by its content, not the unit square. Refusal happens only when the content can't be read. Was: an outright refusal, unusable on producers that wrap the whole page in one form. Tests: `tests/unit/process.test.ts` › "filters inside a partly covered Form XObject rather than deleting the whole form"; `tests/unit/redaction-form-no-bbox.test.ts` (forms with no `/BBox`, added 2026-10-05).
  - **AUDIT-EDGE-CASES-2026-09-15 §3 #5**: what redaction drops is disclosed before saving: bookmarks, attached files, named destinations, structure tree, metadata/XMP. Page labels and layer visibility are kept (`RedactPanel.tsx` copy). Was: dropped silently (`bookmarked-9.pdf` went from 3 bookmarks to 0).
- **AC:** A hidden-layer secret stays hidden through `applyRedactions` plus the scrub. A sticky note containing the search term is marked. A Type 3 run under a mark is removed and its neighbour is kept. Redaction on a whole-page form succeeds.

### HRD-37 · Save, reopen, search and convert error paths stay specific — `S` `P1`

**Status: Done (2026-10-05)** — The Recents, folder-search and ZIP-picker fixes now have e2e tests: `tests/e2e/recents-folder-search.spec.ts` › "a Recents entry reopens the file it was opened from", "a Recents entry whose file was deleted says it moved, and opens nothing" (§3 #7), "HRD-37 §3 #9 — folder search shows the latest query, not a slower earlier one"; `tests/e2e/batch-folder.spec.ts` › "HRD-37 §3 #10: without a save picker, "Select Output ZIP" says why instead of a raw error". Accepted limitation: XLSX RTL is sheet-level only (§3 #8). Open: none.

- **Requirements:**
  - **AUDIT-EDGE-CASES-2026-09-15 §3 #6**: `saveOverHandle` returns `false` when `createWritable()` throws (file moved or deleted, `NotFoundError`/`NoModificationAllowedError`), so the "Could not save over the original file… save a new file instead" copy appears. Tests: `tests/unit/file-system.test.ts` › "returns false, rather than throwing, when the file was moved or deleted since it was opened".
  - **AUDIT-EDGE-CASES-2026-09-15 §3 #7**: reopening from Recents a handle that says `granted` but whose file is gone shows "Permission was declined, or the file has moved. Open it again from disk." (`HomeView.tsx`, `getFile()` guarded). Test: `tests/e2e/recents-folder-search.spec.ts` (2026-10-05).
  - **AUDIT-EDGE-CASES-2026-09-15 §3 #8**: PDF→Word/Excel/PowerPoint mark RTL text right-to-left with each format's real API (`<w:bidi/>`/`<w:rtl/>`/`<w:bidiVisual/>`, `<sheetView rightToLeft="1"/>`, `rtl="1"`) via `src/core/convert/text-direction.ts`. Tests: `tests/unit/text-direction.test.ts`; `pdf-to-word.test.ts` › "CNV-08 — RTL text is flagged right-to-left, not silently left-to-right"; `pdf-to-excel.test.ts` › "CNV-10 — an RTL sheet is flagged right-to-left…"; `pdf-to-ppt.test.ts` › "CNV-12 — RTL text is flagged right-to-left…". **Open (accepted):** a mixed-direction XLSX sheet takes its majority direction. Per-cell `readingOrder` would need a styles part (documented in `xlsx-writer.ts`).
  - **AUDIT-EDGE-CASES-2026-09-15 §3 #9**: folder-search results apply only for the latest query (`searchSeq` in `FolderSearchPanel.tsx`). Was: an earlier, slower query could overwrite a newer one. Test: `tests/e2e/recents-folder-search.spec.ts` (2026-10-05).
  - **AUDIT-EDGE-CASES-2026-09-15 §3 #10**: Batch's ZIP-output picker checks `hasFileSystemAccess()` like its sibling buttons and says "Folder processing requires Chrome or Edge." Was: a raw "showSaveFilePicker is unavailable" on Firefox/Safari. Test: `tests/e2e/batch-folder.spec.ts` (2026-10-05).
- **AC:** Saving over a deleted file shows the friendly copy. An Arabic PDF converted to DOCX, XLSX and PPTX opens right-to-left in each.

### HRD-38 · Low-severity limits and process guards — `S` `P2`

**Status: Done (re-verified 2026-10-05)** — §4 #5 is by design. Open: none.

- **Requirements:**
  - **AUDIT-EDGE-CASES-2026-09-15 §4 #1**: both invariant checkers (`.claude/hooks/check-invariants.mjs`, `scripts/check-invariants.mjs`) validate `content_security_policy.extension_pages` against the allowlist in `scripts/csp.mjs`. They read the real `public/manifest.json`. Was: the CSP wasn't checked per write, and the whole-repo script read a non-existent root `manifest.json`, so even its permissions check was a no-op. Tests: `tests/unit/csp.test.ts` › "refuses a bare CDN host, a remote source outside connect-src, and a missing default-src", "the invariant hook duplicates the same allowlist".
  - **AUDIT-EDGE-CASES-2026-09-15 §4 #2**: the scan-cleanup warp target has an absolute pixel cap as well as `MAX_PIXEL_GROWTH = 2`. Was: 16851×7999 (~539 MB RGBA) from a 10000×8000 frame. Tests: `warp-target-size.test.ts` › "caps the output at a real canvas can allocate, even on a large source frame", "leaves an ordinary photo at its correctly-computed size, unaffected by the absolute cap".
  - **AUDIT-EDGE-CASES-2026-09-15 §4 #3**: batch's never-grow rollback discards only the compression step. Tools after it (for example watermark) are replayed, and restrictions are re-applied to the replayed result. Was: the watermark was lost, and the note mentioned only compression. Tests: `batch-runner.test.ts` › "discarding compression does not also discard a tool that ran after it, and still restricts the result".
  - **AUDIT-EDGE-CASES-2026-09-15 §4 #4**: PDF→Excel caps detected table columns at `MAX_SHEET_COLUMNS` (shared with `xlsx-reader.ts`) and says so. Tests: `pdf-to-excel.test.ts` › "caps a detected table at Excel's practical column limit and says so", "leaves an ordinary table under the column limit untouched, and says nothing about it".
  - **AUDIT-EDGE-CASES-2026-09-15 §4 #5**: on Firefox < 127 (no `runtime.getContexts`), each toolbar click opens a new tab. This is an accepted trade-off for zero permissions, feature-detected rather than UA-sniffed. Test: `service-worker.test.ts` › "falls back to opening a fresh tab when getContexts does not exist (pre-127 Firefox)".
- **AC:** Adding `https://cdn.example` to the manifest CSP fails the hook on write and fails `pnpm check`.

### HRD-39 · Confirmed-clean baselines stay clean; coverage holes stay closed — `S` `P1`

**Status: Done (2026-10-05)** — §6 #2: by owner decision, a textless JBIG2/JPX page may take the raster route (pdf.js renders both; the raster route never re-reads the stream), while the spot-colour (`/Separation`, `/DeviceN`) and stencil (`/ImageMask`) blocks still apply to such images (`tests/unit/compress-edge-cases.test.ts` › "refuses to rasterise a textless page carrying %s", "still rasterises a textless page whose image carries a JPX/JBIG2 mask (HRD-39)"). The fixture test is fixed: `compress-plan-fixtures.test.ts` asserts `plan.pages[0].route` on the real `jbig2.pdf`/`jpx.pdf` (raster when textless, skip with the reason when text is present), and classifies `indexed`/`icc`/`soft-mask.pdf` at their own 1×1 size. §6 #7's truncated-input batch case is covered by `tests/e2e/batch-folder.spec.ts` (HRD-32). One §5 claim (HEIC) was contradicted and later made true, now also in the extension e2e (HRD-51). Open: none.

§5 lists what the audit found clean. Each is now a requirement, so a regression is a
defect, not a surprise. §6 lists the test holes behind §1–§2.

- **Requirements:**
  - **AUDIT-EDGE-CASES-2026-09-15 §5 #1**: no `src/` violation of zero network, zero permissions, no raw colours or the layer boundary. `fetch(FONT_URL)` in `src/core/ocr/devanagariFont.ts` stays a same-origin bundled asset. ESLint's `chrome` restriction stays scoped. Guarded by the hook, `pnpm check` and the zero-network e2e plus post-build network scan.
  - **AUDIT-EDGE-CASES-2026-09-15 §5 #2**: compress, redact, scan cleanup, OCR and convert thread an `AbortSignal`/`JobHandle` through `checkpoint()` before any work that affects output.
  - **AUDIT-EDGE-CASES-2026-09-15 §5 #3**: every locale has exactly `en.json`'s key set. Since UI-8 this is enforced by a coverage test that includes worker messages.
  - **AUDIT-EDGE-CASES-2026-09-15 §5 #4**: picker cancellation, directory-picker feature detection, 0-byte and non-PDF rejection, the > 100 MB warning, IndexedDB quota handling and the web adapter stay implemented and tested.
  - **AUDIT-EDGE-CASES-2026-09-15 §5 #5**: `encrypted.pdf` and `not-a-pdf.pdf` are refused with classified errors. AES-256/R6 permission-only round-trips keep `/P` exactly, including `0` and `2147483647`.
  - **AUDIT-EDGE-CASES-2026-09-15 §5 #6**: the redaction save gate has one caller that both search and pattern redaction funnel through, and it does a full rewrite after `sweepUnreachableObjects`, leaving no incremental-update remnants.
  - **AUDIT-EDGE-CASES-2026-09-15 §5 #7**: HEIC EXIF orientation, cancelling tesseract mid-run, oversized-file warnings, malformed docx/xlsx/pptx zips and empty sheets/slides/documents keep working with tests. **Contradicted by AUDIT-2026-09-25 §4 / CONV-1:** HEIC hung in the extension (heic2any's `new Function` vs the MV3 CSP). It is now true with the libheif WASM decoder, and since 2026-10-05 the extension e2e has HEIC cases (`tests/e2e/extension/tool-flows.spec.ts`, HRD-51).
  - **AUDIT-EDGE-CASES-2026-09-15 §6 #1**: `rebuildCompressed` is driven with an `/SMask`, a `/Mask` and a rotated page. **Closed** by `compress-raster-page.test.ts` and `compress-edge-cases.test.ts`.
  - **AUDIT-EDGE-CASES-2026-09-15 §6 #2**: fixture tests assert the routing decision on the real fixture. **Closed 2026-10-05** (JBIG2/JPX may take the raster route by owner decision; the test now asserts the route and classifies at the fixtures' own size). Was: `tests/unit/compress-plan-fixtures.test.ts` still asserted only `reencode: []` for `jbig2.pdf`/`jpx.pdf`. Its comment ("still compressible via the raster route") was wrong: `blocked()` set `raster: false`, so the textless page routed `already-optimized` with "cannot be safely rasterized". The `it.each` over `indexed`/`icc`/`soft-mask.pdf` overwrote the fixture's dimensions (3000×4000) before classifying. Needed: assert `plan.pages[0].route` and fix the comment, and decide whether JBIG2/JPX should block the raster route at all, since pdf.js renders both and the raster route never re-reads the stream (the same reasoning as §2.9).
  - **AUDIT-EDGE-CASES-2026-09-15 §6 #3**: `enhance.test.ts` covers blank and faint input, and the collinear quad goes through `warpPerspective`. **Closed** (HRD-35 tests).
  - **AUDIT-EDGE-CASES-2026-09-15 §6 #4**: redaction tests cover annotations, form fields, outlines, embedded files, optional content, Type 3 and Form XObject recursion. **Closed** (HRD-31 and HRD-36 tests), including the no-`/BBox` form since 2026-10-05 (`redaction-form-no-bbox.test.ts`).
  - **AUDIT-EDGE-CASES-2026-09-15 §6 #5**: an OCR test covers a page that fails to render. **Closed** (`ocr.test.ts` § 2.3 block, simulated render failure).
  - **AUDIT-EDGE-CASES-2026-09-15 §6 #6**: face-model truncated, aborted and corrupt-cache cases. **Moot:** the weights are bundled (HRD-33 §2.6).
  - **AUDIT-EDGE-CASES-2026-09-15 §6 #7**: batch is tested with a non-PDF input and a double "Run Batch". **Closed** (HRD-32, HRD-33), including a truncated-input case since 2026-10-05 (`tests/e2e/batch-folder.spec.ts`).
  - **AUDIT-EDGE-CASES-2026-09-15 §7**: the priority order (§1.1 → §1.2/§1.3 → §1.4 → §1.5 → rest) was followed, and all of it is done.
- **AC:** `compress-plan-fixtures.test.ts` asserts the real route for `jbig2.pdf` and `jpx.pdf`, and classifies at the fixtures' own dimensions.

### HRD-40 · One object copier per rebuild, page refs remapped (root cause M1) — `M` `P0`

**Status: Done (AUDIT-2026-09-25 fixes, 2026-09-26; not regressed per AUDIT-2026-10-01 §0)** — `src/core/pdf/rebuild.ts` is the single rebuild path; `tests/unit/rebuild-page-links.test.ts` re-parses output bytes for every finding below. **Closed 2026-10-05:** (1) the size doubling: pdf-lib wrote every rebuilt catalog, page-tree node and page leaf as a plain uncompressed object, and `compactStructuralObjects` (`src/core/pdf/compact-save.ts`) now lets them go into object streams on a full save, in redaction, the scrub, compose/extract/split and n-up. The 100-page corpus fixture measured 28,196 B in, 28,234 B after redaction and 28,113 B after redact → scrub (`tests/unit/redaction-size.test.ts`, ≤ 1.05× input; `tests/unit/rebuild-size.test.ts` for compose, extract, split and n-up). Compress deliberately does not use compaction: by product decision, it would otherwise count a ~0% structural gain as compression. (2) The lint rule: `eslint.config.js` bans `copyPages`/`embedPage`/`embedPages`/`embedPdf` inside a loop outside `src/core/pdf/rebuild.ts` (`tests/unit/lint-rebuild-copier.test.ts`). R-PDF-4 accepted as-is. Open: none.

Calling `copyPages(src, [i])` or `embedPage()` per page built a fresh `PDFObjectCopier`
each time, so pdf-lib duplicated every shared font/image per page and made an orphan copy
of any page something else pointed at (annot `/P`, link `/Dest`, sibling widget) — and the
orphan kept the original, unredacted content stream. One root cause behind the audit's
worst privacy leak, a page-exclusion leak and 10× output inflation.

- **Requirements:**
  - **AUDIT-2026-09-25 M1** — Every operation that rebuilds a document (compose, extract/
    split, compress, scrub, redact, n-up, watermark) uses one copier per rebuild via
    `rebuildDocument` (`src/core/pdf/rebuild.ts`): source→output page refs registered
    *before* copying; `/Dest`, `/GoTo` and `/P` remapped; links to excluded pages nulled;
    unreachable objects swept. A lint rule bans direct `copyPages`/`embedPage` inside
    loops (written 2026-10-05: `eslint.config.js`, `tests/unit/lint-rebuild-copier.test.ts`).
    Was: a fresh copier per page in `process.worker.ts`.
  - **AUDIT-2026-09-25 PDF-1** (🔴) — A redacted page's original content must not survive
    anywhere in the output file — no orphan page copy with the old `/Contents`, `/Thumb` or
    `/PieceInfo` — even when an annotation `/P`, a TOC `/Dest` or a widget references the
    page, and including after the scrub step. Was: all three variants leaked, recoverable
    with `strings`/qpdf, and the verifier said "verified" (see HRD-41 for M7).
    Tests: `rebuild-page-links.test.ts`, `pdf-regression-review.test.ts`.
  - **AUDIT-2026-09-25 PDF-6** (🟠) — Rebuilds keep internal links working, and
    Extract/Split never ships a page the user excluded. Was: extracting page 1, which
    linked to page 3, put page 3's full text in the output; merge, compress, scrub and
    watermark killed TOC and footnote links. Test: `rebuild-page-links.test.ts`.
  - **AUDIT-2026-09-25 PDF-7** (🟠, ⟲ REGRESSION) — Shared resources are copied once per
    rebuild, not once per page. Was: `shared-image.pdf` redaction 4.7 MB → 46.8 MB (now
    4.69 MB), and a 300-page file with a big font could crash the worker, while
    AUDIT-FINDINGS §0 claimed redaction already shared one copier. Test:
    `rebuild-page-links.test.ts`.
  - **AUDIT-2026-09-25 PDF-11** (🟠) — A form value redacted on one widget is cleared on the
    *merged* field, and every sibling widget's appearance is regenerated, so the value
    neither reads back from the form nor sits in the bytes. Was: `ssn=SSN123456789`
    survived on the field's other widgets and the result was marked verified. Test:
    `rebuild-page-links.test.ts`.
  - **AUDIT-2026-09-25 PDF-12** (🟡) — N-up embeds all source pages in one
    `embedPages(allPages)` call (no per-cell duplication), and tells the user which links,
    comments and fields it drops. Was: ~10× size and silent drops. Also: n-up must work on
    pages with no `/Contents` (found in §8, present on master too). Test:
    `rebuild-page-links.test.ts`.
  - **AUDIT-2026-09-25 PDF-13** (🟡) — The metadata scrub (and so every redaction, which runs
    it) carries bookmarks, page labels, the tag tree, `/Lang` and OutputIntents through
    unless the user ticks them. Was: all dropped with nothing ticked — navigation,
    accessibility and PDF/A conformance lost. Test: `rebuild-page-links.test.ts`.
  - **AUDIT-2026-09-25 R-PDF-4** — Accepted limit: rebuilt files are 1–3.5% larger than
    before the fix; removing it needs a whole-graph renumbering pass. Re-evaluate only with
    a measured case where it matters.
- **AC:** On fixtures where an annotation, link or widget references the redacted page,
  `strings` and qpdf find no redacted text and no `/Type /Page` outside the page tree;
  extract of a page that links to an excluded page contains none of the excluded page's
  text and no dangling link; `shared-image.pdf` redaction output ≤ 1.05× input; n-up output
  size does not scale with cell count; a no-op scrub keeps outline, page labels,
  StructTreeRoot, `/Lang` and OutputIntents.

### HRD-41 · Content-stream surgery that never corrupts, and a verifier independent of it (M7) — `M` `P0`

**Status: Done (AUDIT-2026-09-25 fixes, 2026-09-26; not regressed per AUDIT-2026-10-01 §0)** — whole-file residual-text and orphan-page check in the verifier; four-corner image geometry; simple-TrueType font substitution. **Closed 2026-10-05 (PDF-14):** face/logo blur now reaches images drawn only by annotation appearances (the active appearance state) and by tiling patterns, and reports what it still cannot reach (an inactive state, a hidden annotation, an unreadable pattern) with its own skip reasons, not redaction refusals; logo marking uses its own planner (`planLogoMark`). Tests: `tests/unit/faceblur-annotations.test.ts` › "HRD-41: images drawn only by an annotation appearance", "HRD-41: images inside a tiling pattern". Redaction through tiling patterns is HRD-70. Open: none.

Three 🔴 findings were tools that reported success while visibly corrupting or failing to
redact the page; two of them passed the redaction verifier because it read only page-tree
text and recomputed the plan with the same geometry code as the redaction itself.

- **Requirements:**
  - **AUDIT-2026-09-25 M7** — The redaction verifier is independent of the redaction: it
    (a) decodes and scans **every** stream in the output for the redacted strings, (b)
    asserts no `/Type /Page` exists outside the page tree, and (c) uses an independent
    coverage check (four-corner quads or render-and-diff), never the redaction's own plan.
    Was: page-tree text only, same geometry — PDF-1 and PDF-4 both reported
    `verified: true` on leaking output.
  - **AUDIT-2026-09-25 PDF-2** (🔴) — "Embed missing font" (DOC-12) must leave every run of
    text reading the same: write a *simple* `/TrueType` font with the original encoding
    (including `/Differences`), `/FirstChar`/`/LastChar`/`/Widths` and `/FontFile2`;
    re-extract the text after the change and return the original bytes if it differs.
    Was: `embedFont`'s `Type0/Identity-H` read 1-byte WinAnsi codes as 2-byte CIDs, so text
    rendered as `.notdef`, widths were lost, and the UI said "fixed". Test:
    `font-embedding.test.ts` › "embedMissingFont keeps the text (PDF-2)";
    `src/core/pdf/font-substitute.ts`.
  - **AUDIT-2026-09-25 PDF-3** (🔴) — Flatten background (OPS-13) drops a background's whole
    path-construction run (`re`/`m`/`l`…) together with its painter. Was: only `f` was
    dropped, so the next fill painted the whole page (`… 0 0 612 792 re 0 0 0 rg 100 100 10
    10 re f` → black page). Test: `flatten-background.test.ts` (re-parses output content
    streams).
  - **AUDIT-2026-09-25 PDF-4** (🟠) — An image at any rotation is tested as the quad of its
    four transformed corners (as `formBoxOf` does), not a bounding box from two diagonal
    corners. Was: at 45° the box had zero width, so the image was neither stripped nor
    pixel-redacted, only overlaid, and verified. Test: `interpreter.test.ts`.
  - **AUDIT-2026-09-25 PDF-5** (🟠, ⟲ REGRESSION) — Redaction's mandatory scrub keeps
    `/OCProperties` (passes `hasOptionalContent: false`); whenever OCProperties is stripped,
    content in OFF groups is removed with it, so hidden layers never become visible. Was:
    the scrub deleted `/OCProperties` and un-hid layers the author set OFF, undoing the
    09-15 audit's OCG fix, because the OCG test never ran the scrub. Test:
    `redaction-optional-content.test.ts` › "keeps the layer hidden through the pipeline's
    mandatory metadata scrub (PDF-5)".
  - **AUDIT-2026-09-25 PDF-14** (🟡) — Face/logo blur finds images inside Form XObjects:
    forms on the path to the image are cloned for the selected pages only (a form shared
    with an unselected page keeps the original there), retired forms/images are purged
    only when nothing references them, and anything still unreachable is reported as a
    skip reason. Since 2026-10-05, annotation appearances and tiling patterns are reached
    (`faceblur-annotations.test.ts`). Was: "no faces found" on
    Office/Quartz PDFs full of faces. Tests: `inherited-resources.test.ts`,
    `faceblur-forms.test.ts`.
  - **AUDIT-2026-09-25 PDF-15** (⚪) — The DOC-12 font inventory reads inherited
    `/Resources` (`page.node.Resources()`) and walks fonts inside forms. Test:
    `font-embedding.test.ts`.
  - **AUDIT-2026-09-25 PDF-16** (⚪) — An OCR re-run removes a `BT…ET` span only when
    *every* show operator in it is `3 Tr` (invisible). Was: visible text sharing a span
    with invisible OCR text was deleted. Test: `interpreter.test.ts`.
  - **AUDIT-2026-09-25 R-PDF-1** — The residual-text scan excludes structural keys and
    dictionaries (`/Lang`, font names, `/DA`), so it does not false-fail legitimate
    redactions. Test: `pdf-regression-review.test.ts`.
  - **AUDIT-2026-09-25 R-PDF-2** — The default scrub purges inline and indirect JavaScript
    actions from every reachable action, bookmarks included. Test:
    `pdf-regression-review.test.ts`.
  - **AUDIT-2026-09-25 U1** — The redaction's visible-text checks run first, so it never says
    "no page shows it" for a word visible on another page.
  - Checked clean by the audit, and must stay so: the compress never-grow gate;
    SMask/colour-key/JBIG2/JPX refusals; encode-once; inline-image refusal in redaction;
    the AES-256 pass; `q…Q` wrapping when appending to a content stream.
- **AC:** A sabotaged build (overlay-only, or orphan page left in) is rejected by the
  verifier; a 45°-rotated image under a mark is removed or pixel-redacted; a hidden-OCG
  fixture stays hidden after redact → scrub; font substitution and flatten re-extract the
  text and re-parse the content stream of real output and fail on any difference.

### HRD-42 · Placement geometry against the visible frame (root cause M2) — `M` `P0`

**Status: Done for placement (AUDIT-2026-09-25 fixes, 2026-09-26; not regressed per AUDIT-2026-10-01 §0)** — `src/core/pdf/display-frame.ts`, `tests/unit/display-frame-geometry.test.ts` on rotated, cropped, offset-origin pages. **Closed 2026-10-05:** `getFormFields` reports field rectangles in the visible frame (CropBox ∩ MediaBox, origin, `/Rotate`), matching the pdf.js viewport within 1 pt (`tests/unit/form-fields-frame.test.ts` › "getFormFields rects are in the visible, rotated frame (HRD-42)", plus a check that the old raw-MediaBox mapping missed by far more than 1 pt). Open: none.

Tools mapped UI coordinates (the pdf.js viewport: CropBox, rotated) onto `page.getSize()`
(MediaBox, unrotated, no origin). The rotation half was fixed by an earlier audit; the
origin/crop half was not. This was the third time this class of bug came up.

- **Requirements:**
  - **AUDIT-2026-09-25 M2** — Every placement and reverse-mapping path uses one
    `displayFrame(page)` built from CropBox ∩ MediaBox with origin and `/Rotate`, checked
    against the pdf.js viewport, with one golden test per tool on a rotated, cropped,
    offset-origin page. This includes reading geometry back (`getFormFields` field rects —
    done 2026-10-05, `form-fields-frame.test.ts`).
  - **AUDIT-2026-09-25 PDF-8** (🟠) — Raster compression sizes the new page from the visible
    box (CropBox ∩ MediaBox in the original user space), keeps `/Rotate`, and places the
    raster at the crop origin, so nothing is stretched, cropped margins stay cropped and
    copied annotation `/Rect`s stay on their content. Was: cropped scans stretched,
    margins returned, annotations moved.
  - **AUDIT-2026-09-25 PDF-9** (🟠) — Signatures, stamps and incoming crop coordinates are
    placed in the visible frame. Was: on a page with bleed or a crop, a signature placed
    top-left landed outside the visible page and was effectively missing.
  - **AUDIT-2026-09-25 PDF-10** (🟠) — Annotate drawings (including whiteout), text and
    sticky notes map every point through the frame helper and are placed upright on
    rotated pages; non-Latin `ann.text` gets the clear WinAnsi error, not a raw pdf-lib
    throw. Was: whiteout drawn top-left on a `/Rotate 90` page exported top-right, leaving
    the content visible.
  - **AUDIT-2026-09-25 R-RT-3** — OCR words are placed at the DPI the page was actually
    rendered at (after the render-size cap of HRD-43), not the requested DPI. Was: words
    misplaced on A1/A0 pages. Test: `regression-review.test.ts`.
- **AC:** For each of compress-raster, sign, stamp, crop, annotate/whiteout and OCR text
  layer, a golden test on a `/Rotate 90`, cropped, non-zero-origin fixture shows the output
  mark within 1 pt of where the pdf.js viewport showed it; `getFormFields` rects on the same
  fixture match the viewport.

### HRD-43 · Worker lifecycle and render-resource budgets — `M` `P0`

**Status: Done (AUDIT-2026-09-25 fixes, 2026-09-26; not regressed per AUDIT-2026-10-01 §0)** — R-RT-10 accepted as-is.

A worker crash or failed boot hung every in-flight call and pinned render handle until a
reload, because Comlink 4.4.2 never rejects pending calls on termination. Render
resources were budgeted by count, not bytes, and several paths leaked pdf.js documents.

- **Requirements:**
  - **AUDIT-2026-09-25 RT-1** (🟠) — Every call to a worker races an instance-death promise
    that the worker's `error` handler rejects; render handles owned by a dead instance are
    evicted; `activeJob` is released, so undo, tab close and new jobs still work. Was: one
    worker error (e.g. a web-twin redeploy 404ing an old hashed worker URL) locked the app
    until reload; G4 in AUDIT-FINDINGS wrongly said the lease "just rejects". Tests:
    `worker-crash.test.ts`, `worker-client.test.ts`.
  - **AUDIT-2026-09-25 R-RT-1** — The death race holds no reference to a settled call's
    result: a per-call reject set, removed on settle. Was: 200 MB held after 20 × 10 MB
    calls.
  - **AUDIT-2026-09-25 RT-9** (🟡) — The render worker's `closeDocument` always destroys the
    pdf.js document (`try { cleanup } catch {} finally { destroy }`), even with a render in
    flight. Test: `render-worker-lifecycle.test.ts`.
  - **AUDIT-2026-09-25 RT-10** (🟡) / **AUDIT-2026-09-25 UI-16** — The bitmap cache is
    budgeted in bytes (192 MB); bitmaps in use are never closed; renders are clamped (8192²
    px, 16384 px per side); single-page and side-by-side views do not cache zoomed renders,
    cap at 4096² with a "Reduced detail" label, and cover the page with a loading/error
    state while it changes, so no overlay is ever drawn against the previous page's
    pixels. Was: a 120-entry count cap (gigabytes at zoom), blank A0 renders with no
    message, Redact/Crop marks made over the wrong image. Test:
    `render-budget-and-queues.test.ts`.
  - **AUDIT-2026-09-25 R-RT-8** — The loading cover does not flash on every zoom step.
  - **AUDIT-2026-09-25 R-RT-10** — Accepted limit: a rare thumbnail bitmap is freed by GC
    rather than closed.
  - **AUDIT-2026-09-25 RT-13** (⚪) — A failed pdf.js load (encrypted/corrupt) destroys its
    loading task. Test: `render-worker-lifecycle.test.ts`.
  - **AUDIT-2026-09-25 RT-19** (⚪) — A failed `renderHandleFor` deletes only its own cache
    entry (compare by identity), never a newer handle's. Test: `worker-crash.test.ts`.
  - **AUDIT-2026-09-25 RT-22** (⚪) — A section that opens a document in the render worker
    closes it on the same lease (`renderWorker.pin()`); was `FontEmbeddingSection`
    leaking the doc. Test: `open-import-audit.test.ts`.
  - **AUDIT-2026-09-25 R-PDF-3** — Export-review preview sessions are per review, so one
    review's cache can never close the next review's documents. Test:
    `diff-preview-sessions.test.ts`.
  - **AUDIT-2026-09-25 Comlink transfers** (found while fixing, §7) — Bytes cross a worker
    boundary by real transfer: `Comlink.transfer` is honoured only on the top-level argument
    or return value, so nested `{ bytes: transfer(x) }` must use `transferSourceBytes`
    (`operations.ts`) / `transferOut` (`process.worker.ts`). Was: ~10 sites silently
    structured-cloned (50 ms and 134 ms main-thread blocks on a 10 × 5 MB merge; the merge
    perf budget failed 4/4); the export review re-posted both documents per page view.
- **AC:** Terminating a worker mid-call rejects the call within one tick and leaves the app
  usable without reload; heap after 20 × 10 MB calls returns to baseline; zooming an A0
  page to max never exceeds the canvas limit and shows "Reduced detail"; the 10 × 5 MB
  merge keeps the main-thread frame gap under budget.

### HRD-44 · Source liveness, OPFS garbage collection and storage resilience (root cause M6) — `M` `P0`

**Status: Done (AUDIT-2026-09-25 fixes, 2026-09-26; not regressed per AUDIT-2026-10-01 §0)** — tests in `tests/unit/runtime-data-safety.test.ts`, `db-open.test.ts`, `opfs.test.ts`.

`closeDocument` freed sources that only the undo stack still referenced, and nothing ever
swept OPFS — so unredacted originals stayed on disk forever. Storage calls could hang on a
blocked IndexedDB upgrade or a slow open, which then read as "no session".

- **Requirements:**
  - **AUDIT-2026-09-25 M6** — Source liveness is computed from live documents, every
    undo/redo snapshot (pages and baseline) and pending imports; a startup OPFS sweep runs
    after the recovery decision.
  - **AUDIT-2026-09-25 RT-2** (🟠) — Closing any tab never deletes bytes another document's
    undo history needs, and `checkRecovery` validates every `sourceDocId`. Was:
    redact A, close B, Ctrl+Z on A → blank thumbnails, failed export, and the broken state
    autosaved and restored. Test: `runtime-data-safety.test.ts`.
  - **AUDIT-2026-09-25 RT-4** (🟠, privacy) — OPFS `*.pdf` files not referenced by the
    restored session are swept at startup (model files kept) and on "Start fresh"; the
    sweep runs only when this is the sole Stapler tab (Web Lock) and is skipped without the
    Web Locks API. Was: the pre-redaction original stayed on disk after redact → export →
    close → Start fresh, and a full quota blamed "saved signatures". Tests:
    `runtime-data-safety.test.ts`, `local-data.test.ts`.
  - **AUDIT-2026-09-25 R-RT-2** — The tab lock is taken first, the sweep runs only when
    `locks.query()` shows a sole holder, and bytes are re-checked before restore, so a
    second tab can never delete what a first tab (still on its restore prompt) will restore.
  - **AUDIT-2026-09-25 R-RT-4** — Unreadable storage is not "no record": a slow or failed
    IndexedDB open never clears the record, never sweeps, and suspends autosave.
  - **AUDIT-2026-09-25 RT-5** (🟡) — Sources registered by an in-progress import are live
    (`pendingSources`), so closing a tab during a Home-screen import cannot delete them.
    Test: `runtime-data-safety.test.ts`.
  - **AUDIT-2026-09-25 RT-11** (🟡) — An IndexedDB upgrade blocked by an older tab can't hang
    storage: `blocking(){ db.close() }` plus a timeout that falls back to the degraded
    path. Was: recovery never finished, so autosave never armed and signatures, recents
    and settings never loaded. Test: `db-open.test.ts` › "RT-11".
  - **AUDIT-2026-09-25 RT-20** (⚪) — OPFS-vs-memory mode is probed once (write path
    included) and memoised; a missing `createWritable` (older Safari) is handled. Tests:
    `render-budget-and-queues.test.ts`, `opfs.test.ts`.
  - **AUDIT-2026-09-25 R-RT-5** — The OPFS probe file name cannot clash with real files.
  - **AUDIT-2026-09-25 RT-21** (⚪) — Quota-full is one persistent, rate-limited notice, not
    a toast per autosave. Test: `db-open.test.ts` › "RT-21".
  - **AUDIT-2026-09-25 RT-23** (⚪) — An error in the recovery check still sets
    `sessionRecoveryChecked` (try/finally), so autosave is never silently disabled for the
    session. Test: `runtime-data-safety.test.ts`.
  - **AUDIT-2026-09-25 RT-18** (⚪) — Every `localStorage` access is guarded (try/catch);
    was unguarded `setItem` in `shortcuts.ts`, and (found while fixing, §7)
    `batch/state.ts` read `localStorage` at module load, so any importer threw in Safari
    private mode.
- **AC:** Closing B never breaks undo on A; after redact → export → close → Start fresh, no
  pre-redaction `*.pdf` remains in OPFS; with a second tab on its restore prompt, the
  first tab's sweep deletes nothing; a blocked or slow IndexedDB open neither hangs nor
  clears the session record.

### HRD-45 · Document open, import and close paths are one safe flow — `M` `P0`

**Status: Done (AUDIT-2026-09-25 fixes, 2026-09-26; not regressed per AUDIT-2026-10-01 §0)** — RT-6's undo semantics were then superseded by per-document undo (DOC-15).

- **Requirements:**
  - **AUDIT-2026-09-25 RT-3** (🟠) — Deleting every page of a document is refused with a
    message ("A document needs at least one page… close its tab instead"); nothing is ever
    closed except through the tab-close confirmation. Was: Ctrl+A → Delete closed the
    document with no confirmation, no undo, no busy check, and deleted its history and
    OPFS bytes. Tests: `runtime-data-safety.test.ts`, `tests/e2e/tool-flows.spec.ts`.
  - **AUDIT-2026-09-25 R-RT-9** — A refused delete does not move focus.
  - **AUDIT-2026-09-25 RT-6** (🟡) — Opening a file never wipes another document's undo, and
    every open path (drop, picker, Recents, paste) behaves the same. Was: `resetHistory()`
    on open, while Recents and paste skipped it so Ctrl+Z removed the new document. Test:
    `open-import-audit.test.ts`.
  - **AUDIT-2026-09-25 R-RT-6** / **AUDIT-2026-09-25 R-RT-7** — Opening and closing are
    workspace actions, not undo steps, so undo can never empty the workspace (resolved by
    GAP-11 / DOC-15's per-document undo).
  - **AUDIT-2026-09-25 RT-7** (🟡) — Opening files is a cancellable job (`runImportJob`) with
    a Cancel button, including on Home (no action bar); a cancelled open adds nothing and
    frees what it stored. Was: a 500 MB drop could not be stopped. Test:
    `open-import-audit.test.ts`.
  - **AUDIT-2026-09-25 RT-14** (⚪) — Imports are refused until the recovery check finishes,
    so files dropped during the Restore prompt are not lost. Tests:
    `open-import-audit.test.ts`, `tests/e2e/import.spec.ts`.
  - **AUDIT-2026-09-25 RT-16** (⚪) — Import sniffs `%PDF` on `file.slice(0, 1024)` before
    reading the whole file, and transfers buffers (no 3 copies at peak). Test:
    `open-import-audit.test.ts`.
  - **AUDIT-2026-09-25 RT-17** (⚪) — `dirty` is cleared after a save (`refreshBaseline`), so
    close only asks when there is something to lose. Test: `runtime-data-safety.test.ts`.
  - **AUDIT-2026-09-25 RT-12** (🟡) — Every operation that registers an output document gives
    it real `pageSizes` (the `loadDocument` → `pageSizes` path in `commit.ts`). Was:
    face-blur registered `pageSizes: []` — blank single-page view, a TypeError in cleanup
    "apply to all", and empty sizes autosaved.
  - **AUDIT-2026-09-25 UI-4** (🟠) — Folder-search "jump to result" imports the file through
    `importFilesAsDocuments` and matches by handle, not name. Was: a phantom document with
    no bytes (`makePageRefs(crypto.randomUUID(), 1)`) that never rendered, failed on
    export, was saved by session recovery, and same-name files jumped into the wrong one.
  - **AUDIT-2026-09-25 R-UI-5** — The folder-search file map is per indexed folder, so a
    result never resolves to a same-named file from another folder.
  - **AUDIT-2026-09-25 UI-27** (⚪) — Opening a Recent is guarded against double-click, and a
    "Forget" rejection is handled.
- **AC:** Ctrl+A → Delete on any document is refused and leaves it open; cancelling a large
  drop leaves no document and no OPFS file; a file dropped during the Restore prompt is
  open after Restore; double-clicking a Recent opens one tab.

### HRD-46 · The job lock, cancellation and honest progress cover every long flow (root cause M5) — `M` `P1`

**Status: Done (AUDIT-2026-09-25 fixes, 2026-09-26; not regressed per AUDIT-2026-10-01 §0)** — implemented as a call-site guard (`src/ui/busy.ts`), not in store mutators as M5 proposed, because detect-blank legitimately deletes pages inside its own job. Test: `tests/unit/busy-guard.test.ts`.

Only undo/redo, tab switching and the primary CTA checked `activeJob`; page delete,
rotate, reorder, paste, stamp, secondary buttons and imports did not, and `run()` refused
silently.

- **Requirements:**
  - **AUDIT-2026-09-25 M5** — Every user-facing mutator (grid keys, drag, thumbnail
    buttons, Organize, paste, stamp placement, secondary panel buttons, imports) is refused
    with a message while a job runs; imports go through the job model so they set the lock
    and are cancellable; a refused `run()` tells the user instead of returning `undefined`.
  - **AUDIT-2026-09-25 RT-8** (🟡) / **AUDIT-2026-09-25 UI-10** — Edits made while a long job
    runs are either blocked or survive it; the export stamps the right baseline. Was: a page
    deleted during a redaction came back when it finished (`replaceWithSource`), and
    `refreshBaseline` stamped a stale baseline so the next review diffed against the wrong
    thing (§2.2 fix of an earlier audit was incomplete).
  - **AUDIT-2026-09-25 UI-20** (🟡) — Secondary panel buttons are disabled or notify while a
    job runs; the Merge picker never discards files the user just picked. Was:
    `useJob.ts:61` returned `undefined` silently.
  - **AUDIT-2026-09-25 UI-9** (🟡) — A batch run's controller lives in module state, so it can
    be cancelled after navigating away and back; the primary "Run Batch" CTA runs the batch;
    no Done button is a no-op (compare, read-aloud, reflow, history, side-by-side).
  - **AUDIT-2026-09-25 UI-15** (🟡) — Leaving read-aloud stops speech for good: stop/unmount
    mark the session idle and drop the utterance *before* `speechSynthesis.cancel()`, and
    `speakPage` is token-guarded (`read-aloud/speech-session.ts`). Was: Chrome fires `onend`
    on cancel, so it auto-advanced page after page. Test: `render-budget-and-queues.test.ts`.
  - **AUDIT-2026-09-25 UI-19** (🟡) — The OCR consent dialog resets its "Uploading…" state in
    `finally` and when the request changes. Was: disabled for the rest of the session after
    one upload.
  - **AUDIT-2026-09-25 UI-23** (⚪) — The cleanup editor has an error state and announces
    "Page cleaned." once, after the work finishes.
  - **AUDIT-2026-09-25 UI-24** (⚪) — Folder indexing is cancellable (AbortController +
    Cancel) and never sets state after unmount.
  - **AUDIT-2026-09-25 RT-15** (⚪) — The modal queue settles each request once (per-request
    `settled` flag), so a double resolve cannot skip or hang the next dialog. Test:
    `render-budget-and-queues.test.ts`.
- **AC:** With a redaction running, Delete, Alt+arrow, paste, stamp and a secondary button
  each show a refusal and change nothing; a batch started, navigated away from and back to
  can be cancelled; leaving read-aloud mid-page produces no further speech.

### HRD-47 · Tool state is scoped to the document it describes (root cause M3) — `S` `P0`

**Status: Done (AUDIT-2026-09-25 fixes, 2026-09-26; not regressed per AUDIT-2026-10-01 §0)** — `resetOnDocumentChange` / `src/ui/tools/docScoped.ts`; `tests/unit/doc-scoped-state.test.ts`.

Settings and results in module-level signals survived a document switch or edit, and
export applied them to the wrong document. An earlier audit fixed three tools; the rest
kept the pattern (`redact/state.ts` already showed the right one).

- **Requirements:**
  - **AUDIT-2026-09-25 M3** — Any tool state describing one document is tagged with
    `{docId, pagesVersion}` and resets when either changes; a unit test iterates every
    tool's state module.
  - **AUDIT-2026-09-25 UI-1** (🔴) — Metadata "Strip & export" strips everything by default
    without a prior "Inspect" (`scrubSettings` starts `undefined`, because `{}` is truthy
    and skipped the strip-all default), and findings/settings never carry over to the next
    document. Was: Author, Title, paths, XMP and JavaScript all survived with a success
    toast; the e2e always clicked Inspect first. Test: `metadata-default-scrub.test.ts`.
  - **AUDIT-2026-09-25 UI-3** (🟠) — Table-extract rows and extracted text never survive a
    document switch. Was: `B-page3-table.csv` contained doc A's cells — wrong content and a
    cross-document leak.
  - **AUDIT-2026-09-25 UI-11** (🟡) — The Compress projection and "target reached" outcome
    are for the current document and revision, with ordered, error-handled refreshes.
  - **AUDIT-2026-09-25 UI-12** (🟡) — Sign's "Sign here" suggestions are per document and an
    armed stamp is cleared on tool change. Was: clicking a page in Outline or Normalize
    silently placed a signature.
  - **AUDIT-2026-09-25 UI-18** (🟡) — The alt-text scan is keyed on document revision, aborts
    the previous run, and shows distinct loading/empty/error states; typed alt text is not
    wiped by a page edit (found while fixing, §7). Was: rescans on every edit, stuck on
    "Loading…".
  - **AUDIT-2026-09-25 UI-25** (⚪) — The Sign panel recomposes only when doc id or pages
    version changes, and handles rejection.
  - **AUDIT-2026-09-25 UI-14** (🟡) — "Discard all changes" clears signature stamps and form
    fields as its dialog promises. Test: `discardAllChanges.test.ts`.
  - **AUDIT-2026-09-25 R-UI-1** — A moved form field's input moves with it (field geometry
    in the debounced refetch key).
  - **AUDIT-2026-09-25 R-UI-8** — Fields are not cleared mid-typing by a refetch.
- **AC:** For every tool, opening doc B after configuring the tool on doc A shows defaults;
  "Strip & export" with no Inspect leaves no Author/Title/XMP/JS in the output bytes; a CSV
  exported on doc B contains only doc B's cells.

### HRD-48 · Overlays, focus and keyboard operation never trap or misfire — `M` `P0`

**Status: Done (AUDIT-2026-09-25 fixes, 2026-09-26; not regressed per AUDIT-2026-10-01 §0)**

- **Requirements:**
  - **AUDIT-2026-09-25 UI-2** (🟠) — A drop on the Home drop zone imports once
    (`stopPropagation()` in the zone / `defaultPrevented` check in the window handler). Was:
    every PDF opened as two tabs, a side effect of the 09-15 §1.1 fix. Test:
    `tests/e2e/audit-2026-09-25.spec.ts`.
  - **AUDIT-2026-09-25 UI-7** (🟠) — Escape closes only the top overlay (modal stack,
    `stopImmediatePropagation()`), and the command palette cannot open while a modal is
    open. Was: Ctrl+K → Esc over the restore prompt resolved "Start fresh" and permanently
    cleared the session, and the same sequence cancelled an export review. Test:
    `tests/e2e/audit-2026-09-25.spec.ts`. Also (§7): the modal key listener attaches in a
    layout effect, so an Escape right after a dialog appears is not lost.
  - **AUDIT-2026-09-25 UI-5** (🟠) — The shortcut recorder rejects reserved keys (Tab,
    arrows, Enter, Space) and Tab exits record mode; Reset is keyboard operable. Was:
    binding the palette to Tab hijacked Tab app-wide across reloads; ArrowRight bound to
    Delete page turned grid navigation into deletion. Test: `shortcuts.test.ts` › "refuses
    bindings that would trap keyboard navigation (UI-5)".
  - **AUDIT-2026-09-25 R-UI-9** — Saved shortcuts that are no longer valid are reported, not
    dropped silently.
  - **AUDIT-2026-09-25 UI-6** (🟠) — A keyboard user can create a signature: the signature
    modal uses `components/Tabs.tsx` (arrow-key roving tabindex), and Type and Import are
    reachable without a pointer.
  - **AUDIT-2026-09-25 UI-13** (🟡) — Alt+arrow reorder moves the selection as a block from
    its min/max, not the focused index. Was: no-op or double jump; a non-contiguous selection
    collapsed to the end. Test: `reorder.test.ts`.
  - **AUDIT-2026-09-25 UI-17** (🟡) — Toasts sit above the action bar and never cover the
    primary CTA; the visible count is capped. Test: `busy-guard.test.ts` › "toast cap
    (UI-17)".
  - **AUDIT-2026-09-25 R-UI-6** — The toast cap never evicts an unread error. Test:
    `busy-guard.test.ts`.
  - **AUDIT-2026-09-25 UI-21** (⚪) — RTL: `<html lang>` is set, arrow keys and drop halves
    mirror, layout uses logical CSS properties (was 66 physical ones). Test:
    `reorder.test.ts`.
  - **AUDIT-2026-09-25 UI-22** (⚪) — A modal keeps `onClose` in a ref, so a re-render never
    moves focus to the close button.
  - **AUDIT-2026-09-25 R-UI-4** — A queued dialog takes focus when it opens, not the previous
    dialog's.
  - **AUDIT-2026-09-25 R-UI-7** — `aria-controls` survives the fixes.
  - **AUDIT-2026-09-25 UI-26** (⚪) — Crop/annotation drag listeners and the history
    transaction end on unmount.
  - **AUDIT-2026-09-25 UI-28** (⚪) — Below 1100px the options sheet can be collapsed so it
    never covers overlays.
  - Checked clean by the audit, and must stay so: no `innerHTML`/`dangerouslySetInnerHTML`
    anywhere; every colour token resolves; locale files are structurally identical; the
    page grid is virtualised; object URLs are revoked (watermark, export review, signature).
- **AC:** A Playwright run drops one PDF on Home and gets one tab; Ctrl+K → Esc over the
  restore prompt leaves the prompt open and the session intact; a keyboard-only run creates
  and places a signature; recording Tab as a shortcut is refused.

### HRD-49 · Every user-facing string is translated, in the UI and in workers — `M` `P0`

**Status: Done (AUDIT-2026-09-25 fixes, 2026-09-26; not regressed per AUDIT-2026-10-01 §0)** — `tests/unit/i18n-coverage.test.ts`, `worker-locale.test.ts`, `i18n-plural.test.ts`. Not reviewed by native speakers (NFR-04).

- **Requirements:**
  - **AUDIT-2026-09-25 UI-8** (🟠) — Every key passed to `t`/`translate`/`tPlural`/`tKey`
    anywhere in `src/` (workers included) exists in all ten locales with every CLDR plural
    category its language needs (`Intl.PluralRules`) and every `{placeholder}`, enforced by
    a coverage test; registry strings (`core/tools.ts`) are translated at render time;
    sentences are whole keys with params (no fragments, no `'s'` plural hack); every worker
    pool sends `setLocale` on spawn and on language change, and the first call after a
    spawn waits for it. English by design only for: internal invariant errors a user can't
    trigger, text written into output documents, the exported compression report, log
    lines. Was: 383 of 710 used keys in no locale, 136 unused keys, dozens of JSX literals,
    while NFR-04 was marked Done.
  - **AUDIT-2026-09-25 R-UI-2** / **AUDIT-2026-09-25 R-UI-3** — Command-palette and Home
    search score translated and English text separately, so "red" + Enter cannot run Redo
    and ranking does not shift. Test: `regression-review.test.ts` › "R-UI-2/3".
  - **AUDIT-2026-09-25 N1** — No message added by the fixes ships untranslated (the §8
    regression review found one).
- **AC:** The coverage test fails on a newly added `t('…')` missing from any locale; with
  Spanish selected, a worker-generated error appears in Spanish.

### HRD-50 · Conversion and export treat every input as hostile — `M` `P1`

**Status: Done (AUDIT-2026-09-25 fixes, 2026-09-26; not regressed per AUDIT-2026-10-01 §0)** — R-CONV-9 accepted as-is.

- **Requirements:**
  - **AUDIT-2026-09-25 CONV-3** (🟠) — PDF→Word and PDF→PowerPoint never write a character
    XML 1.0 forbids: the shared `stripInvalidXmlChars` applies to every text run, cell and
    title in every OOXML writer. Was: only `xlsx-writer.ts` had it; Office rejected or
    "repaired" (dropping content) after a success toast. Test: `convert-xml-chars.test.ts`.
  - **AUDIT-2026-09-25 CONV-4** (🟡) — The PowerPoint reader is linear-time (one tokenizer
    pass) with a size cap per XML part. Was: a 1.4 KB crafted .pptx pinned the convert worker
    29 s, ~4× per doubling, uncancellable. Test: `convert-hostile-input.test.ts` › "CONV-4".
  - **AUDIT-2026-09-25 CONV-5** (🟡) — docx/xlsx/pptx entries are inflated into buffers one
    byte larger than their declared size and refused as a bomb if exceeded (damaged if
    short), with total-uncompressed and entry-count caps; only needed parts are inflated;
    mammoth and SheetJS receive only a stored-only repack of vetted entries. Was: a 1.5 MB
    .pptx allocated >1 GB. Test: `convert-hostile-input.test.ts` › "CONV-5".
  - **AUDIT-2026-09-25 R-CONV-9** — Accepted limit: the 256 MB unpack cap refuses very large
    workbooks.
  - **AUDIT-2026-09-25 CONV-9** (🟡) / **AUDIT-2026-09-25 PLT-11** — Parsers of untrusted
    files carry no known advisory: SheetJS is 0.20.3 from its official tarball, pinned by
    integrity in the lockfile (fixes CVE-2023-30533 prototype pollution and CVE-2024-22363
    ReDoS); an uncalculated formula reads as blank. Was: abandoned `xlsx@0.18.5` on npm.
  - **AUDIT-2026-09-25 CONV-7** (🟡) — CSV export neutralises formula injection: a cell
    starting with `= + - @ \t \r` is prefixed with `'` and quoted. Test:
    `table-extract.test.ts` › "formula injection (CONV-7)".
  - **AUDIT-2026-09-25 R-CONV-5** — The CSV guard does not prefix plain amounts, phone numbers
    or @mentions. Test: `conv-regression-fixes.test.ts`.
  - **AUDIT-2026-09-25 CONV-11** (⚪) — Markdown→PDF link URIs go through `new URL().href`
    (non-Latin URLs intact) and only http(s) and mailto are written; `javascript:`/`file:`
    are dropped. Test: `markdown-links-nesting.test.ts`.
  - **AUDIT-2026-09-25 R-CONV-7** — `#anchor` and `tel:` links are handled deliberately.
  - **AUDIT-2026-09-25 CONV-12** (⚪) — Markdown→PDF survives hostile nesting (5k `>`) and
    pathological emphasis, is cancellable with determinate progress (JobHandle
    checkpoints), caps input, catches `RangeError`, and reports dropped images. Was: stack
    overflow, 9 s on a 30 KB pattern, silent image drops. Tests: `markdown-cancel.test.ts`,
    `markdown-links-nesting.test.ts`.
  - **AUDIT-2026-09-25 R-CONV-4** — The markdown guard never mangles code spans or URLs.
  - **AUDIT-2026-09-25 R-CONV-6** — The deep-list note is not repeated in other locales.
  - **AUDIT-2026-09-25 CONV-13** (⚪) — Text-diff export warns when non-WinAnsi text (CJK,
    Cyrillic, Hebrew, emoji) had to be replaced, instead of silently writing `????`. Test:
    `text-diff-export.test.ts` › "warns (CONV-13)".
  - **AUDIT-2026-09-25 CONV-14** (⚪) — The word diff is Myers O((N+M)·D) in the `cv` worker,
    off the main thread. Was: ~217 ms and 132 MB per page switch. Test: `diff.test.ts` ›
    "Text Diff — Myers (CONV-14)".
  - **AUDIT-2026-09-25 R-CONV-8** — Moderately different texts still get a fine-grained diff.
  - **AUDIT-2026-09-25 CONV-15** (⚪) — The formula evaluator uses `Object.hasOwn` /
    `Object.create(null)`, so a field named `constructor`, `toString` or `__proto__` neither
    crashes nor is swallowed. Test: `formula.test.ts` › "field names that collide with
    Object.prototype (CONV-15)".
  - Checked clean by the audit, and must stay so: mammoth HTML never reaches the DOM; the
    xlsx writer uses inline strings; OCR SHA-256 verification is correct; shard path
    traversal is blocked; zxing WASM is local; the formula parser has no eval and has
    depth caps.
- **AC:** The hostile-input corpus (quadratic pptx, zip bomb, invalid XML chars, `=cmd`
  cells, `javascript:` links, 5k-deep quote, prototype-named fields) each produces either a
  valid file re-parsed from bytes or a specific refusal, within a bounded time, cancellable.

### HRD-51 · Image import is faithful and works in the shipped extension — `M` `P0`

**Status: Done (2026-10-05)** — HEIC is now automated in the packaged extension: `tests/e2e/extension/tool-flows.spec.ts` › "HRD-51 — HEIC in the packaged extension" ("photo-rotated.heic imports upright: 400×300 page, red top-left, blue bottom-right", "sample.heic imports as a landscape page at its own size"), plus "image to size: a HEIC photo comes out as a JPEG at or under 20 KB", in the extension project that fails on any CSP violation or network request (CNV-03). **Still required:** libheif's LGPL-3.0 licence review, an explicit legal gate in `RELEASE_CHECKLIST.md` §1 before the first store submission.

- **Requirements:**
  - **AUDIT-2026-09-25 CONV-1** (🟠) / **AUDIT-2026-09-25 PLT-1** — HEIC decodes in the
    shipped extension under its MV3 CSP: libheif-js (WASM, no `eval`/`new Function`) in its
    own bundled worker, with EXIF/HEIF orientation, cancel and a timeout that terminate the
    worker; the ~1.9 MB WASM is a lazy chunk loaded only for HEIC. Was: heic2any's
    `new Function` was blocked by the CSP and its promise never settled — a spinner forever
    in both extension builds, while CNV-03 was Done on a web-preview e2e. Tests:
    `raster-decode.test.ts`, `image-import.test.ts`; manual check in loaded `dist/ext`.
  - **AUDIT-2026-09-25 CONV-10** (🟡) — "Maximum" image import never re-encodes losslessly
    held data: PNG is embedded losslessly and original JPEG bytes pass through. Was: "100%
    (Lossless)" was a lossy JPEG re-encode. Test: `image-import.test.ts` › "lossless image
    import (CONV-10)".
  - **AUDIT-2026-09-25 R-CONV-1** — Originals are embedded with EXIF applied at placement;
    photos decoded from HEIC/TIFF/WebP are 95% JPEG; the option is labelled "Maximum
    (originals kept where possible)". Was: 23 MB PNGs. Test: `image-import.test.ts`.
  - **AUDIT-2026-09-25 R-CONV-2** — JPEG passthrough keeps the ICC profile. Test:
    `image-import.test.ts`.
  - **AUDIT-2026-09-25 R-CONV-3** — Concurrent HEIC/TIFF decodes queue instead of cancelling
    each other. Test: `image-import.test.ts`.
  - **AUDIT-2026-09-25 CONV-16** (⚪, cited in code as `audit 2026-09-25 CNV-16`) — TIFF
    decodes in the image worker, not on the main thread; and the OCR model download
    streams with byte progress against the expected total and is cut off past twice the
    pinned size (or a too-large `Content-Length`) before hashing or buffering it all.
    Tests: `raster-decode.test.ts` › "TIFF decode (CONV-16)", `ocr.test.ts` (CNV-16 cases).
- **AC:** In the loaded `dist/ext`, `sample.heic` and `photo-rotated.heic` import upright with
  zero CSP violations (automate in the extension project); an upright JPEG imported at
  Maximum is byte-identical inside the PDF.

### HRD-52 · Network exceptions are pinned, consented, counted — and nothing leaves the device unseen — `M` `P0`

**Status: Done (AUDIT-2026-09-25 fixes, 2026-09-26; not regressed per AUDIT-2026-10-01 §0)** — OCR is now the only network exception; face weights are bundled.

- **Requirements:**
  - **AUDIT-2026-09-25 CONV-2** (🟠, cited in code as `audit 2026-09-25 CNV-2`) — Tesseract
    can never fetch on its own: `cacheMethod: 'readOnly'`, a `langPath` that cannot reach the
    network, an engine that can't load the model is fatal for the whole run (not a per-page
    skip), and the CSP is path-scoped (HRD-53). Was: after a failed init, tesseract.js 7
    deleted its cache and the next page fetched an unpinned, unhashed model from
    `cdn.jsdelivr.net` without consent — a breach of invariant #1. Test: `ocr.test.ts` ›
    "a tesseract cache miss can never fetch (CNV-2)".
  - **AUDIT-2026-09-25 CONV-8** (🟡, cited in code as `audit 2026-09-25 CNV-8`) — An uploaded
    offline model is trial-loaded before it is kept, and there is a control to remove stored
    language models. Was: a bad upload was re-seeded before every run with no way to replace
    it. Test: `conv-regression-fixes.test.ts`.
  - **AUDIT-2026-09-25 CONV-6** (🟡, cited in code as `audit 2026-09-25 CNV-6`) /
    **AUDIT-2026-09-25 PLT-8** — Face-detector weights are bundled from
    `@vladmandic/face-api/model/`: no download, no consent dialog, no CSP allowance. Any
    model that must stay remote is SHA-256-pinned like OCR's. Was: a length check against a
    remote unverified manifest with `force-cache`, so tampered weights could report "no faces
    found" and leave faces visible. Test: `faceblur-offline.test.ts`.
  - **AUDIT-2026-09-25 PLT-5** (🟠, privacy) — Read-aloud speaks only with voices whose
    `localService` is true; with none, the tool is disabled with an explanation. Was: on
    ChromeOS, Linux without speech-dispatcher, or a "Google …" default voice, page text was
    synthesised server-side — invisible to CSP, DevTools and Playwright — while the chip said
    "0 requests". Test: `read-aloud-voices.test.ts`.
  - **AUDIT-2026-09-25 PLT-16** (⚪) — The "Offline · 0 requests" chip is driven by a counter
    (`core/disclosedDownloads.ts`) that each completed, verified consented download
    increments. Was: a fixed string. Test: `ocr.test.ts` › "counts a completed, verified
    download for the top-bar chip (PLT-16)".
- **AC:** With a deliberately wrong offline model, a 3-page OCR run makes zero requests and
  fails with a clear message; face blur in the loaded extension makes zero requests; with
  only network voices available, read-aloud is disabled; the chip reads 1 after one
  verified OCR download.

### HRD-53 · Zero network is enforced by the runtime, not by regex (root cause M9) — `M` `P0`

**Status: Done (AUDIT-2026-09-25 fixes, 2026-09-26; not regressed per AUDIT-2026-10-01 §0)** — `scripts/csp.mjs`, `scripts/network-guard.mjs`, `pnpm check:bundle-network`. Limit stated: static analysis cannot follow values across modules or through returns; the bundle scan and CSP cover that.

- **Requirements:**
  - **AUDIT-2026-09-25 M9** — The CSP is the real guarantee (strict, path-scoped, generated
    from one source for both builds); ESLint `no-restricted-globals`/`-properties` ban
    network APIs; a post-build scan of `dist/` checks hosts against an allowlist. Guards
    must accept (indeed require) the tighter, path-scoped policy.
  - **AUDIT-2026-09-25 PLT-3** (🟠) — The extension CSP is `default-src 'self'`,
    `object-src`/`frame-src`/`base-uri`/`form-action` `'none'`, `img-src 'self' blob: data:`,
    and `connect-src` limited to the exact pinned OCR model paths. Was: no `default-src`
    (remote img/style/iframe went out, so `new Image().src` beacons worked) and
    `connect-src https://cdn.jsdelivr.net`, which with `'wasm-unsafe-eval'` allowed fetching
    and running remote WASM; the guards rejected anything tighter than a bare host. Tests:
    `csp.test.ts`, `tests/e2e/manifest.spec.ts`.
  - **AUDIT-2026-09-25 PLT-4** (🟠) — The web twin ships the same CSP as the first
    `<meta http-equiv>` of every page (GitHub Pages cannot set headers), asserted in
    `zero-network.spec`. Was: none of the 12 root HTML pages had a CSP. Tests: `csp.test.ts`,
    `tests/e2e/zero-network.spec.ts`.
  - **AUDIT-2026-09-25 PLT-6** (🟡) — Both invariant guards use one AST analyzer that
    resolves aliases, constant-folded keys (`'fe'+'tch'`, templates, `join`, `atob`),
    global-object aliases and unresolvable computed global access, remote `import()` and
    workers, URL sinks, CSS `url()`/`@import`, HTML resource attributes, and scans root
    `*.html`. Was: ~25 of 30 bypass payloads missed, root HTML never scanned
    (`editor.html` had a raw `#ffffff`), no bundle scan. Test: `network-guard.test.ts`
    (69 bypasses, 26 negatives).
- **AC:** In the loaded extension and the CSP-protected web build: zero violations on load,
  and remote img/style/iframe/fetch/WASM probes are all blocked; adding any of the 69
  bypass payloads fails `pnpm check`; a remote URL in a built bundle fails
  `check:bundle-network`.

### HRD-54 · "Done" means it works in the shipped build, proven on output bytes (roots M4, M8; §4 claims) — `M` `P0`

**Status: Done, CI run unconfirmed (2026-10-05)** — the extension Playwright projects, CI on `master` and the non-retried perf job landed with the fixes (2026-09-26) and AUDIT-2026-10-01 found no regression. M8's discipline and M4's "verified in the loaded extension" line are now in the Definition of Done at the top of this file. **Done 2026-10-05:** seven tool flows are checked on output bytes in the packaged extension (`tests/e2e/extension/tool-flows.spec.ts` › "HRD-54 — tool flows in the packaged extension": split, compress, redact, sign, watermark, PDF to images, image to size), alongside the HEIC cases (HRD-51). **Still unconfirmed:** whether a GitHub CI run has happened, because this branch has not been pushed.

Every e2e spec ran against `vite preview` (no MV3 CSP, test hooks on), CI triggered on a
branch that did not exist, and fixes were tested without the pipeline step that follows
them. Five findings contradicted claims of earlier audits (⟲ REGRESSION), and ten tickets
were Done on the strength of tests that could not have caught them.

- **Requirements:**
  - **AUDIT-2026-09-25 M4** — Anything touching workers, WASM or third-party decoders is
    verified in the loaded extension (Playwright `--load-extension` on `dist/ext`), and
    that is part of the Definition of Done. This is also the audit's GAP-1 ("make Done mean
    works in the shipped build": extension e2e project, working CI, post-build host scan),
    which EPIC-18 records on the tickets it reopened rather than as its own ticket.
  - **AUDIT-2026-09-25 M8** — Regression tests run user flows end-to-end through the real
    pipeline, including the default path where the user skips the optional button, and
    assert on real output bytes. Was: the OCG test skipped the scrub (PDF-5), the metadata
    e2e always clicked Inspect (UI-1), the HEIC e2e never saw the CSP (CONV-1).
  - **AUDIT-2026-09-25 §4 claims** — A claim of "fixed", "Done" or "fails CI" in an audit or
    ticket must cite a test that asserts on output bytes in the build that ships, or say it
    is a manual check. Each contradicted claim stays recorded until it holds: redaction
    "shares one copier" (PDF-7), OCG preserved by redaction (PDF-5), G4 lease "just rejects"
    (RT-1), HEIC "working code paths" (CONV-1), "fails CI" (PLT-2), read-aloud "on-device"
    (PLT-5), "Cloudflare Pages with headers" (PLT-4), "all locales complete" (UI-8), face
    model "pinned like OCR" (CONV-6).
  - **AUDIT-2026-09-25 PLT-2** (🟠) — CI triggers on push/PR to `master`, and
    `package.json` pins `packageManager` so `pnpm/action-setup` resolves. Was: `branches:
    [main]`; `gh run list` showed only Pages deploys, so every "fails CI" AC in QA-03, QA-04
    and NFR-02 had never run.
  - **AUDIT-2026-09-25 PLT-7** (🟡) — Playwright `extension` projects build and load the real
    `dist/ext` and fail on any network request, CSP violation or page error (load, licence
    file, PNG import, merge, face blur), as CI job `e2e-extension`; the zero-network sweep
    also covers read-aloud, reflow, history, side-by-side, barcode scanning and face blur.
    Tests: `tests/e2e/extension/*`.
  - **AUDIT-2026-09-25 PLT-15** (⚪) — `tests/`, `scripts/` and configs are type-checked
    (`tsconfig.test.json` in `check:type`). Found while fixing (§7): two `process.test.ts`
    tests asserted nothing (wrong replacement key; a 3-byte base image the never-grow rule
    always kept), and `ProcessJob.composeSplit`'s declared type omitted `fileCount` — both
    repaired.
  - **AUDIT-2026-09-25 PLT-18** (⚪) — Perf budgets run in their own never-retried `perf`
    project/job (`tests/e2e/perf.spec.ts`) recording measured vs budget; functional e2e
    allows at most one retry with `failOnFlakyTests`; e2e waits on conditions, never races
    the UI (§7: a drag before render, one "Dismiss" for two toasts, a bare
    `getByRole('status')`; the OCR-01 e2e never clicked through the export review; the
    Compress preview reported `ready` for the wrong page).
- **AC:** CI on a PR to `master` runs `e2e`, `e2e-extension`, `perf` and `bundle-network`;
  a deliberately broken worker/WASM import fails `e2e-extension`; the Definition of Done in
  TICKETS.md carries the M4 and M8 lines.

### HRD-55 · Build output, packaging, browser floors and docs match what ships — `S` `P1`

**Status: Done (AUDIT-2026-09-25 fixes, 2026-09-26; not regressed per AUDIT-2026-10-01 §0)** — floors accepted as final by the owner (2026-09-27).

- **Requirements:**
  - **AUDIT-2026-09-25 PLT-9** (🟡) — The manifests declare the floors the bundled pdf.js
    really needs, tied to the pdf.js version by a test (`scripts/browser-floors.mjs`):
    `minimum_chrome_version` 147 and gecko `strict_min_version` 144.0 (pdf.js 6 calls
    `Math.sumPrecise`, `Map.prototype.getOrInsertComputed`, `Uint8Array.fromBase64`,
    `Promise.try` unguarded); switching to `pdfjs-dist/legacy` is the only way to lower
    them. Was: no Chrome floor and Firefox 112, so stores accepted installs that could not
    render. Tests: `browser-floors.test.ts`, `firefox-manifest.test.ts`, `manifest.spec.ts`.
  - **AUDIT-2026-09-25 PLT-10** (🟡) — Tooling hooks and documented commands actually run:
    the Prettier PostToolUse hook calls `node_modules/.bin/prettier`, CLAUDE.md documents
    pnpm, and the permission allowlist grants `pnpm *` and direct `node_modules/.bin/…`
    tools. Was: `npm`/`npx` fail with `EBADDEVENGINES`, so the hook had never run.
  - **AUDIT-2026-09-25 PLT-12** (⚪) — Both builds ship `THIRD_PARTY_LICENSES.txt` (Apache
    NOTICE for pdf.js, tesseract, tfjs; LGPL for libheif) generated at build time. Tests:
    `third-party-licenses.test.ts`, `a11y-and-perf.spec.ts`, `extension.spec.ts`.
  - **AUDIT-2026-09-25 PLT-13** (⚪) — Sourcemaps are `hidden` and never in the store zip
    (`pnpm package` strips `*.map`). Was: 23 MB of a 44 MB extension build.
  - **AUDIT-2026-09-25 PLT-14** (⚪) — `public/` is filtered per target (no
    `robots.txt`/`sitemap.xml` in the extension, no extension `manifest.json` on the web)
    and modulepreload is off for the extension. Test: `extension.spec.ts`.
  - **AUDIT-2026-09-25 PLT-17** (⚪) — Docs match reality: load `dist/ext`; OCR's first use
    needs the network; the feature list matches the tool registry; workers live in
    `src/core/workers/`; the web twin deploys to GitHub Pages.
  - **AUDIT-2026-09-25 PLT-19** (⚪) — The `<input type=file>` fallback uses the `cancel`
    event, with focus only as a last resort, so a slow selection is never dropped. Test:
    `file-input-fallback.test.ts`.
  - **AUDIT-2026-09-25 UI-29** (⚪) — The dev component gallery is gated on
    `import.meta.env.DEV` and absent from production builds.
- **AC:** `pnpm package` output contains no `*.map`, includes the licence file, and its
  manifests carry the tested floors; `#/dev/components` 404s in `dist/ext`.

### HRD-60 · Engineering rules from recurring bug patterns — `S` `P1`

**Status: Done (2026-10-06)** — the shared helpers exist (`src/core/page-version.ts`,
`size-guard.ts` `chooseSmaller`, `page-range.ts` `parsePageRange`, `bytes.ts`
`formatBytes`/`formatBytesUp`) and every known instance is fixed. Both guard rails are in:
(1) `@typescript-eslint/no-floating-promises` and `no-misused-promises` are enabled for
`src/` (type-aware, in `eslint.config.js`); all 81 violations were fixed without a single
disable — handlers whose rejection was uncaught now go through `withErrorToast`
(`src/ui/asyncHandler.ts`), and caught-but-only-logged errors now reach `notifyError`;
(2) `tests/unit/i18n-literal-labels.test.ts` (TypeScript compiler API) scans all of `src/`
for untranslated progress labels, `notify()` titles/details/action labels and job labels, with
a self-check probe; it found and fixed two literals. Cost: `eslint .` takes about 17–25 s
(was about 8.5 s).

Nine root causes produced most of the audit's findings. Each is now a rule for new code,
so the next instance is caught in review or by a gate, not by the next audit.

- **Requirements:**
  - **AUDIT-2026-10-01 pattern 1** — every per-document cache (bytes, text, rasters, diff
    images) is keyed on the page list (`page-version.ts`), never on `doc.id` alone, and is
    dropped when the pages change. Was: Read aloud (UI-1), Reflow (X-11) and Compare (X-13)
    served deleted pages.
  - **AUDIT-2026-10-01 pattern 2** — "never larger than the input" is enforced once, by
    `chooseSmaller(original, result)` (`src/core/size-guard.ts`) in the commit path of every
    size-reducing tool, not tool by tool. Was: Image to size guarded only upright JPEGs
    (IMG-1), Grayscale only warned (UI-OPS19), Compress + Protect skipped the guard (IMG-5).
  - **AUDIT-2026-10-01 pattern 3** — every success message ("Reached", "Opened X", "Repaired")
    is computed from the bytes actually saved and the return value actually received, never
    from intent flags. Was: IMG-5, RT-2, Image to size "Reached" on a re-encode that grew.
  - **AUDIT-2026-10-01 pattern 4** — verify the output, not the plan: verification also
    covers fallback paths (rasterised pages, salvage), and risky recovery runs only on
    evidence of damage. Was: PDF-2, PDF-1 (trailer-only encryption check), PDF-3.
  - **AUDIT-2026-10-01 pattern 5** — one input has one parser: page ranges go through the
    exported `parsePageRange` (`src/core/page-range.ts`) in preview and worker alike, and a
    non-empty range that selects zero pages is a visible warning. Was: X-7, X-8.
  - **AUDIT-2026-10-01 pattern 6** — byte sizes are decimal (1 KB = 1000 B) everywhere, shown
    by one formatter and read by one parser (`src/core/bytes.ts`); a size that missed its
    target is rounded up (`formatBytesUp`). Was: IMG-3, IMG-4, IMG-11, X-10.
  - **AUDIT-2026-10-01 pattern 7** — no whole-document-in-memory loops: page work runs in
    bounded batches and each document is loaded once per operation. Was: PDF-5, X-4, X-5.
  - **AUDIT-2026-10-01 pattern 8** — every async UI effect has an error state: no promise
    without a `.catch`/try, no speech or media object without `onerror`. Enforce with
    `@typescript-eslint/no-floating-promises` (not yet enabled). Was: UI-2, X-11, X-12.
  - **AUDIT-2026-10-01 pattern 9** — no user-visible English outside `t()`/`translate()`,
    including progress stage labels and `detail` strings; the i18n coverage scan must see
    string literals passed to `stage()`/`progress()`/`detail` (today only for
    `operations.ts`). Was: X-14, UI-12.
  - **Keep sound (checked 2026-10-01):** `permissions: []` on every build (`omnibox` is a
    key, not a permission); the manifest CSP equals `STAPLER_CSP`; no `chrome.*` outside
    the allowed layers; deep-link values are rejected or clamped and reach only signals;
    the worker client rejects pending calls on crash, balances `pin()`/`release()` and
    never reuses a transferred `ArrayBuffer`; the document cap holds on every external open
    path; undo stays within the active document; object URLs are revoked; no `setInterval`;
    commit and CTA have a double-run guard.
- **AC:** A new instance of any pattern fails a gate or a named test, not only review.
  Met for patterns 1–7 by the tests in HRD-61..HRD-67; unmet for pattern 8 (no lint rule)
  and pattern 9 outside `operations.ts`.

### HRD-61 · PDF internals: grayscale and repair integrity — `M` `P1`

**Status: Done (2026-10-02)** — all nine findings fixed. Known limit: pdf-lib cannot save
incrementally, so the output document still grows to the output size during PDF-5's
batches.

Grayscale (OPS-19) and Repair (DOC-13) each made a guarantee their own checks did not
prove.

- **Requirements:**
  - **AUDIT-2026-10-01 PDF-1** — Repair refuses an encrypted file even when its trailer is
    lost: it refuses on a security-handler dict (`/Filter` + `/O` + `/U`) or a raw
    `/Encrypt` name **outside stream data**. Was: an encrypted file cut before its final
    `xref` was "rebuilt", reported as a success, and saved as ciphertext with no
    `/Encrypt` (`src/core/pdf/repair.ts`). Tests: `tests/unit/repair.test.ts` (PDF-1 cases).
  - **AUDIT-2026-10-01 PDF-2** — grayscale verification counts raster reasons as colour
    left; a rasterised page is rendered with its annotations and the drawn annotations are
    hidden. Was: the fallback render used `annotationMode: DISABLE`, the colour annotation
    stayed on top, and max chroma was 255 before and after. Tests:
    `tests/unit/grayscale-audit.test.ts`.
  - **AUDIT-2026-10-01 PDF-3** — salvage runs only on evidence of damage (bad xref, missing
    `%%EOF`) and skips matches inside parsed stream ranges; an intact file round-trips as
    already valid. Was: `salvageDroppedObjects` regex-scanned stream bytes for `N G obj`,
    reported intact files as damaged and could inject or replace objects. Tests:
    `tests/unit/repair.test.ts`, `tests/unit/repair-intact.test.ts`,
    `tests/e2e/repair-intact.spec.ts`.
  - **AUDIT-2026-10-01 PDF-4** — a Type 0 function with m > 1 inputs uses multilinear
    interpolation (up to 8 inputs) and returns null (rasterise) above that. Was:
    nearest-neighbour lookup gave wrong DeviceN greys with hard jumps
    (`src/core/pdf/functions.ts`). Tests: `tests/unit/functions.test.ts`.
  - **AUDIT-2026-10-01 PDF-5** — grayscale plans, decodes and applies in batches of 8 pages
    through a process-worker session (`grayscaleBegin` / `grayscaleApplyBatch` /
    `grayscaleFinish`); converter memos persist across batches so shared objects are
    written once and the output is byte-identical to a single batch. Was: every page's
    decoded images and rasters were held at once (~2.5 GB for 300 pages at 300 dpi).
    Tests: `tests/unit/grayscale-audit.test.ts`, `tests/unit/grayscale-batching.test.ts`.
  - **AUDIT-2026-10-01 PDF-6** — a resource-less shared Form XObject is converted once
    (memoised by object plus inherited resources). Was: one form became N copies. Tests:
    `tests/unit/grayscale-audit.test.ts`.
  - **AUDIT-2026-10-01 PDF-7** — a PostScript-function stack underflow throws, and the
    tint returns null (rasterise), never zeros. Was: a malformed tint mapped to the wrong
    grey. Tests: `tests/unit/functions.test.ts`, `tests/unit/grayscale-audit.test.ts`.
  - **AUDIT-2026-10-01 PDF-8** — a content-parse failure is reported for what it is. Was:
    every parse error said "contains an inline image" (`grayscale.ts`). Tests:
    `tests/unit/grayscale-parse-errors.test.ts`.
  - **AUDIT-2026-10-01 PDF-9** — `renderPageGray` takes the job handle and is cancellable;
    repair scans the bytes directly. Was: no cancellation, and repair built two
    whole-file latin1 strings. Tests: `tests/unit/grayscale-audit.test.ts`.
- **AC:** Each test above fails before the fix and passes after; an encrypted file with a
  lost trailer is refused; eleven intact fixtures round-trip as already valid with
  unchanged text; a page rasterised for an annotation has R = G = B on every sampled
  pixel.

### HRD-62 · Runtime, history and local-data integrity — `M` `P1`

**Status: Done (2026-10-02)** — all ten findings fixed. Known limits: the web-twin precache
survives Clear-all (app code, not user data); granted persistence cannot be revoked by a
page.

Undo, Repair's open path, session restore and Clear-all (DOC-14, DOC-15, DS-12) could lose
work or claim a deletion that did not happen.

- **Requirements:**
  - **AUDIT-2026-10-01 RT-1** — undo and redo never restore `dirty` or `baseline` from a
    snapshot: `rebaseHistory()` re-anchors every snapshot on save, `dirty` is recomputed
    against the live baseline, and `sourceHandle` stays live. Was: rotate → Save over
    original → Ctrl+Z left the page unrotated but marked clean, so closing gave no prompt
    (`src/core/history.ts`). Tests: `tests/unit/runtime-audit-2026-10-01.test.ts`.
  - **AUDIT-2026-10-01 RT-2** — "Open repaired" checks `workspaceOpenCapacity(1)` first,
    releases the source on refusal, has an in-flight guard, and reports success only when
    `addDocument()` returned true. Was: a success toast with no tab at the 20-document cap,
    an orphaned OPFS source, and two copies on double-click (`RepairPanel.tsx`,
    `repair/state.ts`). Tests: `tests/unit/runtime-audit-2026-10-01.test.ts`.
  - **AUDIT-2026-10-01 RT-3** — Clear-all counts OPFS `removeEntry` failures and shows the
    partial-clear warning (`isPartialClear`). Was: a locked pre-redaction original survived
    while the user was told everything was deleted (`opfs.ts`, `local-data.ts`). Tests:
    `tests/unit/runtime-audit-2026-10-01.test.ts`.
  - **AUDIT-2026-10-01 RT-4** — the other-tab check (`otherStaplerTabsOpen()`) runs again
    after the confirm dialog. Was: a tab opened while the dialog was up had its sources
    deleted from under it (`src/ui/clearLocalData.ts`). Tests:
    `tests/unit/local-data.test.ts` ("RT-4 — refuses when another tab opens…").
  - **AUDIT-2026-10-01 RT-5** — the tesseract-cache IndexedDB open is raced against
    `DB_OPEN_TIMEOUT_MS`, and a connection arriving after the timeout is closed. Was: no
    timeout or `onblocked`, so Clear-all could hang with autosave suspended. Tests:
    `tests/unit/runtime-audit-2026-10-01.test.ts`.
  - **AUDIT-2026-10-01 RT-6** — session restore trims to `MAX_OPEN_DOCUMENTS` in
    `checkRecovery`, keeps the active document, and reports cap drops separately from lost
    data. Was: a 30-document record restored all 30. Tests:
    `tests/unit/runtime-audit-2026-10-01.test.ts`.
  - **AUDIT-2026-10-01 RT-7** — restored history obeys the per-document depth and
    `MAX_TOTAL_SNAPSHOTS` (sparing the active document). Was: restored redo stacks were
    uncapped. Tests: `tests/unit/runtime-audit-2026-10-01.test.ts`.
  - **AUDIT-2026-10-01 RT-8** — Clear-all deletes the `stapler-meta` IndexedDB database, with
    a bounded wait that resolves false when blocked. Was: it survived. Tests:
    `tests/unit/runtime-audit-2026-10-01.test.ts`.
  - **AUDIT-2026-10-01 RT-9** — `persist()` is asked at most once per session even when the
    outcome cannot be stored, and no toast shows when the outcome was not recorded. Was:
    "ask once" depended on an IndexedDB write, so a failed write re-asked and re-toasted
    every session (`storage-persistence.ts`). Tests: `tests/unit/local-data.test.ts`
    ("RT-9: asks at most once per session…").
  - **AUDIT-2026-10-01 RT-10** — no `*.orig` (or other merge-backup) file is tracked;
    `*.orig` is in `.gitignore`. Was: eight tracked `.orig` files from 634eb74 made grep
    return duplicate definitions.
- **AC:** The named tests pass; after Clear-all with a locked file the UI says the clear was
  partial; `git ls-files '*.orig'` is empty.

### HRD-63 · Web twin service worker, share target and release pipeline — `M` `P1`

**Status: Done (2026-10-02) in code and CI; four checks not verifiable here** — a real Android
share, Lighthouse installability, an OS "Open with" launch, and a release workflow run on a
real tag. RELEASE_CHECKLIST.md carries the manual Android share step.

The web twin (DIST-06) could run new HTML with old JS, lose its tool code in a second tab,
and accept a cross-site share; the release (DIST-07) did not ship what it tested.

- **Requirements:**
  - **AUDIT-2026-10-01 PLT-1** — a page and its scripts always come from one build: entry
    files are hashed on the web build, pages are served cache-first from the controlling
    worker's own cache, and installs are SHA-256-checked. The host must serve build output
    byte for byte (RELEASE_CHECKLIST.md website deploy step). Was: network-first pages with
    unhashed cache-first `[name].js` ran v2 HTML on v1 `editor.js` and broke the next
    offline launch (`src/platform/pwa/service-worker.ts`, `vite.config.ts`). Tests:
    `tests/unit/pwa-sw-routing.test.ts`, `tests/unit/pwa-build.test.ts`.
  - **AUDIT-2026-10-01 PLT-2** — every worker imports `src/core/workers/network-guard.ts`
    first, so worker `fetch`/XHR/WebSocket refuse remote URLs on the website too; cases the
    guard cannot cover are listed in `scripts/csp.mjs`. Was: the web CSP is a `<meta>`,
    which does not apply to workers, and GitHub Pages sends no CSP header. Tests:
    `tests/unit/network-guard-worker.test.ts`.
  - **AUDIT-2026-10-01 PLT-3** — a share-target POST is classified as reject, verified or
    unverified; a cross-site one is rejected, and an unverified one (no Origin, referrer or
    client: every real OS share) is held in the inbox and imported only after "Open N
    shared files?" is confirmed. Was: any site could auto-submit a form to `/share-target`
    and open an attacker-chosen PDF (`sw-routing.ts`, `src/ui/pwa.ts`). Tests:
    `tests/unit/share-consent.test.ts`, `tests/unit/pwa-sw-routing.test.ts`,
    `tests/e2e/pwa-share-consent.spec.ts`.
  - **AUDIT-2026-10-01 PLT-4** — an update applied in one tab never strands another: the old
    cache is kept until its clients are gone; a cold-started worker holds same-origin GETs
    until it has read the kept-cache record and then serves the kept file or forwards the
    original `Request` unchanged (`src/platform/pwa/passthrough.ts`: same-origin GET only,
    query, headers and real status intact); a hard-reloaded tab detects an update applied
    elsewhere. Was: tab A's update deleted the old cache and tab B's tool code 404ed.
    Tests: `tests/unit/pwa-sw-routing.test.ts`, `tests/unit/pwa-launch.test.ts`.
  - **AUDIT-2026-10-01 PLT-5** — Clear-all deletes the `stapler-share-inbox` cache; inbox
    batches older than 10 minutes, malformed or future-dated are swept on every normal start
    and before each new share, never on a share-target launch. Was: shared files could stay
    indefinitely. Tests: `tests/unit/share-inbox-expiry.test.ts`,
    `tests/unit/runtime-audit-2026-10-01.test.ts`.
  - **AUDIT-2026-10-01 PLT-6** — the network fallback for a page has a ~3 s timeout behind
    cache-first serving. Was: no timeout, so offline launch stalled on a flaky connection.
    Tests: `tests/unit/pwa-sw-routing.test.ts`.
  - **AUDIT-2026-10-01 PLT-7** — the release builds once, then tests and publishes those same
    zips as a draft release with a web zip and a `.sha256` per file; `perf` is in `needs`;
    the `e2e-web-shipped` job unzips the shipped web zip, checks it holds no test hooks, and
    runs the zero-network, offline and share specs against those bytes. Was: the release
    job rebuilt instead of shipping the tested artifacts (`.github/workflows/release.yml`).
    Tests: `tests/e2e/pwa-shipped.config.ts`, `tests/e2e/pwa-shipped-network.spec.ts`.
- **AC:** The named tests and the zero-network e2e pass; `dist/ext` still has no service
  worker registration or web manifest. Manual, before a release: a real Android share,
  Lighthouse installability, OS "Open with", and one run of the workflow on a real tag.

### HRD-64 · Image tools and size honesty — `M` `P1`

**Status: Done (2026-10-02)** — all twelve findings and UI-OPS19 fixed. Design decision kept:
Grayscale warns about growth and does not block (see UI-OPS19).

Size-reducing and resizing tools (CNV-14, DIST-08, DOC-07, OPS-15) must never save a
bigger file than they were given, never report a target they missed, and never quietly run
a value other than the one typed.

- **Requirements:**
  - **AUDIT-2026-10-01 IMG-1** — for every format, the original is kept whenever it already
    satisfies the request and the result is not smaller (`chooseSmaller()`,
    `src/core/size-guard.ts`). Was: only upright JPEGs had the fallback; a PNG grew
    1,379 → 2,077 B and was reported "Reached" (`commit.ts`, `image-target.ts`). Tests:
    `tests/unit/size-honesty-commit.test.ts`, `tests/unit/bytes-and-size-guard.test.ts`,
    `tests/unit/image-size-audit.test.ts`.
  - **AUDIT-2026-10-01 IMG-2** — an out-of-range amount shows an inline error and the run
    refuses rather than using a previous value; a unit change converts the amount and is
    bounds-checked. The same rule (`targetKbInRange`, via `validateSizeParam`) applies to
    PDF to Images "Size per image". Was: "4 KB" silently ran 50 KB; 0.5 MB → KB became
    500 B (`ImageSizePanel.tsx`). Tests: `tests/unit/size-honesty-commit.test.ts`,
    `tests/unit/image-size-audit.test.ts`.
  - **AUDIT-2026-10-01 IMG-3** — a size that missed its target is rounded up
    (`formatBytesUp`), and display switches to MB at 999,500 B. Was: "Could not reach
    200 KB. The smallest Stapler could make is 200 KB." Tests:
    `tests/unit/bytes-and-size-guard.test.ts`, `tests/unit/size-honesty-commit.test.ts`.
  - **AUDIT-2026-10-01 IMG-4** — split-by-size uses `targetSizeKb * 1000`. Was: `* 1024`,
    so "5000 KB" allowed 5.12 MB parts that fail a 5 MB portal limit (`commit.ts`; X-9
    merged here).
  - **AUDIT-2026-10-01 IMG-5** — the Compress "Reached" toast is gated on the final written
    size (`finalSize <= targetBytes`), Protect overhead included. Was: it ignored
    encryption overhead. Tests: `tests/unit/size-honesty-commit.test.ts`.
  - **AUDIT-2026-10-01 IMG-6** — "longest side at most N" never yields N+1 px (canvas sized
    with `fitWithin` / floored with an epsilon). Was: a 595 pt page gave 401/801/1601 px
    (`render.worker.ts`). Tests: `tests/unit/operations-sized-image.test.ts`,
    `tests/unit/cnv14-pdf-to-img.test.ts`.
  - **AUDIT-2026-10-01 IMG-7** — the PDF to Images size estimate uses the first page's
    rotated viewport and caps the longest side. Was: a hard-coded 595 pt width capped on
    width (`PdfToImagePanel.tsx`).
  - **AUDIT-2026-10-01 IMG-8** — the pixel limit is checked from each format's header before
    decoding (JPEG via `readJpegInfo`'s SOF; post-decode check when there is no usable
    SOF), and throws `unsupported` naming the dimensions. The same limit guards Images to
    PDF's main-thread decode (`imageFileToPdfImages`: header in the first 1 MB, else the
    decoded bitmap). Was: a 20000×20000 PNG gave a cryptic canvas/OOM error
    (`image.worker.ts`). Tests: `tests/unit/image-limits-gif-audit.test.ts`,
    `tests/unit/image-size-audit.test.ts`, `tests/unit/images-to-pdf-pixel-limit.test.ts`.
  - **AUDIT-2026-10-01 IMG-9** — TIFF Orientation (tag 274) is applied, and Image to size and
    Images to PDF name each animated GIF whose first frame alone was used (frames counted by
    the streaming `GifFrameCounter`). Was: orientation ignored, later frames dropped
    silently (`raster-decode.ts`). Tests: `tests/unit/image-limits-gif-audit.test.ts`,
    `tests/unit/image-size-audit.test.ts`.
  - **AUDIT-2026-10-01 IMG-10** — `isBrowserRenderableImage` is false when `rasterKindOf()`
    is non-null or the size is 0, and `<img>` has an `onError` fallback. Was: MIME OR
    extension, so a HEIC named `.jpg` or a 0-byte `.png` showed a broken image
    (`src/core/image.ts`). Tests: `tests/unit/image-size-audit.test.ts`.
  - **AUDIT-2026-10-01 IMG-11** — the "200 MB" limit is 200,000,000 B, and KiB/MiB are scaled
    correctly or rejected. Was: 200 MiB, and KiB/MiB parsed as decimal (`image.ts`,
    `deep-link.ts`). Tests: `tests/unit/image-size-audit.test.ts`.
  - **AUDIT-2026-10-01 IMG-12** — the Compress target field validates against
    `PDF_TARGET_BOUNDS`, with 10 KB as the minimum, matching the deep link. Was: 50 B
    accepted (`CompressPanel.tsx`). Tests: `tests/unit/size-honesty-commit.test.ts`,
    `tests/unit/image-size-audit.test.ts`.
  - **AUDIT-2026-10-01 UI-OPS19** — Grayscale never writes a larger file silently: growth
    is warned with both sizes (never shown as equal), including growth caused by password
    protection or re-applied restrictions alone, and the export review shows both sizes
    before anything is written. It warns rather than blocks, because the original cannot
    satisfy "make it grey" and a blocking confirm interrupted ordinary vector-only
    conversions that grow by a few bytes. Was: saved with only a warning, no sizes. Tests:
    `tests/unit/size-honesty-commit.test.ts` ("OPS-19 — Grayscale never writes a larger
    file silently").
- **AC:** The audit's probe cases (PNG 1,379 B, WebP 488 B, 5 MB target) keep the original;
  no "Reached" appears unless the written bytes meet the target; the named tests pass.

### HRD-65 · UI: read aloud, single-page view, repair, duplex and tooltips — `M` `P1`

**Status: Done (2026-10-02)** — all twelve findings and the ACC-04 voice-fallback notice fixed.

The read-aloud panel (ACC-04), the single-page view (DS-10), the Repair and Duplex panels
(DOC-13, OPS-20) and the rail tooltip (DS-11) had stale state, stuck states and silent
fallbacks.

- **Requirements:**
  - **AUDIT-2026-10-01 UI-1** — Read aloud keys its cached bytes and text on the page list
    and stops speech when it changes. Was: delete page 2, press Play on page 2, and it read
    the deleted page (`ReadAloudPanel.tsx`). Tests: `tests/e2e/audit-2026-10-01-ui.spec.ts`.
  - **AUDIT-2026-10-01 UI-2** — a synthesis error (`utterance.onerror`) or a failed page
    extraction resets the panel to idle with a note. Was: stuck on "Reading page N" with an
    unhandled rejection. Tests: `tests/e2e/audit-2026-10-01-ui.spec.ts`.
  - **AUDIT-2026-10-01 UI-3** — Repair repairs what the panel names: an untouched document
    from its raw file, an edited one composed from its own pages, rotations, crops and
    annotations; it falls back to the raw file only when the edits cannot be written, and
    says so. Was: a single-source document was repaired from its original file, dropping
    rotations, deletions and annotations under copy saying "the open document"
    (`src/ui/tools/commit.ts`). Tests: `tests/unit/size-honesty-commit.test.ts`
    ("UI-3 — Repair repairs the open document, edits included").
  - **AUDIT-2026-10-01 UI-4** — sentence splitting does not break after titles, initials and
    mid-sentence abbreviations, and caps each utterance at about 250 characters (breaking at
    whitespace or a comma, never inside a surrogate pair; CJK and RTL work). Was:
    `Intl.Segmenter` split after "Dr." and a table page became one utterance Chrome cut off
    (`sentences.ts`). Tests: `tests/unit/ui-audit-2026-10-01.test.ts`.
  - **AUDIT-2026-10-01 UI-5** — fit-to-view observes the stage through a callback ref, so it
    works when the stage mounts late (session restore). Was: a `[]`-deps ResizeObserver
    effect left zoom at 100% (`SinglePageView.tsx`).
  - **AUDIT-2026-10-01 UI-6** — a manual zoom is kept across page changes and reset only on a
    document, displayed-size or rotation change. Was: reset on every page change, against
    the file's own header comment. Tests: `tests/unit/ui-audit-2026-10-01.test.ts`.
  - **AUDIT-2026-10-01 UI-7** — resize ticks are coalesced and the zoom floored to a whole
    percent, so a drag yields few renders. Was: every tick started a full worker render
    (`usePageRender.ts`). Tests: `tests/unit/ui-audit-2026-10-01.test.ts`.
  - **AUDIT-2026-10-01 UI-8** — the Duplex interleave button is disabled until the page order
    changes. Was: a second press scrambled the order (`DuplexSection.tsx`). Tests:
    `tests/unit/ui-audit-2026-10-01.test.ts`.
  - **AUDIT-2026-10-01 UI-9** — the chosen repair file can be cleared ("Use the open
    document", `clearRepairCandidate`). Was: `repairCandidate` was never cleared, so later
    repairs targeted a stale file (`repair/state.ts`). Tests:
    `tests/unit/runtime-audit-2026-10-01.test.ts`.
  - **AUDIT-2026-10-01 UI-10** — reading to the end resets to page 1, sentence 1, and the
    "skipped page" note stays visible for at least one sentence. Was: Play at the end read
    only the last sentence and the note was cleared unseen. Tests:
    `tests/e2e/audit-2026-10-01-ui.spec.ts`.
  - **AUDIT-2026-10-01 UI-11** — tooltips meet WCAG 1.4.13: the bubble is hoverable with a
    hide delay; each rail item has its own static hidden summary for `aria-describedby`;
    the trust chip drops a describedby that only repeated its name; the Escape listener
    attaches in a layout effect. Was: unhoverable bubble, describedby one render late, and
    an Escape race that made `mobile.spec.ts` flaky (`FloatingTooltip.tsx`).
  - **AUDIT-2026-10-01 UI-12** — `HomeView`'s `detail` goes through `translate()` and is in
    every locale. Was: hard-coded English (`src/ui/home/HomeView.tsx`).
  - **AUDIT-2026-10-01 ACC-04** — a remembered voice that is no longer installed (or is now a
    network voice) falls back to the default local voice with a notice; voice and rate
    survive a reload. Was: silent fallback (`voices.ts`), no reload e2e. Tests:
    `tests/unit/ui-audit-2026-10-01.test.ts`, `tests/e2e/read-aloud-preferences.spec.ts`.
- **AC:** The named tests pass in light and dark; the tooltip can be hovered and dismissed
  with Escape; `mobile.spec.ts` is stable under load.

### HRD-66 · Compare exports: correct, cancellable, bounded — `M` `P1`

**Status: Done (2026-10-02)** — all seven findings fixed.

The visual-diff (ANN-05) and redline (ANN-06) exports produced wrong output under cancel,
non-Letter pages and mixed sizes, and held whole documents on the main thread.

- **Requirements:**
  - **AUDIT-2026-10-01 X-1** — a cancelled export throws `cancelled()` and saves nothing.
    Was: `break` then save, so cancel at page 3 of 40 offered a 2-page "diff"
    (`src/core/visual-diff-export.ts`). Tests:
    `tests/unit/compare-export-audit-2026-10-01.test.ts`.
  - **AUDIT-2026-10-01 X-2** — each output page uses the real CropBox size and rotation.
    Was: every page forced to 612×792, distorting A4 and landscape. Tests:
    `tests/unit/compare-export-audit-2026-10-01.test.ts`,
    `tests/e2e/audit-2026-10-01-ui.spec.ts`.
  - **AUDIT-2026-10-01 X-3** — pages of different sizes are compared by resampling one image
    to the other's size, as the live view does. Was: `pixelDiff` threw on a size mismatch,
    so A4 vs Letter or a rotated page could not be exported (`pixel-diff.ts`). Tests:
    `tests/unit/compare-export-audit-2026-10-01.test.ts`, `tests/unit/compare.test.ts`,
    `tests/e2e/audit-2026-10-01-ui.spec.ts`.
  - **AUDIT-2026-10-01 X-4** — each document is loaded once per export
    (`src/core/compare-documents.ts`). Was: both reloaded on every page (400 pdf.js loads
    for two 200-page files). Tests: `tests/unit/compare-export-audit-2026-10-01.test.ts`.
  - **AUDIT-2026-10-01 X-5** — redline export works page by page. Was: both documents
    rasterised at once (~1.7 GB for a 200-page pair) (`redline-export.ts`). Tests:
    `tests/unit/compare-export-audit-2026-10-01.test.ts`.
  - **AUDIT-2026-10-01 X-6** — per-page `getImageData`, diff and PNG encode run in the cv
    worker (`src/core/compare-raster.ts`), with per-page determinate progress. Was: >50 ms
    per page on the main thread, no progress. Tests:
    `tests/unit/compare-export-audit-2026-10-01.test.ts`,
    `tests/e2e/audit-2026-10-01-ui.spec.ts`.
  - **AUDIT-2026-10-01 X-13** — moving the sensitivity slider recomputes only the diff from
    the kept rendered `ImageData`. Was: each tick reloaded and re-rendered both documents
    (`CompareView.tsx`).
- **AC:** A4 against Letter exports at real sizes; cancel writes nothing; peak memory is per
  page, not per document; the named tests pass.

### HRD-67 · Cross-cutting: ranges, units, async errors, strings and types — `S` `P1`

**Status: Done (2026-10-02)** — all seven findings fixed.

Repo-wide instances of patterns 5, 6, 8 and 9 and of the strict-TypeScript convention.

- **Requirements:**
  - **AUDIT-2026-10-01 X-7** — preview and export share `parsePageRange`; a whitespace-only
    range means every page, an en dash and `;` are accepted, and a non-empty range that
    selects nothing is flagged. Was: `" "` selected all pages in the watermark preview and
    none in the export, and `–`, `;`, `0`, `-` silently selected nothing
    (`watermark/state.ts` vs `process.worker.ts`). Tests:
    `tests/unit/ui-audit-2026-10-01.test.ts`.
  - **AUDIT-2026-10-01 X-8** — custom split points accept plain integers only. Was:
    `parseInt` accepted `"1-3"` and `"2.5"` (`operations.ts`). Tests:
    `tests/unit/split-points.test.ts`.
  - **AUDIT-2026-10-01 X-10** — storage, import, open-document, OCR, zip-guard and PPTX
    size messages use the one decimal formatter. Was: 1024-based units in each. Tests:
    `tests/unit/bytes-and-size-guard.test.ts`.
  - **AUDIT-2026-10-01 X-11** — Reflow, `HomeView` and `LocalDataSection` promise chains have
    an error state, and Reflow's text is keyed on the page version. Was: no `.catch`, and
    stale Reflow text after page edits.
  - **AUDIT-2026-10-01 X-12** — a corrupt Flate stream rejects once, through `decodeStream`,
    with the writer's `write()` and `close()` rejections caught. Was: two unhandled
    rejections (`src/core/pdf/interpreter.ts`). Tests:
    `tests/unit/interpreter-decode.test.ts`.
  - **AUDIT-2026-10-01 X-14** — every progress label and user-facing note in `operations.ts`
    goes through `translate()` with `{page}` parameters. Was: about 15 bare English
    labels. Tests: `tests/unit/i18n-literal-labels.test.ts` (now scans all of `src/`, HRD-60).
  - **AUDIT-2026-10-01 X-15** — no `any` without a justifying comment. Stored
    `Recipe.settings` is `unknown`, validated by `parseRecipe`
    (`src/ui/tools/batch/recipe-settings.ts`) before a batch runs or a recipe is imported;
    a malformed recipe stops with the bad fields named; stored shape and DB version
    unchanged. Was: unjustified `any` in `BatchPanel.tsx`, `AcroFormOverlay.tsx`,
    `ImageOptionsDialog.tsx` and `db.ts`. Tests: `tests/unit/recipe-settings.test.ts`.
- **AC:** The named tests pass; the four files X-15 named contain no `any`, and every
  remaining `any` in `src/` sits under an `eslint-disable` with a justifying comment.

### HRD-68 · Regressions found by the first post-fix review — `S` `P1`

**Status: Done (2026-10-02)** — every item fixed with a test that fails before and passes
after, except two recorded verdicts: one not reproduced, one documented.

A review of the fix branch against `master` for bugs the fixes introduced.

- **Requirements:**
  - **AUDIT-2026-10-01 UI-3 follow-up** — Repair never stamps Watermark, Header/Footer or
    N-up panel settings into a repaired file, and an untouched document is repaired from
    its raw bytes (`hasDocumentEdits`). Was: the UI-3 fix composed every document, so panel
    settings leaked in and salvageable damaged files were rebuilt instead. Tests:
    `tests/unit/size-honesty-commit.test.ts`.
  - **AUDIT-2026-10-01 IMG-1 follow-up** — Image to size caps JPEG quality at the source size
    only when `imageOriginalSatisfies` holds (now in `raster-decode.ts`, shared with the
    worker). Was: the cap also applied to files it must convert anyway (HEIC, TIFF,
    sideways JPEG). Tests: `tests/unit/image-source-cap.test.ts`.
  - **AUDIT-2026-10-01 PDF-2 follow-up** — not reproduced: an annotation hidden by PDF-2
    flattening was suspected to still count as colour left. Two reproductions failed, the
    speculative change was reverted, and the mesh-gradient case is kept as a guard test in
    `tests/unit/grayscale-audit.test.ts`.
  - **AUDIT-2026-10-01 PDF-1 follow-up** — `/Encrypt` counts only outside stream data. Was:
    unencrypted files with `/Encrypt` inside a stream were refused. Tests:
    `tests/unit/repair.test.ts`.
  - **AUDIT-2026-10-01 RT-1 follow-up** — `refreshBaseline` receives the annotations actually
    written and clears `dirty` only when pages and annotations both match. Was: an
    annotation added while a save was in flight became the baseline. Tests:
    `tests/unit/runtime-audit-2026-10-01.test.ts`.
  - **AUDIT-2026-10-01 PLT-4 follow-up** — an active worker at registration time marks the
    first `controllerchange` as an update, not a first install. Was: a hard-reloaded
    (uncontrolled) tab missed a takeover by another tab's update. Tests:
    `tests/unit/pwa-launch.test.ts`.
  - **AUDIT-2026-10-01 PLT-1 follow-up** — documented, not changed: a host that rewrites
    responses makes every service-worker install fail its integrity check. The check stays;
    RELEASE_CHECKLIST.md's website deploy step states the byte-for-byte hosting requirement
    and how to verify the install.
  - **AUDIT-2026-10-01 post-fix cleanups** — the size target is checked before composing;
    `targetKbInRange` uses `validateSizeParam`; the cap message, compare open/close and grey
    encoder each live once (`open-document.ts`, `compare-documents.ts`, `gray-encode.ts`);
    GIF frames are counted once by a streaming `GifFrameCounter`, identical to the old
    counter on every truncation, the fixtures and 300 corrupted files. Tests:
    `tests/unit/image-limits-gif-audit.test.ts`.
  - **AUDIT-2026-10-01 test stability** — e2e specs never exhaust a low-memory runner: the
    19-page CSP test opens a fresh browser context per page; the compress preview reports
    `ready` only after document analysis chose the real page (a check records every page
    that ever reported ready, 10/10 runs). Tests: `tests/e2e/zero-network.spec.ts`,
    `tests/e2e/compress-preview.spec.ts`.
- **AC:** Each fixed item has its regression test; the two verdicts stay recorded here.

### HRD-69 · Regressions found by the second post-fix review — `S` `P1`

**Status: Done (2026-10-02)** — every item fixed with a test. Not verifiable here: a real
Android share, Lighthouse installability, an OS "Open with" launch, and a release workflow
run on a real tag (tracked on HRD-63).

A second review covered the round that implemented the acceptance-criteria gaps (Compress
Colour option for OPS-19, exact width × height for CNV-14, DS-10 layout, PLT-4 cold start).

- **Requirements:**
  - **AUDIT-2026-10-02 compress-grey skipped pages** — Compress with grey names every page it
    could not convert (JBIG2/JPX, failed pages) and never claims full conversion. Tests:
    `tests/unit/ops19-compress-gray.test.ts`.
  - **AUDIT-2026-10-02 compress-grey colour kept** — when grey does not help or cannot be
    verified, a verified colour compression is still saved; the original is kept only when
    that is not smaller either. Was: the colour result was discarded. Tests:
    `tests/unit/ops19-compress-gray.test.ts`.
  - **AUDIT-2026-10-02 cold-start passthrough** — requests held by a cold-started worker are
    forwarded unchanged: query string and headers kept, a 404 stays a 404, no shared scratch
    cache entry. Tests: `tests/unit/pwa-sw-routing.test.ts`.
  - **AUDIT-2026-10-02 exact-size limits** — Image to size and PDF to Images share one area
    limit and one per-side limit (`src/core/render-limits.ts`), checked before any canvas is
    allocated. Was: Image to size had a looser pixel cap and no per-side check. Tests:
    `tests/unit/cnv14-exact-limit.test.ts`.
  - **AUDIT-2026-10-02 exact-size relock** — an edit made while the aspect lock is off
    survives re-locking. Tests: `tests/unit/cnv14-exact-size.test.ts`.
  - **AUDIT-2026-10-02 header dimensions** — the Image to size panel reads image dimensions
    from the file header, never by fully decoding the image.
  - **AUDIT-2026-10-02 cleanups** — one `progressBand`, one copy of the cap, no dead
    `applyGrayscale` / `isShareRequestAllowed`; the confirm-dialog list has unique keys; the
    Welcome dialog never stacks over a confirm.
  - **AUDIT-2026-10-02 corpus sweep stability** — the DOC-02 corpus sweep
    (`tests/e2e/import.spec.ts`) opens a fresh tab per fixture in one context instead of
    reloading one tab ~40 times. Was: intermittent `net::ERR_INSUFFICIENT_RESOURCES`. Passed
    3 runs in a row.
- **AC:** The named tests pass; `import.spec.ts` passes repeatedly on a low-memory runner.

### HRD-70 · Redaction through tiling patterns and stroke extents — `M` `P0`

**Status: Done (2026-10-05)** — every item below is fixed with a test on output bytes:
`tests/unit/redaction-tiling-pattern.test.ts`, `tests/unit/redaction-stroke-extent.test.ts`,
`tests/unit/interpreter.test.ts`. Open limits: (1) the verifier cannot see stroke ink outside
patterns, so removal there is proven by the filter's model plus the tests on output bytes;
(2) ExtGState `/Font` is not tracked; (3) an unresolvable ExtGState over-removes (it fails
closed, by design); (4) `gs` inside forms and pattern cells has no test.

Privacy fixes found while closing HRD-41 (PDF-14) and HRD-40. Content a redaction mark covered
could survive inside a tiling-pattern cell, or beside the mark as stroke ink whose centre line
missed it, and the verifier did not look there.

- **Requirements:**
  - **HRD-70 pattern cells** — Content under a mark inside a tiling-pattern cell is removed,
    on every tile the mark reaches and only in the covered part of the cell: paths, text,
    stencil image masks filled with the pattern, covered forms that paint with the pattern
    fill (a covered form that cannot be read is treated as painting it), thick strokes, and
    strokes widened through ExtGState `/LW`. Tests: `redaction-tiling-pattern.test.ts`.
  - **HRD-70 stroke extents** — A stroke is judged by its ink, not its centre line: line
    width, mitre limit at joins, and `/LW` from `/ExtGState` (a later `w` or a `Q` ends it;
    a dash pattern does not shrink the reach). An ExtGState that cannot be resolved is
    treated as infinite width, so the stroke goes. Stroked text (`Tr` 1, 2, 5, 6) is removed
    when its outline enters the mark; `Tr` 0, 3 and 7 are judged on the glyph box as before.
    Tests: `redaction-stroke-extent.test.ts`, `interpreter.test.ts`.
  - **HRD-70 verifier** — The verifier re-runs the cell filter on the output
    (`patternResidue`) and fails closed: a pattern still drawing content under a mark, or
    one that cannot be checked, means the redaction is not proven. Tests: "the verifier
    rejects an overlay that leaves the cell intact", "the verifier rejects a stripped
    stencil mask that left the cell intact".
  - **HRD-70 shared images** — An image a pattern cell still draws is purged only when it is
    unreachable, so stripping or replacing the page's own placement never removes it from
    the cell (redaction and face blur).
  - **HRD-70 refusals** — Redaction refuses, changes nothing and says why for: a pattern with
    no usable `/BBox`, a pattern drawn through a Form XObject, a cell whose content cannot be
    read, and a pattern nested inside a pattern cell.
  - **HRD-70 merged rectangles** — Per-image redaction rectangles are merged per object
    (`rectsByObject`, `render.worker.ts`), so an image under several marks, or drawn by both
    the page and a pattern, is redacted for all of them in one pass.
- **AC:** On fixtures that hide a secret in a pattern cell, under a thick or ExtGState-widened
  stroke, or in stroked text, the redacted output contains none of it (re-parsed bytes), the
  verifier rejects an overlay-only build, and each refusal case leaves the input unchanged
  with its message.

### HRD-71 · Second-round review fixes (2026-10-05) — `S` `P1`

**Status: Done (2026-10-05)** — every item fixed with a test.

A review of the round that closed EPIC-19's open items.

- **Requirements:**
  - **HRD-71 JBIG2/JPX blocks** — Letting JBIG2/JPX pages take the raster route (HRD-39) does
    not bypass the spot-colour (`/Separation`, `/DeviceN`) and stencil (`/ImageMask`)
    blocks. Tests: `compress-edge-cases.test.ts` › "refuses to rasterise a textless page
    carrying %s".
  - **HRD-71 OCR language** — Folder search re-runs OCR on a file's text-less pages when the
    OCR language changes, and a page OCR failed on is retried after a language change.
    Tests: `folder-index-ocr.test.ts` › "switching the OCR language re-OCRs an unchanged
    file's text-less pages".
  - **HRD-71 encrypt once** — With Protect and fast web view on, the export is encrypted
    once, and a growth-guard failure is blamed on the step that caused it. Tests:
    `export-fast-web-view.test.ts` › "fast web view vs the growth guard — one encryption
    pass, honest blame".
  - **HRD-71 annotation summary** — The annotation-summary PDF is built in the process
    worker, not on the main thread. Tests: `annotation-summary-job.test.ts`.
  - **HRD-71 flaky clock** — `permission-restrictions.test.ts` › "an unrestricted document
    is unaffected" froze the clock, so a second boundary between two saves no longer
    changes the compressed length by a byte.
- **AC:** The named tests pass repeatedly.

---

## Critical path to v1.0

```
QA-01 ─┬─ F-01 → F-02 → F-03 → F-04 → F-05 → F-06 → F-07
       └─ DS-01 → DS-02 → DS-03 → DS-04 → DS-05
                                    │
              DOC-01 → DOC-02 → DOC-03 → DOC-04 → DOC-05 → DOC-06
                                    │
        ┌───────────────┬───────────┴────┬──────────────┐
      OPS-01..04     CNV-01..04      SGN-01..03    CMP-01 → CMP-02
                                                        └→ CMP-03 → CMP-04 → CMP-05
                                                   SCN-01 → SCN-02 → SCN-03
                                    │
              DS-06, DS-07, DS-08, NFR-01..03, QA-02..05, DIST-01, DIST-02, DIST-05
```

**Longest pole:** `CMP-03` (surgical re-encode) then `SCN-01` (edge detection). Start both
spike-first, behind a feature flag, so neither can block the rest of v1.0.
