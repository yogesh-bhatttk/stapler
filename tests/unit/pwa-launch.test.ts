import { describe, expect, it, vi } from 'vitest';
import {
  consumeLaunchQueue,
  type LaunchParamsLike,
  type LaunchedFiles
} from '../../src/platform/pwa/launch-queue';
import {
  SHARE_INBOX_CACHE,
  storeSharedFiles,
  takeSharedFiles,
  type CacheLike,
  type CacheStorageLike
} from '../../src/platform/pwa/share-inbox';
import {
  registerServiceWorker,
  type ContainerLike,
  type RegistrationLike,
  type WorkerLike
} from '../../src/platform/pwa/register';
import { CLIENT_READY_MESSAGE, SKIP_WAITING_MESSAGE } from '../../src/platform/pwa/sw-routing';
import {
  pendingExternalOpens,
  queueExternalOpen,
  takeExternalOpens
} from '../../src/core/external-open';

/**
 * GAP-2 — the page side of the installed web app: files launched through
 * `launchQueue`, files received from the share sheet, and the "new version"
 * hand-over. All against fakes; the e2e suite covers the real browser.
 */

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function fakeLaunchQueue() {
  let consumer: ((params: LaunchParamsLike) => void) | null = null;
  return {
    queue: { setConsumer: (fn: (params: LaunchParamsLike) => void) => (consumer = fn) },
    launch: (params: LaunchParamsLike) => consumer?.(params)
  };
}

const fileHandle = (file: File) => ({
  kind: 'file' as const,
  name: file.name,
  getFile: async () => file
});

describe('consumeLaunchQueue', () => {
  it('returns false when the browser has no launchQueue', () => {
    expect(consumeLaunchQueue({}, () => undefined)).toBe(false);
  });

  it('hands launched files, with writable handles, to the callback', async () => {
    const { queue, launch } = fakeLaunchQueue();
    const received: LaunchedFiles[] = [];
    expect(consumeLaunchQueue({ launchQueue: queue }, l => received.push(l))).toBe(true);

    const pdf = new File(['%PDF-1.7'], 'a.pdf', { type: 'application/pdf' });
    const png = new File(['png'], 'b.png', { type: 'image/png' });
    launch({ files: [fileHandle(pdf), fileHandle(png)] });
    await flush();

    expect(received).toHaveLength(1);
    expect(received[0].files).toEqual([pdf, png]);
    expect(received[0].handles.map(h => [h.name, h.writable, h.persistable])).toEqual([
      ['a.pdf', true, true],
      ['b.png', true, true]
    ]);
    expect(await received[0].handles[0].getFile()).toBe(pdf);
  });

  it('skips directories and unreadable handles, and ignores an empty launch', async () => {
    const { queue, launch } = fakeLaunchQueue();
    const onLaunch = vi.fn();
    consumeLaunchQueue({ launchQueue: queue }, onLaunch);

    launch({ files: [] });
    launch({});
    await flush();
    expect(onLaunch).not.toHaveBeenCalled();

    const ok = new File(['%PDF'], 'ok.pdf', { type: 'application/pdf' });
    launch({
      files: [
        { kind: 'directory' },
        { kind: 'file', getFile: () => Promise.reject(new Error('gone')) } as never,
        fileHandle(ok)
      ]
    });
    await flush();
    expect(onLaunch).toHaveBeenCalledTimes(1);
    expect((onLaunch.mock.calls[0][0] as LaunchedFiles).files).toEqual([ok]);
  });
});

function fakeCacheStorage() {
  const stores = new Map<string, Map<string, Response>>();
  const open = async (name: string): Promise<CacheLike> => {
    let store = stores.get(name);
    if (!store) stores.set(name, (store = new Map()));
    const entries = store;
    return {
      put: async (request, response) => void entries.set(request.url, response),
      match: async request => entries.get(request.url)?.clone(),
      keys: async () => [...entries.keys()].reverse().map(url => new Request(url)),
      delete: async request => entries.delete(request.url)
    };
  };
  const storage: CacheStorageLike = {
    open,
    has: async name => stores.has(name),
    delete: async name => stores.delete(name)
  };
  return { storage, stores };
}

describe('share inbox', () => {
  it('round-trips shared files in order, with names, types and dates, then empties itself', async () => {
    const { storage, stores } = fakeCacheStorage();
    const files = [
      new File(['%PDF-1.7 one'], 'Rapport été.pdf', {
        type: 'application/pdf',
        lastModified: 1_700_000_000_000
      }),
      new File(['jpeg'], 'photo.jpg', { type: 'image/jpeg', lastModified: 1_700_000_001_000 }),
      new File(['?'], 'untyped', { type: '' })
    ];
    expect(await storeSharedFiles(storage, 'https://stapler.app/', files, 42)).toBe(3);
    // Keyed under the app's own scope — never another origin.
    for (const url of stores.get(SHARE_INBOX_CACHE)!.keys()) {
      expect(url.startsWith('https://stapler.app/')).toBe(true);
    }

    const taken = await takeSharedFiles(storage);
    expect(taken.map(f => [f.name, f.type, f.lastModified])).toEqual([
      ['Rapport été.pdf', 'application/pdf', 1_700_000_000_000],
      ['photo.jpg', 'image/jpeg', 1_700_000_001_000],
      ['untyped', '', expect.any(Number)]
    ]);
    expect(await taken[0].text()).toBe('%PDF-1.7 one');
    expect(stores.has(SHARE_INBOX_CACHE)).toBe(false);
    expect(await takeSharedFiles(storage)).toEqual([]);
  });

  it('returns nothing when nothing was shared', async () => {
    const { storage, stores } = fakeCacheStorage();
    expect(await takeSharedFiles(storage)).toEqual([]);
    expect(stores.size).toBe(0);
  });
});

class FakeWorker implements WorkerLike {
  state = 'installing';
  messages: unknown[] = [];
  private listeners: (() => void)[] = [];
  postMessage(message: unknown) {
    this.messages.push(message);
  }
  addEventListener(_type: 'statechange', listener: () => void) {
    this.listeners.push(listener);
  }
  setState(state: string) {
    this.state = state;
    this.listeners.forEach(l => l());
  }
}

function fakeContainer(options: { controller: boolean; waiting?: FakeWorker }) {
  const updateListeners: (() => void)[] = [];
  const controllerListeners: (() => void)[] = [];
  const registration: RegistrationLike & { installing: FakeWorker | null } = {
    waiting: options.waiting ?? null,
    installing: null,
    addEventListener: (_type, listener) => void updateListeners.push(listener)
  };
  const controller = options.controller ? { postMessage: vi.fn() } : null;
  const container: ContainerLike = {
    controller,
    register: vi.fn(async () => registration),
    addEventListener: (_type, listener) => void controllerListeners.push(listener)
  };
  return {
    container,
    controller,
    registration,
    startUpdate(worker: FakeWorker) {
      registration.installing = worker;
      updateListeners.forEach(l => l());
    },
    controllerChange: () => controllerListeners.forEach(l => l())
  };
}

describe('registerServiceWorker', () => {
  it('registers the worker at the given URL and scope', async () => {
    const { container } = fakeContainer({ controller: false });
    await registerServiceWorker({
      container,
      url: '/sw.js',
      scope: '/',
      onUpdateReady: () => undefined,
      reload: () => undefined
    });
    expect(container.register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
  });

  it('does not offer a reload, or reload, on the first install', async () => {
    const fake = fakeContainer({ controller: false });
    const onUpdateReady = vi.fn();
    const reload = vi.fn();
    await registerServiceWorker({
      container: fake.container,
      url: '/sw.js',
      onUpdateReady,
      reload
    });
    const worker = new FakeWorker();
    fake.startUpdate(worker);
    worker.setState('installed');
    fake.controllerChange(); // clients.claim() on first activation
    expect(onUpdateReady).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('offers an installed update once, and reloads only after the user applies it', async () => {
    const fake = fakeContainer({ controller: true });
    const onUpdateReady = vi.fn();
    const reload = vi.fn();
    await registerServiceWorker({
      container: fake.container,
      url: '/sw.js',
      onUpdateReady,
      reload
    });

    const worker = new FakeWorker();
    fake.startUpdate(worker);
    worker.setState('installed');
    worker.setState('installed');
    expect(onUpdateReady).toHaveBeenCalledTimes(1);
    expect(worker.messages).toEqual([]);

    const apply = onUpdateReady.mock.calls[0][0] as () => void;
    apply();
    expect(worker.messages).toEqual([{ type: SKIP_WAITING_MESSAGE }]);
    fake.controllerChange();
    fake.controllerChange();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('tells a tab that did not apply the update that another tab did (PLT-4)', async () => {
    const fake = fakeContainer({ controller: true });
    const onUpdateReady = vi.fn();
    const reload = vi.fn();
    const onReplacedElsewhere = vi.fn();
    await registerServiceWorker({
      container: fake.container,
      url: '/sw.js',
      onUpdateReady,
      reload,
      onReplacedElsewhere
    });
    const worker = new FakeWorker();
    fake.startUpdate(worker);
    worker.setState('installed');
    // Another tab applied it: this one's controller changes without being asked.
    fake.controllerChange();
    fake.controllerChange();
    expect(onReplacedElsewhere).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
    expect(worker.messages).toEqual([]);
  });

  it('reloads a tab replaced from elsewhere when no handler is given', async () => {
    const fake = fakeContainer({ controller: true });
    const reload = vi.fn();
    await registerServiceWorker({
      container: fake.container,
      url: '/sw.js',
      onUpdateReady: () => undefined,
      reload
    });
    fake.controllerChange();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('a page first controlled by a fresh install is told of a later update', async () => {
    const fake = fakeContainer({ controller: false });
    const reload = vi.fn();
    const onReplacedElsewhere = vi.fn();
    await registerServiceWorker({
      container: fake.container,
      url: '/sw.js',
      onUpdateReady: () => undefined,
      reload,
      onReplacedElsewhere
    });
    fake.controllerChange(); // first install claims the page
    expect(onReplacedElsewhere).not.toHaveBeenCalled();
    fake.controllerChange(); // a later update applied in another tab
    expect(onReplacedElsewhere).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
  });

  it('tells the controlling worker the page has loaded, so it can drop a kept cache', async () => {
    const fake = fakeContainer({ controller: true });
    await registerServiceWorker({
      container: fake.container,
      url: '/sw.js',
      onUpdateReady: () => undefined,
      reload: () => undefined
    });
    expect(fake.controller?.postMessage).toHaveBeenCalledWith({ type: CLIENT_READY_MESSAGE });
  });

  it('offers a worker that was already waiting when the page loaded', async () => {
    const waiting = new FakeWorker();
    waiting.state = 'installed';
    const fake = fakeContainer({ controller: true, waiting });
    const onUpdateReady = vi.fn();
    await registerServiceWorker({
      container: fake.container,
      url: '/sw.js',
      onUpdateReady,
      reload: () => undefined
    });
    expect(onUpdateReady).toHaveBeenCalledTimes(1);
  });
});

describe('external-open queue', () => {
  it('queues non-empty requests in order and drains them once', () => {
    takeExternalOpens();
    const a = new File(['a'], 'a.pdf');
    const b = new File(['b'], 'b.pdf');
    queueExternalOpen({ files: [] });
    queueExternalOpen({ files: [a] });
    queueExternalOpen({ files: [b] });
    expect(pendingExternalOpens.value).toHaveLength(2);
    expect(takeExternalOpens().map(r => r.files[0].name)).toEqual(['a.pdf', 'b.pdf']);
    expect(takeExternalOpens()).toEqual([]);
  });
});
