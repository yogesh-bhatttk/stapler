/**
 * JPEG marker parsing for the lossless image-import path (CONV-10), pure so
 * both the main thread (`image.ts`, which decides whether a JPEG can be passed
 * through) and the process worker (`image-embed.ts`, which embeds it) share
 * one reading of the file.
 *
 * Nothing here decodes pixels: it walks the marker segments up to the first
 * frame header and collects what the passthrough decision needs — the frame
 * type, precision, component count, EXIF orientation and any embedded ICC
 * profile.
 */

/** What {@link readJpegInfo} learns from a JPEG's markers without decoding it. */
export interface JpegInfo {
  width: number;
  height: number;
  /** Sample precision in bits (8 for every ordinary JPEG). */
  precision: number;
  components: number;
  /** EXIF orientation 1–8; 1 when the file has no EXIF orientation tag. */
  orientation: number;
  /**
   * The start-of-frame marker's second byte: 0xC0 baseline, 0xC1 extended,
   * 0xC2 progressive, 0xC3 lossless, 0xC5–0xC7 hierarchical, 0xC9–0xCF
   * arithmetic-coded.
   */
  frameMarker: number;
  /**
   * The embedded ICC profile, reassembled from its APP2 `ICC_PROFILE` chunks;
   * `null` when there is none. `'invalid'` when chunks are present but do not
   * reassemble into one well-formed profile (missing or duplicated chunks, a
   * header whose size disagrees).
   */
  iccProfile: Uint8Array | null | 'invalid';
}

const ICC_SIGNATURE = [0x49, 0x43, 0x43, 0x5f, 0x50, 0x52, 0x4f, 0x46, 0x49, 0x4c, 0x45, 0x00]; // "ICC_PROFILE\0"

/**
 * Walks a JPEG's marker segments up to the first frame header. Returns null for
 * anything that is not a well-formed JPEG up to that point.
 *
 * APP2 ICC chunks that come *after* the frame header are not collected; every
 * producer writes them before it (the ICC.1 embedding spec requires it).
 */
export function readJpegInfo(bytes: Uint8Array): JpegInfo | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let orientation = 1;
  const iccChunks: { seq: number; count: number; data: Uint8Array }[] = [];
  let p = 2;
  while (p + 4 <= bytes.length) {
    if (bytes[p] !== 0xff) return null;
    const marker = bytes[p + 1];
    // Fill bytes and standalone markers carry no length.
    if (marker === 0xff) {
      p += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      p += 2;
      continue;
    }
    const length = (bytes[p + 2] << 8) | bytes[p + 3];
    if (length < 2 || p + 2 + length > bytes.length) return null;
    const seg = p + 4;
    const segEnd = p + 2 + length;
    if (marker === 0xe1 && length >= 16) {
      orientation = exifOrientation(bytes, seg, segEnd) ?? orientation;
    }
    if (marker === 0xe2 && length >= 2 + ICC_SIGNATURE.length + 2) {
      if (ICC_SIGNATURE.every((b, i) => bytes[seg + i] === b)) {
        const at = seg + ICC_SIGNATURE.length;
        iccChunks.push({
          seq: bytes[at],
          count: bytes[at + 1],
          data: bytes.subarray(at + 2, segEnd)
        });
      }
    }
    // SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (length < 8) return null;
      return {
        precision: bytes[seg],
        height: (bytes[seg + 1] << 8) | bytes[seg + 2],
        width: (bytes[seg + 3] << 8) | bytes[seg + 4],
        components: bytes[seg + 5],
        orientation,
        frameMarker: marker,
        iccProfile: assembleIcc(iccChunks)
      };
    }
    if (marker === 0xda || marker === 0xd9) return null; // scan before any frame header
    p = segEnd;
  }
  return null;
}

/** Joins APP2 ICC chunks in sequence order; see {@link JpegInfo.iccProfile}. */
function assembleIcc(
  chunks: { seq: number; count: number; data: Uint8Array }[]
): Uint8Array | null | 'invalid' {
  if (chunks.length === 0) return null;
  const count = chunks[0].count;
  if (count === 0 || chunks.length !== count || chunks.some(c => c.count !== count)) {
    return 'invalid';
  }
  const ordered: Uint8Array[] = [];
  for (let seq = 1; seq <= count; seq++) {
    const chunk = chunks.find(c => c.seq === seq);
    if (!chunk) return 'invalid';
    ordered.push(chunk.data);
  }
  const total = ordered.reduce((n, c) => n + c.length, 0);
  const profile = new Uint8Array(total);
  let offset = 0;
  for (const c of ordered) {
    profile.set(c, offset);
    offset += c.length;
  }
  if (profile.length < 128) return 'invalid';
  const declared = ((profile[0] << 24) | (profile[1] << 16) | (profile[2] << 8) | profile[3]) >>> 0;
  // "acsp" at 36 is the profile file signature every ICC profile carries.
  const signature = String.fromCharCode(profile[36], profile[37], profile[38], profile[39]);
  if (declared !== profile.length || signature !== 'acsp') return 'invalid';
  return profile;
}

/** The ICC profile's data colour space (header bytes 16–19), e.g. `'RGB '`, `'GRAY'`. */
export function iccColorSpace(profile: Uint8Array): string {
  return String.fromCharCode(profile[16], profile[17], profile[18], profile[19]);
}

/** Components an ICC data colour space describes, or 0 for one a JPEG never carries here. */
export function iccComponents(profile: Uint8Array): number {
  switch (iccColorSpace(profile)) {
    case 'GRAY':
      return 1;
    case 'RGB ':
      return 3;
    case 'CMYK':
      return 4;
    default:
      return 0;
  }
}

/** The orientation tag (0x0112) of an APP1 "Exif" segment, if it has one. */
function exifOrientation(b: Uint8Array, start: number, end: number): number | null {
  // "Exif\0\0" then a TIFF header.
  if (
    b[start] !== 0x45 ||
    b[start + 1] !== 0x78 ||
    b[start + 2] !== 0x69 ||
    b[start + 3] !== 0x66
  ) {
    return null;
  }
  const tiff = start + 6;
  if (tiff + 8 > end) return null;
  const little = b[tiff] === 0x49 && b[tiff + 1] === 0x49;
  if (!little && !(b[tiff] === 0x4d && b[tiff + 1] === 0x4d)) return null;
  const u16 = (o: number) => (little ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
  const u32 = (o: number) =>
    little
      ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0
      : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > end) return null;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > end) return null;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : null;
    }
  }
  return null;
}

/**
 * Frame types every PDF viewer's DCT decoder handles: baseline, extended
 * sequential and progressive Huffman. Lossless (C3), hierarchical (C5–C7) and
 * arithmetic-coded (C9–CF) JPEGs are legal in a PDF but pdf.js, Preview and
 * others refuse or mis-draw them, so they are decoded and re-encoded instead.
 */
const PASSTHROUGH_FRAMES = new Set([0xc0, 0xc1, 0xc2]);

/**
 * Whether a JPEG's own bytes can go straight into the PDF (`embedJpg`) and be
 * drawn exactly as the browser draws them (CONV-10). Returns the EXIF
 * orientation to apply at placement time (the image-embed module turns it into
 * the placement matrix — pdf-lib ignores EXIF), or `null` to decode instead.
 *
 * Requires: a frame type every viewer decodes, 8-bit samples, grey or RGB
 * (CMYK is excluded because pdf-lib assumes Adobe's inverted CMYK, which not
 * every producer writes), and an ICC profile that is either absent or
 * reassembles cleanly with a component count that matches the frame — the
 * profile then goes into the PDF as an `/ICCBased` colour space, so a Display
 * P3 or Adobe RGB photo keeps the colours the browser shows (CONV-2 review).
 */
export function jpegPassthrough(bytes: Uint8Array): { orientation: number } | null {
  const info = readJpegInfo(bytes);
  if (
    info === null ||
    !PASSTHROUGH_FRAMES.has(info.frameMarker) ||
    info.precision !== 8 ||
    (info.components !== 1 && info.components !== 3) ||
    info.width <= 0 ||
    info.height <= 0 ||
    info.iccProfile === 'invalid'
  ) {
    return null;
  }
  if (info.iccProfile && iccComponents(info.iccProfile) !== info.components) return null;
  return { orientation: info.orientation };
}
