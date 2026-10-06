/**
 * CNV-14 through the real `commitTool('image-to-size')`, with the worker call
 * (`resizeImageFile`) and the save dialog replaced by recorders: what request
 * the exact-size settings send, when the original is kept, and that a missed
 * target says by how much before anything is saved.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const saved: { name: string; bytes: Uint8Array }[] = [];
const confirmations: { title: string; body: string }[] = [];

vi.mock('comlink', () => ({
  expose: vi.fn(),
  transfer: vi.fn(value => value),
  proxy: vi.fn(v => v)
}));
vi.mock('../../src/platform/current', () => ({
  platform: {
    kind: 'web',
    supportsFileSystemAccess: false,
    saveFileAs: async (bytes: Uint8Array, name: string) => {
      saved.push({ name, bytes });
      return true;
    },
    openFiles: async () => [],
    openDirectory: async () => null,
    saveOver: async () => false,
    persistHandle: async () => {},
    restoreHandles: async () => [],
    reopenHandle: async () => null,
    revokeHandle: async () => {},
    readClipboardImage: async () => null
  }
}));
vi.mock('../../src/core/workers', () => {
  const unavailable = new Proxy(
    {},
    {
      get: () => () => {
        throw new Error('This test does not run that worker');
      }
    }
  );
  // `any`: stands in for the pool's `Comlink.Remote<T>` wrapper.
  const client = (impl: any) => ({
    lease: (fn: (api: any) => unknown) => fn(impl),
    pin: () => ({ lease: (fn: (api: any) => unknown) => fn(impl), release: () => {} })
  });
  return {
    processWorker: client(unavailable),
    renderWorker: client(unavailable),
    cvWorker: client(unavailable),
    ocrWorker: client(unavailable),
    convertWorker: client(unavailable),
    imageWorker: client(unavailable)
  };
});
vi.mock('../../src/core/notify', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/core/notify')>();
  return {
    ...actual,
    requestExportReview: async () => true,
    confirmAction: async (options: { title: string; body: string }) => {
      confirmations.push({ title: options.title, body: options.body });
      return false;
    }
  };
});
vi.mock('../../src/core/image', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/core/image')>();
  return { ...actual, resizeImageFile: vi.fn() };
});

const { commitTool } = await import('../../src/ui/tools/commit');
const { toasts } = await import('../../src/core/notify');
const { resizeImageFile } = await import('../../src/core/image');
const { DEFAULT_EXACT_SIZE, imageSizeResult, imageSizeSettings } =
  await import('../../src/ui/tools/image-size/state');

const png = new Uint8Array(readFileSync('tests/fixtures/sample.png')); // 240×160
const pngFile = () => new File([png], 'sample.png', { type: 'image/png' });

function resized(extra: Record<string, unknown>) {
  return {
    bytes: new Uint8Array(png.byteLength + 500),
    width: 240,
    height: 160,
    quality: 0.92,
    sourceWidth: 240,
    sourceHeight: 160,
    targetBytes: null,
    reached: true,
    attempts: 1,
    sourcePages: 1,
    sourceFrames: 1,
    ...extra
  };
}

function exactSettings(exact: Partial<typeof DEFAULT_EXACT_SIZE>, useTarget = false) {
  imageSizeSettings.value = {
    file: pngFile(),
    useTarget,
    target: { amount: 20, unit: 'KB' },
    maxDimension: 600,
    exact: { ...DEFAULT_EXACT_SIZE, on: true, ...exact }
  };
}

beforeEach(() => {
  saved.length = 0;
  confirmations.length = 0;
  toasts.value = [];
  imageSizeResult.value = null;
  vi.mocked(resizeImageFile).mockReset();
});

describe('CNV-14 — Image to size with an exact width × height', () => {
  it('sends the exact sides, not the longest-side box', async () => {
    exactSettings({ width: 1200, height: 800, lockAspect: false });
    vi.mocked(resizeImageFile).mockResolvedValueOnce(resized({ width: 1200, height: 800 }));
    await commitTool('image-to-size', {});
    expect(vi.mocked(resizeImageFile).mock.calls[0][1]).toEqual({
      targetBytes: null,
      maxDimension: null,
      width: 1200,
      height: 800
    });
    // The original is not that size, so it is converted even though the JPEG
    // is the bigger file — and the growth is said out loud.
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toBe('sample-1200x800.jpg');
    expect(imageSizeResult.value?.keptOriginal).toBe(false);
    expect(toasts.value.at(-1)?.detail).toMatch(/larger than the original/);
  });

  it('locked, sends only the side typed', async () => {
    exactSettings({ width: 300, height: 999, lockAspect: true, driver: 'width' });
    vi.mocked(resizeImageFile).mockResolvedValueOnce(resized({ width: 300, height: 200 }));
    await commitTool('image-to-size', {});
    expect(vi.mocked(resizeImageFile).mock.calls[0][1]).toMatchObject({
      width: 300,
      height: null,
      maxDimension: null
    });
    expect(saved[0].name).toBe('sample-300x200.jpg');
  });

  it('keeps the original when it already is the exact size asked for', async () => {
    exactSettings({ width: 240, height: 160, lockAspect: false });
    vi.mocked(resizeImageFile).mockResolvedValueOnce(resized({}));
    await commitTool('image-to-size', {});
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toBe('sample.png');
    expect(saved[0].bytes).toEqual(png);
    expect(imageSizeResult.value?.keptOriginal).toBe(true);
  });

  it('refuses to run without a usable side', async () => {
    exactSettings({});
    await commitTool('image-to-size', {});
    exactSettings({ width: 0 });
    await commitTool('image-to-size', {});
    expect(resizeImageFile).not.toHaveBeenCalled();
    expect(saved).toHaveLength(0);
    expect(toasts.value.map(t => t.title)).toEqual([
      'Enter a width or a height.',
      'Enter a whole number of pixels between 1 and 16384.'
    ]);
  });

  it('refuses an unlocked size past the area limit before running', async () => {
    exactSettings({ width: 16_384, height: 16_384, lockAspect: false });
    await commitTool('image-to-size', {});
    expect(resizeImageFile).not.toHaveBeenCalled();
    expect(saved).toHaveLength(0);
    expect(toasts.value.at(-1)?.title).toBe(
      '16384×16384 px is larger than the 67,108,864-pixel limit a browser can draw. Choose a smaller size.'
    );
  });

  it('refuses a locked side that would follow a panorama past the side limit', async () => {
    // A PNG header declaring 10 × 4000 (1:400): width 100 locked → 40000 high.
    const head = new Uint8Array(8 + 25 + 12);
    head.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    const view = new DataView(head.buffer);
    view.setUint32(8, 13);
    head.set([0x49, 0x48, 0x44, 0x52], 12);
    view.setUint32(16, 10);
    view.setUint32(20, 4000);
    head.set([0x49, 0x45, 0x4e, 0x44], 37);
    exactSettings({ width: 100, lockAspect: true, driver: 'width' });
    imageSizeSettings.value = {
      ...imageSizeSettings.value,
      file: new File([head], 'panorama.png', { type: 'image/png' })
    };
    await commitTool('image-to-size', {});
    expect(resizeImageFile).not.toHaveBeenCalled();
    expect(toasts.value.at(-1)?.title).toBe(
      '100×40000 px has a side longer than the 16,384 px a browser can draw. Choose a smaller size.'
    );
  });

  it('a missed target says by how much before saving', async () => {
    exactSettings({ width: 1200, height: 800, lockAspect: false }, true);
    vi.mocked(resizeImageFile).mockResolvedValueOnce(
      resized({
        width: 1200,
        height: 800,
        bytes: new Uint8Array(20_400),
        targetBytes: 20_000,
        reached: false,
        attempts: 6,
        quality: 0.3
      })
    );
    await commitTool('image-to-size', {});
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0].title).toBe('Could not reach 20 KB');
    expect(confirmations[0].body).toContain(
      '21 KB — 400 B over your 20 KB target — at 1200×800 px'
    );
    // Declined: nothing written.
    expect(saved).toHaveLength(0);
  });
});
