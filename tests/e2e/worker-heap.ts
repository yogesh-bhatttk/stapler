import type { CDPSession, Page } from '@playwright/test';

/**
 * HRD-12 / NFR-03 — measures the JS heap of the page *and* of every worker it
 * spawns, through the Chrome DevTools Protocol.
 *
 * `performance.memory` reports the main realm only, and
 * `performance.measureUserAgentSpecificMemory()` needs cross-origin isolation
 * (COOP/COEP), which neither build sets. CDP has no such limit: the page's
 * session auto-attaches to each dedicated worker (render, process, convert, …),
 * each worker's session in turn auto-attaches to any worker *it* spawns (none
 * today: pdf.js runs its parser in-thread inside the render/process workers, so
 * parsed documents are counted in those workers' heaps — but a nested worker
 * added later is not silently missed), and `Runtime.getHeapUsage` is asked of
 * every one.
 *
 * Playwright's `CDPSession` cannot address a flattened child session, so this
 * uses the non-flattened form: commands to a child are wrapped in
 * `Target.sendMessageToTarget`, once per level of nesting, and replies arrive
 * wrapped in `Target.receivedMessageFromTarget`.
 *
 * Workers come and go (each idles out after 30 s, and the pool grows on demand),
 * so a sample covers whatever is alive at that moment; `sampleWhile` polls during
 * an operation and keeps the peak.
 */

interface WorkerTarget {
  /** Session ids from the page down to this worker. */
  path: string[];
  url: string;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/** One realm's memory, from `Runtime.getHeapUsage`. */
export interface RealmUsage {
  /** Script file name (hash stripped), or `main`. */
  name: string;
  /** Used V8 JS heap — what `performance.memory.usedJSHeapSize` reports. */
  used: number;
  /**
   * Memory the JS heap figure leaves out: ArrayBuffer backing stores (where
   * decoded pixels and PDF bytes actually sit) plus Blink's own heap.
   */
  external: number;
}

export interface HeapSample {
  main: RealmUsage;
  workers: RealmUsage[];
  /** Every realm's `used + external`, bytes. */
  total: number;
}

export interface HeapPeak {
  /** Highest main-realm V8 heap. */
  mainUsed: number;
  /** Highest V8 heap of any single worker, and which one. */
  workerUsed: number;
  workerName: string;
  /** Highest sum over live workers of `used + external` in one sample. */
  workersTotal: number;
  /** Highest sum over every realm of `used + external` in one sample. */
  total: number;
  /** Most workers alive in a single sample. */
  workerCount: number;
  samples: number;
}

interface HeapUsage {
  usedSize: number;
  embedderHeapUsedSize?: number;
  backingStorageSize?: number;
}

const shortName = (url: string) => url.replace(/^.*\//, '').replace(/-[\w-]{8}\.js$/, '.js');

const realm = (name: string, usage: HeapUsage): RealmUsage => ({
  name,
  used: usage.usedSize,
  external: (usage.embedderHeapUsedSize ?? 0) + (usage.backingStorageSize ?? 0)
});

const realmTotal = (r: RealmUsage) => r.used + r.external;

export const emptyPeak = (): HeapPeak => ({
  mainUsed: 0,
  workerUsed: 0,
  workerName: '',
  workersTotal: 0,
  total: 0,
  workerCount: 0,
  samples: 0
});

/** Folds `sample` into `peak` in place. */
export function recordPeak(peak: HeapPeak, sample: HeapSample): HeapPeak {
  peak.mainUsed = Math.max(peak.mainUsed, sample.main.used);
  for (const worker of sample.workers) {
    if (worker.used > peak.workerUsed) {
      peak.workerUsed = worker.used;
      peak.workerName = worker.name;
    }
  }
  peak.workersTotal = Math.max(
    peak.workersTotal,
    sample.workers.reduce((sum, w) => sum + realmTotal(w), 0)
  );
  peak.total = Math.max(peak.total, sample.total);
  peak.workerCount = Math.max(peak.workerCount, sample.workers.length);
  peak.samples++;
  return peak;
}

export class HeapProbe {
  private readonly targets = new Map<string, WorkerTarget>();
  private readonly pending = new Map<string, Pending>();
  private nextId = 1;

  private constructor(private readonly cdp: CDPSession) {}

  /** Attach before navigating, so no worker spawns unobserved. */
  static async attach(page: Page): Promise<HeapProbe> {
    const cdp = await page.context().newCDPSession(page);
    const probe = new HeapProbe(cdp);
    cdp.on('Target.attachedToTarget', event => probe.onAttached([], event));
    cdp.on('Target.detachedFromTarget', event => probe.onDetached([], event));
    cdp.on('Target.receivedMessageFromTarget', event => probe.onMessage([], event));
    await cdp.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: false
    });
    return probe;
  }

  /** Number of workers currently attached, at any depth. */
  get workerCount(): number {
    return this.targets.size;
  }

  /** Script names of the workers currently attached. */
  get workerNames(): string[] {
    return [...this.targets.values()].map(t => shortName(t.url));
  }

  async sample(): Promise<HeapSample> {
    const main = realm('main', await this.cdp.send('Runtime.getHeapUsage'));
    const live = [...this.targets.values()];
    const results = await Promise.all(
      live.map(async target => {
        try {
          const usage = (await this.sendTo(
            target.path,
            'Runtime.getHeapUsage',
            {},
            2_000
          )) as HeapUsage;
          return realm(shortName(target.url), usage);
        } catch {
          // Terminated between listing and asking — it holds no heap any more.
          return null;
        }
      })
    );
    const workers = results.filter((r): r is RealmUsage => r !== null);
    const total = workers.reduce((sum, w) => sum + realmTotal(w), realmTotal(main));
    return { main, workers, total };
  }

  /**
   * Samples every `intervalMs` until `operation` settles, folding each sample
   * into `peak` (a fresh one unless given), plus one sample after it settles.
   */
  async sampleWhile<T>(
    operation: () => Promise<T>,
    peak: HeapPeak = emptyPeak(),
    intervalMs = 150
  ): Promise<{ result: T; peak: HeapPeak }> {
    let done = false;
    const poller = (async () => {
      while (!done) {
        try {
          recordPeak(peak, await this.sample());
        } catch {
          // The page is navigating; the next tick samples again.
        }
        await new Promise(resolve => setTimeout(resolve, intervalMs));
      }
    })();
    try {
      const result = await operation();
      return { result, peak };
    } finally {
      done = true;
      await poller;
      recordPeak(peak, await this.sample());
    }
  }

  async detach(): Promise<void> {
    for (const { reject } of this.pending.values()) reject(new Error('probe detached'));
    this.pending.clear();
    await this.cdp.detach().catch(() => {});
  }

  // --- protocol plumbing -------------------------------------------------------

  private onAttached(
    parent: string[],
    event: { sessionId: string; targetInfo: { type: string; url: string } }
  ) {
    if (event.targetInfo.type !== 'worker') return;
    const path = [...parent, event.sessionId];
    this.targets.set(path.join('/'), { path, url: event.targetInfo.url });
    // Recurse: the pdf.js worker is a child of the render/process worker.
    void this.sendTo(path, 'Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: false
    }).catch(() => {});
  }

  private onDetached(parent: string[], event: { sessionId: string }) {
    const key = [...parent, event.sessionId].join('/');
    for (const k of [...this.targets.keys()]) {
      if (k === key || k.startsWith(`${key}/`)) this.targets.delete(k);
    }
  }

  /** A message from the child at `parent + sessionId`. */
  private onMessage(parent: string[], event: { sessionId: string; message: string }) {
    const path = [...parent, event.sessionId];
    const message = JSON.parse(event.message) as {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      result?: unknown;
      error?: { message: string };
    };
    if (message.id !== undefined) {
      const key = `${path.join('/')}#${message.id}`;
      const waiter = this.pending.get(key);
      if (!waiter) return;
      this.pending.delete(key);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
      return;
    }
    const params = message.params as never;
    if (message.method === 'Target.attachedToTarget') this.onAttached(path, params);
    else if (message.method === 'Target.detachedFromTarget') this.onDetached(path, params);
    else if (message.method === 'Target.receivedMessageFromTarget') this.onMessage(path, params);
  }

  /** Sends `method` to the worker at `path`, wrapping once per level. */
  private sendTo(
    path: string[],
    method: string,
    params: Record<string, unknown>,
    timeoutMs = 5_000
  ): Promise<unknown> {
    const id = this.nextId++;
    const key = `${path.join('/')}#${id}`;
    let message = JSON.stringify({ id, method, params });
    // Innermost first: each level is a `sendMessageToTarget` sent to its parent.
    for (let depth = path.length - 1; depth >= 1; depth--) {
      message = JSON.stringify({
        id: this.nextId++,
        method: 'Target.sendMessageToTarget',
        params: { sessionId: path[depth], message }
      });
    }
    const reply = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(key, {
        resolve: value => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: error => {
          clearTimeout(timer);
          reject(error);
        }
      });
    });
    void this.cdp.send('Target.sendMessageToTarget', { sessionId: path[0], message }).catch(() => {
      this.pending.get(key)?.reject(new Error('target gone'));
      this.pending.delete(key);
    });
    return reply;
  }
}

/** Formats bytes as MB with one decimal, for annotations. */
export const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
