/**
 * Embedding and placing one imported image in a PDF (CNV-01 / CONV-10).
 *
 * `imagesToPdf` receives either encoded bytes (JPEG or PNG, told apart by
 * signature) or a passed-through JPEG plus the EXIF orientation it still
 * needs. Rotation is applied here, in the placement matrix, instead of by
 * decoding and re-encoding the pixels: a sideways phone photo at "Maximum"
 * quality keeps its original bytes (the lossless path used to write it as a
 * PNG about 2.7× larger than the JPEG it came from).
 *
 * A JPEG that carries an ICC profile gets it as an `/ICCBased` colour space,
 * so a Display P3 or Adobe RGB photo is drawn with the colours the browser
 * showed rather than reinterpreted as sRGB.
 */
import {
  PDFArray,
  PDFName,
  PDFRawStream,
  concatTransformationMatrix,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
  type PDFDocument,
  type PDFImage,
  type PDFPage
} from 'pdf-lib';
import { iccComponents, readJpegInfo } from './jpeg-info';

/** One image for `imagesToPdf`: encoded bytes, or a passed-through JPEG and its orientation. */
export type PdfImageSource = Uint8Array | { bytes: Uint8Array; orientation?: number };

export interface PlacedImage {
  image: PDFImage;
  /** EXIF orientation 1–8 applied when drawn. */
  orientation: number;
  /** Displayed size in pixels — width and height swap for orientations 5–8. */
  width: number;
  height: number;
}

function isPng(bytes: Uint8Array): boolean {
  return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
}

/** Embeds one image and reports the size it will be displayed at. */
export async function embedPdfImage(
  doc: PDFDocument,
  source: PdfImageSource
): Promise<PlacedImage> {
  const bytes = source instanceof Uint8Array ? source : source.bytes;
  const requested = source instanceof Uint8Array ? 1 : (source.orientation ?? 1);
  const orientation =
    Number.isInteger(requested) && requested >= 1 && requested <= 8 ? requested : 1;

  let image: PDFImage;
  if (isPng(bytes)) {
    image = await doc.embedPng(bytes);
  } else {
    image = await doc.embedJpg(bytes);
    await attachIccProfile(doc, image, bytes);
  }
  const swap = orientation >= 5;
  return {
    image,
    orientation,
    width: swap ? image.height : image.width,
    height: swap ? image.width : image.height
  };
}

/**
 * Replaces the JPEG XObject's device colour space with `/ICCBased` when the
 * file embeds a profile whose component count matches the frame. A profile
 * that does not reassemble, or disagrees with the frame, is left out — the
 * image then draws exactly as it did before this existed.
 */
async function attachIccProfile(doc: PDFDocument, image: PDFImage, jpeg: Uint8Array) {
  const info = readJpegInfo(jpeg);
  const profile = info?.iccProfile;
  if (!info || !(profile instanceof Uint8Array)) return;
  const n = iccComponents(profile);
  if (n !== info.components || (n !== 1 && n !== 3)) return;
  await image.embed();
  const stream = doc.context.lookup(image.ref);
  if (!(stream instanceof PDFRawStream)) return;
  const iccRef = doc.context.register(
    doc.context.flateStream(profile, {
      N: n,
      Alternate: n === 1 ? 'DeviceGray' : 'DeviceRGB'
    })
  );
  const colorSpace = PDFArray.withContext(doc.context);
  colorSpace.push(PDFName.of('ICCBased'));
  colorSpace.push(iccRef);
  stream.dict.set(PDFName.of('ColorSpace'), colorSpace);
}

/**
 * The PDF `cm` matrix that maps the image's unit square onto `rect` with the
 * EXIF `orientation` applied. The image space's (u, v) — u along the stored
 * columns, v up from the stored bottom row — goes to the displayed
 * (u', v') = (a1·u + b1·v + c1, a2·u + b2·v + c2), then into the rectangle.
 */
export function orientationMatrix(
  orientation: number,
  rect: { x: number; y: number; width: number; height: number }
): [number, number, number, number, number, number] {
  //                         a1  b1  c1  a2  b2  c2
  const table: Record<number, [number, number, number, number, number, number]> = {
    1: [1, 0, 0, 0, 1, 0],
    2: [-1, 0, 1, 0, 1, 0], // mirrored horizontally
    3: [-1, 0, 1, 0, -1, 1], // rotated 180°
    4: [1, 0, 0, 0, -1, 1], // mirrored vertically
    5: [0, -1, 1, -1, 0, 1], // transposed
    6: [0, 1, 0, -1, 0, 1], // rotated 90° clockwise
    7: [0, 1, 0, 1, 0, 0], // transversed
    8: [0, -1, 1, 1, 0, 0] // rotated 90° anticlockwise
  };
  const [a1, b1, c1, a2, b2, c2] = table[orientation] ?? table[1];
  const { x, y, width: w, height: h } = rect;
  return [w * a1, h * a2, w * b1, h * b2, x + w * c1, y + h * c2];
}

/** Draws a {@link PlacedImage} into `rect` (displayed orientation). */
export function drawPlacedImage(
  page: PDFPage,
  placed: PlacedImage,
  rect: { x: number; y: number; width: number; height: number }
): void {
  if (placed.orientation === 1) {
    page.drawImage(placed.image, rect);
    return;
  }
  const name = page.node.newXObject('Image', placed.image.ref);
  page.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(...orientationMatrix(placed.orientation, rect)),
    drawObject(name),
    popGraphicsState()
  );
}
