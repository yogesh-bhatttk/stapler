# Stapler

![Stapler Icon](public/icons/icon-128.png)

**Stapler** is an offline-first, client-side PDF toolkit designed for privacy, speed, and simplicity. Perform common PDF operations directly in your browser without ever uploading your sensitive documents to a third-party server.

## Features

- **Merge PDFs:** Combine multiple PDFs into a single document, reordering pages as needed.
- **Split PDFs:** Extract specific pages or divide a document into multiple parts.
- **Compress PDFs:** Reduce file size for easier sharing without significant quality loss.
- **Sign PDFs:** Add your signature to documents locally.
- **Redact PDFs:** Securely blackout sensitive information from your documents.
- **Offline First:** Once installed, Stapler runs entirely in your browser using WebAssembly. No internet connection is required.

## Privacy Guarantee

Your files never leave your device. All processing is done locally. We do not collect, store, or transmit your documents or any personal data.

For more details, please see our [Privacy Policy](public/privacy.html).

## Installation

### From the Chrome Web Store
*(Coming Soon)*

### Build from Source

1. **Clone the repository:**
   ```bash
   git clone https://github.com/yourusername/stapler.git
   cd stapler
   ```

2. **Install dependencies:**
   We recommend using `pnpm`.
   ```bash
   pnpm install
   ```

3. **Run the development server:**
   ```bash
   pnpm run dev
   ```

4. **Build for production (Browser Extension):**
   ```bash
   pnpm run build:ext
   ```
   This will generate a `dist` folder.

5. **Load as an unpacked extension:**
   - Open Chrome and navigate to `chrome://extensions/`.
   - Enable "Developer mode" in the top right corner.
   - Click "Load unpacked" and select the `dist` directory generated in the previous step.

## Development Commands

- `pnpm run build` - Build the extension and web targets
- `pnpm run check` - Run TypeScript compiler, ESLint, Prettier, and custom checks
- `pnpm run test` - Run Vitest unit tests
- `pnpm run test:e2e` - Run Playwright end-to-end tests
- `pnpm run verify` - Run all checks and tests (recommended before submitting a PR or release)

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the [MIT License](LICENSE).
