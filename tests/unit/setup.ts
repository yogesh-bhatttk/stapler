/**
 * Minimal DOM shims for the pure modules under test.
 *
 * The pixel and geometry helpers take `ImageData`, which Node does not provide. A
 * 30-line stand-in is preferable to running these in jsdom: the functions touch
 * nothing else, and jsdom's own ImageData would still need a canvas.
 */
class NodeImageData implements ImageData {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  readonly colorSpace: PredefinedColorSpace = 'srgb';

  constructor(
    dataOrWidth: Uint8ClampedArray | number,
    widthOrHeight: number,
    maybeHeight?: number
  ) {
    if (typeof dataOrWidth === 'number') {
      this.width = dataOrWidth;
      this.height = widthOrHeight;
      this.data = new Uint8ClampedArray(this.width * this.height * 4);
    } else {
      this.data = dataOrWidth;
      this.width = widthOrHeight;
      this.height = maybeHeight ?? dataOrWidth.length / 4 / widthOrHeight;
    }
  }
}

if (typeof globalThis.ImageData === 'undefined') {
  (globalThis as unknown as { ImageData: typeof NodeImageData }).ImageData = NodeImageData;
}

if (typeof globalThis.crypto?.randomUUID !== 'function') {
  const { webcrypto } = await import('node:crypto');
  (globalThis as unknown as { crypto: Crypto }).crypto = webcrypto as unknown as Crypto;
}
