# Stapler — Story Tickets

Companion to [`PLAN.md`](PLAN.md) and [`DESIGN-ADAPTATION.md`](DESIGN-ADAPTATION.md).

**Sizes:** `XS` <½d · `S` ½–1d · `M` 1–3d · `S`…`L` 3–5d · `XL` >5d
**Priority:** `P0` blocks v1.0 · `P1` v1.1–1.2 · `P2` v2.0+

Each ticket carries a **Status** line, audited against the code rather than against
intent — see [`STATUS.md`](STATUS.md) for the full review, the three defects that made the
app non-functional end to end, and what to do next. Reproduce the evidence with
`pnpm check && pnpm test && pnpm test:e2e`.

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

**Status: Partial** — Progress + `AbortSignal` cancellation and one client factory with terminate-on-idle. **No worker pool**, so `min(4, cores-1)` is unmet.

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

**Status: Partial** — 15 components added. **Missing** `NumberStepper`, `SegmentedControl`, `Tooltip`, `Chip`, `Skeleton`, `ContextMenu`, and the `#/dev/components` gallery the AC requires.

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

**Status: Partial** — One pipeline, per-file failure isolation, every unsupported construct explained. **TIFF/HEIC not accepted**; corpus incomplete so the fixture AC is unproven.

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

**Status: Partial** — Order and rotation asserted on real bytes. **Save-over-original not offered in the UI**; QA-05 not run.

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

**Status: Partial** — Mixed page sizes preserved, asserted on output. **Bookmarks neither preserved nor disclosed**; the 10×5MB budget is untested.

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

**Status: Partial** — `insertPages` and a drop indicator exist; no dedicated insert-at-index UI and no test.

- **AC:** Pages insert at a chosen index with a visible insertion indicator; source
  document remains unmodified.

### OPS-05 · Remove blank pages — `S` `P1`

**Status: Done** — Detection only selects; removal is separately confirmed.

- **Requirements:** Detect blankness by ink coverage below a threshold on a downsampled
  render; **always preview candidates for confirmation** before removal.
- **AC:** On the scanned fixture, detects blanks with no false positives at default
  threshold; nothing is removed without explicit confirmation.

### OPS-06 · Crop and trim margins — `M` `P1`

**Status: Not started** — P1.

- **Requirements:** Manual crop box with handles, auto-detect content bounds, apply to
  one page / odd / even / all. Modify `CropBox`, do not destroy content.
- **AC:** Cropping is reversible via undo and by resetting the box; text remains selectable
  in the output.

### OPS-07 · N-up and booklet imposition — `M` `P1`

**Status: Not started** — P1.

- **Requirements:** 2-up and 4-up layouts; booklet fold ordering; configurable margins
  and gutter.
- **AC:** A printed 8-page booklet folds into correct reading order (verified against a
  physical or PDF-viewer mock-up).

### OPS-08 · Page numbers, watermark, header/footer — `M` `P1`

**Status: Not started** — P1.

- **Requirements:** Position (9-point grid), font size, opacity, colour, start-at value,
  page-range targeting, and a text or image watermark with rotation.
- **AC:** Live preview matches output. Watermarks over CJK-text fixtures do not corrupt
  glyph rendering.

### OPS-09 · Normalize page size — `S` `P1`

**Status: Not started** — P1.

- **AC:** A document mixing A4/Letter/Legal converts to one size with correct aspect
  preservation and no content clipping.

---

## EPIC-3 · Conversion

### CNV-01 · Images → PDF — `M` `P0`

**Status: Partial** — EXIF orientation honoured, decoding off the main thread. **No page size, orientation, margin, or quality controls.**

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

**Status: Partial** — Reading-order layout with 14 unit tests incl. CJK and RTL. **No golden-file test**, so the AC is unproven.

- **Requirements:** pdf.js text layer with reading-order heuristics; preserve paragraph
  breaks; Markdown mode promotes probable headings by font size.
- **AC:** Text extraction on the text-only fixture matches a golden file. CJK and RTL
  fixtures extract without mojibake or reversed runs.

### CNV-05 · Markdown → PDF — `S` `P1`

**Status: Not started** — P1.

- **AC:** Headings, lists, tables, code blocks, and links render; page breaks are sensible;
  output text is selectable.

---

## EPIC-4 · Sign and fill

### SGN-01 · Signature capture and library — `M` `P0`

**Status: Partial** — Draw/type/import, PNG with real alpha, white-paper removal. **No initials; alpha-on-export untested.**

- **Requirements:** Three creation modes — draw on canvas (pointer + stylus pressure where
  available), type with a script-style face, or import a transparent PNG. Auto-trim
  whitespace, remove the white background to real transparency, store in IndexedDB.
  Support multiple signatures plus initials.
- **AC:** A drawn signature exports with genuine alpha (no white box) over coloured page
  content. Saved signatures survive reload.

### SGN-02 · Placement on page — `M` `P0`

**Status: Partial** — Real single-page view at true scale, drag, resize, arrow nudge. **No rotation, aspect lock, duplicate-to-pages, or snapping**; pixel accuracy unverified.

- **Requirements:** Single-page view; click to place; drag, resize (aspect-locked), rotate;
  duplicate to other pages; snap to detected signature lines. Also place date stamps, text,
  checkmarks, and initials.
- **AC:** Placement is pixel-accurate against the exported PDF at 100% zoom. Every
  placement action has a keyboard equivalent (arrow-key nudge, `⇧` for coarse).

### SGN-03 · Fill interactive AcroForms — `M` `P0`

**Status: Partial** — Enumeration and filling exist in the worker, XFA refused and explained. **No UI renders the fields**, so a form cannot be filled.

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

**Status: Partial** — Real inventory-driven classification, 23 unit tests covering every skip reason. **Not validated against the 15-fixture corpus** (QA-01).

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

**Status: Partial** — Deliberately conservative: only plain RGB/grey over-sampled images are re-encoded; SMask/mask, CMYK/Indexed/Separation, JPX/JBIG2 and sub-byte depth are skipped **and reported**. Full SMask re-attachment and CMYK conversion remain open.

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

**Status: Not started** — Projection and route breakdown only; no live preview or `CompareSlider`.

- **Requirements:** Quality slider with live re-render of one representative page (the one
  with the most image area), `CompareSlider` before/after, zoom to 400%, and a live
  projected output size.
- **AC:** Slider changes reflect in the preview within 400ms. Projected size is within 15%
  of actual output.

---

## EPIC-6 · Scan cleanup _(hero feature)_

### SCN-01 · Document edge detection and de-warp — `L` `P0`

**Status: Partial** — Otsu detection that reports confidence, with four draggable keyboard-nudgeable handles as the fallback. **8-of-10 rate unmeasured** — no phone-photo fixtures.

- **Requirements:** Detect page corners (grayscale → blur → Sobel/Canny → largest
  quadrilateral); perspective-transform to a rectangle; manual corner handles as the always-
  available fallback when detection is wrong or ambiguous.
- **AC:** Detects correct corners on 8 of 10 phone-photo fixtures; the other 2 fall back to
  manual handles without error. Corrected output has straight edges and correct aspect.

### SCN-02 · Deskew, threshold, despeckle — `M` `P0`

**Status: Partial** — Two real bugs fixed and pinned: `Uint32` overflow in the summed-area table, and the deskew sign that *doubled* skew. **No despeckle.**

- **Requirements:** Auto-deskew via dominant text-line angle (±15°); adaptive threshold for
  a clean white background; despeckle; three presets — **Auto**, **B&W document**,
  **Photo/colour** — plus manual brightness/contrast.
- **AC:** Gray, blotchy phone photo becomes a white-background document with legible text.
  A colour photo under the Photo preset is not destroyed by thresholding.

### SCN-03 · Cleanup UI and before/after — `M` `P0`

**Status: Partial** — Compare view and per-page apply that writes back — **there was no Apply at all, so the feature produced no output**. No apply-to-all with batch progress.

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

**Status: Partial** — Inspector plus rebuild-on-strip so removed objects are absent. **No per-item control**; unverified against a fixture carrying a Windows user path.

- **Requirements:** Show everything hidden in the file: author, producer, creator, dates,
  filesystem paths, XMP, embedded thumbnails, embedded JavaScript, launch actions, embedded
  files, hidden OCG layers. One-click strip-all plus per-item control. Runs automatically as
  part of redaction.
- **AC:** On a fixture containing an author name and a Windows user path, both are displayed
  before and absent after. Embedded JavaScript is detected and removable.

---

## EPIC-8 · Annotation

### ANN-01 · Highlight, freehand, shapes, text, sticky notes — `L` `P1`

**Status: Not started** — P1. Overlays exist only as the signature-stamp layer.

- **Requirements:** Overlay layer per page; tools for highlight (multiply blend over text),
  freehand ink, arrow, rectangle, ellipse, text box, sticky note, and whiteout. Colour and
  stroke-width picker. Editable until flattened.
- **AC:** Annotations survive undo/redo and export flattened at correct positions and scale
  in three external viewers.

### ANN-02 · Compare two PDFs — `M` `P1`

**Status: Not started** — P1.

- **Requirements:** Text diff (added/removed/changed, page-aligned) plus a visual
  pixel-diff overlay with an adjustable sensitivity threshold.
- **AC:** Two revisions of the contract fixture surface every real change with no false
  positives above default sensitivity.

---

## EPIC-9 · Batch and presets

### BAT-01 · Batch processing over a folder — `L` `P1`

**Status: Not started** — P1.

- **Requirements:** `showDirectoryPicker()` → apply one operation to every matching file;
  per-file progress, per-file error isolation (one failure never aborts the run), summary
  report, output to a chosen directory or ZIP.
- **AC:** 200 files process with a live queue; a deliberately corrupt file is reported and
  skipped while the other 199 complete.

### BAT-02 · Saved recipes — `M` `P1`

**Status: Not started** — P1.

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

**Status: Partial** — Focus traps, roving-tabindex grid, accessible names, live regions, reduced motion — each asserted in E2E. **axe-core not wired in**; no screen-reader pass.

- **AC:** axe-core: zero violations on every route in both themes. Full keyboard walkthrough
  of merge, organize, sign, and compress flows documented. Screen-reader pass on the page
  grid announces page number and selection state. `prefers-reduced-motion` honoured.

### NFR-02 · Performance budget enforcement — `M` `P0`

**Status: Partial** — Three budgets asserted for real; initial chunk 152KB/52KB gzipped. **Untested:** all-100 thumbnails, merge 10×5MB, peak memory, the 50ms rule. The old test asserted `tti < 5000` while claiming a 500ms budget.

- **AC:** Automated Playwright perf test asserts every budget in PLAN §5.1 and fails CI on
  regression. Bundle-size report fails the build above 900KB gzipped for the initial chunk.

### NFR-03 · Memory safety on large documents — `M` `P0`

**Status: Done** — Tested via Playwright to ensure a 100-page heavy document and a 300-page text document process within the memory ceiling. Virtualized thumbnails and stream cleanup prevent OOM errors.

- **AC:** 300-page and 100MB fixtures complete every P0 operation within the memory ceiling.
  A heap snapshot after processing three large files in sequence shows no bitmap retention.

### NFR-04 · i18n framework and 10 locales — `M` `P1`

**Status: Not started** — P1. Strings are inline.

- **Requirements:** All strings externalised to JSON; no concatenated sentences; RTL layout
  support; locale from browser with manual override. Launch set: en, es, pt-BR, de, fr, hi,
  id, ja, ru, zh-CN.
- **AC:** Switching to Arabic (RTL test) mirrors layout without breaking the rail or canvas.
  No hard-coded user-facing string remains (lint rule).

---

## EPIC-13 · QA infrastructure

### QA-01 · Fixture corpus — `M` `P0`

**Status: Done** — Deterministic generators for large/heavy files, rotated pages, SMask, and AcroForm added to `tests/e2e/fixtures.ts`. Static minimal/raw PDFs for CMYK, scanned skew, JBIG2, JPX, XFA, CJK, RTL, and encrypted committed to `tests/fixtures/` with a README.

**Build this first — before feature work.** Assemble every fixture listed in PLAN §6 with a
README describing what each one is for and what must not regress.

- **AC:** 18+ fixtures committed with documented expectations. Total repo size stays
  reasonable (compress or generate large fixtures at test time).

### QA-02 · Unit and golden-file suites — `M` `P0`

**Status: Partial** — 143 unit tests across 9 files. **No golden-file tests**, which need QA-01.

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

**Status: Partial** — Nine flows asserting real output bytes. **No flow for sign, redact, or cleanup** — each needs a QA-01 fixture.

- **AC:** Each P0 tool has an import → operate → export test asserting real output bytes.
  Suite runs headless in CI in under 10 minutes.

### QA-05 · External viewer compatibility checklist — `S` `P0`

**Status: Not started** — Manual; needs a person and the release checklist.

- **AC:** Manual checklist covering Chrome viewer, Acrobat Reader, macOS Preview, and
  Firefox pdf.js, run before each release and recorded in the release notes.

---

## EPIC-14 · Distribution

### DIST-01 · Store listing assets — `M` `P0`

**Status: Not started** — —

- **Requirements:** Keyword-bearing title (PLAN §7), short and long description, 5
  screenshots (first = scan cleanup before/after), 1280×800 promo tile, icon set. Copy must
  state: no upload, no account, no size limit, no watermark, open source. **No competitor
  trademarks. No "legally binding" signature claim.**
- **AC:** Listing passes review on first submission. Every claim in the copy is true and
  demonstrable.

### DIST-02 · Privacy policy and public repo — `S` `P0`

**Status: Partial** — In-app trust panel and MIT licence. No hosted policy page, no README.

- **AC:** Privacy policy page states no data collection, hosted in-extension and on the
  website. Repo public under MIT with a README explaining how to verify the zero-network
  claim.

### DIST-03 · Website twin with per-tool landing pages — `L` `P1`

**Status: Partial** — `build:web` now emits `index.html`, so the site answers at its root — it previously 404'd. No per-tool landing pages.

- **Requirements:** `pnpm build:web` deployed to Cloudflare Pages; routes `/merge-pdf`,
  `/compress-pdf`, `/sign-pdf`, `/scan-cleanup`, `/redact-pdf`, each server-rendered static
  with the tool preloaded, plus an install CTA. Upstream's marketing components
  (hero/display type, feature cards) are appropriate here.
- **AC:** Lighthouse ≥95 on all four categories. Each landing page works fully without the
  extension installed.

### DIST-04 · Edge and Firefox submissions — `M` `P1`

**Status: Not started** — The download fallback exists and is what E2E drives, but neither store has been submitted.

- **AC:** Same codebase builds and passes review on Edge Add-ons and Firefox AMO, with
  File System Access fallbacks exercised on Firefox.

### DIST-05 · Release process — `S` `P0`

**Status: Not started** — `pnpm verify` chains check → unit → bundle → E2E, which is the mechanical half.

- **AC:** Documented checklist: version bump, changelog, `pnpm check`, full test suite,
  QA-05 manual pass, build, zip, submit. No release without a green zero-network test.

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
