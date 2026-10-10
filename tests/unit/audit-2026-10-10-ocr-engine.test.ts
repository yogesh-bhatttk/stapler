/**
 * Audit 2026-10-10 CV12 — the OCR worker keeps one tesseract engine per run.
 *
 * It used to create (and tear down) an engine for every page, and raced only
 * `recognize` against cancellation, so a cancel during the multi-second engine
 * start was not seen and a late failure could surface unhandled. Exercised
 * against the real worker module with tesseract.js replaced by a fake engine.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('comlink', () => ({ expose: vi.fn(), transfer: vi.fn(v => v), proxy: vi.fn(v => v) }));
vi.mock('../../src/core/workers/network-guard', () => ({}));

const created: FakeEngine[] = [];
let startGate: Promise<void> = Promise.resolve();

class FakeEngine {
  terminated = 0;
  recognized = 0;
  recognize = vi.fn(async () => {
    this.recognized++;
    return { data: { text: 'hello', blocks: [] } };
  });
  terminate = vi.fn(async () => {
    this.terminated++;
  });
}

vi.mock('tesseract.js', () => ({
  OEM: { LSTM_ONLY: 1 },
  createWorker: vi.fn(async () => {
    await startGate;
    const engine = new FakeEngine();
    created.push(engine);
    return engine;
  })
}));

type Api = {
  recognizePage: (b: unknown, o: { lang: string }, job?: unknown) => Promise<unknown>;
};
let api: Api;
let hasWarmEngine: () => boolean;
let disposeEngine: () => Promise<void>;
let ENGINE_IDLE_MS: number;

beforeAll(async () => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.self = { location: { href: 'https://stapler.test/assets/ocr.worker.js' }, Worker: class {} };
  g.OffscreenCanvas = class {
    getContext() {
      return { drawImage() {} };
    }
  };
  const mod = await import('../../src/core/workers/ocr.worker');
  api = mod.__ocrWorkerForTests.api as unknown as Api;
  hasWarmEngine = mod.__ocrWorkerForTests.hasWarmEngine;
  disposeEngine = mod.__ocrWorkerForTests.disposeEngine;
  ENGINE_IDLE_MS = mod.ENGINE_IDLE_MS;
});

afterEach(async () => {
  vi.useRealTimers();
  await disposeEngine();
  created.length = 0;
  startGate = Promise.resolve();
});

const bitmap = () => ({ width: 10, height: 10, close() {} });
const job = (cancelled = () => false) => ({
  progress: vi.fn(async () => {}),
  cancelled: vi.fn(async () => cancelled())
});

describe('CV12 — one OCR engine per run', () => {
  it('starts one engine for three pages and ends it once the run goes idle', async () => {
    vi.useFakeTimers();
    for (let i = 0; i < 3; i++) await api.recognizePage(bitmap(), { lang: 'eng' }, job());
    expect(created).toHaveLength(1);
    expect(created[0].recognized).toBe(3);
    expect(created[0].terminated).toBe(0);
    expect(hasWarmEngine()).toBe(true);
    await vi.advanceTimersByTimeAsync(ENGINE_IDLE_MS + 10);
    expect(created[0].terminated).toBe(1);
    expect(hasWarmEngine()).toBe(false);
  });

  it('starts a new engine when the language changes, ending the old one', async () => {
    await api.recognizePage(bitmap(), { lang: 'eng' }, job());
    await api.recognizePage(bitmap(), { lang: 'hin' }, job());
    expect(created).toHaveLength(2);
    expect(created[0].terminated).toBe(1);
    expect(created[1].terminated).toBe(0);
  });

  it('sees a cancel during engine start-up, and terminates the engine when it does start', async () => {
    let release!: () => void;
    startGate = new Promise(resolve => (release = resolve));
    let cancelledNow = false;
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const run = api.recognizePage(
        bitmap(),
        { lang: 'eng' },
        job(() => cancelledNow)
      );
      cancelledNow = true;
      await expect(run).rejects.toThrow(/cancel/i);
      // The engine start was still pending when the call gave up.
      expect(created).toHaveLength(0);
      release();
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(created).toHaveLength(1);
      expect(created[0].terminated).toBe(1);
      expect(created[0].recognized).toBe(0);
      expect(hasWarmEngine()).toBe(false);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('terminates the engine when recognition fails, and starts fresh next time', async () => {
    await api.recognizePage(bitmap(), { lang: 'eng' }, job());
    created[0].recognize.mockRejectedValueOnce(new Error('engine crashed'));
    await expect(api.recognizePage(bitmap(), { lang: 'eng' }, job())).rejects.toThrow(
      'engine crashed'
    );
    expect(created[0].terminated).toBe(1);
    expect(hasWarmEngine()).toBe(false);
    await api.recognizePage(bitmap(), { lang: 'eng' }, job());
    expect(created).toHaveLength(2);
  });
});
