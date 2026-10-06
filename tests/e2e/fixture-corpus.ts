import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  acroformPdf,
  annotatedPdf,
  barsPdf,
  bookmarkedPdf,
  cmykImagePdf,
  contractV1Pdf,
  contractV2Pdf,
  corruptPdf,
  excelToPdfXlsx,
  heavyPdf,
  imageOnLastPagePdf,
  letterPdf,
  metadataLeakPdf,
  mixedSizePdf,
  mixedTextImagePdf,
  notAPdf,
  oversizedMaskPdf,
  pdfToExcelPdf,
  pdfToPptPdf,
  pdfToWordPdf,
  pptToPdfPartiallyBlankPptx,
  pptToPdfPptx,
  sharedImageDifferentSizesPdf,
  sharedImagePdf,
  textPdf,
  transparentImagePdf,
  truncatedTextPdf,
  wordToPdfDocx
} from './fixtures';

/**
 * The generated half of the fixture corpus (QA-01): every git-ignored file in
 * `tests/fixtures/` that Node can build, each with exactly one generator.
 *
 * `scripts/generate-static-fixtures.mjs` — the `pretest`, `pretest:e2e*` and
 * `pretest:perf` hook — writes all of these before any runner starts, so a unit
 * test never depends on a Playwright spec having run first, and two specs can
 * never cache different bytes under one name depending on which ran first. A
 * spec's own `ensureFixture(name, …)` for one of these names must pass the same
 * generator as this table.
 *
 * Not here, on purpose: fixtures whose bytes need a browser encoder (the
 * `phone-photo-NN.jpg` set, and `mixed-text-image.pdf` / `-tabs.pdf`, which embed
 * a canvas-encoded JPEG), and the few single-spec fixtures a spec builds inline.
 * Those specs `ensureFixture` them themselves, and nothing else reads them.
 */
export const GENERATED_FIXTURES: Readonly<Record<string, () => Promise<Uint8Array>>> = {
  'text-2.pdf': () => textPdf(2),
  'text-3.pdf': () => textPdf(3),
  'text-4.pdf': () => textPdf(4),
  'text-6.pdf': () => textPdf(6),
  'text-8.pdf': () => textPdf(8),
  'text-10.pdf': () => textPdf(10),
  'text-100.pdf': () => textPdf(100),
  'text-300.pdf': () => textPdf(300),
  'letter-20.pdf': () => letterPdf(20),
  '100-page.pdf': () => barsPdf(100),
  'merge-source-1.pdf': () => barsPdf(50),
  'bookmarked-9.pdf': bookmarkedPdf,
  'contract-v1.pdf': contractV1Pdf,
  'contract-v2.pdf': contractV2Pdf,
  'acroform.pdf': acroformPdf,
  'annotated.pdf': annotatedPdf,
  'transparent-image.pdf': transparentImagePdf,
  'mixed-text-image-flate.pdf': () => mixedTextImagePdf(),
  'mixed-sizes.pdf': mixedSizePdf,
  'shared-image.pdf': () => sharedImagePdf(10),
  'shared-image-mixed-sizes.pdf': sharedImageDifferentSizesPdf,
  'image-on-last-page.pdf': imageOnLastPagePdf,
  'cmyk-image.pdf': cmykImagePdf,
  'oversized-mask.pdf': oversizedMaskPdf,
  'metadata-windows-path.pdf': metadataLeakPdf,
  'heavy.pdf': heavyPdf,
  'truncated.pdf': corruptPdf,
  'truncated-mid-body.pdf': () => truncatedTextPdf('mid-body'),
  'truncated-header-only.pdf': () => truncatedTextPdf('header-only'),
  'not-a-pdf.pdf': notAPdf,
  'pdf-to-word.pdf': pdfToWordPdf,
  'word-to-pdf.docx': wordToPdfDocx,
  'pdf-to-excel.pdf': pdfToExcelPdf,
  'excel-to-pdf.xlsx': excelToPdfXlsx,
  'pdf-to-ppt.pdf': pdfToPptPdf,
  'ppt-to-pdf.pptx': pptToPdfPptx,
  'ppt-to-pdf-partially-blank.pptx': pptToPdfPartiallyBlankPptx
};

/**
 * Writes every fixture in `GENERATED_FIXTURES` that is missing from `dir`.
 * Each is written to a temporary name and renamed, so an interrupted run never
 * leaves a half-written file that a later run would take as present.
 */
export async function generateFixtureCorpus(dir: string): Promise<string[]> {
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  for (const [name, build] of Object.entries(GENERATED_FIXTURES)) {
    const file = path.join(dir, name);
    if (existsSync(file)) continue;
    const temp = `${file}.partial`;
    writeFileSync(temp, await build());
    renameSync(temp, file);
    written.push(name);
  }
  return written;
}
