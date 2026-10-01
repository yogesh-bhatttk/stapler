/**
 * X-14 — progress labels and user-facing notes in `operations.ts` go through
 * `translate()`. The i18n coverage test only sees `t()`/`translate()` calls,
 * so a bare English literal handed to `onProgress`/`report` slips past it;
 * this scans for exactly that.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(__dirname, '../../src/core/operations.ts'), 'utf8');

describe('operations.ts progress labels (X-14)', () => {
  it('never passes a bare string or template literal as a progress label', () => {
    const offenders: string[] = [];
    // onProgress?.(fraction, 'Label') / onProgress(fraction, `Label ${x}`)
    const call = /(?:onProgress\??\.?\(|\breport\()([^;]*?)\);/gs;
    for (const match of source.matchAll(call)) {
      const args = match[1];
      if (/(^|,)\s*(['`])[A-Za-z]/.test(args)) {
        const line = source.slice(0, match.index).split('\n').length;
        offenders.push(`${line}: ${match[0].replace(/\s+/g, ' ').slice(0, 100)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
