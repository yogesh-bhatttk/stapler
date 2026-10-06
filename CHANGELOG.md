# Changelog

All notable changes to Stapler are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

Pre-1.0. See `docs/TICKETS.md` for the ticket-by-ticket state of every feature —
this file starts tracking user-facing changes from the first tagged release
onward, not the full development history before it.

## [0.3.0] — 2026-10-06

### Added

- **Fast web view** (opt-in, in the export review): saves PDFs with page 1
  first and no object streams, so a browser can show it before the rest has
  loaded. Off by default, which keeps the smaller default layout.
- **Compress: Colour option** — keep colour, shades of grey, or black and
  white for scans. Never saves a file larger than the original; pages that
  cannot be converted are named.
- **Exact pixel size** (width × height, proportions locked by default) in
  Image to size and PDF to images; a missed size target now says by how much.
- **Folder search can read scanned pages with OCR** (opt-in), only after you
  approve the one-time language-model download; results are cached and marked
  as recognized text.
- The installable web app asks before opening files shared to it that it cannot
  verify came from your device.

### Fixed

- **Redaction** now also removes content hidden inside repeating (tiling)
  patterns, under thick or widened strokes and outlined text, and under
  stencil masks — and its verification fails if any of it survives. Redacted
  files no longer roughly double in size.
- Size-reducing tools (Image to size, Grayscale, Compress with Protect) never
  silently save a file larger than the input, and their "Reached" messages are
  measured on the file actually written. Sizes use decimal KB/MB throughout.
- Undo after saving, "Clear all local data" (now reports anything it could not
  delete), session restore at the document limit, and Repair (keeps your edits)
  behave correctly.
- The web app no longer mixes old and new code after an update, and other open
  tabs reload safely; workers on the website refuse network requests.
- Face and logo blur reach images in comments and fill patterns; form fields
  line up on cropped and rotated pages; read-aloud follows page edits; Compare
  exports use real page sizes and can be cancelled cleanly.
- Smoother page-grid scrolling and large merges; heavy signature and summary
  work moved off the main thread; tooltips are accessible to screen readers.

### Changed

- Every finding of the internal audits is now a tracked requirement in EPIC-19
  of `docs/TICKETS.md`; the separate audit documents were removed.

## [0.2.1] — 2026-09-16

### Fixed

- Switching tools or documents while a job was running could clobber the
  active-job progress bar, defeat the unsaved-changes guard, leak Compare's
  second file source, or let a slow Sign panel form-field fetch overwrite
  state for a document you'd already switched away from.
- A batch of concurrency and edge-case issues found across an internal audit:
  concurrent confirmation dialogs could hang forever, OPFS unavailability
  crashed the app instead of falling back to memory, undo/redo history could
  be corrupted by overlapping operations, and several tools (compression,
  redaction, scan cleanup, OCR, batch processing) mishandled degenerate or
  adversarial inputs. The findings (AUDIT-FINDINGS, AUDIT-EDGE-CASES-2026-09-15)
  are recorded as requirements in EPIC-19 of `docs/TICKETS.md`.
- Document and page-selection state updates are now batched, session
  auto-save no longer re-enters itself under rapid changes, and worker job
  proxies and render canvases now release their memory immediately instead
  of waiting on garbage collection.

### Changed

- Completed translations for all 10 supported locales — the 173 strings
  added by the Word/Excel/PowerPoint converters and the export-review flow
  were previously English-only outside the app's default locale.

## [0.2.0] — 2026-09-05

### Added

- **PDF → PowerPoint (`.pptx`), labelled beta (CNV-12).** Places each page's text and
  embedded images onto its own slide, positioned where the page drew them. This is
  the widest fidelity gap of Stapler's six converters and the panel says so plainly:
  the result is a picture of the page assembled out of movable text boxes, not an
  editable presentation — nothing reflows, nothing is grouped, and there is no
  outline. Every known limitation (fonts substituted, angled text, clipped images,
  JBIG2/JPEG 2000 images left out, and more) is listed in the panel before you
  convert, and a full preview is mandatory before the save button unlocks.
- **PowerPoint (`.pptx`) → PDF, labelled beta (CNV-13).** Draws one PDF page per
  slide, with each shape's text, picture and table placed where the deck positions
  it — a structural conversion, not a picture of what PowerPoint renders. Slide
  transitions, animations and speaker notes are not reproduced, fonts are
  substituted, and a slide that comes out blank (because its content lives only in
  an unread layout) is named as such in the preview rather than silently empty.
- **PDF → Excel (`.xlsx`), labelled beta (CNV-10).** Detects table-like blocks of
  text and writes each one to its own sheet, with cell values only — no formulas,
  no formatting. A PDF has no tables, only text that lines up like one, so the
  mandatory preview is this tool's real safety mechanism: every detected sheet and
  its row/column counts are shown before you save, and known false positives
  (two-column prose read as a table, a banner heading landing on the text sheet)
  are called out by name.
- **Excel (`.xlsx`) → PDF, labelled beta (CNV-11).** Draws every visible sheet as a
  paginated grid of cells, one section per sheet — cell values are preserved
  exactly as Excel last displayed them, but Excel's own print setup, cell styling,
  merged-cell layout, and charts/images/pivot tables are not reproduced. Every
  limitation is listed in the panel before you convert.
- **Website: landing pages for all six conversion tools.** `/pdf-to-word`,
  `/word-to-pdf`, `/pdf-to-excel`, `/excel-to-pdf`, `/pdf-to-ppt` and `/ppt-to-pdf`
  join the site's existing per-tool landing pages, each stating the tool's beta
  status and fidelity limit and preloading the real tool, usable without the
  extension installed.
- **Word (`.docx`) → PDF, labelled beta (CNV-09).** Pick a Word document and get
  a PDF carrying its headings, paragraphs, bulleted and numbered lists, tables
  and images — with bold, italic and hyperlinks preserved, including inside table
  cells. It is a structural conversion, not a copy of the page: Word's own
  pagination, fonts, columns, headers and footers are not reproduced, the tool's
  own copy says so, page size is your choice (A4 or US Letter) rather than a
  guess, and a preview of the actual output is mandatory before the save button
  unlocks. Choosing a different file or changing the page size throws the preview
  away and re-locks the button, so the bytes that were reviewed are always the
  bytes that land. A corrupt `.docx`, a legacy `.doc` and a password-protected
  document are each refused with their own explanation and your file left
  untouched, rather than half-converted; an image a PDF cannot embed (Word's
  EMF/WMF vector art) is listed in the preview with the reason instead of
  disappearing, as is an image inside a table cell and a list nested deeper than
  eight levels (its text is all kept, flattened to eight). Text is drawn with the
  built-in Latin fonts, so characters outside them (CJK, Cyrillic, Arabic) are
  substituted and you are told. Everything the converter does not carry across is
  now listed in the panel itself, before you convert. Still fully offline — no
  permission and no network request was added.
- **PDF → Word (`.docx`), labelled beta (CNV-08).** Produces an editable Word
  document with the source's paragraphs, headings, tables and embedded images,
  and preserves bold/italic in paragraphs and headings — inside a table the cell
  text is preserved but its character formatting is not, which the tool's own
  copy states. It is a structural conversion, not a copy of the page: layout,
  fonts, columns and pagination may differ, the tool's own copy says so, and a
  preview of the actual output is mandatory before the save button unlocks. The
  preview is thrown away and the save button re-locks if the document is edited
  afterwards, so the bytes that were reviewed are always the bytes that land.
  Encrypted and XFA documents are refused with an explanation rather than
  half-converted, and any image Word cannot embed (JPEG 2000, JBIG2, CCITT) is
  listed in the preview with the reason instead of disappearing. Still fully
  offline — no permission and no network request was added.

## [0.1.0] — 2026-08-31

First release candidate. Core toolkit: merge, organize (rotate/delete/duplicate/
reorder), split & extract, insert pages, remove blanks, crop, N-up & booklet,
watermark & page numbers, normalize page size, images ↔ PDF, HEIC import,
PDF → text/Markdown, Markdown → PDF, sign & fill (draw/type/import signatures,
AcroForm fill/flatten), compress (raster + surgical re-encode), scan cleanup
(edge detection, deskew, threshold, despeckle), redaction (true content removal
with a verification gate), metadata inspection and scrubbing, annotations
(highlight/freehand/rectangle/text/sticky note/whiteout), compare, batch
processing, saved recipes, 10-locale i18n with RTL, light/dark themes, and full
keyboard operation. Zero runtime network requests, zero manifest permissions.
