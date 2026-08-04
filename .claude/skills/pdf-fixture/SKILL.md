---
name: pdf-fixture
description: Create, inspect, or diagnose PDF test fixtures for the Stapler corpus in tests/fixtures. Use when asked to build the fixture corpus (QA-01), add a fixture for a specific edge case (CMYK, JBIG2, JPX, SMask/transparency, AcroForm, XFA, encrypted, 300-page, CJK, RTL, rotated, mixed page sizes, corrupt/truncated), inspect what is actually inside a PDF, or work out why an operation fails on a particular file.
---

# PDF fixtures and diagnosis

The corpus is the project's safety net — every hard bug in this codebase is an edge case
(see [docs/PLAN.md](../../../docs/PLAN.md) §6 for the required list).

## Inspecting a PDF

Before theorising about a failure, look at the actual file. Useful, in order:

1. **Structure** — `qpdf --qdf --object-streams=disable in.pdf out.pdf` then read the
   uncompressed objects. If `qpdf` isn't installed, say so rather than guessing.
2. **Images** — enumerate XObjects per page with pdf.js `getOperatorList()` and record for
   each: width/height, colour space, filter (`DCTDecode`, `FlateDecode`, `JPXDecode`,
   `JBIG2Decode`), displayed size, and whether an `SMask` is present. This inventory is what
   `CMP-01`'s classifier consumes.
3. **Text** — `getTextContent()` per page. A page with no extractable text is a scan, which
   is what routes compression to the raster path.
4. **Forms** — pdf-lib `getForm().getFields()`. If it throws or returns nothing while the
   file clearly has fields, suspect XFA.
5. **Encryption** — pdf-lib refuses encrypted documents. Detect and report; never attempt
   to work around it.

## Creating a fixture

Generate deterministically with a committed script under `tests/fixtures/generate/` so the
corpus is reproducible and the repo stays small. Each fixture needs an entry in
`tests/fixtures/README.md` stating **what it is for and what must not regress**.

A fixture without a stated expectation is not a fixture — it is a file.

## Diagnosis discipline

- Reproduce with the smallest possible input before changing any code.
- Distinguish "we produce wrong output" from "the input uses a construct we don't support".
  The second is a detect-and-explain path, not a bug to paper over.
- When a construct genuinely can't be handled (JBIG2/JPX decode, XFA, encryption), the
  correct behaviour is to skip that element untouched and tell the user — never corrupt it.
