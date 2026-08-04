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
- `mixed-text-image.pdf` — a page of text plus an already-JPEG photo (`mixedTextImagePdf`;
  the JPEG is encoded by the browser inside the test, since Node here has no encoder).
  **Must not regress:** compression reduces it by 30–70%, the content stream is byte-identical,
  and the text still extracts.
- `shared-image.pdf` — the same image on ten text pages (`sharedImagePdf`). **Must not
  regress:** the output holds exactly one image object, referenced from all ten pages.

`tests/e2e/fixtures.ts` also exports `largePdf` (300 pages), `rotatedPdf` (90/180/270°
pages), `acroformPdf` (fillable text field + checkbox), and `corruptPdf` (truncated PDF) —
each written under the fixture name passed to `ensureFixture` by the test that needs it,
not under the export's own name.
