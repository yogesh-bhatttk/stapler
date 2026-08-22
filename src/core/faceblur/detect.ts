/**
 * RED-08 — on-device face detection.
 *
 * The detector is `@vladmandic/face-api`'s `tinyFaceDetector`, running on the
 * TensorFlow.js runtime that library bundles. Both are ordinary npm
 * dependencies, code-split into a lazy chunk: the engine is *bundled*, and only
 * the ~196 KB of weights is fetched, once, after an explicit confirmation (see
 * `model.ts`). No pixel ever leaves the worker — there is no API to send one to.
 *
 * Everything here is deliberately arranged so the network-free, ML-free parts
 * can be tested on their own:
 *
 *  • `detectFaces` takes decoded pixels and returns unit-space rectangles. It
 *    knows nothing about PDFs, and nothing about where the weights came from.
 *  • `setFaceDetectorOverride` replaces the whole detector, so a test can drive
 *    the rest of the pipeline from a known, fixed answer.
 *  • The weights arrive as bytes the caller already has. This module never
 *    fetches; `download.ts` does that and nothing else.
 */
import type { UnitRect } from '../pdf/image-redaction';

export type DetectionKind = 'face' | 'logo';

/** A detected region in the image's own unit square, y upwards from bottom-left. */
export interface DetectedRegion extends UnitRect {
  kind: DetectionKind;
  /** 0..1 confidence, as reported by the detector. */
  score: number;
}

export interface RgbaImage {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
}

/** One `{paths, weights}` group of a TensorFlow.js weight manifest. */
export interface WeightManifestGroup {
  paths: string[];
  weights: unknown[];
}

export type WeightManifest = WeightManifestGroup[];

export interface FaceModelWeights {
  manifest: WeightManifest;
  /** The single binary shard the manifest names. */
  shard: Uint8Array;
}

export interface DetectFacesOptions {
  /**
   * Minimum confidence a detection needs before its region is blurred.
   *
   * The default is deliberately low. A false positive costs a mosaicked patch
   * of wallpaper; a false negative publishes somebody's face. When the two
   * errors are that asymmetric, the threshold belongs near the permissive end,
   * and the panel says as much.
   */
  minScore?: number;
  /**
   * Square edge the detector resizes its input to. Larger finds smaller faces
   * and costs roughly quadratically. 416 is face-api's own default.
   */
  inputSize?: 128 | 160 | 224 | 320 | 416 | 512 | 608;
}

export const DEFAULT_MIN_SCORE = 0.35;
export const DEFAULT_INPUT_SIZE = 416;

/**
 * Longest edge the raster is reduced to before detection.
 *
 * A 300 DPI A4 scan is ~2480×3508. As float32 RGB that is a 104 MB tensor, for
 * a network that immediately resizes its input to 416² anyway — so the large
 * tensor buys nothing but a memory spike well past NFR §5.1's budget. Boxes
 * come back in unit space, which is scale-free, so nothing downstream can tell
 * the difference.
 */
const MAX_DETECT_EDGE = 1024;

export type FaceDetector = (
  image: RgbaImage,
  options: DetectFacesOptions
) => Promise<DetectedRegion[]>;

/**
 * Test seam: replaces the real detector wholesale.
 *
 * The point is not to avoid slow inference (the unit suite runs the real
 * network against the real weights — see `tests/unit/faceblur.test.ts`). It is
 * that a test of the *pipeline* — coordinate mapping, encode-once, the consent
 * gate, the PDF substitution — needs a detector whose answer is a fixed,
 * known rectangle, so a pipeline failure cannot hide behind a model that simply
 * did not find anything.
 */
let detectorOverride: FaceDetector | null = null;

export function setFaceDetectorOverride(detector: FaceDetector | null): void {
  detectorOverride = detector;
}

export function getFaceDetectorOverride(): FaceDetector | null {
  return detectorOverride;
}

/* ------------------------------------------------------------------ *
 * The structural slice of `@vladmandic/face-api` this module uses.
 *
 * A local interface rather than the package's own types, for the reason
 * `ocr/devanagariFont.ts` takes the same approach with fontkit: the published
 * declarations re-export `@tensorflow/tfjs-core`'s types, and that package is
 * not installed (the runtime is bundled *inside* face-api's dist). Naming the
 * handful of members actually called keeps the dependency surface visible and
 * the build free of a types-only dependency on a second package.
 * ------------------------------------------------------------------ */

interface TfTensor {
  dispose(): void;
}

interface FaceApiEnv {
  getEnv(): unknown;
  setEnv(env: unknown): void;
}

interface FaceApiBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface FaceApiDetection {
  box: FaceApiBox;
  score: number;
}

interface FaceApiNet {
  isLoaded: boolean;
  loadFromWeightMap(weightMap: unknown): Promise<void>;
  dispose(): void;
}

interface FaceApiLike {
  tf: {
    setBackend(name: string): Promise<boolean>;
    ready(): Promise<void>;
    getBackend(): string;
    tensor3d(values: ArrayLike<number>, shape: [number, number, number], dtype: string): TfTensor;
    io: { decodeWeights(buffer: ArrayBuffer, specs: unknown[]): unknown };
  };
  env: FaceApiEnv;
  nets: { tinyFaceDetector: FaceApiNet };
  TinyFaceDetectorOptions: new (options: {
    inputSize?: number;
    scoreThreshold?: number;
  }) => unknown;
  detectAllFaces(input: unknown, options: unknown): Promise<FaceApiDetection[]>;
}

let modulePromise: Promise<FaceApiLike> | null = null;

/**
 * The browser ESM bundle is named explicitly rather than importing the bare
 * package, and the specifier is a literal so Vite can see it.
 *
 * The package's `main` is `dist/face-api.node.js`, which `require`s
 * `@tensorflow/tfjs-node` — a native addon that is neither installed nor
 * wanted. Naming the file keeps Vite, Vitest and tsc all resolving the same
 * artefact: the self-contained browser build with the TensorFlow.js runtime
 * inside it. Being a dynamic `import()`, that ~1.3 MB lands in a chunk of its
 * own that nothing loads until the user actually runs a blur.
 */
async function loadFaceApi(): Promise<FaceApiLike> {
  if (!modulePromise) {
    modulePromise = (async () => {
      const mod =
        (await import('@vladmandic/face-api/dist/face-api.esm.js')) as unknown as FaceApiLike;
      prepareEnvironment(mod);
      await selectBackend(mod);
      return mod;
    })().catch(err => {
      // A failed load must not be cached as a permanently broken module.
      modulePromise = null;
      throw err;
    });
  }
  return modulePromise;
}

/**
 * face-api decides at import time whether it is in a browser or in Node, and
 * refuses to work if it is neither. A Web Worker is neither: its detection
 * needs `window`, `document` and `HTMLImageElement`, none of which exist off
 * the main thread — so left alone the library throws "environment is not
 * defined" the first time anything touches it.
 *
 * The environment it actually needs on this path is almost empty: pixels arrive
 * as a tensor built here, so no canvas, image or video element is ever
 * constructed. The members below exist to satisfy the library's `instanceof`
 * checks and nothing else, and every one of them is a *local* object — in
 * particular `fetch` is not wired up, because this module must not be able to
 * make a request even by accident. `download.ts` owns the one request.
 */
function prepareEnvironment(faceapi: FaceApiLike): void {
  try {
    faceapi.env.getEnv();
    return; // Already initialised (a real browser main thread, or Node).
  } catch {
    // Not initialised — fall through and set one up.
  }

  class Unavailable {}
  const refuse = (): never => {
    throw new Error('Face detection in Stapler works from pixel data only.');
  };

  faceapi.env.setEnv({
    Canvas: typeof OffscreenCanvas === 'undefined' ? Unavailable : OffscreenCanvas,
    CanvasRenderingContext2D:
      typeof OffscreenCanvasRenderingContext2D === 'undefined'
        ? Unavailable
        : OffscreenCanvasRenderingContext2D,
    Image: Unavailable,
    ImageData: typeof ImageData === 'undefined' ? Unavailable : ImageData,
    Video: Unavailable,
    createCanvasElement: () =>
      typeof OffscreenCanvas === 'undefined' ? refuse() : new OffscreenCanvas(1, 1),
    createImageElement: refuse,
    createVideoElement: refuse,
    fetch: refuse,
    readFile: refuse
  });
}

/**
 * WebGL where it exists, plain JS everywhere else.
 *
 * The WASM backend is deliberately not tried: tfjs fetches its `.wasm` binaries
 * from a CDN at runtime unless a path is configured, which is exactly the
 * remote-code load PLAN §5.4 item 2 forbids. WebGL's shaders are compiled from
 * strings already in the bundle, and the CPU backend is pure JS, so both are
 * self-contained.
 */
async function selectBackend(faceapi: FaceApiLike): Promise<void> {
  for (const backend of ['webgl', 'cpu']) {
    try {
      if (await faceapi.tf.setBackend(backend)) {
        await faceapi.tf.ready();
        return;
      }
    } catch {
      // Try the next one; a headless or GPU-blocked context has no WebGL.
    }
  }
  throw new Error('No TensorFlow.js backend could be started for face detection.');
}

/**
 * Loads the weights into the detector network.
 *
 * Idempotent: the network is a module-level singleton in face-api, so a second
 * call with the same weights is a no-op rather than a second 196 KB of GPU
 * memory. `decodeWeights` is tfjs's own manifest reader, so the uint8
 * quantisation the manifest describes is undone exactly the way the library
 * that wrote it intended.
 */
export async function loadFaceModel(weights: FaceModelWeights): Promise<void> {
  const faceapi = await loadFaceApi();
  if (faceapi.nets.tinyFaceDetector.isLoaded) return;

  const specs = weights.manifest.flatMap(group => group.weights);
  const shard = weights.shard;
  const buffer = shard.buffer.slice(shard.byteOffset, shard.byteOffset + shard.byteLength);
  const weightMap = faceapi.tf.io.decodeWeights(buffer as ArrayBuffer, specs);
  await faceapi.nets.tinyFaceDetector.loadFromWeightMap(weightMap);
}

/** Frees the loaded network. Used between tests; harmless in production. */
export async function unloadFaceModel(): Promise<void> {
  if (!modulePromise) return;
  const faceapi = await modulePromise;
  if (faceapi.nets.tinyFaceDetector.isLoaded) faceapi.nets.tinyFaceDetector.dispose();
}

/**
 * Box-averages RGBA down to at most `MAX_DETECT_EDGE` on its longest side and
 * drops the alpha channel, producing the tightly packed RGB the tensor wants.
 *
 * Box averaging, not nearest-neighbour: dropping pixels aliases a face into
 * noise at these ratios, and a detector that misses a face is the failure this
 * whole feature exists to avoid.
 */
export function toDetectionRgb(image: RgbaImage): {
  rgb: Uint8Array;
  width: number;
  height: number;
} {
  const { rgba, width, height } = image;
  const longest = Math.max(width, height);
  const step = longest > MAX_DETECT_EDGE ? longest / MAX_DETECT_EDGE : 1;
  const outWidth = Math.max(1, Math.floor(width / step));
  const outHeight = Math.max(1, Math.floor(height / step));
  const rgb = new Uint8Array(outWidth * outHeight * 3);

  for (let y = 0; y < outHeight; y++) {
    const sy0 = Math.floor((y * height) / outHeight);
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * height) / outHeight));
    for (let x = 0; x < outWidth; x++) {
      const sx0 = Math.floor((x * width) / outWidth);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * width) / outWidth));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const p = (sy * width + sx) * 4;
          r += rgba[p];
          g += rgba[p + 1];
          b += rgba[p + 2];
          n += 1;
        }
      }
      const d = (y * outWidth + x) * 3;
      rgb[d] = Math.round(r / n);
      rgb[d + 1] = Math.round(g / n);
      rgb[d + 2] = Math.round(b / n);
    }
  }

  return { rgb, width: outWidth, height: outHeight };
}

/**
 * Runs the detector over one decoded image and returns the faces it found, in
 * the image's own unit square with y upwards — the same convention
 * `pixelateRects` and `paintRectsBlack` consume, so a box can be handed
 * straight from one to the other.
 *
 * `loadFaceModel` must have been called first, unless a detector override is
 * installed. That ordering is enforced by `runFaceBlur`, which will not reach
 * this function before consent has been given and the weights are in hand.
 */
export async function detectFaces(
  image: RgbaImage,
  options: DetectFacesOptions = {}
): Promise<DetectedRegion[]> {
  if (detectorOverride) return detectorOverride(image, options);

  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  const inputSize = options.inputSize ?? DEFAULT_INPUT_SIZE;
  const faceapi = await loadFaceApi();
  if (!faceapi.nets.tinyFaceDetector.isLoaded) {
    throw new Error('The face detector was asked to run before its weights were loaded.');
  }

  const { rgb, width, height } = toDetectionRgb(image);
  const input = faceapi.tf.tensor3d(rgb, [height, width, 3], 'float32');
  let detections: FaceApiDetection[];
  try {
    detections = await faceapi.detectAllFaces(
      input,
      new faceapi.TinyFaceDetectorOptions({ inputSize, scoreThreshold: minScore })
    );
  } finally {
    input.dispose();
  }

  return detections
    .filter(detection => detection.score >= minScore)
    .map(detection => {
      const { box } = detection;
      // Detector space is pixels from the top-left of the downscaled raster;
      // unit space is fractions from the bottom-left. Clamped, because the
      // network can and does report a box that runs a little off the edge.
      const x = clamp01(box.x / width);
      const right = clamp01((box.x + box.width) / width);
      const top = clamp01(box.y / height);
      const bottom = clamp01((box.y + box.height) / height);
      return {
        kind: 'face' as const,
        score: detection.score,
        x,
        y: 1 - bottom,
        width: Math.max(0, right - x),
        height: Math.max(0, bottom - top)
      };
    })
    .filter(region => region.width > 0 && region.height > 0);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
