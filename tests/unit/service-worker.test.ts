import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * `runtime.getContexts` only exists in Firefox 127+ (our manifest's
 * `strict_min_version` is 109.0), so the service worker must not assume it is
 * present. Before this test existed, an older Firefox threw inside
 * `openEditor()`, was swallowed by the top-level `.catch`, and the toolbar
 * button silently did nothing.
 *
 * `chrome.action.onClicked.addListener` runs at module import time, so each
 * test rebuilds the `chrome` global and re-imports the module fresh.
 */

// Minimal shape of the one chrome.* surface service-worker.ts touches;
// `as unknown as typeof chrome` below stands in for the rest of the real API.
interface ChromeMock {
  action: { onClicked: { addListener: (fn: () => void | Promise<void>) => void } };
  runtime: {
    getURL: (path: string) => string;
    getContexts?: (filter: unknown) => Promise<Array<{ tabId?: number; windowId?: number }>>;
    onInstalled: { addListener: (fn: (details: { reason: string }) => void) => void };
  };
  tabs: {
    update: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  windows: {
    update: ReturnType<typeof vi.fn>;
  };
}

let clickListener: (() => void | Promise<void>) | undefined;
let chromeMock: ChromeMock;

function installChromeMock(getContexts: ChromeMock['runtime']['getContexts']): void {
  clickListener = undefined;
  chromeMock = {
    action: {
      onClicked: {
        addListener: fn => {
          clickListener = fn;
        }
      }
    },
    runtime: {
      getURL: (path: string) => `chrome-extension://test-id/${path}`,
      getContexts,
      onInstalled: { addListener: () => {} }
    },
    tabs: {
      update: vi.fn().mockResolvedValue(undefined),
      create: vi.fn().mockResolvedValue(undefined)
    },
    windows: {
      update: vi.fn().mockResolvedValue(undefined)
    }
  };
  (globalThis as unknown as { chrome: typeof chrome }).chrome =
    chromeMock as unknown as typeof chrome;
}

async function loadServiceWorker(): Promise<void> {
  vi.resetModules();
  await import('../../src/background/service-worker');
}

describe('service worker: openEditor Firefox fallback', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    delete (globalThis as { chrome?: typeof chrome }).chrome;
  });

  test('focuses the existing tab via getContexts when it is available', async () => {
    installChromeMock(vi.fn().mockResolvedValue([{ tabId: 42, windowId: 7 }]));
    await loadServiceWorker();

    await clickListener?.();

    expect(chromeMock.runtime.getContexts).toHaveBeenCalled();
    expect(chromeMock.tabs.update).toHaveBeenCalledWith(42, { active: true });
    expect(chromeMock.windows.update).toHaveBeenCalledWith(7, { focused: true });
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
  });

  test('opens a fresh tab when getContexts finds nothing', async () => {
    installChromeMock(vi.fn().mockResolvedValue([]));
    await loadServiceWorker();

    await clickListener?.();

    expect(chromeMock.tabs.create).toHaveBeenCalledWith({
      url: 'chrome-extension://test-id/editor.html'
    });
  });

  test('falls back to opening a fresh tab when getContexts does not exist (pre-127 Firefox)', async () => {
    installChromeMock(undefined);
    await loadServiceWorker();

    await clickListener?.();

    expect(chromeMock.tabs.create).toHaveBeenCalledWith({
      url: 'chrome-extension://test-id/editor.html'
    });
    expect(chromeMock.tabs.update).not.toHaveBeenCalled();
  });
});
