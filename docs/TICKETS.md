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

**Status: Done** — Re-verified against the real corpus, not against intent.

- **AC, first half — every fixture imports or gets its specific, accurate explanation:** proven by a sweep over the whole corpus, `tests/e2e/import.spec.ts` › "every PDF in the corpus imports or is refused with a specific reason". It reads `tests/fixtures/*.pdf` off disk (41 files on the last run), imports each through the real file input, and requires every refusal to match one of the pipeline's own sentences — a generic "something went wrong" fails the test. Result: 35 imported (including `xfa.pdf`, `jbig2.pdf`, `jpx.pdf`, `cjk.pdf`, `rtl.pdf`, `cmyk*.pdf`, `heavy.pdf`, `text-300.pdf`); 6 refused — `encrypted.pdf` ("requires a password"), `not-a-pdf.pdf` ("does not start with a PDF header"), and four truncation shapes ("its structure is invalid or truncated").
- **AC, second half — a truncated PDF never crashes the tab:** the pre-existing coverage used `not-a-pdf.pdf`, which is refused by the header check and never reaches pdf.js, so the truncated path was untested and `corruptPdf()` in `tests/e2e/fixtures.ts` was dead code. Now covered three ways (tail-truncated, mid-body, header-only) with a `pageerror` listener asserting no uncaught error, and with a good file imported afterwards in the same tab to prove it still works.
- **Formats:** PNG, JPEG, WebP, TIFF and HEIC each import through the real pipeline from a real fixture (`sample.png`, `tiny.jpg`, `sample.webp`, `sample.tiff`, `sample.heic`), and three at once become one three-page PDF whose bytes re-parse.
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

**Status: Done** — Order and rotation asserted on real bytes. Save-over-original is
offered in the UI (asks explicitly on every commit for a document opened from one writable
file). The full export pipeline is now verified by `tests/unit/export-pipeline.test.ts`
(14 tests: pdf-lib round-trip, compose-path, sanitizeFileStem, splitBoundaries — all
passing). Save-over-original via the native file-picker is the one step Playwright cannot
drive; it is covered in QA-05's manual checklist in `RELEASE_CHECKLIST.md` §1.

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

**Status: Done** — Merged via `worktree-agent-aa5957858ee912aab`. Lazy `tesseract.js` with user-confirmed model download, cached offline in CacheStorage/IndexedDB. Searchable text layer produced over the original scan.

- **Requirements:** Lazy `tesseract.js`; language model fetched **once** on explicit user
  confirmation, cached in CacheStorage/IndexedDB, then fully offline. Confirmation dialog
  states exactly what is downloaded and from where — this is the sole documented exception
  to the zero-network invariant. Produce a searchable text layer over the original scan.
- **AC:** After first download, OCR works with the network disabled. The extension performs
  no fetch unless the user opts in. Recognized text is selectable in the exported PDF.

### OCR-02 · Folder index and search — `L` `P2`

**Status: Done** — `indexDirectory` / `searchFolderIndex` in
`src/core/ocr/folder-index.ts`. Inverted-index in IndexedDB (`searchIndex` store in
`src/core/db.ts`); tokenises text and OCR layers; serves keyword queries with snippets,
page numbers, and jump-to-page in < 500 ms. Incremental re-index skips unchanged
files via `lastModified` hash. FolderSearchPanel UI wired into OcrPanel tab.

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

**Status: Done** — 610 unit tests across 56 files, including `tests/unit/golden.test.ts`: one
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

**Status: Done** — `pnpm build:web` now emits five real static HTML entry points,
and all six landing pages (index + 5 tool pages) serve HTTP 200 from `vite preview`.
Lighthouse scores measured locally against `http://localhost:4173` (2026-08-16):

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
  password-*removal* non-goal — Stapler still never opens or decrypts a document it
  doesn't already hold the password for.
- **AC:** Exported file requires the set password to open in an external viewer (Chrome's
  own PDF viewer, at minimum) and the unprotected original in the editor is unaffected.

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

**Status: Done**

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
- Encrypted input is refused with the standard message — its streams are ciphertext, so
  "extracting" them would write files full of noise. Nothing is written when nothing could
  be extracted: an empty ZIP would read as a successful export of nothing.

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

**Status: Done**

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

**Status: Done**

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

**Status: Done** — `generateCompressionReportText` and JSON export breakdown in `src/core/compress-report.ts`. Tested in `tests/unit/compress-report.test.ts`.

- **Requirements:** Alongside CMP-04's on-screen honest-reporting summary, an exportable
  per-page/per-image breakdown (sizes before/after, which images were re-encoded vs.
  skipped and why) as a plain-text or JSON sidecar file.
- **AC:** Exported report's totals match the actual output file size and the skip reasons
  match what CMP-04's UI summary shows for the same run.

### ANN-05 · Export visual diff — `S` `P2`

**Status: Done** — `exportVisualDiff` in `src/core/visual-diff-export.ts` renders visual diff overlays into PDF. Tested in `tests/unit/visual-diff-export.test.ts`.

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

**Status: Done**

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

**Status: Done** — A new `read-aloud` tool (`src/ui/tools/read-aloud/`), grid canvas mode
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

**Status: Done, with the logo half deliberately narrowed — see "Scope narrowed" below.**

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
  and no others; declining the model download leaves the tool disabled with a clear
  message, never a silent no-op on export.

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

**Status: Done** — A new `exportRedlinePdf` (`src/core/redline-export.ts`), wired in as a
third `diffMode` alongside ANN-05's `'visual'`/`'text'` in `compare-export.ts`'s existing
dispatcher and `ComparePanel.tsx`'s `RadioGroup`. Each source page is rasterised once
(`renderAllPages` loads the whole document a single time rather than once per page, unlike
`exportVisualDiff`'s per-page load) and drawn into its own output PDF page next to its
counterpart, "Before"/"After" labelled, rather than merged into one overlay image the way
ANN-05 does.

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

- **Requirements:** Persist enough session state to F-06's IndexedDB layer to reopen the
  editor after a crash or accidental reload and resume the in-progress document and undo
  stack, with an explicit prompt to restore or discard rather than silent resumption.
- **AC:** Killing the tab mid-edit and reopening the editor offers to restore the exact
  prior document state and undo stack; declining starts a clean session with the
  recovery record cleared, not retried on the next launch.

### DOC-12 · Font-embedding checker — `S` `P2`

**Status: Done, with "any matching locally-available system font" deliberately narrowed**
**— see below.** `checkFontEmbedding` in `src/core/workers/process.worker.ts` walks every
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

**Status: Not started.**

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

**Status: Not started.** Generalizes OCR-03's table→XLSX writer (`table-extract.ts`,
`docs/TICKETS.md:795`) — that ticket only ran on OCR'd scan output; this one runs the
same column-position-clustering heuristic over a PDF's real, selectable text layer,
covering ordinary (non-scanned) PDFs with tabular or columnar content.

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

**Status: Not started.**

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

**Status: Not started.** The most novel surface of the six — no existing reader
precedent in the codebase for the source direction, since PDF→PPTX still starts from
pdf.js's existing page/text/image extraction, same as CNV-08.

- **Requirements:** One slide per PDF page: page rendered/extracted content (text
  blocks by position, embedded images) placed onto a same-size slide via `pptxgenjs`
  (lazy-loaded). Exact PDF layout is approximated as positioned text boxes and images,
  not editable rich text reflow — this is the widest fidelity gap of the six tickets
  and must say so plainly in the beta copy.
- **AC:** A multi-page fixture produces a `.pptx` with one slide per page, opens in
  PowerPoint/LibreOffice Impress, and each slide's extracted text (via a round-trip
  through `pptx-reader.ts`) matches the source page's text content. Beta label and
  mandatory preview appear before save.

### CNV-13 · PowerPoint (PPTX) → PDF — `L` `P2`

**Status: Not started.**

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
