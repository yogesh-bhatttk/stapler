/**
 * Audit 2026-10-10 T6 — CMP-04's safety net, swept across the whole corpus.
 *
 * "Never emit output larger than the input on a compress operation" was
 * asserted on a handful of hand-picked documents. This runs the real
 * `planCompression` + `compressDocument` (the "Choose quality" path) at three
 * settings spanning the panel's sliders, and the real `compressToTargetSize`
 * (the "Aim for a size" path) at three targets, over every PDF in
 * `tests/fixtures`, through the real process and render workers in-process
 * (pdf.js + Skia standing in for OffscreenCanvas). Each output is measured:
 * `output.byteLength <= input.byteLength`, always — and when the original is
 * kept, it is the original bytes, unchanged.
 *
 * A document the pipeline refuses (encrypted, truncated, not a PDF) must
 * refuse with an error, never emit something; that is graded too.
 *
 * Runtime: fixtures over 10 MB are skipped here (none are in the corpus as
 * generated today; `heavy.pdf` is ~5.4 MB) — a larger file belongs to the
 * e2e/perf suites, where a real browser does the decoding. The target-size
 * sweep runs on the image-bearing fixtures only: on a text-only document every
 * rung is a no-op, which the quality sweep already covers.
 */
import { describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { installCanvasShims } from './helpers/node-canvas-shims';

vi.setConfig({ testTimeout: 240_000 });

vi.mock('comlink', () => ({
  expose: vi.fn(),
  transfer: vi.fn(value => value),
  proxy: vi.fn(value => value),
  releaseProxy: Symbol('releaseProxy')
}));
vi.mock('../../src/core/workers/pdfjs-setup', async () => {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return {
    pdfjsLib,
    openDocument: ({ data, password }: { data: Uint8Array; password?: string }) =>
      pdfjsLib.getDocument({ data, password, disableFontFace: true, verbosity: 0 })
  };
});
vi.mock('../../src/core/workers', async () => {
  const { processWorkerImpl } = await import('../../src/core/workers/process.worker');
  const { renderWorkerImpl } = await import('../../src/core/workers/render.worker');
  // `any`: stands in for the pool's `Comlink.Remote<T>` wrapper.
  const client = (impl: any) => ({
    lease: (fn: (api: any) => unknown) => fn(impl),
    pin: () => ({ lease: (fn: (api: any) => unknown) => fn(impl), release: () => {} })
  });
  // Comlink structured-clones arguments the caller does not transfer, so each
  // call gets its own copy — as it would across a real worker boundary.
  // `any`: forwards each method's own parameter list unchanged.
  const cloning = (impl: any) =>
    new Proxy(impl, {
      get: (target, key) => {
        const value = target[key];
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) =>
          value.apply(
            target,
            args.map(arg => (arg instanceof Uint8Array ? arg.slice() : arg))
          );
      }
    });
  return {
    processWorker: client(cloning(processWorkerImpl)),
    renderWorker: client(cloning(renderWorkerImpl))
  };
});

installCanvasShims();
const ops = await import('../../src/core/operations');
const { fromUnknown } = await import('../../src/core/errors');
const { BROKEN_PAGE_TREE_MESSAGE } = await import('../../src/core/pdf/load');
type ErrorKind = import('../../src/core/errors').ErrorKind;

const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));
const MAX_UNIT_BYTES = 10 * 1024 * 1024;

const all = readdirSync(FIXTURES)
  .filter(name => name.endsWith('.pdf'))
  .sort()
  .map(name => ({ name, size: statSync(path.join(FIXTURES, name)).size }));
const corpus = all.filter(f => f.size <= MAX_UNIT_BYTES).map(f => f.name);
const skipped = all.filter(f => f.size > MAX_UNIT_BYTES).map(f => f.name);

/** The "Choose quality" sliders: the low end, the default, and the high end. */
const SETTINGS = [
  { dpi: 72, quality: 0.4 },
  { dpi: 150, quality: 0.75 },
  { dpi: 300, quality: 0.95 }
];

function read(name: string): Uint8Array {
  return new Uint8Array(readFileSync(path.join(FIXTURES, name)));
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && Buffer.from(a).equals(Buffer.from(b));
}

/**
 * The fixtures that cannot be opened at all — a refusal is the right answer for
 * these and only these, and each must refuse with the typed error the UI can
 * explain. (Formerly the three truncated ones failed with a raw `TypeError`
 * from pdf-lib, "reading 'Pages'": pdf-lib parses a file cut off before its
 * trailer into a document with no catalog. The shared loader now refuses that
 * as `CorruptDocument` and points at Repair — audit 2026-10-10 F2.)
 */
const UNOPENABLE: Record<string, ErrorKind> = {
  'encrypted.pdf': 'Encrypted',
  'not-a-pdf.pdf': 'CorruptDocument',
  'truncated.pdf': 'CorruptDocument',
  'truncated-header-only.pdf': 'CorruptDocument',
  'truncated-mid-body.pdf': 'CorruptDocument'
};

/** Runs `attempt`; a typed refusal is acceptable, emitting a larger file is not. */
async function outputOrRefusal(
  name: string,
  attempt: () => Promise<{ bytes: Uint8Array; keptOriginal: boolean }>
): Promise<{ bytes: Uint8Array; keptOriginal: boolean } | 'refused'> {
  try {
    return await attempt();
  } catch (error) {
    // Any other fixture refusing would make this sweep vacuous for it.
    expect(UNOPENABLE[name], `${name} was refused: ${String(error)}`).toBeDefined();
    // A refusal must be an explained, typed error — never a crash.
    expect(error, `${name}: ${String(error)}`).not.toBeInstanceOf(TypeError);
    expect((error as { isStaplerError?: boolean }).isStaplerError, String(error)).toBe(true);
    const typed = fromUnknown(error);
    expect(typed.kind, `${name}: ${typed.message}`).toBe(UNOPENABLE[name]);
    expect(typed.message).not.toBe('');
    if (name.startsWith('truncated')) expect(typed.message).toBe(BROKEN_PAGE_TREE_MESSAGE);
    return 'refused';
  }
}

describe('CMP-04 sweep — refusals are typed', () => {
  it.each(Object.keys(UNOPENABLE))('%s: refused with the expected kind', async name => {
    const input = read(name);
    const outcome = await outputOrRefusal(name, async () => {
      const settings = SETTINGS[1];
      const report = await ops.planCompression(input, settings);
      return ops.compressDocument(input, settings, report);
    });
    expect(outcome).toBe('refused');
    // The "Aim for a size" path refuses the same way.
    const aimed = await outputOrRefusal(name, () =>
      ops.compressToTargetSize(input, Math.max(1, Math.floor(input.byteLength / 2)))
    );
    expect(aimed).toBe('refused');
  });
});

describe('CMP-04 sweep — the corpus is real', () => {
  it('has the fixtures this sweep claims to cover', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(20);
    expect(corpus).toEqual(
      expect.arrayContaining(['heavy.pdf', 'scanned_skewed.pdf', 'mixed-text-image.pdf'])
    );
    // Documented rather than silent: anything skipped for size is named.
    expect(skipped).toEqual([]);
  });
});

describe.each(SETTINGS)('CMP-04 sweep — choose quality at $dpi DPI, $quality', settings => {
  it.each(corpus)('%s: output is never larger than the input', async name => {
    const input = read(name);
    const outcome = await outputOrRefusal(name, async () => {
      const report = await ops.planCompression(input, settings);
      return ops.compressDocument(input, settings, report);
    });
    if (outcome === 'refused') return;
    expect(outcome.bytes.byteLength, name).toBeLessThanOrEqual(input.byteLength);
    if (outcome.keptOriginal) expect(sameBytes(outcome.bytes, input), name).toBe(true);
  });
});

/** Fixtures that carry images, where a target size has something to act on. */
const IMAGE_FIXTURES = corpus.filter(name =>
  /image|heavy|scanned|cmyk|mask|photo|colored|stencil|indexed|icc|jbig2|jpx|soft|pre-blended|color-key|separation|device-n|sub-byte/.test(
    name
  )
);

describe.each([
  { label: 'half the input', target: (n: number) => Math.floor(n / 2) },
  { label: 'a tenth of the input', target: (n: number) => Math.floor(n / 10) },
  { label: 'an unreachable 1 KB', target: () => 1_000 }
])('CMP-04 sweep — aim for $label', ({ target }) => {
  it.each(IMAGE_FIXTURES)('%s: output is never larger than the input', async name => {
    const input = read(name);
    const targetBytes = Math.max(1, target(input.byteLength));
    const outcome = await outputOrRefusal(name, async () => {
      const result = await ops.compressToTargetSize(input, targetBytes);
      // The result describes the bytes it returns, not a model of them.
      expect(result.achievedBytes).toBe(result.bytes.byteLength);
      if (result.reachedTarget) expect(result.bytes.byteLength).toBeLessThanOrEqual(targetBytes);
      return result;
    });
    if (outcome === 'refused') return;
    expect(outcome.bytes.byteLength, name).toBeLessThanOrEqual(input.byteLength);
    if (outcome.keptOriginal) expect(sameBytes(outcome.bytes, input), name).toBe(true);
  });
});
