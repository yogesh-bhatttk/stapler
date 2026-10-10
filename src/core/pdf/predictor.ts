/**
 * `/DecodeParms /Predictor` support for streams decoded with pdf-lib (CV2).
 *
 * pdf-lib's `decodePDFRawStream` runs Flate/LZW and stops: it never reads
 * `/Predictor`, so a predicted stream (TIFF predictor 2, PNG predictors 10–15
 * — what most producers use for lossless images, and every xref stream) comes
 * back as row-filtered bytes, not samples. Treated as samples they are a
 * corrupt picture that still "decodes". Every caller that needs a stream's real
 * bytes goes through {@link decodeStreamBytes} instead.
 *
 * The predictor is undone right after the Flate/LZW step it belongs to, one
 * filter at a time, so a chain like `[/ASCII85Decode /FlateDecode]` with its
 * `/DecodeParms [null << /Predictor 15 … >>]` comes out right. Anything we
 * cannot undo exactly (an unknown predictor, a damaged row tag, a parameter
 * dictionary that cannot be matched to its filter) throws, so the caller
 * refuses the stream rather than using bytes it cannot vouch for.
 *
 * Pure: pdf-lib objects in, bytes out.
 */
import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  decodePDFRawStream,
  type PDFContext
} from 'pdf-lib';
import { translate } from '../i18n';

export interface PredictorParams {
  /** 1 = none, 2 = TIFF, 10–15 = PNG (the per-row tag picks the real filter). */
  predictor: number;
  /** Samples per pixel (`/Colors`, default 1). */
  colors: number;
  /** `/BitsPerComponent` of the predicted data (default 8). */
  bitsPerComponent: number;
  /** Pixels per row (`/Columns`, default 1). */
  columns: number;
}

function resolve(value: unknown, context: PDFContext): unknown {
  return value instanceof PDFRef ? context.lookup(value) : value;
}

function intOf(dict: PDFDict, key: string, fallback: number, context: PDFContext): number {
  const value = resolve(dict.get(PDFName.of(key)), context);
  return value instanceof PDFNumber ? value.asNumber() : fallback;
}

/** The predictor parameters in one filter's `/DecodeParms` dictionary. */
export function predictorParamsOf(
  parms: PDFDict | undefined,
  context: PDFContext
): PredictorParams {
  if (!parms) return { predictor: 1, colors: 1, bitsPerComponent: 8, columns: 1 };
  return {
    predictor: intOf(parms, 'Predictor', 1, context),
    colors: intOf(parms, 'Colors', 1, context),
    bitsPerComponent: intOf(parms, 'BitsPerComponent', 8, context),
    columns: intOf(parms, 'Columns', 1, context)
  };
}

function predictorError(detail: string): Error {
  return new Error(translate('its /Predictor data could not be undone ({detail})', { detail }));
}

/**
 * Undoes a TIFF (2) or PNG (10–15) predictor. Predictor 1 (or absent) returns
 * the input. Throws on anything else, or on parameters no real image has.
 */
export function undoPredictor(data: Uint8Array, params: PredictorParams): Uint8Array {
  const { predictor, colors, bitsPerComponent: bpc, columns } = params;
  if (predictor <= 1) return data;
  if (![1, 2, 4, 8, 16].includes(bpc)) {
    throw predictorError(translate('bits per component {bpc}', { bpc }));
  }
  if (!(Number.isInteger(colors) && colors >= 1 && colors <= 32)) {
    throw predictorError(translate('{colors} colours per pixel', { colors }));
  }
  if (!(Number.isInteger(columns) && columns >= 1)) {
    throw predictorError(translate('{columns} columns', { columns }));
  }
  const rowBytes = Math.ceil((colors * bpc * columns) / 8);
  if (predictor === 2) return undoTiffPredictor(data, rowBytes, colors, bpc);
  if (predictor >= 10 && predictor <= 15) {
    return undoPngPredictor(data, rowBytes, Math.max(1, Math.ceil((colors * bpc) / 8)));
  }
  throw predictorError(translate('predictor {predictor}', { predictor }));
}

/** PNG row filters (RFC 2083 §6): each row is a tag byte then `rowBytes` filtered bytes. */
function undoPngPredictor(data: Uint8Array, rowBytes: number, bpp: number): Uint8Array {
  const stride = rowBytes + 1;
  const rows = Math.ceil(data.length / stride);
  const out = new Uint8Array(rows * rowBytes);
  let written = 0;
  for (let r = 0; r < rows; r++) {
    const src = r * stride;
    const tag = data[src];
    // A short last row (a truncated stream) is decoded as far as it goes.
    const length = Math.min(rowBytes, data.length - src - 1);
    if (length <= 0) break;
    const row = written;
    const prev = row - rowBytes; // the row above, already reconstructed
    for (let i = 0; i < length; i++) {
      const x = data[src + 1 + i];
      const left = i >= bpp ? out[row + i - bpp] : 0;
      const up = r > 0 ? out[prev + i] : 0;
      const upLeft = r > 0 && i >= bpp ? out[prev + i - bpp] : 0;
      let value: number;
      switch (tag) {
        case 0:
          value = x;
          break;
        case 1:
          value = x + left;
          break;
        case 2:
          value = x + up;
          break;
        case 3:
          value = x + ((left + up) >> 1);
          break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          value = x + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
          break;
        }
        default:
          throw predictorError(translate('row {row} has filter type {tag}', { row: r + 1, tag }));
      }
      out[row + i] = value & 0xff;
    }
    written += length;
  }
  return written === out.length ? out : out.slice(0, written);
}

/** TIFF predictor 2: each sample is stored as its difference from the same sample one pixel left. */
function undoTiffPredictor(
  data: Uint8Array,
  rowBytes: number,
  colors: number,
  bpc: number
): Uint8Array {
  const out = new Uint8Array(data);
  const rows = Math.floor(out.length / rowBytes);
  for (let r = 0; r < rows; r++) {
    const start = r * rowBytes;
    if (bpc === 8) {
      for (let i = colors; i < rowBytes; i++) {
        out[start + i] = (out[start + i] + out[start + i - colors]) & 0xff;
      }
    } else if (bpc === 16) {
      const step = colors * 2;
      for (let i = step; i + 1 < rowBytes; i += 2) {
        const sum =
          ((out[start + i] << 8) | out[start + i + 1]) +
          ((out[start + i - step] << 8) | out[start + i - step + 1]);
        out[start + i] = (sum >> 8) & 0xff;
        out[start + i + 1] = sum & 0xff;
      }
    } else {
      // 1, 2 or 4 bits: walk the row sample by sample, MSB first.
      const mask = (1 << bpc) - 1;
      const samples = Math.floor((rowBytes * 8) / bpc);
      const get = (k: number) => {
        const bit = k * bpc;
        return (out[start + (bit >> 3)] >> (8 - bpc - (bit & 7))) & mask;
      };
      const set = (k: number, v: number) => {
        const bit = k * bpc;
        const shift = 8 - bpc - (bit & 7);
        const at = start + (bit >> 3);
        out[at] = (out[at] & ~(mask << shift)) | ((v & mask) << shift);
      };
      for (let k = colors; k < samples; k++) set(k, get(k) + get(k - colors));
    }
  }
  return out;
}

/** pdf-lib knows only the long filter names; inline-image abbreviations also turn up in streams. */
const LONG_FILTER_NAME: Readonly<Record<string, string>> = {
  Fl: 'FlateDecode',
  LZW: 'LZWDecode',
  A85: 'ASCII85Decode',
  AHx: 'ASCIIHexDecode',
  RL: 'RunLengthDecode'
};

/** The filter names of a stream dictionary, in order, abbreviations expanded. */
function filterNames(dict: PDFDict, context: PDFContext): PDFName[] {
  const value = resolve(dict.get(PDFName.of('Filter')), context);
  if (value instanceof PDFName) return [longName(value)];
  if (value instanceof PDFArray) {
    return value.asArray().map(entry => {
      const name = resolve(entry, context);
      if (!(name instanceof PDFName)) throw new Error(translate('a malformed /Filter array'));
      return longName(name);
    });
  }
  if (value !== undefined) throw new Error(translate('a malformed /Filter entry'));
  return [];
}

function longName(name: PDFName): PDFName {
  const long = LONG_FILTER_NAME[name.asString().slice(1)];
  return long ? PDFName.of(long) : name;
}

/**
 * The `/DecodeParms` for each filter of the chain (undefined where none). A
 * single dictionary for a one-filter chain is the normal form; a single
 * dictionary for a longer chain cannot be matched to a filter, so it is
 * accepted only when it carries no predictor.
 */
function parmsPerFilter(
  dict: PDFDict,
  count: number,
  context: PDFContext
): (PDFDict | undefined)[] {
  const value = resolve(dict.get(PDFName.of('DecodeParms')), context);
  const out: (PDFDict | undefined)[] = new Array<PDFDict | undefined>(count).fill(undefined);
  if (value instanceof PDFDict) {
    if (count === 1) out[0] = value;
    else if (predictorParamsOf(value, context).predictor > 1) {
      throw new Error(translate('one /DecodeParms dictionary for several filters'));
    }
  } else if (value instanceof PDFArray) {
    for (let i = 0; i < Math.min(count, value.size()); i++) {
      const entry = resolve(value.get(i), context);
      if (entry instanceof PDFDict) out[i] = entry;
    }
  }
  return out;
}

/**
 * A stream's bytes after its first `upTo` filters (all of them by default),
 * with every Flate/LZW predictor undone. `upTo` lets a caller stop before an
 * image codec (`[/FlateDecode /DCTDecode]` → the JPEG's own bytes). Throws when
 * a filter or predictor cannot be undone.
 */
export function decodeStreamBytes(stream: PDFRawStream, upTo?: number): Uint8Array {
  const context = stream.dict.context;
  const filters = filterNames(stream.dict, context);
  const end = Math.min(upTo ?? filters.length, filters.length);
  if (end === 0) return stream.getContents();
  const parms = parmsPerFilter(stream.dict, filters.length, context);
  let bytes = stream.contents;
  for (let i = 0; i < end; i++) {
    const step = PDFDict.withContext(context);
    step.set(PDFName.of('Filter'), filters[i]);
    if (parms[i]) step.set(PDFName.of('DecodeParms'), parms[i] as PDFDict);
    // Only the first step sees the raw (possibly encrypted) bytes.
    bytes = decodePDFRawStream(
      PDFRawStream.of(step, bytes, i === 0 ? stream.transform : undefined)
    ).decode();
    const name = filters[i].asString();
    if (name === '/FlateDecode' || name === '/LZWDecode') {
      bytes = undoPredictor(bytes, predictorParamsOf(parms[i], context));
    }
  }
  return bytes;
}
