/**
 * A real 2D canvas and JPEG encoder for Node tests: `@napi-rs/canvas` (Skia),
 * resolved off pdfjs-dist's own optional dependency exactly as
 * `redaction-verify-images.test.ts` does, plus an `OffscreenCanvas` shim over
 * it with the one async method the production encoders call.
 */
import { createRequire } from 'node:module';

// `any`: @napi-rs/canvas is resolved dynamically off pdfjs-dist's optional
// dependency, so there are no types to import for it.
export const canvasLib: any = await import('@napi-rs/canvas').catch(() => {
  const require = createRequire(import.meta.url);
  return require(
    require.resolve('@napi-rs/canvas', { paths: [require.resolve('pdfjs-dist/package.json')] })
  );
});

export class NodeOffscreenCanvas {
  readonly canvas: any; // untyped — see canvasLib
  constructor(width: number, height: number) {
    this.canvas = canvasLib.createCanvas(Math.max(1, width), Math.max(1, height));
  }
  get width(): number {
    return this.canvas.width;
  }
  set width(value: number) {
    this.canvas.width = Math.max(1, value);
  }
  get height(): number {
    return this.canvas.height;
  }
  set height(value: number) {
    this.canvas.height = Math.max(1, value);
  }
  getContext(kind: string) {
    const ctx = this.canvas.getContext(kind);
    // `drawImage` of another shim canvas: hand Skia the real canvas inside it.
    const drawImage = ctx.drawImage.bind(ctx);
    ctx.drawImage = (source: unknown, ...rest: number[]) =>
      drawImage(source instanceof NodeOffscreenCanvas ? source.canvas : source, ...rest);
    return ctx;
  }
  async convertToBlob({ type = 'image/png', quality }: { type?: string; quality?: number } = {}) {
    const buffer: Buffer =
      type === 'image/jpeg'
        ? this.canvas.toBuffer('image/jpeg', Math.round((quality ?? 0.92) * 100))
        : this.canvas.toBuffer('image/png');
    return {
      arrayBuffer: async () =>
        buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
    };
  }
}

export function installOffscreenCanvas(): void {
  (globalThis as unknown as { OffscreenCanvas: unknown }).OffscreenCanvas = NodeOffscreenCanvas;
}

/** An RGBA frame drawn into a shim canvas, ready to use as a `drawImage` source. */
export function canvasFromRgba(data: Uint8ClampedArray, width: number, height: number) {
  const canvas = new NodeOffscreenCanvas(width, height);
  const ctx = canvas.canvas.getContext('2d');
  ctx.putImageData(new canvasLib.ImageData(new Uint8ClampedArray(data), width, height), 0, 0);
  return canvas;
}

/** A PNG/JPEG/WebP file decoded by Skia into a shim canvas. */
export async function canvasFromFile(bytes: Uint8Array) {
  const image = await canvasLib.loadImage(Buffer.from(bytes));
  const canvas = new NodeOffscreenCanvas(image.width, image.height);
  canvas.canvas.getContext('2d').drawImage(image, 0, 0);
  return canvas;
}
