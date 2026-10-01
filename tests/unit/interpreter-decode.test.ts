/**
 * X-12 — `decodeStream` on a corrupt Flate stream must reject once, through
 * its own promise, and leave no unhandled rejections behind from the
 * DecompressionStream writer it does not await.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { zlibSync } from 'fflate';
import { decodeStream } from '../../src/core/pdf/interpreter';

describe('decodeStream', () => {
  const seen: unknown[] = [];
  const record = (reason: unknown) => seen.push(reason);
  afterEach(() => {
    process.off('unhandledRejection', record);
    seen.length = 0;
  });

  it('decodes a zlib stream', async () => {
    const source = new TextEncoder().encode('BT (hello) Tj ET');
    expect(new TextDecoder().decode(await decodeStream(zlibSync(source)))).toBe('BT (hello) Tj ET');
  });

  it('X-12: a corrupt stream rejects without unhandled writer rejections', async () => {
    process.on('unhandledRejection', record);
    const corrupt = new Uint8Array([0x78, 0x9c, 0xff, 0xff, 0xff, 0x00, 0x13, 0x37, 0x42]);
    await expect(decodeStream(corrupt)).rejects.toBeTruthy();
    // Unhandled rejections are reported after the microtask queue drains.
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(seen).toEqual([]);
  });
});
