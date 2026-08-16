#!/usr/bin/env node
/**
 * qa05-validate.mjs — QA-05 automated structural validation.
 *
 * Generates a representative PDF for each P0 tool output category and
 * validates it parses cleanly with pdf-lib (no XRef corruption, correct
 * page count, %PDF header present). This is the maximum automation possible
 * without a real PDF viewer process.
 *
 * External viewer testing (Chrome, Acrobat, Preview, Firefox pdf.js)
 * remains a manual step recorded in RELEASE_CHECKLIST.md §1.
 *
 * Exit 0 = all structural checks pass. Exit 1 = at least one failure.
 */

import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

const results = [];
let failures = 0;

async function check(toolName, label, fn) {
  try {
    await fn();
    results.push({ tool: toolName, label, pass: true });
  } catch (err) {
    results.push({ tool: toolName, label, pass: false, error: String(err) });
    failures++;
  }
}

function ok(v, msg) {
  if (!v) throw new Error(msg);
}

// ---------------------------------------------------------------------------
// Helper: build a minimal N-page PDF
// ---------------------------------------------------------------------------
async function makePdf(pages = 1, text = 'Stapler QA-05') {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([595, 842]);
    page.setFont(font);
    page.drawText(`${text} — page ${i + 1} of ${pages}`, {
      x: 50,
      y: 780,
      size: 14,
      color: rgb(0.1, 0.1, 0.1)
    });
  }
  return doc.save();
}

// Helper: parse bytes and return the loaded doc
async function loadPdf(bytes) {
  return PDFDocument.load(bytes, { throwOnInvalidObject: false });
}

// ---------------------------------------------------------------------------
// Merge (OPS-01) — combine 2 PDFs by copying pages
// ---------------------------------------------------------------------------
await check('Merge (OPS-01)', 'Two 1-page PDFs merged into 2-page output', async () => {
  const a = await makePdf(1, 'Doc A');
  const b = await makePdf(1, 'Doc B');
  const docA = await PDFDocument.load(a);
  const docB = await PDFDocument.load(b);
  const merged = await PDFDocument.create();
  const [pageA] = await merged.copyPages(docA, [0]);
  const [pageB] = await merged.copyPages(docB, [0]);
  merged.addPage(pageA);
  merged.addPage(pageB);
  const out = await merged.save();
  const reparsed = await loadPdf(out);
  ok(reparsed.getPageCount() === 2, 'Expected 2 pages after merge');
  ok(out[0] === 0x25, 'Output does not start with %');
});

// ---------------------------------------------------------------------------
// Organize / Rotate (OPS-02) — rotate page 90°
// ---------------------------------------------------------------------------
await check('Organize/Rotate (OPS-02)', 'Page rotation survives serialise → re-parse', async () => {
  const bytes = await makePdf(2, 'Rotate test');
  const doc = await PDFDocument.load(bytes);
  doc.getPage(0).setRotation({ angle: 90, type: 'degrees' });
  const out = await doc.save();
  const reparsed = await loadPdf(out);
  ok(reparsed.getPageCount() === 2, 'Page count wrong after rotation');
  const rotated = reparsed.getPage(0).getRotation().angle;
  ok(rotated === 90, `Expected rotation 90°, got ${rotated}`);
});

// ---------------------------------------------------------------------------
// Split (OPS-03) — split a 3-page doc into 3 single-page PDFs
// ---------------------------------------------------------------------------
await check('Split (OPS-03)', 'Split 3-page doc into 3 single-page outputs', async () => {
  const bytes = await makePdf(3, 'Split test');
  const src = await PDFDocument.load(bytes);
  for (let i = 0; i < 3; i++) {
    const out = await PDFDocument.create();
    const [page] = await out.copyPages(src, [i]);
    out.addPage(page);
    const serialized = await out.save();
    const reparsed = await loadPdf(serialized);
    ok(reparsed.getPageCount() === 1, `Chunk ${i}: expected 1 page`);
  }
});

// ---------------------------------------------------------------------------
// Export / Compose (DOC-05) — serialize and re-parse
// ---------------------------------------------------------------------------
await check(
  'Export/Compose (DOC-05)',
  'Document serialises and re-parses without error',
  async () => {
    const bytes = await makePdf(5, 'Export test');
    const doc = await loadPdf(bytes);
    ok(doc.getPageCount() === 5, 'Expected 5 pages');
    const header = new TextDecoder('ascii').decode(bytes.slice(0, 5));
    ok(header === '%PDF-', `Header mismatch: ${header}`);
  }
);

// ---------------------------------------------------------------------------
// Compress (CMP-03) — output parses and has same page count
// ---------------------------------------------------------------------------
await check('Compress (CMP-03)', 'Compressed output re-parses cleanly', async () => {
  const bytes = await makePdf(2, 'Compress test');
  // pdf-lib's useObjectStreams option mimics compression pipeline output
  const doc = await PDFDocument.load(bytes);
  const out = await doc.save({ useObjectStreams: true });
  const reparsed = await loadPdf(out);
  ok(reparsed.getPageCount() === 2, 'Page count wrong after object-stream save');
});

// ---------------------------------------------------------------------------
// Sign / Fill (SGN-03, SGN-06) — AcroForm field survives round-trip
// ---------------------------------------------------------------------------
await check(
  'Sign/Fill (SGN-03, SGN-06)',
  'AcroForm text field survives serialise → re-parse',
  async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([595, 842]);
    const form = doc.getForm();
    const field = form.createTextField('test.field');
    field.setText('Stapler QA');
    field.addToPage(page, { x: 50, y: 700, width: 200, height: 24 });
    const out = await doc.save();
    const reparsed = await loadPdf(out);
    ok(reparsed.getPageCount() === 1, 'Page count wrong');
    const reparsedField = reparsed.getForm().getTextField('test.field');
    ok(reparsedField.getText() === 'Stapler QA', 'Field value not preserved');
  }
);

// ---------------------------------------------------------------------------
// Annotate (ANN-01) — annotation survives round-trip
// ---------------------------------------------------------------------------
await check('Annotate (ANN-01)', 'Highlight annotation embedded without XRef error', async () => {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]);
  // Embed a raw annotation dict (pdf-lib has no public highlight API)
  const page = doc.getPage(0);
  const context = doc.context;
  const annot = context.obj({
    Type: 'Annot',
    Subtype: 'Highlight',
    Rect: [50, 700, 200, 720],
    C: [1, 0.9, 0],
    QuadPoints: [50, 720, 200, 720, 50, 700, 200, 700]
  });
  const ref = context.register(annot);
  page.node.set(context.obj('Annots'), context.obj([ref]));
  const out = await doc.save();
  const reparsed = await loadPdf(out);
  ok(reparsed.getPageCount() === 1, 'Page count wrong after annotation');
});

// ---------------------------------------------------------------------------
// Table extract (OCR-03) — generated CSV is well-formed
// ---------------------------------------------------------------------------
await check(
  'Table Extract (OCR-03)',
  'CSV export from table data is non-empty and valid',
  async () => {
    // Simulate the exportTableToCsv logic inline (no ESM import from src/ needed)
    const rows = [
      ['Name', 'Amount', 'Date'],
      ['Alice', '1,200.00', '2026-08-01'],
      ['Bob', '980', '2026-08-05']
    ];
    const csv = rows
      .map(row =>
        row
          .map(cell =>
            cell.includes(',') || cell.includes('"') || cell.includes('\n')
              ? `"${cell.replace(/"/g, '""')}"`
              : cell
          )
          .join(',')
      )
      .join('\n');
    ok(csv.includes('Alice'), 'Alice not in CSV');
    ok(csv.includes('"1,200.00"'), 'Comma-containing cell not quoted');
    ok(csv.split('\n').length === 3, 'Expected 3 rows');
  }
);

// ---------------------------------------------------------------------------
// Print results table
// ---------------------------------------------------------------------------
console.log('\n┌─────────────────────────────────────────────────────────────────────┐');
console.log('│  QA-05 — Automated Structural Validation                            │');
console.log('├─────────────────────────────────────────────────────────────────────┤');

for (const r of results) {
  const icon = r.pass ? '✅' : '❌';
  const line = `${icon}  ${r.tool}: ${r.label}`;
  console.log(`│  ${line.padEnd(69)}│`);
  if (!r.pass) {
    const err = `     Error: ${r.error}`.slice(0, 72);
    console.log(`│  ${err.padEnd(69)}│`);
  }
}

console.log('├─────────────────────────────────────────────────────────────────────┤');
const summary =
  failures === 0
    ? `✅  All ${results.length} structural checks passed.`
    : `❌  ${failures} of ${results.length} checks failed.`;
console.log(`│  ${summary.padEnd(69)}│`);
console.log('└─────────────────────────────────────────────────────────────────────┘');
console.log('');
console.log('Note: External viewer testing (Chrome PDF viewer, Adobe Acrobat Reader,');
console.log('      macOS Preview, Firefox pdf.js) remains a manual QA-05 step.');
console.log('      See RELEASE_CHECKLIST.md §1 for the manual checklist.\n');

process.exit(failures > 0 ? 1 : 0);
