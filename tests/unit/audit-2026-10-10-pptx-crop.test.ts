/**
 * Audit 2026-10-10 CV4 — a PowerPoint picture's `<a:srcRect>` crop.
 *
 * `pictureItem` never read the crop, so PPT → PDF drew the whole source image
 * squeezed into the frame — the parts the author cropped away included. Graded
 * on the rendered output page.
 */
import { describe, expect, it, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { decodeToRgba, installCanvasShims } from './helpers/node-canvas-shims';

vi.setConfig({ testTimeout: 60_000 });
vi.mock('comlink', () => ({
  expose: vi.fn(),
  transfer: vi.fn(value => value),
  proxy: vi.fn(value => value),
  releaseProxy: Symbol('releaseProxy')
}));
vi.mock('../../src/core/workers/pdfjs-setup', async () => {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return {
    pdfjsLib,
    openDocument: ({ data, password }: { data: Uint8Array; password?: string }) =>
      pdfjsLib.getDocument({ data, password, disableFontFace: true, verbosity: 0 })
  };
});

installCanvasShims();
const { readPptxAsBlocks } = await import('../../src/core/convert/pptx-slides');
const { layoutBlocksToPdf } = await import('../../src/core/convert/pdf-block-layout');
const { renderWorkerImpl } = await import('../../src/core/workers/render.worker');
const { encodePng } = await import('../../src/core/png');

const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

/** A 4:3 slide (720×540 pt) with one picture filling it; `srcRect` attributes as given. */
function deck(srcRect: string | null): Uint8Array {
  // 4×1 greyscale: left half black, right half white.
  const png = encodePng({
    width: 4,
    height: 1,
    bitDepth: 8,
    colorType: 0,
    samples: new Uint8Array([0, 0, 255, 255])
  });
  const crop = srcRect === null ? '' : `<a:srcRect ${srcRect}/>`;
  const pic =
    '<p:pic><p:nvPicPr/><p:blipFill><a:blip r:embed="rId2"/>' +
    crop +
    '<a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
    '<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="9144000" cy="6858000"/></a:xfrm></p:spPr></p:pic>';
  return zipSync({
    'ppt/presentation.xml': strToU8(
      `<p:presentation ${NS}><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>` +
        '<p:sldSz cx="9144000" cy="6858000"/></p:presentation>'
    ),
    'ppt/_rels/presentation.xml.rels': strToU8(
      '<Relationships><Relationship Id="rId1" Type="slide" Target="slides/slide1.xml"/></Relationships>'
    ),
    'ppt/slides/slide1.xml': strToU8(
      `<p:sld ${NS}><p:cSld><p:spTree>${pic}</p:spTree></p:cSld></p:sld>`
    ),
    'ppt/slides/_rels/slide1.xml.rels': strToU8(
      '<Relationships><Relationship Id="rId2" Target="../media/image1.png"/></Relationships>'
    ),
    'ppt/media/image1.png': png
  });
}

/** Mean grey of the rendered page's left and right thirds. */
async function render(pptx: Uint8Array): Promise<{ left: number; right: number }> {
  const read = await readPptxAsBlocks(pptx);
  const { bytes } = await layoutBlocksToPdf(read.blocks, {
    pageSize: 'a4',
    pageBox: { width: 720, height: 540 }
  });
  const { handle } = await renderWorkerImpl.loadDocument(bytes.slice());
  try {
    const png = await renderWorkerImpl.pageToImageBytes(handle, 0, 'png', 36);
    const { data, width, height } = await decodeToRgba(png);
    const mean = (x0: number, x1: number) => {
      let sum = 0;
      let n = 0;
      for (let y = Math.floor(height * 0.25); y < height * 0.75; y++) {
        for (let x = Math.floor(x0 * width); x < x1 * width; x++) {
          sum += data[(y * width + x) * 4];
          n++;
        }
      }
      return sum / n;
    };
    return { left: mean(0.05, 0.3), right: mean(0.7, 0.95) };
  } finally {
    await renderWorkerImpl.closeDocument(handle);
  }
}

describe('CV4 — PPT → PDF honours a picture crop', () => {
  it('premise: uncropped, the left half of the frame is black', async () => {
    const { left, right } = await render(deck(null));
    expect(left).toBeLessThan(40);
    expect(right).toBeGreaterThan(215);
  });

  it('cropping away the left half (l="50000") leaves only white in the frame', async () => {
    const { left, right } = await render(deck('l="50000" r="0" t="0" b="0"'));
    expect(left).toBeGreaterThan(215);
    expect(right).toBeGreaterThan(215);
  });

  it('cropping away the right half (r="50000") leaves only black', async () => {
    const { left, right } = await render(deck('r="50000"'));
    expect(left).toBeLessThan(40);
    expect(right).toBeLessThan(40);
  });

  it('carries the crop on the canvas item and drops a crop that keeps nothing', async () => {
    const cropped = await readPptxAsBlocks(deck('l="25000" t="10000"'));
    const items = cropped.blocks.flatMap(b => (b.kind === 'canvas' ? b.items : []));
    const image = items.find(i => i.kind === 'image');
    expect(image && image.kind === 'image' ? image.crop : null).toEqual({
      left: 0.25,
      top: 0.1,
      right: 0,
      bottom: 0
    });
    // Nothing of the picture is kept, so (as in PowerPoint) nothing is drawn —
    // and a deck with nothing drawable is refused, not written blank.
    await expect(readPptxAsBlocks(deck('l="60000" r="40000"'))).rejects.toThrow(
      /Nothing in this presentation could be drawn/
    );
  });
});

describe('CV4 — Word → PDF says a cropped picture is shown uncropped', () => {
  const docx = (body: string) =>
    zipSync({
      '[Content_Types].xml': strToU8(
        '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
      ),
      '_rels/.rels': strToU8(
        '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
      ),
      'word/document.xml': strToU8(
        '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
          'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><w:body><w:p><w:r><w:t>Hi</w:t></w:r></w:p>' +
          body +
          '</w:body></w:document>'
      )
    });

  it('adds the note when a picture has a nonzero srcRect, and not otherwise', async () => {
    const { readDocxAsHtml, DOCX_CROPPED_PICTURES_MESSAGE } =
      await import('../../src/core/convert/docx-reader');
    const cropped = await readDocxAsHtml(docx('<a:srcRect l="12000" r="0"/>'));
    expect(cropped.messages).toContain(DOCX_CROPPED_PICTURES_MESSAGE);
    const zero = await readDocxAsHtml(docx('<a:srcRect/>'));
    expect(zero.messages).not.toContain(DOCX_CROPPED_PICTURES_MESSAGE);
    const plain = await readDocxAsHtml(docx(''));
    expect(plain.html).toContain('Hi');
    expect(plain.messages).not.toContain(DOCX_CROPPED_PICTURES_MESSAGE);
  });
});
