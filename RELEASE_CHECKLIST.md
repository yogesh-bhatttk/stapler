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
- [ ] **Zip the Extension:** Compress the *contents* of `dist/ext` into a `.zip` file (e.g., `stapler-v1.0.0.zip`) — zip the files inside `dist/ext`, not the `dist/ext` folder itself.

## 5. Chrome Web Store Publishing
- [ ] **Upload Package:** Go to the [Chrome Developer Dashboard](https://chrome.google.com/webstore/devconsole).
- [ ] **Create/Update Item:** Upload the newly created `.zip` file.
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
- [ ] **Zip and submit:** zip the contents of `dist/firefox` and submit at
      [addons.mozilla.org/developers](https://addons.mozilla.org/developers/).

## 6. Post-Release
- [ ] **Git Tag:** Create a git tag for the release (e.g., `git tag v1.0.0` and `git push --tags`).
- [ ] **GitHub Release:** Create a release on GitHub using the tag, copy the changelog notes, and attach the `.zip` file as a release asset.
- [ ] **Celebrate:** Grab a coffee! ☕
