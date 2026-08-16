# Competitive analysis — bigpdf.11zon.com vs. Stapler

> **Correction, round 3.** The three "gaps" this document originally identified —
> target-size compression, extract embedded images, and password protection — **already
> exist** in this codebase as `DOC-07`, `CNV-06`, and `RED-06`, all `Status: Done` in
> `docs/TICKETS.md`. The error: the first research pass read only the first 849 of 1626
> lines of `TICKETS.md` and missed them. The user-motivation findings in round 2 below
> (especially why target-size compression is the primary demand driver) are still
> accurate and worth keeping — they just argue for **verifying** existing work rather
> than building new work. See `docs/AUDIT-SPEC-DOC07-CNV06-RED06.md` for the independent
> verification brief written from this correction.

## Round 2: why people actually use it (user-motivation research)

Feature parity alone understates one gap and overstates the urgency of the others. Here's
what surfaced from reviews, a third-party comparison blog, and search-intent research —
not from 11zon's own marketing copy.

### The real driver: exact target-size compression for form/portal uploads

The single biggest reason this category of tool exists is **hard, arbitrary file-size
caps set by third parties the user doesn't control** — government exam portals, job
application systems, university admissions, visa applications. These caps are often
absurdly small and exact: "photo must be under 20KB," "certificate PDF must be under
100KB," "resume must be under 200KB." A quality slider that lands "somewhere smaller"
doesn't solve this; the user needs a specific number.

This is corroborated two ways:
- 11zon's own SEO strategy is built around it — dedicated landing pages like
  `/reduce-pdf/reduce-pdf-to-11kb`, and a third-party blog specifically calling out the
  **"100kb feature"** as the headline use case, ahead of merge or convert.
- General search-intent research on "compress PDF for job application" confirms the same
  pattern independent of 11zon: portals commonly enforce specific caps (2MB/5MB/10MB for
  corporate ATS systems like Workday/Greenhouse; far smaller — 100KB/200KB — for
  government and exam systems processing huge applicant volumes), and the complaint
  "compression got it *smaller* but not *under the limit*" is the actual pain point, not
  "my file is too big" in the abstract.

**Implication:** gap #2 in the table below (target-size compression) isn't a minor
enhancement to CMP-05 — it's plausibly the single highest-leverage feature to close, and
the reason to prioritize it above extract-images or protect-PDF.

### Everything else that drives adoption is convenience, not capability

- **Zero friction**: no install, no signup, works from whatever device/browser is at
  hand — often a shared or locked-down computer (library, cyber café, work machine
  without admin rights) where installing software isn't an option at all. Stapler's
  "it's a Chrome extension" model doesn't fully match this — a user on a locked-down
  public machine may not be able to install *any* extension either, browser or not. The
  website twin (`dist/web`) is the piece of Stapler's own architecture that actually
  serves this use case, not the extension.
- **All-in-one**: PDF and image tools live in one place, which matters to non-technical
  users who don't want to search for and vet five different single-purpose sites.
- **No artificial rationing**: reviewers position it against Smallpdf's 2-tasks/hour free
  tier specifically — the competition it's winning against is paywalled quotas, not
  privacy-respecting tools. Stapler already wins this by construction (no server means
  no metering to enforce).

### What actual reviews complain about — validates Stapler's approach, doesn't add new scope

- Ads and popups during processing (disruptive, not present in Stapler by design/invariant).
- Missing text-editing, annotation, and reading features — Stapler already has ANN-01
  (annotation) and exceeds this.
- Marketing claims for some conversions (Word/PPT batch) that reviewers say don't
  actually work — a reliability complaint, not a feature request; reinforces that
  Stapler's non-goal on Office↔PDF is the right call rather than a gap to close.
- Slow uploads on multiple files — inherent to any server-round-trip model; doesn't
  apply to Stapler's local processing.
- The 2-hour server retention is flagged by reviewers as a privacy risk **despite** being
  advertised as a feature — this is direct evidence that "we say we delete it" doesn't
  read as trustworthy as "it never left your machine." Worth using verbatim in Stapler's
  own trust-page copy (`DS-07`) as a point of contrast, if not already.


Researched 2026-08-16. Source: `bigpdf.11zon.com/en/compress-pdf/` and related tool pages
(fetched live), plus search results for the site's tool catalogue. Not a code change —
this is the requirements doc requested before any implementation.

## How 11zon actually works (important framing)

BigPDF is a **server-upload** tool: files go to their servers over HTTPS, get processed,
and are auto-deleted after 2 hours. No account required, no stated file-size or daily
limits, no ads observed. That model is the exact thing Stapler's `PLAN.md` §1 positions
against — "every mainstream PDF tool uploads your file to a server." Where a feature
exists on both sides, Stapler's version is already the stronger claim (zero-upload) even
if the on-screen options are similar. The gaps below are about **feature coverage**, not
about matching their architecture.

## Full 11zon tool catalogue → Stapler mapping

| 11zon tool | Stapler equivalent | Status |
|---|---|---|
| Compress PDF (quality slider) | CMP-01..05 | **Have** — arguably more sophisticated (per-page routing, honest reporting, live preview) |
| **Reduce PDF to exact size** (e.g. "reduce to 11KB") | — | **Gap** — see below |
| Merge PDF | OPS-01 | Have |
| Merge PDF + image in one pass | OPS-01 + CNV-01 (separate steps) | Have, via two tools rather than one combined flow — minor UX gap, not a capability gap |
| Split PDF | OPS-03 | Have (4 modes, exceeds their single range-split) |
| Crop PDF | OPS-06 | Have |
| Organize (drag reorder) | DOC-04 | Have |
| Rotate PDF | OPS-02 | Have |
| Remove pages | OPS-02 | Have |
| Extract PDF (pages → new file) | OPS-03 | Have |
| **Extract Images** (pull embedded image XObjects out as files) | — | **Gap** — see below |
| Add page number | OPS-08 | Have |
| Add watermark | OPS-08 | Have (text + image, exceeds their offering) |
| Image/JPG → PDF | CNV-01 | Have |
| Word/PowerPoint/Excel → PDF | — | **Deliberate non-goal** (`PLAN.md` §1.1: "Office → PDF — WASM options are enormous; docx→HTML→print quality is indefensible") |
| Text → PDF | CNV-05 (Markdown → PDF covers this) | Have, close enough |
| PDF → Image/JPG | CNV-02 | Have |
| PDF → Word/PowerPoint | — | **Deliberate non-goal** (`PLAN.md` §1.1: "PDF → Word/DOCX — layout reconstruction is its own product") |
| PDF → Excel | — | Partially covered by OCR-03 (table extraction → CSV/XLSX, beta) for tabular content; not a general PDF→Excel |
| PDF → Text | CNV-04 | Have |
| Unlock PDF (remove password) | — | **Deliberate non-goal** (`PLAN.md` §1.1: "pdf-lib cannot decrypt; attracts requests we won't serve") |
| **Protect PDF (add password)** | — | **Gap, not currently a stated non-goal** — see below |

## Real gaps worth a ticket

### 1. Extract embedded images
Distinct from CNV-02 (which rasterizes whole *pages* to images at a chosen DPI). This
pulls the actual image XObjects already embedded in the PDF out as standalone files
(PNG/JPEG), at their original resolution, without re-rendering the page. Straightforward
with pdf.js's image XObject access (the same machinery CMP-03 already uses to enumerate
images) — low technical risk, no new dependency, fits the existing `core/convert/`
directory. Would sit naturally next to CNV-02 in EPIC-3.

### 2. Reduce PDF to an exact target size
11zon lets a user type a target size (or pick "reduce to 11KB"-style presets) and the
tool searches for a quality/DPI setting that hits it, rather than exposing a raw quality
slider. Stapler's CMP-05 already has the live preview and measured-projection
infrastructure (`refineEstimate`) needed to do a bisection/binary search over quality or
DPI to converge on a target byte count. This is an enhancement to CMP-05's panel, not a
new pipeline — moderate effort, no new architecture.

### 3. Protect PDF (add a password)
Not currently in `TICKETS.md` at all, and not explicitly listed as a non-goal — only
**password removal** is called out as out of scope, for the specific reason that pdf-lib
cannot decrypt. Adding standard PDF encryption (RC4/AES, user + owner password) is a
different, tractable problem, but pdf-lib itself has no native encryption support either,
so this would need either a small additional library or hand-rolled PDF standard security
handler implementation (RFC-documented, but real work — likely `M`–`L`). This needs an
explicit decision: is "Protect PDF" in scope, and if so does it get its own line in
`PLAN.md` §1.1's non-goals table (to join password *removal*) or does it get a ticket.

## Non-gaps: explicitly out of scope, unchanged by this research

- Word/PowerPoint/Excel → PDF and PDF → Word/PowerPoint: confirmed deliberate non-goals,
  reasons already documented in `PLAN.md` §1.1. 11zon offers these because server-side
  Office rendering (e.g. LibreOffice headless) is cheap to run on a server; it is not
  cheap or high-quality client-side in a browser tab. No change recommended.
- Unlock PDF (password removal): confirmed deliberate non-goal, same reasoning as above.
  No change recommended.

## Suggested next step (re-prioritized after round 2)

Three candidate tickets, now ordered by user-motivation evidence rather than effort:

1. **`CMP-06 · Target-size compression`** — `M`, EPIC-5, builds on CMP-05. Promoted to
   top priority: this is the actual demand driver behind the whole "compress pdf" search
   category, not a slider nicety. UI: a "target size" input (with a few common presets —
   100KB, 200KB, 500KB, 1MB, matching what exam/job/visa portals actually demand) that
   drives a bisection search over DPI/quality using CMP-05's existing measured-projection
   machinery, converging on "smallest output ≤ target" or clearly reporting when the
   target isn't achievable without visible quality loss.
2. `CNV-06 · Extract embedded images` — `S`, EPIC-3, low risk, still worth doing but no
   longer the more urgent of the two feature gaps.
3. `SEC-01 · Protect PDF with a password` — `M`/`L`, new epic, needs a scope decision
   first (which encryption strength/spec to support, and whether it belongs in
   `PLAN.md`'s non-goals table instead). Lowest priority — no evidence surfaced in either
   research pass that this drives usage the way target-size compression does.

Secondary, non-feature takeaway: the website twin (`dist/web`) matters more to this
audience than the research initially suggested, since a meaningful share of this
traffic is on locked-down machines where even installing a browser extension isn't
possible. Worth confirming `dist/web` parity is a release gate, not an afterthought,
if it isn't already.

This document makes no code changes. Awaiting review before any ticket is opened or
implemented.
