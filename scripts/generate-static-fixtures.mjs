import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const FIXTURES_DIR = path.resolve(process.cwd(), 'tests/fixtures');
mkdirSync(FIXTURES_DIR, { recursive: true });

function run(cmd, tool) {
  try {
    execSync(cmd, { stdio: 'inherit' });
  } catch (err) {
    throw new Error(
      `Fixture generation needs "${tool}" on PATH and the command failed: ${cmd}\n${err.message}`
    );
  }
}

/** US Letter. Every raw Page dict must carry one: /MediaBox is a required Page attribute,
 *  and pdf-lib's `page.getSize()` throws ("Expected instance of PDFArray") rather than
 *  defaulting when it is absent from both the Page and its Pages ancestry — which crashed
 *  CMP-01's classifier on these fixtures instead of routing/skipping the page. */
const MEDIA_BOX = '/MediaBox [ 0 0 612 792 ]';

/**
 * Hand-built minimal PDFs for filter/structure detection fixtures. These declare the
 * relevant filter or dictionary key but carry no real decodable payload — sufficient for
 * "detect and skip" / "detect and explain" tests, which read the dictionary and must never
 * attempt to decode. Deterministic and offline: no encoder can produce a real JBIG2/JPX
 * stream without a specialised library, and none is worth adding for a skip-path test.
 */
function createRawPdf(name, objects) {
  // Guard so a future stub cannot reintroduce a MediaBox-less page: catch it at generation
  // time here, rather than as an unhandled throw deep inside the classifier.
  for (const obj of objects) {
    if (/\/Type\s*\/Page(?![s\w])/.test(obj) && !obj.includes('/MediaBox')) {
      throw new Error(`Raw fixture "${name}" has a /Type /Page object with no /MediaBox: ${obj}`);
    }
  }

  const file = path.join(FIXTURES_DIR, name);
  if (existsSync(file)) return;
  const header = '%PDF-1.7\n%\xe2\xe3\xcf\xd3\n';
  let body = '';
  let xref = 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n';
  // The whole file is written with the 'latin1' encoding below (one byte per char code,
  // needed for the header's raw high-byte marker), so offsets must be counted the same way
  // — Buffer.byteLength's default 'utf8' would double-count those bytes and corrupt every
  // xref offset after the header.
  let offset = Buffer.byteLength(header, 'latin1');

  for (let i = 0; i < objects.length; i++) {
    const objStr = `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
    xref += offset.toString().padStart(10, '0') + ' 00000 n \n';
    body += objStr;
    offset += Buffer.byteLength(objStr, 'latin1');
  }

  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  writeFileSync(file, header + body + xref + trailer, 'latin1');
}

function generateRawStubs() {
  // JPEG2000 (JPX) image XObject: declares the filter, zero-length stream. CMP-01 must
  // route this to "skip", never attempt to decode it.
  createRawPdf('jpx.pdf', [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [ 3 0 R ] >>',
    `<< /Type /Page /Parent 2 0 R ${MEDIA_BOX} /Resources << /XObject << /Im1 4 0 R >> >> >>`,
    '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /JPXDecode /Length 0 >> stream\nendstream'
  ]);

  // JBIG2 image XObject: same shape, for the same reason.
  createRawPdf('jbig2.pdf', [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [ 3 0 R ] >>',
    `<< /Type /Page /Parent 2 0 R ${MEDIA_BOX} /Resources << /XObject << /Im1 4 0 R >> >> >>`,
    '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /JBIG2Decode /Length 0 >> stream\nendstream'
  ]);

  // XFA form: an AcroForm dict carrying /XFA. SGN-03 must detect this and refuse cleanly,
  // never attempt to render or fill it as a normal AcroForm.
  createRawPdf('xfa.pdf', [
    '<< /Type /Catalog /Pages 2 0 R /AcroForm << /XFA [ (template) 4 0 R ] >> >>',
    '<< /Type /Pages /Count 1 /Kids [ 3 0 R ] >>',
    `<< /Type /Page /Parent 2 0 R ${MEDIA_BOX} >>`,
    '<< /Length 10 >> stream\n<xfa/>\nendstream'
  ]);

  // CJK text via a predefined Adobe-Japan CMap (UniJIS-UTF16-H), which pdf.js bundles, so
  // extraction exercises a real CID lookup path rather than a synthetic in-memory fixture.
  // Codepoints 4E2D 6587 = "中文" ("Chinese language").
  createRawPdf('cjk.pdf', [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [ 3 0 R ] >>',
    `<< /Type /Page /Parent 2 0 R ${MEDIA_BOX} /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,
    '<< /Type /Font /Subtype /Type0 /BaseFont /HeiseiMin-W3 /Encoding /UniJIS-UTF16-H /DescendantFonts [ 6 0 R ] >>',
    '<< /Length 29 >> stream\nBT /F1 12 Tf <4E2D6587> Tj ET\nendstream',
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HeiseiMin-W3 /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 2 >> >>'
  ]);

  // RTL text via Identity-H. Codepoints 0645 0631 = "مر" (Arabic), reversed visual order is
  // exactly what CNV-04's bidi handling must correct.
  createRawPdf('rtl.pdf', [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [ 3 0 R ] >>',
    `<< /Type /Page /Parent 2 0 R ${MEDIA_BOX} /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,
    '<< /Type /Font /Subtype /Type0 /BaseFont /Arial /Encoding /Identity-H /DescendantFonts [ 6 0 R ] >>',
    '<< /Length 29 >> stream\nBT /F1 12 Tf <06450631> Tj ET\nendstream',
    '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Arial /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> >>'
  ]);
}

function generateEncodedFixtures() {
  // scanned_skewed.pdf: a rendered text image with noise and a 2° rotation, simulating a
  // skewed phone-photo scan. Feeds SCN-01 de-skew and CMP-02 raster-path compression.
  const scanned = path.join(FIXTURES_DIR, 'scanned_skewed.pdf');
  if (!existsSync(scanned)) {
    run(
      `convert -size 800x1000 xc:white -fill black -pointsize 40 -gravity center -annotate 0 "Scanned\\nDocument" +noise Gaussian -rotate 2 -depth 8 ${scanned}`,
      'ImageMagick (convert)'
    );
  }

  // cmyk.pdf: an image in the CMYK color space. CMP-03 must convert or skip, never
  // silently re-encode with a colour shift.
  const cmyk = path.join(FIXTURES_DIR, 'cmyk.pdf');
  if (!existsSync(cmyk)) {
    run(`convert -size 400x400 xc:cyan -colorspace CMYK ${cmyk}`, 'ImageMagick (convert)');
  }

  // encrypted.pdf: a real password-protected PDF via Ghostscript. DOC-02 must detect and
  // explain this, never fail obscurely.
  const encrypted = path.join(FIXTURES_DIR, 'encrypted.pdf');
  if (!existsSync(encrypted)) {
    const tempIn = path.join(FIXTURES_DIR, 'temp_enc.pdf');
    run(
      `convert -size 200x200 xc:white -fill black -annotate 0 "Secret" ${tempIn}`,
      'ImageMagick (convert)'
    );
    run(
      `gs -q -dNOPAUSE -dBATCH -sDEVICE=pdfwrite -sOwnerPassword=owner -sUserPassword=password -sOutputFile=${encrypted} ${tempIn}`,
      'Ghostscript (gs)'
    );
    run(`rm ${tempIn}`, 'rm');
  }
}

generateRawStubs();
generateEncodedFixtures();
console.log('Static fixtures present in tests/fixtures/ (generated any that were missing).');
