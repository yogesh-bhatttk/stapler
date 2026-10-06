import { execSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
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

  createRawPdf('device-n.pdf', [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [ 3 0 R ] >>',
    `<< /Type /Page /Parent 2 0 R ${MEDIA_BOX} /Resources << /XObject << /Im1 4 0 R >> >> >>`,
    '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceN /BitsPerComponent 8 /Length 0 >> stream\nendstream'
  ]);
  createRawPdf('separation.pdf', [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [ 3 0 R ] >>',
    `<< /Type /Page /Parent 2 0 R ${MEDIA_BOX} /Resources << /XObject << /Im1 4 0 R >> >> >>`,
    '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /Separation /BitsPerComponent 8 /Length 0 >> stream\nendstream'
  ]);
  createRawPdf('color-key.pdf', [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [ 3 0 R ] >>',
    `<< /Type /Page /Parent 2 0 R ${MEDIA_BOX} /Resources << /XObject << /Im1 4 0 R >> >> >>`,
    '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Mask [ 0 255 ] /Length 0 >> stream\nendstream'
  ]);
  createRawPdf('stencil.pdf', [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [ 3 0 R ] >>',
    `<< /Type /Page /Parent 2 0 R ${MEDIA_BOX} /Resources << /XObject << /Im1 4 0 R >> >> >>`,
    '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ImageMask true /BitsPerComponent 8 /Length 0 >> stream\nendstream'
  ]);
  createRawPdf('soft-mask.pdf', [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [ 3 0 R ] >>',
    `<< /Type /Page /Parent 2 0 R ${MEDIA_BOX} /Resources << /XObject << /Im1 4 0 R >> >> >>`,
    '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /SMask 5 0 R /Length 0 >> stream\nendstream',
    '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 0 >> stream\nendstream'
  ]);
  createRawPdf('pre-blended.pdf', [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [ 3 0 R ] >>',
    `<< /Type /Page /Parent 2 0 R ${MEDIA_BOX} /Resources << /XObject << /Im1 4 0 R >> >> >>`,
    '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /SMask 5 0 R /Length 0 >> stream\nendstream',
    '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Matte [ 0 0 0 ] /Length 0 >> stream\nendstream'
  ]);
  createRawPdf('indexed.pdf', [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [ 3 0 R ] >>',
    `<< /Type /Page /Parent 2 0 R ${MEDIA_BOX} /Resources << /XObject << /Im1 4 0 R >> >> >>`,
    '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace [ /Indexed /DeviceRGB 255 5 0 R ] /BitsPerComponent 8 /Length 0 >> stream\nendstream',
    '<< /Length 0 >> stream\nendstream'
  ]);
  createRawPdf('icc.pdf', [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [ 3 0 R ] >>',
    `<< /Type /Page /Parent 2 0 R ${MEDIA_BOX} /Resources << /XObject << /Im1 4 0 R >> >> >>`,
    '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace [ /ICCBased 5 0 R ] /BitsPerComponent 8 /Length 0 >> stream\nendstream',
    '<< /Length 0 >> stream\nendstream'
  ]);
  createRawPdf('sub-byte.pdf', [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [ 3 0 R ] >>',
    `<< /Type /Page /Parent 2 0 R ${MEDIA_BOX} /Resources << /XObject << /Im1 4 0 R >> >> >>`,
    '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 1 /Length 0 >> stream\nendstream'
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

  // cmyk-text.pdf: a CMYK image whose /ColorSpace is an *indirect* reference (`10 0 R`),
  // which is the case that used to fall through to "unknown" and get re-encoded to RGB
  // regardless of the true colour space (CMP-03).
  const cmykText = path.join(FIXTURES_DIR, 'cmyk-text.pdf');
  if (!existsSync(cmykText)) {
    run(
      `convert -size 400x400 xc:cyan -fill black -pointsize 32 -annotate +20+60 "CMYK text" -colorspace CMYK ${cmykText}`,
      'ImageMagick (convert)'
    );
  }

  // tiny.jpg: a 10x210 grayscale JPEG. The extreme aspect ratio is the point — it is what
  // the images-to-PDF orientation and page-fit assertions measure against (CNV-01). Node
  // has no JPEG encoder, so this cannot be built inside the test the way PNGs are.
  const tinyJpg = path.join(FIXTURES_DIR, 'tiny.jpg');
  if (!existsSync(tinyJpg)) {
    run(
      `convert -size 10x210 gradient:white-black -colorspace Gray ${tinyJpg}`,
      'ImageMagick (convert)'
    );
  }

  // sample.png / sample.webp / sample.tiff: one 240x160 image in three encodings, so
  // DOC-02's "accept PNG, JPEG, WebP, TIFF, HEIC" is exercised through the real import
  // pipeline rather than asserted. (JPEG is covered by tiny.jpg; HEIC has no offline
  // encoder in this toolchain — see tests/fixtures/README.md.)
  for (const ext of ['png', 'webp', 'tiff']) {
    const file = path.join(FIXTURES_DIR, `sample.${ext}`);
    if (!existsSync(file)) {
      run(`convert -size 240x160 gradient:red-blue ${file}`, 'ImageMagick (convert)');
    }
  }

  // multipage.tiff: three IFDs, so HRD-05's "N IFDs → N pages" is proved on a real file
  // (sample.tiff has one). See writeMultipageTiff below.
  const multipageTiff = path.join(FIXTURES_DIR, 'multipage.tiff');
  if (!existsSync(multipageTiff)) writeFileSync(multipageTiff, writeMultipageTiff());

  // face-chip.png: a real photographic face, for RED-08's detector test. Cropped from
  // the MIT-licensed sample that ships inside the installed `@vladmandic/face-api`
  // package — the same library whose detector the test runs — so no new asset enters
  // the repo from outside the dependency tree. The crop rectangle is fixed on purpose:
  // `tests/unit/faceblur.test.ts` hard-codes where the face sits inside the result, and
  // regenerating with a different crop would move it. See tests/fixtures/README.md.
  const faceChip = path.join(FIXTURES_DIR, 'face-chip.png');
  if (!existsSync(faceChip)) {
    const sample = path.resolve(
      process.cwd(),
      'node_modules/@vladmandic/face-api/demo/sample1.jpg'
    );
    if (!existsSync(sample)) {
      throw new Error(
        `Cannot rebuild face-chip.png: ${sample} is missing. Run an install first — the ` +
          'source image ships inside the @vladmandic/face-api dependency.'
      );
    }
    run(
      `convert ${sample} -crop 594x599+1278+42 +repage -resize 240x240! -depth 8 PNG24:${faceChip}`,
      'ImageMagick (convert)'
    );
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

  // permission-restricted.pdf: an /Encrypt dictionary with an owner password but
  // NO user password — the extremely common "printing/copying restricted, opens
  // with no prompt" PDF that Chrome, Acrobat and Preview all open transparently.
  // Regression fixture for the bug where Stapler refused every /Encrypt-bearing
  // PDF outright instead of trying the empty user password first.
  const permissionOnly = path.join(FIXTURES_DIR, 'permission-restricted.pdf');
  if (!existsSync(permissionOnly)) {
    const tempIn = path.join(FIXTURES_DIR, 'temp_perm.pdf');
    run(
      `convert -size 200x200 xc:white -fill black -annotate 0 "Not actually secret" ${tempIn}`,
      'ImageMagick (convert)'
    );
    run(
      `gs -q -dNOPAUSE -dBATCH -sDEVICE=pdfwrite -sOwnerPassword=owner -sOutputFile=${permissionOnly} ${tempIn}`,
      'Ghostscript (gs)'
    );
    run(`rm ${tempIn}`, 'rm');
  }

  // permission-no-print.pdf: the same shape, but with permissions that actually
  // deny something — /P -3904, i.e. no printing, copying, modifying, annotating,
  // form filling or assembly (Acrobat's "view only"). `permission-restricted.pdf`
  // above carries Ghostscript's default /P -4, which restricts *nothing*, so it
  // cannot show whether an export still denies what the input denied. This one
  // can: re-parse the exported bytes and the same /P must still be there.
  const noPrint = path.join(FIXTURES_DIR, 'permission-no-print.pdf');
  if (!existsSync(noPrint)) {
    const tempIn = path.join(FIXTURES_DIR, 'temp_noprint.pdf');
    run(
      `convert -size 200x200 xc:white -fill black -annotate 0 "Do not print" ${tempIn}`,
      'ImageMagick (convert)'
    );
    run(
      `gs -q -dNOPAUSE -dBATCH -sDEVICE=pdfwrite -dEncryptionR=3 -dKeyLength=128 ` +
        `-dPermissions=-3904 -sOwnerPassword=owner -sOutputFile=${noPrint} ${tempIn}`,
      'Ghostscript (gs)'
    );
    run(`rm ${tempIn}`, 'rm');
  }
}

/**
 * multipage.tiff (HRD-05): a baseline TIFF 6.0 file with three IFDs, written byte by byte.
 *
 * Each page has its own size and fill, with a 20×20 red marker in its *stored* top-left
 * corner. Page 3 is stored landscape 200×100 with Orientation 6 (RightTop, "row 0 is the
 * visual right side"), the tag a scanner writes for a sideways page: it must import as a
 * portrait 100×200 page with the marker at the top-right. Pages 1 and 2 carry
 * Orientation 1.
 *
 * Written here rather than by ImageMagick, because ImageMagick applies `-orient` to every
 * frame of a multi-frame TIFF (and rewrites the pixels to match), so it cannot make one
 * sideways page among upright ones; and not by UTIF, so the decoder under test is not
 * grading its own encoder. RGB, 8 bits, one Deflate (Compression 8) strip per page —
 * deterministic, a few KB. `PIL`/libtiff read it back with the same sizes and tags.
 */
function writeMultipageTiff() {
  const pages = [
    { width: 300, height: 200, fill: [0, 255, 0], orientation: 1 },
    { width: 160, height: 240, fill: [0, 0, 255], orientation: 1 },
    { width: 200, height: 100, fill: [255, 255, 0], orientation: 6 }
  ];
  const strips = pages.map(({ width, height, fill }) => {
    const raw = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const rgb = x < 20 && y < 20 ? [255, 0, 0] : fill;
        raw.set(rgb, (y * width + x) * 3);
      }
    }
    return deflateSync(raw, { level: 9 });
  });

  const TAGS = 11;
  const ifdSize = 2 + TAGS * 12 + 4;
  const chunks = [];
  let offset = 8;
  const layout = pages.map((_, i) => {
    const stripOffset = offset;
    offset += strips[i].length + (strips[i].length % 2); // word-align what follows
    const bitsOffset = offset;
    offset += 6;
    const ifdOffset = offset;
    offset += ifdSize;
    return { stripOffset, bitsOffset, ifdOffset };
  });

  const header = Buffer.alloc(8);
  header.write('II', 0, 'latin1');
  header.writeUInt16LE(42, 2);
  header.writeUInt32LE(layout[0].ifdOffset, 4);
  chunks.push(header);

  pages.forEach((page, i) => {
    const { stripOffset, bitsOffset, ifdOffset } = layout[i];
    const strip = strips[i];
    chunks.push(strip);
    if (strip.length % 2) chunks.push(Buffer.alloc(1));
    const bits = Buffer.alloc(6);
    [8, 8, 8].forEach((b, k) => bits.writeUInt16LE(b, k * 2));
    chunks.push(bits);

    const SHORT = 3;
    const LONG = 4;
    // [tag, type, count, value], ascending by tag as TIFF requires.
    const entries = [
      [256, LONG, 1, page.width],
      [257, LONG, 1, page.height],
      [258, SHORT, 3, bitsOffset],
      [259, SHORT, 1, 8], // Deflate
      [262, SHORT, 1, 2], // RGB
      [273, LONG, 1, stripOffset],
      [274, SHORT, 1, page.orientation],
      [277, SHORT, 1, 3],
      [278, LONG, 1, page.height],
      [279, LONG, 1, strip.length],
      [284, SHORT, 1, 1] // chunky
    ];
    if (entries.length !== TAGS) throw new Error('multipage.tiff: tag count mismatch');
    const ifd = Buffer.alloc(ifdSize);
    ifd.writeUInt16LE(entries.length, 0);
    entries.forEach(([tag, type, count, value], k) => {
      const at = 2 + k * 12;
      ifd.writeUInt16LE(tag, at);
      ifd.writeUInt16LE(type, at + 2);
      ifd.writeUInt32LE(count, at + 4);
      if (type === SHORT && count === 1) ifd.writeUInt16LE(value, at + 8);
      else ifd.writeUInt32LE(value, at + 8);
    });
    ifd.writeUInt32LE(i + 1 < pages.length ? layout[i + 1].ifdOffset : 0, 2 + TAGS * 12);
    chunks.push(ifd);
    if (Buffer.concat(chunks).length !== ifdOffset + ifdSize) {
      throw new Error('multipage.tiff: layout offsets drifted');
    }
  });
  return Buffer.concat(chunks);
}

/**
 * The generated half of the corpus: every git-ignored fixture Node can build, from the
 * one table in `tests/e2e/fixture-corpus.ts` that the Playwright specs share. Run here,
 * before any runner, so `pnpm test` on a clean checkout never depends on an e2e run
 * having left files behind. The module is TypeScript (and some generators import from
 * `src/`), so it is loaded through a Vite module runner — with no config file, as a
 * plain Node module graph rather than the app — kept open until every generator,
 * including their lazy imports, has finished.
 */
async function generateCorpus() {
  const { createServer, createServerModuleRunner } = await import('vite');
  const server = await createServer({
    configFile: false,
    logLevel: 'error',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false, ws: false, watch: null }
  });
  try {
    const runner = createServerModuleRunner(server.environments.ssr, { hmr: false });
    const corpus = await runner.import(path.resolve('tests/e2e/fixture-corpus.ts'));
    const written = await corpus.generateFixtureCorpus(FIXTURES_DIR);
    if (written.length) console.log(`Generated ${written.length} fixtures: ${written.join(', ')}`);
    await runner.close();
  } finally {
    await server.close();
  }
}

generateRawStubs();
generateEncodedFixtures();
await generateCorpus();
console.log('Static fixtures present in tests/fixtures/ (generated any that were missing).');
