/**
 * Browser canvas shims for driving the *real* render worker in Node.
 *
 * pdf.js's legacy build renders through @napi-rs/canvas (its own optional
 * dependency); these stand in for `OffscreenCanvas`, `ImageBitmap` and
 * `createImageBitmap`, the three browser APIs the worker reaches for. Same
 * approach as `compress-encode-once.test.ts`, shared so new tests do not copy it.
 */

// `any` throughout: @napi-rs/canvas is resolved dynamically off pdfjs-dist's own
// optional dependency, so there are no types to import for it.
export const canvasLib: any = await import('@napi-rs/canvas').catch(async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  return require(
    require.resolve('@napi-rs/canvas', { paths: [require.resolve('pdfjs-dist/package.json')] })
  );
});

class NodeOffscreenCanvas {
  private canvas: any;
  constructor(width: number, height: number) {
    this.canvas = canvasLib.createCanvas(Math.max(1, width), Math.max(1, height));
  }
  get width() {
    return this.canvas.width;
  }
  set width(value: number) {
    this.canvas.width = Math.max(1, value);
  }
  get height() {
    return this.canvas.height;
  }
  set height(value: number) {
    this.canvas.height = Math.max(1, value);
  }
  getContext(kind: string) {
    return this.canvas.getContext(kind);
  }
  async convertToBlob({ type = 'image/png', quality }: { type?: string; quality?: number } = {}) {
    const buffer: Buffer =
      type === 'image/jpeg'
        ? this.canvas.toBuffer('image/jpeg', quality ?? 0.92)
        : this.canvas.toBuffer('image/png');
    return {
      arrayBuffer: async () =>
        buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
    };
  }
}

export function installCanvasShims(): void {
  const g = globalThis as any;
  if (typeof g.OffscreenCanvas === 'undefined') g.OffscreenCanvas = NodeOffscreenCanvas;
  if (typeof g.ImageBitmap === 'undefined') g.ImageBitmap = class ImageBitmap {};
  if (typeof g.createImageBitmap === 'undefined') {
    g.createImageBitmap = async (source: ImageData) => {
      const canvas = canvasLib.createCanvas(source.width, source.height);
      const ctx = canvas.getContext('2d');
      ctx.putImageData(
        new canvasLib.ImageData(new Uint8ClampedArray(source.data), source.width, source.height),
        0,
        0
      );
      canvas.close = () => undefined;
      return canvas;
    };
  }
}

/** Decodes PNG/JPEG bytes to RGBA through the same canvas library. */
export async function decodeToRgba(
  bytes: Uint8Array
): Promise<{ width: number; height: number; data: Uint8ClampedArray }> {
  const image = await canvasLib.loadImage(Buffer.from(bytes));
  const canvas = canvasLib.createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  const { data } = ctx.getImageData(0, 0, image.width, image.height);
  return { width: image.width, height: image.height, data };
}
