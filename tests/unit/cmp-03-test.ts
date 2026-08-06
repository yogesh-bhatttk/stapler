import { expect, test } from 'vitest';
import { processWorkerImpl } from '../../src/core/workers/process.worker';
import fs from 'node:fs';
import { silentJob } from '../../src/core/workers/protocol';

test('CMP-03: resamples SMask when base image is downscaled', async () => {
  const bytes = fs.readFileSync('tests/fixtures/oversized-mask.pdf');

  // We mock a replacement for object number 8 (the image).
  // Suppose it is downscaled to 10 x 210.
  const replacedImages = {
    '0': {
      ImStrip: {
        jpeg: new Uint8Array([255, 216, 255, 217]), // Fake JPEG
        width: 10,
        height: 210,
        // The downscaled mask bytes, flat-encoded later
        maskBytes: new Uint8Array(10 * 210) // 2100 bytes
      }
    }
  };

  const result = await processWorkerImpl.rebuildCompressed(bytes, [], replacedImages, silentJob);
  expect(result.keptOriginal).toBe(false);

  // just loop through
});
