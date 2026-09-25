/**
 * RED-08 — the `tinyFaceDetector` weights, compiled into the bundle.
 *
 * `?url&inline` makes Vite embed the binary shard as a base64 `data:` URI at
 * build time (the same approach `process.worker.ts` takes for its vendored
 * Liberation Sans), so loading the weights involves no `fetch()` of any kind —
 * not even a same-origin one. The manifest is plain JSON and is imported as a
 * module. Only `model.ts` imports this file, and only dynamically, so these
 * bytes sit in a lazy chunk that nothing but a face-blur run ever loads.
 *
 * The files come straight out of the installed, lockfile-pinned
 * `@vladmandic/face-api` package — the same package whose JS runs them — so the
 * weights and the engine cannot drift apart.
 */
import manifest from '@vladmandic/face-api/model/tiny_face_detector_model-weights_manifest.json';
import shardDataUrl from '@vladmandic/face-api/model/tiny_face_detector_model.bin?url&inline';

export const BUNDLED_MANIFEST: unknown = manifest;
export const BUNDLED_SHARD_DATA_URL: string = shardDataUrl;
