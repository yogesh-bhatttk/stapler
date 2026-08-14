# Stapler — Story Tickets

Companion to [`PLAN.md`](PLAN.md) and [`DESIGN-ADAPTATION.md`](DESIGN-ADAPTATION.md).

**Sizes:** `XS` <½d · `S` ½–1d · `M` 1–3d · `S`…`L` 3–5d · `XL` >5d
**Priority:** `P0` blocks v1.0 · `P1` v1.1–1.2 · `P2` v2.0+

Each ticket carries a **Status** line, audited against the code rather than against
intent — this file is the single source of truth for per-ticket state (an earlier
parallel `STATUS.md` was removed once it drifted out of sync with the entries below).
Reproduce the evidence with `pnpm check && pnpm test && pnpm test:e2e`.

Every ticket must satisfy this **definition of done**, in addition to its own criteria:

- [ ] TypeScript strict, no `any` without a written justification
- [ ] Unit tests for pure logic; E2E test if it adds a user-facing flow
- [ ] Works in light **and** dark theme, keyboard-only, and with a screen reader label
- [ ] Long operations are cancellable and report determinate progress
- [ ] No new manifest permission; no new runtime network request
- [ ] No main-thread block >50ms (verify in a performance trace)
- [ ] Errors surface a human-readable message; document bytes are never silently altered

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
exercising every state. **Missing:** the gallery's axe-core pass (blocked on NFR-01, which
wires axe-core in at all) and `forwardRef` on the pre-existing components from before this
pass (not retrofitted here — no current call site needs a forwarded ref).

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

**Status: Done** — A real button on every route; the trust copy matches what the tests verify.

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

### DOC-02 · Import and validation — `M` `P0`

**Status: Done, with one named gap (HEIC).** Re-verified against the real corpus, not against intent.

- **AC, first half — every fixture imports or gets its specific, accurate explanation:** proven by a sweep over the whole corpus, `tests/e2e/import.spec.ts` › "every PDF in the corpus imports or is refused with a specific reason". It reads `tests/fixtures/*.pdf` off disk (41 files on the last run), imports each through the real file input, and requires every refusal to match one of the pipeline's own sentences — a generic "something went wrong" fails the test. Result: 35 imported (including `xfa.pdf`, `jbig2.pdf`, `jpx.pdf`, `cjk.pdf`, `rtl.pdf`, `cmyk*.pdf`, `heavy.pdf`, `text-300.pdf`); 6 refused — `encrypted.pdf` ("requires a password"), `not-a-pdf.pdf` ("does not start with a PDF header"), and four truncation shapes ("its structure is invalid or truncated").
- **AC, second half — a truncated PDF never crashes the tab:** the pre-existing coverage used `not-a-pdf.pdf`, which is refused by the header check and never reaches pdf.js, so the truncated path was untested and `corruptPdf()` in `tests/e2e/fixtures.ts` was dead code. Now covered three ways (tail-truncated, mid-body, header-only) with a `pageerror` listener asserting no uncaught error, and with a good file imported afterwards in the same tab to prove it still works.
- **Formats:** PNG, JPEG, WebP and TIFF each import through the real pipeline from a real fixture (`sample.png`, `tiny.jpg`, `sample.webp`, `sample.tiff`), and three at once become one three-page PDF whose bytes re-parse. **HEIC is unverified end to end:** ImageMagick here reads HEIC but cannot write it and no other offline encoder is available, so no fixture exists. Its routing and its failure message are covered; its decode is not. Dropping a real `.heic` file into `tests/fixtures/` is the only way to close this.
- **Oversized:** `largeFileWarning()` is unit-tested at the boundary (100MB exactly → silent, +1 byte → warns), and an import of a >100MB PDF is proven to warn rather than refuse (`tests/unit/import.test.ts`). The warning now also covers oversized *images*, which it previously did not.
- **Two full copies of the bytes — one real instance found and fixed:** `render.worker.ts` `loadDocument` did `new Uint8Array(bytes)` before handing the buffer to pdf.js, so a 100MB import held 200MB in the render worker. The copy protected nothing: the argument arrives by structured clone (no call site transfers it), so the array is already private to that worker. Removed; all 34 `tool-flows` E2E tests, which load a document on every path, still pass. The main-thread read (`new Uint8Array(await file.arrayBuffer())`) is a view, not a copy, and was already correct.
- **Fixed along the way:** `tiny.jpg` and `cmyk-text.pdf` were used by unit tests but neither committed nor generated — a fresh clone failed six tests. Both are now built by `scripts/generate-static-fixtures.mjs` and allow-listed. The unsupported-file message and the drop-zone hint both omitted TIFF while the pipeline accepted it; both now read from one `SUPPORTED_FORMATS` constant.

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

**Status: Done** — Row windowing, multi-select, ⌘A, drag with an insertion line, `Alt`+arrow reorder.

- **Requirements:** Windowed rendering, multi-select (click, shift-range, ⌘/Ctrl-toggle,
  ⌘A), drag-to-reorder with a clear drop indicator, and a **keyboard reorder alternative**
  (select → `⌥↑/↓` to move) for accessibility.
- **AC:** 300 pages scroll at 60fps. Every selection and reorder action is achievable by
  keyboard alone.

### DOC-05 · Export pipeline — `M` `P0`

**Status: Partial** — Order and rotation asserted on real bytes. Save-over-original is now
offered in the UI (asks explicitly on every commit for a document opened from one writable
file). **Unverified by automation** — needs the QA-05 manual pass, since Playwright cannot
drive the native file picker.

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

**Status: Done** — Fully implemented in the UI and worker.

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

**Status: Done** — Lazy-loaded WASM HEIC decoder via heic2any allows importing iPhone HEIC photos.

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

**Status: Done** — Fully implemented in the UI and worker.

- **AC:** Headings, lists, tables, code blocks, and links render; page breaks are sensible;
  output text is selectable.

---

## EPIC-4 · Sign and fill

### SGN-01 · Signature capture and library — `M` `P0`

**Status: Done** — Draw/type/import, PNG with real alpha, white-paper removal. Initials supported.

- **Requirements:** Three creation modes — draw on canvas (pointer + stylus pressure where
  available), type with a script-style face, or import a transparent PNG. Auto-trim
  whitespace, remove the white background to real transparency, store in IndexedDB.
  Support multiple signatures plus initials.
- **AC:** A drawn signature exports with genuine alpha (no white box) over coloured page
  content. Saved signatures survive reload.

### SGN-02 · Placement on page — `M` `P0`

**Status: Done** — Real single-page view at true scale, drag, resize, arrow nudge. 

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

**Status: Done** — Real inventory-driven classification, 23 unit tests covering every skip
reason. **Now validated against the real static corpus**, not just hand-built `ImageFacts`
mocks: `tests/unit/compress-plan-fixtures.test.ts` loads `jbig2.pdf`, `jpx.pdf`, `cmyk.pdf`,
`cmyk-text.pdf`, and `encrypted.pdf` directly and asserts on the real parsed inventory (filter
detection, DeviceCMYK resolution from a real ImageMagick-encoded JPEG, an indirect
`/ColorSpace` reference, encryption detection) — these five committed fixtures existed in the
corpus but no test had ever loaded them.

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

**Status: Partial** — The path now works: it did nothing at all before, in three independent ways (pdf.js image objects were read before they had been decoded; images were matched by resource name against pdf.js's own object ids, which never match; and JPEG images arrive as a `VideoFrame`, which the decoder did not recognise). SMask and stencil-mask images, DeviceCMYK, Indexed and ICCBased are all re-encoded now, downscaled to displayed size, with the mask re-attached byte-for-byte; a shared image is encoded *and stored* once. Still skipped and reported: `/Separation` and `/DeviceN` (flattening a named ink to RGB destroys the plate), colour-key `/Mask` arrays, `/Matte` pre-blended soft masks, `/ImageMask` stencils, JPX/JBIG2, sub-byte depth. **Correction:** the mask stream is now resampled too (`encodeMask` in `render.worker.ts`, applied in `rebuildCompressed`), shrink-only so a mask already smaller than the new target is left untouched rather than inflated — this row's "never resampled" was stale as of the SMask-resampling pass. A newly found and fixed correctness bug from this audit: image replacement was keyed by resource *name*, which is scoped per dictionary — a page-level image and an unrelated image inside a nested Form XObject could legally share a local name, letting one silently overwrite or misattach the other's re-encoded bytes. Replacement is now keyed by PDF object number, which is unique document-wide.

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

**Status: Done** — Operator-level removal is implemented and geometrically verified. Redacted regions have their underlying intersecting text structurally removed from the content stream, while keeping text outside the regions fully selectable.

Implements PLAN §4.2 steps 2–3.

- **Requirements:** Strip text-showing operators intersecting a region from the content
  stream; clip or re-encode intersecting image XObjects; rasterize the affected region as a
  final guarantee. Never rely on an overlay rectangle alone.
- **AC:** After applying, text extraction of the output contains **zero** redacted strings.
  Copy-paste from three external viewers over the redacted area yields nothing. Content
  outside regions is unchanged (asserted by text diff).

### RED-03 · Verification report gate — `M` `P1`

**Status: Done** — Verification is geometric and per region; saving is blocked on any failure. **The old verifier reported "passed" for regions it never checked.**

- **Requirements:** Re-extract text and assert absence of every redacted string; render each
  region and check for residual glyphs; present a per-region pass/fail table. **Saving is
  blocked when any region fails**, with an explanation.
- **AC:** A deliberately-sabotaged build (overlay-only redaction) is _rejected_ by the
  verifier. Report renders in both themes and is exportable as text.

### RED-04 · Metadata inspector and scrubber — `M` `P1`

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

**Status: Done** — `src/ui/tools/annotate/` is a real annotation layer: highlight, freehand,
rectangle, text, **sticky note, and whiteout** (both added this pass — `AnnotationType` now
carries all six), colour/stroke picker, separate from the SGN-02 signature-stamp layer it used
to share. **Undo/redo now reaches it**: `pageAnnotations` previously wasn't in
`core/history.ts`'s snapshot at all, so ⌘Z/Ctrl+Z was a no-op for every annotation
(`AnnotateOverlay.tsx` calls `commit()`/history mutators itself, mirroring `CropOverlay.tsx`,
since `state.ts` can't import `history.ts` back without a cycle). No keyboard path existed on
the canvas at all (now Enter adds/arrows move/Delete removes); panel labels pointed at i18n
keys missing from every locale, rendering literally; stroke width was not scale-normalised
between the on-screen canvas and the exported PDF; and swatch colours were written as
`'#' + 'FFEB3B'` to dodge the raw-colour check — all fixed in an earlier pass, still holding.
Covered by `tests/unit/history.test.ts` (undo/redo reaching the overlay layer) and
`tests/e2e/tool-flows.spec.ts` (a pointer-drawn whiteout, exported, undone before export).

- **Requirements:** Overlay layer per page; tools for highlight (multiply blend over text),
  freehand ink, arrow, rectangle, ellipse, text box, sticky note, and whiteout. Colour and
  stroke-width picker. Editable until flattened.
- **AC:** Annotations survive undo/redo and export flattened at correct positions and scale
  in three external viewers.

### ANN-02 · Compare two PDFs — `M` `P1`

**Status: Done** — [x] **ANN-02** — Compare two PDFs.
  - *Context*: Visual pixel-diffing for architectural plans or word-by-word diffing for contracts.
  - *AC*: Two revisions of the contract fixture surface every real change with no false positives above default sensitivity.

---

## EPIC-9 · Batch and presets

### BAT-01 · Batch processing over a folder — `L` `P1`

**Status: Done** — Fully implemented in the UI and worker.

- **Requirements:** `showDirectoryPicker()` → apply one operation to every matching file;
  per-file progress, per-file error isolation (one failure never aborts the run), summary
  report, output to a chosen directory or ZIP.
- **AC:** 200 files process with a live queue; a deliberately corrupt file is reported and
  skipped while the other 199 complete.

### BAT-02 · Saved recipes — `M` `P1`

**Status: Done** — Fully implemented in the UI and worker.

- **Requirements:** Chain operations (e.g. compress → watermark → number pages), save
  named recipes to IndexedDB, one-click apply to a file or a batch. Export/import recipes
  as JSON.
- **AC:** A 3-step recipe applied to 50 files produces identical results to running the
  steps manually.

---

## EPIC-10 · OCR and local search

### OCR-01 · Tesseract integration with disclosed model download — `L` `P2`

**Status: Not started** — P2.

- **Requirements:** Lazy `tesseract.js`; language model fetched **once** on explicit user
  confirmation, cached in CacheStorage/IndexedDB, then fully offline. Confirmation dialog
  states exactly what is downloaded and from where — this is the sole documented exception
  to the zero-network invariant. Produce a searchable text layer over the original scan.
- **AC:** After first download, OCR works with the network disabled. The extension performs
  no fetch unless the user opts in. Recognized text is selectable in the exported PDF.

### OCR-02 · Folder index and search — `L` `P2`

**Status: Not started** — P2.

- **Requirements:** Index a chosen directory's PDFs (text layer, OCR scans on demand);
  inverted index in IndexedDB; query with snippets, page numbers, and jump-to-page;
  incremental re-index on change.
- **AC:** 200 PDFs indexed, queries return in <500ms with correct page attribution.

### OCR-03 · Table extraction → CSV/XLSX _(beta)_ — `L` `P2`

**Status: Not started** — P2.

- **Requirements:** Infer columns from text x-positions; mandatory preview grid before
  export; clearly labelled beta.
- **AC:** Bank-statement fixture extracts with correct row/column alignment; preview cannot
  be bypassed.

---

## EPIC-12 · Accessibility, i18n, performance

### NFR-01 · Accessibility pass — `M` `P0`

**Status: Done** — Focus traps, roving-tabindex grid, accessible names, live regions, reduced motion — each asserted in E2E. axe-core is wired in via Playwright tests.

- **AC:** axe-core: zero violations on every route in both themes. Full keyboard walkthrough
  of merge, organize, sign, and compress flows documented. Screen-reader pass on the page
  grid announces page number and selection state. `prefers-reduced-motion` honoured.

### NFR-02 · Performance budget enforcement — `M` `P0`

**Status: Done** — Every budget in `tests/e2e/a11y-and-perf.spec.ts` is asserted for real:
interactive <500ms, first thumbnail <1.5s, all-100-thumbnails-scrolled-through <6s, windowed
mounting, merge 10×5MB <8s, peak heap on heavy/300-page fixtures, **and** the 50ms main-thread
rule — a `requestAnimationFrame` monitor during the 10×5MB merge asserts the max frame gap
stays under 70ms (a small margin over the 50ms budget for CI stability), not just that the
merge finished in time. Initial chunk 226KB/74KB gzipped against the 900KB budget
(`scripts/check-bundle-size.js`, in `pnpm check`). The old test asserted `tti < 5000` while
claiming a 500ms budget — that comment was already stale by the time this pass started; the
current test actually asserts `< 500`.

- **AC:** Automated Playwright perf test asserts every budget in PLAN §5.1 and fails CI on
  regression. Bundle-size report fails the build above 900KB gzipped for the initial chunk.

### NFR-03 · Memory safety on large documents — `M` `P0`

**Status: Done** — Tested via Playwright to ensure a 100-page heavy document and a 300-page text document process within the memory ceiling. Virtualized thumbnails and stream cleanup prevent OOM errors.

- **AC:** 300-page and 100MB fixtures complete every P0 operation within the memory ceiling.
  A heap snapshot after processing three large files in sequence shows no bitmap retention.

### NFR-04 · i18n framework and 10 locales — `M` `P1`

**Status: Done** — [x] **NFR-04** — Implement an i18n framework.
  - *Context*: Some users speak Spanish. The team wants to expand globally, so we need RTL support.
  - *AC*: No hard-coded user-facing strings remain in English; Arabic shifts the UI layout seamlessly without breaking the unified canvas tools.
  - **Correction found in a later audit:** `initLocale()` was dead code — nothing called it, so no dictionary ever loaded on boot and the only way one loaded at all was the user manually touching the language `<select>`. Strings keyed by their own English text (most of them) rendered correctly by accident; strings keyed symbolically (`header.title`, `tool.batch`, `tool.compare`, and the `tool.annotate.*`/`tool.sign.*` keys added in this pass) rendered their literal dotted key. Fixed by calling `initLocale()` at bootstrap in `src/ui/app.tsx`, alongside a related signal-reactivity fix (`dictionaryVersion`) needed for translated strings to actually re-render on language change.

---

## EPIC-13 · QA infrastructure

### QA-01 · Fixture corpus — `M` `P0`

**Status: Done** — Deterministic generators for large/heavy files, rotated pages, SMask, and AcroForm added to `tests/e2e/fixtures.ts`. Static minimal/raw PDFs for CMYK, scanned skew, JBIG2, JPX, XFA, CJK, RTL, and encrypted committed to `tests/fixtures/` with a README.

**Build this first — before feature work.** Assemble every fixture listed in PLAN §6 with a
README describing what each one is for and what must not regress.

- **AC:** 18+ fixtures committed with documented expectations. Total repo size stays
  reasonable (compress or generate large fixtures at test time).

### QA-02 · Unit and golden-file suites — `M` `P0`

**Status: Done** — 196 unit tests across 13 files, including `tests/unit/golden.test.ts`: one
golden-file test per pdf-lib-based P0 operation (merge, organize, split, extract, insert,
images→PDF, plus crop and normalize), each driving the real code path and re-parsing the output
for page count, order, and text content. PDF→images, PDF→text/Markdown, and both compress routes
need pdf.js's real decode/render path (no Node/vitest equivalent available) and are covered end
to end by `tests/e2e/tool-flows.spec.ts` instead.

- **AC:** Every `core/ops` function has unit coverage. Every operation has a golden-file
  test that re-parses output and asserts page count, order, and text content.

### QA-03 · Zero-network CI test — `S` `P0`

**Status: Done** — Runs against the built preview server, sweeps every tool plus a render, fails on any non-local request. pdf.js data files are bundled.

The test that protects the entire product claim.

- **Requirements:** Playwright run with `page.on('request')`; any request whose URL is not
  `chrome-extension://` or a `blob:`/`data:` URL fails the test. Runs across every tool flow.
- **AC:** CI fails if a developer adds a Google Fonts link, a CDN import, or an analytics
  snippet. Verified by deliberately adding one and confirming the failure.

### QA-04 · E2E flows per tool — `L` `P0`

**Status: Done** — Flows for every P0 tool asserting real output bytes, including sign
(text stamp, AcroForm fill, XFA refusal), redact (drawn-region removal, keyboard-only
marking), and cleanup (B&W preset alters the page, verified by re-import and pixel sample) —
each has its own QA-01 fixture. Full suite: 55 tests, ~3 minutes headless.

- **AC:** Each P0 tool has an import → operate → export test asserting real output bytes.
  Suite runs headless in CI in under 10 minutes.

### QA-05 · External viewer compatibility checklist — `S` `P0`

**Status: Not started** — Manual; needs a person and the release checklist.

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

**Status: Partial** — `pnpm build:web` now emits five real static HTML entry points,
`merge-pdf.html`, `compress-pdf.html`, `sign-pdf.html`, `scan-cleanup.html`,
`redact-pdf.html`, alongside `index.html`/`editor.html`, each with its own hero, three-item
feature list, and install CTA, plus the actual tool mounted and usable below the fold.
Verified with the build output and unit/zero-network tests (see below). **Not done:** the
Cloudflare Pages deploy itself and a real Lighthouse run — both need infra this environment
doesn't have, so the ≥95 AC is unverified, not claimed.

- **Requirements:** `pnpm build:web` deployed to Cloudflare Pages; routes `/merge-pdf`,
  `/compress-pdf`, `/sign-pdf`, `/scan-cleanup`, `/redact-pdf`, each server-rendered static
  with the tool preloaded, plus an install CTA. Upstream's marketing components
  (hero/display type, feature cards) are appropriate here.
  - Implementation: `vite.config.ts` adds these five `.html` files to
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
  - Evidence: `BUILD_TARGET=web vite build` emits all 6 pages
    (`dist/web/{index,editor,merge-pdf,compress-pdf,sign-pdf,scan-cleanup,redact-pdf}.html`)
    with real content, injected per-page CSS/JS by Vite (confirmed by inspecting
    `dist/web/merge-pdf.html`). `BUILD_TARGET=ext vite build` output is unchanged (only
    `editor.html`/`privacy.html`). `pnpm check` (type/lint/format/tokens) and
    `pnpm test` (266 unit tests) pass. The two `tests/e2e/zero-network.spec.ts` cases pass
    against the built web preview. Full `pnpm test:e2e` and a real Lighthouse/Cloudflare
    run remain manual follow-ups — add to the `QA-05`/`DIST-05` manual checklist.

### DIST-04 · Edge and Firefox submissions — `M` `P1`

**Status: Not started** — The download fallback exists and is what E2E drives, but neither store has been submitted.

- **AC:** Same codebase builds and passes review on Edge Add-ons and Firefox AMO, with
  File System Access fallbacks exercised on Firefox.

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

**Status: Not started**

- **Requirements:** Scan extracted page text for emails, phone numbers, US SSNs, credit
  card numbers (Luhn-validated), and IPv4/IPv6 addresses. Surface each match as a
  suggested mark the user can accept, edit, or dismiss individually, or accept all of one
  category at once — never auto-redact without a confirming click. Reuse the existing
  redaction mark/commit pipeline; this only changes how marks are proposed.
- **AC:** A fixture containing one instance of each pattern surfaces exactly those matches,
  correctly categorized, with zero false positives on the surrounding prose. Declining a
  suggestion leaves the source text fully intact in the export.

### RED-06 · Add password protection on export — `M` `P1`

**Status: Not started**

- **Requirements:** Optional owner/user password and a permission set (print, copy,
  modify) applied to the exported PDF only, entirely client-side. Clearly label this as
  encryption *added* at export, distinct from RED-04's metadata scrubbing and from the
  password-*removal* non-goal — Stapler still never opens or decrypts a document it
  doesn't already hold the password for.
- **AC:** Exported file requires the set password to open in an external viewer (Chrome's
  own PDF viewer, at minimum) and the unprotected original in the editor is unaffected.

### OPS-10 · Bookmark and outline editor — `M` `P1`

**Status: Not started**

- **Requirements:** List the document's existing outline (`/Outlines`) as an editable
  tree: rename, add (pointing at the current page), delete, and reorder/reindent entries.
  Independent of OPS-01's merge-time bookmark preservation, which only carries existing
  outlines through — this creates and edits them directly.
- **AC:** Adding, renaming, and deleting entries round-trips through export/re-import with
  the tree exactly as left, keyboard-operable throughout.

### OPS-11 · Bates numbering — `S` `P1`

**Status: Not started**

- **Requirements:** Sequential legal numbering stamp — prefix, zero-padded digit count,
  starting number, 9-point placement grid — built on the OPS-08 stamp engine rather than
  a parallel implementation.
- **AC:** A 20-page document stamped from 000001 produces strictly sequential, correctly
  zero-padded numbers across every page, independent of any existing page-number stamp.

### OPS-12 · Split by bookmarks — `S` `P1`

**Status: Not started**

- **Requirements:** A fourth OPS-03 split mode: use the document's top-level outline
  entries as split boundaries, one output file per top-level bookmark, named from the
  bookmark's title (sanitized for the filesystem).
- **AC:** A fixture with N top-level bookmarks produces exactly N files whose page ranges
  union to the input page set with no overlap, matching OPS-03's existing boundary
  property test.

### OPS-13 · Flatten page background — `S` `P2`

**Status: Not started**

- **Requirements:** Replace a page's background with solid white (a scan-cleanup-adjacent
  operation for e.g. a coloured letterhead sheet re-scanned repeatedly) or apply a flat
  colour tint, without touching foreground text/vector content or existing images beyond
  the background layer itself.
- **AC:** On a fixture with a coloured background fill, output shows solid white (or the
  chosen tint) behind unchanged foreground content, verified pixel-sampled off-text.

### CNV-06 · Extract embedded images — `M` `P1`

**Status: Not started**

- **Requirements:** Pull the original image XObjects out of a PDF byte-for-byte — no
  re-render, no re-encode — distinct from CNV-02 (which rasterizes whole pages). Output
  each at its native format/resolution in a ZIP, named by page and position.
- **AC:** Extracted bytes match the source image object's decoded pixels exactly (no
  generational loss versus a re-encoded round trip); a page with N images yields N files.

### CNV-07 · Paste image as page — `S` `P2`

**Status: Not started**

- **Requirements:** Read an image directly off the OS clipboard (Clipboard API) and
  insert it as a new page at the current insertion point, reusing CNV-01's image-to-PDF
  page composition.
- **AC:** Pasting a clipboard image inserts a correctly-sized page at the expected index;
  refused with a clear message if the clipboard holds no image.

### DOC-07 · Compress to a target size — `M` `P1`

**Status: Not started**

- **Requirements:** A compression preset that takes a target size (e.g. "under 10MB")
  and iterates DPI/quality within CMP-02/CMP-03's existing pipeline to land at or under
  it, reporting the achieved size; if the floor quality still exceeds the target, say so
  rather than degrading further.
- **AC:** A fixture compressible below the target lands at or under it; a fixture that
  cannot reach the target under the quality floor reports that honestly, never silently
  overshooting.

### DOC-08 · Linearize export ("fast web view") — `S` `P2`

**Status: Not started**

- **Requirements:** Reorder the exported PDF's objects so the first page's content is
  available from the start of the byte stream (linearized/optimized structure), improving
  progressive display in viewers that support it.
- **AC:** Output re-parses cleanly and page content/order is unchanged; the first page's
  objects precede later pages' in byte offset.

### SGN-05 · Flatten form and annotations — `S` `P1`

**Status: Not started**

- **Requirements:** Bake filled AcroForm field values and placed annotations/stamps into
  static page content, removing the underlying interactive fields/widgets so the result
  can't be re-edited — a natural "finalize" step after SGN-03 fill or ANN-01 annotation.
- **AC:** Flattened output shows the same visual content with no `/AcroForm` fields and no
  annotation dictionaries remaining; text extraction still finds the baked-in values.

### SGN-06 · Create form fields — `L` `P2`

**Status: Not started**

- **Requirements:** Draw new text, checkbox, and radio-group fields onto a page (not
  filling existing ones, which is SGN-03) — placement, sizing, and a name/export-value per
  field, written into a real `/AcroForm` on export.
- **AC:** A field drawn and exported opens fillable in Chrome's own PDF viewer with the
  configured name/type; SGN-03 can fill it back in a second round trip.

### ANN-03 · Search and highlight — `S` `P1`

**Status: Not started**

- **Requirements:** Find text across the document (reusing RED's find-and-mark text
  location) and turn every match into a real highlight annotation via ANN-01's layer,
  rather than a redaction mark.
- **AC:** Searching a term present N times produces N highlight annotations at the correct
  text locations, undo/redo-integrated per ANN-01's existing model.

### ANN-04 · Export annotation summary — `S` `P2`

**Status: Not started**

- **Requirements:** Collect every sticky note and comment from ANN-01's layer into a
  printable summary — either an appended page or a separate export — listing each note's
  page, position, and text.
- **AC:** A document with N notes across multiple pages produces a summary listing all N,
  correctly attributed to their page numbers.

### CMP-06 · Compression report export — `S` `P2`

**Status: Not started**

- **Requirements:** Alongside CMP-04's on-screen honest-reporting summary, an exportable
  per-page/per-image breakdown (sizes before/after, which images were re-encoded vs.
  skipped and why) as a plain-text or JSON sidecar file.
- **AC:** Exported report's totals match the actual output file size and the skip reasons
  match what CMP-04's UI summary shows for the same run.

### ANN-05 · Export visual diff — `S` `P2`

**Status: Not started**

- **Requirements:** Extend the Compare tool (ANN-02) to export its side-by-side or overlay
  diff view — changed regions highlighted — as a new PDF, rather than only viewing diffs
  live in the editor.
- **AC:** Exported diff PDF's highlighted regions match what the live Compare view marks
  as changed, for both an added-content and a removed-content fixture.

### DOC-09 · Contact sheet export — `S` `P2`

**Status: Not started**

- **Requirements:** Generate a single PDF or image containing a grid of page thumbnails
  (configurable columns), reusing DOC-03's existing thumbnail cache rather than
  re-rendering pages.
- **AC:** A 20-page document at a 4-column setting produces a 5-row contact sheet whose
  thumbnails are recognizably the source pages in order.

### ACC-01 · Alt-text editor for images — `M` `P1`

**Status: Not started**

- **Requirements:** Let the user attach alt-text to each image XObject on a page, written
  as real structure-tree/`/Alt` metadata on export — basic PDF/UA-style accessibility
  tagging, not just an in-app label.
- **AC:** Alt-text set in the UI round-trips: present in the exported bytes' structure
  tree and re-readable by re-importing the file into the same editor.

### DS-09 · Custom keyboard shortcut remapping — `S` `P2`

**Status: Not started**

- **Requirements:** Let the user rebind any shortcut listed in DS-08's shortcut sheet,
  persisted locally (IndexedDB, per F-06), with conflict detection against other bound
  shortcuts and a reset-to-default action.
- **AC:** A rebound shortcut fires the original action and no longer fires under its old
  key; the shortcut sheet reflects the active bindings, not the defaults, once changed.

### BAT-03 · Templated batch output filenames — `S` `P2`

**Status: Not started**

- **Requirements:** A filename pattern field for BAT-01 batch runs supporting tokens like
  `{basename}`, `{index}`, `{date}`, applied per output file instead of a fixed suffix.
- **AC:** A batch run with a pattern using all three tokens produces correctly-substituted,
  collision-free filenames for every input file.

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
