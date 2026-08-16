# Audit spec: DOC-07, CNV-06, RED-06

**Purpose.** These three tickets were proposed as "missing features" in an earlier
competitive-analysis pass against `bigpdf.11zon.com` (target-size compression, extract
embedded images, password protection). Deeper research found all three already
implemented and marked `Status: Done` in `docs/TICKETS.md`. This document is a
**self-contained verification brief** — hand it to any agent/LLM with no other context
from this project and it should be able to independently confirm (or refute) that each
ticket really meets its acceptance criteria, against real output bytes, per this
repository's own stated standard:

> "Verify acceptance criteria against real output bytes, not against intent. 'It should
> work' is not a passing criterion." — `CLAUDE.md`

**This is a read-only audit, not an implementation task.** Do not modify
`src/core/compress-target.ts`, `src/core/workers/process.worker.ts`,
`src/core/pdf/encrypt.ts`, or any of their call sites unless you find and need to fix a
genuine defect — and if you do, say so explicitly rather than silently patching and
re-reporting green.

## Ground rules for whoever runs this

1. Don't trust the existing test suite's own assertions at face value — re-derive the
   claim independently wherever the AC allows a second method (an external tool, a
   different library, hand constructed input). Where a claim can only be checked by the
   project's own test harness, run it for real and read the actual output, don't assume
   from the ticket prose that it still passes.
2. Report per-AC-clause verdicts (PASS/FAIL/UNVERIFIABLE-IN-THIS-ENV), each with the
   concrete evidence that produced it: a command run, its output, a byte comparison, a
   file you inspected.
3. If a prerequisite tool isn't installed in this environment (e.g. `poppler-utils` for
   `pdfinfo`/`pdftotext`), say so and mark that specific check UNVERIFIABLE rather than
   skipping it silently or assuming it would pass.
4. Repo root: wherever this file lives, two directories up
   (`docs/AUDIT-SPEC-DOC07-CNV06-RED06.md` → repo root is `..`). Package manager: `pnpm`
   is intended but only `npm` may be installed — substitute `npm run <script>` for any
   `pnpm <script>` below if `pnpm` is unavailable.
5. Base commands available in this repo (`package.json` scripts):
   ```
   pnpm check      # eslint + prettier + tsc --noEmit
   pnpm test       # vitest (unit)
   pnpm test:e2e   # playwright (requires browsers installed — see below if missing)
   ```
   Playwright browsers, if not already installed: `npx playwright install chromium`
   (chromium only is sufficient for these three tickets' e2e coverage).

---

## Ticket 1 — DOC-07 · Compress to a target size

### Requirements (verbatim from `docs/TICKETS.md`)
> An "Aim for a size" preset on the compress tool hands DPI and quality to a measured
> search instead of to the user.

### Acceptance criteria (verbatim)
> A user requests a target file size; the tool finds settings that land at or under the
> target when achievable, or clearly reports when it cannot, without ever silently
> producing a larger-than-requested file.
>
> (Derived from ticket body: bisects a nine-rung DPI/quality ladder from 300 DPI/90% down
> to a 72 DPI/30% floor; the floor rung is probed first so "impossible" is a cheap,
> honest answer; capped at 5 full render+encode trials; every trial still respects
> CMP-04's safety net — an output that isn't smaller than the original is discarded.)

### Where the implementation lives
- `src/core/compress-target.ts` — pure logic, no pdf-lib/pdfjs/worker imports:
  - `export const TARGET_LADDER: readonly TargetRung[]` — 9 rungs, 300dpi/90% → 72dpi/30%.
  - `export const MAX_TARGET_TRIALS = 5`
  - `export async function searchForTargetSize<T>(options: TargetSearchOptions<T>): Promise<TargetSearchOutcome<T>>` —
    caller supplies `run: (settings, trialIndex) => Promise<TrialOutput<T>>`; probes the
    floor rung first, then bisects.
- `src/core/operations.ts:551` — `compressToTargetSize(bytes, targetBytes, options)`,
  wires `searchForTargetSize` to real `planCompression`/`compressDocument` calls. Returns
  `TargetCompressionResult { bytes, originalBytes, targetBytes, achievedBytes,
  reachedTarget, settings: TargetRung | null, keptOriginal, trials: TargetTrial[], plan }`.
- `src/ui/tools/compress/state.ts` — `compressMode: 'quality' | 'target'`,
  `compressTarget: { amount, unit: 'KB' | 'MB' }` signals.
- `src/ui/tools/compress/CompressPanel.tsx` — "Aim for a size" radio switches to target
  mode; `NumberInput` + unit `Select` for the target.

### Existing evidence to re-run and independently read (don't just check exit code)
```
pnpm test -- compress-target        # unit: bisection/probing logic in isolation
pnpm test:e2e -- compress-preview    # e2e: tests/e2e/compress-preview.spec.ts
```
Specifically inspect these two named blocks in `tests/e2e/compress-preview.spec.ts`
(around lines 212 and 243 as of this writing — line numbers drift, search by string):
- `'lands at or under a reachable target, and the written file proves it'`
- `'says so, and writes nothing, when the floor cannot reach the target'`

Read what bytes each test actually asserts on — not just that Playwright reports green.

### Independent checks to perform beyond the existing suite
1. **Never-exceeds-target, adversarially.** Pick a real PDF fixture from
   `tests/fixtures/` that's image-heavy (e.g. `scanned_skewed.pdf` or `heavy.pdf` — list
   `tests/fixtures/*.pdf` and pick by size), drive the real UI (or call
   `compressToTargetSize` directly from a small Node/Vitest script if driving the UI is
   impractical in your environment) with a target deliberately set to something clearly
   *achievable* (e.g. 50% of original size) and confirm the returned `achievedBytes` ≤
   `targetBytes` by reading the actual byte length of the returned `Uint8Array`, not a
   reported percentage.
2. **Honest failure on an impossible target.** Set the target to something clearly
   *unreachable* (e.g. 1KB on a 5MB scanned fixture) and confirm: (a) `reachedTarget ===
   false`, (b) `keptOriginal === true` or equivalent — the original bytes are returned,
   not a larger-than-target file passed off as success, (c) the UI (if you can drive it)
   surfaces a clear message rather than silently downloading a file that's still over the
   limit.
3. **Trial budget respected.** Confirm `trials.length <= MAX_TARGET_TRIALS` (5) in both
   the achievable and unreachable cases above — this bounds worst-case latency and is
   asserted nowhere as a hard runtime check outside the trial-count field itself, so
   verify it isn't silently exceeded.
4. **CMP-04 safety net still holds inside the search.** For at least one trial in a
   run, confirm the trial's own output size is compared against the *original* size (not
   just the target), i.e. a rung that happens to produce a larger file than the input is
   discarded per-trial, not just at the final result. Read `compress-target.ts` and
   `operations.ts:551` to confirm this is actually wired, since the ticket claims it
   ("every trial independently keeps CMP-04's safety net") but this is the kind of claim
   worth re-deriving from the code rather than trusting the prose.
5. **Re-parse the output.** Whatever bytes are returned in the achievable case, re-parse
   them with pdf.js (or `pdfinfo` from poppler-utils if available) and confirm the page
   count matches the input and the file opens without error — a target-size search that
   silently corrupts the document while hitting its byte target is a worse failure than
   missing the target.

---

## Ticket 2 — CNV-06 · Extract embedded images

### Requirements (verbatim)
> Pull the original image XObjects out of a PDF byte-for-byte — no re-render, no
> re-encode — distinct from CNV-02 (which rasterizes whole pages). Output each at its
> native format/resolution in a ZIP, named by page and position.

### Acceptance criteria (verbatim)
> Extracted bytes match the source image object's decoded pixels exactly (no
> generational loss versus a re-encoded round trip); a page with N images yields N files.

### Where the implementation lives
- `src/core/workers/process.worker.ts`:
  - `collectImageRefs(...)` (~line 2093) — shared with CMP-03's compression candidate
    scan; walks `/Resources/XObject`, recurses into Form XObjects, dedupes by object
    number.
  - `extractImages(bytes, pageIndices, job?)` (~line 3727, `ProcessJob` interface
    ~line 439) — the actual extraction, calling `collectImageRefs` (~line 3758).
  - `ExtractedImageEntry` / `ExtractedImages` types (~lines 2423 / 2446).
- `src/core/operations.ts:917` — `extractEmbeddedImages(bytes, pageIndices, options)`,
  the public wrapper.
- `src/core/png.ts` — hand-rolled exact PNG re-framing (preserves bit depth/palette; a
  canvas round-trip was deliberately rejected because it would promote everything to
  8-bit RGBA and cannot express a 1-bit stencil or an indexed palette).
- `src/ui/tools/extract-images/` (`ExtractImagesPanel.tsx`, 61 lines) — no settings by
  design ("no re-encode" is the whole point).

### Documented routing table (what should happen to each filter type — verify this exactly)
| Source encoding | Expected output | Why |
|---|---|---|
| `/DCTDecode` (JPEG) | `.jpg`, byte-for-byte, no decode step at all | Already a complete JFIF/Adobe JPEG |
| `/JPXDecode` (JPEG2000) | `.jp2`, byte-for-byte | pdf.js can't re-encode it, but extraction never needs to decode it |
| Transport filters only (Flate/LZW/ASCII85/ASCIIHex/RunLength, or none) | Exact PNG re-frame, same bit depth/sample order/palette | Losslessly re-containerize the already-decoded samples |
| JBIG2 | Skipped, reported | Segment sequence needs external globals object — not a standalone file |
| CCITT | Skipped, reported | Bare codestream, no lossless single-file container used here |
| CMYK / `/Separation` rasters | Skipped, reported | No lossless single-file raster format; converting would be the re-encode this ticket exists to avoid (that conversion is CNV-02's job, not this one's) |
| Non-identity `/Decode` array | Skipped, reported | Can't reinterpret samples losslessly without decoding |
| Truncated stream (declared size > actual data) | Skipped, reported | Nothing valid to extract |
| SMask/stencil mask present | Written as sibling `page-NNN-image-NN-mask.png` | JPEG can't carry alpha; merging would force a re-encode |
| Encrypted input | Refused entirely with standard message | Streams are ciphertext — "extracting" would write noise |
| Same image object reused across pages | Extracted once, later reuses reported not re-written | A logo on 300 pages should produce one file, not 300 |

### Existing evidence to re-run and independently read
```
pnpm test -- extract-images          # tests/unit/extract-images.test.ts, 16 tests
pnpm test:e2e -- tool-flows           # search for "extract images" inside tool-flows.spec.ts
```
The named e2e block: `'extract images: the extracted file holds the source image samples
exactly'` — read what it actually compares (it unzips the output and byte-compares
against `decodePDFRawStream(...).decode()` on the source PDF's own image stream).

### Independent checks to perform beyond the existing suite
1. **Byte-for-byte JPEG claim, verified externally.** Take (or build, via the
   `pdf-fixture` skill if available, or ImageMagick) a PDF with one known JPEG image
   embedded. Extract it through the real pipeline. Compare the extracted `.jpg` file
   against the original JPEG bytes with a checksum (`sha256sum` or `cmp`) — not against a
   "looks the same" visual check. This is the strongest, most falsifiable form of the AC
   and should be checked with an OS-level tool independent of the project's own test
   assertions.
2. **PNG re-frame losslessness for a non-trivial case.** Construct or locate a fixture
   with an **indexed-palette** or **1-bit** image (a fax-like scan, or a GIF converted to
   an indexed PNG then embedded) and confirm the extracted PNG, when decoded (e.g. with
   ImageMagick's `identify -verbose` or Python `Pillow`), reports the same bit depth and
   palette as the source, and that a straightforward "decode both, diff the pixels"
   comparison shows zero differences.
3. **N images on one page → N files, counted from real output.** Build or find a
   fixture with at least 3 distinct images on a single page, run extraction, and manually
   count non-mask entries in the output ZIP for that page — don't rely on a summary
   count the tool itself reports; count the actual files.
4. **Reuse dedup, verified by file count not just by claim.** Extract from a fixture
   where the same image object is referenced from 2+ pages (or construct one) and confirm
   only one file is written for it — check the ZIP's file listing directly.
5. **Skip categories, at least one verified end-to-end.** Using `tests/fixtures/jbig2.pdf`,
   `tests/fixtures/jpx.pdf`, `tests/fixtures/cmyk.pdf`, or `tests/fixtures/encrypted.pdf`
   (check which exist via `ls tests/fixtures/`), run extraction and confirm the tool
   reports the skip with a specific reason (matching this doc's routing table above) and
   writes no corrupted/empty file for that image, rather than silently producing garbage.

---

## Ticket 3 — RED-06 · Add password protection on export

### Requirements (verbatim)
> Optional owner/user password and a permission set (print, copy, modify) applied to the
> exported PDF only, entirely client-side. Clearly label this as encryption *added* at
> export, distinct from RED-04's metadata scrubbing and from the password-*removal*
> non-goal — Stapler still never opens or decrypts a document it doesn't already hold the
> password for.

### Acceptance criteria (verbatim)
> Exported file requires the set password to open in an external viewer (Chrome's own PDF
> viewer, at minimum) and the unprotected original in the editor is unaffected.

### Where the implementation lives
- `src/core/pdf/encrypt.ts` (348 lines) — hand-rolled PDF standard security handler
  (**Revision 6 / AES-256**, per ISO 32000-2 §7.6.4.3), because pdf-lib cannot write
  encrypted PDFs and no crypto dependency exists in `package.json` (confirmed: only
  `globalThis.crypto.subtle` / WebCrypto is used — AES-CBC + SHA-2 primitives — **no new
  npm dependency**):
  - `export interface ProtectionSettings { userPassword: string; ownerPassword: string;
    allowPrinting: boolean; allowCopying: boolean; allowModifying: boolean; }`
  - `export const DEFAULT_PROTECTION: ProtectionSettings`
  - `export function permissionFlags(settings: ProtectionSettings): number`
  - `export async function encryptPdf(bytes: Uint8Array, settings: ProtectionSettings): Promise<Uint8Array>`
  - Algorithm notes worth independently confirming in the code: walks every indirect
    object; replaces each `PDFString`/`PDFHexString` with its ciphertext re-encoded *as* a
    hex string (so ciphertext survives serialization); replaces each raw stream's bytes
    with ciphertext; registers the `/Encrypt` dictionary **last**, so the object walk
    never encrypts the encryption dictionary itself; sets a trailer `/ID`; saves with
    `doc.save({ useObjectStreams: false, updateFieldAppearances: false })` — deliberately
    no object streams, since an xref stream would itself need encryption handling this
    implementation doesn't do.
  - Two documented WebCrypto workarounds to verify are actually present in the code, not
    just claimed in the ticket: (a) AES-CBC always pads, so the no-padding form must drop
    the trailing block by hand; (b) there is no ECB primitive in WebCrypto, so algorithm
    10's single-block ECB step is done as CBC with a zero IV.
- `src/ui/tools/commit.ts`:
  - `applyProtection(bytes, name)` (~line 77) — called from `save()` (~line 129) before
    any write. On failure, returns `null` and **blocks the save entirely** — verify this,
    since writing the plaintext instead would hand the user a file they believe is
    protected.
  - A ZIP export path must say plainly that no password was applied (protection only
    applies to a single PDF output) — verify this message actually appears rather than
    protection being silently skipped with no indication.
- `src/ui/tools/protect/{ProtectSection.tsx,state.ts}` — lives inside the metadata/privacy
  panel (there is no standalone `'protect'` tool route); password is typed twice; setting
  resets when the active document changes.

### Existing evidence to re-run and independently read
```
pnpm test -- encrypt      # tests/unit/encrypt.test.ts, 8 passing (as documented)
```
Read what each of the 8 cases actually does — the ticket claims: pdf.js (not pdf-lib,
since pdf-lib can't open encrypted files either) is hard-set to reject with no password
and with a wrong password (`PasswordException`), opens correctly with either the user or
owner password, `getTextContent()` returns real text (proving streams decrypt), a title
string round-trips through `getMetadata()` while being **absent from the raw exported
bytes** (proving strings are encrypted, not just streams), `getPermissions()` correctly
reports print-only, the plaintext input array is untouched after the call, and
re-encrypting an already-encrypted file is refused.

### Independent checks to perform beyond the existing suite — this ticket has the highest bar, verify externally wherever possible
1. **External, non-project verification with poppler-utils, if available.** This is the
   single strongest independent check available, since it uses a completely different
   PDF implementation than either pdf-lib (which wrote the file, sort of) or pdf.js (which
   wrote the test). Check if `pdfinfo`/`pdftotext` (poppler-utils) are installed
   (`which pdfinfo`); if not, note this as UNVERIFIABLE-IN-THIS-ENV rather than skipping
   the claim silently. If available:
   ```
   pdfinfo protected-output.pdf                    # expect: exits 1, "Incorrect password"
   pdfinfo -upw '<the password>' protected-output.pdf   # expect: "Encrypted: yes (... algorithm:AES-256)"
   pdftotext -opw '<the password>' protected-output.pdf -   # expect: recovers real page text
   ```
2. **Chrome's own viewer, per the AC's literal wording.** The AC specifically names
   "Chrome's own PDF viewer, at minimum." Confirm whether the project's own e2e suite
   actually exercises this (the ticket itself admits: "headless Chromium does not run the
   PDF plugin, so the check would have been theatre" and substitutes pdf.js + poppler
   instead). If you have access to a real, non-headless Chrome, this is the one check
   worth doing manually that the automated suite explicitly could not do: open the
   protected export in an actual Chrome tab (not headless) and confirm it prompts for a
   password and that the wrong password is rejected. If you cannot do this, report it as
   the one AC clause that remains unverified by any automated means, matching the
   ticket's own stated caveat — don't present it as confirmed.
3. **Original document is unaffected — verified by identity, not by inspection.** Before
   calling `encryptPdf`, checksum the input bytes (`sha256sum` or equivalent). After the
   call, checksum the *original* array/reference again (not the returned encrypted
   bytes) and confirm it's unchanged, and separately confirm the in-editor document
   (if you can drive the UI) still opens and displays normally with no password prompt —
   i.e. protection is applied only to the exported copy, never mutates the working
   document.
4. **Permission flags, checked bit-for-bit.** For at least two different
   `ProtectionSettings` combinations (e.g. print-only vs. print+copy, no-modify in both),
   confirm via `pdfinfo` or `getPermissions()` that the *reported* permissions match what
   was requested — not just that *some* permission restriction is present.
5. **Re-encryption refusal, confirmed as an explicit rejection, not a silent double-wrap.**
   Take an already-encrypted PDF (output of a prior `encryptPdf` call) and call
   `encryptPdf` on it again. Confirm the function actually refuses (throws / returns an
   error) rather than producing a nested/corrupted result that happens to still open with
   *a* password.
6. **A failed encryption blocks the save, confirmed by forcing a failure.** If feasible,
   construct a condition that makes `encryptPdf` throw (e.g. malformed input bytes it
   can't parse) and confirm `commit.ts`'s `save()` actually returns without writing a file
   — i.e., no plaintext fallback file appears on disk.

---

## Reporting format expected back

For each of the three tickets, report:
- A verdict per AC clause: **PASS** / **FAIL** / **UNVERIFIABLE-IN-THIS-ENV** (with the
  specific missing prerequisite named).
- The concrete evidence for each verdict — command + output, or byte comparison result,
  or file path inspected — not a restatement of the ticket's own prose.
- Any discrepancy between what `docs/TICKETS.md` claims and what you actually observed,
  named plainly (this is the entire point of the audit — a stale or optimistic ticket
  entry is exactly the failure mode this document exists to catch).
- If you find a genuine defect (not just an unverified claim), describe it precisely
  (file, line, reproduction) but do not silently fix it — flag it for a decision on
  whether to open a new ticket or patch in place.
