/**
 * OCR-01 — the language-model catalogue and the one URL Stapler is ever allowed
 * to fetch at runtime.
 *
 * PLAN §5.4 item 5 makes the OCR *language model* one of two documented exceptions
 * to the zero-network invariant — the other is RED-08's face-detector weights in
 * `src/core/faceblur/model.ts`, which follows this file's shape deliberately: same
 * host, same pin-an-exact-version rule, same `setModelBaseOverride` test seam.
 * This file adds one thing that one does not — a hardcoded SHA-256 per language,
 * checked in `download.ts` against every byte actually received — because a
 * `.traineddata` file is loaded straight into the recognition engine with no
 * further parsing to catch a corrupted or substituted download, where the
 * face-detector's weight manifest at least gets a shape/size sanity check first.
 * Everything else OCR needs — the tesseract.js worker script and the WASM engine —
 * is vendored into the bundle by the `stapler:tesseract-assets` Vite plugin,
 * because engine code is remote code execution and no amount of user consent makes
 * that acceptable (PLAN §5.4 item 2).
 *
 * The actual `fetch()` call lives in `download.ts`, not here — this file only
 * resolves URLs and holds the pinned hashes, exactly as `faceblur/model.ts` holds
 * URLs while `faceblur/download.ts` does the one fetch. Auditing "what can OCR
 * request?" means reading this file and `download.ts`, and nothing else in
 * `src/core/ocr/`.
 *
 * The invariant hook (`.claude/hooks/check-invariants.mjs`) and `scripts/
 * check-invariants.mjs` both carve `src/core/ocr/` (and, identically,
 * `src/core/faceblur/`) out of their `REMOTE_HOSTS` check for `model.ts` and
 * `download.ts` only — so the host can be named in full here instead of being
 * assembled to dodge the scanner — and out of their network-API check for those
 * two files plus `devanagariFont.ts`'s narrower, pre-existing, same-origin
 * `fetch()` of a bundled asset. A stray `fetch()` or remote-host reference
 * anywhere else in either directory still trips the guard.
 */

/** Host the model is fetched from. Named out loud in the confirmation dialog. */
export const MODEL_HOST = 'cdn.jsdelivr.net';

/**
 * Pinned to an exact package *version*, not just a path segment that merely looks
 * like one: `/npm/@tesseract.js-data/<lang>/4.0.0_best_int` (no `@<version>`)
 * resolves on jsdelivr to the *latest* published version of the `@tesseract.js-data/
 * <lang>` package, with `4.0.0_best_int` taken as a sub-path inside it — not a
 * version pin at all. `4.0.0_best_int` is tesseract.js's own name for the LSTM-only
 * ("best" integerised) data set, the one that matches `OEM.LSTM_ONLY` used by the
 * OCR worker, but it names a *directory inside the package*, not the package's own
 * version. `DATA_PACKAGE_VERSION` is the actual npm version pin; jsdelivr's scoped-
 * package syntax puts it right after the package name (`@tesseract.js-data/<lang>
 * @<version>`), before that sub-path.
 */
const DATA_PACKAGE = '@tesseract.js-data';
const DATA_PACKAGE_VERSION = '1.0.0';
const DATA_VERSION = '4.0.0_best_int';

/**
 * SHA-256 of the exact gzip bytes served at `resolveModelUrl(lang)` for each
 * pinned `DATA_PACKAGE_VERSION` — computed once, by hand, against the real file
 * (`curl` + `sha256sum` against the pinned URL), the same way a subresource-
 * integrity hash is produced for a `<script>` tag. `download.ts` verifies every
 * downloaded byte against this before the bytes are ever handed to tesseract;
 * a mismatch is refused outright rather than used. Keyed by the *component*
 * code (`eng`, `hin`), never by a composite (`eng+hin`) — a combined language is
 * always downloaded and verified as its separate components.
 *
 * A pinned npm version's published tarball is immutable, so this hash does not
 * need to be re-derived unless `DATA_PACKAGE_VERSION` changes.
 */
export const MODEL_SHA256: Readonly<Record<string, string>> = {
  eng: '45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91',
  hin: 'f3b6a0d320df38d886178cdd727b90dbf9df3db053adb32bd9cf73f0463cda07'
};

/**
 * Test seam for `MODEL_SHA256`, the same shape as `baseOverride` below: point it
 * at whatever hash a test fixture actually hashes to, so the integrity check in
 * `download.ts` can be exercised — both the success and the mismatch path —
 * without needing a real network download of the real, multi-megabyte file.
 */
let hashOverride: Readonly<Record<string, string>> | null = null;

export function setModelHashOverride(map: Readonly<Record<string, string>> | null): void {
  hashOverride = map;
}

/** The hash `download.ts` must see before it will use a downloaded model. */
export function expectedModelHash(lang: string): string | undefined {
  return (hashOverride ?? MODEL_SHA256)[lang];
}

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
  return `https://${MODEL_HOST}/npm/${DATA_PACKAGE}/${lang}@${DATA_PACKAGE_VERSION}/${DATA_VERSION}`;
}

/**
 * The exact URL that will be requested, gzip suffix included. Used by the
 * confirmation copy and by the E2E test that counts requests, so the assertion is
 * made against the same string the library builds.
 */
export function resolveModelUrl(lang: string): string {
  return `${resolveModelBase(lang)}/${lang}.traineddata.gz`;
}
