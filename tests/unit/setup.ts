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

/*
 * The English plural forms, as production always has them (the main thread
 * loads `en.json` at start-up; every worker loads it with its locale — AUDIT
 * UI-8). Without them `tPlural` falls back to its key, the "other" form, and a
 * count of one would read "1 pages". Only the suffixed plural entries are
 * installed, so `translate()` of any plain key still returns the key itself,
 * exactly as before.
 */
{
  const { registerDictionary } = await import('../../src/core/i18n');
  const { default: en } = await import('../../src/core/i18n/locales/en.json');
  registerDictionary(
    'en',
    Object.fromEntries(
      Object.entries(en as Record<string, string>).filter(([key]) =>
        /_(zero|one|two|few|many|other)$/.test(key)
      )
    )
  );
}

if (typeof globalThis.crypto?.randomUUID !== 'function') {
  const { webcrypto } = await import('node:crypto');
  (globalThis as unknown as { crypto: Crypto }).crypto = webcrypto as unknown as Crypto;
}
