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
- [ ] **QA-05 — external viewer compatibility (manual, cannot be automated):**
      open a representative output from each P0 tool in Chrome's own PDF viewer,
      Adobe Acrobat Reader, macOS Preview, and Firefox's pdf.js. Confirm no
      warnings on open and that the content matches what Stapler showed.
      Record the result (pass/fail per viewer, per tool) in this file's git
      history or an issue — "it should work" is not a passing criterion.
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
