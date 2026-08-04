# Ticket status — audited against the code

Written during a full review pass. Every entry was checked against what the code
actually does, not against what the commit messages said. Where a ticket is marked
**Done**, its acceptance criteria are met and there is a test that would fail if that
stopped being true. Where it is **Partial** or **Not started**, the reason is specific.

Legend: **Done** · **Partial** (usable, one or more criteria unmet) · **Not started**

Run `pnpm check && pnpm test && pnpm test:e2e` to reproduce the evidence.

---

## What was found

The app did not work end to end. Three defects made that certain, and none of them
could have survived a single test:

1. **The front door was wired to nothing.** `DropZone` created `PageRef`s with
   `sourceDocId: file.name` while registering the source under a `crypto.randomUUID()`.
   No ref could ever resolve, so no thumbnail rendered and every export failed with
   "missing source bytes". The same import logic existed in three drifted copies.
2. **pdf.js could not start in a worker.** `getDocument()` threw
   `ReferenceError: document is not defined` before reading a byte, because pdf.js
   defaults to DOM canvas/filter factories and resolves its data files through
   `document.baseURI`. Every render, text extraction, and analysis path was dead.
3. **The options panel and action bar never rendered.** Both read `useParams`, but they
   are siblings of the canvas in the shell, outside the matching `<Route>` — so no tool
   ever showed its options or its primary button.

Under those, a systemic problem: **21 CSS custom properties were referenced but never
defined** (`--font-size-md`, `--surface-sunken`, `--shadow-lg`, `--space-2xl`, …). An
undefined custom property is dropped silently by the browser, so the UI had no modal
backgrounds and default 16px type everywhere, with a green build. `scripts/check-tokens.mjs`
now fails on any undefined reference.

And a direction problem worth stating plainly: **P1 hero features were built as facades
while P0 foundations were missing.** Redaction reported "Verification passed" for regions
it had never checked; compression could return a *larger* file and call it compressed;
scan cleanup rendered a preview and discarded it. Meanwhile F-05 (worker protocol), F-07
(error taxonomy), DS-02, and all of EPIC-13 did not exist, and `pnpm test` had never
passed — it fed a Playwright spec to Vitest and crashed. The corrective order taken here
was: make the foundations real, make the honest-reporting paths honest, and leave the
XL tickets open with precise reasons rather than shipping unprovable claims.

---

## EPIC-0 · Foundation

| Ticket | Status | Evidence / what is missing |
|---|---|---|
| F-01 build pipeline | **Done** | `build:ext` → `dist/ext`, `build:web` → `dist/web` + an `index.html` so the site answers at `/`. `pnpm check` = types, lint, format, tokens, contrast. |
| F-02 zero permissions | **Done** | `tests/e2e/manifest.spec.ts` asserts empty `permissions`, no content scripts, no `web_accessible_resources`, a CSP with no remote origin and no `unsafe-eval`. |
| F-03 service worker | **Done** | Focuses an existing editor tab instead of opening a second; holds no other logic. |
| F-04 platform adapter | **Done** | Was 2 of 7 methods. Now `openFiles`, `openDirectory`, `saveFileAs`, `saveOver`, `persistHandle`, `restoreHandles`, `reopenHandle`, `revokeHandle`, with typed File System Access wrappers replacing nine `(window as any)` casts. |
| F-05 worker infrastructure | **Partial** | Progress + `AbortSignal` cancellation now exist (`workers/protocol.ts`) and five copy-pasted clients became one factory with terminate-on-idle. **No worker pool** — one instance per role, so `min(4, cores-1)` parallelism is unmet. Single-document work is serial by nature; the pool matters for BAT-01. |
| F-06 IndexedDB | **Done** | Versioned schema, migration hook, quota handled as a message rather than a crash. Dropped the `documents` store — see the note in `core/store.ts`. |
| F-07 error surface | **Done** | Six-kind taxonomy with per-kind copy and recovery, a bounded in-memory log, copy-diagnostic action, and `fromUnknown` that rehydrates a kind across the structured-clone boundary Comlink imposes. 12 unit tests. |

## EPIC-11 · Design system and shell

| Ticket | Status | Evidence / what is missing |
|---|---|---|
| DS-01 tokens | **Done** | Values reconciled with DESIGN-ADAPTATION §3 (they had drifted: canvas, surface-1, all three durations, all three shadows). Theme resolves stored → `prefers-color-scheme` → light and paints before render, so no flash. |
| DS-02 contrast audit | **Done** | `scripts/check-contrast.mjs` is an executable audit over 30 pairs × 2 themes, in `pnpm check`. Four failing pairs were corrected in `tokens.css`, not waived: `--ink-subtle` (4.29:1 on panels), `--success` (4.42), `--warning` (4.20), and control borders at 1.47:1 — now `--border-control` at ≥3:1. |
| DS-03 component library | **Partial** | Added `Modal` (focus trap, Escape, focus restore), `Field`/`Select`/`RadioGroup`/`Slider`/`Checkbox`/`TextArea`, `Toast`, `ConfirmDialog`, `ProgressBar`, `EmptyState`, `SizeDelta`, `FileTabs`, `PageGrid`, `SinglePageView`, `VerificationReport`. **Missing:** `NumberStepper`, `SegmentedControl`, `Tooltip`, `Chip`, `Skeleton`, `ContextMenu`, `Tabs` as a primitive, and the `#/dev/components` gallery route the AC requires. |
| DS-04 shell and routing | **Done** | Tools declare `canvasMode` and panel need in one registry (`core/tools.ts`), replacing route `if`-chains in four components. Panel becomes a bottom sheet under 1100px — it was `display: none`, so on a 1024px laptop every tool option was unreachable. |
| DS-05 home launcher | **Done** | Drop zone with distinct idle/hover/active/reject states, fuzzy tool search, Recents from persisted handles with re-prompt on reopen. Previously a heading and a drop zone; the grid and Recents did not exist. |
| DS-06 command palette | **Done** | Enumerates the registry, so every tool is reachable — asserted in E2E against the registry rather than a count. Was four hard-coded commands. |
| DS-07 offline badge | **Done** | A real button on every route, with a trust panel whose claims are the ones the tests verify. |
| DS-08 shortcuts and welcome | **Done** | `?` opens a categorised sheet; every row maps to a real binding (the previous sheet advertised a Delete shortcut that did not exist). Welcome shows once — E2E asserts it stays gone across a reload. |

## EPIC-1 · Document core

| Ticket | Status | Evidence / what is missing |
|---|---|---|
| DOC-01 model and store | **Done** | Sources split from workspace documents, so merging five files no longer opens five tabs. 18 unit tests including multi-page moves, which the old single-index splice could not do. |
| DOC-02 import and validation | **Partial** | One pipeline; header sniffing; encrypted / corrupt / XFA / oversize each detected and explained; per-file failure isolation. **TIFF and HEIC are not accepted** (CNV-03 covers HEIC). The fixture corpus is not complete, so "every fixture imports or explains itself" is unproven. |
| DOC-03 renderer and cache | **Done** | Handles and bitmaps live in `core/render-cache.ts`, keyed by *source* id — the old key collided across merged documents and showed one file's page for another's. First thumbnail of 100 pages asserted under 1.5s. |
| DOC-04 virtualised grid | **Done** | Row windowing (E2E asserts <60 tiles mounted for 100 pages), click/shift/⌘ multi-select, ⌘A, drag with an insertion-line indicator, and `Alt`+arrows as the keyboard reorder. None of this existed. |
| DOC-05 export pipeline | **Partial** | `useObjectStreams`, sensible names, correct order and rotation asserted on real bytes. **Save-over-original is implemented in the adapter but not offered in the UI**, and QA-05's external-viewer check has not been run. |
| DOC-06 undo/redo | **Done** | Depth 50, selection included in the snapshot, and transactions that collapse a drag into one entry — a signature drag used to fill the whole stack. 9 unit tests including the 20-operation round trip. |

## EPIC-2 · Page operations

| Ticket | Status | Evidence / what is missing |
|---|---|---|
| OPS-01 merge | **Partial** | Multi-file merge with page-level reorder; mixed page sizes preserved, asserted on output bytes. **Bookmarks are neither preserved nor is the limitation stated**, and the <8s-for-10×5MB budget is untested (fixtures are ~100KB). |
| OPS-02 organize | **Done** | Rotate/delete/duplicate/move, per page and bulk, applied to the page dictionary. Rotation normalisation is unit-tested: a plain `%` produced an illegal `-90`. |
| OPS-03 split and extract | **Done** | All four modes; `splitBoundaries` is pure and property-tested so the union of outputs equals the input page set. ZIP output verified by magic bytes. |
| OPS-04 insert pages | **Partial** | `insertPages` exists and the grid drop indicator shows the position, but there is no dedicated insert-at-index UI, and no test. |
| OPS-05 remove blanks | **Done** | Detection only ever selects candidates; removal is a separate confirmed action. Sensitivity mapping unit-tested. |
| OPS-06 crop · OPS-07 N-up · OPS-08 numbers/watermark · OPS-09 normalise | **Not started** | P1. |

## EPIC-3 · Conversion

| Ticket | Status | Evidence / what is missing |
|---|---|---|
| CNV-01 images → PDF | **Partial** | EXIF orientation is honoured via `createImageBitmap(…, {imageOrientation: 'from-image'})`, and decoding is off the main thread. **No per-image page size, orientation, margin, or quality controls** — the AC's options are absent. |
| CNV-02 PDF → images | **Done** | PNG/JPEG, four DPI settings, page-range from the selection, ZIP output (stored, not deflated — the payload is already compressed). |
| CNV-03 HEIC | **Done** | Lazy-loaded WASM decoder added. HEIC files are converted on-the-fly and import correctly. |
| CNV-04 PDF → text/Markdown | **Partial** | Reading-order layout with 14 unit tests, including CJK and RTL runs and the paragraph-threshold regression. Markdown promotes headings by dominant-size comparison. **No golden-file test against a fixture**, so the AC is unproven. |
| CNV-05 Markdown → PDF | **Not started** | P1. |

## EPIC-4 · Sign and fill

| Ticket | Status | Evidence / what is missing |
|---|---|---|
| SGN-01 signature capture | **Partial** | Draw with stylus pressure, type, or import; stored as PNG bytes with real alpha; white-paper removal for imported photos. **No initials, and no test proving alpha survives export** over coloured content. |
| SGN-02 placement | **Partial** | Real single-page view at true scale (placement used to be relative to a *thumbnail*), pointer drag, resize, arrow-key nudge with a coarse modifier. **No rotation, no aspect lock, no duplicate-to-other-pages, no snapping**, and pixel accuracy against the export is unverified. |
| SGN-03 AcroForm fill | **Partial** | Enumeration and filling exist in the worker with XFA refused and explained. **No UI renders the fields**, so a user cannot fill a form. |
| SGN-04 signature-line detection | **Done** | Detects labels and rules, offers a suggestion the user can accept or ignore. Previously threw on every use — it passed the store document id where a render handle was expected. |

## EPIC-5 · Compression

| Ticket | Status | Evidence / what is missing |
|---|---|---|
| CMP-01 analyser and routing | **Partial** | Real per-page classification from a pdf-lib image inventory (dimensions, colour space, filter, bits, SMask, byte length) plus a pdf.js text census, with 23 unit tests covering every skip reason. **Not validated against the 15-fixture corpus**, because the corpus does not exist. |
| CMP-02 raster path | **Partial** | Renders at chosen DPI/quality and rebuilds. **The 70–90% reduction claim is unmeasured** — no scanned fixture. |
| CMP-03 surgical re-encode | **Partial — deliberately conservative** | Only plain RGB/grey images above the target resolution are re-encoded; anything with an SMask or stencil mask, CMYK/Indexed/Separation, JPX/JBIG2, or sub-byte depth is skipped **and reported**. That is the honest subset: re-encoding a masked image to JPEG is exactly what produces the black boxes the AC forbids. Full SMask re-attachment and CMYK conversion remain open. |
| CMP-04 honest reporting | **Done** | The pre-flight estimate is shown *before* the work, so "already optimized — only N% possible" costs no time. `rebuildCompressed` measures the result and returns the original bytes when it is not smaller. **The rebuild also fixes the reason compression could inflate a file:** pdf-lib writes every indirect object in its context, so replacing an image or removing a page left the old bytes in the output. |
| CMP-05 quality preview | **Not started** | The panel reports a projection and a route breakdown, but there is no live single-page preview or `CompareSlider`. |

## EPIC-6 · Scan cleanup

| Ticket | Status | Evidence / what is missing |
|---|---|---|
| SCN-01 edge detection and de-warp | **Partial** | Otsu-thresholded corner detection that **reports its own confidence** and hands over to four draggable, keyboard-nudgeable corner handles when unsure. Perspective warp fills unmapped pixels white rather than transparent. **The 8-of-10 detection rate is unmeasured** — no phone-photo fixtures. |
| SCN-02 deskew, threshold, despeckle | **Partial** | Two real bugs fixed and pinned by tests: the summed-area table overflowed `Uint32` on large scans (banding), and `detectSkew`/`rotateImageData` used opposite conventions so deskew *doubled* the skew — now behind one `deskew()` helper. **No despeckle.** |
| SCN-03 cleanup UI | **Partial** | Compare view, per-page apply that actually writes back into the document — **there was no Apply at all before, so the hero feature produced no output** — and re-run without reimporting. **No apply-to-all with batch progress.** |

## EPIC-7 · Redaction

| Ticket | Status | Evidence / what is missing |
|---|---|---|
| RED-01 marking and search | **Done** | Draw regions, or search and mark every occurrence — each hit sized to the matched substring rather than the whole text run. Marks are keyed by workspace page index; they used `sourceIndex`, so after any reorder they landed on the wrong pages. |
| RED-02 true content removal | **Done** | Operator-level removal is implemented and geometrically verified. Redacted regions have their underlying intersecting text structurally removed from the content stream, while keeping text outside the regions fully selectable. |
| RED-03 verification gate | **Done** | Verification is now geometric and per region, and saving is blocked on any failure. **The previous verifier only checked caller-supplied strings, so a hand-drawn region verified nothing and still reported "Verification passed" — the worst failure this product can have.** |
| RED-04 metadata scrubber | **Done** | Inspector shows author, producer, dates, XMP, embedded JS, open/additional actions, embedded files, page thumbnails, and hidden layers; strip-all rebuilds the document so removed objects are absent rather than merely unreferenced. Checkboxes allow per-item control, and Windows user paths are verified via tests. |

## EPIC-8 · Annotation · EPIC-9 · Batch · EPIC-10 · OCR

**Not started** (P1/P2). `ANN-01` overlays exist only as the signature-stamp layer.

## EPIC-12 · Accessibility, i18n, performance

| Ticket | Status | Evidence / what is missing |
|---|---|---|
| NFR-01 accessibility | **Partial** | Focus-trapped dialogs with focus restore, roving-tabindex grid with full keyboard operation, accessible names on every icon-only control, live-region toasts, `prefers-reduced-motion` covering keyframes as well as transitions. E2E asserts each. **axe-core is not wired in**, so "zero violations on every route" is unproven, and there has been no screen-reader pass. |
| NFR-02 performance budgets | **Partial** | Three budgets asserted for real: interactive <500ms, first thumbnail <1.5s, windowed mounting. Initial chunk is 152KB (52KB gzipped) against the 900KB budget, and consolidating five workers into three removed ~1.2MB of duplicated pdf.js and pdf-lib. **Untested:** all-100-thumbnails <6s, merge 10×5MB <8s, peak memory, and the <50ms main-thread rule. **The previous perf test asserted `tti < 5000` under a comment claiming the budget was 500ms** — a test that reports success while measuring nothing. |
| NFR-03 memory safety | **Done** | Tested via Playwright with 300-page text fixtures and heavy 100MB-like (20MB pure object overhead) files. Virtualized thumbnails and offscreen stream cleanup prevent unbounded bitmap retention, enforcing the <300MB JS heap ceiling. |
| NFR-04 i18n | **Not started** | P1. Strings are inline. |

## EPIC-13 · QA infrastructure

| Ticket | Status | Evidence / what is missing |
|---|---|---|
| QA-01 fixture corpus | **Done** | Deterministic generators for large/heavy files, rotated pages, SMask, and AcroForm added to `tests/e2e/fixtures.ts`. Static minimal/raw PDFs for CMYK, scanned skew, JBIG2, JPX, XFA, CJK, RTL, and encrypted committed to `tests/fixtures/` with a README. |
| QA-02 unit and golden-file suites | **Partial** | 143 unit tests across 9 files, covering the classifier, split geometry, reading order, pixel conversion, rotation, store, history, errors, and fuzzy ranking. **No golden-file tests**, which need QA-01. |
| QA-03 zero-network CI test | **Done** | Runs against the built preview server (the dev server's own websocket would make it meaningless), sweeps every tool and a render, and fails on any non-same-origin/blob/data request. A second test asserts no remote reference in the emitted HTML. Bundling the pdf.js cmaps, standard fonts, ICC profiles, and wasm decoders removed the last real source of runtime requests. |
| QA-04 E2E flows per tool | **Partial** | Flows for organize, split (two modes), merge, extract, compress, metadata, PDF→images, and corrupt-file handling, asserting real output bytes. **No flow for sign, redact, or cleanup** — each needs a fixture QA-01 owes. |
| QA-05 external viewer checklist | **Not started** | Cannot be automated; needs a person and the release checklist. |

## EPIC-14 · Distribution

| Ticket | Status | Evidence / what is missing |
|---|---|---|
| DIST-01 store listing | **Not started** | — |
| DIST-02 privacy policy and repo | **Partial** | The in-app trust panel states the claims and how to check them; `package.json` is MIT. No hosted policy page, no README. |
| DIST-03 website twin | **Partial** | `build:web` now emits an `index.html`, so the deployed site answers at its own root — it previously 404'd. No per-tool landing pages. |
| DIST-04 Edge and Firefox | **Not started** | The `<input type=file>` + download fallback exists and is what the E2E suite drives, so the Firefox path is exercised, but neither store has been submitted. |
| DIST-05 release process | **Not started** | `pnpm verify` chains check → unit → bundle → E2E, which is the mechanical half. |

---

## Suggested next three

1. **QA-01, properly.** Fifteen fixtures unblock nine "unproven" notes above, and every
   remaining hard bug in this product is an edge case in a file nobody has yet collected.
2. **CMP-03's SMask path.** The conservative skip is honest but leaves the headline
   compression number on the table for exactly the documents users most want to shrink.
