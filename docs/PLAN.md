# Stapler — Offline PDF Toolkit · Build Plan

> **Working name:** Stapler _(placeholder — trademark-check before store submission)_
> **Store title (draft):** `Stapler — Offline PDF Tools: Merge, Split, Compress, Sign`
> **Type:** Chrome Extension (Manifest V3) + identical static web app
> **Status:** In development. Foundation, core features, i18n, and compare implemented.

Companion documents:

- [`TICKETS.md`](TICKETS.md) — every story ticket with acceptance criteria
- [`DESIGN-ADAPTATION.md`](DESIGN-ADAPTATION.md) — design tokens, layout, component specs
- [`../DESIGN.md`](../DESIGN.md) — upstream `linear.app` design system (unmodified reference)

---

## 1. Product thesis

Every mainstream PDF tool uploads your file to a server and gates the result behind a
$9–15/month subscription. Stapler does the same work entirely inside the browser tab.

Three consequences, and they are the whole product:

1. **Zero permissions.** No content scripts, no host permissions, no `downloads` permission.
   Chrome's install dialog has nothing to warn the user about. Server-based competitors
   cannot copy this without abandoning their business model.
2. **Zero cost to operate.** No backend, no API keys, no storage. Lifetime infrastructure
   cost is the one-time $5 Web Store developer fee. "Free forever" is not a subsidy.
3. **Zero limits.** No 10MB cap, no 2-files-per-day, no watermark, no account.

**Verifiability is the marketing.** A user can open DevTools and observe zero network
requests. The repo is public so the claim is checkable. This is enforced in CI
(see [NFR-4](#54-privacy-invariants) and `QA-03`).

### 1.1 Non-goals

Explicitly out of scope. Each has a reason; do not relitigate without one.

| Not building                          | Reason                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------ |
| Pixel-perfect PDF ↔ Office fidelity   | Exact font/pagination/column reconstruction needs a full rendering engine (WASM or server-side LibreOffice) that either blows the 900KB bundle budget or breaks the zero-network invariant. We don't promise this and won't fake it. |
| Password / permission removal         | pdf-lib cannot decrypt; attracts requests we won't serve                             |
| Certificate-based signatures (PAdES)  | Incremental-update signing is a deep rabbit hole. Revisit post-v2                    |
| Editing existing text in place        | Font matching and reflow make this a trap                                            |
| Accounts, sync, cloud storage         | Breaks the cost model and the privacy claim                                          |
| Analytics, telemetry, crash reporting | Breaks the zero-network invariant. Non-negotiable                                    |

**Revision note:** PDF → Word/DOCX and Office → PDF were previously blanket
non-goals here. They're now in scope as **CNV-08..13** (§3), scoped narrowly to
what's actually achievable client-side: best-effort structural conversion
(paragraphs, headings, tables, basic runs, images), not pixel-perfect layout.
This is the same trade already made for OCR-03's table→XLSX export — ship it
labeled beta with a mandatory preview rather than not shipping it at all (see
§5.5). The reasoning that killed the old blanket non-goal is preserved above,
narrowed to the fidelity claim it actually applies to. This is a deliberate
carve-out, not a silent reversal — same pattern as RED-06 carving password
*addition* out of the still-standing password *removal* non-goal.

---

## 2. Architecture

### 2.1 Runtime shape

```
Toolbar icon click
  └─ service-worker.ts  (chrome.action.onClicked → chrome.tabs.create)
       └─ editor.html   ← the entire application, one extension page
            ├─ UI thread     Preact + signals, design-token CSS
            ├─ render.worker    pdf.js  → page bitmaps, text layers
            ├─ process.worker   pdf-lib → page ops, compression, redaction
            └─ ocr.worker       tesseract.js (lazy)
```

The service worker exists **only** to open the tab. It holds no logic and needs no
permissions (`chrome.tabs.create` with an extension URL is permission-free).

### 2.2 Why a `platform/` adapter

The same `core/` code ships as a Chrome extension **and** a static website (free SEO,
one build, three stores). Everything platform-specific lives behind one interface:

```
src/platform/index.ts        // interface: openFile, saveFile, persistHandle, openTab
src/platform/extension.ts    // chrome.* implementations
src/platform/web.ts          // no-op / <a download> fallbacks
```

`core/` must never import `chrome.*` directly. Enforced by an ESLint boundary rule.

### 2.3 Directory layout

```
stapler/
├── manifest.json
├── DESIGN.md
├── docs/{PLAN,TICKETS,DESIGN-ADAPTATION}.md
├── src/
│   ├── background/service-worker.ts
│   ├── platform/
│   ├── core/
│   │   ├── doc/          document model, import, export, undo stack
│   │   ├── ops/          merge, split, rotate, reorder, crop, nup, insert
│   │   ├── render/       pdf.js wrappers, thumbnail cache, text extraction
│   │   ├── compress/     analyzer, raster path, surgical image path
│   │   ├── scan/         corner detect, dewarp, deskew, threshold
│   │   ├── redact/       region model, text-op stripping, verifier
│   │   ├── sign/         signature capture, placement, AcroForm fill
│   │   ├── convert/      images→pdf, pdf→images, heic, markdown, text, docx/xlsx/pptx ↔ pdf
│   │   ├── meta/         metadata inspector + scrubber
│   │   ├── ocr/          tesseract orchestration, model cache
│   │   └── search/       folder index, query engine
│   ├── workers/
│   ├── ui/
│   │   ├── editor.html
│   │   ├── app.tsx
│   │   ├── shell/        TopBar, ToolRail, Canvas, OptionsPanel, ActionBar
│   │   ├── components/   design-system primitives
│   │   ├── tools/        one view per tool
│   │   └── styles/       tokens.css, base.css
│   └── lib/              idb, zip, comlink helpers, format utils
├── tests/{unit,e2e,fixtures}/
└── web/                  website-twin entry + per-tool landing pages
```

### 2.4 Stack decisions (ADR summary)

| Decision   | Choice                                                   | Rationale                                                                     |
| ---------- | -------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Build      | **Vite** + static `manifest.json` copy                   | One HTML entry means we don't need `@crxjs`; fewer MV3 breakages              |
| UI         | **Preact + TypeScript (strict)**                         | ~4KB runtime; bundle size matters when everything ships locally               |
| State      | **`@preact/signals`**                                    | Fine-grained updates; a 300-thumbnail grid must not re-render wholesale       |
| Styling    | **CSS Modules + CSS custom properties**                  | Design tokens map 1:1 to `:root` vars; theming is a class swap, no build step |
| PDF write  | **pdf-lib** (MIT)                                        | Merge, split, rotate, draw, AcroForms                                         |
| PDF read   | **pdfjs-dist** (Apache-2.0)                              | Rendering, text layer, image XObject extraction                               |
| Worker RPC | **Comlink**                                              | Removes postMessage boilerplate; transferable ArrayBuffers                    |
| Zip        | **fflate**                                               | Smallest, fastest, streaming                                                  |
| OCR        | **tesseract.js** (lazy)                                  | Only loaded when OCR is invoked                                               |
| DOCX write | **docx** (lazy)                                          | Pure JS OOXML writer, no WASM/native deps; only loaded by CNV-08              |
| DOCX read  | **mammoth** (lazy)                                       | Structural docx→HTML for Word→PDF and PDF→Word round trips; not a renderer   |
| XLSX read  | **xlsx** / SheetJS CE (lazy)                             | Apache-2.0, read-only usage for Excel→PDF                                     |
| XLSX write | *(hand-rolled, via existing `fflate`)*                   | Same zip+XML builder OCR-03 already ships, generalized for CNV-10             |
| PPTX write | **pptxgenjs** (lazy)                                     | Pure JS OOXML writer, no WASM/native deps                                     |
| PPTX read  | *(hand-rolled, via existing `fflate`)*                   | pptx is a zip of slide XML; avoids a 5th format dependency for a narrow need |
| DB         | **IndexedDB via `idb`**                                  | File handles, signatures, presets, search index                               |
| Fonts      | **System stack only**                                    | A webfont CDN request would break the zero-network claim                      |
| Unit tests | **Vitest**                                               | Fast, Vite-native                                                             |
| E2E        | **Playwright** (persistent context + `--load-extension`) | Can drive the real extension page                                             |

### 2.5 File I/O

Use the **File System Access API** (`showOpenFilePicker`, `showSaveFilePicker`,
`showDirectoryPicker`) — needs no manifest permission, enables save-over-original and
folder batch processing. Persist handles in IndexedDB for a Recents list.

Fallback chain for the website twin and Firefox: `<input type="file">` + Blob download.

---

## 3. Roadmap and cut lines

| Release               | Contents                                                                                         | Gate                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| **v0.1** internal     | EPIC-0, EPIC-11 shell, EPIC-1, EPIC-2                                                            | Merge + organize + split works end to end on 10 fixture PDFs |
| **v1.0** store launch | + EPIC-3 convert, EPIC-4 sign, EPIC-5 compress, EPIC-6 scan cleanup, EPIC-13 QA, EPIC-14 listing | All P0 acceptance criteria green; zero-network test passing  |
| **v1.1**              | EPIC-7 redaction + metadata scrubber, EPIC-8 annotate                                            | Redaction verifier proves text removal on all fixtures       |
| **v1.2**              | EPIC-9 batch + presets, crop, N-up, page numbers, watermark, CNV-08..13 Office↔PDF conversion    | Round-trip tests green for docx/xlsx/pptx fixtures; beta label + mandatory preview shipped |
| **v2.0**              | EPIC-10 OCR + local folder search                                                                | Index 200 PDFs and query in <500ms                           |
| Continuous            | EPIC-12 a11y, i18n, perf; website twin landing pages                                             | —                                                            |

**Why this order.** "merge pdf" has an order of magnitude more search volume than
"compress pdf", and merge is _certain_ to work. Ship revenue-of-attention first; the hard
engineering (compression, redaction) never blocks the first release.

**Why scan cleanup is in v1.0.** It is the single best screenshot on the roadmap — a
gray, skewed phone photo becoming a crisp white document. Store conversion is won in the
first screenshot, and the feature is mostly canvas math.

---

## 4. The two hard problems

### 4.1 Compression (EPIC-5)

Naive `pdf-lib` load→save yields 2–8%, and sometimes produces a **larger** file. The
product-correct approach is a per-page analyzer that routes to one of three paths:

| Page classification          | Path                                                                      | Expected reduction |
| ---------------------------- | ------------------------------------------------------------------------- | ------------------ |
| No extractable text (a scan) | Rasterize @ chosen DPI → JPEG q0.75 → rebuild                             | 70–90%             |
| Has text + raster images     | Surgical: re-encode image XObjects in place, leave text/vectors untouched | 30–70%             |
| Text-only, already optimized | **Report honestly, offer cancel**                                         | 0–8%               |

That third row is the differentiator. Incumbents silently return a 4%-smaller file and
let you assume it worked. Telling the truth costs nothing and buys trust.

**Known sharp edges** — budget most of the epic here, not on the happy path:

- SMasks (transparency) must be re-attached or images render as black boxes
- CMYK and Indexed color spaces need conversion before canvas re-encode
- JBIG2 / JPX images may not decode in pdf.js → **detect and skip**, never corrupt
- Never emit output larger than input; fall back to the original bytes and say so

### 4.2 Redaction (EPIC-7)

A black rectangle drawn on top is the well-documented failure that has burned law firms
and government agencies — the text underneath stays selectable. Real redaction must
remove the underlying data, and then **prove** it:

1. User marks regions (or searches for a string and marks all hits)
2. Strip intersecting text-showing operators from the content stream; clip or re-encode
   intersecting image XObjects
3. Rasterize the affected region as a final guarantee
4. **Verifier:** re-extract text from the output and assert the redacted strings are absent;
   render the region and assert no residual glyphs
5. Show the user a verification report before saving

Also strip document metadata, XMP, and embedded thumbnails in the same pass — redacted
content frequently survives in those.

---

## 5. Non-functional requirements

### 5.1 Performance budgets

| Scenario                               | Budget                                                      |
| -------------------------------------- | ----------------------------------------------------------- |
| Extension page interactive             | < 500ms                                                     |
| First thumbnail visible, 100-page PDF  | < 1.5s                                                      |
| All 100 thumbnails rendered            | < 6s (virtualized, progressive)                             |
| Main-thread block from any single task | **< 50ms** — all heavy work in workers                      |
| Merge 10 × 5MB PDFs                    | < 8s                                                        |
| Peak memory, 300-page document         | < 1.5GB; page-at-a-time processing, explicit bitmap release |
| Initial bundle (excl. lazy tools)      | < 900KB gzipped                                             |

Every long operation must be **cancellable** and report determinate progress.

### 5.2 Correctness

- No operation may silently corrupt a document. On any unrecoverable error, return the
  original bytes and surface a clear message.
- Unsupported constructs (XFA forms, encrypted files, JBIG2/JPX images) are **detected
  and explained**, never half-processed.
- Golden-file tests: every op runs against the fixture corpus and output is validated by
  re-parsing, page-count assertions, and text-extraction diffs.

### 5.3 Accessibility

WCAG 2.1 AA in both themes. Full keyboard operation including the thumbnail grid
(arrow-key navigation, space to select, drag alternatives via cut/paste-position).
Visible focus rings from tokens. `prefers-reduced-motion` respected. All icon-only
controls carry accessible labels.

### 5.4 Privacy invariants

These are hard constraints, enforced by tests, not aspirations:

1. **No runtime network request of any kind.** No fonts, no CDN, no analytics, no
   update pings. CI fails if the E2E run observes any external request.
2. No remote code execution (also an MV3 requirement). Everything bundled.
3. No permissions in `manifest.json` at v1.0. Any later addition must go in
   `optional_permissions` behind explicit user opt-in, to preserve the clean install prompt.
4. Document bytes never leave a worker except to the user's chosen save location.
5. Exactly two model downloads are exceptions, each fetched once on explicit user action,
   cached forever, clearly disclosed, and shipped behind a "download once" confirmation
   that names the host and the size:
   - the OCR language model (OCR-01, `src/core/ocr/`);
   - the face-detector weights for on-device face blur (RED-08, `src/core/faceblur/`).

   Both are *weights only*. The engines that run them (tesseract's WASM core, the tfjs
   runtime and face-api's own JS) are bundled, because item 2 forbids remote code no
   matter what the user consents to. No other fetch of any kind is permitted, and the
   invariant hook enforces that by carving out only these two directories.

### 5.5 Legal / claims discipline

- Signatures are described as **"stamped signature images"**. Do not claim ESIGN or
  eIDAS compliance or "legally binding".
- Redaction copy: state what the tool removes and that the user should review the
  verification report. No warranties.
- No competitor trademarks in listing text, name, or icons.
- Table extraction (v2+) ships labeled beta with mandatory preview — silent wrong numbers
  are worse than no feature.
- Same rule for CNV-08..13 (PDF↔Word/Excel/PowerPoint, §3): output is labeled **beta**,
  every conversion shows a mandatory preview before save, and copy states plainly that
  structure/text is preserved but layout, fonts, and pagination may differ from the source.
- License: MIT, public repo.

---

## 6. Testing strategy

| Layer        | Tool                   | Scope                                                                                                |
| ------------ | ---------------------- | ---------------------------------------------------------------------------------------------------- |
| Unit         | Vitest                 | Page-op math, region geometry, compression analyzer classification, redaction verifier, format utils |
| Golden file  | Vitest + fixtures      | Every op re-parsed and asserted; byte-size and text-content invariants                               |
| E2E          | Playwright             | Real extension page: import → operate → export, per tool                                             |
| Zero-network | Playwright             | `page.on('request')` asserts no non-extension URL is ever requested                                  |
| Perf         | Playwright + traces    | Budgets in §5.1 asserted on a 100-page fixture                                                       |
| A11y         | axe-core in Playwright | Zero violations on every route, both themes                                                          |

**Fixture corpus** (`tests/fixtures/`) — build this in `QA-01`, before feature work:
text-only, scanned (skewed phone photo), mixed text+image, CMYK, JBIG2, JPX,
transparency/SMask, AcroForm, XFA form, encrypted, 300-page, 100MB, corrupt/truncated,
CJK text, RTL text, rotated pages, mixed page sizes.

---

## 7. Distribution

1. **Chrome Web Store** — name carries most of store search weight, so keywords go in the
   title, not just the description. Screenshot 1 is the scan-cleanup before/after.
2. **Edge Add-ons + Firefox AMO** — same MV3 codebase, near-zero extra work.
3. **Website twin** — identical bundle on Cloudflare Pages with per-tool landing pages
   (`/merge-pdf`, `/compress-pdf`, `/sign-pdf`, …). Each is a separate SEO door into the
   same code at zero marginal cost, and funnels installs.
4. **i18n** — 10 locales of JSON strings is the largest single install multiplier
   available; store search is per-locale and most competitors are English-only.

Listing must state: no upload, no account, no file-size limit, no watermark, open source.

---

## 8. Risk register

| Risk                                          | Severity | Mitigation                                                           |
| --------------------------------------------- | -------- | -------------------------------------------------------------------- |
| Compression underdelivers vs. incumbents      | High     | Auto-routing analyzer; honest reporting; never ship a bigger file    |
| Store discovery failure                       | High     | Keyword-bearing title, website-twin SEO, i18n, hero screenshot       |
| Memory blowups on large files                 | Medium   | Page-at-a-time, virtualized grid, explicit release, warn >100MB      |
| pdf.js / pdf-lib API churn                    | Medium   | Pin versions; wrap both behind `core/render` and `core/doc` adapters |
| Redaction claim proves false in one edge case | High     | Verifier gate + refuse to save when verification fails               |
| Scope creep sinking v1.0                      | High     | Cut lines in §3 are contracts; new ideas land in v1.2+               |
| Feature parity race with a funded rival       | Low      | Our moat is architectural, not featural                              |
