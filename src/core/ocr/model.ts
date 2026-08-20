/**
 * OCR-01 — the language-model catalogue and the one URL Stapler is ever allowed
 * to fetch at runtime.
 *
 * PLAN §5.4 item 5 makes the OCR *language model* the single documented exception
 * to the zero-network invariant. Everything else OCR needs — the tesseract.js
 * worker script and the WASM engine — is vendored into the bundle by the
 * `stapler:tesseract-assets` Vite plugin, because engine code is remote code
 * execution and no amount of user consent makes that acceptable (PLAN §5.4 item 2).
 *
 * The invariant hook (`.claude/hooks/check-invariants.mjs`) carves `src/core/ocr/`
 * out of its `REMOTE_HOSTS` check as well as its network-API check, so the host
 * can be named in full here instead of assembled to dodge the scanner.
 */

/** Host the model is fetched from. Named out loud in the confirmation dialog. */
export const MODEL_HOST = 'cdn.jsdelivr.net';

/**
 * Pinned to an exact package path rather than a floating tag: an unpinned CDN URL
 * is a remote dependency that can change under us between two runs of the same
 * build, which is the thing "download once, then fully offline" is supposed to rule
 * out. `4.0.0_best_int` is tesseract.js's own LSTM-only ("best" integerised) data
 * set — the one that matches `OEM.LSTM_ONLY`, which is what the OCR worker asks for.
 */
const DATA_PACKAGE = '@tesseract.js-data';
const DATA_VERSION = '4.0.0_best_int';

export interface OcrLanguage {
  /** tesseract language code, also the `<lang>.traineddata` file stem. */
  code: string;
  /** Shown in the panel and in the confirmation dialog. */
  label: string;
  /**
   * Approximate download size in MB, for the disclosure copy.
   *
   * This is an **estimate**, not a measurement: the file is not vendored, so there
   * is nothing local to stat, and measuring it would require the very network
   * request the dialog exists to ask permission for. ~12 MB is the published size
   * of `eng.traineddata` in the `4.0.0_best_int` set (gzipped in transit, and it is
   * the gzipped file that is fetched — so the real transfer is smaller than the
   * number shown). Erring high is deliberate: a disclosure that under-states a
   * download is worse than one that over-states it.
   */
  approxSizeMb: number;
}

/**
 * English and Hindi, each individually selectable, plus one composite entry for
 * a mixed Hindi/English ("Hinglish") page — the common case for a document
 * photographed on a phone rather than produced digitally. Composite codes are
 * the component codes joined with `+`, which is also the separator tesseract.js
 * itself uses for multi-language recognition, so `splitLangCodes` and the
 * library's own convention never disagree.
 */
export const OCR_LANGUAGES: readonly OcrLanguage[] = [
  { code: 'eng', label: 'English', approxSizeMb: 12 },
  { code: 'hin', label: 'Hindi', approxSizeMb: 2 },
  { code: 'eng+hin', label: 'English + Hindi (mixed)', approxSizeMb: 14 }
];

export const DEFAULT_OCR_LANGUAGE = 'eng';

export function findLanguage(code: string): OcrLanguage | undefined {
  return OCR_LANGUAGES.find(lang => lang.code === code);
}

/** `'eng+hin'` → `['eng', 'hin']`. A plain code splits to itself, one element. */
export function splitLangCodes(code: string): string[] {
  return code.split('+');
}

/**
 * Test seam. Point this at a local fixture and nothing in the OCR path can reach
 * the real CDN; `null` restores the pinned default.
 *
 * A module-level override rather than injected config because `runOcr` is called
 * from a commit handler that has no dependency-injection seam of its own, and the
 * repo's other test seams (`clearLog` in `core/errors.ts`) are the same shape.
 */
let baseOverride: string | null = null;

export function setModelBaseOverride(base: string | null): void {
  baseOverride = base;
}

export function getModelBaseOverride(): string | null {
  return baseOverride;
}

/**
 * Directory tesseract.js resolves `<lang>.traineddata.gz` against — this is what
 * goes into `langPath`, because that is what the library's `loadAndGunzipFile`
 * expects (it appends the filename itself).
 */
export function resolveModelBase(lang: string): string {
  if (baseOverride) return baseOverride.replace(/\/$/, '');
  return `https://${MODEL_HOST}/npm/${DATA_PACKAGE}/${lang}/${DATA_VERSION}`;
}

/**
 * The exact URL that will be requested, gzip suffix included. Used by the
 * confirmation copy and by the E2E test that counts requests, so the assertion is
 * made against the same string the library builds.
 */
export function resolveModelUrl(lang: string): string {
  return `${resolveModelBase(lang)}/${lang}.traineddata.gz`;
}
