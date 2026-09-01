# Changelog

All notable changes to Stapler are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

Pre-1.0. See `docs/TICKETS.md` for the ticket-by-ticket state of every feature —
this file starts tracking user-facing changes from the first tagged release
onward, not the full development history before it.

### Added

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
