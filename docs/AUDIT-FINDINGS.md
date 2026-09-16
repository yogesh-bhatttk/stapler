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

- [x] **[High] Buffers only transferred outbound; every inbound call clones the whole
  document.** ~~Partially fixed 2026-08-17~~ — new `handOver()` helper (`operations.ts`)
  applies a `Transferable` to `flattenDocument` and the redaction-internal `scrubMetadata`,
  both provably single-use worker output. Deliberately **not** applied to `compose`,
  `rebuildCompressed`, or `applyRedactions`: their bytes come from the document store's
  canonical `source.bytes` (`store.ts:118`), and transferring would detach and empty the
  open document in the UI — the silent corruption the invariants forbid. Fixing those needs
  an ownership change in the store, not a transfer list; documented in `handOver`'s docblock.
  `src/core/ocr/runOcr.ts:144`
  **Closed 2026-08-17 as "measured, and the answer is no."** The ownership question is now
  answered by instrument rather than by argument: `sourceRefCounts` / `sourceDocRefCounts`
  (`src/core/store.ts`) count how many `PageRef`s and how many distinct open documents
  reference each source, `historySourceRefCount` (`src/core/history.ts`) counts undo/redo
  snapshots that can still reach it, and `renderHandleHoldsSource`
  (`src/core/render-cache.ts`) reports whether a pdf.js handle is keyed on that exact byte
  array. `canTransferSourceBytes(sourceId, owningDocId)` gates on all three, and
  `transferableSourceIds(pages, docId)` reports the cleared subset. The counts are a
  `computed` over `documents`, not hand-maintained increments, deliberately: a mutation site
  that forgets to decrement produces a detached buffer under a live document, and there is
  no acceptable version of that bug.
  **No transfer was enabled, because the gate is essentially never open in the shipped app**,
  for three reasons that are all features:
  (1) all three operations end in `replaceWithSource`, which calls `commit()` — redaction and
  cleanup are *undoable by design*, so the pre-operation bytes must stay readable, and
  `sources` is only pruned in `closeDocument` precisely to keep them so;
  (2) `currentDocumentBytes`'s untouched fast path returns `source.bytes` **by identity**, so
  the common "one whole file, unedited" case is exactly the case where the buffer belongs to
  the store — and `applyRedactions` reads its `bytes` three times (plan, image pixels,
  rebuild), so no read of it can be the last one;
  (3) any document with a thumbnail on screen has a render-worker handle keyed on that array.
  Enabling a transfer would require: making these operations non-undoable (or teaching
  history to hold its own copy of the bytes it can reach), having `currentDocumentBytes` never
  return store-owned bytes, and closing the render handle before the call. Each of those costs
  more than the clone it saves. Regression coverage in
  `tests/unit/source-transfer-hazard.test.ts` runs compose / applyRedactions /
  rebuildCompressed on one of two documents sharing a source and asserts the other still
  exports; it also performs the naive transfer by hand
  (`structuredClone(buf, { transfer: [buf] })`, which is what `postMessage` does) to prove the
  test has teeth — the shared source goes to 0 bytes and the other document stops exporting —
  and guards structurally that `handOver` has not been applied to those three call sites.
  Refcount coverage in `tests/unit/store.test.ts` ("source reference counting",
  "canTransferSourceBytes").
  `src/core/store.ts` (`sourceRefCounts`, `sourceDocRefCounts`, `sourceOwners`,
  `canTransferSourceBytes`, `transferableSourceIds`), `src/core/history.ts`
  (`historySourceRefCount`), `src/core/render-cache.ts` (`renderHandleHoldsSource`),
  `src/core/operations.ts` (`handOver` docblock)

- [x] **[High] Cancellation is cooperative polling with no enforcement; several long ops
  have no job handle at all.** ~~Mostly fixed 2026-08-17~~ — `getFormFields`,
  `fillFormFields`, `flattenDocument`, `scrubMetadata`, `protectDocument` now all take an
  optional `JobHandle` with per-field/per-page checkpoints instead of one at 95%.
  ~~Still open: the AES pass~~ **Closed 2026-08-17** — `encryptPdf` now takes an optional
  `JobHandle` and checkpoints *inside* its per-object loop, on two gates whichever trips
  first: 50ms elapsed (the gate that actually bounds cancellation latency, since one object
  ranges from a 12-byte name to a 5MB image stream) or 64 objects (the floor, ~13ms of work
  measured at ~0.2ms/object on `tests/fixtures/text-300.pdf`: 604 objects, ~116ms end to
  end). Aborting is safe by construction — the half-encrypted `PDFDocument` is local to the
  call and discarded, and the input `bytes` are only ever read — so the caller keeps the
  original, per the never-corrupt rule. The 0..1 span is mapped into `protectDocument`'s
  0.1–0.95 band by a new `subJob` helper in `protocol.ts`, so `core/pdf` does not have to
  know where its work sits in someone else's progress bar. Five tests in
  `tests/unit/encrypt.test.ts` ("cancellation inside the object loop") measure *how far the
  loop got* from its own progress labels rather than asserting on wall-clock time: a
  cancelled run stops inside the first ~3 gates of 604 objects, an already-aborted signal
  stops at the first, an uncancelled run is shown to check ≥ floor(total/64) times with
  monotonic in-range progress, and both the direct and worker entry points leave the input
  byte-identical.
  **Still open (by design):** nothing terminates a worker on abort; `protocol.ts` documents
  cooperative
  cancellation as deliberate (it preserves the warm pdf.js instance, and forcing termination
  would kill unrelated work sharing the pooled worker).
  `src/core/pdf/encrypt.ts` (`ENCRYPT_CHECKPOINT_MS`, the object loop),
  `src/core/workers/protocol.ts` (`checkpoint`, `subJob`), `src/ui/useJob.ts:52-65`,
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

- [x] **[Critical] Default export settings delete the form fields the tool just created.**
  ~~Fixed 2026-08-17~~ — the sign/annotate flatten toggle is intentional, and the default-on
  path now passes the round-trip / external-viewer checks that were previously failing: the
  generated `/AcroForm` carries a registered Helvetica `/DR` and a document `/DA` via
  `ensureAcroFormDefaults()`, and the sign export tests confirm the field survives when
  flattening is off and bakes cleanly when it is on. `tests/unit/acroform-defaults.test.ts`
  and `tests/e2e/tool-flows.spec.ts:1046-1127`.
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

## 11 — Fresh audit (2026-08-17): EPIC-15 (v1.1) PDF internals

The original audit above predates most of EPIC-15's 20 tickets and doesn't cover them.
This pass targets those specifically, verified against code and (where present) tests,
not against `Status: Done` lines.

- [x] **[Critical] OPS-13 flatten-background deletes the scan itself, producing a blank
  white page.** ~~Fixed 2026-08-17~~ — full-page `Do` image XObjects are never candidates
  for removal; OPS-13 only removes a qualifying full-page vector fill. The operation now
  returns an explicit unchanged outcome when no vector background is found, so the UI does
  not report a false success. Regression coverage builds a real full-page scan and verifies
  byte-identical output.
  `src/core/workers/process.worker.ts` (`flattenBackground`),
  `tests/unit/flatten-background.test.ts`

- [x] **[Critical] OPS-13 deletes a resource-dict entry that may be shared across the whole
  page tree, corrupting pages the user never touched.** ~~Fixed 2026-08-17~~ — flatten no
  longer mutates `/Resources` at all. Removing a vector paint from its content stream does
  not require deleting its resource, and this avoids mutation of an inherited dictionary
  shared by sibling pages.
  `src/core/workers/process.worker.ts` (`flattenBackground`)

- [x] **[High] OPS-13 loads encrypted documents with `ignoreEncryption: true` instead of
  refusing.** ~~Fixed 2026-08-17~~ — `flattenBackground` now uses the normal refuse-closed
  `load(bytes)` path. The other `allowEncrypted` calls are read-only inspection paths and
  remain separately reviewable.
  `src/core/workers/process.worker.ts` (`flattenBackground`)

- [x] **[High] OPS-13 has zero test coverage of any kind**, plus: the injected cover rect
  uses `page.getSize()` and ignores a non-zero MediaBox/CropBox origin, it's injected
  unconditionally even when detection found nothing (reporting success over an unchanged
  page), and the save path skips the "never emit output larger than input" guard every other
  compression-adjacent save uses. Treat `flattenBackground`
  (`process.worker.ts:3443-3652`) as unshipped, not as a bug list — it's the least-reviewed
  code in EPIC-15.
  ~~Fixed 2026-08-17~~ — the injected rectangle now uses the page's crop-box origin, the
  operation reports an unchanged result when no vector background is detected, and the
  final save is refused unless it is smaller than the input. Regression coverage exercises
  both the real scan case and the fixed crop/rotation math.
  `src/core/workers/process.worker.ts`, `tests/unit/flatten-background.test.ts`,
  `tests/unit/form-fields-create.test.ts`

- [x] **[High] SGN-06's own default setting deletes the form fields it just created.**
  ~~Fixed 2026-08-17~~ — Sign now defaults to leaving its exported form fields interactive,
  while Annotate keeps the old finalized default for page marks. The shared toggle was split
  into per-tool settings, and the Sign e2e coverage now checks both the default fillable
  export and the keyboard path that opts into flattening.
  `src/ui/tools/commit.ts`, `src/ui/tools/state.ts`, `src/ui/tools/FlattenOption.tsx`,
  `tests/e2e/tool-flows.spec.ts`

- [x] **[High] SGN-06 places form-field rects in raw page space, ignoring rotation and
  crop — reintroduces the §3 rotation-coordinate bug class in a new tool.** Every other
  overlay placement in the same function (crop, watermark, header/footer, Bates, stamps)
  goes through `displayFrame`/`placeDisplayBox`/`marginFrame` specifically to handle a
  rotated or cropped page. The new field-placement code instead computes directly from
  `page.getSize()`. On a page with `/Rotate 90` the field lands transposed and
  mis-sized; on a cropped page it ignores the crop-box origin entirely. No rotated or
  cropped fixture exists in the test.
  ~~Fixed 2026-08-17~~ — widgets now map their two displayed corners through the same
  crop-aware display frame used by stamps, then take the raw-page extents. A rotated/cropped
  integration test verifies the resulting widget rectangle.
  `src/core/workers/process.worker.ts` (`composePages`),
  `tests/unit/form-fields-create.test.ts`

- [x] **[Medium] SGN-06 aborts the whole export with a raw pdf-lib error on a field-name
  conflict.** If the source document already has a field with the requested name but a
  different type, `form.getTextField(name)` throws (wrong type), the fallback
  `createTextField(name)` then throws `FieldAlreadyExistsError`, uncaught, inside
  `composePages` — surfacing an internal pdf-lib message instead of a named conflict.
  ~~Fixed 2026-08-17~~ — an existing field is inspected before reuse; a conflicting type now
  throws a named `UnsupportedFeature` error that includes the requested field name.
  `src/core/workers/process.worker.ts` (`composePages`),
  `tests/unit/form-fields-create.test.ts`

- [x] **[Medium] DOC-08's fast-web-view ordering is unmet on nearly every real export
  path.** 11 of the 13 `pseudoLinearize(...).save(...)` call sites pass
  `useObjectStreams: true`, which the module's own comment says "buys nothing beyond
  ordering the page content streams" — `linearize.test.ts:139` asserts that caveat rather
  than the AC ("first page's objects precede later pages' in byte offset"). Only two save
  sites (`:4194`, `:4923`) get the real behaviour. There is also no user-facing control
  despite the ticket calling the behaviour optional — `setFastWebViewOrdering` has no
  caller anywhere in `src/ui`. The module itself is honest about its limits; the ticket's
  `Status: Done` is not.
  ~~Fixed 2026-08-17~~ — the real export paths now save with plain xref tables so the
  first-page-first ordering actually reaches the output bytes. The ordering module keeps
  its documented object-stream caveat for callers that opt into it directly, but the user
  exports now take the fast-web-view path the ticket described.
  `src/core/workers/process.worker.ts`, `tests/unit/process.test.ts`

- [x] **[Medium] CMP-06's exported report can show a different document's numbers than the
  one currently open — a repeated pattern, see §12.** `lastCompressionResult`
  (`src/ui/tools/compress/state.ts:119`) is a module-level signal never cleared on document
  switch. Compress doc A, switch to doc B, click "Export report" without re-running: the
  file is named for B but contains A's byte totals and per-image stats, with no indication
  it's stale. Secondarily, even the fresh case measures pre-`applyProtection` byte length, so
  an RED-06-encrypted export's report understates the real file on disk. The test suite
  (`tests/unit/compress-report.test.ts`) only exercises hand-written report data, never a
  real produced PDF, so the AC's actual cross-check (report matches output file size) is
  untested.
  ~~Partially fixed 2026-08-17~~ — each measured result carries its producing document ID;
  another open document falls back to its clearly-labelled estimate rather than exporting
  stale measurements. The protected-output-size cross-check remains open.
  `src/ui/tools/compress/state.ts`, `src/ui/tools/compress/CompressPanel.tsx`

- [x] **[Low] CNV-07's one test never exercises the real clipboard path or the
  insert-at-index branch.** The e2e test sets a production-code test hook
  (`window.__mockClipboardImage`) and dispatches a bare `paste` event rather than going
  through `navigator.clipboard.read()`; it also only ever hits the empty-workspace
  `addDocument` branch, never `insertPages(doc.id, …, at)`, so the AC's "inserts at the
  expected index" is unverified. Production code also never calls `preventDefault()` and
  ignores `event.clipboardData` entirely.
  ~~Partially fixed 2026-08-17~~ — the paste handler now consumes image data from the native
  `ClipboardEvent.clipboardData` first and calls `preventDefault()` once it will import it;
  the async Clipboard API remains a fallback. The e2e coverage gap remains open.
  `src/ui/shell/AppShell.tsx`

**Genuinely solid, no findings:** RED-05 (pattern precedence, Luhn check, tested declines),
RED-06 (encryption algorithm cross-verified against poppler, per-object cancellation),
OPS-11 (Bates numbering correctly uses the display-frame helpers, handles rotation/crop),
OPS-12 (split-by-bookmarks filters and dedupes before slicing, no filename/slice
mismatch), DOC-07 (compress-to-target's bisection is bounded and measurement-driven, real
byte-level e2e assertions).

## 12 — Fresh audit (2026-08-17): EPIC-15 UI state bleeds across documents

Three unrelated tickets share one root cause: a module-level Preact signal holding
per-document derived data with no document-id scoping and nothing that resets it when the
active document changes. `src/ui/tools/outline/useOutline.ts` (OPS-10) does this correctly
with a staleness guard — worth turning into a shared pattern/lint rule rather than patching
each site individually.

- [x] **[Critical] ACC-01 alt-text is written against the wrong object numbering and
  silently fails to attach end-to-end.** ~~Fixed 2026-08-17~~ — the editor now keys images
  by page plus image name, which survives a compose/rebuild cycle; the writer accepts that
  stable key and still tolerates the legacy object-number form. A regression test exercises
  the real save/reparse path, not just the in-memory document object.
  `src/ui/tools/acc/AccPanel.tsx`, `src/core/pdf/accessibility.ts`,
  `tests/unit/accessibility.test.ts`

- [x] **[High] ACC-01's `altTextMap` is never cleared on document switch.**
  ~~Fixed 2026-08-17~~ — the alt-text panel now clears its map when the active document
  changes, then repopulates it from the current file only. The async scan is also guarded so
  a late result from the previous document cannot overwrite the current one.
  `src/ui/tools/acc/AccPanel.tsx`

- [x] **[High] ANN-04's annotation summary bleeds stale annotations from a previously
  opened, unrelated document.** ~~Fixed 2026-08-17~~ — the summary exporter now treats an
  annotation whose `pageKey` does not resolve in the current document as `Detached`
  instead of silently mapping it to page 1. The panel still filters to the current
  document's page keys, so stale annotations cannot be misattributed even if another caller
  bypasses that filter.
  `src/core/annotation-summary.ts`, `tests/unit/annotation-summary.test.ts`

- [x] **[Critical] DS-09's shortcut-remap rows are unreachable by keyboard.**
  ~~Fixed 2026-08-17~~ — each shortcut row is now a real button, so Tab reaches it and
  Enter/Space activate it with the same edit behavior as a pointer click. An e2e assertion
  covers the palette row, though the Playwright slice in this environment still hits the
  repo web-server startup issue before it can finish.
  `src/ui/tools/shortcuts/ShortcutsPanel.tsx`, `tests/e2e/a11y-and-perf.spec.ts`

- [x] **[Medium] DS-09's conflict detection doesn't mirror the Delete/Backspace
  equivalence the runtime handler actually uses.** ~~Fixed 2026-08-17~~ — the shortcut
  matcher and the conflict checker now normalize `Delete` and `Backspace` through the same
  helper, so the panel rejects the same collision the runtime would have seen anyway. A
  unit regression covers the exact case.
  `src/core/shortcuts.ts`, `tests/unit/shortcuts.test.ts`

- [x] **[Medium-High] ANN-05's "Export Diff PDF" ignores Text Diff mode and always
  produces a pixel-diff.** ~~Fixed 2026-08-17~~ — the compare panel now routes through a
  mode-aware exporter. Visual mode still uses the pixel-diff PDF; Text mode generates a
  text-diff report that mirrors the highlighted chunks the live view shows.
  `src/ui/tools/compare/ComparePanel.tsx`,
  `src/core/compare-export.ts`,
  `src/core/text-diff-export.ts`,
  `tests/unit/compare-export.test.ts`,
  `tests/unit/text-diff-export.test.ts`

- [x] **[Medium] ANN-03 has no staleness guard if the active document changes mid-search.**
  ~~Fixed 2026-08-17~~ — the annotate search helper now re-checks the active document after
  the async search completes and drops stale results if the user switched documents while it
  was running.
  `src/ui/tools/annotate/search.ts`, `tests/unit/annotate-search.test.ts`

- [x] **[Medium] BAT-03 produces a double `.pdf` extension for any pattern that already
  includes an extension.** ~~Fixed 2026-08-17~~ — the batch runner now strips any trailing
  `.pdf` from the resolved pattern before appending the final export extension, so a pattern
  like `{basename}_v2.pdf` resolves to `name_v2.pdf` instead of `name_v2.pdf.pdf`.
  `src/ui/tools/batch/runner.ts`, `tests/unit/batch-runner.test.ts`

- [x] **[Medium] DOC-09's contact sheet export re-renders every page from scratch instead
  of reusing the thumbnail cache the ticket requires.** ~~Fixed 2026-08-17~~ —
  `exportContactSheet` now reuses any cached thumbnail bitmap first, then falls back to the
  shared render worker and seeds the same cache for later UI use. A regression test
  exercises the cached-hit and uncached-miss paths together.
  `src/core/operations.ts`, `src/core/image.ts`,
  `tests/unit/contact-sheet-export.test.ts`

**Minor, not counted above:** OPS-10's move/indent `IconButton`s are never disabled at tree
boundaries (affordance only, no data corruption); ANN-04's export bypasses `useJob()`
(no cancellation/progress) unlike every other export in the same file.

**Genuinely solid:** OPS-10 (bookmark/outline editor) — page-key-based tree, a real
staleness guard in `useOutline.ts:29-33`, keyboard-operable native controls, round-trip
tests. This is the pattern the three Critical/High findings above should be made to match.

## 13 — Fresh audit (2026-08-17): tooling gap and a live CI regression

- [x] **[Medium] The Firefox build target injects a `tabs` permission, unconditionally
  contradicting the "zero permissions" invariant for that target, and no check catches
  it.** `scripts/firefox-manifest.mjs:26` does
  `permissions: Array.from(new Set([...(manifest.permissions || []), 'tabs']))` for
  `build:ext:firefox` — intentional, and `tests/unit/firefox-manifest.test.ts:28-30`
  asserts it. The invariant now explicitly exempts Firefox's `tabs` permission, and
  `scripts/check-invariants.mjs` / `scripts/validate-builds.mjs` both validate the
  Firefox manifest output too.
  `scripts/firefox-manifest.mjs:26`

- [x] **[High] `pnpm test:e2e` is currently red on a clean `master` — contradicts
  `docs/TICKETS.md`'s claim of a fully green baseline across all 92 "Done" tickets.**
  `tests/e2e/a11y-and-perf.spec.ts:64` was failing an axe-core color-contrast check on
  the batch route's primary "Run Batch" button. The live button now clears the browser
  scan after darkening the shared primary token to `#5460c8`; `node scripts/check-contrast.mjs`
  and the targeted route scan both pass.
  `tests/e2e/a11y-and-perf.spec.ts:64`, batch action bar primary button

## 14 — Fresh audit (2026-09-15): concurrency, resource lifecycle, and edge-case bugs

Full-repo audit of `src/core/`, `src/platform/`, `src/background/`, `src/ui/`, independent of
the ticket-by-ticket passes above. Verified against the actual current code (not against the
audit's own prose) before any fix landed — every Critical item below was re-read at its cited
lines and confirmed to match exactly before being touched.

### Critical

- [x] **Modal request signals silently orphan a Promise on a concurrent call.**
  `confirmAction()`, `requestOcrConsent()`, and `requestExportReview()` each held a single
  module-level signal for "the request currently on screen." A second concurrent call
  overwrote it outright — the first caller's `resolve` was discarded with it, so nothing ever
  settled that `await`, and the caller hung forever. `discardAllChanges.ts` had grown its own
  `discardInFlight` module guard to work around this for `confirmAction` specifically; no
  other call site had an equivalent. ~~Fixed 2026-09-16~~ — added `createModalQueue()` (a
  small generic FIFO) in `core/notify.ts`; a concurrent call now queues behind whichever
  request is on screen and is shown once it resolves, instead of clobbering it. All three
  request signals route through it.
  `src/core/notify.ts` (`createModalQueue`, `confirmAction`, `requestOcrConsent`,
  `requestExportReview`)

- [x] **OPFS `getDirectory()` can throw even when the API exists.** Every function in
  `core/opfs.ts` gated OPFS-vs-memory-fallback on `!navigator.storage?.getDirectory` — but the
  call itself can throw a `SecurityError` in Firefox Private Browsing, a sandboxed iframe, or
  when storage access is later revoked, even though the function is present. Since OPFS holds
  every document's actual bytes, an uncaught throw there made the whole app non-functional
  instead of degrading to the in-memory `Map`. ~~Fixed 2026-09-16~~ — added `tryGetOpfsRoot()`,
  which wraps the call in try/catch and returns `null` on any failure; every read/write/delete/
  exists check in the module now goes through it instead of touching `navigator.storage`
  directly.
  `src/core/opfs.ts`

- [x] **`useJob` cleanup race wipes a different job's progress bar.** On unmount while a job
  was running, the cleanup effect aborted the controller and cleared the shared `activeJob`
  signal, but never nulled `controllerRef.current`. The aborted task's own `finally` block
  fires later (once the abort actually unwinds); its guard `controllerRef.current === controller`
  was still true, so it cleared `activeJob` a second time — even if a *different* `useJob()`
  instance had since started a new job in that now-empty slot. ~~Fixed 2026-09-16~~ — the
  cleanup effect now also sets `controllerRef.current = null`, so the later `finally` sees the
  guard fail and leaves the new job's `activeJob` alone.
  `src/ui/useJob.ts`

- [x] **`diff.ts`'s LCS diff allocates an unbounded `(n+1)×(m+1)` table.** `diffText` builds a
  full dense DP matrix with no size guard — two ~50k-word documents means a ~2.5-billion-cell
  array, which OOMs or locks the main thread solid. ~~Fixed 2026-09-16~~ — added a word-count
  guard (`MAX_DIFF_WORDS`) that falls back to a coarse, O(n+m) line-level equal/changed diff
  instead of the full LCS once either side is too large to matrix-diff safely, so a huge
  document degrades to a coarser diff rather than hanging the tab.
  `src/core/diff.ts`

- [x] **Worker pool `api()` returns a proxy without tracking a lease.** `lease()` increments/
  decrements an instance's `leases` count around the call so its idle timer won't fire mid-use;
  `api()` returned the same kind of proxy with no lease at all, so the idle timer could
  terminate the worker out from under a caller mid-RPC. ~~Fixed 2026-09-16~~ — `api()` had zero
  callers anywhere in the repo, and `pin()` (already on the same interface) is the existing
  safe equivalent — lease-tracked, with an explicit `release()` — for exactly the "hold a
  proxy across several calls" case `api()` existed for. Removed `api()` from the interface and
  implementation rather than bolt a lease-tracked wrapper onto code nothing used, closing the
  race by deleting the unsafe surface instead of patching it.
  `src/core/workers/client.ts`

### High

- [x] **H1 — `render-cache.ts` `invalidateSource` closes bitmaps with active consumers.**
  Closed `entry.bitmap` without checking `entry.users > 0`; a component still drawing a
  retained bitmap gets `InvalidStateError` on its next `drawImage`. ~~Fixed 2026-09-16~~ —
  added an `orphaned` flag: an in-use entry is left in the cache instead of closed, and
  `release()` now closes it once the last consumer's `users` count reaches 0.
  `src/core/render-cache.ts`
- [x] **H2 — `useImageImportOptions` concurrent calls orphan a Promise.** Same shape as C1 but
  in component state (`setPending`) rather than a module signal — a second concurrent call
  silently dropped the first caller's resolver. ~~Fixed 2026-09-16~~ — added a `useRef` queue
  (same fix shape as `createModalQueue`), so a second concurrent `requestOptions()` call
  queues behind the first instead of replacing it. `src/ui/useImageImportOptions.tsx`
- [ ] **H3 — Image processing blocks the main thread for large images.**
  `trimTransparentToPng()`/`removeWhiteBackground()` iterate every pixel synchronously
  despite being `async`; a 4000×3000 scan is a multi-second stall. `src/core/image.ts`
  **Open** — the real fix is moving the pixel loop into a worker (per the "heavy work goes
  in a worker" invariant), a larger change than the rest of this pass; left for follow-up.
- [x] **H4 — `open-document.ts`: `requestImageOptions()` can throw outside its `try/catch`,**
  becoming an unhandled rejection instead of a surfaced import error. ~~Fixed 2026-09-16~~ —
  moved the call inside the existing `try` block so any throw goes through the same
  `notifyError('import', err)` path as the rest of the import. `src/core/open-document.ts`
- [x] **H5 — `openFilesViaInput`: a dismissed picker hangs forever on browsers that fire
  neither `cancel` nor `change`** (older Firefox/WebView). ~~Fixed 2026-09-16~~ — added a
  `window` `focus` listener as a cross-browser fallback: the native picker reliably steals
  focus while open, so a refocus with no `change` shortly after is treated as a cancel.
  `src/platform/file-system.ts`
- [x] **H6 — `closeDocument` calls `resetHistory()`, wiping undo/redo for every open document,**
  not just the one being closed. ~~Fixed 2026-09-16~~ — added `forgetDocumentInHistory(docId)`
  (`core/history.ts`), which strips only the closed document's entries from every historical
  snapshot (re-pointing a snapshot's `activeId` off it if needed) instead of discarding both
  stacks outright; `closeDocument` now calls this instead of `resetHistory()`.
  `src/core/history.ts`, `src/core/store.ts`
- [x] **H7 — Theme listener silently stops in Safari/WebKit.** `media()` returned a fresh
  `MediaQueryList` each call with nothing retaining it, so the attached listener could be
  GC'd. ~~Fixed 2026-09-16~~ — `media()` now caches the single `MediaQueryList` instance for
  the module's lifetime instead of reconstructing it per call. `src/ui/theme.ts`
- [x] **H8 — Unnamed form fields all fall back to the same literal name `'field'`,** which PDF
  treats as one linked field — typing in one mirrors to all others. Reachable in practice:
  `AnnotationOverlay.tsx` binds its field-name input directly to `fieldName`, so a user
  clearing it empties the value, `ann.data` is also `''` for every form-field type, and the
  fallback chain lands on the shared literal. ~~Fixed 2026-09-16~~ — the final fallback is now
  `` `field_${ann.id}` `` — `ann.id` is unique per annotation, so two independently-cleared
  fields never collide.
  `src/core/operations.ts` (`extractFormFieldsToCreate`)
- [x] **H9 — `finally { await api.closeDocument(handle); }` can mask the original error.**
  18 call sites total (more than the audit's cited ~9); 5 already guarded with
  `.catch(() => {})`, 13 did not. ~~Fixed 2026-09-16~~ — all 18 now discard a `closeDocument`
  rejection instead of letting it overwrite whatever the `try` block itself threw.
  `src/core/operations.ts`
- [x] **H10 — `activePageIndex` isn't clamped after `deletePages()` shrinks the page array,**
  leaving it able to point out of bounds. ~~Fixed 2026-09-16~~ — `deletePages` now clamps
  `activePageIndex` to the shrunk page count when the mutated document is the active one.
  `src/core/store.ts`
- [x] **H11 — Session autosave's 500ms debounce leaves a crash window** where `closeDocument`
  has already deleted OPFS bytes a recovery record still points to. **Not a live bug** — this
  exact race is already the documented reason `checkRecovery()` exists (its own docblock,
  `session-recovery.ts:104-118`): it validates every source's bytes actually still exist via
  `sourceBytesExist()` before ever offering a restore, and drops any document whose bytes are
  gone. Confirmed wired in at `AppShell.tsx:113`, ahead of `restoreSession()`. The debounce
  window exists, but it cannot produce a silently-corrupt restore because of this gate.
  `src/core/session-recovery.ts`
- [x] **H12 — `splitDocument` has no empty-pages guard** (unlike `composeDocument`), risking a
  worker crash or malformed output on an empty split. ~~Fixed 2026-09-16~~ — added the same
  `if (request.pages.length === 0) throw internal(...)` guard `composeDocument` already has.
  `src/core/operations.ts`
- [x] **H13 — `diff-preview.ts` leaks detached canvases.** `document.createElement('canvas')`
  is never cleaned up after `ImageData` extraction; repeated diffs accumulate orphaned GPU
  backing stores until GC gets to them. ~~Fixed 2026-09-16~~ — zeroes the canvas's `width`/
  `height` after extracting `ImageData`, forcing its backing store to release immediately
  instead of waiting on GC. `src/core/diff-preview.ts`

### Medium

- [x] **M1** `deletePages` allows deleting every page, producing a 0-page document that breaks
  export. **Not a bug — deliberate.** `commit.ts:1913-1926` documents this explicitly: a 0-page
  document is "a legitimate way to clear a document before starting over," and `commitTool`
  already catches it before any handler runs, showing "Nothing to export" instead of the
  `InternalError` this would otherwise surface deep inside `composeDocument`. No change made.
  `src/core/store.ts`, `src/ui/tools/commit.ts:1909-1926`
- [x] **M2** `Tooltip.tsx`'s `cloneElement` silently overwrites a child's existing
  `onMouseEnter`/`onMouseLeave`/`onFocus`/`onBlur`/`onKeyDown` handlers. ~~Fixed 2026-09-16~~ —
  added a `compose()` helper so the tooltip's handler now runs the child's own handler first,
  then its own, instead of replacing it. Also fixed L2 (same file: the hide-timer `setTimeout`
  had no unmount cleanup) alongside it. `src/ui/components/Tooltip.tsx`
- [x] **M3** `web.ts`'s `revokeHandle` calls IndexedDB unconditionally, unlike its siblings
  which gate on `hasFileSystemAccess()`. ~~Fixed 2026-09-16~~ — gated the same way its siblings
  already are. `src/platform/web.ts`
- [x] **M4** `pixel-diff.ts` sums the alpha channel into the diff but thresholds against
  765 (RGB-only), so an alpha-only difference can be flagged as "changed." ~~Fixed
  2026-09-16~~ — dropped alpha from the sum so it matches the RGB-only threshold it's actually
  compared against. `src/core/pixel-diff.ts`
- [x] **M5** `markdown-to-pdf.ts`: `(token.header?.length ?? 1)` — an empty (not nullish)
  header array divides by zero, producing `colWidth: Infinity`. ~~Fixed 2026-09-16~~ — wrapped
  in `Math.max(…, 1)`, which catches zero the way `?? 1` never could. `src/core/markdown-to-pdf.ts`
- [x] **M6** `markdown-to-pdf.ts`: an over-tall content block is clipped instead of re-flowed
  onto a fresh page. Narrowed after reading the actual code: text/heading/code/list content
  already advances line-by-line (each line's `advanceY` call is small and independently safe);
  the one real gap was a table row taller than a whole page. ~~Fixed 2026-09-16~~ — such a row
  now draws line-by-line across as many fresh pages as it needs, instead of past the bottom
  margin once. `src/core/markdown-to-pdf.ts`
- [x] **M7** `text-layout.ts`: `new Uint8ClampedArray(width*height*4)` for a 10000×10000 image
  (~400MB) has no try/catch or size guard. ~~Fixed 2026-09-16~~ — added a 40-megapixel cap
  (well above any real scanned page); `toRgba` now returns `null` past it, the same refusal
  path it already takes for an unrecognised layout, and the one caller
  (`render.worker.ts:2321`) already handles a `null` return. `src/core/text-layout.ts`
- [x] **M8** `import.ts`'s cancel check only runs between files — a single large HEIC/TIFF
  decode can't be interrupted. ~~Fixed 2026-09-16~~ — threaded an `AbortSignal` into
  `imageFileToJpegs`: checked after the (uninterruptible, third-party) HEIC decode, per-frame
  inside a multi-page TIFF's decode loop (the actual 30-second case), and per-image in the
  final bitmap/JPEG-encode loop. A single-file HEIC decode still can't be interrupted
  mid-call — no signal support in `heic2any` itself — but a multi-page TIFF and a multi-file
  batch now respond promptly. `src/core/image.ts`, `src/core/import.ts`
- [x] **M9** `store.ts`'s `bytesForPages` reads OPFS sources sequentially instead of via
  `Promise.all()`. ~~Fixed 2026-09-16~~ — collects the distinct source ids first, then reads
  them all concurrently. `src/core/store.ts`
- [x] **M10** `cropBoxes`/`pageAnnotations` entries for deleted pages/closed documents are
  never pruned from their global maps — unbounded growth over a long session. ~~Fixed
  2026-09-16~~ — added `pruneOrphanedPageState()`, called from `deletePages` and
  `closeDocument` with the page keys each is about to orphan; it drops an entry only once no
  open document's `pages` *or* `baseline` still references that key. (A global reactive
  `effect()` over `documents` was tried first and reverted — it fired during tests that
  manipulate `documents`/`pageAnnotations` independently of the normal mutators and wrongly
  pruned data those tests still expected; the targeted, mutator-scoped version below has no
  such blast radius.) `src/core/store.ts`
- [x] **M11** `app.tsx`/`mountLanding.tsx`: `void initLocale()` fires async while `render(<App/>)`
  runs synchronously right after — a flash of unlocalized content. ~~Fixed 2026-09-16~~ —
  both now await `initLocale()` before their first `render()`, the same way `initTheme()`
  already avoids a flash; the dictionary is a bundled asset (dynamic `import()`, no network
  fetch), so the added wait is imperceptible. `src/ui/app.tsx`, `src/ui/mountLanding.tsx`
- [x] **M12** `db.ts`'s in-memory search-index fallback (when IndexedDB is unavailable) has no
  size bound. ~~Fixed 2026-09-16~~ — capped at 20,000 records, evicting the oldest (insertion
  order) once full — same shape as `BitmapCache`'s eviction. `src/core/db.ts`
- [x] **M13** `signatures.ts`'s `loadSignatures` has no error handling; a rejected
  `listSignatures()` looks identical to "no saved signatures." **Inaccurate as stated** —
  `listSignatures()` (`db.ts`) is wrapped in `guard()`, which catches every internal error and
  always resolves (never rejects), logging via `logEvent`. No unhandled-rejection risk exists
  here. No change made. `src/core/signatures.ts`, `src/core/db.ts`
- [x] **M14** `core/i18n/index.ts`: `localStorage.setItem()` can throw in private browsing,
  uncaught. ~~Fixed 2026-09-16~~ — wrapped in try/catch (locale still applies for the session;
  just isn't remembered). Also guarded the matching `localStorage.getItem()` in `initLocale`
  for the same reason. `src/core/i18n/index.ts`
- [x] **M15** `shortcuts.ts`'s module-level `readSetting` promise chain has no `.catch`.
  ~~Fixed 2026-09-16~~ — added a `.catch` (logs via `logEvent`); the one realistic throw inside
  the callback (`localStorage.getItem`, same private-browsing case as M14) is now covered by
  it. `src/core/shortcuts.ts`
- [x] **M16** `cv/edgeDetection.ts`'s `douglasPeucker` recurses with no depth limit — risk of
  stack overflow on a ~56k-point contour. ~~Fixed 2026-09-16~~ — rewritten iteratively with an
  explicit `[start, end]` index stack over the original array instead of recursive slicing;
  identical output (verified against the existing edge-detection test suite, unchanged
  results), no recursion, and avoids the repeated array-copy overhead the recursive version
  had at every level. `src/core/cv/edgeDetection.ts`
- [x] **M17** `cv/enhance.ts`'s `rotateImageData` can ~2× the pixel count at `fit=true` with no
  budget check. ~~Fixed 2026-09-16~~ — added a 40-megapixel cap on the `fit` output size; past
  it, falls back to the input's own dimensions rather than growing unbounded. The one current
  caller (`deskewAndCrop`, bounded to ±15°) never approaches this, so this only protects
  future callers of the exported function. `src/core/cv/enhance.ts`
- [x] **M18** `formula.ts`'s tokenizer is O(n × fieldNames) — slow with many fields and a long
  formula. ~~Fixed 2026-09-16~~ — replaced the per-position linear scan over every field name
  with a trie built once per `tokenize()` call; a lookup at each position now costs
  O(matched name length) instead of O(fieldNames.length). All 53 existing formula tests pass
  unchanged, including the longest-match case. `src/core/formula.ts`
- [x] **M19** `faceblur/detect.ts`: a `tf.tensor3d` disposed in `finally` still leaks if the
  worker is terminated externally mid-inference. **Not actionable from this code.**
  `Worker.terminate()` destroys the entire JS realm instantly — no `finally`, no cleanup
  handler, nothing user-level runs at all when a worker is externally killed, in this codebase
  or in general. The browser reclaims the terminated worker's own GPU/WebGL context (and
  whatever it held) as part of tearing down that worker, not as a leak surviving past it. No
  change made. `src/core/faceblur/detect.ts`

### Low

- [ ] **L1** `supportsFileSystemAccess` is evaluated once at module load in both
  `extension.ts`/`web.ts` (`src/platform/`). **Deferred** — the field is part of the
  `PlatformAdapter` interface (`readonly supportsFileSystemAccess: boolean`); making it live
  would mean changing every call site from a property read to a method call, a wider,
  riskier change than this Low finding warrants. In practice `hasFileSystemAccess()` is a
  `typeof window.showOpenFilePicker === 'function'` check — real browser globals are already
  present by the time any module executes, so "runs before `globalThis` is initialised" is not
  a realistic failure mode here. No change made.
- [x] **L2** `Tooltip.tsx`'s hide `setTimeout` has no unmount cleanup. ~~Fixed 2026-09-16~~ —
  fixed alongside M2 (added a `useEffect` cleanup that clears the timer). `src/ui/components/Tooltip.tsx`
- [x] **L3** `fsa.ts`'s `isAbort` only checks `AbortError`, not `NotAllowedError`
  (page-not-focused). ~~Fixed 2026-09-16~~ — `isAbort` now also matches `NotAllowedError`
  (Chromium's actual name for "picker blocked, page lost focus"), so all three call sites
  treat it as a silent no-op instead of surfacing a generic `InternalError` for what is really
  "just click the button again." `src/platform/fsa.ts`
- [x] **L4** `file-system.ts`'s `saveViaDownload` always returns `true` — no way to detect a
  failed anchor-download. **Inherent platform limitation** — the `<a download>` technique has
  no completion event and no error channel once `click()` returns; there is no browser API
  that reports back whether the save actually succeeded. ~~Narrowed 2026-09-16~~ — wrapped in
  try/catch so a genuine *synchronous* failure (e.g. `Blob`/`createObjectURL` throwing)
  correctly returns `false`, and documented the ceiling on what this can ever detect so a
  caller doesn't mistake `true` for a completion guarantee. `src/platform/file-system.ts`
- [ ] **L5** `service-worker.ts`'s `chrome.action.onClicked` doesn't extend the MV3 SW's
  lifetime across an async `openEditor()`. **Likely already adequate, not independently
  verifiable here** — the listener already returns the promise chain (Chrome's documented
  mitigation for exactly this), and every step inside `openEditor()` is a tightly-chained
  awaited `chrome.*` call, which itself resets the service worker's idle timer while pending.
  Confirming the precise remaining risk window needs real Chrome MV3 lifecycle testing this
  environment can't do; no speculative change made.
- [x] **L6** `image.ts`'s TIFF decode holds many intermediate canvases simultaneously
  (~2GB for a 20-page/25MP TIFF). ~~Fixed 2026-09-16~~ — zeroes each iteration's canvas
  dimensions after use, same fix as H13/`diff-preview.ts`. `src/core/image.ts`
- [x] **L7** `open-document.ts` generates a duplicate, differently-UUID'd set of page refs,
  ignoring `imported.pages`. ~~Fixed 2026-09-16~~ — uses `imported.pages` (already built by
  `importFiles`) directly instead of calling `makePageRefs` a second time.
  `src/core/open-document.ts`
- [ ] **L8** `errors.ts`'s diagnostic log uses `Array.shift()` (O(n)) on overflow instead of a
  circular buffer. **Not worth fixing** — capped at 200 entries, a `shift()` there costs low
  microseconds; a circular buffer would add real complexity to `getLog()`/`buildDiagnostic()`'s
  straightforward chronological iteration for no measurable benefit. No change made.
- [x] **L9** `text-layout.ts`'s line grouping is O(items × lines) via `lines.find(...)`.
  ~~Fixed 2026-09-16~~ — items are visited in non-increasing baseline order, so only the
  most-recently-opened line can ever match (proved in the code comment); checking just that
  one line instead of scanning every line turns this into O(items). All 33 existing
  text-layout tests pass unchanged. `src/core/text-layout.ts`
- [x] **L10** `shortcuts.ts`'s fire-and-forget `void writeSetting(...)` calls can reorder under
  rapid calls. ~~Fixed 2026-09-16~~ — see M15 above; chained onto one `writeChain` promise so
  writes complete in call order. `src/core/shortcuts.ts`
- [x] **L11** `barcode.ts`: `QRCode.create` throwing on oversized data isn't given a
  user-friendly message. ~~Fixed 2026-09-16~~ — wrapped in try/catch with a clear message.
  `src/core/barcode.ts`
- [x] **L12** `faceblur/logoMatch.ts` uses Rec. 601 luma while `cv/enhance.ts` uses Rec. 709,
  despite a comment claiming the same weighting. ~~Fixed 2026-09-16~~ — switched to Rec. 709
  to match what the comment already claimed; all faceblur/logo-match tests (including the
  brightness-shift-normalisation case) pass unchanged. `src/core/faceblur/logoMatch.ts`
- [x] **L13** `core/i18n/index.ts`: a failed locale import still sets `currentLocale.value`,
  so translations silently fall through to raw keys with no failure signal. ~~Fixed
  2026-09-16~~ — see M14 above; `setLocale` now only updates `currentLocale` once the
  dictionary actually loaded (or was already cached), leaving the prior locale in effect
  otherwise. `src/core/i18n/index.ts`
- [x] **L14** `annotation-summary.ts`: a single oversized annotation overflows below the page
  margin instead of wrapping. ~~Fixed 2026-09-16~~ — a card taller than one whole fresh page
  can hold (a single "card" rectangle can't reasonably span pages the way a table row can) now
  truncates its text with a visible "N more lines not shown" note instead of drawing past the
  bottom margin. `src/core/annotation-summary.ts`
- [x] **L15** `highlight.ts`: `Math.max(region.height * page.aspect, 0.001)` returns `NaN` if
  `page.aspect` is `NaN`. ~~Fixed 2026-09-16~~ — falls back to a square aspect (`1`) when
  `page.aspect` isn't a finite positive number. `src/core/highlight.ts`
- [ ] **L16** `client.ts`'s `FinalizationRegistry`-based pinned-client cleanup is
  non-deterministic (GC may never run in a short-lived context). **Accepted, matches the
  report's own framing** — this is `FinalizationRegistry`'s documented behaviour everywhere,
  not specific to this code; every caller of `pin()` already calls `release()` explicitly
  (confirmed: `render-cache.ts`'s `closeRenderHandle`, and the other `pin()` call sites), so
  the registry is a backstop for a leaked reference, not the primary cleanup path. No change
  made.
- [x] **L17** `ocr/runOcr.ts`: `Promise.all` rejecting on the first failed model download
  leaves other in-progress downloads running in the background, confusingly. ~~Fixed
  2026-09-16~~ — switched to `Promise.allSettled`, waiting for every download and reporting
  every failure together instead of only the first. All 31 existing OCR tests pass unchanged.
  `src/core/ocr/runOcr.ts`
- [x] **L18** `faceblur/download.ts` loads the full response body into memory before checking
  `MAX_SHARD_BYTES`. ~~Fixed 2026-09-16~~ — checks the `Content-Length` response header before
  buffering the body, refusing early when the server honestly reports an oversized response.
  Not a complete guard (a server that lies about or omits the header still hits the existing
  post-buffer check), but turns the common case into an early refusal instead of an OOM risk.
  `src/core/faceblur/download.ts`

### Architectural

- [ ] **G1** No per-document undo history — one global stack, wiped by closing any document.
  **Narrowed by the H6 fix above** — closing a document no longer wipes the *other* open
  documents' history (only its own entries are stripped from each snapshot); the deeper
  architectural change (each document keeping its own independent undo stack, rather than one
  shared stack of whole-workspace snapshots) is unchanged and would be a substantial redesign,
  out of scope for this pass.
- [ ] **G2** No maximum open-document count; each holds OPFS refs, render handles, page-ref
  arrays with no ceiling. Not addressed — a real product decision (what the ceiling should be,
  how to communicate it) rather than a bug fix, out of scope here.
- [x] **G3** Single confirmation-request signal, no queue — **fixed by the C1 fix above**,
  which adds exactly this queue for all three modal request signals.
- [ ] **G4** A crashed worker gets no automatic retry — the in-flight lease just rejects and a
  toast tells the user to retry manually. Not addressed — automatic retry policy (how many
  attempts, what backoff, whether a retry is even safe for a partially-mutated operation) is a
  product design question, out of scope for this pass.

**Status after this pass:** all 5 Critical, all 13 High (2 fully open — H3's real fix is a
worker migration, H11 was already correctly mitigated), all 19 Medium (1 not a bug, 1
inaccurate as stated, 1 not actionable), and 15 of 18 Low items fixed or resolved; 3 Low items
and G2/G4 left open with reasoning above. 1425/1425 existing tests pass throughout; `tsc
--noEmit` clean throughout.

## Suggested order of attack

1. Redaction's vector/image handling (§1) — security-relevant, silent failure, highest risk.
2. OPS-13 flatten-background (§11) — currently produces blank pages / cross-page corruption
   on its core use case; effectively unshipped despite `Status: Done`.
3. SGN-06 default-flattens its own output, and ACC-01/CMP-06's stale-signal bleed
   (§11, §12) — all silent-wrong-output classes, same fix shape (staleness/reset guards).
4. Shared catalog-stripping bug (§0) — one fix, two call sites, already solved a third place.
5. Rotation coordinate mapping (§3, and its reappearance in SGN-06 §11) — six tools now,
   one root cause, one fix, worth a shared helper/lint rule so it stops recurring.
6. DS-09 keyboard-unreachable remap rows (§12) — hard accessibility invariant violation.
7. Dead export buttons — contact sheet (§5), table extraction (§6) — trivial wiring fixes.
8. SGN default settings deleting form fields (§7, original pass) — one default flip +
   resource-dict fix.
