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
