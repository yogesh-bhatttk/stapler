/**
 * OCR — the non-Latin fallback font for the invisible text layer.
 *
 * `textLayer.ts` writes recognised words with `StandardFonts.Helvetica`, which
 * only covers WinAnsi. A Devanagari word has no glyph in it at all, and — this is
 * the part that made the gap dangerous rather than merely incomplete —
 * `@cantoo/pdf-lib`'s standard-font encoder does not throw on a missing glyph the
 * way upstream pdf-lib does; it silently substitutes `?` and reports success. Any
 * code that trusted `font.encodeText(text)` to throw as its "can this font show
 * this word" check (which is what this file's `canEncode` predicates replace)
 * would embed a document full of literal question marks and call it recognised
 * text. See `textLayer.ts`'s `pickFont`/`FontChoice` for the real check.
 *
 * The font itself is a bundled asset, fetched from the extension's own origin,
 * never from a remote host — the same shape as the tesseract engine files
 * `ocr.worker.ts` loads via `WORKER_PATH`/`CORE_PATH`. It lives under
 * `src/core/ocr/` so the `fetch()` call is covered by that directory's carve-out
 * in `.claude/hooks/check-invariants.mjs` (PLAN §5.4 item 5's neighbourhood,
 * though this fetch never leaves the bundle). Font: Noto Sans Devanagari,
 * OFL-licensed — see `assets/NotoSansDevanagari-OFL.txt`.
 *
 * Subset to Basic Latin + the Devanagari block (U+0000–007E, U+0900–097F): wide
 * enough that a mixed Hindi/English word encodes in one font without a per-glyph
 * font switch, narrow enough to stay under 200 KB. Regenerating it is a build-time
 * step (`fonttools varLib.instancer` + `fonttools subset`), not something this
 * module does at runtime.
 */
import { PDFDocument, PDFFont } from 'pdf-lib';

const FONT_URL = new URL('./assets/NotoSansDevanagari.ttf', import.meta.url).href;

export interface DevanagariFont {
  font: PDFFont;
  /** True if every character of `text` has an actual glyph in this font. */
  canEncode: (text: string) => boolean;
}

/**
 * The one fontkit capability this module actually calls. `fontkit` ships no
 * types of its own, and `pdf-lib`'s own structural `Fontkit`/`Font` types
 * (`core/types/fontkit.ts`) are not part of its public exports — so this is a
 * local, minimal, structurally-checked stand-in rather than an `any`, covering
 * exactly the two calls made below (`create`, `hasGlyphForCodePoint`).
 */
interface FontkitLike {
  create(bytes: Uint8Array): { hasGlyphForCodePoint(codePoint: number): boolean };
}

/**
 * Embeds the Devanagari font into `doc`. `subset: true` keeps the *exported*
 * PDF small — pdf-lib writes only the glyphs actually used, which for an
 * invisible text layer is a handful of words, not the whole font.
 *
 * Returns `null` if the asset is missing or fontkit fails to parse it, so a
 * broken font file degrades to "non-Latin words are skipped" (the pre-existing
 * behaviour for a font Helvetica can't show) instead of failing the whole OCR
 * run.
 */
export async function embedDevanagariFont(doc: PDFDocument): Promise<DevanagariFont | null> {
  try {
    // CJS interop: bundled, this resolves to the module's default export
    // directly; under a plain dynamic `import()` of a CJS package, `.default`
    // carries it and the bare namespace does not — falling back to the
    // namespace itself covers both.
    const imported = (await import('fontkit')) as unknown as {
      default?: FontkitLike;
    } & FontkitLike;
    const fontkit = imported.default ?? imported;

    // `registerFontkit` is only needed once per document; `addOcrTextLayerToDocument`
    // calls this at most once per document, so there is no second call to guard.
    doc.registerFontkit(fontkit as unknown as Parameters<PDFDocument['registerFontkit']>[0]);

    const response = await fetch(FONT_URL);
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());

    // Parsed a second time, independent of pdf-lib's own embedding: this is the
    // coverage check callers use to decide whether this font is the right
    // candidate for a word *before* asking pdf-lib to encode it, since pdf-lib's
    // own `encodeText` never reports a miss (see the module comment above).
    const parsed = fontkit.create(bytes);
    const font = await doc.embedFont(bytes, { subset: true });

    return {
      font,
      canEncode: text =>
        Array.from(text).every(char => {
          const codePoint = char.codePointAt(0);
          return codePoint !== undefined && parsed.hasGlyphForCodePoint(codePoint);
        })
    };
  } catch {
    return null;
  }
}
