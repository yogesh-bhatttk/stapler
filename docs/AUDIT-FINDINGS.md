# Audit findings — open issues (2026-08-16)

Bugs, gaps, and missing implementation found in a full-repo audit against
`docs/TICKETS.md`, verified against real output bytes rather than ticket `Status` lines.
Pure punch list — things to implement/fix. Ticket `Status` lines in `docs/TICKETS.md` are
unchanged; update them per-ticket as each item below is closed.

Severity: **Critical** (silent data loss / security-relevant / core promise broken),
**High** (wrong output or broken UX on a real path), **Medium** (real but narrower gap).

---

## 0 — Structural: same bug in three places

- [ ] **[Critical] Rebuild-via-copyPages silently strips the document catalog.**
  Redaction and compression both rebuild output as `PDFDocument.create()` + `copyPages` +
  `reattachAcroForm` only, dropping `/Outlines`, `/StructTreeRoot`, `/OCProperties`,
  `/PageLabels`, `/Names`. Verified on `tests/fixtures/bookmarked-9.pdf`: `/Outlines`
  present in input, gone from output on both paths. Bookmarks, accessibility structure,
  optional-content layers, named destinations all silently vanish.
  RED-04 already fixed this exact problem in `scrubMetadata` via a shared
  `PDFObjectCopier` — apply the same fix here.
  `src/core/workers/process.worker.ts:4112` (redact), `:3596` (compress)

- [ ] **[High] Base export path never dedupes shared objects across pages.**
  `composePages` calls pdf-lib's `copyPages` once per page in a loop; pdf-lib builds a
  fresh `PDFObjectCopier` per call, so a logo/font shared across ten pages is copied ten
  times. Same defect already fixed in the compress rebuild path
  (`process.worker.ts:3597-3600`) but never carried to the main export path every other
  tool calls first.
  `src/core/workers/process.worker.ts:1708`

---

## 1 — Redaction (RED-01..06)

- [ ] **[Critical] Vector content under a redacted region is never removed, only covered.**
  `filterContentStream` strips text-showing operators and `Do` only; path
  construction/painting (`m l c re S f B`) passes through untouched. A signature drawn as a
  stroke, a logo, a chart, a stamp: none of it is redacted.
  `src/core/pdf/interpreter.ts:306-478`

- [ ] **[Critical] Verification gate only checks text.**
  RED-03's "render each region and check for residual content" is actually "read
  `getTextContent()` and check for residual glyphs" — nothing renders a region to pixels,
  nothing inspects image content. Combined with the item above, the gate passes files that
  still contain the content it's meant to catch.
  `src/core/operations.ts:740-788`, `src/core/workers/render.worker.ts:605-651`

- [ ] **[Critical] A redacted image region deletes the entire image, not the region.**
  Any XObject whose bbox intersects a redaction region is removed wholesale — no clip or
  re-encode of just the affected area. Reproduced: one full-page scan, 5%×5% corner
  redaction → entire scan gone, blank page with a small black box.
  `src/core/pdf/interpreter.ts:460-471`, `src/core/workers/process.worker.ts:4304-4380`
  (test at `tests/unit/process.test.ts:343-379` currently asserts this as intended — needs
  updating once fixed)

- [ ] **[High] Inherited page rotation invisible to the redaction pipeline.**
  `copied.node.get(PDFName.of('Rotate'))` is non-inheritable; a `/Rotate` on the `/Pages`
  node returns `undefined` here while pdf-lib's `getRotation()` and pdf.js's viewport both
  see it. Regions map to the wrong quadrant on such pages.
  `src/core/workers/process.worker.ts:4134`

- [ ] **[High] Content-stream filtering is exponential in `q` nesting depth.**
  Every `q` deep-clones the whole state stack (T(d) = 2^d). Measured: depth 22 → 1.7s,
  depth 30 ≈ 7 min, depth 34 ≈ 2 hours. Illustrator/CAD/map exports nest this deep
  routinely; cancellation only checks per page, so this hangs uninterruptibly.
  `src/core/pdf/interpreter.ts:204-215, 320`

- [ ] **[Medium] Text width is a fixed 0.6em guess and also drives position.**
  `estimatedWidth = textStr.length * fontSize * 0.6` from raw bytes (double-counts 2-byte
  CID fonts), fed back into the text matrix so error compounds across a BT/ET block.
  `Tz`/`Tc`/`Tw` and TJ kerning aren't modeled.
  `src/core/pdf/interpreter.ts:389, 402-403`

- [ ] **[Medium] Find-and-mark can't match text split across runs.**
  Matches per text run, not per concatenated page text — a kerning break or style change
  hides an occurrence.
  `src/core/workers/render.worker.ts:409-435`

- [ ] **[Medium] Redaction success message is dead code / always wrong.**
  Reports `rasterizedPages` in the success copy; the variable is hardcoded `[]`, so the UI
  always prints "Pages&nbsp; are now images" with no pages named.
  `src/ui/tools/commit.ts:692`, `src/ui/tools/redact/VerificationReport.tsx:29`

- [ ] **[Gap] No test covers:** an image under a region, a vector shape under a region,
  page rotation, or the "content outside the region is byte-identical" half of RED-02's AC.
  `tests/unit/process.test.ts:269-296` only checks that output bytes differ and are
  nonzero length.

---

## 2 — Compression (CMP-01..06)

- [ ] **[Critical] Safety-image skip list is computed, then ignored on the raster route.**
  Unsafe images (Separation ink, JBIG2/JPX, colour-key mask, soft mask) are correctly added
  to `plan.skipped` — then any textless page is routed to full-page raster re-encode
  *without consulting that list*. Reproduced: textless page with a `/Separation` image gets
  flattened to RGB JPEG (ink plate destroyed) while the report claims it was untouched.
  `src/core/compress-plan.ts:264, 280-296` (untested branch: `tests/unit/compress-plan.test.ts:85-105`
  only covers text-heavy pages)

- [ ] **[High] A zero-work compression run can still report savings.**
  Because of item 0 above, `rebuildCompressed(bytes, {}, {})` with no image work still
  returns `keptOriginal: false` — the "savings" are just the dropped catalog entries.
  `src/core/workers/process.worker.ts:3596, 3627`

- [ ] **[High] Exported compression report can present an estimate as a measurement.**
  When no compression run has happened, the panel falls back to `report.estimatedBytes` /
  `report.alreadyOptimized` and prints it under literal "Compressed Size:" / "Saved: N
  bytes" labels.
  `src/ui/tools/compress/CompressPanel.tsx:110-113`, `src/core/compress-report.ts:167-172`

- [ ] **[Medium] "Encoded once" is only true of storage, not of encoding work.**
  A logo repeated across ten pages is decoded/downscaled/JPEG-encoded ten separate times;
  only the largest result is kept.
  `src/core/operations.ts:424-434, 462-481`

- [ ] **[Medium] Per-image before/after sizes never populated; memory budget unverified.**
  `imageStats` is never populated by any real caller, so CMP-06's JSON sidecar is
  effectively always empty. Memory perf test samples main-thread `performance.memory`,
  which doesn't see the worker heap where re-encoded pages actually accumulate.
  `src/core/compress-report.ts:17-19, 96-101, 216`, `src/core/operations.ts:420, 449`

---

## 3 — Rotation & coordinate geometry (one root cause, five tools)

- [ ] **[High] Crop, watermark, header/footer and Bates all place content in the wrong
  frame on a rotated page.** Only the signature-stamp path does the inverse-rotation
  mapping correctly; the rest write against the raw MediaBox while the UI overlay is drawn
  against the rotation-aware viewport. Reproduced on a `/Rotate 90` page: crop takes the
  wrong half, watermark renders sideways in the wrong corner, Bates stamp lands outside the
  just-applied crop box and is silently clipped away.
  `src/core/workers/process.worker.ts:1592-1620` (header/footer), `:1785-1791` (crop),
  `:1811, 1835` (watermark), `:1877` (Bates) — fix: reuse the inverse-rotation transform
  already implemented for signature stamps.

- [ ] **[High] Rotating a page after placing a signature moves and spins it.**
  Stamp placement computes rotation as source `/Rotate` + the workspace rotate-tool's
  rotation and inverse-maps against the sum, but the overlay only ever carries the source
  rotation. The two disagree whenever the rotate tool has been used.
  `src/core/workers/process.worker.ts:640-690`, `src/ui/shell/SinglePageView.tsx:131`

- [ ] **[Medium] Page-range semantics disagree within the same operation.**
  Watermark/header-footer ranges are evaluated against the local slice index; `{n}` and
  Bates numbering use the global page offset — in the same function. On a split,
  "watermark pages 1–3" stamps the first three pages of every output file.
  `src/core/workers/process.worker.ts:1663-1668, 1806, 1820, 1865, 1873`

---

## 4 — Workers, cancellation & progress

- [ ] **[High] Buffers only transferred outbound; every inbound call clones the whole
  document.** Only one call site anywhere (`src/core/ocr/runOcr.ts:144`) transfers
  main→worker. `compose`, `applyRedactions`, `rebuildCompressed`, `protectDocument` all
  structured-clone full byte arrays into the process worker on every call, doubling peak
  memory each time.

- [ ] **[High] Cancellation is cooperative polling with no enforcement; several long ops
  have no job handle at all.** Nothing terminates a worker on abort except OCR; cancel
  latency equals time-to-next-checkpoint, and several ops checkpoint at 95% right before
  `pdf-lib.save()`. `protectDocument`, `flattenDocument`, `scrubMetadata`, form-field reads
  take no job handle — no progress, no cancel, ever. No test exercises this.
  `src/core/workers/protocol.ts:68-76`, `src/ui/useJob.ts:52-65`,
  `src/core/workers/process.worker.ts:3334, 3628, 3972, 3976, 4474, 4540`

- [ ] **[Medium] Three unmapped `console.error` sites; no double-click guard on the
  extension's tab-open handler.** Worker boot failure and directory-picker failure ship raw
  console errors with no user toast. Two rapid icon clicks before the first `tabs.query`
  resolves open two tabs; a tab with no `id` silently no-ops.
  `src/core/workers/client.ts:110`, `src/ui/tools/batch/BatchPanel.tsx:43, 59`,
  `src/background/service-worker.ts:1-16`

---

## 5 — Document core (DOC-01..09)

- [ ] **[High] Home/End are dead keys on any document long enough to virtualize.**
  Keyboard nav looks up the target tile via `querySelector('[data-index=...]')`, but only
  rows inside the virtualization window exist in the DOM.
  `src/ui/shell/PageGrid.tsx:128-134, 195`

- [ ] **[High] Contact Sheet's main export button doesn't export a contact sheet.**
  The primary action-bar button is wired to the generic composed-document export; only a
  secondary in-panel button produces the actual sheet. Also: contact-sheet generation
  always emits exactly one A4 page regardless of page count (300 pages at 4 columns → ~10pt
  cells, contradicting the code's own "still recognisable" comment).
  `src/ui/tools/commit.ts:757`, `src/core/tools.ts:299`,
  `src/core/workers/process.worker.ts:4557-4559, 4566`

- [ ] **[High] Rotating a page in the grid doesn't repaint its thumbnail.**
  Render effect's dependency list omits `page.rotation`; rotation reuses the same key so
  the effect never reruns, and CSS stretches the stale bitmap into the new aspect ratio.
  Export is correct; only the on-screen preview is wrong.
  `src/ui/components/Thumbnail.tsx:125`

- [ ] **[Medium] Linearized export doesn't actually linearize the objects that matter.**
  14 of 16 save sites use `useObjectStreams: true`; under pdf-lib's writer, page
  dictionaries/catalog/page tree end up diverted into object streams appended near the end
  regardless of sort order. No `/Linearized` dict, no hint tables. Applied unconditionally
  to every save with no way to disable, though the ticket describes it as an option. Zero
  tests reference linearization anywhere.
  `src/core/pdf/linearize.ts:3, 8-9, 26-48`

- [ ] **[Medium] Import can't be cancelled; shows fake 0%→100% progress.**
  Abort signal accepted then explicitly discarded (`void options`); no progress callback
  fires until the whole file finishes.
  `src/core/import.ts:69-129, 124`

---

## 6 — Scan cleanup & OCR (SCN-01..03, OCR-01..03)

- [ ] **[High] A failed edge-detection still crops the page.**
  A low-contrast test scene returns `confident: true` at 25% mean corner error (untested by
  the existing suite). When not confident, de-warp still applies a 2% inset crop instead of
  leaving the page alone.
  `tests/unit/edge-detection.test.ts:167, 173`, `src/core/cv/imageUtils.ts:106`

- [ ] **[High] Despeckle does nothing; background-flatten discards the preview it just
  computed.** Despeckle setting missing from the preview effect's dependency array. With
  "flatten background" on, the panel computes the previewed result and discards it, running
  flatten on the original source bytes instead; "apply to all" skips every page but the
  first entirely.
  `src/ui/tools/cleanup/CleanupEditor.tsx:144, 186-194, 248-259`

- [ ] **[High] Flattening a page repoints it to the wrong page number.**
  `flattenBackground` returns the whole rebuilt document; caller repoints with a hardcoded
  `sourceIndex: 0`. Flattening page 5 makes that content become page 1.
  `src/ui/tools/cleanup/CleanupEditor.tsx:186-193`, `src/core/store.ts:286`

- [ ] **[High] Folder search indexes encrypted files as garbage; incremental re-index loses
  unrelated files.** Render-worker errors (including "encrypted") are swallowed and fall
  back to a raw latin1 byte regex with no user message. Re-indexing after one file changes
  strips occurrences for every file in the folder but only re-adds the ones actually
  re-indexed.
  `src/core/ocr/folder-index.ts:186-203, 297`

- [ ] **[Critical] Table extraction's own primary export button is a no-op.**
  Commit handler for `table-extract` is an empty async function; the UI's own "Export
  Table" renders as the enabled primary CTA. Clustering/XLSX logic underneath is real —
  just unreachable.
  `src/ui/tools/commit.ts:756`, `src/core/tools.ts:271`

- [ ] **[Gap] Zero-network e2e test never visits the OCR route** — the one tool allowed to
  touch the network is the one route the zero-network test doesn't check.

- [ ] **[Medium] Signature-line detection only sees text, never a drawn horizontal rule.**
  Matches "signature"/underscore runs against text runs only; a vector-drawn signature
  line (the normal way it's done) is invisible to it. No fixture or test.
  `src/core/workers/render.worker.ts:503-530`

---

## 7 — Signing & forms

- [ ] **[Critical] Default export settings delete the form fields the tool just created.**
  `flattenOnExport` defaults to `true`; finalize deletes newly created fields as part of
  flattening. Verified: 2 fields after compose → 0 fields, no `/AcroForm`, no `/Annots`
  after finalize. Generated `/AcroForm` also has no `/DR`, no document `/DA`, and each
  field names a `/Helvetica` font that resolves nowhere.
  `src/ui/tools/state.ts:48`, `src/ui/tools/commit.ts:268, 634`

---

## 8 — Batch, alt-text, annotations

- [ ] **[High] A batch file failure shifts every subsequent file's output filename.**
  Filenames are pre-resolved against the input list but consumed via a counter that only
  advances when a file survives its full pipeline — a file that fails early desyncs every
  later filename in the run.
  `src/ui/tools/batch/runner.ts:84-89, 178`

- [ ] **[High] A saved recipe can silently pick up settings open in another tool.**
  Untouched recipe settings are stored as `null`; at run time `recipe?.settings.normalize ??
  normalizeSettings.value` falls through `null` to whatever the live global signal currently
  holds — not what was true when the recipe was saved.
  `src/ui/tools/batch/runner.ts:52-56`, `src/ui/tools/batch/BatchPanel.tsx:63-80`

- [ ] **[Medium] Alt-text never reads back on re-import.**
  Writer path is real; no reader exists anywhere in the codebase, so re-opening an exported
  file shows every alt-text field blank. Struct-tree writer also keys `ParentTree` entries
  by page index instead of the page's `/StructParents` integer (never set), so a
  spec-conformant reader can't resolve the structure.
  `src/ui/tools/acc/state.ts:4`, `src/core/pdf/accessibility.ts`

---

## 9 — Invariant enforcement tooling

- [ ] **[Medium] One raw color literal slipped past the hook.**
  Hook's colour regex matches bare CSS syntax (`color: black`) but not a quoted JS/TSX
  string literal (`color: 'black'`).
  `src/ui/shell/TopBar.tsx:81`, `.claude/hooks/check-invariants.mjs:47`

- [ ] **[Medium] Enforcement hook only fires on Write/Edit, and only scans `src/`.**
  Files written via shell commands bypass it entirely; no equivalent whole-repo check is
  wired into `pnpm check`. `public/privacy.html` carries ~16 hardcoded hex literals with
  its own hand-rolled dark-mode palette, unseen by hook or token-checker.
  `.claude/settings.json:32`, `.claude/hooks/check-invariants.mjs`

---

## 10 — i18n & UI

- [ ] **[High] Nine of ten non-English locales are missing keys, undisclosed.**
  Six annotate-tool keys absent from ar/de/fr/hi/id/ja/pt-BR/ru/zh-CN; Spanish missing four
  of six. Falls back to English on a miss, so these strings render in English for every
  non-English user.
  `src/core/i18n/locales/*.json` vs `en.json` (286 keys)

- [ ] **[Medium] Component library's forwardRef requirement unmet across all 23 components.**
  No component under `src/ui/components` uses `forwardRef`, despite it being a stated
  per-component acceptance criterion.

---

## Suggested order of attack

1. Redaction's vector/image handling (§1) — security-relevant, silent failure, highest risk.
2. Shared catalog-stripping bug (§0) — one fix, two call sites, already solved a third place.
3. Rotation coordinate mapping (§3) — five tools, one root cause, one fix.
4. Dead export buttons — contact sheet (§5), table extraction (§6) — trivial wiring fixes.
5. SGN default settings deleting form fields (§7) — one default flip + resource-dict fix.
