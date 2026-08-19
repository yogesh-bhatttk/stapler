/**
 * OCR-01 — the invisible text layer.
 *
 * This is the half of OCR that can corrupt a document, so it is deliberately the
 * most conservative thing that satisfies "recognized text is selectable in the
 * exported PDF":
 *
 *  • It never touches an existing content stream. `pushOperators` appends a *new*
 *    stream to the page's `/Contents` array, so every drawing operator the page
 *    already had — text, vectors, image XObjects — is carried through byte for
 *    byte. The unit test asserts that, not the intent.
 *  • Everything it appends is wrapped in `q … Q` and drawn in text rendering mode
 *    3 (invisible), so the page looks *identical* and the graphics state it
 *    inherits is restored.
 *  • A word the font cannot encode is skipped and counted, never approximated.
 *
 * Lives in `core/ocr/` rather than inside the pdf-lib worker so it can be unit
 * tested in Node — the worker calls `Comlink.expose` at import time and cannot be
 * loaded outside a worker.
 */
import {
  PDFDocument,
  PDFFont,
  PDFHexString,
  PDFName,
  PDFOperator,
  PDFPage,
  beginText,
  endText,
  popGraphicsState,
  pushGraphicsState,
  setCharacterSqueeze,
  setFontAndSize,
  setTextMatrix,
  setTextRenderingMode,
  showText,
  StandardFonts,
  TextRenderingMode
} from 'pdf-lib';
import { Encodings } from '@pdf-lib/standard-fonts';
import { embedDevanagariFont } from './devanagariFont';
import type { OcrLayerReport, OcrPageLayer } from './types';

/** The page box pdf.js rasterised, in PDF points. Mirrors pdf.js's `page.view`. */
export interface PageBox {
  x0: number;
  y0: number;
  width: number;
  height: number;
}

export interface UserPoint {
  x: number;
  y: number;
}

/**
 * Inverse of pdf.js's `PageViewport` transform, for the four legal rotations.
 *
 * pdf.js rasterises through `getViewport({ scale })`, which bakes the page's
 * `/Rotate` into the bitmap: at 90° the bitmap is landscape and its +x axis runs
 * *down* the unrotated page. Mapping a word's box back with the identity mapping
 * — which is the obvious implementation, and the wrong one — puts every word of
 * every rotated scan in the wrong place, transposed and mirrored.
 *
 * Each case below is the algebraic inverse of pdf.js's own matrix
 * (`rotateA..rotateD` in `PageViewport`), derived for a general view box so a
 * document whose CropBox is offset from the origin maps correctly too.
 */
export function bitmapToUserSpace(
  px: number,
  py: number,
  scale: number,
  rotation: number,
  box: PageBox
): UserPoint {
  const { x0, y0, width: w, height: h } = box;
  const vx = px / scale;
  const vy = py / scale;

  switch (((rotation % 360) + 360) % 360) {
    case 90:
      return { x: x0 + vy, y: y0 + vx };
    case 180:
      return { x: x0 + w - vx, y: y0 + vy };
    case 270:
      return { x: x0 + w - vy, y: y0 + h - vx };
    default:
      return { x: x0 + vx, y: y0 + h - vy };
  }
}

/**
 * Angle, in degrees, that bitmap-horizontal reading direction points in unrotated
 * user space. A word recognised left-to-right on a 90°-rotated page runs *up* the
 * page in the file's own coordinates, and its text matrix has to say so or the
 * text is selectable at the right spot but in the wrong direction.
 */
function readingAngle(rotation: number): number {
  return ((rotation % 360) + 360) % 360;
}

/**
 * True if every character of `text` has a real glyph in `font` — checked
 * against WinAnsi's own codepoint table, *not* by calling `font.encodeText`
 * and seeing whether it throws.
 *
 * That distinction is load-bearing: `@cantoo/pdf-lib`'s standard-font encoder
 * does not throw on a codepoint outside WinAnsi. It silently substitutes `?`
 * and returns as if nothing were wrong (upstream pdf-lib throws here; this is
 * a fork behaviour difference). A try/catch around `encodeText` therefore
 * never sees a miss, and every non-Latin word — Devanagari, CJK, anything
 * outside Latin-1 — would get written into the invisible text layer as a run
 * of literal question marks, silently, while being counted as *added* rather
 * than skipped. `canEncodeUnicodeCodePoint` is the one part of this encoder
 * that reports the truth instead of a placeholder.
 */
function winAnsiEncodable(text: string): boolean {
  return Array.from(text).every(char => {
    const codePoint = char.codePointAt(0);
    return codePoint !== undefined && Encodings.WinAnsi.canEncodeUnicodeCodePoint(codePoint);
  });
}

export interface FontChoice {
  font: PDFFont;
  key: PDFName;
  canEncode: (text: string) => boolean;
}

/**
 * First candidate that can actually show `text`, checked in order. The
 * primary (Helvetica) is tried first because it needs no glyph subsetting and
 * covers the common case; a fallback such as the Devanagari font only gets
 * consulted for a word Helvetica actually lacks a glyph for.
 */
function pickFont(candidates: FontChoice[], text: string): FontChoice | undefined {
  return candidates.find(candidate => candidate.canEncode(text));
}

/**
 * Encodes `text` one character at a time and concatenates the results, rather
 * than handing the whole word to `font.encodeText` in one call.
 *
 * For a script with combining marks — a Devanagari vowel sign is stored
 * *after* the consonant it modifies in Unicode but drawn *before* it — a font's
 * shaping engine (fontkit's `layout`, which `CustomFontEmbedder.encodeText`
 * calls) reorders the glyph run to get that visual position right. This text
 * is never painted, only indexed, so that reordering actively works against
 * the goal: a viewer that extracts these glyphs back to text would recover
 * them in shaped order, not the order Tesseract actually recognised — the
 * fixture in `ocr.test.ts` demonstrates this turning "सचिवालय" into "सिचवालय".
 * Encoding one grapheme at a time gives each `layout` call nothing to reorder
 * against, so the emitted glyphs stay in logical (recognition) order. Standard
 * WinAnsi fonts have no shaping step either way, so this is a no-op for them.
 */
function encodeInLogicalOrder(font: PDFFont, text: string): PDFHexString {
  return PDFHexString.of(
    Array.from(text)
      .map(char => font.encodeText(char).asString())
      .join('')
  );
}

/**
 * Appends one page's words as an invisible text run.
 *
 * Returns the number of words written and skipped rather than throwing on a bad
 * word: OCR output is noisy by nature, and losing the whole page's text layer
 * because one glyph came back as U+FFFD would be the wrong trade.
 */
export function drawInvisibleWords(
  page: PDFPage,
  candidates: FontChoice[],
  layer: OcrPageLayer
): { added: number; skipped: number } {
  const scale = layer.dpi / 72;
  const rotation = page.getRotation().angle;
  const crop = page.getCropBox();
  const box: PageBox = {
    x0: crop.x,
    y0: crop.y,
    width: crop.width,
    height: crop.height
  };

  const angle = readingAngle(rotation);
  const radians = (angle * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);

  let added = 0;
  let skipped = 0;
  const operators: PDFOperator[] = [];

  for (const word of layer.words) {
    const text = word.text.trim();
    if (!text) continue;
    const choice = pickFont(candidates, text);
    if (!choice) {
      skipped++;
      continue;
    }

    const { x0, y0, x1, y1 } = word.bbox;
    const widthPx = x1 - x0;
    const heightPx = y1 - y0;
    if (widthPx <= 0 || heightPx <= 0) {
      skipped++;
      continue;
    }

    // Baseline, not the box bottom, when tesseract measured one: the box bottom
    // sits a descender low, which shifts every selection highlight downward.
    const baselinePx = word.baselineY ?? y1;
    const origin = bitmapToUserSpace(x0, baselinePx, scale, rotation, box);

    // The box height spans ascender to descender, which is very close to the em
    // for the Latin scripts this ships with, so it is used directly as the size.
    const size = heightPx / scale;
    const targetWidth = widthPx / scale;
    const naturalWidth = choice.font.widthOfTextAtSize(text, size);
    // Tz squeezes the run to the width tesseract actually measured, so a text
    // selection drawn by a viewer lands on the ink rather than beside it.
    const squeeze = naturalWidth > 0 ? (targetWidth / naturalWidth) * 100 : 100;

    operators.push(
      beginText(),
      setFontAndSize(choice.key, size),
      setCharacterSqueeze(Number(squeeze.toFixed(3))),
      setTextMatrix(cos, sin, -sin, cos, origin.x, origin.y),
      showText(encodeInLogicalOrder(choice.font, text)),
      endText()
    );
    added++;
  }

  if (operators.length === 0) return { added, skipped };

  page.pushOperators(
    pushGraphicsState(),
    // Mode 3 is the whole point: the glyphs are laid out, measured, and indexed
    // by every text extractor, and painted by none. An overlay of white text or a
    // hidden annotation would look the same and behave differently.
    setTextRenderingMode(TextRenderingMode.Invisible),
    ...operators,
    setCharacterSqueeze(100),
    popGraphicsState()
  );

  return { added, skipped };
}

/**
 * Adds an invisible text layer to `doc` in place, one page at a time.
 *
 * Helvetica is embedded once for the whole document, unsubsetted, because the
 * glyphs are never painted — only their widths matter, and shipping a font
 * program for text nobody sees would grow the file for nothing. It only covers
 * WinAnsi, though, so a document with at least one word Helvetica cannot encode
 * gets a second, subsetted Devanagari font embedded alongside it — checked for
 * up front, once, rather than per page, so an English-only scan never pays for
 * the extra embed.
 */
export async function addOcrTextLayerToDocument(
  doc: PDFDocument,
  layers: OcrPageLayer[]
): Promise<OcrLayerReport> {
  const withWords = layers.filter(layer => layer.words.length > 0);
  if (withWords.length === 0) return { wordsAdded: 0, wordsSkipped: 0, pagesTouched: 0 };

  const helvetica = await doc.embedStandardFont(StandardFonts.Helvetica);
  const needsFallback = withWords.some(layer =>
    layer.words.some(word => {
      const text = word.text.trim();
      return text.length > 0 && !winAnsiEncodable(text);
    })
  );
  const fallback = needsFallback ? await embedDevanagariFont(doc) : null;

  const pages = doc.getPages();

  let wordsAdded = 0;
  let wordsSkipped = 0;
  let pagesTouched = 0;

  for (const layer of withWords) {
    const page = pages[layer.pageIndex];
    if (!page) continue;
    const candidates: FontChoice[] = [
      {
        font: helvetica,
        key: page.node.newFontDictionary(helvetica.name, helvetica.ref),
        canEncode: winAnsiEncodable
      }
    ];
    if (fallback) {
      candidates.push({
        font: fallback.font,
        key: page.node.newFontDictionary(fallback.font.name, fallback.font.ref),
        canEncode: fallback.canEncode
      });
    }
    const { added, skipped } = drawInvisibleWords(page, candidates, layer);
    wordsAdded += added;
    wordsSkipped += skipped;
    if (added > 0) pagesTouched++;
  }

  return { wordsAdded, wordsSkipped, pagesTouched };
}
