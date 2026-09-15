# Stapler — Edge-Case Audit (2026-09-15)

This audit is a targeted hunt for **unhandled edge cases**, not a ticket-by-ticket
acceptance-criteria re-verification (see [`AUDIT-2026-08-17.md`](AUDIT-2026-08-17.md) for
that). It was produced by five independent, read-only agents running in parallel, each
covering a disjoint area of the codebase, verifying findings by reading the real
implementation (and in several cases running constructed or fixture input against it)
rather than inferring from names or ticket text.

## 0. Scope and methodology

| Area | Coverage |
| --- | --- |
| PDF internals | `src/core/pdf/`, `src/core/compress/` (compress-plan, process.worker), `src/core/redact/`, `src/core/cv/` (scan cleanup), `src/core/faceblur/` |
| Conversion & OCR | `src/core/convert/` (images↔PDF, HEIC, docx/xlsx/pptx↔PDF), `src/core/ocr/` |
| UI concurrency | `src/ui/tools/*` (batch, history, compare, side-by-side, sign, redact, ocr), `src/ui/shell/` |
| Platform / file I/O | `src/platform/`, `src/background/service-worker.ts`, `src/core/db.ts`, `src/core/opfs.ts`, `src/core/import.ts` |
| Cross-cutting invariants | zero-network, zero-permissions, no-raw-colours, layer boundary, cancellability, i18n completeness |

No repository files were modified during this audit. Where an agent constructed a probe
file to test behavior, it was deleted before completion; `git status` was clean
throughout.

**What this does NOT cover:** browser-store review, real hardware/OS drag-and-drop
behavior beyond code inspection, a live OCR/face-model network download (sandboxed, no
network), or a second adversarial re-verification pass on these findings themselves.
Treat the items below as strong, evidence-based leads — each one cites the exact
location and a concrete trigger — but not beyond further challenge.

---

## 1. Critical — data loss, redaction bypass, or silent corruption

**Status (2026-09-15): all nine items below are fixed.** Each fix has a
dedicated regression test asserting on real output bytes (not mocks), and the
full suite — 1324 tests across 100 files — passes clean, along with `tsc
--noEmit`, `eslint`, `prettier --check`, and `scripts/check-invariants.mjs`.
§1.1/§1.8/§1.9 were fixed directly; §1.2–§1.7 were fixed together since they
share `process.worker.ts` and related pdf-lib internals. New/changed test
coverage: `tests/unit/opfs.test.ts`, the "§1.8" block in
`tests/unit/batch-runner.test.ts`, `tests/unit/compress-raster-page.test.ts`
(§1.2/§1.3), `tests/unit/redaction-offpage-text.test.ts` (§1.4), the "§1.5"
block in `tests/unit/permission-restrictions.test.ts`, the updated cases in
`tests/unit/compress-plan.test.ts` (§1.6), and `tests/unit/xfa-object-stream.test.ts`
(§1.7). Not yet re-run: the Playwright e2e suite (`pnpm test:e2e`), which this
sandbox cannot drive a real browser for.

### 1.1 External file drop can navigate the tab away, losing the whole workspace  ✅ Fixed
**[`src/ui/shell/PageGrid.tsx:349-368`](../src/ui/shell/PageGrid.tsx#L349-L368)**

Once a document is open, `DropZone` (only mounted in the empty-state home view) is gone.
The page grid's only remaining drag handlers are per-cell, and `onDragOver` calls
`event.preventDefault()` **only** when `dragKey` — internal page-reorder state set by
this component's own `onDragStart` — is truthy:

```
onDragOver={event => {
  if (!dragKey) return;      // no preventDefault for a non-internal drag
  event.preventDefault();
  ...
}}
```

Dragging a file from the OS (or another app) never sets `dragKey`, so `dragover` is
never prevented and the browser's default `drop` action fires — in a Chrome extension
page this typically **navigates the tab to the dropped file**. No window-level
`dragover`/`drop` listener exists anywhere in `src/ui` or `src/platform` (verified by
grep).

**Trigger:** open any document → drag any file from the desktop onto the page grid →
drop.
**Impact:** potential navigation away from the app, silently losing all open documents,
undo history, and unsaved edits, with no confirmation. Worse than the "silently corrupt"
failure modes CLAUDE.md calls out, since it can destroy the whole session rather than
one document.

### 1.2 Compression's raster path double-rotates landscape scans  ✅ Fixed
**[`src/core/workers/process.worker.ts:4934-4944`](../src/core/workers/process.worker.ts#L4934-L4944)**

Any textless page with `/Rotate 90` or `/Rotate 270` (a landscape phone scan) routed to
the raster compression path is corrupted: pdf.js already bakes rotation into the
rendered JPEG (`render.worker.ts:1168`'s default viewport rotation), and the compression
code then re-applies `/Rotate` on top and draws a 792×612 raster into a 612×792 box.

**Trigger:** compress a textless, rotated scan.
**Impact:** output is double-rotated and aspect-distorted. This is CMP-02's headline
feature corrupting the single most common real-world input it will see.

### 1.3 Raster compression path drops all annotations  ✅ Fixed
**[`src/core/workers/process.worker.ts:4941`](../src/core/workers/process.worker.ts#L4941)**

The new page created for a raster-routed page never copies `/Annots`.

**Trigger:** compress any page with links, comments, stamps, or form widgets and no
extractable text.
**Impact:** annotations vanish silently. Measured: input with one `/Link` → output has
`/Annots [ ]`.

### 1.4 Redaction verifier misses off-page text locations  ✅ Fixed
**[`src/core/workers/process.worker.ts:5816`](../src/core/workers/process.worker.ts#L5816)** (`collectOffPageText`)

Only `/Contents` and `PDFTextField`/`Dropdown`/`OptionList` values are collected. A
redacted string living in a link's `/A /URI`, a markup annotation's `/RC` with no
`/Contents`, a field's `/TU` tooltip or `/DV` default value, or a `FileAttachment`'s
`/FS /EF` embedded stream is never scanned.

**Trigger:** redact a string that also appears in a URI, tooltip, rich-text comment, or
attached file.
**Impact:** verified for all four cases — `collectOffPageText(out) === []`, the
verifier returns `pass: true`, and **the save proceeds with the sensitive string still
present in the output bytes**. This defeats the core guarantee RED-02 exists to provide.

### 1.5 Toggling "Protect" on can loosen an existing restriction  ✅ Fixed
**[`src/core/pdf/encrypt.ts:116-127`](../src/core/pdf/encrypt.ts#L116-L127)** (`withInheritedRestrictions`)

Three UI booleans can't express every `/P` permission bit. Importing a PDF whose `/P`
forbids only annotations (bit 6), form-filling (bit 9), or high-quality printing (bit
12), then turning Protect **on**, re-grants those bits from the `-4` base flags because
the UI has no toggle for them.

**Trigger:** import a PDF with one of those specific restrictions set, enable Protect.
**Impact:** verified for all three bits — input forbids, output permits. Directly
contradicts the function's own "this only ever removes permissions" contract; turning a
protection feature **on** should never loosen a restriction.

### 1.6 Short but real text gets misclassified as a blank scan  ✅ Fixed
**[`src/core/compress-plan.ts:80,201`](../src/core/compress-plan.ts#L80)** (`MEANINGFUL_TEXT_CHARS = 24`)

A scan page carrying real selectable text under 24 characters (a Bates number, "Page 1
of 12") is classified as text-free and routed to the raster path.

**Trigger:** compress a scanned page with a short text overlay/stamp.
**Impact:** measured — 23 characters routes to `raster` (destructive), 24 to
`surgical` (safe). The real text is irreversibly flattened into a JPEG while the
compression report claims "no extractable text."

### 1.7 XFA payload can be silently discarded despite the compose guard  ✅ Fixed
**[`src/core/workers/process.worker.ts:2121`](../src/core/workers/process.worker.ts#L2121)**

The compose guard relies on `hasXfaMarker`, a raw byte scan, alone — contrary to
`xfa.ts:53-55`'s own comment instructing it be combined with the parsed check. pdf-lib's
load path never passes `preserveXFA`, so it already strips XFA data on load; for a form
saved with object streams (typical real Adobe LiveCycle output), `hasXfaMarker` is
`false` and `inspect().isXfa` is `false` too.

**Trigger:** open and re-save (compose) an object-stream-encoded XFA form.
**Impact:** verified — compose succeeds and the form payload is already gone by the
time any guard could catch it. This is exactly the silent-half-processing scenario
`XFA_COMPOSE_MESSAGE` exists to prevent.

### 1.8 Batch import lacks a PDF/corruption gate  ✅ Fixed
**[`src/ui/tools/batch/runner.ts:138-166`](../src/ui/tools/batch/runner.ts#L138-L166)**

Unlike `importPdf` (`import.ts:86-110`), the batch path has no header check and no
pdf.js validation gate before calling `inspect` directly.

**Trigger:** include a non-PDF or truncated file in a batch input folder.
**Impact:** measured on truncated fixtures — a badly-truncated file throws a raw
`TypeError: Cannot read properties of undefined (reading 'getOrCreateAcroForm')`,
bypassing the normal error-classification taxonomy entirely. A partially-recoverable
file (a 100-page fixture cut to 95%) returns `pageCount: 74` with **no error at all** —
26 pages silently dropped.

### 1.9 OPFS quota exhaustion has no dedicated handling  ✅ Fixed
**[`src/core/opfs.ts:9-19`](../src/core/opfs.ts#L9-L19)** (`writeSourceBytes`)

`writable.write(bytes)` has no try/catch. A `QuotaExceededError` bubbles uncaught
through `import.ts:150`/`:221` (also unguarded) into the generic error path
(`errors.ts:145-146`), producing "Something went wrong" instead of the specific,
actionable "Local storage is full…" message `db.ts:159-175` already provides for the
identical failure on IndexedDB.

**Trigger:** import a large file (or several) when origin storage quota is exhausted.
**Impact:** OPFS holds the actual document bytes (potentially 100MB+), making this the
storage path most likely to hit quota — and the one with no specific handling.

---

## 2. High — concurrency races and classification errors

**Status (2026-09-15): all ten items below are fixed.** §2.1/§2.2/§2.3/§2.6
were fixed directly, each with regression tests in `tests/unit/batch-runner.test.ts`
(§2.1), `tests/unit/history.test.ts` (§2.2), `tests/unit/ocr.test.ts` (§2.3),
and `tests/unit/faceblur-consent.test.ts` (§2.6, which also caught a bug in
the fix itself — the face-detector manifest is quantized, so a shard's
on-disk byte width comes from each weight's `quantization.dtype`, not its
logical `dtype`; the test suite rejected even the genuine file until that was
corrected). §2.4/§2.5/§2.9/§2.10 were fixed together in
`src/core/compress-plan.ts` and `src/core/workers/process.worker.ts` (new
tests in `tests/unit/compress-edge-cases.test.ts`, 17 cases). §2.7/§2.8 were
fixed together in `src/core/cv/imageUtils.ts` and `src/core/cv/enhance.ts`
(extended `tests/unit/warp-target-size.test.ts` and `tests/unit/enhance.test.ts`).
Every fix was independently reviewed against the actual diff, not just the
implementing agent's report. Full suite: 1367 tests across 101 files, plus
clean `tsc --noEmit`, `eslint .`, `prettier --check .`, and
`scripts/check-invariants.mjs`.

### 2.1 Batch runs have no reentrancy guard  ✅ Fixed
**[`src/ui/tools/batch/runner.ts:41-113`](../src/ui/tools/batch/runner.ts#L41-L113)**,
**[`src/ui/tools/batch/BatchPanel.tsx:220-229`](../src/ui/tools/batch/BatchPanel.tsx#L220-L229)**

`runBatch` never checks `batchProgress.value.isProcessing` on entry (only the button's
`disabled` prop guards it), and there is a real `await` gap
(`inDir.isSameEntry(...)`, `runner.ts:51-56`) before `isProcessing` flips to `true`.
`handleRun` also overwrites `abortControllerRef.current` on every call with no ownership
check — the same bug class commit `6bab634` already fixed for `useJob`.

**Trigger:** double-click, or press Enter twice on, "Run Batch" before the first render
pass disables it.
**Impact:** two concurrent `runBatch()` calls mutate the same `batchProgress` signal
(counters interleave nonsensically) and both write to the same output
directory/ZIP handle. The second call's controller silently replaces the first's, so
Cancel only stops the newer run — the first keeps writing files in the background with
no way to stop it.

### 2.2 Undo/redo during an in-flight export stamps a stale baseline  ✅ Fixed
**[`src/ui/tools/commit.ts:353`](../src/ui/tools/commit.ts#L353)** (and `:338`),
**[`src/core/store.ts:324-326`](../src/core/store.ts#L324-L326)**

`commitTool` captures `doc = activeDoc.value` once and passes it by reference through a
long async handler (compose → optional confirm dialogs → a native save picker, which
can pause for seconds). `AppShell.tsx`'s undo/redo keydown handler is **not** gated by
`activeJob`, unlike tab-close which does check `busy = activeJob.value !== null`.

**Trigger:** edit a document → start an export whose commit takes a few seconds or
opens a confirm dialog (e.g. Compress's over-target confirm, or "Save over original?")
→ press Ctrl+Z while it's pending → let the export finish.
**Impact:** `save()` calls `refreshBaseline(doc.id, doc.pages)` using the stale,
pre-undo `doc.pages`, which `refreshBaseline` writes onto the document's *current*
`baseline` field looked up by id. The next export's review diff
(`alignPages(doc.baseline, doc.pages)`) shows a wrong "what changed" comparison —
stale or fabricated diffs in the Export Review modal.

### 2.3 OCR aborts the whole batch on one oversized page  ✅ Fixed
**[`src/core/ocr/runOcr.ts:203-205`](../src/core/ocr/runOcr.ts#L203-L205)**

`client.lease(api => api.renderPage(...))` inside the per-page loop
(`runOcr.ts:192`) has no try/catch. At `OCR_DPI = 300` (≈4.17× scale), a legal but
oversized custom PDF page (the spec allows up to 14,400×14,400pt) produces a canvas
request the browser will refuse. `render.worker.ts`'s `renderPage` has no size clamp
either.

**Trigger:** run OCR over a multi-page document where one page has an unusually large
page box.
**Impact:** the per-page render throws uncaught, discarding all recognition work
already completed for every earlier page in the run, surfacing only a generic failure
toast. Contrast with `scanDocumentBarcodes` (`operations.ts:1529-1558`), which already
wraps each page's render in try/catch and records a per-page failure reason for exactly
this scenario. No test constructs an oversized-page case.

### 2.4 SMask/Mask filter chain not checked for undecodable encodings  ✅ Fixed
**[`src/core/workers/process.worker.ts:3139`](../src/core/workers/process.worker.ts#L3139)**,
**[`src/core/compress-plan.ts:96`](../src/core/compress-plan.ts#L96)**

Only the *base* image's `/Filter` chain is recorded for the skip list. A FlateDecode
image whose `/SMask` or `/Mask` is itself JPXDecode is not caught.

**Trigger:** compress an image with a JPEG2000-encoded soft mask.
**Impact:** measured — routed to `surgical`, `skipped: []`; the undecodable mask stream
enters the re-encode path the skip list exists to prevent.

### 2.5 Unparseable replacement JPEG has no fallback  ✅ Fixed
**[`src/core/workers/process.worker.ts:4806,4943`](../src/core/workers/process.worker.ts#L4806)**,
**[`src/core/render.worker.ts:1623,1694`](../src/core/render.worker.ts#L1623)**

`embedJpg` is unguarded on both the surgical and raster paths. Every other failure mode
in `rebuildCompressed` calls `note({status:'skipped'})` and continues; this one doesn't.

**Trigger:** a page whose re-encoded replacement JPEG pdf-lib cannot parse.
**Impact:** `Error: SOI not found in JPEG` propagates straight out of
`rebuildCompressed` — no fallback to original bytes, no per-image skip, no user-facing
message.

### 2.6 Face-model shard corruption is permanent, with no recovery path  ✅ Fixed
**[`src/core/faceblur/download.ts:150-156`](../src/core/faceblur/download.ts#L150-L156)**,
**[`src/core/opfs.ts:104-129`](../src/core/opfs.ts#L104-L129)**

The only validation on a downloaded shard is `0 < byteLength <= 4 MiB` — no hash check,
even though the manifest's tensor shapes give the exact expected length.

**Trigger:** a dropped connection or chunked response truncates a shard mid-download.
**Impact:** measured — a shard truncated to 96,660 of 193,321 bytes resolves
successfully and is cached; a subsequent offline load re-serves the same corrupt bytes
with no network involved, and `tf.io.decodeWeights` throws a raw tensor-shape string.
There is **no delete for face-model files anywhere in `src/`** —
`forgetFaceModel` (`modelState.ts:38`) clears only the consent flag, not the cached
shard — so the failure is permanent for that browser profile with no user-reachable
recovery, and the panel keeps offering face blur as if it works.

### 2.7 Degenerate crop quad can black out or collapse a scanned page  ✅ Fixed
**[`src/core/cv/imageUtils.ts:222-269`](../src/core/cv/imageUtils.ts#L222-L269)**

`CleanupEditor.tsx:574-635` enforces no minimum area, convexity, or corner ordering on
the four crop handles. `solve`'s `< 1e-12` pivot guard doesn't fire for a rank-deficient
(collinear) system, and back-substitution has no guard of its own.

**Trigger:** drag three of the four crop corner handles onto (or near) a single line,
or collapse all four to one point.
**Impact:** measured — three collinear corners warp the entire page to solid black;
four identical corners collapse the output to a 1×1 image. The code comment claiming
"degenerate quad returns the image unchanged" does not match measured behavior.

### 2.8 Blank/uniform pages pick an arbitrary deskew angle  ✅ Fixed
**[`src/core/cv/enhance.ts:275-313`](../src/core/cv/enhance.ts#L275-L313)** (`searchSkew`)

`bestScore` initializes to `-1`; real variance is always `>= 0`, so on a zero-variance
projection (a blank separator sheet, a duplex back side, a faint page) the loop's first
candidate angle always "wins" regardless of any actual signal.

**Trigger:** run scan cleanup with deskew enabled (the default) on a blank or
near-blank page.
**Impact:** measured — a 300×400 all-white image produces `detectSkew = -16`, and the
output is resized to 399×468 — violating the module's own `<= 15°` sanity assertion in
`enhance.test.ts:171`, which currently passes only because no blank input is ever fed to
it.

### 2.9 1-bit fax scans are misclassified as unsafe to rasterize  ✅ Fixed
**[`src/core/compress-plan.ts:128,299-311`](../src/core/compress-plan.ts#L128)**

A single image with `bitsPerComponent < 8` marks the whole page's compression as
unsafe, with the stated reason "cannot be safely rasterize-able." This is the exact
CCITT/JBIG2-style bilevel fax scan that IS the archetypal input compression targets —
pdf.js renders it fine, and the raster route never touches the original image stream at
all, so image-level bit-depth is the wrong gate for a whole-page re-render decision.

**Trigger:** compress a 1-bit bilevel scanned page.
**Impact:** zero compression achieved, plus a false "already optimized" report. Also
fires spuriously for any page mixing a large photo with a small 1-bit stencil/logo.

### 2.10 Zero-byte stream reads are indistinguishable from "don't judge"  ✅ Fixed
**[`src/core/workers/process.worker.ts:4721`](../src/core/workers/process.worker.ts#L4721)** (`storedStreamBytes`)

Returns `0` both for a genuinely empty stream and when `getContents()` throws
internally (`:2721-2727`). The guard `if (originalBytes > 0 && ...)` treats both cases
as "skip judging this image's growth."

**Trigger:** an image whose content-stream read throws.
**Impact:** measured — an image that grew from 0 to 20,000 bytes was reported as
"re-encoded" rather than "skipped," masking a real growth case behind the same code
path meant to ignore an empty stream.

---

## 3. Medium

**Status (2026-09-15): all ten items below are fixed.** The first five
(OCG/optional-content, sticky notes, Type 3 fonts, Form XObject recursion,
bookmarks/embedded-files/structure-tree disclosure) were fixed together in
`src/core/workers/process.worker.ts`, `src/core/pdf/interpreter.ts`,
`src/core/workers/render.worker.ts`, and `src/ui/tools/redact/RedactPanel.tsx`
— new tests in `tests/unit/redaction-optional-content.test.ts`,
`tests/unit/redaction-type3-font.test.ts`,
`tests/unit/annotation-contents-pdfjs.test.ts` (the latter verified against
the actually-installed pdf.js's real return shape, not an assumption), plus
an updated case in `tests/unit/process.test.ts` that decompresses every
object in a produced file to prove a partially-redacted Form XObject's marked
text is gone while its unmarked text survives. RTL/bidi support was added to
all three PDF→Office writers (`docx-writer.ts`/`xlsx-writer.ts`/`pptx-writer.ts`)
via a new shared `src/core/convert/text-direction.ts` detector, using each
target library's real RTL API (verified against installed package sources,
not guessed) — `xlsx-writer.ts`'s fix is sheet-level only, a stated remaining
gap for a genuinely mixed-direction sheet, documented in the code. The
remaining four (`saveOverHandle`, Recents reopen, `FolderSearchPanel`,
Batch's ZIP-output picker) were small, self-contained UI/platform fixes with
no new component-test infrastructure introduced (this repo has none) —
verified by type-check and inspection. Full suite: 1420 tests across 105
files, plus clean `tsc --noEmit`, `eslint .`, `prettier --check .`, and
`scripts/check-invariants.mjs`.

- ✅ **Optional Content Groups dropped during redaction** —
  [`process.worker.ts:2030`](../src/core/workers/process.worker.ts#L2030)
  (`REDACTION_CATALOG_KEYS`). `/OCProperties` is stripped while the content stream
  survives, so a layer the author had switched **off** (`/D /OFF`) can end up rendering
  and printing in the redacted output. Verified: a hidden-layer secret string remains
  present while `catalog.OCProperties` becomes `undefined`.
- ✅ **Sticky-note scanning is dead code on pdf.js 6.x** —
  [`render.worker.ts:1417,1469`](../src/core/render.worker.ts#L1417). pdf.js 6.2.108
  exposes annotation text as `contentsObj.str`, not `.contents`; both scan sites read
  the old shape and always get `undefined`, so find-and-mark can never flag a sticky
  note's contents.
- ✅ **Type 3 fonts with a non-standard `/FontMatrix` break redaction glyph measurement** —
  [`process.worker.ts:6480`](../src/core/workers/process.worker.ts#L6480)
  (`fontInfoFor`). No Type 3 branch exists; a LaTeX/dvips-produced run measures roughly
  0.14pt wide instead of its real extent. Not a leak — `checkRegionText` still catches
  the mismatch and blocks the save — but redaction is effectively unusable on these
  documents.
- ✅ **Form XObjects without `/BBox`, or with partial overlap, break redaction usability**
  — [`interpreter.ts:1198-1280`](../src/core/interpreter.ts#L1198). No recursion into
  form content streams; a missing `/BBox` falls through to the image unit square
  (surviving text is caught and blocks the save, not leaked), but any *partial* overlap
  with a form XObject causes an outright refusal — making redaction unusable on
  producers that wrap an entire page in one form.
- ✅ **Bookmarks, embedded files, and structure tree silently dropped on redaction save**
  — [`process.worker.ts:2030`](../src/core/workers/process.worker.ts#L2030) +
  [`operations.ts:982`](../src/core/operations.ts#L982). Outlines (measured:
  `bookmarked-9.pdf`'s 3 bookmarks → 0), `/Names/EmbeddedFiles`, `/Dests`, and
  `StructTreeRoot` are all dropped with no message. Safe direction (no leak), but the
  redaction summary UI (`RedactPanel.tsx:236`) never discloses this loss to the user.
- ✅ **`saveOverHandle` doesn't guard `createWritable()`** —
  [`src/platform/file-system.ts:163-176`](../src/platform/file-system.ts#L163-L176).
  Missing-handle and permission-refused cases correctly return `false`, but
  `createWritable()` itself sits outside the try block. Saving over a file that was
  moved/deleted since opening throws `NotFoundError`/`NoModificationAllowedError`
  uncaught, surfacing a generic internal error instead of the friendlier "Could not
  save over the original file… Try again to save a new file instead" copy already
  written two lines below for the sibling case.
- ✅ **Recents reopen of a deleted file loses its own better error message** —
  [`src/ui/home/HomeView.tsx:61-98`](../src/ui/home/HomeView.tsx#L61-L98). When a
  persisted handle still reports `'granted'` permission but the underlying file is gone,
  `handle.getFile()` throws and is only caught by the generic outer handler, even though
  the correct "Permission was declined, or the file has moved" message exists four
  lines above for a different branch.
- ✅ **PDF→Office conversions never set RTL/bidi flags** —
  [`src/core/convert/docx-writer.ts:50-51`](../src/core/convert/docx-writer.ts#L50-L51),
  and equivalently in `xlsx-writer.ts`/`pptx-writer.ts`. The reverse direction
  (Office→PDF) already discloses its Latin-1-only limitation honestly
  (`xlsx-reader.ts:269-270`); the PDF→Office direction has no test at all for RTL
  content (`tests/fixtures/rtl.pdf` is exercised only by the unrelated "Extract text"
  tool), so whether extracted Arabic/Hebrew text lands correctly right-aligned and
  ordered in the produced document is unverified and likely wrong.
- ✅ **`FolderSearchPanel` has the same stale-response race class `6bab634` just fixed
  elsewhere** — [`src/ui/tools/ocr/FolderSearchPanel.tsx:67-80`](../src/ui/tools/ocr/FolderSearchPanel.tsx#L67-L80).
  No sequence number or cancellation check on the search promise; a fast
  type-then-backspace sequence can let an earlier (longer) query's results overwrite
  what's shown for the currently-displayed (shorter) query.
- ✅ **Batch's ZIP-output picker isn't feature-gated like its sibling buttons** —
  [`src/ui/tools/batch/BatchPanel.tsx:112-123`](../src/ui/tools/batch/BatchPanel.tsx#L112-L123).
  Calls `showSaveFilePicker` directly with no `hasFileSystemAccess()` precheck, unlike
  the input/output folder buttons which correctly show "Folder processing requires
  Chrome or Edge." On Firefox/Safari this surfaces a raw internal guard string instead.

---

## 4. Low / process gaps

**Status (2026-09-15): all four actionable items are fixed; the fifth was
never a bug.** CSP checking was added to both `.claude/hooks/check-invariants.mjs`
and `scripts/check-invariants.mjs`, which also surfaced and fixed a real
pre-existing bug: the whole-repo script referenced a `manifest.json` at the
repo root that does not exist (the real file is `public/manifest.json`), so
every check against it — including the pre-existing permissions/content_scripts
check — had been silently a no-op. The warp-target size cap, the batch
rollback fix (which also had to start re-applying restrictions to the
replayed result — a downstream tool's `compose` doesn't carry the source's
real `/Encrypt` forward the way leaving the untouched original bytes alone
does), and the Excel write-side column cap are each covered by new tests in
`tests/unit/warp-target-size.test.ts`, `tests/unit/batch-runner.test.ts`, and
`tests/unit/pdf-to-excel.test.ts` respectively. Full suite: 1425 tests across
105 files, plus clean `tsc --noEmit`, `prettier --check .`, and both
invariant scripts (verified against both a synthetically bad manifest and the
real one, then restored byte-for-byte).

- ✅ **CSP drift has no per-write coverage** — `.claude/hooks/check-invariants.mjs` only
  inspects `permissions`/`host_permissions`/`optional_permissions`/`content_scripts` in
  `manifest.json`, never `content_security_policy`. Currently correct (the one
  `connect-src` host matches the pinned model host and is asserted by
  `tests/e2e/manifest.spec.ts`), but a future CSP widening wouldn't get instant
  feedback — only caught later by `pnpm check`'s whole-repo script.
- ✅ **No absolute pixel cap on scan-cleanup's warp target size** —
  [`src/core/cv/imageUtils.ts:391`](../src/core/cv/imageUtils.ts#L391)
  (`MAX_PIXEL_GROWTH = 2`). Growth is capped relative to the quad's own bounding box
  with no absolute ceiling; measured a 10000×8000 frame with a tilted quad computing a
  16851×7999 target (~539MB RGBA), past typical browser canvas dimension limits.
- ✅ **Batch rollback can discard more than intended** —
  [`src/ui/tools/batch/runner.ts:312-320`](../src/ui/tools/batch/runner.ts#L312-L320).
  For a non-default recipe order (`compress` before `watermark`), compression's
  never-grow rollback resets to pre-compress bytes, which also discards the watermark
  applied afterwards; the user-facing note only mentions the compressed version being
  discarded. Default recipe order avoids this.
- ✅ **No column-count cap on PDF→Excel table detection** —
  [`src/core/convert/table-regions.ts`](../src/core/convert/table-regions.ts) /
  [`sheets.ts`](../src/core/convert/sheets.ts). The read side already caps at 32
  columns (`xlsx-reader.ts:122`) specifically because Excel's real limit is 16,384; the
  write side has no equivalent guard. Speculative — no fixture currently reaches this.
- **Firefox <127 opens one tab per toolbar click, by design** —
  [`src/background/service-worker.ts:25`](../src/background/service-worker.ts#L25).
  Correctly feature-detected (not UA-sniffed); the file's own comment documents this as
  an accepted trade-off rather than a hidden bug.

---

## 5. Confirmed clean — no action needed

- **Zero-network, zero-permissions, no-raw-colours, layer-boundary invariants**: no
  violations found anywhere in `src/`. The one suspicious-looking `fetch(FONT_URL)` in
  `src/core/ocr/devanagariFont.ts:74` resolves to a same-origin bundled asset via
  `import.meta.url`, correctly allow-listed. ESLint's `chrome` global restriction is
  genuinely configured and scoped, not just documented intent.
- **Cancellability**: `compressDocument`, `applyRedactions`, scan cleanup, OCR, and the
  convert pipelines all thread an `AbortSignal`/`JobHandle` through a shared
  `checkpoint()` helper that throws before any output-affecting work proceeds. Real,
  not aspirational.
- **i18n**: all 11 locale files have exactly the same key set as `en.json` — no
  missing, extra, or empty translations. No hardcoded English strings were added to
  shipped UI since the last translation-backfill commit.
- **File picker cancellation, directory-picker feature detection (outside Batch's ZIP
  button), 0-byte/non-PDF rejection, the >100MB import warning, IndexedDB quota
  handling, and the web-twin platform adapter** are all implemented correctly and
  covered by tests — not just documented intent.
- **Encryption/permissions round-trip**: `encrypted.pdf` and `not-a-pdf.pdf` are
  refused with correctly classified errors; AES-256/R6 permission-only round-trips
  preserve `/P` exactly across export/re-import for every value tested, including `0`
  and `2147483647`.
- **Redaction save gate**: has exactly one caller, both search and pattern-based
  redaction funnel through it, and the save is a full rewrite after
  `sweepUnreachableObjects` — no incremental-update remnants survive.
- **HEIC EXIF orientation, tesseract cancel-mid-run, oversized-file warnings, malformed
  zip containers for docx/xlsx/pptx, and empty sheet/slide/document handling** all have
  working code paths with matching tests.

---

## 6. Test-coverage holes behind the findings above

- No test drives `rebuildCompressed` with an `/SMask`, a `/Mask`, or a rotated page —
  exactly where §1.2, §1.3, and §2.4 live.
- `compress-plan-fixtures.test.ts:30-49` asserts `reencode: []` for `jbig2.pdf`/
  `jpx.pdf` but never asserts the actual routing decision, and its own comment claims a
  route the code doesn't take — stale. `:150-151` overwrites fixture dimensions before
  classifying, testing arithmetic rather than the fixture itself.
- `enhance.test.ts` has no blank, uniform, tiny, or huge input case, despite §2.8 living
  exactly there. `warp-target-size.test.ts:213-218` builds the exact collinear quad from
  §2.7 but only asserts `Number.isFinite`, never pushing it through `warpPerspective`.
- None of the six redaction test files touch annotations, form fields, outlines,
  embedded files, optional content groups, Type 3 fonts, or Form XObject recursion —
  all six are happy-path only.
- No unit test constructs an oversized-page OCR scenario (§2.3); only one e2e OCR test
  exists and it's happy-path.
- `faceblur-consent.test.ts` covers a too-short body and an HTTP 503, but no
  truncated-but-plausible-size body, no download-abort case, and no corrupt-cache
  recovery (§2.6).
- No test drives batch with a non-PDF/truncated input file (§1.8), or double-invokes
  "Run Batch" (§2.1).

---

## 7. Suggested priority order

1. **§1.1** (drag-drop navigation-away) — trivially reachable, destroys the entire
   session, near-zero fix cost (a single window-level `dragover`/`drop` guard).
2. **§1.2 + §1.3** (raster compression rotation/annotation loss) — CMP-02's most common
   real input path is actively corrupting output today.
3. **§1.4** (redaction off-page text bypass) — defeats the product's core redaction
   claim.
4. **§1.5** (Protect can loosen permissions) — inverts a security feature's contract.
5. Remaining Critical items (§1.6–§1.9), then High (§2), then Medium/Low as capacity
   allows.
