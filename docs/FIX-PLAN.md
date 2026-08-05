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

## Chunk 2 — Finish the P0 tools that got partial UI (M–L, can split by ticket)

- [ ] **OPS-08 watermark** — **start-at and page-range targeting are now done**, and
      the preview scales point-based font/padding values to the rendered page. Still add
      image watermark, real header/footer (distinct from the single text stamp), and a
      CJK-safe font/error path instead of the current WinAnsi exception.
- [ ] **SGN-02 placement** — add keyboard paths for resize, rotate, and initial
      placement (currently pointer-only); add snap-to-detected-signature-line during
      drag; fix pixel accuracy on rotated pages (pdf-lib `getSize()` vs pdf.js viewport
      disagree on rotation).
- [ ] **OPS-07 N-up** — stop discarding page rotation and crop boxes on `embedPage`; use
      per-page dimensions instead of page-0-only for sheet sizing.
- [ ] **CMP-05** — either tighten the preview pipeline to hit 400ms (debounce/compress
      cost) or move the budget's goalposts with the user's sign-off; fix the
      size-projection heuristic (currently 20–84% off vs a 15% budget) to actually model
      the raster route; add keyboard/ARIA support to `CompareSlider`.
- [ ] **CMP-03** — extend mask resampling to the "small image, large mask" case that's
      still gated on `dimensionsChanged`; add a real CMYK-fixture test with a documented
      tolerance.

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
