#!/usr/bin/env node
/**
 * DIST-01 — Chrome Web Store promo tiles: the 440x280 small tile and the
 * 1280x800 large promo tile. Optional CWS assets, but the ticket's AC lists
 * both, so this closes that gap the same way `generate-screenshots.mjs`
 * closed the required screenshots: render real markup with Playwright rather
 * than hand-rolling text into a raw pixel buffer (that approach is only
 * dependency-free-worthy for `generate-icons.mjs`'s simple glyph).
 *
 * No preview server needed — this renders a self-contained HTML string via
 * `page.setContent`, not the live app.
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'docs', 'promo');
mkdirSync(outDir, { recursive: true });

// Matches --primary / --canvas / --ink in src/ui/styles/tokens.css, duplicated
// here deliberately — same precedent as generate-icons.mjs, which runs outside
// the app's own token pipeline.
const PRIMARY = '#5e6ad2';
const CANVAS_DARK = '#14151a';
const INK = '#f7f8f8';
const INK_MUTED = '#b4b7c5';

function pageHtml({ width, height, compact }) {
  const foldSize = compact ? 44 : 96;
  const titleSize = compact ? 28 : 56;
  const taglineSize = compact ? 14 : 24;
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${width}px; height: ${height}px; overflow: hidden; }
  body {
    display: flex; align-items: center; justify-content: center; gap: ${compact ? 20 : 40}px;
    background: linear-gradient(135deg, ${CANVAS_DARK}, #1c1e27);
    font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
  }
  .glyph {
    width: ${foldSize}px; height: ${foldSize}px; flex: none;
    background: ${PRIMARY}; border-radius: ${foldSize * 0.22}px;
    position: relative;
  }
  .glyph::after {
    content: ""; position: absolute; right: 0; top: 0;
    width: 0; height: 0; border-style: solid;
    border-width: 0 ${foldSize * 0.32}px ${foldSize * 0.32}px 0;
    border-color: transparent ${CANVAS_DARK} transparent transparent;
    border-top-right-radius: ${foldSize * 0.06}px;
  }
  .text { display: flex; flex-direction: column; gap: ${compact ? 4 : 10}px; }
  .title { color: ${INK}; font-size: ${titleSize}px; font-weight: 700; letter-spacing: -0.01em; }
  .tagline { color: ${INK_MUTED}; font-size: ${taglineSize}px; font-weight: 400; max-width: ${width * 0.55}px; }
</style></head>
<body>
  <div class="glyph"></div>
  <div class="text">
    <div class="title">Stapler</div>
    <div class="tagline">Offline PDF tools — merge, compress, sign, redact. No uploads, ever.</div>
  </div>
</body></html>`;
}

async function main() {
  const browser = await chromium.launch();
  const tiles = [
    { name: 'small-tile-440x280.png', width: 440, height: 280, compact: true },
    { name: 'promo-tile-1280x800.png', width: 1280, height: 800, compact: false }
  ];
  for (const tile of tiles) {
    const page = await browser.newPage({ viewport: { width: tile.width, height: tile.height } });
    await page.setContent(pageHtml(tile));
    await page.screenshot({ path: path.join(outDir, tile.name) });
    await page.close();
  }
  await browser.close();
  console.log(`Wrote ${tiles.length} promo tiles to ${outDir}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
