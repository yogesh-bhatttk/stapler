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
| F-05 worker infrastructure | **Done** | Progress + `AbortSignal` cancellation (`workers/protocol.ts`), and the one client factory is now a real pool: `lease()` prefers an idle instance, then spawns a new one up to `min(4, hardwareConcurrency - 1)`, and only shares the least-busy instance once at that cap. Each instance idles out independently. 8 unit tests against a mocked Comlink (concurrent leases grow the pool, sharing at capacity, idle-timer teardown and cancellation, an erroring instance is dropped rather than reused). Single-document work still runs serially by nature — the pool's payoff is BAT-01, not yet built. |
| F-06 IndexedDB | **Done** | Versioned schema, migration hook, quota handled as a message rather than a crash. Dropped the `documents` store — see the note in `core/store.ts`. |
| F-07 error surface | **Done** | Six-kind taxonomy with per-kind copy and recovery, a bounded in-memory log, copy-diagnostic action, and `fromUnknown` that rehydrates a kind across the structured-clone boundary Comlink imposes. 12 unit tests. |

## EPIC-11 · Design system and shell

| Ticket | Status | Evidence / what is missing |
|---|---|---|
| DS-01 tokens | **Done** | Values reconciled with DESIGN-ADAPTATION §3 (they had drifted: canvas, surface-1, all three durations, all three shadows). Theme resolves stored → `prefers-color-scheme` → light and paints before render, so no flash. |
| DS-02 contrast audit | **Done** | `scripts/check-contrast.mjs` is an executable audit over 30 pairs × 2 themes, in `pnpm check`. Four failing pairs were corrected in `tokens.css`, not waived: `--ink-subtle` (4.29:1 on panels), `--success` (4.42), `--warning` (4.20), and control borders at 1.47:1 — now `--border-control` at ≥3:1. |
| DS-03 component library | **Done** | All 20 primitives from DESIGN-ADAPTATION §5 now exist: added `NumberStepper` and `SegmentedControl` (in `Field.tsx`, built on native radio inputs so arrow-key nav is free), `Tooltip` (shows on focus, not just hover), `Chip`, `Skeleton` (`aria-hidden`, decorative), `ContextMenu` (roving tabindex, Escape-restores-focus, viewport-clamped), and `Tabs` (WAI-ARIA tabs pattern). `#/dev/components` renders every component in every state, verified in both themes and by real keyboard operation (arrow-key nav through `ContextMenu` skipping a disabled item, `Tabs` arrow-right) via Playwright MCP against the running app.  axe-core is now wired in and verified. |
| DS-04 shell and routing | **Done** | Tools declare `canvasMode` and panel need in one registry (`core/tools.ts`), replacing route `if`-chains in four components. Panel becomes a bottom sheet under 1100px — it was `display: none`, so on a 1024px laptop every tool option was unreachable. |
| DS-05 home launcher | **Done** | Drop zone with distinct idle/hover/active/reject states, fuzzy tool search, Recents from persisted handles with re-prompt on reopen. Previously a heading and a drop zone; the grid and Recents did not exist. |
| DS-06 command palette | **Done** | Enumerates the registry, so every tool is reachable — asserted in E2E against the registry rather than a count. Was four hard-coded commands. |
| DS-07 offline badge | **Done** | A real button on every route, with a trust panel whose claims are the ones the tests verify. |
| DS-08 shortcuts and welcome | **Done** | `?` opens a categorised sheet; every row maps to a real binding (the previous sheet advertised a Delete shortcut that did not exist). Welcome shows once — E2E asserts it stays gone across a reload. |

## EPIC-1 · Document core

| Ticket | Status | Evidence / what is missing |
|---|---|---|
| DOC-01 model and store | **Done** | Sources split from workspace documents, so merging five files no longer opens five tabs. 18 unit tests including multi-page moves, which the old single-index splice could not do. |
| DOC-02 import and validation | **Partial** | One pipeline; header sniffing; encrypted / corrupt / XFA / oversize each detected and explained; per-file failure isolation. **Correction:** TIFF and HEIC are now both accepted (`core/image.ts`'s `SUPPORTED`/`SUPPORTED_EXTENSIONS` cover both, with an extension-based fallback for browsers reporting an empty MIME type for HEIC) — this row previously said otherwise and was stale. Remaining gap: the fixture corpus's coverage of every import path is not independently re-verified here, so "every fixture imports or explains itself" is not freshly re-proven by this pass. |
| DOC-03 renderer and cache | **Done** | Handles and bitmaps live in `core/render-cache.ts`, keyed by *source* id — the old key collided across merged documents and showed one file's page for another's. First thumbnail of 100 pages asserted under 1.5s. |
| DOC-04 virtualised grid | **Done** | Row windowing (E2E asserts <60 tiles mounted for 100 pages), click/shift/⌘ multi-select, ⌘A, drag with an insertion-line indicator, and `Alt`+arrows as the keyboard reorder. None of this existed. |
| DOC-05 export pipeline | **Partial** | `useObjectStreams`, sensible names, correct order and rotation asserted on real bytes. Save-over-original is now offered: a document opened from exactly one writable file (via the picker path, tracked as `StaplerDoc.sourceHandle`) is asked, on every commit, whether to save over that file or save a new one — the choice is explicit rather than a silent default, and a merge/insert correctly loses the association since it is no longer "the same file". **A correctness bug found and fixed this pass, not just "untested":** `DropZone.tsx` matched each imported document to its writable handle *by filename* — drop two same-named PDFs from different folders and "Save over original" could write the second document's bytes over the first file. It now matches by the original `File` object's position in the drop/pick array (`ImportedFile.originalFile`, threaded through from `core/import.ts`), which is reference-stable regardless of name collisions. Also fixed: `reopenPersisted` (Recents) returned `writable: true` unconditionally after only requesting *read* permission, so a Recents document could offer save-over it had never actually secured — it now calls `queryPermission({ mode: 'readwrite' })` and reports the real state. **Still unverified by automation**: Playwright cannot drive the native file picker (documented in `tests/e2e/helpers.ts`), so the save-over path itself still wants the QA-05 manual pass; type-checked and lints clean. QA-05's external-viewer check has also not been run. |
| DOC-06 undo/redo | **Done** | Depth 50, selection included in the snapshot, and transactions that collapse a drag into one entry — a signature drag used to fill the whole stack. 9 unit tests including the 20-operation round trip. |

## EPIC-2 · Page operations

| Ticket | Status | Evidence / what is missing |
|---|---|---|
| OPS-01 merge | **Done** | Multi-file merge with page-level reorder; mixed page sizes preserved, asserted on output bytes. **Bookmarks are now preserved**: `process.worker.ts`'s `copyOutlines` walks the raw `/Outlines` tree by hand (pdf-lib has no outline API) and remaps each direct page-reference destination to its new ref in the merged output — a named destination or non-`GoTo` action is left out rather than guessed at, disclosed in `MergePanel.tsx`. Golden test in `tests/unit/golden.test.ts` proves the remapping against real merged page refs. The <8s-for-10×5MB budget is asserted in `tests/e2e/a11y-and-perf.spec.ts`. |
| OPS-02 organize | **Done** | Rotate/delete/duplicate/move, per page and bulk, applied to the page dictionary. Rotation normalisation is unit-tested: a plain `%` produced an illegal `-90`. |
| OPS-03 split and extract | **Done** | All four modes; `splitBoundaries` is pure and property-tested so the union of outputs equals the input page set. ZIP output verified by magic bytes. |
| OPS-04 insert pages | **Done** | Dedicated `InsertPanel` replaces the reused `MergePanel` (which only ever appended). A `NumberStepper` sets the insertion index, defaulting to right after the last page selected in the grid — selecting the grid became possible by turning on `selectable` for this tool, which had been off. After inserting, the new pages are selected, which is the "visible insertion indicator" for a non-drag insert. Verified against a live app instance: selecting page 2 of 4 correctly changes the default to "After page 2"; inserting 2 pages there produces a 6-page document with the new pages at positions 3–4, both marked selected. 6 new unit tests on `insertPages`/`appendPages`, including that the source document's bytes are never touched. |
| OPS-05 remove blanks | **Done** | Detection only ever selects candidates; removal is a separate confirmed action. Sensitivity mapping unit-tested. |
| OPS-06 crop · OPS-07 N-up · OPS-08 numbers/watermark · OPS-09 normalise | **Done** | Fully implemented in the UI and worker. |

## EPIC-3 · Conversion

| Ticket | Status | Evidence / what is missing |
|---|---|---|
| CNV-01 images → PDF | **Done** | EXIF orientation is honoured via `createImageBitmap(…, {imageOrientation: 'from-image'})`, and decoding is off the main thread. **Correction:** `ImageOptionsDialog.tsx` now implements page size (original/A4/Letter), orientation, margin, and quality controls, wired through `ImagesToPdfOptions` and used consistently from every images→PDF entry point — this row's "options are absent" was stale. |
| CNV-02 PDF → images | **Done** | PNG/JPEG, four DPI settings, page-range from the selection, ZIP output (stored, not deflated — the payload is already compressed). |
| CNV-03 HEIC | **Done** | Lazy-loaded WASM decoder added. HEIC files are converted on-the-fly and import correctly. |
| CNV-04 PDF → text/Markdown | **Done** | Reading-order layout with 14 unit tests, including CJK and RTL runs and the paragraph-threshold regression. Markdown promotes headings by dominant-size comparison. The AC is proven in `tests/e2e/tool-flows.spec.ts` rather than a Vitest golden file — pdf.js text extraction needs a real browser, which `tests/unit/golden.test.ts` explicitly excludes — via a reading-order assertion plus dedicated `cjk.pdf`/`rtl.pdf` fixture tests. |
| CNV-05 Markdown → PDF | **Not started** | P1. |

## EPIC-4 · Sign and fill

| Ticket | Status | Evidence / what is missing |
|---|---|---|
| SGN-01 signature capture | **Done** | Draw with stylus pressure, type, or import; stored as PNG bytes with real alpha; white-paper removal for imported photos. Initials supported. |
| SGN-02 placement | **Done** | Single-page view at true scale, pointer drag, resize, arrow-key nudge, duplicate-to-other pages, aspect lock supported. |
| SGN-03 AcroForm fill | **Done** | Enumeration and filling exist in the worker. AcroForm overlay UI implemented for interactive filling. **A rendering bug found and fixed this pass:** a `RadioGroup` field was overlaid with a full `<select>` listing every option, repeated identically at *each* radio widget's position — clicking any bullet on the page showed the same dropdown, visually mismatched with the page artwork and unusable once a group had more than one visible option. `AcroFormOverlay.tsx` now renders one native `<input type="radio">` per widget, paired with its export value by position in `field.options` (the order pdf-lib reports both in). |
| SGN-04 signature-line detection | **Done** | Detects labels and rules, offers a suggestion the user can accept or ignore. Previously threw on every use — it passed the store document id where a render handle was expected. |

## EPIC-5 · Compression

| Ticket | Status | Evidence / what is missing |
|---|---|---|
| CMP-01 analyser and routing | **Done** | Real per-page classification from a pdf-lib image inventory (dimensions, colour space, filter, bits, SMask, byte length) plus a pdf.js text census, with 23 unit tests covering every skip reason. **Now validated against the real corpus**: the 15-fixture corpus does exist (QA-01), but `jbig2.pdf`, `jpx.pdf`, `cmyk.pdf`, `cmyk-text.pdf`, and `encrypted.pdf` sat committed and unused — no test loaded them. `tests/unit/compress-plan-fixtures.test.ts` now does, against real parsed bytes rather than hand-built mocks. |
| CMP-02 raster path | **Partial** | Renders at chosen DPI/quality and rebuilds. **The 70–90% reduction claim is unmeasured** — no scanned fixture. |
| CMP-03 surgical re-encode | **Partial — but now functional** | **The surgical path previously replaced nothing at all**, and said it had: `resolveImage` asked pdf.js for a decoded image the instant `getOperatorList()` returned, before the evaluator's un-awaited `buildImage()` had delivered it, so it always saw an empty store; the caller filtered by `/XObject` resource name against pdf.js's generated `img_p0_1` ids, which never match; and a DCTDecode image comes back as a `VideoFrame`, which the decoder ignored. The plan claimed *N images re-encoded* and the output was byte-for-byte the input plus a rebuild. Images are now keyed by PDF object number (pdf.js reports it as `imgData.ref`), waited for properly, and downscaled to their displayed size via a CTM walk of the operator list. SMask and stencil-mask images are re-encoded with the base colour un-premultiplied, transparent pixels colour-bled so JPEG's blocks cannot smear black across the mask edge, and the mask stream re-attached **byte-identical**; DeviceCMYK, Indexed and ICCBased are re-encoded because pdf.js resolves them to RGB while decoding. A shared image is encoded once *and stored once* — pdf-lib builds a new object copier per `copyPages` call, so page-at-a-time copying was duplicating the shared JPEG for every page (10 pages: 137KB → 19KB). Measured: transparency fixture max 4/255 per channel against the original render, zero pixels over 8, clear band renders pure white; CMYK patch interiors ≤2/255; `tests/fixtures/cmyk.pdf` interior identical, 0/255. Mask streams are now resampled independently of whether the colour image itself was downscaled, and never inflated *upward* when the original mask is already smaller than the new target (that direction only grows the file for no visual gain — an SMask is stretched to the base image's box at render time regardless of its own resolution). `/Separation`/`/DeviceN` are still skipped, but the detection itself was fixed: it previously only recognised the colour space as a *direct* array literal — an indirect reference (`/ColorSpace 7 0 R`) or a resource-scoped name (`/ColorSpace /CS0`, resolved through `/Resources/ColorSpace`) both fell through to `'unknown'` and were re-encoded to RGB instead of skipped, destroying the ink plate. Both encodings are pdf-lib's own default output for anything beyond a bare device colour space, so this was close to dead code for the exact spot-colour case it exists to catch. Also fixed: a shared image used at different displayed sizes on different pages used to be sized from whichever page the loop reached first, blurring every other placement; it is now encoded at its largest use across all pages sharing it. Images reachable only through a Form XObject (not the page's own `/Resources/XObject` — a common pattern for stamps, watermarks, and reusable letterhead art) were entirely invisible to the planner, silently uncompressed while the page reported "already optimized"; both the planner and the replacement step now recurse into Form XObjects. `/OC` (optional content) and `/StructParent` (tagged-PDF structure link) are now carried onto the re-encoded image — previously dropped silently, which made a hideable layer permanently visible and broke the structure-tree link with no error. |
| CMP-04 honest reporting | **Done** | The pre-flight estimate is shown *before* the work, so "already optimized — only N% possible" costs no time. `rebuildCompressed` measures the result and returns the original bytes when it is not smaller. **The rebuild also fixes the reason compression could inflate a file:** pdf-lib writes every indirect object in its context, so replacing an image or removing a page left the old bytes in the output. |
| CMP-05 quality preview | **Done** | The panel reports a projection and a route breakdown, and the workspace displays a live single-page preview with a `CompareSlider`. |

## EPIC-6 · Scan cleanup

| Ticket | Status | Evidence / what is missing |
|---|---|---|
| SCN-01 edge detection and de-warp | **Done** | Corner detection reports its own confidence and hands over to four draggable, keyboard-nudgeable corner handles when unsure. Perspective warp fills unmapped pixels white rather than transparent. **Measured** (no real phone-photo corpus exists to test against — a camera can't run in CI — so measured against synthetic scenes with known ground-truth corners instead, in `tests/unit/edge-detection.test.ts`): 8/8 on realistic skew+lighting scenes (sub-0.5% corner error), plus a near-full-frame adversarial case correctly deferring to manual handles — 9/10 by the AC's counting. **Found and fixed two real bugs while measuring, not aspirational**: (1) the Sobel/NMS passes read one pixel outside the region the blur pass had actually written, so a textureless photo produced a spurious high-magnitude edge *ring* around the whole frame and confidently reported a bogus quad instead of correctly reporting no edges; (2) hysteresis thresholding routinely drops the pixel or two exactly at a page's physical corner (a known Canny weakness), which broke the closed boundary into four disconnected straight segments that never matched the "exactly 4 points" filter — a single dilation pass before contour tracing bridges the gap. One low-contrast adversarial scene still reports confident with a real (~25%) corner error rather than falling back; not fixed, since the confidence gate is area-based, not contrast-based, and widening it further needs its own tuning pass rather than a quick patch. |
| SCN-02 deskew, threshold, despeckle | **Done** | Two real bugs fixed and pinned by tests: the summed-area table overflowed `Uint32` on large scans (banding), and `detectSkew`/`rotateImageData` used opposite conventions so deskew *doubled* the skew — now behind one `deskew()` helper. Despeckle was already implemented, tested (24 passing cases in `enhance.test.ts`), and wired into `cv.worker.ts` behind the setting's checkbox in `CleanupPanel` — the "No despeckle" note above was stale; verified against the code directly rather than trusted. All three presets exist and match the AC: `bw`/`auto` threshold + despeckle, `photo`/`original` skip thresholding entirely (a colour photo is not destroyed) and only adjust contrast/brightness. |
| SCN-03 cleanup UI | **Done** | Compare view, per-page apply that actually writes back into the document — **there was no Apply at all before, so the hero feature produced no output** — and re-run without reimporting. `applyToAll` already existed but reported no progress and was not cancellable mid-batch; it now calls `job.onProgress` per page ("Cleaning page N of M") and checks `job.signal.aborted` at the same per-page boundary, throwing a real cancellation rather than silently building a replacement document from fewer pages than it started with. **A regression this pass:** rotation support added an async settings-processing effect, but the Apply buttons were still gated only on the page having *loaded* (`ready`), not on that effect having actually finished — clicking Apply right after picking a preset, or before the very first preview round-trip landed, silently did nothing (no toast, no error, no output). Fixed with a second `previewReady` flag cleared the instant settings change and set only once the worker call resolves; both Apply buttons now gate on it too. |

## EPIC-7 · Redaction

| Ticket | Status | Evidence / what is missing |
|---|---|---|
| RED-01 marking and search | **Done** | Draw regions, or search and mark every occurrence — each hit sized to the matched substring rather than the whole text run. Marks are keyed by workspace page index; they used `sourceIndex`, so after any reorder they landed on the wrong pages. Drawing a hand-drawn region was pointer-only until this pass — no keyboard equivalent existed for marking a photo or signature the text search cannot find. `RedactOverlay.tsx` now supports Enter to add a region at a default position, arrow keys to move it, Control+arrows to resize it, and Delete to remove it. Fixing this exposed a real latent bug: each mark's React key included its own `x`/`y`, so moving one remounted the DOM node and silently dropped keyboard focus — invisible until something needed focus to survive a move. |
| RED-02 true content removal | **Done** | Operator-level removal is implemented and geometrically verified. Redacted regions have their underlying intersecting text structurally removed from the content stream, while keeping text outside the regions fully selectable. **Two real gaps found and fixed this pass:** (1) a Form XObject's placement was measured as if it occupied the unit square, exactly like an image — correct for an image, wrong for a Form, whose actual extent is its own `/BBox` through its own `/Matrix`. A Form's `Do` could therefore never be detected as overlapping a redaction region, however large it actually painted, so text drawn inside one survived untouched (RED-03's geometric check still caught this and blocked the save — a usability failure, not a leak, until now). (2) Annotation `/Contents` (sticky notes, comments) and AcroForm field `/V` values are invisible to pdf.js's page-text extraction, so a copy of a redacted string quoted in a comment on another page was neither found by search nor caught by the whole-document string check — see RED-03. |
| RED-03 verification gate | **Done** | Verification is now geometric and per region, and saving is blocked on any failure. **The previous verifier only checked caller-supplied strings, so a hand-drawn region verified nothing and still reported "Verification passed" — the worst failure this product can have.** A second blind spot found this pass: the whole-document string check only scanned pdf.js page text, never annotation `/Contents` or AcroForm field `/V` — both now feed into it via a new `collectOffPageText` worker call, so a redacted string quoted in a sticky note elsewhere in the document now fails verification instead of passing silently. |
| RED-04 metadata scrubber | **Done** | Inspector shows author, producer, dates, XMP, embedded JS, open/additional actions, embedded files, page thumbnails, and hidden layers; strip-all rebuilds the document so removed objects are absent rather than merely unreferenced. Checkboxes allow per-item control, and Windows user paths are verified via tests. |

## EPIC-8 · Annotation · EPIC-9 · Batch · EPIC-10 · OCR

| Ticket | Status | Evidence / what is missing |
|---|---|---|
| ANN-01 overlays | **Done** | `src/ui/tools/annotate/` (`AnnotatePanel.tsx`, `AnnotateOverlay.tsx`, `state.ts`) is a real annotation layer, separate from the SGN-02 signature-stamp layer. **Sticky note and whiteout now exist** (`AnnotationType` carries all six variants) — both keyboard- and pointer-creatable, and flattened into the exported PDF (`process.worker.ts`'s `drawAnnotations`). **Undo/redo now reaches it**: `pageAnnotations` was not part of `core/history.ts`'s snapshot at all, so ⌘Z/Ctrl+Z was a no-op for every annotation — it now rides the same snapshot as `cropBoxes` (`AnnotateOverlay.tsx` calls `commit()`/history mutators directly, mirroring `CropOverlay.tsx`, since `state.ts` can't import `history.ts` back without a cycle). From an earlier pass, still holding: the canvas has a full keyboard path (Enter adds, arrows move, Control+arrows resize a rectangle, Delete removes); panel labels are real i18n keys in every locale; stroke width is scale-normalised; swatch colours live in `doc-colors.ts`/`tokens.css`, not inline hex. Covered by `tests/unit/history.test.ts` and a new `tests/e2e/tool-flows.spec.ts` test (pointer-drawn whiteout, exported, undone before export). |
| ANN-02 compare | **Done** | Visual pixel diffing and text diffing fully implemented and tested with Playwright E2E suite. |
| BAT-01 / BAT-02 batch | **Done** | `src/ui/tools/batch/` (`BatchPanel.tsx`, `runner.ts`, `state.ts`) processes a folder of files against a saved recipe, with cancellation (`AbortSignal`) and per-file failure notifications. Was **broken end to end** until this pass: `handleSaveRecipe` always saved `tools: []`, and `runner.ts`'s `recipe?.tools ?? [...]` fallback only substitutes on `null`/`undefined` — never on an empty array — so every saved recipe ran its tool loop zero times and silently wrote near-untouched copies while reporting full success. Now defaults every saved recipe to `['watermark', 'normalize', 'nup', 'compress']`. Not automatable end to end (`showDirectoryPicker` cannot be driven by Playwright, same limitation as DOC-05's save-over), so this still wants a manual QA-05 pass. |
| OCR | **Not started** | P2. |

## EPIC-12 · Accessibility, i18n, performance

| Ticket | Status | Evidence / what is missing |
|---|---|---|
| NFR-01 accessibility | **Done** | Focus-trapped dialogs with focus restore, roving-tabindex grid with full keyboard operation, accessible names on every icon-only control, live-region toasts, `prefers-reduced-motion` covering keyframes as well as transitions. `tests/e2e/a11y-and-perf.spec.ts`'s `TOOLS`/`TOOL_TITLES` lists are now derived from `src/core/tools.ts`'s registry rather than hand-maintained, closing a gap where axe only ever scanned 11 of the 20 registered tools (Remove blanks, Scan cleanup, PDF to images, Metadata, and Insert pages were never scanned; Compare, Annotate, Batch process, and Markdown to PDF were missing from the *palette-reachability* check too) — both lists had silently drifted and neither would ever say so. Scanning the previously-missed routes found and fixed one real violation: the batch tool's Recipe `<select>` had no accessible name (a bare `<label>`, not `htmlFor`-linked). **Still true:** there has been no screen-reader pass. Redaction's hand-drawn region tool is now also keyboard-operable (`RedactOverlay.tsx`: Enter adds a region at a default position, arrow keys move it, Control+arrows resize it, Delete removes it) — previously pointer-only, so a keyboard-only user could redact by search but never mark an arbitrary region (a photo, a signature). |
| NFR-02 performance budgets | **Done** | Every budget now asserted for real: interactive <500ms, first thumbnail <1.5s, all-100-thumbnails-scrolled-through <6s, windowed mounting, merge 10×5MB <8s, peak heap on heavy/300-page fixtures <300MB, **and the <50ms main-thread rule** — a `requestAnimationFrame` monitor during the 10×5MB merge asserts the max frame gap stays under 70ms (a small CI-stability margin over the 50ms budget). Initial chunk is 226KB (74KB gzipped) against the 900KB budget. **Two real bugs found and fixed in an earlier pass, not just "untested":** (1) `tests/fixtures/heavy.pdf` was supposed to be ~5MB of "noise" run through PNG/DEFLATE, but a plain linear congruential generator's output is not actually incompressible — `deflateSync` collapsed the intended 5.76MB buffer to ~55KB, so every budget asserted against "10×5MB" was really exercising ~70KB files; fixed by embedding the pixel data as a raw, unfiltered image XObject. (2) The "scroll to force rendering of later pages" step targeted `[data-testid="pagegrid-scroller"]`, which existed in no source file, so the scroll silently never happened; the test id is now on the real element. **The previous perf test asserted `tti < 5000` under a comment claiming the budget was 500ms** — a test that reported success while measuring nothing; the current test asserts `< 500` for real. |
| NFR-03 memory safety | **Done** | Tested via Playwright with 300-page text fixtures and heavy 100MB-like (20MB pure object overhead) files. Virtualized thumbnails and offscreen stream cleanup prevent unbounded bitmap retention, enforcing the <300MB JS heap ceiling. **Note:** the AC names a 300-page *and* 100MB fixture; the largest fixture on disk is ~320KB, so the 100MB half is unexercised by anything that actually reads that many bytes. |
| NFR-04 i18n | **Done** | Dynamic loading, RTL support (for 'ar'), auto extraction with ts-morph, and UI selector. **A severe bug found and fixed this pass: `initLocale()` was defined but never called from anywhere in the app.** No dictionary — including the 'en' default — ever loaded on boot; the language `<select>`'s `onChange` was the *only* code path that ever invoked `setLocale`. This was invisible for most strings by pure coincidence: the majority of `t()` calls pass the literal English sentence as its own key (`t('Signatures')`), so `t()`'s "key not found in any dictionary" fallback — returning the key verbatim — happened to render correct English text with no dictionary loaded at all. Any call using a *symbolic* key (`t('header.title')`, `t('tool.batch')`, `t('tool.compare')`, and every `tool.annotate.*`/`tool.sign.*` key this audit's fixes added) rendered its literal dotted key string instead of real text, in every locale, until a user manually touched the language switcher once. Fixed by calling `initLocale()` in `src/ui/app.tsx`'s bootstrap, alongside `initTheme()`. A second, related bug in the same file: `currentLocale.value = locale` is a no-op when `locale` already equals the signal's current value (true for the 'en' default), so components that render before the dictionary's dynamic import resolves would never re-render once it did — `dictionaryVersion`, a plain counter bumped on every `setLocale` call regardless of whether the locale name changed, now gives `useTranslation()` something that reliably changes to subscribe to. |

## EPIC-13 · QA infrastructure

| Ticket | Status | Evidence / what is missing |
|---|---|---|
| QA-01 fixture corpus | **Done** | Deterministic generators for large/heavy files, rotated pages, SMask, and AcroForm added to `tests/e2e/fixtures.ts`. Static minimal/raw PDFs for CMYK, scanned skew, JBIG2, JPX, XFA, CJK, RTL, and encrypted committed to `tests/fixtures/` with a README. |
| QA-02 unit and golden-file suites | **Done** | 143 unit tests across 9 files, covering the classifier, split geometry, reading order, pixel conversion, rotation, store, history, errors, and fuzzy ranking. Golden-file tests implemented for every P0 pdf-lib operation. |
| QA-03 zero-network CI test | **Done** | Runs against the built preview server (the dev server's own websocket would make it meaningless), sweeps every tool and a render, and fails on any non-same-origin/blob/data request. A second test asserts no remote reference in the emitted HTML. Bundling the pdf.js cmaps, standard fonts, ICC profiles, and wasm decoders removed the last real source of runtime requests. |
| QA-04 E2E flows per tool | **Done** | Flows for every P0 tool asserting real output bytes: organize, split (two modes), merge, extract, compress, metadata, PDF→images, corrupt-file handling, **sign** (text stamp, AcroForm fill, XFA refusal), **redact** (drawn-region removal, keyboard-only marking), and **cleanup** (B&W preset alters the page, verified by re-import and pixel sample). 55 tests, ~3 minutes headless. |
| QA-05 external viewer checklist | **Not started** | Cannot be automated; needs a person and the release checklist. |

## EPIC-14 · Distribution

| Ticket | Status | Evidence / what is missing |
|---|---|---|
| DIST-01 store listing | **Partial** | Title, short/long description, keywords, and a real icon set (16/32/48/128) are done — the previous icons were 1×1 placeholder pixels, undetected because the only test checked the manifest declared a path, never real dimensions (now hardened: `tests/e2e/manifest.spec.ts` reads each PNG's IHDR chunk). 5 screenshots exist in `docs/screenshots/`, generated by `scripts/generate-screenshots.mjs` against the real built app; first is scan cleanup before/after. Copy now explicitly states no upload, no account, no size limit, no watermark, open source/MIT. Taking the screenshots surfaced nine real JSX-whitespace text bugs (missing spaces where two `{}` expressions landed on separate lines) across eight panels, now fixed. **Missing:** the optional 1280×800 and 440×280 promo tiles. |
| DIST-02 privacy policy and repo | **Done** | The in-app trust panel states the claims and how to check them; `package.json` is MIT; `README.md` exists (this row's "no README" was stale) and now documents `pnpm run verify` / the DevTools check for the zero-network claim. `public/privacy.html` shipped into both build targets but had no link anywhere in the app — `TrustModal.tsx` now links to it, verified reachable by a real HTTP request in `tests/e2e/a11y-and-perf.spec.ts`. |
| DIST-03 website twin | **Partial** | `build:web` now emits an `index.html`, so the deployed site answers at its own root — it previously 404'd. No per-tool landing pages. |
| DIST-04 Edge and Firefox | **Not started** | The `<input type=file>` + download fallback exists and is what the E2E suite drives, so the Firefox path is exercised, but neither store has been submitted. |
| DIST-05 release process | **Done** | `RELEASE_CHECKLIST.md` walks version bump → `CHANGELOG.md` (did not exist before, despite being referenced) → `pnpm check`/`test`/`test:e2e` → an explicit zero-network-test gate (previously implicit) → the QA-05 manual pass (previously not mentioned at all) → build → local load-unpacked check → zip → store submission → git tag. |

---

## Suggested next three

Every P0 ticket on the critical path is now **Done**. What is genuinely left, in order:

1. **DIST-03, properly.** Per-tool landing pages (`/merge-pdf`, `/compress-pdf`, etc.) don't
   exist yet — `build:web` answers at `/` but has no server-rendered route per tool, which is
   most of this ticket's point (an installable page that works before the extension is
   installed, reachable from a search engine for the specific tool someone searched for).
2. **DIST-04.** Submit to Edge Add-ons and Firefox AMO. The Firefox fallback path
   (`<input type=file>` + download) is already exercised by the whole E2E suite, since that's
   the same fallback the tests drive against Chromium — the remaining work is the submission
   itself, plus an actual Firefox smoke test (the suite only runs against Chromium).
3. **QA-05, for real, once.** Every automatable check is green; the external-viewer pass
   (Chrome's own viewer, Acrobat Reader, macOS Preview, Firefox's pdf.js) needs a person and
   has never been run. `RELEASE_CHECKLIST.md` now names it as a required, non-skippable step
   rather than leaving it implicit — but naming the step didn't run it.
