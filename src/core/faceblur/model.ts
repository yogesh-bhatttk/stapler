/**
 * RED-08 — the face-detector weight catalogue, and the second (and last) URL
 * Stapler is ever allowed to fetch at runtime.
 *
 * PLAN §5.4 item 5 lists exactly two documented exceptions to the zero-network
 * invariant: OCR-01's language model (`src/core/ocr/model.ts`) and this one.
 * This file is deliberately the same shape as that one — same host, same
 * pin-an-exact-version rule, same `setModelBaseOverride` test seam — so the two
 * exceptions cannot drift into two different privacy stories.
 *
 * **Weights only.** The thing that *runs* the weights — `@vladmandic/face-api`
 * and the TensorFlow.js runtime it bundles — is a normal npm dependency,
 * code-split into a lazy chunk of our own bundle. That split is not an
 * optimisation, it is the rule: executable code fetched from a CDN is remote
 * code execution, which PLAN §5.4 item 2 forbids outright and which no amount
 * of user consent makes acceptable. It is the same line tesseract draws —
 * engine vendored, `.traineddata` fetched.
 *
 * The invariant hook (`.claude/hooks/check-invariants.mjs`) carves
 * `src/core/faceblur/` out of its `REMOTE_HOSTS` and network-API checks exactly
 * as it does `src/core/ocr/`, so the host is named in full here rather than
 * assembled from fragments to sneak past the scanner.
 */

/** Host the weights are fetched from. Named out loud in the confirmation dialog. */
export const MODEL_HOST = 'cdn.jsdelivr.net';

/**
 * Pinned to an exact package *version*, not a floating tag, for the same reason
 * `resolveModelBase` in `ocr/model.ts` pins `DATA_VERSION`: an unpinned CDN URL
 * is a remote dependency that can change under a build that has already shipped
 * and been audited, which is precisely what "download once, then fully offline"
 * is supposed to rule out.
 *
 * `MODEL_PACKAGE_VERSION` intentionally matches the `@vladmandic/face-api`
 * version in `package.json`. The bundled inference code and the fetched weights
 * are two halves of one artefact; letting them drift apart is how you get a
 * detector that silently returns nothing.
 */
const MODEL_PACKAGE = '@vladmandic/face-api';
const MODEL_PACKAGE_VERSION = '1.7.15';

/**
 * The weight-manifest file name. face-api's `tinyFaceDetector` publishes its
 * weights as a TensorFlow.js graph-model pair: a JSON manifest listing every
 * tensor's name, shape, dtype and uint8 quantisation parameters, plus one binary
 * shard the manifest names. Both are fetched; nothing else is.
 */
export const MANIFEST_FILE = 'tiny_face_detector_model-weights_manifest.json';

/**
 * Approximate total download, for the disclosure copy.
 *
 * Unlike OCR's estimate this one *is* measured: the same files ship inside the
 * installed `@vladmandic/face-api` package, so `tiny_face_detector_model.bin`
 * (193,321 bytes) plus the manifest (3,219 bytes) is 196,540 bytes. Rounded up
 * to 0.2 MB — erring high, because a disclosure that under-states a download is
 * worse than one that over-states it.
 */
export const APPROX_SIZE_MB = 0.2;

/**
 * Stable id for the consent flag and the OPFS cache key. Versioned, so bumping
 * `MODEL_PACKAGE_VERSION` to different weights re-asks rather than silently
 * serving a stale cache that no longer matches the bundled engine.
 */
export const FACE_MODEL_ID = `tiny_face_detector@${MODEL_PACKAGE_VERSION}`;

/** Shown in the panel and in the confirmation dialog. */
export const FACE_MODEL_LABEL = 'on-device face detector';

/**
 * Test seam. Point this at a local fixture directory and nothing in the face
 * blur path can reach the real CDN; `null` restores the pinned default.
 *
 * A module-level override rather than injected config, for the same reason
 * `ocr/model.ts` uses one: `runFaceBlur` is called from a panel handler with no
 * dependency-injection seam of its own, and this is the shape the repo's other
 * test seams already take.
 */
let baseOverride: string | null = null;

export function setModelBaseOverride(base: string | null): void {
  baseOverride = base;
}

export function getModelBaseOverride(): string | null {
  return baseOverride;
}

/** Directory the manifest and its shards are resolved against, no trailing slash. */
export function resolveModelBase(): string {
  if (baseOverride) return baseOverride.replace(/\/$/, '');
  return `https://${MODEL_HOST}/npm/${MODEL_PACKAGE}@${MODEL_PACKAGE_VERSION}/model`;
}

/**
 * The exact manifest URL that will be requested. Used by the confirmation copy
 * and by the tests that assert what is reachable, so the assertion is made
 * against the same string the fetch builds.
 */
export function resolveManifestUrl(): string {
  return `${resolveModelBase()}/${MANIFEST_FILE}`;
}

/**
 * A shard URL, from the relative path the manifest itself names.
 *
 * The path is taken from the manifest rather than hard-coded, because that is
 * what tfjs's own loader does — but it is *validated* first: a manifest is
 * remote data, and a `paths` entry of `../../../etc/passwd` or an absolute
 * `https://elsewhere.example/x` would turn one pinned download into a fetch of
 * the manifest author's choosing. Only a plain file name is accepted.
 */
export function resolveShardUrl(relativePath: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(relativePath) || relativePath.startsWith('.')) {
    throw new Error(
      `The face-detector weight manifest named a shard path Stapler will not fetch: ` +
        `"${relativePath}". Only a plain file name alongside the manifest is allowed.`
    );
  }
  return `${resolveModelBase()}/${relativePath}`;
}
