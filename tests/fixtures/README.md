# Test Fixture Corpus

This directory contains the fixture corpus required for the test suites (`QA-01`).
To keep the repository size reasonable, large or easily constructed files are generated
dynamically at test-time by `tests/e2e/fixtures.ts`, while small static files that need a
specific encoding (which requires an external encoder like ImageMagick or Ghostscript, or
a hand-built byte structure no encoder produces) are committed here.

`npm test` and `npm run test:e2e` regenerate any missing static fixture automatically via
their `pretest`/`pretest:e2e` hooks (`npm run fixtures:static`). Regeneration only runs
`convert`/`gs` for `scanned_skewed.pdf`, `cmyk.pdf`, and `encrypted.pdf` if those files are
absent — on a normal checkout they are already committed, so no external tool is required.

## Static Fixtures (Committed)

These files must not regress, as they test specific parsing, routing, and decoding paths in
the application. `.gitignore` allow-lists exactly these files inside `tests/fixtures/`.

- `scanned_skewed.pdf` — a rendered text image with Gaussian noise and a 2° rotation,
  simulating a skewed phone-photo scan. Validates edge detection (`SCN-01`) and raster-path
  compression (`CMP-02`). Built with ImageMagick.
- `cmyk.pdf` — an image encoded in the CMYK colour space. Must be skipped or converted
  properly during surgical re-encode (`CMP-03`). Built with ImageMagick.
- `encrypted.pdf` — a real password-protected PDF (owner/user password). Validates that the
  app detects and explains encryption rather than failing obscurely (`DOC-02`). Built with
  Ghostscript.
- `jbig2.pdf` / `jpx.pdf` — a minimal hand-built PDF whose only image XObject declares
  `/Filter /JBIG2Decode` or `/JPXDecode` with a zero-length stream. This is **not** real
  decodable JBIG2/JPX image data — no offline encoder in this toolchain produces that, and
  the product only needs to *detect the filter name and skip*, never decode it, so a real
  payload would test nothing extra. Used by `CMP-01`/`CMP-03` skip-routing tests.
- `xfa.pdf` — a minimal hand-built PDF with an `AcroForm` dict carrying an `/XFA` key.
  Validates that XFA is detected and refused rather than partially filled (`SGN-03`).
- `cjk.pdf` — a minimal hand-built PDF using the predefined `UniJIS-UTF16-H` CMap (bundled
  by pdf.js) to show real CID-keyed CJK text ("中文"). Validates reading-order text
  extraction (`CNV-04`) through a real CID lookup rather than a synthetic fixture.
- `rtl.pdf` — a minimal hand-built PDF using `Identity-H` to show Arabic text ("مر") whose
  logical and visual byte order differ. Validates bidi handling in text extraction
  (`CNV-04`).
- `cmyk-text.pdf` — a CMYK image whose `/ColorSpace` is an **indirect** reference
  (`/ColorSpace 10 0 R`), the case that used to resolve to `unknown` and be re-encoded to
  RGB anyway (`CMP-03`). Built with ImageMagick.
- `tiny.jpg` — a 10×210 grayscale JPEG. The extreme aspect ratio is the point: it is what
  the images-to-PDF orientation and page-fit assertions measure against (`CNV-01`). Node
  has no JPEG encoder, so unlike the PNG fixtures it cannot be built inside a test.
- `face-chip.png` — a 240×240 photograph of a single human face, for `RED-08`'s
  face-detector tests. Cropped (`-crop 594x599+1278+42`, resized to 240×240) from
  `demo/sample1.jpg` inside the installed, MIT-licensed `@vladmandic/face-api` package —
  the same library whose detector the test runs — so the fixture comes from the
  dependency tree rather than from an unrelated third party. **Must not regress:** the
  face occupies `x 62, y 63, 113×112` in this image, measured by eye and hard-coded in
  `tests/unit/faceblur.test.ts` as the "known face position" RED-08's first acceptance
  criterion is stated against. Regenerating with a different crop moves the face and
  invalidates that constant, so the crop rectangle in `scripts/generate-static-fixtures.mjs`
  is fixed rather than approximate. A drawn shape would not do: the test's whole point is
  that a real detector finds a real face, and no detector finds a circle.
- `sample.png` / `sample.webp` / `sample.tiff` — one 240×160 gradient in three encodings,
  so `DOC-02`'s "accept PNG, JPEG, WebP, TIFF, HEIC" is exercised through the real import
  pipeline (`tests/e2e/import.spec.ts`) rather than asserted. Built with ImageMagick.

Regenerate any of these (after deleting the file) with `npm run fixtures:static`. The raw
hand-built ones (`jbig2`, `jpx`, `xfa`, `cjk`, `rtl`) always regenerate offline; the other
three need `convert` (ImageMagick) and `gs` (Ghostscript) on `PATH`.

## Dynamic Fixtures (Generated)

These files are generated on demand into this directory by `tests/e2e/fixtures.ts` and are
git-ignored — deterministic, so re-running tests reproduces them identically:

- `text-6.pdf`, `text-10.pdf`, `text-100.pdf`, `text-300.pdf` — text documents with a
  predictable page count and per-page marker text (`textPdf(n)`).
- `mixed-sizes.pdf` — A4, Letter, and Legal pages in one document, for merge and normalise
  assertions (`mixedSizePdf`).
- `heavy.pdf` — a large (~20MB) document with bloated, non-deduplicated text content, for
  memory-safety testing (`heavyPdf`).
- `not-a-pdf.pdf` — bytes that do not start with a PDF header, for import-error tests.
- `transparent-image.pdf` — a 1600×1200 RGBA image over text, in four vertical bands of
  known colour and known alpha (opaque, half, clear, opaque), drawn at 400×300pt so it is
  over-sampled for the 150 DPI default (`transparentImagePdf`). **Must not regress:** after
  `CMP-03` compression the `/SMask` stream is still referenced and byte-identical, the clear
  band renders as the white page rather than black, and no band shifts by more than 12/255.
- `mixed-text-image-flate.pdf` — the same builder with **no** JPEG argument, so the photo is
  stored as a Flate RGB raster. Its own filename on purpose: `ensureFixture` caches by name,
  and sharing `mixed-text-image.pdf` handed CMP-03's reduction-band test a different
  document. Used by CMP-05's projection test and by CNV-06's extraction test, which compares
  the extracted PNG's samples against this file's image stream.
- `mixed-text-image.pdf` — a page of text plus an already-JPEG photo (`mixedTextImagePdf`;
  the JPEG is encoded by the browser inside the test, since Node here has no encoder).
  **Must not regress:** compression reduces it by 30–70%, the content stream is byte-identical,
  and the text still extracts.
- `shared-image.pdf` — the same image on ten text pages (`sharedImagePdf`). **Must not
  regress:** the output holds exactly one image object, referenced from all ten pages.

- `acroform.pdf` — a fillable text field with a hierarchical name (`name.first`) and a
  checkbox (`acroformPdf`). The hierarchy is the point: pdf-lib joins the `/T` of every node
  to name a field, so a two-level name is what catches a `/AcroForm` rebuild that dedupes
  only at the tree root. **Must not regress:** after an export the field is still enumerable
  and its typed value is drawn into the page, on every page it appears on (`SGN-03`).

- `metadata-windows-path.pdf` — an author name (`Grace Hopper`) and a Windows user path in
  the three places a path actually hides: a custom `/SourceFile` Info key, inside the
  `/Producer` string, and inside the XMP packet — plus a document-level JavaScript action
  (`metadataLeakPdf`, strings exported as `METADATA_LEAK`). The Info strings are written as
  hex, not literals, because pdf-lib writes a literal string unescaped and its own parser
  then reads `C:\Users\…` back as `C:Users…`. **Must not regress (`RED-04`):** the inspector
  displays the author and every copy of the path before, and after a strip none of them
  survive anywhere in the decompressed output bytes.

- `photo-rotated.heic` — a real HEIC file (HEVC Main Still Picture) whose pixels are
  physically stored rotated 90° with an EXIF `Orientation=6` tag telling a correct reader
  to rotate it back to an upright 400×300 landscape image: red square top-left, blue
  square bottom-right. `sample.heic` already covers "HEIC decodes without crashing"; this
  one is the fixture the corpus was missing for orientation specifically — the same class
  of bug CNV-01's "a sideways photo must not stay sideways" JPEG handling exists for, never
  previously provable for HEIC since `heic2any` decodes through an intermediate PNG blob.
  Built with Python's `pillow-heif` + `piexif` (`pip install pillow-heif piexif`; not
  reproducible by `fixtures:static`'s ImageMagick/Ghostscript path since neither writes
  real HEIC).

`tests/e2e/fixtures.ts` also exports `largePdf` (300 pages), `rotatedPdf` (90/180/270°
pages), `acroformPdf` (fillable text field + checkbox), and `corruptPdf` (truncated PDF) —
each written under the fixture name passed to `ensureFixture` by the test that needs it,
not under the export's own name.
