# Release Checklist

Follow these steps when preparing a new release for Stapler. Per `docs/TICKETS.md`
(DIST-05): **no release ships without a green zero-network test.** That test — not
this checklist — is the thing that actually protects the product's central claim,
so it gets its own explicit step below rather than being buried inside "run verify."

## 1. Pre-Release Verification
- [ ] **Version Bump:** Update the version number in `package.json` according to semantic versioning.
- [ ] **Manifest Update:** Ensure the `version` field in `public/manifest.json` matches the new version.
- [ ] **Changelog:** Move the `[Unreleased]` entries in `CHANGELOG.md` under a new
      `[x.y.z] — YYYY-MM-DD` heading.
- [ ] **`pnpm check` (or `npm run check`):** typecheck, lint, format, design-token
      audit, contrast audit. Must be clean on the tree you intend to release.
- [ ] **`pnpm test` (or `npm test`):** the full Vitest unit suite.
- [ ] **`pnpm test:e2e` (or `npm run test:e2e`):** the full Playwright suite —
      includes every P0 tool flow, accessibility, and performance budgets.
- [ ] **Zero-network test is green:** confirm `tests/e2e/zero-network.spec.ts`
      passed in the run above (it is part of `test:e2e`, but check it by name —
      a broader suite passing does not tell you *this specific* test ran and
      passed). This is the test that would catch an accidentally-added CDN
      import, Google Fonts link, or analytics snippet before it ships.
- [ ] **Known, analysed bundle findings — read this before filing a panic:** a
      content scan of the built output turns up two hits that are *expected*, and
      a release should not be held for either. Anything **not** on this list is a
      real finding and is a release blocker until it is explained.
      1. **One `XMLHttpRequest` in `assets/pptxgen.es-*.js`** (CNV-12's
         `pptxgenjs` chunk). This is the library's `encodeSlideMediaRels`, which
         resolves a media relationship that has no `data` of its own. It is not
         reachable from this app: `addImage` is called from exactly **one** place
         in the whole source tree (`src/core/convert/pptx-writer.ts`), that call
         sets `data` **unconditionally** and never sets `path`, and the library
         picks its candidates with a single filter — `rel.type !== 'online' &&
         !rel.data && …` — that gates the browser XHR branch and its `node:fs` /
         `node:https` branches alike. A relationship carrying its own bytes is
         excluded before any branch is chosen. Full reasoning: `docs/TICKETS.md`
         § CNV-12, "`pptxgenjs` is a genuinely new dependency".
         Note that this hit is **not** something the `verify-offline` skill's
         layer 2 looks for — that layer greps the built bundle for `http://`,
         `https://`, `fetch(` and the known CDN hosts, and `XMLHttpRequest`
         appears only in its layer 1, which is `src/`-only and so never reaches a
         dependency's chunk. It is recorded here because a reviewer who
         reasonably *widens* that grep will find it, and an unexplained fresh hit
         in a network-claim audit is exactly the thing that should stop a release
         if nobody has written down why it does not.
      2. **`http(s)://` literals inside that same chunk** — which layer 2 *does*
         find. Measured on the built chunk: the only hosts are
         `schemas.openxmlformats.org`, `schemas.microsoft.com`, `purl.org` and
         `www.w3.org` — XML namespace URIs, i.e. identifiers that are never
         dereferenced — plus `gitbrent.github.io` / `github.com` links inside the
         library's own `throw new Error(...)` strings. The chunk holds **0**
         occurrences of `fetch(` and **0** of `WebSocket`; `node:fs`,
         `node:https` and `image-size` are stubbed out by the package's own
         `browser` field.
      Layer 3 of `verify-offline` (the runtime request monitor, i.e. the
      zero-network test above) is what actually covers both, and it drives a real
      PDF → PowerPoint conversion that embeds real images.
- [ ] **QA-05 — automated structural validation:** run `pnpm run qa05` before each
       release. Validates that every P0 tool's PDF output round-trips through pdf-lib
       without XRef corruption or parse error. All 8 checks pass (Merge, Rotate,
       Split, Export/Compose, Compress, Sign/AcroForm, Annotate, Table Extract CSV).
       Evidence (2026-08-16):
       ```
       ✅  Merge (OPS-01): Two 1-page PDFs merged into 2-page output
       ✅  Organize/Rotate (OPS-02): Page rotation survives serialise → re-parse
       ✅  Split (OPS-03): Split 3-page doc into 3 single-page outputs
       ✅  Export/Compose (DOC-05): Document serialises and re-parses without error
       ✅  Compress (CMP-03): Compressed output re-parses cleanly
       ✅  Sign/Fill (SGN-03, SGN-06): AcroForm text field survives serialise → re-parse
       ✅  Annotate (ANN-01): Highlight annotation embedded without XRef error
       ✅  Table Extract (OCR-03): CSV export from table data is non-empty and valid
       ✅  All 8 structural checks passed.
       ```
 - [ ] **QA-05 — Chrome PDF viewer (manual):** open a representative output from
       each P0 tool. Confirm no warnings on open, content matches Stapler's preview.
 - [ ] **QA-05 — Adobe Acrobat Reader (manual):** same as above.
 - [ ] **QA-05 — macOS Preview (manual):** same as above.
 - [ ] **QA-05 — Firefox pdf.js (manual):** same as above.
       Record pass/fail per viewer per tool in this file's git history or an issue.
 - [ ] **QA-05 — Microsoft Word and LibreOffice Writer (manual, CNV-08):** open a
       `.docx` produced by PDF → Word from `tests/fixtures/pdf-to-word.pdf`.
       Confirm **no repair prompt**, the two headings carry Word's Heading 1 /
       Heading 2 styles, the table is a real editable table (click into a cell),
       the bold and italic runs are emphasised, and the image is visible on the
       second page. Structural conformance is already asserted against the output
       bytes by `tests/unit/pdf-to-word.test.ts` (via `mammoth` and by unzipping
       the OPC package) — this step is specifically about the two real
       applications, which no test in this repo can launch.
 - [ ] **QA-05 — PDF viewers, Word → PDF output (manual, CNV-09):** open a PDF
       produced by Word → PDF from `tests/fixtures/word-to-pdf.docx` in Acrobat
       Reader, macOS Preview and Chrome's viewer. Confirm **no warning on open**,
       and that it reads as a faithful *structural* copy of the source: both
       headings are visibly larger and bold, the bulleted and numbered lists show
       their markers and indents, the table is drawn with its rules and its
       header row is bold, the bold/italic runs in the body sentence are
       emphasised, and the image is visible and not distorted. Select the text
       and confirm it copies out cleanly. Word's own pagination and fonts are
       *not* reproduced — that is the tool's stated limitation, not a defect to
       raise here. Text, table cell values, page size, `/Title`, fonts and the
       image XObject are already asserted against the output bytes by
       `tests/unit/word-to-pdf.test.ts` (re-extracted with pdf.js and re-parsed
       with pdf-lib) — this step is specifically about the real viewers, which no
       test in this repo can launch.
 - [ ] **QA-05 — Microsoft Excel and LibreOffice Calc (manual, CNV-10):** open an
       `.xlsx` produced by PDF → Excel from `tests/fixtures/pdf-to-excel.pdf`.
       Confirm **no repair prompt**, that the workbook carries the three sheets
       the preview listed (`Page 1 Table`, `Page 1 Text`, `Page 2 Text`) in that
       order, that `Page 1 Table` renders as a 5 × 4 grid with `Region /
       Revenue / Units / Change` as its first row, and that the two text sheets
       render one line of the page per row. Check that every cell is still
       **text**: `1,204` and `318` must read exactly as drawn, left-aligned and
       unconverted, not re-formatted as numbers — that is the writer's
       deliberate choice, not a defect. Borders, merged cells, column widths and
       formulas are *not* reconstructed and their absence is the tool's stated
       limitation, not something to raise here. The cell grid, the package's
       relationship graph and every part's XML are already asserted against the
       output bytes by `tests/unit/pdf-to-excel.test.ts` (read back both with
       SheetJS's `XLSX.read` and by unzipping the OPC package with `fflate`) —
       this step is specifically about the two real applications, which no test
       in this repo can launch.
 - [ ] **QA-05 — PDF viewers, Excel → PDF output (manual, CNV-11):** open a PDF
       produced by Excel → PDF from `tests/fixtures/excel-to-pdf.xlsx` in Acrobat
       Reader, macOS Preview and Chrome's viewer. Confirm **no warning on open**,
       and that it reads as a paginated grid: four sections headed `Summary`,
       `Regions`, `Blank` and `Wide` in that order, each grid drawn with its
       hairline cell borders, `Summary` showing `1,204.50` / `2026-01-15` /
       `8.1%` as Excel displays them (not `1204.5` / an ISO timestamp / `0.081`)
       and `2,191.50` where the formula was, `Regions` showing only its two
       visible columns and three visible rows, `Blank` saying it is empty, and
       `Wide` continued as three labelled column bands (`Columns A-H (1 of 3)`
       and so on) with all twenty `Metric NN` headers present. The hidden sheet
       `Notes` must not appear anywhere. Select the text and confirm it copies
       out cleanly. Excel's own print setup, cell styling and merged cells are
       *not* reproduced — that is the tool's stated limitation, not a defect to
       raise here. Cell values, formatting, hidden-content exclusion, column
       widths, page size, `/Title` and the section order are already asserted
       against the output bytes by `tests/unit/excel-to-pdf.test.ts`
       (re-extracted with pdf.js and re-parsed with pdf-lib, including the cell
       widths read out of the content streams) — this step is specifically about
       the real viewers, which no test in this repo can launch.
 - [ ] **QA-05 — a workbook authored by real Microsoft Excel (manual, CNV-11):**
       every `.xlsx` in this repo's test corpus — `tests/fixtures/excel-to-pdf.xlsx`
       included — was **written by SheetJS's own writer**, so every automated
       check of Excel → PDF reads back a file produced by the same library that
       parses it. That is a real blind spot the second review pass recorded
       rather than papered over: it cannot catch anything Excel writes
       differently from SheetJS (styles inline vs. shared, `!cols`/`!rows`
       shapes, shared strings, `dimension` vs. inferred ranges, a worksheet part
       named something other than `sheetN.xml`). So convert **at least one
       workbook saved by a real copy of Microsoft Excel** (not LibreOffice, not
       Google Sheets export, not a round trip through this repo) containing:
       currency, percentage and date formats; a formula; a hidden sheet, a
       hidden row and a hidden column; one sheet left genuinely blank; and more
       than twelve columns. Confirm the displayed values match Excel's, the
       hidden content is absent, the blank sheet says "This sheet is empty."
       (and **not** that it could not be read — that message means the reader
       failed to parse a part it should have), and the wide sheet is continued
       as labelled column bands. A workbook saved by LibreOffice Calc is worth a
       second pass for the same reason.
 - [ ] **QA-05 — Microsoft PowerPoint and LibreOffice Impress (manual, CNV-12):**
       open a `.pptx` produced by PDF → PowerPoint from
       `tests/fixtures/pdf-to-ppt.pdf`. Confirm **no repair prompt**; that the
       deck holds four slides in page order; that the slide size reads 8.5 × 11
       in (File → Page Setup / Slide Size), i.e. the *source page's* size and not
       a 4:3 or 16:9 preset; that slide 1 shows the title, the three body lines
       and the photo roughly where the PDF page draws them, with `17 percent`
       bold and `unaudited` italic; that slide 2 (the A4 page) is scaled and
       centred rather than stretched; that slide 3's text reads the same way up
       as the rotated source page does; and that slide 4 shows the same photo
       again at a smaller size. Click a text box and confirm it is an editable
       text box, one per line of the page — that is the output's shape, not a
       defect. **What must not be raised here**, because all of it is stated in
       the panel before the conversion runs: text does not reflow, the deck's
       theme font is used rather than the PDF's, all text is black, and no vector
       drawing, rule, border or background is reproduced. Slide count and order,
       per-slide text (compared against pdf.js's own reading of each page), box
       and picture geometry in EMU, run properties, the media parts and their
       relationships are already asserted against the output bytes by
       `tests/unit/pdf-to-ppt.test.ts` (read back with `pptx-reader.ts` and by
       unzipping the package with `fflate`) — this step is specifically about the
       two real applications, which no test in this repo can launch, and about
       whether the approximation is *usable*, which no test can judge.
 - [ ] **QA-05 — an OCR'd scan through PDF → PowerPoint (manual, CNV-12):** the
       one case where the tool's default is knowingly wrong-looking. Run the OCR
       tool over a scanned page, then convert the result with **both** options
       on: the invisible text layer becomes visible black type over the page
       image, because PowerPoint has no invisible text. Confirm the panel's
       limitation list says so, that switching "Place page text" off produces a
       usable image-only deck, and that switching "Place embedded images" off
       instead produces the text alone. If the black-over-scan result reads as a
       bug rather than as the disclosed behaviour, the copy needs strengthening —
       raise that, not the rendering.
 - [ ] **QA-05 — a deck a person actually authored, through PowerPoint → PDF
       (manual, CNV-13):** the gap this tool cannot close in a test. Every
       fixture in this repo is machine-written, so the two things no automated
       check here has ever exercised are a real **slide master/layout** and a
       real **theme**. Take a `.pptx` authored in PowerPoint or Impress — ideally
       one using a built-in template — and convert it. Expect, and do **not**
       raise, all of the following, because each is stated in the panel before
       the conversion runs: any title, footer, slide number or background that
       comes from the *layout* rather than from the slide is absent; all text is
       black; no shape fill, outline, shadow or slide background is drawn; every
       glyph is Helvetica at the deck's stated size, so lines are wider or
       narrower than PowerPoint draws them and a box can overrun. **Do raise:**
       a page count that is not one per slide; text that is on the wrong page;
       a shape at visibly the wrong position (especially a *grouped* shape, or a
       table, which are the two the reader had to learn for this ticket); a slide
       that comes out blank when its text is visibly typed into the slide rather
       than inherited; or a deck refused with a message that does not describe
       what is actually wrong with it. A deck whose slides *are* entirely
       inherited placeholders is refused by design, with a message naming that
       cause — confirm the message reads as an explanation and not as a failure.
 - [ ] **QA-05 — PDF viewers, PowerPoint → PDF output (manual, CNV-13):** open a
       PDF produced from `tests/fixtures/ppt-to-pdf.pptx` in Acrobat, Preview and
       Chrome's built-in viewer. Confirm four pages, each 13.33 × 7.5 in with
       "Match the slide size" (File → Properties → Page Size), the title at the
       *top* of page 1 and the footer at the *bottom* (an inverted y flip is the
       one failure that would look internally consistent everywhere else), the
       picture on pages 2 and 4, and the table's grid drawn on page 3. Then
       convert again onto A4 and confirm each slide is scaled and centred between
       two equal bands rather than stretched. Page count, per-page text (compared
       against the source deck's own runs, read back with `pptx-reader.ts`), the
       title and footer baselines, the picture's `cm` placement and the
       one-object-for-two-placements image sharing are already asserted against
       the output bytes by `tests/unit/ppt-to-pdf.test.ts` — this step is about
       the three real viewers, which no test in this repo can launch.
- [ ] **Feature Complete:** All features for this release are implemented; any
      known limitation is disclosed in the relevant panel, not silent.
- [ ] **HEIC decoder licence (legal review, before first store release):**
      `libheif-js` (the HEIC decoder, `src/core/raster-decode.ts`) is LGPL-3.0. It
      ships as a separate, replaceable WASM chunk with its licence text included in
      `THIRD_PARTY_LICENSES.txt` (see `scripts/third-party-licenses.mjs`), which
      satisfies LGPL §4's "prominent notice" requirement, but confirm with counsel
      that this distribution shape is acceptable before the first Chrome Web Store /
      AMO submission. Not required again for routine updates once cleared.

## 2. Build the Extension
- [ ] **Clean Build:** Remove any old `dist/ext` folder.
- [ ] **Build:** Run `npm run build:ext` — emits the unpacked extension to `dist/ext`.
- [ ] **Review Artifacts:** Check `dist/ext` for `manifest.json`, `background.js`,
      `editor.html`, and every icon size, correctly minified.

## 3. Local Testing of the Build
- [ ] **Load Unpacked:** Open Chrome, go to `chrome://extensions`, enable "Developer mode", and click "Load unpacked". Select the `dist/ext` folder.
- [ ] **No install warning:** confirm Chrome's install dialog shows no permission
      warnings at all (F-02's whole point) — a regression here is a release blocker.
- [ ] **Functionality Check:**
  - Open the extension and test the primary workflows (Merge, Split, Compress, Sign, Redact).
  - Verify offline functionality: disable networking entirely and confirm every tool still works.
- [ ] **No Console Errors:** Open DevTools for the extension's editor tab and ensure there are no errors in the console.

## 4. Packaging
- [ ] **Package:** Run `pnpm package` (`scripts/package.mjs`). It builds all three
      targets, runs `validate-builds.mjs`, re-checks the built manifests (version matches
      `package.json`, zero permissions, no content scripts, `THIRD_PARTY_LICENSES.txt`
      present, no extension `manifest.json` in `dist/web`, the website's entry scripts
      content-hashed), then writes `dist/release/stapler-<version>-chrome.zip`,
      `…-firefox.zip` and `…-web.zip` — the *contents* of `dist/ext` / `dist/firefox` /
      `dist/web`, every `*.map` left out, fixed timestamps so a rebuild of the same tree
      gives identical bytes — plus a `<zip>.sha256` next to each zip and
      `dist/release/SHA256SUMS` covering all three. Do not zip by hand. (`--skip-build`
      re-packages existing `dist/` output.) On a tag push, the release workflow (§6) runs
      this for you; run it locally only to rehearse.
- [ ] **Extension e2e:** `pnpm test:e2e:ext` passes against that build (with
      `STAPLER_EXT_PREBUILT=1` to test the `dist/ext` you just packaged rather than a
      rebuild).
- [ ] **Browser floors:** `minimum_chrome_version` (Chrome) and gecko
      `strict_min_version` (Firefox) come from `scripts/browser-floors.mjs`. After a
      pdf.js upgrade, re-check its table — `tests/unit/browser-floors.test.ts` fails
      until you do.

## 5. Chrome Web Store Publishing
- [ ] **Upload the CI-built zips, never a local build.** Download the zips from the
      GitHub release the tag created (they are the bytes the release workflow tested)
      and upload those to every store, and submit the source at that tag when AMO asks
      for it. A local `pnpm package` of the same source is not byte-identical to the CI
      build, so a reviewer rebuilding from source would not match a locally built upload.
- [ ] **Upload Package:** Go to the [Chrome Developer Dashboard](https://chrome.google.com/webstore/devconsole).
- [ ] **Create/Update Item:** Upload `dist/release/stapler-<version>-chrome.zip`.
- [ ] **Update Listing:** Ensure all Store Listing details (description, screenshots, promotional images) are up-to-date (refer to `docs/STORE_LISTING.md`).
- [ ] **Privacy Policy:** Ensure the Privacy Policy URL is still correct and accessible (or points to the bundled/GitHub version if applicable).
- [ ] **Submit for Review:** Click "Submit for Review".

## 5b. Edge Add-ons and Firefox AMO (DIST-04)
- [ ] **Edge:** `dist/ext` is Edge-compatible unmodified — no separate build. Load it via
      `edge://extensions` → "Load unpacked" and repeat the "No install warning" and
      "Functionality Check" steps from §3 before uploading the same `.zip` to the
      [Edge Add-ons Developer Dashboard](https://partner.microsoft.com/en-us/dashboard/microsoftedge/).
- [ ] **Firefox build:** Run `npm run build:ext:firefox` — emits a second unpacked
      directory, `dist/firefox`, with an AMO-shaped `manifest.json` (`browser_specific_settings.gecko.id`,
      `background.scripts` instead of `service_worker`).
- [ ] **Firefox gecko.id:** Before the first real AMO submission, replace the placeholder
      `gecko.id` in `scripts/firefox-manifest.mjs` with the ID AMO issues (or the one you
      chose at registration) — grep the file for `TODO(DIST-04)`.
- [ ] **Load Temporary Add-on:** `about:debugging#/runtime/this-firefox` → "Load Temporary
      Add-on" → select `dist/firefox/manifest.json`. Repeat the "Functionality Check" from
      §3, paying particular attention to file open/save: Firefox has no File System Access
      API, so opening should fall back to `<input type=file>` and saving to a browser
      download, not a picker.
- [ ] **Submit:** upload `dist/release/stapler-<version>-firefox.zip` (made by
      `pnpm package`, §4) at
      [addons.mozilla.org/developers](https://addons.mozilla.org/developers/).

## 6. Post-Release
- [ ] **Git Tag:** `git tag v<version> && git push origin v<version>` — the tag must
      equal `v` + `package.json`'s `version`, or the workflow stops at its first step.
- [ ] **Release workflow:** the tag push runs `.github/workflows/release.yml`
      (audit 2026-10-01 PLT-7 / DIST-07). It builds **once** (`pnpm package`, job
      `build`) and uploads `dist/release/` as the `release` artifact; every later job
      uses that artifact rather than rebuilding:
      - `bundle-network` unpacks all three shipped zips and runs the zero-network
        bundle scan on them;
      - `e2e-extension` unpacks the shipped Chrome zip into `dist/ext` and runs the
        packaged-extension suite against it;
      - `e2e-web-shipped` unpacks the shipped web zip and, with no test hooks and
        no rebuild, runs the zero-network, offline (PWA), share-target and
        service-worker-network suites against it
        (`tests/e2e/pwa-shipped.config.ts`; locally:
        `STAPLER_SHIPPED_WEB=<unzipped dir> pnpm exec playwright test -c tests/e2e/pwa-shipped.config.ts`);
      - `e2e-web` and `perf` build their own *instrumented* copy of the same commit
        for every other web suite (they need `VITE_E2E_TEST_HOOKS`, which the shipped
        site must not contain) — they gate the release too;
      - `check` runs lint, types, tokens, invariants and the unit tests;
      - `release` needs all of the above, re-verifies `SHA256SUMS` and every
        `<zip>.sha256`, and creates a **draft** GitHub Release with the three zips,
        their `.sha256` files and `SHA256SUMS`, with generated notes (`-` in the tag →
        pre-release).
- [ ] **Review and publish the draft:** on the repository's Releases page, check the
      draft has all seven assets, replace the generated notes with this version's
      `CHANGELOG.md` section, then publish. The zips you upload to the stores (§5,
      §5b) should be the draft's own assets — `sha256sum --check <zip>.sha256` on the
      downloaded file proves it — not a local rebuild.
- [ ] **Website deploy:** unpack `stapler-<version>-web.zip` onto the static host. The
      site's entry scripts are content-hashed and its service worker serves each page
      from its own versioned cache, so open tabs keep running their version until the
      user accepts the "new version" reload.
      **The host must serve every file byte for byte.** The service worker checks each
      downloaded file against the SHA-256 recorded at build time and refuses to install
      a cache that does not match. Turn off anything that rewrites responses: HTML
      minification, injected analytics or banners, Cloudflare email obfuscation and
      Rocket Loader, and similar features. Otherwise the site still works online, but it
      never installs for offline use. To check, open the deployed site, then in DevTools
      → Application → Service workers confirm that `sw.js` is *activated* and that Cache
      Storage holds a `stapler-precache-<version>` cache.
- [ ] **Share to the installed web app (Android, manual — no CI can do this):**
      install the deployed site, share a PDF to it from another app. Expected: the app
      opens and asks "Open 1 shared file?" naming the file (the service worker cannot
      tell an OS share from a website posting one, audit 2026-10-01 PLT-3); **Open**
      imports it, **Discard** opens nothing and a reload does not bring it back.
- [ ] **Celebrate:** Grab a coffee! ☕
