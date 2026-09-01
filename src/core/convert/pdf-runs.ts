/**
 * CNV-08 — pdf.js text runs, annotated with the weight and slant their font
 * declares.
 *
 * `getTextContent()` alone cannot answer "is this run bold". Its `styles` map
 * carries only pdf.js's CSS *fallback* family ("serif"/"sans-serif"/"monospace"),
 * which is the same string for Helvetica and Helvetica-Bold. The font's real
 * identity reaches the main thread as a `FontFaceObject` on the document's
 * `commonObjs`, keyed by the very `fontName` each text item already carries — but
 * pdf.js only sends it while building an **operator list**, not while extracting
 * text (its `getTextContent` path never calls `TranslatedFont.send`). So one
 * `getOperatorList()` per page is what makes the font table available; the
 * operator list itself is discarded.
 *
 * Two sources are combined, and neither alone is enough:
 *
 *  • `font.bold` / `font.italic` — pdf.js sets these only on the
 *    `fallbackToSystemFont` path, i.e. for fonts with **no** embedded file. They
 *    are `undefined` for every embedded font, so trusting them alone would report
 *    an embedded Arial-BoldMT as regular.
 *  • the `/BaseFont` name — always present, and by long convention carries the
 *    style ("AAAAAA+Arial-BoldMT", "TimesNewRoman,BoldItalic", "Helvetica-Oblique").
 *
 * When neither says anything the run is reported unstyled. That is the honest
 * answer: this ticket promises bold/italic *from font descriptors*, and inferring
 * weight from glyph geometry instead would mislabel text in a file we cannot
 * check, which is worse than losing the emphasis.
 */

import type { FormattedRun } from './blocks';
import type { TextRun } from '../text-layout';

/** Style words that appear in a `/BaseFont` name. Matched case-insensitively. */
const BOLD_NAME = /bold|black|heavy|semib|demib/i;
const ITALIC_NAME = /italic|oblique/i;

/**
 * What we need from a pdf.js font object. Duck-typed rather than imported so this
 * module stays free of a runtime pdf.js import and can be unit-tested with a
 * literal.
 */
export interface FontStyleSource {
  name?: string;
  bold?: boolean;
  italic?: boolean;
}

/** The subset of `PDFPageProxy` this module touches. */
export interface TextPageSource {
  getTextContent(): Promise<{ items: unknown[] }>;
  /** Discarded — called only so the page's fonts reach `commonObjs`. */
  getOperatorList(): Promise<unknown>;
  commonObjs: { has(id: string): boolean; get(id: string): unknown };
}

/** True for a pdf.js text item, as opposed to a marked-content marker. */
function isTextRun(value: unknown): value is TextRun & { fontName?: string } {
  if (typeof value !== 'object' || value === null) return false;
  const run = value as { str?: unknown; transform?: unknown; width?: unknown };
  return (
    typeof run.str === 'string' && Array.isArray(run.transform) && typeof run.width === 'number'
  );
}

/** Resolves one font's declared weight and slant. */
export function fontStyle(font: FontStyleSource | null | undefined): {
  bold: boolean;
  italic: boolean;
} {
  if (!font) return { bold: false, italic: false };
  const name = typeof font.name === 'string' ? font.name : '';
  return {
    bold: font.bold === true || BOLD_NAME.test(name),
    italic: font.italic === true || ITALIC_NAME.test(name)
  };
}

/**
 * Every text run on the page, with `bold`/`italic` resolved per run.
 *
 * A failure to resolve the font table is not a failure of the conversion: the
 * text is still extracted, just without emphasis. Throwing here would turn a
 * cosmetic gap into a refused document.
 */
export async function formattedRuns(page: TextPageSource): Promise<FormattedRun[]> {
  let fonts: TextPageSource['commonObjs'] | null = null;
  try {
    await page.getOperatorList();
    fonts = page.commonObjs;
  } catch {
    fonts = null;
  }

  const styles = new Map<string, { bold: boolean; italic: boolean }>();
  const styleFor = (fontName: string | undefined) => {
    if (!fontName || !fonts) return { bold: false, italic: false };
    const cached = styles.get(fontName);
    if (cached) return cached;
    let resolved = { bold: false, italic: false };
    try {
      if (fonts.has(fontName)) resolved = fontStyle(fonts.get(fontName) as FontStyleSource);
    } catch {
      // `commonObjs.get` throws for an id that is present but unresolved. An
      // unstyled run is the right fallback.
    }
    styles.set(fontName, resolved);
    return resolved;
  };

  const content = await page.getTextContent();
  const out: FormattedRun[] = [];
  for (const item of content.items) {
    if (!isTextRun(item)) continue;
    const { bold, italic } = styleFor(item.fontName);
    out.push({
      str: item.str,
      transform: item.transform,
      width: item.width,
      height: item.height,
      hasEOL: item.hasEOL,
      bold,
      italic
    });
  }
  return out;
}
