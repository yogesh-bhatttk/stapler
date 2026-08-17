# Audit findings — open issues (2026-08-16)

Bugs, gaps, and missing implementation found in a full-repo audit against
`docs/TICKETS.md`, verified against real output bytes rather than ticket `Status` lines.
Pure punch list — things to implement/fix. Ticket `Status` lines in `docs/TICKETS.md` are
unchanged; update them per-ticket as each item below is closed.

Severity: **Critical** (silent data loss / security-relevant / core promise broken),
**High** (wrong output or broken UX on a real path), **Medium** (real but narrower gap).

---

## 0 — Structural: same bug in three places

- [x] **[Critical] Rebuild-via-copyPages silently strips the document catalog.** ~~Verified
  fixed 2026-08-17~~ — `preserveDocumentCatalog()` is already called on both the compress
  rebuild (`process.worker.ts:3880`) and the redact rebuild (`:4431`), sharing one
  `PDFObjectCopier`. The line numbers above were stale; nothing needed changing, but the
  claim had no test, so `tests/unit/rebuild-catalog.test.ts` now re-parses real output bytes
  from `bookmarked-9.pdf` and asserts `/Outlines`, `/PageLabels`, `/OCProperties`,
  `/StructTreeRoot` survive both paths.
  `src/core/workers/process.worker.ts:4112` (redact), `:3596` (compress)

- [x] **[High] Base export path never dedupes shared objects across pages.** ~~Verified fixed
  2026-08-17~~ — `composePages` already reuses one `PDFObjectCopier` per source document
  (`copiers = new Map<PDFDocument, PDFObjectCopier>()`, `process.worker.ts:1851`), same as
  the compress path. Regression test added: composing a document with a logo shared across
  every page asserts exactly one XObject reference survives, not one per page.
  `src/core/workers/process.worker.ts:1708`

---

## 1 — Redaction (RED-01..06)

- [x] **[Critical] Vector content under a redacted region is never removed, only covered.**
  ~~Verified fixed 2026-08-17~~ — `interpreter.ts` already tracks path construction/painting
  operators (`currentPathStmts`/`currentPathPoints`/`flushPath`, CTM-transformed) and drops
  any path whose transformed geometry overlaps a redaction region; the audit's line numbers
  were stale. No test exercised it, so `tests/unit/interpreter.test.ts` now asserts on real
  output content-stream bytes: a stroked path, a filled `re`, and all of
  `S s f F f* B B* b b*` are removed when inside a region, geometry outside a region and
  `W n` clip paths are kept, and coordinates measured through a `cm` (not just raw user
  space) are handled correctly.
  `src/core/pdf/interpreter.ts:306-478`

- [x] **[Critical] Verification gate only checks text.** ~~Fixed 2026-08-17~~ — the gate now
  has a second, independent half: `checkRegionPixels` (`render.worker.ts`) renders each
  region exactly as a viewer draws it and measures how far it is from the opaque redaction
  fill (`regionPixelResidue`), and `verifyRedaction` fails any region over 2% off-fill.
  Tolerances are the same conservatism `checkRegionText` already applies to its glyph
  boxes: 24/255 per channel for rasteriser and JPEG noise, and an 8% edge inset because the
  mark's own boundary is anti-aliased. A region that cannot be rendered fails **closed** —
  unverifiable is not verified, and the save is blocked. `tests/unit/redaction-verify.test.ts`
  proves the two halves disagree where it matters: a real pdf.js render of a region holding
  a vector shape and no text passes the text check and fails the pixel check, while a
  correctly filled region passes both.
  `src/core/operations.ts` (`verifyRedaction`, `residueFailure`),
  `src/core/workers/render.worker.ts` (`renderRegion`, `regionVerifyDpi`, `regionPixelResidue`)

- [x] **[Critical] A redacted image region deletes the entire image, not the region.** ~~Fixed
  2026-08-17~~ — partial overlap now paints only the covered pixels black (`invertMatrix` /
  `redactionRectInUnitSpace` in `src/core/pdf/interpreter.ts`, pixel work in the new
  `src/core/pdf/image-redaction.ts` and `redactPageImages` in `render.worker.ts`,
  `planImageRedactions`/`applyRedactions` in `process.worker.ts`). An image pdf.js cannot
  decode now throws `unsupported` with a clear message instead of silently reporting
  `verified: true` over an intact image. `tests/unit/image-redaction.test.ts` and an e2e case
  cover it. Full containment still removes the XObject as before.
  `src/core/pdf/interpreter.ts:460-471`, `src/core/workers/process.worker.ts:4304-4380`
  (test at `tests/unit/process.test.ts:343-379` updated to match)

- [x] **[High] Inherited page rotation invisible to the redaction pipeline.** ~~Verified fixed
  2026-08-17~~ — the redaction path now reads rotation via `page.getRotation()`
  (`redactionRectsForPage`, `process.worker.ts`), pdf-lib's own inheritance-aware accessor,
  not the non-inheritable manual `.node.get(PDFName.of('Rotate'))` the audit found.
  `src/core/workers/process.worker.ts:4134`

- [x] **[High] Content-stream filtering is exponential in `q` nesting depth.** ~~Verified fixed
  2026-08-17~~ — `q` pushes `state.saveSnapshot()` (O(1)), not a deep clone of the whole
  stack; the audit's line numbers were stale. Added a depth-40 nesting test asserting
  completion in well under a second (actual ≈ 0ms) plus a correctness check that the CTM
  unwinds to identity through all 40 levels.
  `src/core/pdf/interpreter.ts:204-215, 320`

- [x] **[Medium] Text width is a fixed 0.6em guess and also drives position.** ~~Fixed
  2026-08-17~~ — real per-glyph widths are now read from the PDF (`/Widths`+`/FirstChar`+
  `/MissingWidth` for simple fonts, `/W`+`/DW` off the descendant for `/Type0`, which also
  determines single- vs double-byte decoding). `Tz`, `Tc`, `Tw`, the `"` operator's
  `aw`/`ac` operands, and TJ kerning are all applied; strings are unescaped/hex-decoded
  before counting instead of counting raw source bytes. 10 new tests in
  `tests/unit/interpreter.test.ts`.
  `src/core/pdf/interpreter.ts:389, 402-403`

- [x] **[Medium] Find-and-mark can't match text split across runs.** ~~Fixed 2026-08-17~~ —
  new `findAcrossRuns` (`src/core/pdf/text-search.ts`) concatenates page text with a
  per-character run/offset map, matches once against the whole string, then maps matches
  back to per-run slices; a run boundary that carries an EOL injects a newline so a match
  can't silently span two lines. 8 tests in `tests/unit/text-search.test.ts`.
  `src/core/workers/render.worker.ts:409-435`

- [x] **[Medium] Redaction success message is dead code / always wrong.** ~~Fixed
  2026-08-17~~ — the current redaction pipeline never rasterizes a page, so `rasterizedPages`
  was a permanent lie; removed from `RedactionOutcome`, the hardcoded `[]`, the toast (which
  now reports the verified region count instead), and the copyable report.
  `src/ui/tools/commit.ts:692`, `src/ui/tools/redact/VerificationReport.tsx:29`

- [x] **[Gap] No test covers:** an image under a region, a vector shape under a region, page
  rotation, or the "content outside the region is byte-identical" half of RED-02's AC.
  ~~Closed 2026-08-17~~ — covered by `tests/unit/interpreter.test.ts` (vector shapes, `cm`
  geometry), `tests/unit/image-redaction.test.ts` and the new e2e case (image regions), and
  `tests/unit/rotation-placement.test.ts` (rotation, via the redaction rect mapping).
  `tests/unit/process.test.ts:269-296` only checks that output bytes differ and are
  nonzero length.

---

## 2 — Compression (CMP-01..06)

- [x] **[Critical] Safety-image skip list is computed, then ignored on the raster route.**
  ~~Verified fixed 2026-08-17~~ — `hasUnsafeImage` already gates the textless (raster) route
  in `compress-plan.ts`: a page with an unsafe image and no text now routes to
  `already-optimized` with an explicit reason, not to `raster`. The line numbers were stale
  and the exact reproduction case was untested, so
  `tests/unit/compress-plan.test.ts` ("never rasterises a textless page whose image is
  unsafe to re-encode") now covers a textless page with a `/Separation` image directly.
  `src/core/compress-plan.ts:264, 280-296`

- [x] **[High] A zero-work compression run can still report savings.** ~~Fixed 2026-08-17~~ —
  the zero-work guard (`hasRaster`/`hasReencoded`) turned out to be present already, but
  untested and one case short: an image whose replacement was *larger* than the stream it
  replaced was still swapped in, so "work happened" could mean "one image got worse".
  `rebuildCompressed` now takes a replacement only when it is actually smaller, which also
  means a plan whose every encode is counter-productive collapses to `keptOriginal: true`.
  Covered by `tests/unit/compress-rebuild.test.ts` against real output bytes: an empty plan
  returns the input byte-for-byte, a plan naming an unreachable image reports why, and an
  oversized replacement is refused with the original stream still in the output.
  `src/core/workers/process.worker.ts` (`rebuildCompressed`)

- [x] **[High] Exported compression report can present an estimate as a measurement.**
  ~~Fixed 2026-08-17~~ — `CompressionResultStats` gained an `estimated` flag; with it set the
  report reads "Estimated Size:" / "Estimated Saved:", says "Estimate only — no compression
  has been run on this document yet", and marks the page breakdown as planned routes. The
  panel sets it whenever `lastCompressionResult` is absent (the only signal that a run
  finished) instead of printing the projection under the measured labels, and no longer
  reuses `alreadyOptimized` as if it were `keptOriginal`. The JSON sidecar carries
  `summary.estimated` too. 4 new cases in `tests/unit/compress-report.test.ts`.
  `src/ui/tools/compress/CompressPanel.tsx`, `src/core/compress-report.ts`

- [x] **[Medium] "Encoded once" is only true of storage, not of encoding work.** ~~Fixed
  2026-08-17~~ — new `extractSharedImages` (`render.worker.ts`) decides the winning
  placement for every image *before* any pixel work, then decodes/downscales/encodes each
  distinct object once, at the largest size any page displays it at; `compressDocument`
  makes one document-wide call instead of one per page. Pages are held only while an
  unencoded winner depends on them, capped by `MAX_HELD_PAGES` so a long document cannot
  grow without bound (past the cap an image may be encoded twice — time, never
  correctness). `tests/unit/compress-encode-once.test.ts` runs the real worker against a
  real PDF and counts encodes as they happen: six pages sharing one image produce exactly
  one encode, at the largest page's size.
  `src/core/workers/render.worker.ts`, `src/core/operations.ts` (`compressDocument`)

- [x] **[Medium] Per-image before/after sizes never populated.** ~~Fixed 2026-08-17~~ —
  `rebuildCompressed` is the only place both numbers exist, so it now measures them there:
  every image the caller asked about is reported with the original stream's *stored* byte
  length, the replacement's, and a reason when it was skipped. Threaded through
  `compressDocument` / `compressToTargetSize` / `lastCompressionResult` into CMP-06's
  sidecar, which is no longer permanently empty. Covered in
  `tests/unit/compress-rebuild.test.ts` and `tests/unit/compress-report.test.ts`.
  **Still open — memory budget unverified:** `tests/e2e/a11y-and-perf.spec.ts` samples
  `performance.memory`, which reports the main thread's heap only; the re-encoded pages and
  decoded images accumulate in the worker heaps it cannot see.
  `performance.measureUserAgentSpecificMemory()` would cover them but requires cross-origin
  isolation (COOP/COEP) that neither the extension page nor the web twin sets, so adding it
  would change what ships to satisfy a test. The limitation is now stated in the test
  instead of implied away.
  `src/core/workers/process.worker.ts`, `src/core/compress-report.ts`, `src/core/operations.ts`

---

## 3 — Rotation & coordinate geometry (one root cause, five tools)

- [x] **[High] Crop, watermark, header/footer and Bates all place content in the wrong
  frame on a rotated page.** ~~Fixed 2026-08-17~~ — the inverse-rotation transform that only
  the signature-stamp path had is now a shared, tested primitive in `src/core/rotation.ts`
  (`displayFrame` / `displayPointToPage` / `placeDisplayBox`), and crop, watermark,
  header/footer, Bates and stamps all place against it. Edge-anchored content
  (watermark grid, header/footer band, Bates) is laid out against the **crop box**, so a
  Bates number no longer falls outside a crop the same export just applied. On an
  unrotated, uncropped page the transform reduces to the identity, so existing output is
  unchanged. `tests/unit/rotation-placement.test.ts` asserts each of the four against an
  independent transcription of pdf.js's `PageViewport`, at all four rotations.

- [x] **[High] Rotating a page after placing a signature moves and spins it.** ~~Fixed
  2026-08-17~~ — resolved by *excluding* the rotate tool's rotation, which is the side that
  was wrong: `SinglePageView` nests its overlay layer inside the element it CSS-rotates, so
  overlay coordinates are relative to page content and stay there. Every placement in
  `composePages` now derives its frame from `getRotation().angle - ref.rotation`, i.e. the
  source `/Rotate` only. Covered by "rotating a page after signing it does not move or spin
  the signature" in `tests/unit/rotation-placement.test.ts`.
  `src/core/workers/process.worker.ts` (`composePages`, `drawStamps`)

- [x] **[Medium] Page-range semantics disagree within the same operation.** ~~Partially fixed
  2026-08-17~~ — watermark ranges now parse against `globalTotal` and match `pageOffset + i`,
  so a split no longer stamps every output as pages 1–3; `pageRefMap` also keeps the first
  instance of a duplicated page instead of the last, and named destinations (both `/Dests`
  and the `/Names /Dests` name tree) now resolve for bookmarks. Header/footer and Bates
  numbering were not touched by this pass — re-check whether they still disagree.
  **Re-checked 2026-08-17: no longer broken.** Header/footer parses its range against
  `globalTotal` and matches `pageOffset + i`, and Bates numbers from `pageOffset + i`; both
  now have regression coverage over a split in `tests/unit/rotation-placement.test.ts`.
  `src/core/workers/process.worker.ts:1663-1668, 1806, 1820, 1865, 1873`

---

## 4 — Workers, cancellation & progress

- [ ] **[High] Buffers only transferred outbound; every inbound call clones the whole
  document.** ~~Partially fixed 2026-08-17~~ — new `handOver()` helper (`operations.ts`)
  applies a `Transferable` to `flattenDocument` and the redaction-internal `scrubMetadata`,
  both provably single-use worker output. Deliberately **not** applied to `compose`,
  `rebuildCompressed`, or `applyRedactions`: their bytes come from the document store's
  canonical `source.bytes` (`store.ts:118`), and transferring would detach and empty the
  open document in the UI — the silent corruption the invariants forbid. Fixing those needs
  an ownership change in the store, not a transfer list; documented in `handOver`'s docblock.
  `src/core/ocr/runOcr.ts:144`

- [ ] **[High] Cancellation is cooperative polling with no enforcement; several long ops
  have no job handle at all.** ~~Mostly fixed 2026-08-17~~ — `getFormFields`,
  `fillFormFields`, `flattenDocument`, `scrubMetadata`, `protectDocument` now all take an
  optional `JobHandle` with per-field/per-page checkpoints instead of one at 95%. **Still
  open:** the AES pass itself (`src/core/pdf/encrypt.ts`) is one uninterruptible loop over
  every indirect object — `protectDocument` can only be cancelled before it starts or after
  it ends. Nothing terminates a worker on abort; `protocol.ts` documents cooperative
  cancellation as deliberate (it preserves the warm pdf.js instance, and forcing termination
  would kill unrelated work sharing the pooled worker).
  `src/core/workers/protocol.ts:68-76`, `src/ui/useJob.ts:52-65`,
  `src/core/workers/process.worker.ts:3334, 3628, 3972, 3976, 4474, 4540`

- [x] **[Medium] Three unmapped `console.error` sites; no double-click guard on the
  extension's tab-open handler.** ~~Fixed 2026-08-17~~ — `client.ts:110`'s worker-boot
  failure now raises a `danger` toast with a copyable diagnostic instead of a bare
  `console.error`. `service-worker.ts` rewritten to guard on an in-flight **promise** (not a
  boolean) so a second click joins the first rather than racing it, and a tab with no `id`
  opens a fresh editor tab with a warning instead of silently no-opping.
  `src/core/workers/client.ts:110`, `src/ui/tools/batch/BatchPanel.tsx:43, 59`,
  `src/background/service-worker.ts:1-16`

---

## 5 — Document core (DOC-01..09)

- [x] **[High] Home/End are dead keys on any document long enough to virtualize.** ~~Fixed
  2026-08-17~~ — keyboard nav now scrolls the virtualized grid to the target row first
  (`pendingFocusRef`), then focuses the tile once it actually renders, instead of querying
  the DOM for an element that doesn't exist yet outside the overscan window.
  `src/ui/shell/PageGrid.tsx:128-134, 195`

- [x] **[High] Contact Sheet's main export button doesn't export a contact sheet.** ~~Fixed
  2026-08-17~~ — the action-bar handler calls `exportContactSheet`, generation paginates at
  20 cells per A4 sheet (thumbnails stay ~109x154pt however long the document is), and the
  column count moved from the panel's `useState` to `contactSheetColumns` in
  `src/ui/tools/contact-sheet/state.ts` so both export routes honour the same setting
  instead of the action bar hardcoding 4. Pagination and per-cell size asserted on a
  300-page sheet in `tests/unit/rotation-placement.test.ts`.
  `src/ui/tools/commit.ts`, `src/core/workers/process.worker.ts` (`contactSheetExport`)

- [x] **[High] Rotating a page in the grid doesn't repaint its thumbnail.** ~~Fixed
  2026-08-17~~ — `page.rotation` added to the render effect's dependency array, so rotating
  a page now re-renders its thumbnail instead of CSS-stretching the stale bitmap.
  `src/ui/components/Thumbnail.tsx:125`

- [x] **[Medium] Linearized export doesn't actually linearize the objects that matter.**
  ~~Fixed honestly 2026-08-17~~ — kept as first-page-first *object ordering* (pdf-lib cannot
  emit a real `/Linearized` dict or hint tables, and this module never fabricates one), but
  the misleading naming is gone: the module's own docblock now states plainly that this is
  not ISO 32000-1 §F linearization, explains that `useObjectStreams: true` save sites get
  little benefit from the reordering (pdf-lib's `PDFStreamWriter` diverts everything into
  object streams regardless of order), and the behaviour is now optional
  (`setFastWebViewOrdering(false)` / `pseudoLinearize(doc, false)`). `tests/unit/linearize.test.ts`
  asserts both the ordering itself and its documented limits on the object-stream path.
  `src/core/pdf/linearize.ts:3, 8-9, 26-48`

- [x] **[Medium] Import can't be cancelled; shows fake 0%→100% progress.** ~~Fixed
  2026-08-17~~ — the `AbortSignal` is now checked between real stages (reading, header
  check, parsing, inspecting), each of which reports its own progress fraction and label
  instead of jumping straight to 100%.
  `src/core/import.ts:69-129, 124`

---

## 6 — Scan cleanup & OCR (SCN-01..03, OCR-01..03)

- [x] **[High] A failed edge-detection still crops the page.** ~~Fixed 2026-08-17~~ — added
  `quadEdgeSupport`/a real confidence measurement (inside-vs-outside luminance contrast at
  each edge against sample noise), so the low-contrast case now correctly reports
  `confident: false`; the caller (via `isFrameQuad`/`cornersFor`) skips the warp entirely
  when not confident instead of falling back to a blind 2% inset crop.
  `tests/unit/edge-detection.test.ts:167, 173`, `src/core/cv/imageUtils.ts:106`

- [x] **[High] Despeckle does nothing; background-flatten discards the preview it just
  computed.** ~~Fixed 2026-08-17~~ — `despeckle` added to the preview effect's dependency
  array, so toggling it now updates the preview. "Apply to all" now cleans every page (not
  just the first) before any tint is applied. **Flatten's interaction with the preview
  turned out not to be a bug**: OPS-13 requires flatten to preserve foreground text/vector
  content, which only exists on the *original* page — routing it through the rasterized
  cleanup preview (a single all-image page, as an interim fix here briefly did) gives
  flatten nothing but background to find and erases the page entirely. Confirmed by
  `tests/e2e/tool-flows.spec.ts` "cleanup: flatten background preserves text", which
  regressed and was restored. Flatten now always runs against the original vector page(s);
  cleanup settings apply on the non-flatten (rasterize) path only, which is what they were
  ever able to affect.
  `src/ui/tools/cleanup/CleanupEditor.tsx:144, 186-194, 248-259`

- [x] **[High] Flattening a page repoints it to the wrong page number.** ~~Fixed
  2026-08-17~~ — the single-page apply path now tracks which page index the result actually
  corresponds to (`page.sourceIndex` when flatten ran against the whole source document,
  `0` when the non-flatten path produced a fresh single-page document) and repoints using
  that, instead of a hardcoded `0` that was only ever correct for one of the two paths.
  `src/ui/tools/cleanup/CleanupEditor.tsx:186-193`, `src/core/store.ts:286`

- [x] **[High] Folder search indexes encrypted files as garbage; incremental re-index loses
  unrelated files.** ~~Fixed 2026-08-17~~ — `readPdfTextPages` now distinguishes "pdf.js
  refused this document" (encrypted/corrupt/unsupported → skipped, reason surfaced to the
  user) from "no worker available" (degraded latin1 fallback, a claim about the
  environment, not the document) — encrypted files are no longer byte-scraped into the
  index. Incremental re-index now calls `deleteSearchIndexRecordsByFileId` only for files it
  actually rewrites, so editing one file no longer strips the index entries of every
  unchanged file in the folder.
  `src/core/ocr/folder-index.ts:186-203, 297`

- [x] **[Critical] Table extraction's own primary export button is a no-op.** ~~Fixed
  2026-08-17~~ — the `table-extract` commit handler exports the grid the user is actually
  looking at: page number, edited cells and last-used format live in
  `src/ui/tools/ocr/table-extract-state.ts`, shared by the panel and the action bar. With
  nothing previewed it extracts the selected page first, and warns rather than writing an
  empty file when no table is found. Writes via `platform.saveFileAs`, not the shared
  `save`, because that helper would run a CSV/XLSX through PDF encryption.
  `src/ui/tools/commit.ts`, `src/ui/tools/ocr/TableExtractPanel.tsx`

- [x] **[Gap] Zero-network e2e test never visits the OCR route** — ~~closed 2026-08-17~~ —
  added `ocr`, `table-extract`, `acc`, `contact-sheet`, `outline`, and `shortcuts` to the
  route sweep in `tests/e2e/zero-network.spec.ts` (only `outline`/`shortcuts` were missing
  for unrelated reasons; OCR was the one that mattered). Confirmed passing: none of these
  routes fire a network request merely by being visited.

- [x] **[Medium] Signature-line detection only sees text, never a drawn horizontal rule.**
  ~~Fixed 2026-08-17~~ — `render.worker.ts` now also detects a horizontal vector rule drawn
  near a "Signature"/"Date"/"Sign here"/"Printed name" label (`horizontalRulesFromOps`,
  `signatureRulesToRegions`), not just text/underscore runs. Tests in
  `tests/unit/signature-lines.test.ts`.
  `src/core/workers/render.worker.ts:503-530`

---

## 7 — Signing & forms

- [ ] **[Critical] Default export settings delete the form fields the tool just created.**
  ~~Partially fixed 2026-08-17~~ — `flattenOnExport` defaulting to `true` is confirmed
  intentional (sign/annotate are meant to flatten by default, per the tool's own comment
  history and a UI toggle that shows the choice), so that half is by design, not a bug. What
  *is* fixed: the generated `/AcroForm` now gets a `/DR` with a registered Helvetica font
  (under both `/Helvetica` and `/Helv`, matching what pdf-lib and other producers each
  emit) and a document `/DA`, via `ensureAcroFormDefaults()`, called from `composePages`,
  `fillFormFields`, and `flattenDocument`. 4 tests in `tests/unit/acroform-defaults.test.ts`.
  Honest caveat from that work: the "flattens without refusing" test passes with or without
  this fix, because pdf-lib flattens from appearance streams baked at `addToPage` time — the
  `/DR` fix matters for viewers that regenerate appearances later (`/NeedAppearances`, a
  second fill, a different editor), not for this app's own flatten path today.
  `src/ui/tools/state.ts:48`, `src/ui/tools/commit.ts:268, 634`

---

## 8 — Batch, alt-text, annotations

- [x] **[High] A batch file failure shifts every subsequent file's output filename.** ~~Fixed
  2026-08-17~~ — output filenames are now indexed by the loop's own file position
  (`resolvedNames[fileIndex]`), not a separate counter that only advanced on success, so a
  failure no longer desyncs every later filename in the run.
  `src/ui/tools/batch/runner.ts:84-89, 178`

- [x] **[High] A saved recipe can silently pick up settings open in another tool.** ~~Fixed
  2026-08-17~~ — an untouched setting in a recipe is now treated as "this recipe doesn't
  configure that tool" (the tool is skipped, with a warning naming which ones) rather than
  falling through to whatever a live global signal currently holds.
  `src/ui/tools/batch/runner.ts:52-56`, `src/ui/tools/batch/BatchPanel.tsx:63-80`

- [x] **[Medium] Alt-text never reads back on re-import.** ~~Fixed 2026-08-17~~ — the writer
  now sets a `/StructParents` integer on each tagged page and keys `ParentTree` entries by
  that integer instead of page index (also fixed a bug the new tests caught: the `Nums`
  array was built by wrapping a plain JS array once and mutating it afterward, which
  pdf-lib copies at wrap time — later pushes never reached the stored array). A new reader
  (`readAltTextFromDoc`/`readAltText`) walks the struct tree from `/StructTreeRoot` and
  matches elements back to images via their page's marked content, and `AccPanel` now
  populates `altTextMap` from it when a document loads. Round-trip tests (write → save →
  re-load → read, multi-page `/StructParents` uniqueness) in `tests/unit/accessibility.test.ts`.
  `src/ui/tools/acc/state.ts:4`, `src/core/pdf/accessibility.ts`

---

## 9 — Invariant enforcement tooling

- [x] **[Medium] One raw color literal slipped past the hook.** ~~Fixed 2026-08-17~~ —
  `TopBar.tsx`'s literal was already using a token; the hook regex was broadened to catch
  colour keywords in quoted/backtick JS string literals (not just bare `color:` CSS syntax)
  across a wider set of colour-bearing properties (`background`, `border-color`, `fill`,
  `stroke`, `box-shadow`, etc). Verified zero new findings across `src/`.
  `src/ui/shell/TopBar.tsx:81`, `.claude/hooks/check-invariants.mjs:47`

- [x] **[Medium] Enforcement hook only fires on Write/Edit, and only scans `src/`.** ~~Fixed
  2026-08-17~~ — `scripts/check-invariants.mjs` (already wired into `pnpm check`) had
  quietly exempted `public/privacy.html` entirely, which is what let its hex literals go
  unseen. Replaced the blanket exemption with the same rule `tokens.css` gets: only a
  `--token: <value>;` custom-property *declaration* line is allowed, so the page's small
  palette is declared as page-scoped custom properties (with a comment explaining why it
  duplicates `tokens.css`'s values instead of sharing them — no build pipeline connects a
  static HTML page under `public/` to `src/`) and any stray literal elsewhere would now be
  caught.
  `.claude/settings.json:32`, `.claude/hooks/check-invariants.mjs`

---

## 10 — i18n & UI

- [x] **[High] Nine of ten non-English locales are missing keys, undisclosed.** ~~Fixed
  2026-08-17~~ — all 286 keys are structurally present in every locale, but six
  `tool.annotate.*` strings were byte-identical to the English source (untranslated) in
  ar/de/fr/hi/id/ja/pt-BR/ru/zh-CN, and four of six in es, matching the audit exactly.
  Translated all of them in all 10 files. Least confident: the "Annotate" tool-name
  translations themselves (de/ru/ar/hi) — worth a native-speaker check against whatever term
  each locale already uses for similar tool-category labels. Also noted but out of scope: a
  handful of other pre-existing untranslated strings outside the annotate tool, across every
  locale — a broader version of the same problem, worth its own follow-up.
  `src/core/i18n/locales/*.json` vs `en.json` (286 keys)

- [x] **[Medium] Component library's forwardRef requirement unmet across all 23 components.**
  ~~Fixed 2026-08-17~~ — all 23 components now forward their ref to their single root DOM
  element, via a new `src/ui/components/mergeRefs.ts` helper where a component already had
  its own internal ref (`Modal`'s `dialogRef`, `Thumbnail`'s `frameRef`). `Select`,
  `RadioGroup`, and `SegmentedControl` keep their generic type parameter through a small
  `forwardRefGeneric` cast helper, since `preact/compat`'s `forwardRef` erases generics
  otherwise.

---

## Suggested order of attack

1. Redaction's vector/image handling (§1) — security-relevant, silent failure, highest risk.
2. Shared catalog-stripping bug (§0) — one fix, two call sites, already solved a third place.
3. Rotation coordinate mapping (§3) — five tools, one root cause, one fix.
4. Dead export buttons — contact sheet (§5), table extraction (§6) — trivial wiring fixes.
5. SGN default settings deleting form fields (§7) — one default flip + resource-dict fix.
