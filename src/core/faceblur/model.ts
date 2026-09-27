/**
 * RED-08 — the face-detector weights, bundled.
 *
 * These used to be the second documented exception to the zero-network
 * invariant: a one-time, consented download of the `tinyFaceDetector` weight
 * manifest and shard from a CDN. That exception was never needed — the exact
 * same two files ship inside the installed `@vladmandic/face-api` package — and
 * downloading them meant trusting a remote manifest and a size check where a
 * redaction feature needs certainty (a tampered shard that detects nothing
 * makes face blur report "no faces found" and leave faces visible; audit
 * 2026-09-25 CNV-6 / PLT-8). So they are now part of the build, like the
 * engine that runs them: nothing is fetched, nothing is asked, and the bytes
 * the detector loads are the bytes that were audited at build time.
 *
 * The actual bytes live in `bundledWeights.ts` and are imported *dynamically*
 * from here, so the ~260 KB base64 data URI lands in a lazy chunk that only a
 * face-blur run loads — in practice the render worker's, since that is where
 * `loadBundledFaceModelWeights` is called from.
 */
import { internal } from '../errors';
import type { FaceModelWeights, WeightManifest } from './detect';

/**
 * The installed `@vladmandic/face-api` version the weights come from. Kept as a
 * constant so the test suite can assert it still matches `package.json`: the
 * bundled inference code and the bundled weights are two halves of one artefact.
 */
export const MODEL_PACKAGE_VERSION = '1.7.15';

/** The weight-manifest file name inside `@vladmandic/face-api/model/`. */
export const MANIFEST_FILE = 'tiny_face_detector_model-weights_manifest.json';

/** Shown in the panel copy. */
export const FACE_MODEL_LABEL = 'on-device face detector';

/**
 * Decodes the bundled weights into the `{ manifest, shard }` shape
 * `detect.ts`'s `loadFaceModel` takes, and sanity-checks them first.
 *
 * The checks are not integrity checks in the download sense — nothing here
 * came off the network — they are a build-time tripwire: a face-api upgrade
 * that reshapes the model (more than one shard, or a shard whose length no
 * longer matches the tensor shapes its manifest declares) fails loudly the
 * first time the detector loads instead of producing a detector that silently
 * finds nothing.
 */
export async function loadBundledFaceModelWeights(): Promise<FaceModelWeights> {
  const { BUNDLED_MANIFEST, BUNDLED_SHARD_DATA_URL } = await import('./bundledWeights');
  const manifest = validateManifest(BUNDLED_MANIFEST);
  const shard = dataUrlToBytes(BUNDLED_SHARD_DATA_URL);
  const expected = expectedShardBytes(manifest);
  if (expected !== shard.byteLength) {
    throw internal(
      `The bundled face-detector weights are ${shard.byteLength} bytes, but their manifest ` +
        `describes ${expected ?? 'an unknown number of'} bytes. This build is broken; face blur ` +
        'cannot run.'
    );
  }
  return { manifest, shard };
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',');
  if (!dataUrl.startsWith('data:') || comma < 0 || !dataUrl.slice(0, comma).endsWith(';base64')) {
    throw internal('The bundled face-detector weights are not a base64 data URI.');
  }
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function validateManifest(parsed: unknown): WeightManifest {
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw internal('The bundled face-detector weight manifest is not in the expected format.');
  }
  for (const group of parsed) {
    const entry = group as { paths?: unknown; weights?: unknown };
    if (!Array.isArray(entry.paths) || !Array.isArray(entry.weights)) {
      throw internal('The bundled face-detector weight manifest is not in the expected format.');
    }
  }
  const manifest = parsed as WeightManifest;
  const paths = manifest.flatMap(group => group.paths);
  if (paths.length !== 1) {
    throw internal(
      `The bundled face-detector weight manifest names ${paths.length} weight files; ` +
        'Stapler expects exactly one.'
    );
  }
  return manifest;
}

/** uint8/float32/int32/bool are the only dtypes a TF.js weight manifest can name. */
const DTYPE_BYTES: Record<string, number> = {
  uint8: 1,
  float32: 4,
  int32: 4,
  bool: 1,
  complex64: 8
};

/**
 * The exact byte length the manifest's own tensor shapes predict for the
 * shard, or `null` when a weight spec has a `shape`/`dtype` this cannot
 * account for.
 *
 * `tinyFaceDetector`'s manifest is *quantized*: every weight's logical `dtype`
 * reads `float32`, but what is actually in the shard — and what
 * `quantization.dtype` names — is one `uint8` byte per element. When present,
 * `quantization.dtype` is what describes the bytes and must win.
 */
export function expectedShardBytes(manifest: WeightManifest): number | null {
  let total = 0;
  for (const group of manifest) {
    for (const raw of group.weights) {
      const spec = raw as {
        shape?: unknown;
        dtype?: unknown;
        quantization?: { dtype?: unknown };
      };
      const effectiveDtype =
        typeof spec.quantization?.dtype === 'string' ? spec.quantization.dtype : spec.dtype;
      const bytesPerElement =
        typeof effectiveDtype === 'string' ? DTYPE_BYTES[effectiveDtype] : undefined;
      if (!Array.isArray(spec.shape) || bytesPerElement === undefined) return null;
      const elements = spec.shape.reduce(
        (a: number, b: unknown) => a * (typeof b === 'number' ? b : NaN),
        1
      );
      if (!Number.isFinite(elements)) return null;
      total += elements * bytesPerElement;
    }
  }
  return total;
}
