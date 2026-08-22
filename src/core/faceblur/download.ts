/**
 * RED-08 — the *only* place in this feature that touches the network.
 *
 * Isolating it is the point. `detect.ts` runs the model and cannot fetch;
 * `runFaceBlur.ts` sequences the operation and cannot fetch; this file fetches
 * two pinned URLs and does nothing else. Auditing "what can Stapler request?"
 * means reading this file and `ocr/model.ts`, and nothing more.
 *
 * The cache is checked before anything is requested, so the download really
 * does happen once: a second run reads the same bytes back out of OPFS with the
 * network untouched.
 */
import { readFaceModelFile, writeFaceModelFile } from '../opfs';
import { cancelled, internal } from '../errors';
import type { FaceModelWeights, WeightManifest } from './detect';
import { MANIFEST_FILE, resolveManifestUrl, resolveShardUrl } from './model';

export interface DownloadOptions {
  signal?: AbortSignal;
  onProgress?: (fraction: number, label: string) => void;
}

/**
 * A shard bigger than this is not the file we pinned, and is not going into
 * OPFS. The real one is 193,321 bytes; the ceiling is deliberately loose enough
 * to survive a patch release of the same model and tight enough that a wrong
 * URL (or a captive-portal login page) is caught rather than cached forever.
 */
const MAX_SHARD_BYTES = 4 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;

/**
 * Returns the detector weights, from the local cache when they are there and
 * from the pinned CDN URL otherwise.
 *
 * Callers must have taken consent already — this function does not ask. That
 * split is deliberate: a function that both asks and fetches is one refactor
 * away from a function that fetches without asking.
 */
export async function ensureFaceModelWeights(
  options: DownloadOptions = {}
): Promise<FaceModelWeights> {
  const cached = await readCachedWeights();
  if (cached) {
    options.onProgress?.(1, 'Face detector ready');
    return cached;
  }

  options.onProgress?.(0.05, 'Downloading the face detector');
  const manifestBytes = await fetchBinary(resolveManifestUrl(), MAX_MANIFEST_BYTES, options);

  const manifest = parseManifest(manifestBytes);
  const shardPath = shardPathOf(manifest);

  options.onProgress?.(0.4, 'Downloading the face detector');
  const shard = await fetchBinary(resolveShardUrl(shardPath), MAX_SHARD_BYTES, options);

  // Written only after both files are in hand, so a half-finished download
  // cannot leave a cache that looks complete and loads as a broken network.
  options.onProgress?.(0.9, 'Saving the face detector');
  await writeFaceModelFile(MANIFEST_FILE, manifestBytes);
  await writeFaceModelFile(shardPath, shard);

  options.onProgress?.(1, 'Face detector ready');
  return { manifest, shard };
}

/** True when both files are already cached, so no request would be made. */
export async function hasCachedFaceModel(): Promise<boolean> {
  return (await readCachedWeights()) !== null;
}

async function readCachedWeights(): Promise<FaceModelWeights | null> {
  const manifestBytes = await readFaceModelFile(MANIFEST_FILE);
  if (!manifestBytes) return null;
  let manifest: WeightManifest;
  let shardPath: string;
  try {
    manifest = parseManifest(manifestBytes);
    shardPath = shardPathOf(manifest);
  } catch {
    // A corrupt cache is not an error the user can act on — it is treated as
    // "not downloaded", which puts the consent dialog back in front of them
    // rather than failing the run.
    return null;
  }
  const shard = await readFaceModelFile(shardPath);
  if (!shard) return null;
  return { manifest, shard };
}

function parseManifest(bytes: Uint8Array): WeightManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw internal('The face-detector weight manifest could not be read as JSON.');
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw internal('The face-detector weight manifest was not in the expected format.');
  }
  for (const group of parsed) {
    const entry = group as { paths?: unknown; weights?: unknown };
    if (!Array.isArray(entry.paths) || !Array.isArray(entry.weights)) {
      throw internal('The face-detector weight manifest was not in the expected format.');
    }
  }
  return parsed as WeightManifest;
}

/**
 * The single shard the manifest names.
 *
 * `tinyFaceDetector` publishes one group with one path. More than one would
 * mean the pinned model changed shape under us, which is exactly the situation
 * the version pin exists to prevent — so it is refused rather than guessed at.
 */
function shardPathOf(manifest: WeightManifest): string {
  const paths = manifest.flatMap(group => group.paths);
  if (paths.length !== 1) {
    throw internal(
      `The face-detector weight manifest names ${paths.length} weight files; Stapler expects exactly one.`
    );
  }
  return paths[0];
}

async function fetchBinary(
  url: string,
  maxBytes: number,
  options: DownloadOptions
): Promise<Uint8Array> {
  if (options.signal?.aborted) throw cancelled();

  let response: Response;
  try {
    response = await fetch(url, { signal: options.signal, cache: 'force-cache' });
  } catch (err) {
    if (options.signal?.aborted) throw cancelled();
    throw internal(
      `The face detector could not be downloaded: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!response.ok) {
    throw internal(
      `The face detector could not be downloaded (${response.status} ${response.statusText}).`
    );
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
    throw internal(
      `The face detector download was ${bytes.byteLength} bytes, which is not the pinned file. Nothing was saved.`
    );
  }
  return bytes;
}
