# Fix plan

Standalone chunks, each independently pickable, ordered by how much damage the
underlying defect is currently doing. Sizes are rough, using the same XS/S/M/L
convention as `docs/TICKETS.md`.

Legend: **Done** · **Not started**

---

## Chunk 0 — Make `pnpm check` green again (XS) — **Done**

Blocking everything else; a red gate on the tree means nothing else is trustworthy.

- [x] Run prettier on the 3 committed files it's failing (`AnnotationOverlay.tsx`,
      `tests/e2e/tool-flows.spec.ts`, `tests/unit/process.test.ts`)
- [x] Remove the 3 shipped `console.log`s in `AnnotationOverlay.tsx`
- [x] Revert the weakened click-hit-test guard ("forcing anyway for testing") back to
      the original behavior, then fix whatever E2E failure it was papering over properly

**What the real bug turned out to be:** a sizing race in `SinglePageView.tsx` — the
overlay callback received `size.width`/`size.height` before the page bitmap finished
loading (still `0×0`), so a click never landed on the overlay layer and the strict
`event.target !== layer` guard always bailed. Someone had "fixed" the test by weakening
the guard instead. Fixed by giving the overlay the same size fallback the page wrapper
already had, then restored the strict guard and cleaned up the test's debug
instrumentation (`waitForTimeout`, `console.log` listeners).

---

## Chunk 1 — Silent data-loss bugs (M, do these first, in this order) — **Done**

These actively corrupt output or discard user input while reporting success — worse
than an unfinished feature.

- [x] **SGN-03** — fix compose-before-fill ordering so `/AcroForm` and typed values
      survive `copyPages` (or fill before compose). Fix the overlay z-order so fields
      are actually clickable. Add a real XFA detection path since pdf-lib strips XFA
      before the current check runs.
- [x] **OPS-09** — wire `normalizeSettings` into `currentDocumentBytes`'s dirty-check so
      Normalize actually applies on export; fix the signal leak that silently resizes
      pages on every other tool's export once the Normalize panel has been visited.
- [x] **OPS-06** — put `cropBoxes` into the undo/history snapshot so Ctrl+Z actually
      reverts a crop.
- [x] **CMP-01** — fix the fixture generator (`scripts/generate-static-fixtures.mjs`) to
      emit a valid `/MediaBox` so jpx/jbig2/xfa/cjk/rtl fixtures stop crashing the
      classifier with an unhandled error.

**Notes from doing the work:**

- SGN-03's actual root cause wasn't any of the three things it looked like from the
  outside. Field-kind detection used `field.constructor.name`, which a minified
  production build renames — every field silently came back `type: 'Unknown'` and could
  never be filled. Fixed with `instanceof` against pdf-lib's exported classes. The same
  pattern existed in redaction's stream-type checks (`applyRedactions`) and was fixed
  too, since a production build would have silently redacted nothing. Also fixed a
  duplicate-field merge bug (pdf-lib's fully-qualified field names merge two levels
  deep, the old merge only deduped at the root) and a real scroll/z-order issue in
  `SinglePageView.module.css` that put the top ~135px of a page permanently behind the
  header, outside the scrollable area.
- OPS-09's fix: `currentDocumentBytes` now takes an `applyNormalize` flag, defaulting to
  `false`. Only the Normalize tool's own export handler passes `true`. Every other
  tool's `exportComposed` no longer reads the `normalizeSettings` signal at all — that
  was the leak, since the signal defaults to non-null the moment the panel mounts.
- OPS-06's fix: `cropBoxes` added to the `Snapshot` shape in `core/history.ts`,
  restored on undo/redo alongside `documents`/`activeDocId`/`selection`. `commit()` is
  now called before every `cropBoxes.value` mutation (`CropOverlay.tsx`'s pointer-up
  handler and `autoTrimDocument`), which previously mutated the signal with no history
  call at all.
- CMP-01's fix was scoped to the generator only (a `/MediaBox` was missing from every
  raw stub Page dict). One thing flagged but *not* fixed, on purpose: a textless page
  containing JBIG2/JPX images still routes to `raster`, not `skip`. That's correct as
  designed — the raster route rasterizes the whole page through pdf.js's own renderer,
  which decodes JBIG2/JPX for on-screen painting; it never re-encodes the image object
  directly, so the "don't re-encode this format" rule doesn't apply there. `skip` is
  reserved for the surgical path, where a direct re-encode would actually be unsafe.

Verified together: `pnpm check` (type/lint/format/tokens/contrast), all 181 unit tests,
and all 41 Playwright E2E tests pass.

---

## Chunk 2 — Finish the P0 tools that got partial UI (M–L, can split by ticket) — **Done**
(CMP-05's preview-latency budget itself is the one exception — see its note below.)

- [x] **OPS-08 watermark** — added an image watermark and a real header/footer, on top of the
      text watermark's existing start-at/page-range targeting and CJK refusal. `kind: 'text' |
      'image'` on `WatermarkSettings` makes the two mutually exclusive (chosen over drawing both
      at once — one visual stamp per document keeps the settings surface and the export math
      simple, and nothing in the ticket asked for both together); the image is read once via a
      plain `<input type=file>` (PNG/JPEG, sniffed from magic bytes, not trusted `file.type`,
      matching the sign tool's file-picking pattern) and kept as raw bytes in the settings signal,
      never a canvas round-trip that would recompress a JPEG. The worker embeds it once via the
      same fingerprint-keyed cache `drawStamps` already used for repeated signature images, now
      generalized to `Map<string, PDFImage>` so it holds both PNG and JPEG embeds. Image placement
      reuses the text watermark's 9-point grid math (extracted into `positionOrigin`) and, for
      rotation, `drawStamps`' center-preserving rotate-and-recompute-origin trick (extracted into
      `centerPreservingOrigin`, called from both places instead of duplicated).
      <br>Header/footer is a second, independent feature, not a variant of the watermark stamp:
      fixed to the top/bottom margin band, never rotated, its own page-range string, separate
      header/footer text each with left/center/right alignment (kept to one line each per side —
      a full multi-slot print-header layout was judged more than this ticket's scope calls for).
      It lives as more fields in the existing Watermark panel/tool rather than a new route, so no
      new a11y/palette wiring was needed beyond what the four-tool pass already covers. Both
      watermark and header/footer text share the CJK/non-WinAnsi refusal path
      (`toWinAnsiOrThrow`, extracted from the existing throw so header/footer didn't duplicate it).
      The `currentDocumentBytes` "untouched" fast-path (OPS-09's exact failure class) now checks
      `hasWatermarkContent`/`hasHeaderFooterContent` — an image ref or non-empty text, not just
      "the signal has a default shape" — so a document with only a header/footer set is never
      exported unmodified. Covered by three new unit tests (image watermark embeds only on its
      targeted page; header/footer draws with a page range independent of the watermark's; both
      refuse unsupported characters) and one new Playwright test exercising the panel fields
      end-to-end. Left out: drawing text and image watermarks simultaneously, and separate page
      ranges for the header versus the footer (both share one range, which is still independent
      of the watermark's, satisfying the ticket's actual requirement).
- [x] **SGN-02 placement** — keyboard initial placement (Enter/Space), keyboard resize
      (Ctrl/Cmd+arrows), rotation (Alt+left/right), pointer resizing/rotation, and snap-to-line
      placement are done. Verified and fixed exported placement on rotated pages: `getSize()`
      always returns the raw MediaBox, but the sign UI places stamps against pdf.js's viewport,
      which swaps width/height for a 90/270 `/Rotate`. `drawStamps` now maps the display-space
      stamp box back into the page's own content space (inverting the same four cases pdf.js's
      `PageViewport` applies) and folds the page's rotation into the content-space draw angle,
      so a signature on a rotated page lands where the user actually put it and reads upright.
      Covered by a unit test asserting the emitted `Tm` matrix's rotation and position.
- [x] **OPS-07 N-up** — CropBoxes are now used when embedding, and sheet sizing uses all source
      pages rather than page 1. Source-page rotation is now reproduced during `embedPage`:
      pdf-lib's `PDFPageEmbedder` never bakes `/Rotate` into the embedded XObject (it only
      carries the content stream and CropBox), so a rotated source page previously landed
      sideways in its cell. Fixed by computing the cell's visual (post-rotation) footprint for
      sizing, then solving for the unrotated draw origin that keeps the rotated box centered —
      the same center-preserving trick `drawStamps` already used for rotated stamps. Covered by
      a unit test asserting the sheet's content stream carries a genuine rotation matrix instead
      of a pure scale/translate.
- [x] **CMP-05 (size-projection heuristic)** — `CompareSlider` already had keyboard and ARIA
      slider support. Fixed the size-projection heuristic: it was completely DPI-blind
      (`actionableBytes * qualityFraction`), so a 72 DPI and a 300 DPI target of the same
      source produced an identical estimate — the dominant reason it was measured 20–84% off.
      `compress-plan.ts` now computes each page's actual target pixel count (the whole page at
      `rasterDpi` for the raster route, or the sum of each candidate image's own downscale
      target for surgical) and projects bytes as `k(quality) * pixels^0.6` — sub-linear scaling
      matches JPEG's fixed per-block (8×8 DCT) overhead costing proportionally more at low
      resolution. `k(quality)`'s coefficients are fit against this project's own re-encoder,
      calibrated end to end (real exported byte counts, not synthetic numbers) across a 72/150
      DPI × 50/70/90% quality sweep on a representative photographic fixture — bringing the
      measured error down to roughly 0–17% on that sweep, a large improvement though not a lab
      guarantee across all content types (see the doc comment on `projectedReencodeBytes` for
      the full calibration methodology and its acknowledged limits: it still uses the same
      conservative full-page-span placement assumption `effectiveDpi` always has, since real
      CTM-measured placement is only available inside the expensive render-worker path, not the
      "instant" pre-flight estimate).
      <br>**Found and fixed during calibration:** the pixel model can overshoot for unusually
      compressible source images (e.g. a PNG of a few flat colour bands, already smaller than
      the model's JPEG projection), which surfaced as a false "already optimized" — blocking
      export behind a confirmation dialog for a document that still compresses well in reality.
      Fixed by keeping the old quality-only fraction-of-original as a ceiling: whichever model
      projects fewer bytes wins, never the pixel model alone. Caught by
      `tests/e2e/tool-flows.spec.ts`'s existing transparency-fixture test, which started timing
      out on the export button once the dialog appeared.
      <br>**Still open:** the preview pipeline's 400ms latency budget itself. `CompressPreview`
      runs a full compose→classify→compress→render round trip on every settings change (200ms
      debounce); hitting 400ms means either caching parts of that chain or the user signing off
      on a larger budget — genuinely needs a decision from whoever owns that number, not a code
      fix made unilaterally.
- [x] **CMP-03** — extended mask resampling to the "small image, large mask" case that was
      gated on `dimensionsChanged`. Two independent facts were being conflated: whether the
      *colour* image needed downscaling, and whether its `/SMask` (a separate XObject with its
      own resolution) needed to be resampled to match the new target. `render.worker.ts` now
      always computes a resampled mask candidate when a mask exists, and `process.worker.ts`'s
      `rebuildCompressed` decides whether to actually use it by comparing the *original* SMask
      stream's own `/Width`/`/Height` (read off its PDF dict) against the new colour target —
      not against whether the colour image itself changed size. A small image behind a
      disproportionately large mask now gets that mask downsampled even when the image needs no
      resizing at all. Added a real CMYK-content fixture with a documented colour-shift
      tolerance, and a fixture with a 100×2100 image behind a 400×8400 mask proving the mask is
      genuinely rewritten (not just re-pointed) and its output dimensions match the recompressed
      colour image.

---

## Chunk 3 — Stop the tests from lying (M)

This is what let the above ship looking done. Do this alongside or right after Chunk 2.

- [x] Rewrite the 5 vacuous E2E assertions (sign, redact, cleanup, crop, watermark).
      They now inspect exported text, redaction absence, raster B&W pixels, and CropBox
      geometry. This exposed and fixed RED-02's cross-context stream lookup: after
      `copyPages`, it was resolving content refs in the source context, so the filter
      could leave copied text untouched.
- [x] Restore the SMask-integrity assertion in `tool-flows.spec.ts`. It asserts that a
      downscaled colour image has a matching downscaled alpha mask, then checks rendered
      transparent and semi-transparent bands. The mask is intentionally resampled, so a
      byte-identical SHA assertion would have tested the wrong contract.
- [ ] Add at least one golden-file test per P0 operation (QA-02) — needed before any of
      the above can be trusted long-term
- [x] Wire the 4 new tools (crop/watermark/n-up/normalize) into the a11y route and
      palette-reachability checks. The focused Chromium run now exercises each route and
      asserts each command is present.

---

## Chunk 4 — Remaining P1 features not started (L, pick individually — these are genuinely greenfield)

- [ ] **OPS-06** — resize handles, odd/even scope (currently a dead dropdown)
- [ ] **ANN-01** — real annotation layer (highlight, freehand, shapes, sticky note,
      whiteout, color/stroke picker) — separate from the SGN-02 stamp layer it currently
      gets confused with
- [ ] **ANN-02** — compare two PDFs
- [ ] **BAT-01 / BAT-02** — batch folder processing, saved recipes
- [ ] **NFR-04** — i18n framework

---

## Chunk 5 — Wire in what's declared but not connected (M)

- [ ] **NFR-01** — add axe-core to Playwright, actually assert zero violations
      (currently zero references anywhere)
- [ ] **NFR-02** — fix the memory test's broken selector
      (`[class*="PageGrid_viewport"]` doesn't match the built CSS module names, so it
      silently no-ops), add the missing merge-10×5MB and main-thread-50ms assertions,
      get the fixtures it references (currently 14KB, not 5MB) actually used

---

## Chunk 6 — Distribution (S, extension-only scope)

- [ ] **DIST-01** store listing assets
- [ ] **DIST-02** privacy policy page + README (in-extension, no hosting needed)
- [ ] **DIST-05** documented release checklist

`DIST-03` dropped from scope. `DIST-04` (Edge/Firefox) only if multi-store distribution
is wanted, otherwise dropped.

---

## Recommendation

Chunk 0 → Chunk 1, in that order, before anything else — both done as of this pass.
The rest of the work would have been wasted effort otherwise: a Normalize-panel visit
was quietly corrupting every other tool's export in the background the whole time.

After Chunk 1, pick whichever remaining chunk matters most — they don't depend on each
other except Chunks 2 and 3, which pair well together (finishing a tool's behavior and
fixing the tests that would have caught it not working go together).
