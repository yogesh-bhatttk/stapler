import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * `runtime.getContexts` only exists in Firefox 127+. The manifests' floors
 * are now above that (`scripts/browser-floors.mjs`), but a sideloaded install
 * on an older browser ignores them, so the service worker must not assume it
 * is present. Before this test existed, an older Firefox threw inside
 * `openEditor()`, was swallowed by the top-level `.catch`, and the toolbar
 * button silently did nothing.
 *
 * `chrome.action.onClicked.addListener` runs at module import time, so each
 * test rebuilds the `chrome` global and re-imports the module fresh.
 */

// Minimal shape of the one chrome.* surface service-worker.ts touches;
// `as unknown as typeof chrome` below stands in for the rest of the real API.
type InstalledDetails = { reason: string; previousVersion?: string };
type SuggestFn = (suggestions: Array<{ content: string; description: string }>) => void;

interface ChromeMock {
  action: { onClicked: { addListener: (fn: () => void | Promise<void>) => void } };
  runtime: {
    getURL: (path: string) => string;
    getContexts?: (filter: unknown) => Promise<Array<{ tabId?: number; windowId?: number }>>;
    getManifest: () => { version: string };
    sendMessage: ReturnType<typeof vi.fn>;
    onInstalled: { addListener: (fn: (details: InstalledDetails) => unknown) => void };
  };
  omnibox: {
    setDefaultSuggestion: ReturnType<typeof vi.fn>;
    onInputChanged: { addListener: (fn: (text: string, suggest: SuggestFn) => void) => void };
    onInputEntered: {
      addListener: (fn: (text: string, disposition: string) => unknown) => void;
    };
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
let installedListener: ((details: InstalledDetails) => unknown) | undefined;
let inputChanged: ((text: string, suggest: SuggestFn) => void) | undefined;
let inputEntered: ((text: string, disposition: string) => unknown) | undefined;
let chromeMock: ChromeMock;

// GAP-7 — the "last shown" record lives in IndexedDB, which Node lacks; an
// in-memory stand-in keeps the gating observable.
const shownVersion = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock('../../src/background/whats-new-store', () => ({
  readShownVersion: async () => shownVersion.value,
  writeShownVersion: async (version: string) => {
    shownVersion.value = version;
  }
}));

function installChromeMock(
  getContexts: ChromeMock['runtime']['getContexts'],
  options: { version?: string; navigateReply?: unknown } = {}
): void {
  clickListener = undefined;
  installedListener = undefined;
  inputChanged = undefined;
  inputEntered = undefined;
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
      getManifest: () => ({ version: options.version ?? '0.2.1' }),
      sendMessage: vi.fn().mockResolvedValue(options.navigateReply),
      onInstalled: {
        addListener: fn => {
          installedListener = fn;
        }
      }
    },
    omnibox: {
      setDefaultSuggestion: vi.fn(),
      onInputChanged: {
        addListener: fn => {
          inputChanged = fn;
        }
      },
      onInputEntered: {
        addListener: fn => {
          inputEntered = fn;
        }
      }
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
      url: 'chrome-extension://test-id/editor.html',
      active: true
    });
  });

  test('falls back to opening a fresh tab when getContexts does not exist (pre-127 Firefox)', async () => {
    installChromeMock(undefined);
    await loadServiceWorker();

    await clickListener?.();

    expect(chromeMock.tabs.create).toHaveBeenCalledWith({
      url: 'chrome-extension://test-id/editor.html',
      active: true
    });
    expect(chromeMock.tabs.update).not.toHaveBeenCalled();
  });
});

describe('service worker: omnibox keyword (GAP-7)', () => {
  afterEach(() => {
    delete (globalThis as { chrome?: typeof chrome }).chrome;
  });

  test('suggests matching tools, XML-escaped for Chrome', async () => {
    installChromeMock(vi.fn().mockResolvedValue([]));
    await loadServiceWorker();

    expect(chromeMock.omnibox.setDefaultSuggestion).toHaveBeenCalled();
    const suggest = vi.fn();
    inputChanged?.('split', suggest);
    const suggestions = suggest.mock.calls[0][0] as Array<{ content: string; description: string }>;
    expect(suggestions[0].content).toBe('split');
    expect(suggestions[0].description).toContain('Split &amp; extract');
    expect(suggestions.length).toBeLessThanOrEqual(5);
  });

  test('opens a new editor tab at the matched tool when none is open', async () => {
    installChromeMock(vi.fn().mockResolvedValue([]));
    await loadServiceWorker();

    await inputEntered?.('compress', 'newForegroundTab');

    expect(chromeMock.tabs.create).toHaveBeenCalledWith({
      url: 'chrome-extension://test-id/editor.html#/tool/compress',
      active: true
    });
  });

  test('replaces the current tab for the "currentTab" disposition', async () => {
    installChromeMock(vi.fn().mockResolvedValue([]));
    await loadServiceWorker();

    await inputEntered?.('merge', 'currentTab');

    expect(chromeMock.tabs.update).toHaveBeenCalledWith({
      url: 'chrome-extension://test-id/editor.html#/tool/merge'
    });
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
  });

  test('switches an open editor tab in place when it acknowledges, keeping its documents', async () => {
    installChromeMock(vi.fn().mockResolvedValue([{ tabId: 42, windowId: 7 }]), {
      navigateReply: true
    });
    await loadServiceWorker();

    await inputEntered?.('sign', 'currentTab');

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'stapler:navigate',
      route: '/tool/sign',
      tabId: 42
    });
    // Focused, never re-navigated (a URL change could reload it).
    expect(chromeMock.tabs.update).toHaveBeenCalledTimes(1);
    expect(chromeMock.tabs.update).toHaveBeenCalledWith(42, { active: true });
    expect(chromeMock.windows.update).toHaveBeenCalledWith(7, { focused: true });
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
  });

  test('falls back to navigating the open tab when it does not answer', async () => {
    installChromeMock(vi.fn().mockResolvedValue([{ tabId: 42, windowId: 7 }]), {
      navigateReply: undefined
    });
    await loadServiceWorker();

    await inputEntered?.('sign', 'newForegroundTab');

    expect(chromeMock.tabs.update).toHaveBeenCalledWith(42, {
      url: 'chrome-extension://test-id/editor.html#/tool/sign'
    });
    expect(chromeMock.tabs.update).toHaveBeenCalledWith(42, { active: true });
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
  });

  test('an unmatched query opens Home rather than nothing', async () => {
    installChromeMock(vi.fn().mockResolvedValue([]));
    await loadServiceWorker();

    await inputEntered?.('zzzzqqqq', 'newForegroundTab');

    expect(chromeMock.tabs.create).toHaveBeenCalledWith({
      url: 'chrome-extension://test-id/editor.html#/',
      active: true
    });
  });
});

describe('service worker: What’s new on update (GAP-7)', () => {
  beforeEach(() => {
    shownVersion.value = undefined;
  });

  afterEach(() => {
    delete (globalThis as { chrome?: typeof chrome }).chrome;
  });

  const whatsNewUrl = 'chrome-extension://test-id/editor.html#/whats-new';

  test('opens once on an update to a version with notes, then never again for it', async () => {
    installChromeMock(vi.fn().mockResolvedValue([]), { version: '0.2.1' });
    await loadServiceWorker();

    await installedListener?.({ reason: 'update', previousVersion: '0.2.0' });
    expect(chromeMock.tabs.create).toHaveBeenCalledWith({ url: whatsNewUrl });
    expect(shownVersion.value).toBe('0.2.1');

    chromeMock.tabs.create.mockClear();
    await installedListener?.({ reason: 'update', previousVersion: '0.2.0' });
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
  });

  test('first install opens the welcome route, not What’s new', async () => {
    installChromeMock(vi.fn().mockResolvedValue([]));
    await loadServiceWorker();

    await installedListener?.({ reason: 'install' });
    expect(chromeMock.tabs.create).toHaveBeenCalledTimes(1);
    expect(chromeMock.tabs.create).toHaveBeenCalledWith({
      url: 'chrome-extension://test-id/editor.html#/welcome'
    });
    expect(shownVersion.value).toBeUndefined();
  });

  test('a reload with an unchanged version opens nothing', async () => {
    installChromeMock(vi.fn().mockResolvedValue([]), { version: '0.2.1' });
    await loadServiceWorker();

    await installedListener?.({ reason: 'update', previousVersion: '0.2.1' });
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
  });

  test('a version without release notes opens nothing', async () => {
    installChromeMock(vi.fn().mockResolvedValue([]), { version: '99.0.0' });
    await loadServiceWorker();

    await installedListener?.({ reason: 'update', previousVersion: '0.2.1' });
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
  });
});
