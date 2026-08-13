#!/usr/bin/env node
/**
 * DIST-01 — replaces the 1×1 placeholder PNGs under public/icons/ with a real,
 * recognizable icon at every size Chrome's manifest requires.
 *
 * No image library dependency: a hand-rolled PNG encoder (same approach as
 * tests/e2e/fixtures.ts's image fixtures) over a pixel buffer this script
 * draws by hand — a rounded square in the app's own --primary brand colour
 * (src/ui/styles/tokens.css) with a simple folded-corner page glyph in white.
 * Deterministic and dependency-free, so it can be re-run on any checkout.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// Matches --primary in src/ui/styles/tokens.css. Duplicated as raw numbers
// deliberately — this script runs under plain Node, outside the app's own
// token pipeline, exactly like core/doc-colors.ts's audited duplication.
const PRIMARY = [0x5e, 0x6a, 0xd2];
const WHITE = [0xff, 0xff, 0xff];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const body = new Uint8Array(type.length + data.length);
  for (let i = 0; i < type.length; i++) body[i] = type.charCodeAt(i);
  body.set(data, type.length);
  const out = new Uint8Array(body.length + 8);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(body, 4);
  view.setUint32(out.length - 4, crc32(body));
  return out;
}

function encodePng(pixels, width, height) {
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', new Uint8Array(deflateSync(raw, { level: 9 }))),
    pngChunk('IEND', new Uint8Array(0))
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const png = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    png.set(part, at);
    at += part.length;
  }
  return png;
}

/** Anti-aliased coverage of a rounded-rect at (x,y), 0..1, via 4x4 supersampling. */
function roundedRectCoverage(x, y, w, h, radius) {
  let hits = 0;
  const samples = 4;
  for (let sy = 0; sy < samples; sy++) {
    for (let sx = 0; sx < samples; sx++) {
      const px = x + (sx + 0.5) / samples;
      const py = y + (sy + 0.5) / samples;
      if (insideRoundedRect(px, py, w, h, radius)) hits++;
    }
  }
  return hits / (samples * samples);
}

function insideRoundedRect(px, py, w, h, r) {
  if (px < 0 || py < 0 || px >= w || py >= h) return false;
  const cx = px < r ? r : px > w - r ? w - r : px;
  const cy = py < r ? r : py > h - r ? h - r : py;
  if ((px < r || px > w - r) && (py < r || py > h - r)) {
    const dx = px - cx;
    const dy = py - cy;
    return dx * dx + dy * dy <= r * r;
  }
  return true;
}

/** True if (px,py) is inside the page glyph: a rect with the top-right corner folded. */
function insidePageGlyph(px, py, x0, y0, w, h, fold) {
  if (px < x0 || py < y0 || px >= x0 + w || py >= y0 + h) return false;
  const lx = px - x0;
  const ly = py - y0;
  // Cut the top-right triangle of size `fold`.
  if (lx > w - fold && ly < fold) {
    return lx - (w - fold) < fold - ly ? true : lx - (w - fold) + ly < fold;
  }
  return true;
}

function drawIcon(size) {
  const pixels = new Uint8Array(size * size * 4);
  const cornerRadius = size * 0.18;
  const pageMargin = size * 0.28;
  const pageX = pageMargin;
  const pageY = size * 0.18;
  const pageW = size - pageMargin * 1.7;
  const pageH = size - size * 0.36;
  const fold = pageW * 0.32;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const bgCoverage = roundedRectCoverage(x, y, size, size, cornerRadius);
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      if (bgCoverage > 0) {
        r = PRIMARY[0];
        g = PRIMARY[1];
        b = PRIMARY[2];
        a = bgCoverage;
      }
      // Page glyph, sampled at pixel centre — small sizes don't need AA on the
      // inner glyph the way the outer rounded corner does.
      if (insidePageGlyph(x + 0.5, y + 0.5, pageX, pageY, pageW, pageH, fold)) {
        r = WHITE[0];
        g = WHITE[1];
        b = WHITE[2];
        a = 1;
      }
      pixels[i] = r;
      pixels[i + 1] = g;
      pixels[i + 2] = b;
      pixels[i + 3] = Math.round(a * 255);
    }
  }
  return pixels;
}

const SIZES = [16, 32, 48, 128];
for (const size of SIZES) {
  const pixels = drawIcon(size);
  const png = encodePng(pixels, size, size);
  const outPath = path.join(root, 'public', 'icons', `icon-${size}.png`);
  writeFileSync(outPath, png);
  console.log(`wrote ${outPath} (${png.length} bytes)`);
}
