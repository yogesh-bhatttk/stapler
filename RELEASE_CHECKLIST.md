# Release Checklist

Follow these steps when preparing a new release for Stapler.

## 1. Pre-Release Verification
- [ ] **Tests Pass:** Run `npm run verify` to ensure all checks (typecheck, linting, formatting, bundle size) and tests (Vitest and Playwright e2e) pass.
- [ ] **Feature Complete:** All features for this release have been implemented and manually tested in the browser.
- [ ] **Version Bump:** Update the version number in `package.json` according to semantic versioning.
- [ ] **Manifest Update:** Ensure the `version` field in `public/manifest.json` matches the new version.
- [ ] **Changelog:** Update `CHANGELOG.md` with the new version and detail the changes (features, bug fixes, etc.).

## 2. Build the Extension
- [ ] **Clean Build:** Remove any old `dist/` folders.
- [ ] **Build:** Run `npm run build:ext` to build the extension package.
- [ ] **Review Artifacts:** Check the `dist/` directory to ensure `manifest.json`, `background.js`, `index.html`, and required assets are present and correctly minified.

## 3. Local Testing of the Build
- [ ] **Load Unpacked:** Open Chrome, go to `chrome://extensions`, enable "Developer mode", and click "Load unpacked". Select the `dist/` folder.
- [ ] **Functionality Check:** 
  - Open the extension and test the primary workflows (Merge, Split, Compress).
  - Verify that offline functionality works (turn off Wi-Fi and attempt to process a PDF).
- [ ] **No Console Errors:** Open DevTools for the extension popup/page and ensure there are no errors in the console.

## 4. Packaging
- [ ] **Zip the Extension:** Compress the contents of the `dist/` folder into a `.zip` file (e.g., `stapler-v1.0.0.zip`).
- *(Note: Ensure you are zipping the contents inside `dist/`, not the `dist` folder itself).*

## 5. Chrome Web Store Publishing
- [ ] **Upload Package:** Go to the [Chrome Developer Dashboard](https://chrome.google.com/webstore/devconsole).
- [ ] **Create/Update Item:** Upload the newly created `.zip` file.
- [ ] **Update Listing:** Ensure all Store Listing details (description, screenshots, promotional images) are up-to-date (refer to `docs/STORE_LISTING.md`).
- [ ] **Privacy Policy:** Ensure the Privacy Policy URL is still correct and accessible (or points to the bundled/GitHub version if applicable).
- [ ] **Submit for Review:** Click "Submit for Review".

## 6. Post-Release
- [ ] **Git Tag:** Create a git tag for the release (e.g., `git tag v1.0.0` and `git push --tags`).
- [ ] **GitHub Release:** Create a release on GitHub using the tag, copy the changelog notes, and attach the `.zip` file as a release asset.
- [ ] **Celebrate:** Grab a coffee! ☕
